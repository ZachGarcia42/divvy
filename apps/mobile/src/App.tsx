import { formatMoney, splitFromStored } from '@divvy/domain'
import { editConflict } from './flows/errors'
import { joinedFeedback } from './flows/composer'
import { draftFromSpec, majorString } from './flows/split'
import { emptyFeed, emptySections, buildSections, feedArrived, feedFailed, feedPath, feedRefreshed, feedRequested, feedSnack, feedTarget, canLoadMore, activeChip, feedChips, originStays, returnsToFeed, sectionsArrived, sectionsAsFeed, sectionsFailed, sectionsPath, sectionsRequested, shouldAutoLoad, type FeedEntry, type FeedOrigin, type FeedPage, type FeedState, type SectionData, type SectionsState } from './flows/feed'
import { isForeign, type Quote } from './flows/fx'
import { contentTopGap, SNACK_MS, snackOwner, snackStays, startScreen, groupIcon, type HistoryEntry } from './flows/view'
import { PayReturnSheet, PaymentNamesScreen } from './Pay'
import { onReturn, stillOwed, type PayRow, type PendingPay } from './flows/pay'
import type { PayHandles, PayProvider } from '@divvy/domain'
import { deleteReceipt, photoErrorText, photoPlan, remoteSource, savedWithPhotoProblem, uploadReceipt, type PhotoApi, type PickedPhoto } from './flows/photo'
import { AccountScreen, ActivityScreen, AddSheet, CreateGroupSheet, DeletedExpense, ExpenseDetail, Fab, GroupsHome, GroupView, InviteCard, PasteCard, SettleScreen, Snack, SwitcherSheet, TabBar, todayIso, type SheetSave, type Tab } from './V2'
import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ActivityIndicator,
  Alert,
  AppState,
  BackHandler,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context'
import { StatusBar } from 'expo-status-bar'
import { inviteFromNext, invitePath, isToken, parseDeepLink, parseInvitePreview, PENDING_INVITE_KEY, tokenFromInput, type InvitePreview } from './links'
import { SocialSignIn } from './SocialSignIn'
import type { Expense, GroupDetail, Home, HomeGroup, Payment, PhotoInfo, Settlement } from './types'
import { apiBase, SIGN_IN_WIDTH, webBackPlan, webLinkUrl } from './flows/web'
import { FALLBACK_PROVIDERS, parseProviders, type Providers } from './flows/providers'
import { CheckEmail, ExpiredLink, JoinCard, NamePrompt, NameSheet, Toast } from './November'
import { createOnce, joinFailure, joinedWasAlreadyMember, loadJoinView, type JoinView } from './flows/join'
import { checkStoredSession, createSessionExpiry, loadSession, saveSession, type KeyStore } from './flows/session'
import { nameAskedKey, shouldAskName } from './flows/names'
import { createCooldowns, emailError, LAST_EMAIL_KEY, monotonicNow, normalizeEmail, sendErrorMessage, verifyFailure } from './flows/signin'

// expo-secure-store has no web implementation; the web build keeps the session in localStorage.
const webStorage = (globalThis as unknown as { localStorage?: { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void } }).localStorage
const secureStore: KeyStore = Platform.OS === 'web' ? {
  get: async (key) => webStorage?.getItem(key) ?? null,
  set: async (key, value) => { webStorage?.setItem(key, value) },
  remove: async (key) => { webStorage?.removeItem(key) },
} : {
  get: (key) => SecureStore.getItemAsync(key),
  set: (key, value) => SecureStore.setItemAsync(key, value),
  remove: (key) => SecureStore.deleteItemAsync(key),
}
// Every authenticated 401 (other than a dead-link BAD_TOKEN) ends the session through here.
const sessionExpiry = createSessionExpiry()
// Resend cooldowns survive going back to the email field (keyed by normalized email), for this app run.
const cooldowns = createCooldowns()

// Literal reads so Expo inlines them. On web the API serves the app, so calls are same-origin.
const API = apiBase(Platform.OS, { api: process.env.EXPO_PUBLIC_API_URL, webApi: process.env.EXPO_PUBLIC_WEB_API_URL })
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export type { Expense, GroupDetail, Home, HomeGroup, Member, Payment, Settlement } from './types'

function isStale(reason: unknown) {
  return (reason as { code?: string } | null)?.code === 'STALE'
}

