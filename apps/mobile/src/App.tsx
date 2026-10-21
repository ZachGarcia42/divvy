import { computeShares, exponentOf, formatMoney, parseMajor, shareGapMessage, splitPhrase } from '@divvy/domain'
import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'
import { useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { inviteFromNext, invitePath, isToken, parseDeepLink, parseInvitePreview, PENDING_INVITE_KEY, tokenFromInput, type InvitePreview } from './links'
import { CheckEmail, ExpiredLink, JoinCard, NamePrompt, NameSheet, Toast } from './November'
import { createOnce, joinFailure, joinedWasAlreadyMember, loadJoinView, type JoinView } from './flows/join'
import { checkStoredSession, createSessionExpiry, loadSession, saveSession, type KeyStore } from './flows/session'
import { nameAskedKey, shouldAskName } from './flows/names'
import { createCooldowns, emailError, LAST_EMAIL_KEY, monotonicNow, normalizeEmail, sendErrorMessage, verifyFailure } from './flows/signin'

const secureStore: KeyStore = {
  get: (key) => SecureStore.getItemAsync(key),
  set: (key, value) => SecureStore.setItemAsync(key, value),
  remove: (key) => SecureStore.deleteItemAsync(key),
}
// Every authenticated 401 (other than a dead-link BAD_TOKEN) ends the session through here.
const sessionExpiry = createSessionExpiry()
// Resend cooldowns survive going back to the email field (keyed by normalized email), for this app run.
const cooldowns = createCooldowns()

const API = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8787'
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

type HomeGroup = { id: string; name: string; currency: string; yourNetMinor: number; archived: boolean }
type Home = { you: { name: string }; groups: HomeGroup[] }
type Member = { id: string; name: string; removed: boolean }
type Expense = {
  id: string
  date: string
  description: string
  settlementMinor: number
  payers: { participantId: string; name: string; minor: number }[]
  shares?: { participantId: string; minor: number }[]
}
type Settlement = { id: string; fromId: string; toId: string; fromName: string; toName: string; minor: number }
type Payment = { fromId: string; toId: string; minor: number }
type GroupDetail = {
  group: { id: string; name: string }
  members: Member[]
  yourParticipantId: string
  nets: { participantId: string; netMinor: number }[]
  payments: Payment[]
  expenses: Expense[]
  settlements: Settlement[]
  currency: string
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


function majorString(minor: number, currency: string) {
  const exp = exponentOf(currency)
  const scale = 10 ** exp
  const abs = Math.abs(minor)
  const whole = Math.floor(abs / scale)
  const fraction = exp === 0 ? '' : `.${String(abs % scale).padStart(exp, '0')}`
  return `${minor < 0 ? '-' : ''}${whole}${fraction}`
}

function parseShare(input: string, currency: string) {
  const trimmed = input.trim()
  if (!trimmed) throw new Error('Enter each share')
  if (/^0+(\.0+)?$/.test(trimmed)) return 0
  return parseMajor(trimmed, currency)
}

function equalShareText(amount: string, members: { id: string }[], currency: string) {
  try {
    const total = parseMajor(amount, currency)
    const shares = computeShares(total, { type: 'equal', participantIds: members.map((member) => member.id) })
    return Object.fromEntries(shares.map((share) => [share.participantId, majorString(share.minor, currency)]))
  } catch {
    return Object.fromEntries(members.map((member) => [member.id, '']))
  }
}

function shortDate(iso: string) {
  const [year, month, day] = iso.split('-')
  const monthIndex = Number(month) - 1
  if (!year || !day || monthIndex < 0 || monthIndex > 11) return iso
  return `${MONTHS[monthIndex]} ${Number(day)}`
}

function payerPhrase(payers: Expense['payers'], youId: string) {
  const paying = payers.filter((payer) => payer.minor > 0)
  if (paying.length === 1) {
    const payer = paying[0]!
    return payer.participantId === youId ? 'You paid' : `${payer.name} paid`
  }
  if (paying.length > 1) {
    return `${paying.map((payer) => payer.participantId === youId ? 'You' : payer.name).join(', ')} paid`
  }
  return 'Paid'
}

function personName(detail: GroupDetail, id: string, lowerYou: boolean) {
  if (id === detail.yourParticipantId) return lowerYou ? 'you' : 'You'
  return detail.members.find((member) => member.id === id)?.name ?? 'Someone'
}

function paymentLabel(detail: GroupDetail, payment: Payment) {
  if (payment.fromId === detail.yourParticipantId) return `You pay ${personName(detail, payment.toId, true)}`
  if (payment.toId === detail.yourParticipantId) return `${personName(detail, payment.fromId, false)} pays you`
  return `${personName(detail, payment.fromId, false)} pays ${personName(detail, payment.toId, true)}`
}

function settlementLabel(detail: GroupDetail, settlement: Settlement) {
  if (settlement.fromId === detail.yourParticipantId) return `You paid ${personName(detail, settlement.toId, true)}`
  if (settlement.toId === detail.yourParticipantId) return `${settlement.fromName} paid you`
  return `${settlement.fromName} paid ${settlement.toName}`
}

function firstGroup(groups: HomeGroup[]) {
  return groups.find((group) => !group.archived)?.id ?? groups[0]?.id ?? null
}

export function App() {
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
    Linking.getInitialURL().then(take).catch(() => undefined)
    const subscription = Linking.addEventListener('url', (event) => { void take(event.url) })
    return () => subscription.remove()
  }, [])

  if (booting && !token) {
    return <SafeAreaView style={styles.screen}><View style={styles.signIn}><Text style={styles.brand} accessibilityRole="header">Divvy</Text></View></SafeAreaView>
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
    <SafeAreaView style={styles.screen}>
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

  useEffect(() => {
    // Only show "Open the sample apartment" when the API says dev seed is on.
    call<{ devSeed?: boolean }>(null, '/api/config').then((config) => setSampleAvailable(config.devSeed === true)).catch(() => setSampleAvailable(false))
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
    if (issued.devToken) {
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

  const shownError = error ?? (linkFailure?.kind === 'error' ? linkFailure.message : null)
  const offline = !!error && error.startsWith('Couldn’t send')
  return (
    <SafeAreaView style={styles.screen}>
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
          <Text style={styles.copy}>Split trips and bills with friends. We’ll email you a link to sign in.</Text>
        )}
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
          placeholderTextColor="#6b7a72"
          testID="sign-in-email"
        />
        {shownError && (offline
          ? <OfflineBox text={shownError} />
          : <Text style={styles.error} testID="sign-in-error" accessibilityLiveRegion="polite" accessibilityRole="alert">{shownError}</Text>)}
        <Pressable style={[styles.primary, sending && styles.disabled]} disabled={sending} onPress={sendLink} testID="send-link" accessibilityRole="button" accessibilityState={{ disabled: sending, busy: sending }}>
          <Text style={styles.primaryText}>{sending ? 'Sending…' : offline ? 'Try again' : 'Send link'}</Text>
        </Pressable>
        <Text style={[styles.muted, styles.centerText]}>No password. The link works for 15 minutes.</Text>
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
  const [error, setError] = useState<string | null>(null)
  const [amount, setAmount] = useState('')
  const [description, setDescription] = useState('')
  const [custom, setCustom] = useState(false)
  const [shares, setShares] = useState<Record<string, string>>({})
  const [sharesTouched, setSharesTouched] = useState(false)
  const [saving, setSaving] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const savingRef = useRef(false)
  const busyRef = useRef<string | null>(null)
  const [inviteUrl, setInviteUrl] = useState<string | null>(null)
  const [paste, setPaste] = useState('')
  const [showPaste, setShowPaste] = useState(false)
  const [joinToken, setJoinToken] = useState<string | null>(inviteToken)
  const [join, setJoin] = useState<JoinView | null>(null)
  const [joinError, setJoinError] = useState<string | null>(null)
  const [joinAttempt, setJoinAttempt] = useState(0)
  const [editingName, setEditingName] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const showToast = (text: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current)
    setToast(text)
    toastTimer.current = setTimeout(() => setToast(null), 3000)
  }
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current) }, [])

  useEffect(() => {
    if (inviteToken) setJoinToken(inviteToken)
  }, [inviteToken])

  useEffect(() => {
    let cancelled = false
    call<Home>(token, '/api/home')
      .then((next) => {
        if (cancelled) return
        setHome(next)
        setGroupId((current) => current && next.groups.some((group) => group.id === current) ? current : firstGroup(next.groups))
      })
      .catch((reason: Error) => { if (!cancelled) setError(reason.message) })
    return () => { cancelled = true }
  }, [token])

  useEffect(() => {
    if (!groupId) {
      setDetail(null)
      return
    }
    let cancelled = false
    call<GroupDetail>(token, `/api/groups/${groupId}`)
      .then((next) => { if (!cancelled) setDetail(next) })
      .catch((reason: Error) => { if (!cancelled) setError(reason.message) })
    return () => { cancelled = true }
  }, [token, groupId])

  useEffect(() => {
    setAmount('')
    setDescription('')
    setCustom(false)
    setShares({})
    setSharesTouched(false)
    setError(null)
  }, [groupId])

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
        setGroupId(view.groupId)
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

  const active = (detail?.members ?? []).filter((member) => !member.removed)

  useEffect(() => {
    if (!custom || sharesTouched || !detail) return
    const members = detail.members.filter((member) => !member.removed)
    setShares(equalShareText(amount, members, detail.currency))
  }, [custom, sharesTouched, amount, detail])

  async function refresh(nextGroupId = groupId) {
    const nextHome = await call<Home>(token, '/api/home')
    setHome(nextHome)
    const id = nextGroupId && nextHome.groups.some((group) => group.id === nextGroupId) ? nextGroupId : firstGroup(nextHome.groups)
    setGroupId(id)
    if (!id) {
      setDetail(null)
      return
    }
    setDetail(await call<GroupDetail>(token, `/api/groups/${id}`))
  }

  async function addExpense() {
    if (!detail || savingRef.current) return
    setError(null)
    if (active.length < 2) {
      setError('An expense needs at least two people')
      return
    }
    let minor: number
    try {
      minor = parseMajor(amount, detail.currency)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Enter an amount')
      return
    }
    const payload: {
      description: string
      originalMinor: number
      originalCurrency: string
      payers: { participantId: string; minor: number }[]
      split: { type: 'equal'; participantIds: string[] } | { type: 'exact'; amounts: { participantId: string; minor: number }[] }
    } = {
      description: description.trim(),
      originalMinor: minor,
      originalCurrency: detail.currency,
      payers: [{ participantId: detail.yourParticipantId, minor }],
      split: { type: 'equal', participantIds: active.map((member) => member.id) },
    }
    if (custom) {
      let amounts: { participantId: string; minor: number }[]
      try {
        amounts = active.map((member) => ({ participantId: member.id, minor: parseShare(shares[member.id] ?? '', detail.currency) }))
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : 'Enter each share')
        return
      }
      const sum = amounts.reduce((total, share) => total + share.minor, 0)
      if (sum !== minor) {
        setError(shareGapMessage(sum, minor, detail.currency) ?? 'Shares have to add up to the total')
        return
      }
      payload.split = { type: 'exact', amounts }
    }
    savingRef.current = true
    setSaving(true)
    try {
      await call(token, `/api/groups/${detail.group.id}/expenses`, { method: 'POST', body: JSON.stringify(payload) })
      setAmount('')
      setDescription('')
      setCustom(false)
      setShares({})
      setSharesTouched(false)
      await refresh(detail.group.id)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not add that')
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  async function record(payment: Payment) {
    if (!detail || busyRef.current) return
    const key = `${payment.fromId}:${payment.toId}`
    busyRef.current = key
    setBusyId(key)
    setError(null)
    try {
      await call(token, `/api/groups/${detail.group.id}/settlements`, {
        method: 'POST',
        body: JSON.stringify({ fromId: payment.fromId, toId: payment.toId, minor: payment.minor }),
      })
      await refresh(detail.group.id)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not record that')
    } finally {
      busyRef.current = null
      setBusyId(null)
    }
  }

  async function undo(settlementId: string) {
    if (!detail || busyRef.current) return
    busyRef.current = settlementId
    setBusyId(settlementId)
    setError(null)
    try {
      await call(token, `/api/groups/${detail.group.id}/settlements/${settlementId}`, { method: 'DELETE' })
      await refresh(detail.group.id)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not undo that')
    } finally {
      busyRef.current = null
      setBusyId(null)
    }
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
      setGroupId(joined.group.id)
      setDetail(joined)
      showToast(joinedWasAlreadyMember(joined.group.id, before) ? `You’re already in ${joined.group.name}.` : `You joined ${joined.group.name}`)
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

  const youNet = detail?.nets.find((net) => net.participantId === detail.yourParticipantId)?.netMinor ?? 0
  const expenses = [...(detail?.expenses ?? [])].sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id))

  return (
    <SafeAreaView style={styles.screen}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.scroll}
          style={styles.noSideways}
          horizontal={false}
          alwaysBounceHorizontal={false}
          showsHorizontalScrollIndicator={false}
        >
          <View style={styles.header}>
            <Text style={styles.wordmark}>Divvy</Text>
            <View style={styles.spacer} />
            {home && (
              <Pressable style={styles.chip} onPress={() => setEditingName(true)} testID="name-chip" accessibilityRole="button" accessibilityLabel={`Your name, ${home.you.name}. Edit`} accessibilityState={{ disabled: false }}>
                <View style={styles.chipAvatar}><Text style={styles.chipAvatarText}>{home.you.name.charAt(0).toUpperCase()}</Text></View>
                <Text style={styles.chipText} numberOfLines={1}>{home.you.name}</Text>
                <Text style={styles.muted}>✎</Text>
              </Pressable>
            )}
            <Pressable accessibilityRole="button" accessibilityState={{ disabled: false }} testID="sign-out" onPress={async () => {
              try { await call(token, '/api/auth/logout', { method: 'POST' }) } catch { /* The local session is what switches person. */ }
              onSignedOut()
            }}>
              <Text style={styles.signOut}>Sign out</Text>
            </Pressable>
          </View>

          {!join && home && home.groups.length > 0 && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.strip}>
              {home.groups.map((group) => {
                const on = group.id === groupId
                return (
                  <Pressable key={group.id} onPress={() => setGroupId(group.id)} style={[styles.pill, on && styles.pillOn]} accessibilityRole="button" accessibilityLabel={`${group.name} group`} accessibilityState={{ selected: on }}>
                    <Text style={[styles.pillText, on && styles.pillTextOn]}>{group.name}</Text>
                  </Pressable>
                )
              })}
            </ScrollView>
          )}

          {join && (
            <JoinCard view={join} onJoin={acceptJoin} onNotNow={closeJoin} onOk={closeJoin} onRetry={() => setJoinAttempt((n) => n + 1)} />
          )}
          {joinError && !join && <Text style={styles.error}>{joinError}</Text>}

          {!join && !detail && (
            <View style={styles.card}>
              <Text style={styles.groupName}>{home ? 'No group open' : 'Loading…'}</Text>
              {error ? <Text style={styles.error}>{error}</Text> : <Text style={styles.copy}>Open a group link from a friend, or use the sample apartment from the sign-in screen.</Text>}
            </View>
          )}

          {!join && detail && (
            <View style={styles.card}>
              <Text style={styles.groupName}>{detail.group.name}</Text>
              <Text style={styles.balance} testID="group-balance">
                {youNet === 0 ? 'Settled' : youNet > 0 ? `You are owed ${formatMoney(youNet, detail.currency)}` : `You owe ${formatMoney(Math.abs(youNet), detail.currency)}`}
              </Text>

              <View style={styles.amountRow}>
                <TextInput
                  testID="expense-amount"
                  value={amount}
                  onChangeText={setAmount}
                  placeholder="0.00"
                  placeholderTextColor="#8aa099"
                  keyboardType="decimal-pad"
                  inputMode="decimal"
                  style={styles.amount}
                />
                <Pressable style={[styles.primary, styles.addButton]} testID="add-expense" onPress={addExpense} accessibilityRole="button" accessibilityLabel="Add expense" accessibilityState={{ disabled: saving, busy: saving }}>
                  <Text style={styles.primaryText}>{saving ? 'Adding' : 'Add'}</Text>
                </Pressable>
              </View>
              <Text style={styles.muted}>{custom ? 'Enter the share each person owes' : 'You paid · split equally'}</Text>
              <TextInput
                testID="expense-description"
                autoFocus={false}
                value={description}
                onChangeText={setDescription}
                placeholder="Description (optional)"
                placeholderTextColor="#8aa099"
                style={styles.description}
              />
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ checked: custom }}
                testID="custom-split"
                style={styles.secondary}
                onPress={() => {
                  if (custom) {
                    setCustom(false)
                    setSharesTouched(false)
                    setShares({})
                    return
                  }
                  setCustom(true)
                }}
              >
                <Text style={styles.secondaryText}>{custom ? 'Split equally' : 'Custom split'}</Text>
              </Pressable>
              {custom && active.map((member) => (
                <View key={member.id} style={styles.shareRow}>
                  <Text style={styles.shareName}>{member.id === detail.yourParticipantId ? 'You' : member.name}</Text>
                  <TextInput
                    testID={`share-${member.id}`}
                    autoFocus={false}
                    value={shares[member.id] ?? ''}
                    onChangeText={(text) => {
                      setSharesTouched(true)
                      setShares((current) => ({ ...current, [member.id]: text }))
                    }}
                    keyboardType="decimal-pad"
                    inputMode="decimal"
                    placeholder="0.00"
                    placeholderTextColor="#8aa099"
                    style={styles.shareInput}
                  />
                </View>
              ))}
              {error && <Text style={styles.error} testID="composer-error">{error}</Text>}

              <Text style={styles.section}>Who pays whom</Text>
              {detail.payments.length === 0 && detail.settlements.length === 0 && <Text style={styles.muted}>This group is settled.</Text>}
              {detail.payments.map((payment) => (
                <View key={`${payment.fromId}-${payment.toId}`} style={styles.line}>
                  <Text style={styles.lineLabel}>{paymentLabel(detail, payment)}</Text>
                  <View style={styles.lineEnd}>
                    <Text style={styles.money}>{formatMoney(payment.minor, detail.currency)}</Text>
                    <Pressable testID={`record-${payment.fromId}-${payment.toId}`} style={styles.record} onPress={() => record(payment)} accessibilityRole="button" accessibilityLabel={`Record: ${paymentLabel(detail, payment)}`} accessibilityState={{ busy: busyId === `${payment.fromId}:${payment.toId}`, disabled: busyId !== null }}>
                      <Text style={styles.recordText}>{busyId === `${payment.fromId}:${payment.toId}` ? 'Recording' : 'Record'}</Text>
                    </Pressable>
                  </View>
                </View>
              ))}
              {detail.settlements.map((settlement) => (
                <View key={settlement.id} style={styles.line}>
                  <Text style={styles.lineLabel}>{settlementLabel(detail, settlement)}</Text>
                  <View style={styles.lineEnd}>
                    <Text style={styles.money}>{formatMoney(settlement.minor, detail.currency)}</Text>
                    <Pressable testID={`undo-${settlement.id}`} style={styles.record} onPress={() => undo(settlement.id)} accessibilityRole="button" accessibilityLabel={`Undo: ${settlementLabel(detail, settlement)}`} accessibilityState={{ busy: busyId === settlement.id, disabled: busyId !== null }}>
                      <Text style={styles.recordText}>{busyId === settlement.id ? 'Undoing' : 'Undo'}</Text>
                    </Pressable>
                  </View>
                </View>
              ))}

              <Text style={styles.section}>Expenses</Text>
              {expenses.length === 0 && <Text style={styles.muted}>Nothing here yet.</Text>}
              {expenses.map((expense) => (
                <View key={expense.id} style={styles.line} testID={`expense-${expense.id}`}>
                  <View style={styles.lineCopy}>
                    {expense.description.trim() ? <Text style={styles.expenseTitle}>{expense.description}</Text> : null}
                    <Text style={styles.muted}>{payerPhrase(expense.payers, detail.yourParticipantId)} · {shortDate(expense.date)}{!expense.description.trim() && expense.shares ? ` · ${splitPhrase(expense.shares)}` : ''}</Text>
                  </View>
                  <Text style={styles.money}>{formatMoney(expense.settlementMinor, detail.currency)}</Text>
                </View>
              ))}

              <Text style={styles.section}>Group link</Text>
              <Text selectable style={styles.link} testID="group-link">{inviteUrl ?? 'Preparing a link…'}</Text>
              <Text style={styles.muted}>Anyone already signed in can open this.</Text>
              {inviteUrl && (
                <Pressable style={styles.secondary} onPress={() => { Share.share({ message: inviteUrl }).catch(() => undefined) }} accessibilityRole="button" accessibilityState={{ disabled: false }}>
                  <Text style={styles.secondaryText}>Share</Text>
                </Pressable>
              )}
            </View>
          )}

          {!join && !detail && (
          <View style={styles.card} testID="paste-card">
            {showPaste ? (
              <>
                <TextInput
                  testID="invite-paste"
                  autoFocus={false}
                  autoCapitalize="none"
                  autoCorrect={false}
                  value={paste}
                  onChangeText={setPaste}
                  placeholder="Paste a group link"
                  placeholderTextColor="#8aa099"
                  style={styles.input}
                />
                <View style={styles.rowActions}>
                  <Pressable testID="invite-open" style={styles.primary} accessibilityRole="button" accessibilityState={{ disabled: false }} onPress={() => {
                    const next = tokenFromInput(paste)
                    if (!next) {
                      setJoinError('That is not a group link')
                      return
                    }
                    setJoinError(null)
                    setJoinToken(next)
                  }}>
                    <Text style={styles.primaryText}>Open</Text>
                  </Pressable>
                  <Pressable style={styles.secondary} onPress={() => setShowPaste(false)} accessibilityRole="button" accessibilityState={{ disabled: false }}>
                    <Text style={styles.secondaryText}>Close</Text>
                  </Pressable>
                </View>
              </>
            ) : (
              <Pressable onPress={() => setShowPaste(true)} accessibilityRole="button" accessibilityState={{ disabled: false }}>
                <Text style={styles.signOut}>Open a group link</Text>
              </Pressable>
            )}
          </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
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
      <Toast text={toast} />
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  screen: { flex: 1, backgroundColor: '#f6f7f4' },
  scroll: { padding: 16, gap: 12, paddingBottom: 40, maxWidth: '100%' },
  noSideways: { overflow: 'hidden' },
  signIn: { flex: 1, padding: 20, justifyContent: 'center', gap: 10 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  wordmark: { fontSize: 22, fontWeight: '800', color: '#14221c' },
  you: { flex: 1, textAlign: 'right', color: '#3d4741', fontSize: 16 },
  signOut: { color: '#0f766e', fontWeight: '700' },
  brand: { fontSize: 42, fontWeight: '800', color: '#14221c', marginBottom: 8 },
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
  muted: { color: '#6b7a72', fontSize: 14 },
  section: { marginTop: 8, fontSize: 13, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase', color: '#6b7a72' },
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
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 999, borderWidth: 1, borderColor: '#e4e8e2', backgroundColor: 'white', paddingVertical: 4, paddingLeft: 4, paddingRight: 10 },
  chipAvatar: { width: 22, height: 22, borderRadius: 11, backgroundColor: '#0f766e', alignItems: 'center', justifyContent: 'center' },
  chipAvatarText: { color: 'white', fontWeight: '800', fontSize: 12 },
  chipText: { color: '#14221c', fontWeight: '700' },
  spacer: { flex: 1 },
  centerItems: { alignItems: 'center', gap: 12 },
  verifyingTitle: { fontSize: 22, fontWeight: '800', color: '#14221c' },
  offlineBox: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, borderRadius: 12, borderWidth: 1, borderColor: '#f1c9cf', backgroundColor: '#fbeef0', padding: 12 },
  offlineIcon: { width: 22, height: 22, borderRadius: 11, backgroundColor: '#8d2f39', alignItems: 'center', justifyContent: 'center' },
  offlineIconText: { color: 'white', fontWeight: '800' },
  offlineText: { flex: 1, color: '#8d2f39' },
})
