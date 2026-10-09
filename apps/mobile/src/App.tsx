import { computeShares, exponentOf, formatMoney, parseMajor } from '@divvy/domain'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { useEffect, useRef, useState } from 'react'
import {
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
import { inviteFromNext, parseDeepLink, PENDING_INVITE_KEY } from './links'

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
type InvitePreview = { group: { id: string; name: string }; members: { id: string; name: string }[] }

async function call<T>(token: string | null, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  })
  const body = await response.json().catch(() => ({})) as { error?: { message?: string } }
  if (!response.ok) throw new Error(body.error?.message ?? 'Request failed')
  return body as T
}

function tokenFromInput(value: string | null | undefined) {
  if (!value) return null
  const trimmed = value.trim()
  const match = trimmed.match(/\/invite\/([^/?#\s]+)/)
  if (match?.[1]) return decodeURIComponent(match[1])
  if (/^[A-Za-z0-9_-]{20,}$/.test(trimmed)) return trimmed
  return null
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
  const [token, setToken] = useState<string | null>(null)
  const [inviteToken, setInviteToken] = useState<string | null>(null)
  const [linkError, setLinkError] = useState<string | null>(null)

  // A pending invite survives the app being killed: it is persisted until it is accepted or dismissed.
  const rememberInvite = (next: string) => {
    setInviteToken(next)
    AsyncStorage.setItem(PENDING_INVITE_KEY, next).catch(() => undefined)
  }
  const forgetInvite = () => {
    setInviteToken(null)
    AsyncStorage.removeItem(PENDING_INVITE_KEY).catch(() => undefined)
  }

  useEffect(() => {
    AsyncStorage.getItem(PENDING_INVITE_KEY)
      .then((saved) => { if (saved) setInviteToken((current) => current ?? saved) })
      .catch(() => undefined)
    const take = async (url: string | null) => {
      const link = parseDeepLink(url)
      if (!link) return
      if (link.kind === 'invite') {
        rememberInvite(link.token)
        return
      }
      try {
        const session = await call<{ token: string; next?: string | null }>(null, '/api/auth/verify', {
          method: 'POST',
          body: JSON.stringify({ token: link.token }),
        })
        const pending = inviteFromNext(session.next ?? link.next)
        if (pending) rememberInvite(pending)
        setLinkError(null)
        setToken(session.token)
      } catch (reason) {
        setLinkError(reason instanceof Error ? reason.message : 'That sign-in link is no longer valid')
      }
    }
    Linking.getInitialURL().then(take).catch(() => undefined)
    const subscription = Linking.addEventListener('url', (event) => { void take(event.url) })
    return () => subscription.remove()
  }, [])

  if (!token) return <SignIn onToken={setToken} pendingInvite={inviteToken} linkError={linkError} />
  return (
    <Ledger
      token={token}
      inviteToken={inviteToken}
      onInviteHandled={forgetInvite}
      onSignedOut={() => setToken(null)}
    />
  )
}

function SignIn({ onToken, pendingInvite, linkError }: { onToken: (token: string) => void; pendingInvite: string | null; linkError: string | null }) {
  const [email, setEmail] = useState('')
  const [error, setError] = useState<string | null>(null)
  const shownError = error ?? linkError

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.signIn}>
        <Text style={styles.brand}>Divvy</Text>
        <Text style={styles.copy}>Sign in with your own email. Each person keeps their own ledger.</Text>
        <TextInput
          style={styles.input}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          value={email}
          onChangeText={setEmail}
          placeholder="Email"
          placeholderTextColor="#6b7a72"
          testID="sign-in-email"
        />
        {shownError && <Text style={styles.error}>{shownError}</Text>}
        <Pressable style={styles.primary} onPress={async () => {
          try {
            const session = await call<{ token: string }>(null, '/api/dev/seed', { method: 'POST' })
            onToken(session.token)
          } catch (reason) {
            setError(reason instanceof Error ? reason.message : 'Could not open the sample')
          }
        }}>
          <Text style={styles.primaryText}>Open the sample apartment</Text>
        </Pressable>
        <Pressable style={styles.secondary} onPress={async () => {
          try {
            const issued = await call<{ devToken?: string }>(null, '/api/auth/magic-link', {
              method: 'POST',
              body: JSON.stringify(pendingInvite ? { email, next: `/invite/${pendingInvite}` } : { email }),
            })
            if (!issued.devToken) {
              setError('Check your email for the sign-in link.')
              return
            }
            const session = await call<{ token: string }>(null, '/api/auth/verify', {
              method: 'POST',
              body: JSON.stringify({ token: issued.devToken }),
            })
            onToken(session.token)
          } catch (reason) {
            setError(reason instanceof Error ? reason.message : 'Could not sign in')
          }
        }}>
          <Text style={styles.secondaryText}>Continue with email</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  )
}

function Ledger({
  token,
  inviteToken,
  onInviteHandled,
  onSignedOut,
}: {
  token: string
  inviteToken: string | null
  onInviteHandled: () => void
  onSignedOut: () => void
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
  const [joinPreview, setJoinPreview] = useState<InvitePreview | null>(null)
  const [joinError, setJoinError] = useState<string | null>(null)

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

  useEffect(() => {
    if (!joinToken) {
      setJoinPreview(null)
      return
    }
    let cancelled = false
    call<InvitePreview>(token, `/api/invites/${joinToken}`)
      .then((preview) => { if (!cancelled) { setJoinPreview(preview); setJoinError(null) } })
      .catch((reason: Error) => { if (!cancelled) { setJoinPreview(null); setJoinError(reason.message) } })
    return () => { cancelled = true }
  }, [token, joinToken])

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
        setError('Shares have to add up to the total')
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

  async function acceptJoin() {
    if (!joinToken) return
    setJoinError(null)
    try {
      const joined = await call<GroupDetail>(token, `/api/invites/${joinToken}/accept`, { method: 'POST' })
      setJoinToken(null)
      setJoinPreview(null)
      setPaste('')
      setShowPaste(false)
      onInviteHandled()
      setGroupId(joined.group.id)
      setDetail(joined)
      setHome(await call<Home>(token, '/api/home'))
    } catch (reason) {
      setJoinError(reason instanceof Error ? reason.message : 'Could not join')
    }
  }

  const youNet = detail?.nets.find((net) => net.participantId === detail.yourParticipantId)?.netMinor ?? 0
  const expenses = [...(detail?.expenses ?? [])].sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id))

  return (
    <SafeAreaView style={styles.screen}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.scroll}>
          <View style={styles.header}>
            <Text style={styles.wordmark}>Divvy</Text>
            <Text style={styles.you}>{home?.you.name ?? ''}</Text>
            <Pressable onPress={async () => {
              try { await call(token, '/api/auth/logout', { method: 'POST' }) } catch { /* The local session is what switches person. */ }
              onSignedOut()
            }}>
              <Text style={styles.signOut}>Sign out</Text>
            </Pressable>
          </View>

          {home && home.groups.length > 0 && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.strip}>
              {home.groups.map((group) => {
                const on = group.id === groupId
                return (
                  <Pressable key={group.id} onPress={() => setGroupId(group.id)} style={[styles.pill, on && styles.pillOn]}>
                    <Text style={[styles.pillText, on && styles.pillTextOn]}>{group.name}</Text>
                  </Pressable>
                )
              })}
            </ScrollView>
          )}

          {(joinPreview || joinError) && (
            <View style={styles.card} testID="join-card">
              <Text style={styles.groupName}>Join {joinPreview?.group.name ?? 'this group'}</Text>
              {joinPreview?.members.map((member) => <Text key={member.id} style={styles.copy}>{member.name}</Text>)}
              <Text style={styles.muted}>Joining shows the group’s whole history.</Text>
              {joinError && <Text style={styles.error}>{joinError}</Text>}
              <View style={styles.rowActions}>
                {joinPreview && (
                  <Pressable style={styles.primary} testID="join-accept" onPress={acceptJoin}>
                    <Text style={styles.primaryText}>Accept</Text>
                  </Pressable>
                )}
                <Pressable style={styles.secondary} onPress={() => { setJoinToken(null); setJoinPreview(null); setJoinError(null); onInviteHandled() }}>
                  <Text style={styles.secondaryText}>Close</Text>
                </Pressable>
              </View>
            </View>
          )}

          {!detail && (
            <View style={styles.card}>
              <Text style={styles.groupName}>{home ? 'No group open' : 'Loading…'}</Text>
              {error ? <Text style={styles.error}>{error}</Text> : <Text style={styles.copy}>Open a group link from a friend, or use the sample apartment from the sign-in screen.</Text>}
            </View>
          )}

          {detail && (
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
                <Pressable style={styles.primary} testID="add-expense" onPress={addExpense}>
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
                    <Pressable testID={`record-${payment.fromId}-${payment.toId}`} style={styles.record} onPress={() => record(payment)}>
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
                    <Pressable testID={`undo-${settlement.id}`} style={styles.record} onPress={() => undo(settlement.id)}>
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
                    <Text style={styles.muted}>{payerPhrase(expense.payers, detail.yourParticipantId)} · {shortDate(expense.date)}</Text>
                  </View>
                  <Text style={styles.money}>{formatMoney(expense.settlementMinor, detail.currency)}</Text>
                </View>
              ))}

              <Text style={styles.section}>Group link</Text>
              <Text selectable style={styles.link} testID="group-link">{inviteUrl ?? 'Preparing a link…'}</Text>
              <Text style={styles.muted}>Anyone already signed in can open this.</Text>
              {inviteUrl && (
                <Pressable style={styles.secondary} onPress={() => { Share.share({ message: inviteUrl }).catch(() => undefined) }}>
                  <Text style={styles.secondaryText}>Share</Text>
                </Pressable>
              )}
            </View>
          )}

          <View style={styles.card}>
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
                  <Pressable testID="invite-open" style={styles.primary} onPress={() => {
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
                  <Pressable style={styles.secondary} onPress={() => setShowPaste(false)}>
                    <Text style={styles.secondaryText}>Close</Text>
                  </Pressable>
                </View>
              </>
            ) : (
              <Pressable onPress={() => setShowPaste(true)}>
                <Text style={styles.signOut}>Open a group link</Text>
              </Pressable>
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  screen: { flex: 1, backgroundColor: '#f6f7f4' },
  scroll: { padding: 16, gap: 12, paddingBottom: 40 },
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
  amountRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  amount: { flex: 1, fontSize: 32, fontWeight: '800', color: '#14221c', paddingVertical: 4 },
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
  link: { color: '#14221c', fontSize: 14 },
  rowActions: { flexDirection: 'row', gap: 8 },
})