async function call<T>(token: string | null, path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  let response: Response
  try {
    response = await fetch(`${API}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        'x-divvy-platform': Platform.OS,
        ...(init?.headers ?? {}),
      },
    })
  } catch {
    throw Object.assign(new Error('Couldn’t reach Divvy'), { code: 'NETWORK' })
  } finally {
    clearTimeout(timer)
  }
  const body = await response.json().catch(() => ({})) as { error?: { code?: string; message?: string; attemptsLeft?: number } }
  if (!response.ok) {
    const failure = Object.assign(new Error(body.error?.message ?? 'Request failed'), {
      code: body.error?.code ?? `HTTP_${response.status}`,
      status: response.status,
      attemptsLeft: body.error?.attemptsLeft,
    })
    sessionExpiry.report(failure, !!token)
    throw failure
  }
  return body as T
}


const TOP_EDGES = ['top', 'left', 'right'] as const
const ALL_EDGES = ['top', 'left', 'right', 'bottom'] as const
const LAST_GROUP_KEY = 'divvy.lastGroup'

/** On wide (desktop) web screens the app sits in a centered ~480px column; phones are unchanged. */
export function App() {
  // Android 15+/Expo 54 draw edge to edge, so every screen sits inside SafeAreaProvider and pads its own top (and, without a
  // tab bar, bottom) inset. The status bar is transparent with dark icons over the light screens.
  const screens = <AppScreens />
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      {Platform.OS !== 'web' ? screens : <View style={styles.webOuter}><View style={styles.webColumn}>{screens}</View></View>}
    </SafeAreaProvider>
  )
}

function AppScreens() {
  const [token, setTokenState] = useState<string | null>(null)
  const [booting, setBooting] = useState(true)
  const setToken = (next: string | null) => {
    setTokenState(next)
    void saveSession(secureStore, next)
  }
  const [inviteToken, setInviteToken] = useState<string | null>(null)
  const [linkFailure, setLinkFailure] = useState<ReturnType<typeof verifyFailure> | null>(null)
  const [verifying, setVerifying] = useState(false)
  const tokenRef = useRef<string | null>(null)
  tokenRef.current = token

  // A pending invite survives the app being killed: it is persisted until it is accepted or dismissed.
  const rememberInvite = (next: string) => {
    if (!isToken(next)) return
    setInviteToken(next)
    AsyncStorage.setItem(PENDING_INVITE_KEY, next).catch(() => undefined)
  }
  const forgetInvite = () => {
    setInviteToken(null)
    AsyncStorage.removeItem(PENDING_INVITE_KEY).catch(() => undefined)
  }

  useEffect(() => {
    // After startup, an expired session clears secure storage and returns to sign-in; the pending invite stays.
    sessionExpiry.set(() => setToken(null))
    return () => sessionExpiry.set(null)
  }, [])

  useEffect(() => {
    // Stay signed in across restarts: a stored session that the API no longer knows is cleared.
    ;(async () => {
      const stored = await loadSession(secureStore)
      if (stored) {
        const checked = await checkStoredSession(secureStore, stored, () => call<unknown>(stored, '/api/me'))
        if (checked.ok || checked.reason === 'offline') setTokenState((current) => current ?? stored)
      }
      setBooting(false)
    })()
  }, [])

  useEffect(() => {
    AsyncStorage.getItem(PENDING_INVITE_KEY)
      .then((saved) => {
        if (!saved) return
        // A stored value that is not a well-formed token is dropped, never fetched.
        if (isToken(saved)) setInviteToken((current) => current ?? saved)
        else AsyncStorage.removeItem(PENDING_INVITE_KEY).catch(() => undefined)
      })
      .catch(() => undefined)
    const take = async (url: string | null) => {
      const link = parseDeepLink(url)
      if (!link) return
      if (link.kind === 'invite') {
        rememberInvite(link.token)
        return
      }
      if (tokenRef.current) {
        // Already signed in: don't silently swap accounts. Cancel keeps the current session.
        const proceed = await new Promise<boolean>((resolve) => {
          Alert.alert('Sign in as a different account?', 'This link signs you in with another email. You will leave the current session.', [
            { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
            { text: 'Sign in', style: 'destructive', onPress: () => resolve(true) },
          ], { cancelable: true, onDismiss: () => resolve(false) })
        })
        if (!proceed) return
      }
      setVerifying(true)
      try {
        const session = await call<{ token: string; next?: string | null }>(null, '/api/auth/verify', {
          method: 'POST',
          body: JSON.stringify({ token: link.token }),
        })
        const pending = inviteFromNext(session.next ?? link.next)
        if (pending) rememberInvite(pending)
        setLinkFailure(null)
        setToken(session.token)
      } catch (reason) {
        setLinkFailure(verifyFailure(reason))
      } finally {
        setVerifying(false)
      }
    }
    Linking.getInitialURL().then((url) => {
      if (Platform.OS !== 'web') return take(url)
      // Web: /app/login?token=... or /app/invite/<token>; drop the token from the address bar once read.
      const mapped = webLinkUrl(url)
      if (mapped !== url) (globalThis as unknown as { history?: { replaceState(a: unknown, b: string, c: string): void } }).history?.replaceState(null, '', '/')
      return take(mapped)
    }).catch(() => undefined)
    const subscription = Linking.addEventListener('url', (event) => { void take(event.url) })
    return () => subscription.remove()
  }, [])

  if (booting && !token) {
    return <SafeAreaView style={styles.screen} edges={ALL_EDGES}><View style={styles.signIn}><Text style={styles.brand} accessibilityRole="header">Divvy</Text></View></SafeAreaView>
  }
  if (!token) {
    return (
      <SignIn
        onToken={(next) => { setLinkFailure(null); setToken(next) }}
        pendingInvite={inviteToken}
        onDismissInvite={forgetInvite}
        linkFailure={linkFailure}
        onClearLinkFailure={() => setLinkFailure(null)}
        verifying={verifying}
      />
    )
  }
  return (
    <SignedIn
      key={token}
      token={token}
      inviteToken={inviteToken}
      onInviteHandled={forgetInvite}
      onSignedOut={() => { forgetInvite(); setToken(null) }}
      onSessionExpired={() => setToken(null)}
    />
  )
}

type Me = { userId: string; email: string; participantId: string; displayName: string }

/** After sign-in: the one-time name prompt (2e) comes first, then the group (and any pending join). */
function SignedIn({ onSessionExpired, ...props }: { token: string; inviteToken: string | null; onInviteHandled: () => void; onSignedOut: () => void; onSessionExpired: () => void }) {
  const [me, setMe] = useState<Me | null>(null)
  const [ask, setAsk] = useState<boolean | null>(null)

  useEffect(() => {
    let cancelled = false
    call<Me | null>(props.token, '/api/me')
      .then(async (found) => {
        if (cancelled) return
        if (!found) {
          // The session is gone on the server: clear it and go back to sign-in, keeping any pending invite.
          onSessionExpired()
          return
        }
        setMe(found)
        const asked = found ? await AsyncStorage.getItem(nameAskedKey(found.userId)).catch(() => '1') : '1'
        if (!cancelled) setAsk(shouldAskName(found, !!asked))
      })
      .catch((reason) => {
        if (cancelled) return
        if ((reason as { status?: number; code?: string }).status === 401 && (reason as { code?: string }).code !== 'BAD_TOKEN') onSessionExpired()
        else setAsk(false)
      })
    return () => { cancelled = true }
  }, [props.token])

  if (ask === null) {
    return <SigningIn email={me?.email ?? null} />
  }
  if (ask && me) {
    const finish = () => {
      AsyncStorage.setItem(nameAskedKey(me.userId), '1').catch(() => undefined)
      setAsk(false)
    }
    return (
      <NamePrompt
        current={me.displayName}
        onSave={async (name) => { await call(props.token, '/api/me', { method: 'PATCH', body: JSON.stringify({ displayName: name }) }) }}
        onDone={finish}
      />
    )
  }
  return <Ledger {...props} participantId={me?.participantId ?? null} />
}

/** 1e: spinner, "Signing you in…", and the email under it when we know it. */
function SigningIn({ email }: { email: string | null }) {
  return (
    <SafeAreaView style={styles.screen} edges={ALL_EDGES}>
      <View style={[styles.signIn, styles.centerItems]} testID="verifying" accessibilityLiveRegion="polite">
        <ActivityIndicator size="large" color="#0f766e" accessibilityLabel="Signing you in" />
        <Text style={styles.verifyingTitle} accessibilityRole="header">Signing you in…</Text>
        {email && <Text style={styles.muted}>{email}</Text>}
      </View>
    </SafeAreaView>
  )
}

/** 1d: the mockup's red box with an icon. The icon is decorative; the text is a live region. */
function OfflineBox({ text }: { text: string }) {
  return (
    <View style={styles.offlineBox} testID="sign-in-offline">
      <View style={styles.offlineIcon} accessible={false} importantForAccessibility="no-hide-descendants">
        <Text style={styles.offlineIconText}>!</Text>
      </View>
      <Text style={styles.offlineText} accessibilityLiveRegion="polite" accessibilityRole="alert">{text}</Text>
    </View>
  )
}

function SignIn({ onToken, pendingInvite, onDismissInvite, linkFailure, onClearLinkFailure, verifying }: {
  onToken: (token: string) => void
  pendingInvite: string | null
  onDismissInvite: () => void
  linkFailure: ReturnType<typeof verifyFailure> | null
  onClearLinkFailure: () => void
  verifying: boolean
}) {
  const [email, setEmail] = useState('')
  const [savedEmail, setSavedEmail] = useState<string | null>(null)
  const [sentTo, setSentTo] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [sampleAvailable, setSampleAvailable] = useState(false)
  // null until /api/auth/providers answers, so the email form never flashes before we know it's offered.
  const [loadedProviders, setProviders] = useState<Providers | null>(null)
  const providers = loadedProviders ?? FALLBACK_PROVIDERS
  const [providerError, setProviderError] = useState<string | null>(null)

  useEffect(() => {
    // Only show "Open the sample apartment" when the API says dev seed is on.
    call<{ devSeed?: boolean }>(null, '/api/config').then((config) => setSampleAvailable(config.devSeed === true)).catch(() => setSampleAvailable(false))
    call<unknown>(null, '/api/auth/providers').then((body) => setProviders(parseProviders(body))).catch(() => setProviders(FALLBACK_PROVIDERS))
    AsyncStorage.getItem(LAST_EMAIL_KEY).then((saved) => { if (saved) setSavedEmail(saved) }).catch(() => undefined)
  }, [])

  // Sends the link (with the pending invite as `next`). Throws on failure so callers can show their copy.
  const request = async (address: string) => {
    const send = (next: string | null) => call<{ devToken?: string }>(null, '/api/auth/magic-link', {
      method: 'POST',
      body: JSON.stringify(next ? { email: address, next } : { email: address }),
    })
    let issued: { devToken?: string }
    try {
      issued = await send(pendingInvite ? `/invite/${pendingInvite}` : null)
    } catch (reason) {
      // The server refused the return path: drop the bad pending invite and sign in without it.
      if (!pendingInvite || (reason as { code?: string }).code !== 'BAD_NEXT') throw reason
      onDismissInvite()
      issued = await send(null)
    }
    cooldowns.mark(address, monotonicNow())
    setSavedEmail(address)
    AsyncStorage.setItem(LAST_EMAIL_KEY, address).catch(() => undefined)
    // Never on web: the server refuses browsers anyway, and the hosted app must not have a tester shortcut.
    if (issued.devToken && Platform.OS !== 'web') {
      // Tester builds: an allowlisted email gets a devToken, so verify right away and skip Check your email.
      const session = await call<{ token: string }>(null, '/api/auth/verify', { method: 'POST', body: JSON.stringify({ token: issued.devToken }) })
      onToken(session.token)
      return false
    }
    return true
  }

  const sendLink = async () => {
    const problem = emailError(email)
    if (problem) {
      setError(problem)
      return
    }
    const address = normalizeEmail(email)
    // Same address again within the cooldown: go straight back to Check your email instead of re-sending.
    const last = cooldowns.last(address)
    if (last !== null && monotonicNow() - last >= 0 && monotonicNow() - last < 30_000) {
      setSentTo(address)
      return
    }
    setSending(true)
    setError(null)
    try {
      if (await request(address)) setSentTo(address)
    } catch (reason) {
      setError(sendErrorMessage(reason))
    } finally {
      setSending(false)
    }
  }

  const backToEntry = () => {
    setSentTo(null)
    setEmail('')
    setError(null)
    onClearLinkFailure()
  }

  if (verifying) {
    return (
      <SigningIn email={savedEmail} />
    )
  }
  if (sentTo) {
    return (
      <CheckEmail
        email={sentTo}
        pendingInvite={!!pendingInvite}
        lastSentAt={cooldowns.last(sentTo)}
        now={monotonicNow}
        onResend={async () => { await request(sentTo) }}
        onCode={async (code) => {
          // Same result as a tapped link; any pending invite stays saved and opens after sign-in.
          const session = await call<{ token: string }>(null, '/api/auth/verify-code', { method: 'POST', body: JSON.stringify({ email: sentTo, code }) })
          onToken(session.token)
        }}
        onBack={backToEntry}
      />
    )
  }
  if (linkFailure?.kind === 'expired') {
    return (
      <ExpiredLink
        hasEmail={!!savedEmail}
        onSendNew={async () => {
          if (!savedEmail) return
          if (await request(savedEmail)) { onClearLinkFailure(); setSentTo(savedEmail) }
        }}
        onBack={backToEntry}
      />
    )
  }

  const signInWith = async (provider: 'google' | 'apple', body: Record<string, unknown>) => {
    const post = (payload: Record<string, unknown>) => call<{ token: string }>(null, `/api/auth/${provider}`, { method: 'POST', body: JSON.stringify(payload) })
    let session: { token: string }
    try {
      session = await post(body)
    } catch (reason) {
      // Same as the email path: a refused return path drops the pending invite and signs in without it.
      if (!body.next || (reason as { code?: string }).code !== 'BAD_NEXT') throw reason
      onDismissInvite()
      const { next: _dropped, ...rest } = body
      session = await post(rest)
    }
    onToken(session.token)
  }

  const shownError = error ?? providerError ?? (linkFailure?.kind === 'error' ? linkFailure.message : null)
  const offline = !!error && error.startsWith('Couldn’t send')
  return (
    <SafeAreaView style={styles.screen} edges={ALL_EDGES}>
      <View style={styles.signIn}>
        <Text style={styles.brand}>Divvy</Text>
        {pendingInvite ? (
          <View style={styles.inviteNote} testID="pending-invite">
            <Text style={styles.copy}>🔗  <Text style={styles.strong}>You opened a group link.</Text> Sign in and we’ll take you right to it.</Text>
            <Pressable testID="pending-invite-dismiss" onPress={onDismissInvite} accessibilityRole="button" accessibilityLabel="Dismiss the group invite" accessibilityState={{ disabled: false }}>
              <Text style={styles.signOut}>Dismiss</Text>
            </Pressable>
          </View>
        ) : (
          <Text style={[styles.copy, styles.centerText]}>{!loadedProviders ? ' ' : providers.email ? 'Split trips and bills with friends. We’ll email you a link to sign in.' : 'Split trips and bills with friends.'}</Text>
        )}
        {!loadedProviders && <View style={styles.providersPlaceholder} testID="sign-in-loading" accessibilityLabel="Loading sign-in options" />}
        {loadedProviders && <SocialSignIn
          providers={providers}
          next={pendingInvite ? `/invite/${pendingInvite}` : null}
          onSignIn={signInWith}
          onError={setProviderError}
        />}
        {loadedProviders && providers.email && <>
        <TextInput
          style={[styles.input, !!error && !offline && styles.inputBad]}
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
          keyboardType="email-address"
          returnKeyType="send"
          onSubmitEditing={sendLink}
          value={email}
          onChangeText={(text) => { setEmail(text); setError(null) }}
          placeholder="you@example.com"
          placeholderTextColor="#5f6f67"
          testID="sign-in-email"
        />
        {shownError && (offline
          ? <OfflineBox text={shownError} />
          : <Text style={styles.error} testID="sign-in-error" accessibilityLiveRegion="polite" accessibilityRole="alert">{shownError}</Text>)}
        <Pressable style={[styles.primary, sending && styles.disabled]} disabled={sending} onPress={sendLink} testID="send-link" accessibilityRole="button" accessibilityState={{ disabled: sending, busy: sending }}>
          <Text style={styles.primaryText}>{sending ? 'Sending…' : offline ? 'Try again' : 'Send link'}</Text>
        </Pressable>
        <Text style={[styles.muted, styles.centerText]}>No password. The link works for 15 minutes.</Text>
        </>}
        {!providers.email && shownError && <Text style={styles.error} testID="sign-in-error" accessibilityLiveRegion="polite" accessibilityRole="alert">{shownError}</Text>}
        {sampleAvailable && (
          <Pressable style={styles.secondary} accessibilityRole="button" accessibilityState={{ disabled: false }} onPress={async () => {
            try {
              const session = await call<{ token: string }>(null, '/api/dev/seed', { method: 'POST' })
              onToken(session.token)
            } catch (reason) {
              if ((reason as { status?: number }).status === 404) setSampleAvailable(false)
              else setError(sendErrorMessage(reason))
            }
          }}>
            <Text style={styles.secondaryText}>Open the sample apartment</Text>
          </Pressable>
        )}
      </View>
    </SafeAreaView>
  )
}

type Screen = 'groups' | 'group' | 'expense' | 'settle' | 'account' | 'activity' | 'groupActivity' | 'deleted'
type Snackbar = { text: string; action?: string; run?: () => void; owner?: string }

const deviceZone = () => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { return 'UTC' }
}
const timeText = (iso: string) => {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const clock = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return d.toDateString() === new Date().toDateString() ? clock : `${MONTHS[d.getMonth()]} ${d.getDate()}, ${clock}`
}

/**
 * One Activity feed (all groups when groupId is null). The loaded pages are kept for as long as the feed is the same one: turning
 * `enabled` off and on again (leaving the feed and coming back) refetches only the newest page and merges it on top, so the list
 * and the scroll position survive. A different account or group starts over.
 */
function useFeed(token: string, groupId: string | null, enabled: boolean) {
  const [state, setState] = useState<FeedState>(emptyFeed)
  const latest = useRef(0)
  const stateRef = useRef(state)
  stateRef.current = state
  const load = (mode: 'first' | 'more' | 'refresh') => {
    const more = mode === 'more'
    const cursor = more ? stateRef.current.nextCursor : null
    if (more && !cursor) return
    const id = ++latest.current
    setState((current) => feedRequested(current, more))
    call<FeedPage>(token, feedPath(groupId, cursor))
      .then((page) => { if (latest.current === id) setState((current) => (mode === 'refresh' ? feedRefreshed(current, page) : feedArrived(current, page, more))) })
      .catch((reason: Error) => { if (latest.current === id) setState((current) => feedFailed(current, reason.message, more)) })
  }
  // Another account or group: forget everything.
  useEffect(() => {
    latest.current++
    stateRef.current = emptyFeed
    setState(emptyFeed)
  }, [token, groupId])
  // Each time the feed comes on screen: the first load, or a quiet refresh of the newest page.
  useEffect(() => {
    if (!enabled) return
    load(stateRef.current.loaded ? 'refresh' : 'first')
    return () => { latest.current++ }
  }, [token, groupId, enabled])
  return {
    state,
    more: () => { if (canLoadMore(stateRef.current)) load('more') },
    /** Try again after an error, or pull to refresh. */
    retry: () => load(stateRef.current.loaded ? 'refresh' : 'first'),
    /** The snackbar's Retry: tries the page that failed. */
    retrySnack: () => load(stateRef.current.errorMore ? 'more' : 'refresh'),
  }
}

/**
 * The All view of Activity: one section per group with activity (its newest few entries and its total), from the server, so a very
 * busy group cannot crowd the others out. Like useFeed it keeps what it has and refreshes quietly each time the screen comes back.
 */
function useSections(token: string, enabled: boolean) {
  const [state, setState] = useState<SectionsState>(emptySections)
  const latest = useRef(0)
  const load = () => {
    const id = ++latest.current
    setState(sectionsRequested)
    call<{ sections?: SectionData[] }>(token, sectionsPath())
      .then((page) => { if (latest.current === id) setState(sectionsArrived(page)) })
      .catch((reason: Error) => { if (latest.current === id) setState((current) => sectionsFailed(current, reason.message)) })
  }
  useEffect(() => { latest.current++; setState(emptySections) }, [token])
  useEffect(() => {
    if (!enabled) return
    load()
    return () => { latest.current++ }
  }, [token, enabled])
  return { state, retry: load }
}

/**
 * The entries behind "Show N more" on the sections that are open: each open group's own feed, a page at a time. Opening a section
 * loads its first page; coming back to the screen refreshes the pages already loaded; `more` loads the next page.
 */
function useSectionPages(token: string, open: Record<string, boolean>, enabled: boolean) {
  const [pages, setPages] = useState<Record<string, FeedState>>({})
  const pagesRef = useRef(pages)
  pagesRef.current = pages
  const latest = useRef<Record<string, number>>({})
  const patch = (groupId: string, change: (current: FeedState) => FeedState) => setPages((all) => ({ ...all, [groupId]: change(all[groupId] ?? emptyFeed) }))
  const load = (groupId: string, mode: 'first' | 'more' | 'refresh') => {
    const more = mode === 'more'
    const cursor = more ? pagesRef.current[groupId]?.nextCursor ?? null : null
    if (more && !cursor) return
    const id = (latest.current[groupId] = (latest.current[groupId] ?? 0) + 1)
    patch(groupId, (current) => feedRequested(current, more))
    call<FeedPage>(token, feedPath(groupId, cursor))
      .then((page) => { if (latest.current[groupId] === id) patch(groupId, (current) => (mode === 'refresh' ? feedRefreshed(current, page) : feedArrived(current, page, more))) })
      .catch((reason: Error) => { if (latest.current[groupId] === id) patch(groupId, (current) => feedFailed(current, reason.message, more)) })
  }
  useEffect(() => { latest.current = {}; setPages({}) }, [token])
  const openIds = Object.keys(open).filter((id) => open[id]).sort().join(',')
  useEffect(() => {
    if (!enabled) return
    for (const id of openIds ? openIds.split(',') : []) {
      const current = pagesRef.current[id]
      if (!current || (!current.loaded && !current.loading)) load(id, 'first')
      else if (current.loaded && !current.loading) load(id, 'refresh')
    }
  }, [token, enabled, openIds])
  return {
    pages,
    more: (groupId: string) => { const current = pagesRef.current[groupId]; if (current?.error && !current.errorMore) load(groupId, 'first'); else if (current && canLoadMore(current)) load(groupId, 'more') },
  }
}

function Ledger({
  token,
  inviteToken,
  onInviteHandled,
  onSignedOut,
  participantId,
}: {
  token: string
  inviteToken: string | null
  onInviteHandled: () => void
  onSignedOut: () => void
  participantId: string | null
}) {
  const [home, setHome] = useState<Home | null>(null)
  const [groupId, setGroupId] = useState<string | null>(null)
  const [detail, setDetail] = useState<GroupDetail | null>(null)
  const [screen, setScreen] = useState<Screen>('groups')
  const [expenseId, setExpenseId] = useState<string | null>(null)
  const [history, setHistory] = useState<HistoryEntry[] | null>(null)
  const [adding, setAdding] = useState<{ edit: Expense | null } | null>(null)
  const [switcher, setSwitcher] = useState(false)
  const [creating, setCreating] = useState<{ template?: string } | null>(null)
  const [createBusy, setCreateBusy] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const busyRef = useRef<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [detailTick, setDetailTick] = useState(0)
  const [historyTick, setHistoryTick] = useState(0)
  // The receipt on the open expense: undefined while loading, null when there is none.
  const [photo, setPhoto] = useState<PhotoInfo | null | undefined>(undefined)
  const [photoBusy, setPhotoBusy] = useState(false)
  const [photoError, setPhotoError] = useState<string | null>(null)
  const [inviteUrl, setInviteUrl] = useState<string | null>(null)
  const [paste, setPaste] = useState('')
  const [showPaste, setShowPaste] = useState(false)
  const [joinToken, setJoinToken] = useState<string | null>(inviteToken)
  const [join, setJoin] = useState<JoinView | null>(null)
  const [joinError, setJoinError] = useState<string | null>(null)
  const [joinAttempt, setJoinAttempt] = useState(0)
  const [editingName, setEditingName] = useState(false)
  const [editingPay, setEditingPay] = useState(false)
  // A payment link that was opened and not yet answered (memory only), and the question shown when the app comes back.
  const pendingPay = useRef<PendingPay | null>(null)
  const [returnPay, setReturnPay] = useState<PendingPay | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [snack, setSnack] = useState<Snackbar | null>(null)
  // Where a feed row was opened from (see FeedOrigin): back returns there with the scroll position kept.
  const [origin, setOrigin] = useState<FeedOrigin | null>(null)
  const [deletedEntry, setDeletedEntry] = useState<FeedEntry | null>(null)
  const [restoringDeleted, setRestoringDeleted] = useState(false)
  const scrollRef = useRef<ScrollView | null>(null)
  const scrollY = useRef(0)
  const viewH = useRef(0)
  const contentH = useRef(0)
  const pendingY = useRef<number | null>(null)
  // Where the group's expense list was scrolled to when a detail, Settle up or the group's Activity was opened from it.
  const groupY = useRef<number | null>(null)
  // A lasting "You're in <group>" confirmation after accepting a group link (cleared on dismiss).
  const [welcome, setWelcome] = useState<{ groupId: string; text: string } | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const snackTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const booted = useRef(false)
  const showToast = (text: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current)
    setToast(text)
    toastTimer.current = setTimeout(() => setToast(null), 3000)
  }
  const showSnack = (next: Snackbar | null) => {
    if (snackTimer.current) clearTimeout(snackTimer.current)
    setSnack(next)
    if (next) snackTimer.current = setTimeout(() => setSnack(null), SNACK_MS)
  }
  // An Undo snackbar only makes sense where it was raised: moving to another screen or group clears it.
  useEffect(() => {
    setSnack((current) => (current && !snackStays(current.owner, screen, groupId) ? null : current))
  }, [screen, groupId])
  // The origin only lives while the screens it opened are showing.
  useEffect(() => {
    setOrigin((current) => (current && !originStays(current, screen) ? null : current))
  }, [screen])
  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current)
    if (snackTimer.current) clearTimeout(snackTimer.current)
  }, [])

  useEffect(() => {
    if (inviteToken) setJoinToken(inviteToken)
  }, [inviteToken])

  // Load your groups right after sign-in. The first load reopens the last group you had open (back goes to Groups);
  // otherwise you land on Groups. If none show up yet (e.g. a just-linked Google account), look again shortly
  // and when the tab regains focus.
  const [homeAttempt, setHomeAttempt] = useState(0)
  const sectionsFeed = useSections(token, screen === 'activity')
  // The Activity tab's group chips: which group the feed is narrowed to (null = All, split into a section per group), and the sections opened with "Show more".
  const [feedFilter, setFeedFilter] = useState<string | null>(null)
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({})
  const sectionPages = useSectionPages(token, openSections, screen === 'activity' && feedFilter === null)
  const allFeed = useMemo(() => ({ state: sectionsAsFeed(sectionsFeed.state), more: () => {}, retry: sectionsFeed.retry, retrySnack: sectionsFeed.retry }), [sectionsFeed.state])
  const sections = useMemo(() => buildSections(sectionsFeed.state.sections, sectionPages.pages, openSections), [sectionsFeed.state.sections, sectionPages.pages, openSections])
  const chips = useMemo(() => feedChips(home?.groups ?? [], sectionsFeed.state.sections.map((section) => section.group)), [home?.groups, sectionsFeed.state.sections])
  const chipFilter = activeChip(chips, feedFilter)
  const chipFeed = useFeed(token, chipFilter, screen === 'activity' && chipFilter !== null)
  const groupFeed = useFeed(token, groupId, screen === 'groupActivity' && !!groupId)
  // Only when the sections reply was unusable: the All view as one plain feed.
  const flatFeed = useFeed(token, null, screen === 'activity' && chipFilter === null && sectionsFeed.state.flat === true)
  useEffect(() => {
    let cancelled = false
    Promise.all([call<Home>(token, '/api/home'), AsyncStorage.getItem(LAST_GROUP_KEY).catch(() => null)])
      .then(([next, last]) => {
        if (cancelled) return
        setHome(next)
        if (!booted.current) {
          booted.current = true
          const start = startScreen(next.groups, last)
          if (start.groupId) {
            setGroupId(start.groupId)
            setScreen('group')
          }
        }
      })
      .catch((reason: Error) => { if (!cancelled) setError(reason.message) })
    return () => { cancelled = true }
  }, [token, homeAttempt])
  useEffect(() => {
    if (!home || home.groups.length > 0 || homeAttempt >= 2) return
    const timer = setTimeout(() => setHomeAttempt((n) => n + 1), 1500)
    return () => clearTimeout(timer)
  }, [home, homeAttempt])
  useEffect(() => {
    if (Platform.OS !== 'web') return
    const w = globalThis as unknown as { addEventListener?: (e: string, f: () => void) => void; removeEventListener?: (e: string, f: () => void) => void }
    const onFocus = () => setHomeAttempt((n) => n + 1)
    w.addEventListener?.('focus', onFocus)
    return () => w.removeEventListener?.('focus', onFocus)
  }, [])
  useEffect(() => { if (groupId) AsyncStorage.setItem(LAST_GROUP_KEY, groupId).catch(() => undefined) }, [groupId])

  useEffect(() => {
    if (!groupId) {
      setDetail(null)
      return
    }
    let cancelled = false
    setDetail((current) => (current?.group.id === groupId ? current : null))
    call<GroupDetail>(token, `/api/groups/${groupId}`)
      .then((next) => { if (!cancelled) setDetail(next) })
      .catch((reason: Error) => { if (!cancelled) setError(reason.message) })
    return () => { cancelled = true }
  }, [token, groupId, detailTick])

  useEffect(() => {
    if (screen !== 'expense' || !groupId || !expenseId) return
    let cancelled = false
    call<{ history: HistoryEntry[]; photo?: PhotoInfo | null }>(token, `/api/groups/${groupId}/expenses/${expenseId}`)
      .then((found) => { if (!cancelled) { setHistory(found.history); setPhoto(found.photo ?? null) } })
      .catch(() => { if (!cancelled) { setHistory([]); setPhoto((current) => current ?? null) } })
    return () => { cancelled = true }
  }, [token, groupId, expenseId, screen, historyTick])

  useEffect(() => {
    if (!groupId) return
    let cancelled = false
    call<{ url: string }>(token, `/api/groups/${groupId}/invite-link`, { method: 'POST' })
      .then((link) => { if (!cancelled) setInviteUrl(link.url) })
      .catch(() => { if (!cancelled) setInviteUrl(null) })
    return () => { cancelled = true }
  }, [token, groupId])

  // Join from a link: public status first (tells expired/used/archived apart), then the signed-in
  // preview for members, then your groups to spot "already a member". Decisions live in flows/join.
  useEffect(() => {
    if (!joinToken) {
      setJoin(null)
      return
    }
    let cancelled = false
    setJoin({ kind: 'loading' })
    ;(async () => {
      const view = await loadJoinView({
        publicPreview: () => call<unknown>(null, invitePath(joinToken, '/preview')),
        authedPreview: () => call<unknown>(token, invitePath(joinToken)),
        yourGroupIds: () => call<Home>(token, '/api/home').then((found) => found.groups.map((group) => group.id)),
        parseAuthed: (raw) => {
          const parsed = parseInvitePreview(raw)
          return parsed ? { ...parsed, youAreMember: (raw as { youAreMember?: unknown }).youAreMember === true } : null
        },
        yourParticipantId: participantId,
      })
      if (cancelled) return
      if (view.kind === 'already') {
        booted.current = true
        setGroupId(view.groupId)
        setScreen('group')
        showToast(`You’re already in ${view.groupName}.`)
        setJoinToken(null)
        onInviteHandled()
        return
      }
      // Only a really dead link clears the saved invite; 'offline' keeps it for Try again.
      if (view.kind === 'dead') onInviteHandled()
      setJoin(view)
    })()
    return () => { cancelled = true }
  }, [token, joinToken, joinAttempt])

  const closeJoin = () => {
    setJoinToken(null)
    setJoin(null)
    setJoinError(null)
    onInviteHandled()
  }

  // Back from a screen a feed row opened returns to that feed (hardware back and the on-screen arrow alike); otherwise one step out.
  const stepBack = (): boolean => {
    if (editingPay) { setEditingPay(false); return true }
    if (returnsToFeed(origin, screen)) {
      pendingY.current = origin.y
      setOrigin(null)
      setScreen(origin.screen)
      return true
    }
    if (screen === 'expense' || screen === 'settle' || screen === 'groupActivity') {
      pendingY.current = groupY.current
      groupY.current = null
      setScreen('group')
      return true
    }
    if (screen === 'group' || screen === 'account' || screen === 'activity' || screen === 'deleted') { goGroups(); return true }
    return false
  }
  useEffect(() => {
    if (Platform.OS !== 'android') return
    const sub = BackHandler.addEventListener('hardwareBackPress', stepBack)
    return () => sub.remove()
  }, [screen, origin, editingPay])

  // Browser Back on the web: see webBackPlan. The page keeps one extra history entry while a screen other than Groups shows,
  // and popping it steps back inside the app (stepBack) instead of leaving the site.
  const stepBackRef = useRef(stepBack)
  stepBackRef.current = stepBack
  const backDepth = useRef<0 | 1>(0)
  const ignorePops = useRef(0)
  useEffect(() => {
    if (Platform.OS !== 'web') return
    const hist = (globalThis as unknown as { history?: { pushState(state: unknown, title: string): void; back(): void } }).history
    if (!hist) return
    const plan = webBackPlan(screen, backDepth.current)
    if (plan === 'push') { hist.pushState({ divvy: 1 }, ''); backDepth.current = 1 }
    if (plan === 'unwind') { backDepth.current = 0; ignorePops.current += 1; hist.back() }
  })
  useEffect(() => {
    if (Platform.OS !== 'web') return
    const w = globalThis as unknown as { addEventListener?: (e: string, f: () => void) => void; removeEventListener?: (e: string, f: () => void) => void }
    const onPop = () => {
      if (ignorePops.current > 0) { ignorePops.current -= 1; return }
      backDepth.current = 0
      stepBackRef.current()
    }
    w.addEventListener?.('popstate', onPop)
    return () => w.removeEventListener?.('popstate', onPop)
  }, [])

  // Put the saved scroll offset back once the feed it belongs to is tall enough again (the list is kept, so this is immediate).
  const restoreScroll = () => {
    const y = pendingY.current
    if (y === null) return
    if (contentH.current >= y + viewH.current - 1 || contentH.current > 0 && y === 0) {
      pendingY.current = null
      scrollRef.current?.scrollTo({ y, animated: false })
    }
  }
  useEffect(() => {
    if (pendingY.current === null) return
    const t = setTimeout(() => {
      const y = pendingY.current
      pendingY.current = null
      if (y !== null) scrollRef.current?.scrollTo({ y: Math.max(0, Math.min(y, contentH.current - viewH.current)), animated: false })
    }, 1200)
    return () => clearTimeout(t)
  }, [screen])

  // After a payment link was opened, ask once the app is back in the foreground. The question never records anything.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      const pending = pendingPay.current
      if (!pending) return
      if (state !== 'active') { pendingPay.current = { ...pending, left: true }; return }
      const next = onReturn(pending, Date.now())
      if (next === 'forget') pendingPay.current = null
      if (next === 'ask') { pendingPay.current = null; setReturnPay(pending) }
    })
    return () => sub.remove()
  }, [])

  function openPayLink(row: PayRow, payment: Payment) {
    if (!detail) return
    const payee = detail.members.find((m) => m.id === payment.toId)
    pendingPay.current = { provider: row.provider as PayProvider, groupId: detail.group.id, fromId: payment.fromId, toId: payment.toId, payeeName: payee?.name ?? 'them', minor: payment.minor, currency: detail.currency, openedAt: Date.now(), left: false }
    Linking.openURL(row.url).catch(() => {
      pendingPay.current = null
      showToast(`Couldn’t open ${row.label}. Pay another way, then record it here.`)
    })
  }

  async function savePayNames(pay: Record<PayProvider, string | null>) {
    const saved = await call<{ pay?: PayHandles }>(token, '/api/me', { method: 'PATCH', body: JSON.stringify({ pay }) })
    setHome((current) => current ? { ...current, you: { ...current.you, pay: saved.pay ?? {} } } : current)
    if (groupId) refresh(groupId).catch(() => undefined)
    showToast('Saved. People in your groups can now pay you in one tap.')
  }


  async function refresh(nextGroupId = groupId) {
    const nextHome = await call<Home>(token, '/api/home')
    setHome(nextHome)
    const id = nextGroupId && nextHome.groups.some((group) => group.id === nextGroupId) ? nextGroupId : null
    setGroupId(id)
    if (!id) {
      setDetail(null)
      setScreen('groups')
      return
    }
    setDetail(await call<GroupDetail>(token, `/api/groups/${id}`))
  }

  const goGroups = () => {
    setOrigin(null)
    groupY.current = null
    setScreen('groups')
    setExpenseId(null)
    call<Home>(token, '/api/home').then(setHome).catch(() => undefined)
  }
  const openGroup = (id: string) => {
    setSwitcher(false)
    setOrigin(null)
    groupY.current = null
    setExpenseId(null)
    setGroupId(id)
    setScreen('group')
    setDetailTick((n) => n + 1)
  }

  const members = (detail?.members ?? []).filter((member) => !member.removed)

  /** The day's rate for the Add sheet's preview; the server fetches and caches it, and uses the same figure when the expense is saved. */
  const fetchRate = async (from: string, date: string): Promise<Quote> => {
    if (!detail) throw new Error('No group')
    const quote = await call<{ rate: string; rateDate: string }>(token, `/api/groups/${detail.group.id}/fx?from=${encodeURIComponent(from)}&date=${encodeURIComponent(date)}`)
    return { rate: quote.rate, rateDate: quote.rateDate, source: 'ecb' }
  }

  // Add or edit: the sheet reports a valid split; the server re-validates and has the last word.
  const photoApi: PhotoApi = { base: API, token, platform: Platform.OS }
  const receiptSource = photo && groupId && expenseId ? remoteSource(photoApi, groupId, expenseId, photo) : null

  async function saveExpense(value: SheetSave, editing: Expense | null) {
    if (!detail) return
    const payload = {
      description: value.description,
      originalMinor: value.minor,
      originalCurrency: value.currency,
      ...(value.manualRate ? { rate: value.manualRate } : {}),
      payers: [{ participantId: value.payerId, minor: value.minor }],
      split: value.spec,
      rounding: 'payer' as const,
      ...(value.date ? { date: value.date } : {}),
    }
    let createdId: string | null = null
    if (editing) {
      try {
        await call(token, `/api/groups/${detail.group.id}/expenses/${editing.id}`, { method: 'PATCH', body: JSON.stringify({ ...payload, version: editing.version }) })
        setHistoryTick((n) => n + 1) // the edit is saved: fetch History now, in parallel with the group refresh below
      } catch (reason) {
        const conflict = editConflict(reason)
        if (conflict === 'stale') { setAdding(null); await handleStale(detail.group.id); return }
        if (conflict === 'gone') { setAdding(null); await handleGone(detail.group.id); return }
        throw reason
      }
    } else {
      createdId = (await call<{ id?: string }>(token, `/api/groups/${detail.group.id}/expenses`, { method: 'POST', body: JSON.stringify(payload) })).id ?? null
    }
    // The expense is saved; now its receipt. A photo problem never loses the expense.
    let photoProblem: unknown = null
    const plan = photoPlan(editing ? photo ?? null : null, value.photo)
    const targetId = editing?.id ?? createdId
    if (plan !== 'none' && targetId) {
      try {
        if (plan === 'upload' && value.photo.kind === 'set') {
          const saved = await uploadReceipt(photoApi, detail.group.id, targetId, value.photo.photo)
          if (editing) setPhoto(saved)
        } else {
          await deleteReceipt(photoApi, detail.group.id, targetId)
          if (editing) setPhoto(null)
        }
        if (editing) setHistoryTick((n) => n + 1)
      } catch (reason) {
        photoProblem = reason
      }
    }
    await refresh(detail.group.id)
    setAdding(null)
    showToast(photoProblem ? savedWithPhotoProblem(!!editing, photoProblem) : editing ? 'Expense updated' : 'Expense added')
  }

  /** Detail screen: add or replace the receipt right away (no Save step), then say so. */
  async function pickReceiptFor(expense: Expense, picked: PickedPhoto) {
    if (!detail || photoBusy) return
    const replacing = !!photo
    setPhotoBusy(true)
    setPhotoError(null)
    try {
      setPhoto(await uploadReceipt(photoApi, detail.group.id, expense.id, picked))
      setHistoryTick((n) => n + 1)
      showToast(replacing ? 'Receipt replaced' : 'Receipt added')
    } catch (reason) {
      setPhotoError(photoErrorText(reason))
    } finally {
      setPhotoBusy(false)
    }
  }

  async function removeReceiptFor(expense: Expense) {
    if (!detail || photoBusy) return
    setPhotoBusy(true)
    setPhotoError(null)
    try {
      await deleteReceipt(photoApi, detail.group.id, expense.id)
      setPhoto(null)
      setHistoryTick((n) => n + 1)
      showToast('Receipt removed')
    } catch (reason) {
      setPhotoError(photoErrorText(reason, 'Couldn’t remove the photo. Try again.'))
    } finally {
      setPhotoBusy(false)
    }
  }

  /** Someone else changed this expense first (409 STALE): reload it and its history, and say so. */
  async function handleStale(gid: string) {
    await refresh(gid).catch(() => undefined)
    setHistoryTick((n) => n + 1)
    showToast('Someone just changed this expense. Review it, then try again.')
  }

  /** The expense was deleted by someone else while the sheet was open (404): reload the group's expenses and balances, leave the dead detail. */
  async function handleGone(gid: string) {
    await refresh(gid).catch(() => undefined)
    setExpenseId(null)
    setScreen('group')
    showToast('That expense was deleted. The list is up to date.')
  }

  async function restoreExpense(id: string, gid: string) {
    try {
      await call(token, `/api/groups/${gid}/expenses/${id}/restore`, { method: 'POST' })
      await refresh(gid)
      showSnack(null)
      showToast('Expense restored')
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : 'Could not restore that')
    }
  }

  async function restoreDeleted(entry: FeedEntry) {
    if (restoringDeleted || entry.target.type !== 'expense') return
    setRestoringDeleted(true)
    try {
      await call(token, `/api/groups/${entry.group.id}/expenses/${entry.target.id}/restore`, { method: 'POST' })
      setDetailTick((n) => n + 1)
      showToast('Expense restored')
      if (!stepBack()) goGroups()
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : 'Could not restore that')
    } finally {
      setRestoringDeleted(false)
    }
  }

  async function deleteExpense(expense: Expense) {
    if (!detail || deleting) return
    const gid = detail.group.id
    setDeleting(true)
    try {
      await call(token, `/api/groups/${gid}/expenses/${expense.id}`, { method: 'DELETE', body: JSON.stringify({ version: expense.version }) })
      await refresh(gid)
      setScreen('group')
      setExpenseId(null)
      showSnack({ owner: snackOwner('group', gid), text: `Deleted ${expense.description.trim() || 'expense'}`, action: 'Undo', run: () => { void restoreExpense(expense.id, gid) } })
    } catch (reason) {
      if (isStale(reason)) { await handleStale(gid); return }
      showToast(reason instanceof Error ? reason.message : 'Could not delete that')
    } finally {
      setDeleting(false)
    }
  }

  async function record(payment: Payment) {
    if (!detail || busyRef.current) return
    const key = `${payment.fromId}:${payment.toId}`
    busyRef.current = key
    setBusyKey(key)
    try {
      const made = await call<{ id: string }>(token, `/api/groups/${detail.group.id}/settlements`, {
        method: 'POST',
        body: JSON.stringify({ fromId: payment.fromId, toId: payment.toId, minor: payment.minor }),
      })
      await refresh(detail.group.id)
      const who = (id: string) => (id === detail.yourParticipantId ? 'You' : detail.members.find((m) => m.id === id)?.name ?? 'Someone')
      showSnack({ owner: snackOwner('settle', detail.group.id), text: `Recorded ${who(payment.fromId)} → ${who(payment.toId)} ${formatMoney(payment.minor, detail.currency)}`, action: 'Undo', run: () => { void undo(made.id, true) } })
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : 'Could not record that')
    } finally {
      busyRef.current = null
      setBusyKey(null)
    }
  }

  async function undo(settlementId: string, fromSnack = false) {
    if (!detail || (busyRef.current && !fromSnack)) return
    busyRef.current = settlementId
    setBusyKey(settlementId)
    try {
      await call(token, `/api/groups/${detail.group.id}/settlements/${settlementId}`, { method: 'DELETE' })
      await refresh(detail.group.id)
      showSnack(null)
      showToast('Payment undone')
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : 'Could not undo that')
    } finally {
      busyRef.current = null
      setBusyKey(null)
    }
  }

  async function createGroup(name: string, currency: string, emoji: string) {
    if (createBusy) return
    setCreateBusy(true)
    setCreateError(null)
    try {
      const made = await call<GroupDetail>(token, '/api/groups', { method: 'POST', body: JSON.stringify({ name, currency, emoji, timezone: deviceZone() }) })
      setCreating(null)
      booted.current = true
      setGroupId(made.group.id)
      setDetail(made)
      setScreen('group')
      setHome(await call<Home>(token, '/api/home'))
    } catch (reason) {
      setCreateError(reason instanceof Error ? reason.message : 'Could not create that group')
    } finally {
      setCreateBusy(false)
    }
  }

  const shareLink = () => {
    if (!inviteUrl) { showToast('Preparing the link…'); return }
    Share.share({ message: inviteUrl }).catch(() => undefined)
  }

  const joinOnce = useRef(createOnce()).current
  const acceptJoin = () => joinOnce(acceptJoinNow)
  async function acceptJoinNow() {
    if (!joinToken || join?.kind !== 'preview' || join.joining) return
    setJoin({ ...join, joining: true, error: null })
    const before = (home?.groups ?? []).map((group) => group.id)
    try {
      const joined = await call<GroupDetail>(token, invitePath(joinToken, '/accept'), { method: 'POST' })
      setJoinToken(null)
      setJoin(null)
      setPaste('')
      setShowPaste(false)
      onInviteHandled()
      booted.current = true
      setGroupId(joined.group.id)
      setDetail(joined)
      setScreen('group')
      const already = joinedWasAlreadyMember(joined.group.id, before)
      const feedback = joinedFeedback(joined.group.name, already)
      showToast(feedback.toast)
      if (feedback.banner) setWelcome({ groupId: joined.group.id, text: feedback.banner })
      setHome(await call<Home>(token, '/api/home'))
    } catch (reason) {
      const failure = joinFailure(reason)
      if ('dead' in failure) {
        onInviteHandled()
        setJoin({ kind: 'dead', reason: failure.dead })
      } else {
        setJoin({ ...join, joining: false, error: failure.error })
      }
    }
  }

  const openPaste = () => { setShowPaste(true) }
  const openPastedLink = () => {
    const next = tokenFromInput(paste)
    if (!next) {
      setJoinError('That is not a group link')
      return
    }
    setJoinError(null)
    setJoinToken(next)
  }
  const pasteCard = <PasteCard show={showPaste} value={paste} onChange={setPaste} onOpen={openPastedLink} onToggle={setShowPaste} />

  const today = todayIso()
  const expense = detail && expenseId ? detail.expenses.find((row) => row.id === expenseId) ?? null : null
  // Edit reuses the Add sheet; reimbursements and the like stay view-only.
  const editBlock = (row: Expense) => {
    if (!detail) return 'Loading…'
    if (row.kind && row.kind !== 'expense') return 'This type of entry can’t be edited here.'
    return null
  }
  const sheetMembers = (() => {
    if (!detail) return []
    const edit = adding?.edit
    const wanted = new Set(members.map((member) => member.id))
    if (edit) for (const row of [...edit.payers, ...(edit.shares ?? [])]) wanted.add(row.participantId)
    const named = detail.members.filter((member) => wanted.has(member.id))
    return [...named.filter((m) => m.id === detail.yourParticipantId), ...named.filter((m) => m.id !== detail.yourParticipantId)]
  })()
  const sheetInitial = (() => {
    const edit = adding?.edit
    if (!edit || !detail) return null
    const ids = sheetMembers.map((member) => member.id)
    const spec = splitFromStored(edit.splitMethod, edit.splitInputs)
    const payer = edit.payers.find((p) => p.minor > 0)?.participantId ?? detail.yourParticipantId
    const foreign = isForeign(edit, detail.currency)
    return {
      // An expense is edited in the currency it was entered in; the group-currency figure follows from the stored rate.
      amountText: foreign ? majorString(edit.originalMinor!, edit.originalCurrency!) : majorString(edit.settlementMinor, detail.currency),
      currency: foreign ? edit.originalCurrency! : detail.currency,
      quote: foreign && edit.rate ? { rate: edit.rate, rateDate: edit.rateDate ?? edit.date, source: edit.rateSource === 'manual' ? 'manual' as const : 'ecb' as const } : null,
      description: edit.description,
      draft: draftFromSpec(spec ?? { type: 'exact', amounts: (edit.shares ?? []).map((s) => ({ participantId: s.participantId, minor: s.minor })) }, ids, detail.currency),
      payerId: payer,
      date: edit.date,
    }
  })()

  const tab: Tab = screen === 'account' ? 'account' : screen === 'activity' ? 'activity' : 'groups'
  const showTabs = !join && (screen === 'groups' || screen === 'group' || screen === 'account' || screen === 'activity')
  const youId = participantId ?? detail?.yourParticipantId ?? null
  const feedScreen = screen === 'activity' || screen === 'groupActivity'
  const flatAll = sectionsFeed.state.flat === true
  const activeFeed = screen === 'groupActivity' ? groupFeed : chipFilter ? chipFeed : flatAll ? flatFeed : allFeed
  const feedBar = feedScreen ? feedSnack(activeFeed.state) : null
  const openFeedEntry = (entry: FeedEntry) => {
    const target = feedTarget(entry)
    const at = target.kind === 'expense' ? 'expense' : target.kind === 'settle' ? 'settle' : target.kind === 'deleted' ? 'deleted' : 'group'
    if (screen === 'activity' || screen === 'groupActivity') setOrigin({ screen, y: scrollY.current, at })
    setExpenseId(null)
    setHistory(null)
    setGroupId(target.groupId)
    if (target.kind === 'expense') setExpenseId(target.expenseId)
    if (target.kind === 'deleted') setDeletedEntry(entry)
    setScreen(at)
    setDetailTick((n) => n + 1)
    scrollRef.current?.scrollTo({ y: 0, animated: false })
  }
  // From the group's list into a screen of its own: remember where the list was, open the new screen at its top.
  const leaveGroupList = (next: 'expense' | 'settle' | 'groupActivity') => {
    groupY.current = scrollY.current
    pendingY.current = null
    setScreen(next)
    scrollRef.current?.scrollTo({ y: 0, animated: false })
  }
  const onFeedScroll = (y: number) => {
    scrollY.current = y
    if (feedScreen && shouldAutoLoad(activeFeed.state, contentH.current - y - viewH.current)) activeFeed.more()
  }
  const onTabPress = (next: Tab) => {
    setEditingPay(false)
    if (next === 'groups') { goGroups(); return }
    if (next === 'activity' && screen === 'activity') { activeFeed.retry(); scrollRef.current?.scrollTo({ y: 0, animated: true }); return }
    setScreen(next)
  }
  let body: ReactNode
  if (join) {
    body = (
      <>
        <Text style={styles.wordmark}>Divvy</Text>
        <JoinCard view={join} onJoin={acceptJoin} onNotNow={closeJoin} onOk={closeJoin} onRetry={() => setJoinAttempt((n) => n + 1)} />
      </>
    )
  } else if (!home) {
    body = (
      <View style={styles.card}>
        <Text style={styles.groupName}>Loading…</Text>
        {error && <Text style={styles.error}>{error}</Text>}
      </View>
    )
  } else if (screen === 'account' && editingPay) {
    body = <PaymentNamesScreen initial={home.you.pay ?? {}} onSave={savePayNames} onDone={() => setEditingPay(false)} />
  } else if (screen === 'account') {
    body = <AccountScreen name={home.you.name} pay={home.you.pay} onEditName={() => setEditingName(true)} onPayNames={() => setEditingPay(true)} onSignOut={async () => {
      try { await call(token, '/api/auth/logout', { method: 'POST' }) } catch { /* The local session is what switches person. */ }
      onSignedOut()
    }} />
  } else if (screen === 'activity') {
    body = <ActivityScreen feed={activeFeed.state} youId={youId} today={today} chips={chips} filter={chipFilter} sections={sections} flat={flatAll}
      onFilter={(id) => { setFeedFilter(id); scrollRef.current?.scrollTo({ y: 0, animated: false }) }}
      onSectionMore={(id) => { if (openSections[id]) sectionPages.more(id); else setOpenSections((current) => ({ ...current, [id]: true })) }}
      onSectionLess={(id) => setOpenSections((current) => ({ ...current, [id]: false }))}
      onOpen={openFeedEntry} onMore={activeFeed.more} onRetry={activeFeed.retry} onEmptyAction={() => { if (chipFilter) openGroup(chipFilter); else goGroups() }} />
  } else if (screen === 'deleted' && deletedEntry) {
    body = <DeletedExpense entry={deletedEntry} youId={youId} timeText={timeText} busy={restoringDeleted} onBack={() => { if (!stepBack()) goGroups() }} onRestore={() => { void restoreDeleted(deletedEntry) }} />
  } else if (screen === 'groups' || !groupId) {
    body = (
      <>
        <GroupsHome home={home} onOpen={openGroup} onCreate={() => { setCreateError(null); setCreating({}) }} onPaste={openPaste} onJoinLink={pasteCard} />
        {home.groups.length === 0 && showPaste && pasteCard}
        {joinError && <Text style={styles.error}>{joinError}</Text>}
        {error && !home.groups.length && <Text style={styles.error}>{error}</Text>}
      </>
    )
  } else if (!detail || detail.group.id !== groupId) {
    body = (
      <View style={styles.card}>
        <Text style={styles.groupName}>Loading…</Text>
        {error && <Text style={styles.error}>{error}</Text>}
      </View>
    )
  } else if (screen === 'groupActivity') {
    body = <ActivityScreen group={groupIcon(detail.group)} feed={groupFeed.state} youId={youId} today={today} onBack={() => { stepBack() }} onOpen={openFeedEntry} onMore={groupFeed.more} onRetry={groupFeed.retry} onEmptyAction={() => setAdding({ edit: null })} />
  } else if (screen === 'settle') {
    body = <SettleScreen detail={detail} busyKey={busyKey} youPay={home.you.pay} onBack={() => { stepBack() }} onRecord={record} onUndo={(id) => { void undo(id) }} onPayLink={openPayLink} onAddPayNames={() => { setEditingPay(true); setScreen('account') }} />
  } else if (screen === 'expense') {
    body = expense ? (
      <ExpenseDetail detail={detail} expense={expense} history={history} canEdit={editBlock(expense) === null} whyNoEdit={editBlock(expense)} busy={deleting}
        receipt={{ photo, source: receiptSource, busy: photoBusy, error: photoError, onPick: (picked) => { void pickReceiptFor(expense, picked) }, onRemove: () => { void removeReceiptFor(expense) }, onError: setPhotoError }}
        onBack={() => { stepBack() }} onEdit={() => setAdding({ edit: expense })} onDelete={() => { void deleteExpense(expense) }} timeText={timeText} />
    ) : (
      <View style={styles.card}><Text style={styles.groupName}>That expense is gone</Text><Pressable onPress={() => { stepBack() }} accessibilityRole="button"><Text style={styles.signOut}>Back to the group</Text></Pressable></View>
    )
  } else {
    body = (
      <GroupView detail={detail} today={today}
        banner={welcome && welcome.groupId === detail.group.id ? (
          <View style={[styles.inviteNote, { marginTop: 8 }]} testID="joined-banner" accessibilityLiveRegion="polite">
            <Text style={styles.copy}>🎉  <Text style={styles.strong}>{welcome.text}</Text>. Add an expense below or share the group link.</Text>
            <Pressable onPress={() => setWelcome(null)} accessibilityRole="button" accessibilityLabel="Dismiss"><Text style={styles.signOut}>Dismiss</Text></Pressable>
          </View>
        ) : undefined}
        footer={<InviteCard url={inviteUrl} onShare={shareLink} />}
        onBack={() => { stepBack() }} onSwitcher={() => setSwitcher(true)} onShare={shareLink}
        onOpenExpense={(id) => { setHistory(null); setPhoto(undefined); setPhotoError(null); setExpenseId(id); leaveGroupList('expense') }} onSettle={() => leaveGroupList('settle')} onActivity={() => leaveGroupList('groupActivity')} onAdd={() => setAdding({ edit: null })} />
    )
  }

  return (
    <SafeAreaView style={styles.screen} edges={showTabs ? TOP_EDGES : ALL_EDGES}>
      <View style={styles.flex}>
        <ScrollView ref={scrollRef} keyboardShouldPersistTaps="handled" contentContainerStyle={v2scroll} style={styles.noSideways} horizontal={false} alwaysBounceHorizontal={false} showsHorizontalScrollIndicator={false}
          scrollEventThrottle={64} onScroll={(e) => onFeedScroll(e.nativeEvent.contentOffset.y)}
          onLayout={(e) => { viewH.current = e.nativeEvent.layout.height; restoreScroll() }}
          onContentSizeChange={(_w, h) => {
            contentH.current = h
            restoreScroll()
            // A short list that does not fill the screen asks for the next page by itself.
            if (feedScreen && pendingY.current === null && shouldAutoLoad(activeFeed.state, h - scrollY.current - viewH.current)) activeFeed.more()
          }}
          refreshControl={feedScreen && home ? <RefreshControl refreshing={activeFeed.state.loading && activeFeed.state.loaded} onRefresh={activeFeed.retry} tintColor="#0f766e" colors={['#0f766e']} /> : undefined}>
          {body}
        </ScrollView>
        {!join && screen === 'group' && detail && groupId && <Fab onPress={() => setAdding({ edit: null })} />}
        <Snack text={snack?.text ?? feedBar?.text ?? null} action={snack ? snack.action : feedBar?.action} onAction={snack ? snack.run : activeFeed.retrySnack} />
      </View>
      {showTabs && <TabBar tab={tab} onTab={onTabPress} />}
      {adding && detail && (
        <AddSheet members={sheetMembers} youId={detail.yourParticipantId} currency={detail.currency} groupName={groupIcon(detail.group).title}
          initial={sheetInitial} fetchRate={fetchRate} photo={adding.edit && adding.edit.id === expenseId ? photo ?? null : null} photoSource={adding.edit && adding.edit.id === expenseId ? receiptSource : null} onClose={() => setAdding(null)} onSave={(value) => saveExpense(value, adding.edit)} />
      )}
      {switcher && home && <SwitcherSheet groups={home.groups} currentId={groupId} onPick={openGroup} onAll={() => { setSwitcher(false); goGroups() }} onClose={() => setSwitcher(false)} />}
      {creating && <CreateGroupSheet busy={createBusy} error={createError} onCreate={createGroup} onClose={() => setCreating(null)} />}
      {editingName && home && (
        <NameSheet
          initial={home.you.name}
          onSave={async (name) => { await call(token, '/api/me', { method: 'PATCH', body: JSON.stringify({ displayName: name }) }) }}
          onSaved={(name) => {
            setEditingName(false)
            setHome((current) => current ? { ...current, you: { ...current.you, name } } : current)
            if (groupId) refresh(groupId).catch(() => undefined)
            showToast(`Saved. Friends now see you as ${name}.`)
          }}
          onClose={() => setEditingName(false)}
        />
      )}
      {returnPay && detail && returnPay.groupId === detail.group.id && stillOwed(detail.payments, returnPay) && (
        <PayReturnSheet pending={returnPay} busy={busyKey !== null}
          onYes={() => { const p = returnPay; setReturnPay(null); void record({ fromId: p.fromId, toId: p.toId, minor: p.minor }) }}
          onDifferent={() => { setReturnPay(null); setScreen('settle') }}
          onNotYet={() => setReturnPay(null)} />
      )}
      <Toast text={toast} />
    </SafeAreaView>
  )
}

const v2scroll = { padding: 18, paddingTop: contentTopGap(Platform.OS), paddingBottom: 110 }

const styles = StyleSheet.create({
  flex: { flex: 1 },
  webOuter: { flex: 1, backgroundColor: '#f6f7f4', alignItems: 'center' },
  webColumn: { flex: 1, width: '100%', maxWidth: 480 },
  providersPlaceholder: { minHeight: 44 },
  screen: { flex: 1, backgroundColor: '#f6f7f4' },
  scroll: { padding: 16, gap: 12, paddingBottom: 40, maxWidth: '100%' },
  noSideways: { overflow: 'hidden' },
  signIn: { flex: 1, padding: 20, justifyContent: 'center', gap: 10, width: '100%', maxWidth: SIGN_IN_WIDTH + 40, alignSelf: 'center', alignItems: 'stretch' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  wordmark: { fontSize: 22, fontWeight: '800', color: '#14221c' },
  you: { flex: 1, textAlign: 'right', color: '#3d4741', fontSize: 16 },
  signOut: { color: '#0f766e', fontWeight: '700' },
  brand: { fontSize: 42, fontWeight: '800', color: '#14221c', marginBottom: 8, textAlign: 'center' },
  copy: { color: '#3d4741', fontSize: 16, marginBottom: 8 },
  strip: { gap: 8, paddingVertical: 2 },
  pill: { borderRadius: 999, paddingVertical: 8, paddingHorizontal: 14, backgroundColor: 'white', borderWidth: 1, borderColor: '#e4e8e2' },
  pillOn: { backgroundColor: '#0f766e', borderColor: '#0f766e' },
  pillText: { fontWeight: '700', color: '#5d6b63' },
  pillTextOn: { color: 'white' },
  card: { backgroundColor: 'white', borderRadius: 24, padding: 18, borderWidth: 1, borderColor: '#e4e8e2', gap: 10 },
  groupName: { fontSize: 28, fontWeight: '800', color: '#14221c' },
  balance: { fontSize: 22, fontWeight: '800', color: '#0f766e' },
  amountRow: { flexDirection: 'row', alignItems: 'center', gap: 10, width: '100%' },
  // flex:1 + minWidth:0 lets the field shrink, so Add always fits (a 32 pt TextInput otherwise sizes to its content on web).
  amount: { flex: 1, minWidth: 0, flexShrink: 1, fontSize: 32, fontWeight: '800', color: '#14221c', paddingVertical: 4 },
  addButton: { flexShrink: 0 },
  description: { fontSize: 16, color: '#14221c', paddingVertical: 8 },
  input: { backgroundColor: '#f6f7f4', borderRadius: 12, padding: 14, color: '#14221c' },
  primary: { backgroundColor: '#0f766e', borderRadius: 999, paddingVertical: 12, paddingHorizontal: 16, alignItems: 'center' },
  primaryText: { color: 'white', fontWeight: '700' },
  secondary: { borderRadius: 999, paddingVertical: 10, paddingHorizontal: 14, alignItems: 'center', borderWidth: 1, borderColor: '#cfe3db', backgroundColor: '#f3faf7' },
  secondaryText: { color: '#0f766e', fontWeight: '700' },
  error: { color: '#8d2f39' },
  muted: { color: '#5f6f67', fontSize: 14 },
  section: { marginTop: 8, fontSize: 13, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase', color: '#5f6f67' },
  line: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12, paddingVertical: 8, borderTopWidth: 1, borderTopColor: '#eef2ee' },
  lineCopy: { flex: 1, gap: 2 },
  lineLabel: { flex: 1, color: '#14221c', fontSize: 16 },
  lineEnd: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  money: { fontWeight: '700', color: '#14221c' },
  expenseTitle: { fontSize: 16, fontWeight: '700', color: '#14221c' },
  record: { borderRadius: 999, paddingVertical: 7, paddingHorizontal: 12, borderWidth: 1, borderColor: '#cfe3db', backgroundColor: '#f3faf7' },
  recordText: { color: '#0f766e', fontWeight: '700' },
  shareRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  shareName: { flex: 1, color: '#14221c', fontSize: 16 },
  shareInput: { width: 110, fontSize: 18, fontWeight: '700', color: '#14221c', textAlign: 'right' },
  link: { color: '#14221c', fontSize: 14, flexShrink: 1 },
  rowActions: { flexDirection: 'row', gap: 8 },
  strong: { fontWeight: '800', color: '#14221c' },
  inviteNote: { borderRadius: 12, borderWidth: 1, borderColor: '#cfe3db', backgroundColor: '#f3faf7', padding: 12, gap: 4 },
  inputBad: { borderWidth: 1.5, borderColor: '#8d2f39', backgroundColor: '#fbeef0' },
  disabled: { opacity: 0.5 },
  centerText: { textAlign: 'center' },
  chip: { flexShrink: 1, minWidth: 0, maxWidth: 220, flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 999, borderWidth: 1, borderColor: '#e4e8e2', backgroundColor: 'white', paddingVertical: 4, paddingLeft: 4, paddingRight: 10 },
  chipAvatar: { width: 22, height: 22, borderRadius: 11, backgroundColor: '#0f766e', alignItems: 'center', justifyContent: 'center' },
  chipAvatarText: { color: 'white', fontWeight: '800', fontSize: 12 },
  chipText: { color: '#14221c', fontWeight: '700', maxWidth: 160, flexShrink: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as object,
  spacer: { flex: 1 },
  centerItems: { alignItems: 'center', gap: 12 },
  verifyingTitle: { fontSize: 22, fontWeight: '800', color: '#14221c' },
  offlineBox: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, borderRadius: 12, borderWidth: 1, borderColor: '#f1c9cf', backgroundColor: '#fbeef0', padding: 12 },
  offlineIcon: { width: 22, height: 22, borderRadius: 11, backgroundColor: '#8d2f39', alignItems: 'center', justifyContent: 'center' },
  offlineIconText: { color: 'white', fontWeight: '800' },
  offlineText: { flex: 1, color: '#8d2f39' },
})
