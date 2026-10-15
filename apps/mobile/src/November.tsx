// November screens: check your email, expired link, name sheet / first-run prompt, join card, toast.
// All decisions live in ./flows so they can be unit-tested; these components only render them.
import { useEffect, useRef, useState } from 'react'
import { AccessibilityInfo, ActivityIndicator, Modal, Platform, Pressable, SafeAreaView, StyleSheet, Text, TextInput, View } from 'react-native'
import { DEAD_TITLE, deadCopy, type JoinView } from './flows/join'
import { checkName, saveNameError } from './flows/names'
import { cooldownAnnouncement, resendButton, sendErrorMessage } from './flows/signin'
import { CODE_LENGTH, codeFailure, resendPresentation, sanitizeCode, shouldSubmitCode } from './flows/code'

const C = { ink: '#14221c', body: '#3d4741', muted: '#6b7a72', teal: '#0f766e', line: '#e4e8e2', bg: '#f6f7f4', soft: '#f3faf7', softLine: '#cfe3db', red: '#8d2f39', redSoft: '#fbeef0' }

function useNow(clock: () => number) {
  const [now, setNow] = useState(clock())
  useEffect(() => {
    const timer = setInterval(() => setNow(clock()), 500)
    return () => clearInterval(timer)
  }, [clock])
  return now
}

/** iOS has no live regions, so announce explicitly; Android uses accessibilityLiveRegion on the text. */
function announce(text: string | null | undefined) {
  if (text && Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(text)
}

function useAnnounce(text: string | null | undefined) {
  useEffect(() => { announce(text) }, [text])
}

function ErrorText({ text, testID }: { text: string | null | undefined; testID?: string }) {
  useAnnounce(text)
  if (!text) return null
  return <Text style={s.error} testID={testID} accessibilityLiveRegion="polite" accessibilityRole="alert">{text}</Text>
}

function Glyph({ text, style }: { text: string; style?: object }) {
  return <Text style={style} accessible={false} importantForAccessibility="no">{text}</Text>
}

function Button({ label, onPress, disabled, busy, kind = 'primary', grow, testID, a11yLabel }: {
  label: string; onPress: () => void; disabled?: boolean; busy?: boolean; kind?: 'primary' | 'secondary' | 'link'; grow?: boolean; testID?: string; a11yLabel?: string
}) {
  const off = !!disabled || !!busy
  const box = kind === 'primary' ? s.primary : kind === 'secondary' ? s.secondary : s.link
  const text = kind === 'primary' ? s.primaryText : kind === 'secondary' ? s.secondaryText : s.linkText
  return (
    <Pressable
      style={[box, grow && s.grow, off && kind !== 'link' && s.disabled]}
      disabled={off}
      onPress={onPress}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={a11yLabel ?? label}
      accessibilityState={{ disabled: off, busy: !!busy }}
    >
      <Text style={text}>{label}</Text>
    </Pressable>
  )
}

function CodeField({ onCode, resetKey, onPointToResend }: { onCode: (code: string) => Promise<void>; resetKey: number; onPointToResend: (on: boolean) => void }) {
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const lastSubmitted = useRef<string | null>(null)
  // A Resend means a new code: clear the field and any error.
  useEffect(() => { setCode(''); setError(null); lastSubmitted.current = null }, [resetKey])
  const submit = async (value: string) => {
    if (!shouldSubmitCode(value, lastSubmitted.current, busy)) return
    lastSubmitted.current = value
    setBusy(true)
    setError(null)
    try {
      await onCode(value)
    } catch (reason) {
      const failure = codeFailure(reason)
      setError(failure.message)
      onPointToResend(failure.pointToResend)
      if (failure.clearField) setCode('')
      lastSubmitted.current = failure.clearField ? null : value
    } finally {
      setBusy(false)
    }
  }
  return (
    <View style={{ gap: 6 }}>
      <Text style={s.label} nativeID="code-label">Enter the 6-digit code</Text>
      <View style={s.codeWrap}>
      <TextInput
        autoFocus
        testID="code-input"
        value={code}
        onChangeText={(text) => {
          const next = sanitizeCode(text)
          setCode(next)
          if (error) setError(null)
          if (next.length < CODE_LENGTH) lastSubmitted.current = null
          void submit(next)
        }}
        keyboardType="number-pad"
        inputMode="numeric"
        textContentType="oneTimeCode"
        autoComplete="one-time-code"
        maxLength={32}
        editable={!busy}
        style={[s.codeInput, !!error && s.codeBad, busy && s.codeBusy]}
        placeholder="123 456"
        placeholderTextColor={C.muted}
        accessibilityLabel="6-digit sign-in code"
        accessibilityLabelledBy="code-label"
        accessibilityState={{ busy, disabled: busy }}
      />
      {busy && (
        <View style={s.codeSpinner} accessible={false} importantForAccessibility="no-hide-descendants">
          <ActivityIndicator color={C.teal} />
        </View>
      )}
      </View>
      {/* Screen readers still hear "Checking…"; sighted users see the greyed digits and the spinner. */}
      <Text style={s.srOnly} accessibilityLiveRegion="polite">{busy ? 'Checking…' : ''}</Text>
      <ErrorText text={error} testID="code-error" />
      <Text style={s.muted}>The code works for 10 minutes.</Text>
    </View>
  )
}

export function CheckEmail({ email, pendingInvite, lastSentAt, now: clock, onResend, onCode, onBack }: {
  email: string
  pendingInvite: boolean
  lastSentAt: number | null
  now: () => number
  onResend: () => Promise<void>
  onCode: (code: string) => Promise<void>
  onBack: () => void
}) {
  const [resends, setResends] = useState(0)
  const [pointToResend, setPointToResend] = useState(false)
  const [resentAt, setResentAt] = useState<number | null>(null)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const now = useNow(clock)
  const button = resendPresentation(resendButton({ sentAt: lastSentAt, resentAt, sending }, now), { pointToResend, sending })
  const left = Number(/(\d+) s$/.exec(button.label)?.[1] ?? 0)
  const previousLeft = useRef(0)
  const [cooldownMessage, setCooldownMessage] = useState<string | null>(null)
  useEffect(() => {
    const message = cooldownAnnouncement(previousLeft.current, left)
    previousLeft.current = left
    if (message) {
      setCooldownMessage(message)
      announce(message)
    }
  }, [left])
  return (
    <SafeAreaView style={s.screen}>
      <View style={s.center} testID="check-email">
        <View style={s.badge}><Glyph text="✉" style={s.badgeText} /></View>
        <Text style={s.title} accessibilityRole="header">Check your email</Text>
        <Text style={s.body}>We sent a code and a sign-in link to <Text style={s.strong}>{email}</Text>.</Text>
        <CodeField onCode={onCode} resetKey={resends} onPointToResend={setPointToResend} />
        {pendingInvite
          ? <View style={s.note}><Text style={s.noteText}><Glyph text="🔗  " />After you sign in, we’ll open the group link.</Text></View>
          : <Text style={s.muted}>Or open the link in the email on this phone. Not there? Check spam.</Text>}
        <ErrorText text={error} testID="resend-error" />
        <Button kind={button.kind} testID="resend" label={button.label} disabled={button.disabled} busy={sending} onPress={async () => {
          setSending(true)
          setError(null)
          try {
            await onResend()
            setPointToResend(false)
            setResends((n) => n + 1)
            setResentAt(clock())
            announce('Sent again')
          } catch (reason) {
            setError(sendErrorMessage(reason))
          } finally {
            setSending(false)
          }
        }} />
        {/* Screen readers hear the cooldown once at its start and once at its end, not every tick. */}
        <Text style={s.srOnly} accessibilityLiveRegion="polite">{cooldownMessage ?? ''}</Text>
        <Button kind="link" testID="different-email" label="Use a different email" onPress={onBack} />
      </View>
    </SafeAreaView>
  )
}

export function ExpiredLink({ hasEmail, onSendNew, onBack }: { hasEmail: boolean; onSendNew: () => Promise<void>; onBack: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <SafeAreaView style={s.screen}>
      <View style={s.center} testID="expired-link">
        <View style={[s.badge, s.badgeRed]}><Glyph text="!" style={[s.badgeText, { color: C.red }]} /></View>
        <Text style={s.title} accessibilityRole="header">That link has expired</Text>
        <Text style={s.body}>Sign-in links work once, for 15 minutes. We can send you a fresh one.</Text>
        <ErrorText text={error} />
        <Button label={busy ? 'Sending…' : 'Send a new link'} busy={busy} onPress={async () => {
          if (!hasEmail) return onBack()
          setBusy(true)
          setError(null)
          try { await onSendNew() } catch (reason) { setError(sendErrorMessage(reason)) } finally { setBusy(false) }
        }} />
        <Button kind="link" label="Use a different email" onPress={onBack} />
      </View>
    </SafeAreaView>
  )
}

function NameField({ value, onChange, onSubmit, error, counter, selectAll }: {
  value: string; onChange: (text: string) => void; onSubmit: () => void; error: string | null; counter: string | null; selectAll?: boolean
}) {
  return (
    <View style={{ gap: 6 }}>
      <View style={[s.field, error && s.fieldBad]}>
        <TextInput
          testID="name-input"
          value={value}
          onChangeText={onChange}
          autoFocus
          selectTextOnFocus={selectAll}
          returnKeyType="done"
          onSubmitEditing={onSubmit}
          style={s.fieldInput}
          maxLength={200}
          accessibilityLabel="Your name"
          accessibilityHint={counter ? `${counter} characters` : undefined}
        />
        {counter && <Text style={[s.counter, error && { color: C.red }]} accessibilityLabel={`${counter} characters`}>{counter}</Text>}
      </View>
      <ErrorText text={error} testID="name-error" />
    </View>
  )
}

/** Shared save logic for the sheet and the first-run prompt. Saves only valid, changed-or-confirmed names. */
function useNameForm(initial: string, save: (name: string) => Promise<void>, done: (name: string) => void) {
  const [value, setValue] = useState(initial)
  const [serverError, setServerError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const check = checkName(value)
  const submit = async () => {
    if (!check.canSave || saving) return
    setSaving(true)
    setServerError(null)
    try {
      await save(value.trim())
      done(value.trim())
    } catch (reason) {
      setServerError(saveNameError(reason))
    } finally {
      setSaving(false)
    }
  }
  const change = (text: string) => { setValue(text); setServerError(null) }
  return { value, change, submit, saving, canSave: check.canSave && !saving, error: check.error ?? serverError, counter: check.counter }
}

export function NameSheet({ initial, onSave, onSaved, onClose }: {
  initial: string; onSave: (name: string) => Promise<void>; onSaved: (name: string) => void; onClose: () => void
}) {
  const form = useNameForm(initial, onSave, onSaved)
  return (
    <Modal transparent animationType="slide" onRequestClose={onClose} visible>
      <Pressable style={s.scrim} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close without saving" />
      <View style={s.sheet} testID="name-sheet">
        <View style={s.grabber} accessible={false} importantForAccessibility="no" />
        <Text style={s.sheetTitle} accessibilityRole="header">Your name</Text>
        <Text style={s.muted}>Friends see this in every group.</Text>
        <NameField value={form.value} onChange={form.change} onSubmit={form.submit} error={form.error} counter={form.counter} />
        <View style={s.row}>
          <Button kind="secondary" grow label="Cancel" onPress={onClose} testID="name-cancel" />
          <Button grow label={form.saving ? 'Saving…' : 'Save'} disabled={!form.canSave} busy={form.saving} onPress={form.submit} testID="name-save" />
        </View>
      </View>
    </Modal>
  )
}

export function NamePrompt({ current, onSave, onDone }: { current: string; onSave: (name: string) => Promise<void>; onDone: (name: string | null) => void }) {
  const form = useNameForm(current, onSave, (name) => onDone(name))
  return (
    <SafeAreaView style={s.screen}>
      <View style={s.top} testID="name-firstrun">
        <Text style={s.wordmark}>Divvy</Text>
        <Text style={s.title} accessibilityRole="header">What should friends call you?</Text>
        <Text style={s.body}>Right now you show up as “{current}”.</Text>
        <NameField value={form.value} onChange={form.change} onSubmit={form.submit} error={form.error} counter={form.counter} selectAll />
        <Button label={form.saving ? 'Saving…' : 'Save'} disabled={!form.canSave} busy={form.saving} onPress={form.submit} testID="name-firstrun-save" />
        <Button kind="link" label="Skip" onPress={() => onDone(null)} testID="name-firstrun-skip" />
      </View>
    </SafeAreaView>
  )
}

export function JoinCard({ view, onJoin, onNotNow, onOk, onRetry }: {
  view: JoinView; onJoin: () => void; onNotNow: () => void; onOk: () => void; onRetry: () => void
}) {
  if (view.kind === 'loading') {
    return <View style={s.card} testID="join-loading"><Text style={s.muted}>Opening the group link…</Text></View>
  }
  if (view.kind === 'offline') {
    return (
      <View style={s.card} testID="join-offline">
        <Text style={s.cardTitle} accessibilityRole="header">Couldn’t load the group link</Text>
        <ErrorText text="Check your signal and try again." />
        <View style={s.row}>
          <Button kind="secondary" grow label="Not now" onPress={onNotNow} testID="join-offline-not-now" />
          <Button grow label="Try again" onPress={onRetry} testID="join-retry" />
        </View>
      </View>
    )
  }
  if (view.kind === 'dead') {
    return (
      <View style={s.card} testID="join-dead">
        <View style={[s.badge, s.badgeRed]}><Glyph text="!" style={[s.badgeText, { color: C.red }]} /></View>
        <Text style={s.cardTitle} accessibilityRole="header">{DEAD_TITLE}</Text>
        <Text style={s.body}>{deadCopy(view.reason)}</Text>
        <Button label="OK" onPress={onOk} testID="join-dead-ok" />
      </View>
    )
  }
  if (view.kind !== 'preview') return null
  return (
    <View style={s.card} testID="join-card">
      <Text style={s.eyebrow}>Group link</Text>
      <Text style={s.cardTitle} accessibilityRole="header">Join {view.groupName}</Text>
      {view.members.map((member) => (
        <View key={member.id} style={s.member}>
          <View style={s.avatar} accessible={false} importantForAccessibility="no-hide-descendants"><Text style={s.avatarText}>{member.name.charAt(0).toUpperCase()}</Text></View>
          <Text style={s.memberName}>{member.name}</Text>
        </View>
      ))}
      <View style={s.note}><Text style={s.noteText}><Glyph text="👁  " />Joining shows the group’s whole history: every expense and payment so far.</Text></View>
      <ErrorText text={view.error} testID="join-error" />
      <View style={s.row}>
        <Button kind="secondary" grow label="Not now" onPress={onNotNow} testID="join-not-now" />
        <Button grow label={view.joining ? 'Joining…' : 'Join'} busy={view.joining} onPress={onJoin} testID="join-accept" />
      </View>
    </View>
  )
}

export function Toast({ text }: { text: string | null }) {
  if (!text) return null
  return <ToastBody text={text} />
}

function ToastBody({ text }: { text: string }) {
  useAnnounce(text)
  return <View style={s.toast} testID="toast" pointerEvents="none"><Text style={s.toastText} accessibilityLiveRegion="polite">{text}</Text></View>
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  center: { flex: 1, padding: 24, justifyContent: 'center', gap: 12 },
  top: { flex: 1, padding: 24, paddingTop: 48, gap: 12 },
  wordmark: { fontSize: 22, fontWeight: '800', color: C.ink, marginBottom: 24 },
  title: { fontSize: 28, fontWeight: '800', color: C.ink },
  body: { fontSize: 16, color: C.body },
  strong: { fontWeight: '800', color: C.ink },
  muted: { fontSize: 14, color: C.muted },
  error: { color: C.red },
  badge: { width: 48, height: 48, borderRadius: 14, borderWidth: 1, borderColor: C.softLine, backgroundColor: C.soft, alignItems: 'center', justifyContent: 'center' },
  badgeRed: { borderColor: '#f1c9cf', backgroundColor: C.redSoft },
  badgeText: { fontSize: 22, color: C.teal, fontWeight: '800' },
  note: { borderRadius: 12, borderWidth: 1, borderColor: C.softLine, backgroundColor: C.soft, padding: 12 },
  noteText: { color: C.body },
  primary: { backgroundColor: C.teal, borderRadius: 999, paddingVertical: 14, paddingHorizontal: 16, alignItems: 'center' },
  primaryText: { color: 'white', fontWeight: '700', fontSize: 16 },
  secondary: { borderRadius: 999, paddingVertical: 13, paddingHorizontal: 14, alignItems: 'center', borderWidth: 1, borderColor: C.softLine, backgroundColor: C.soft },
  secondaryText: { color: C.teal, fontWeight: '700', fontSize: 16 },
  disabled: { opacity: 0.5 },
  link: { alignItems: 'center', paddingVertical: 10 },
  linkText: { color: C.teal, fontWeight: '700' },
  row: { flexDirection: 'row', gap: 10 },
  grow: { flex: 1 },
  field: { flexDirection: 'row', alignItems: 'center', borderWidth: 1.5, borderColor: C.teal, borderRadius: 12, backgroundColor: 'white', paddingHorizontal: 12 },
  fieldBad: { borderColor: C.red, backgroundColor: C.redSoft },
  fieldInput: { flex: 1, paddingVertical: 12, fontSize: 16, color: C.ink },
  counter: { fontSize: 12, fontWeight: '700', color: C.muted },
  scrim: { flex: 1, backgroundColor: 'rgba(20,34,28,0.35)' },
  sheet: { backgroundColor: 'white', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 20, paddingBottom: 32, gap: 10 },
  grabber: { alignSelf: 'center', width: 40, height: 5, borderRadius: 3, backgroundColor: C.line, marginBottom: 4 },
  sheetTitle: { fontSize: 20, fontWeight: '800', color: C.ink },
  card: { backgroundColor: 'white', borderRadius: 24, padding: 18, borderWidth: 1, borderColor: C.line, gap: 10 },
  cardTitle: { fontSize: 24, fontWeight: '800', color: C.ink },
  eyebrow: { fontSize: 12, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase', color: C.muted },
  member: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4 },
  avatar: { width: 28, height: 28, borderRadius: 14, backgroundColor: C.teal, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: 'white', fontWeight: '800' },
  memberName: { fontSize: 16, color: C.ink },
  toast: { position: 'absolute', left: 16, right: 16, bottom: 24, backgroundColor: C.ink, borderRadius: 14, padding: 14 },
  toastText: { color: 'white', fontWeight: '600' },
  label: { fontSize: 14, fontWeight: '700', color: C.body },
  codeWrap: { position: 'relative', justifyContent: 'center' },
  codeBad: { borderColor: C.red, borderWidth: 2 },
  codeBusy: { color: C.muted, opacity: 0.6 },
  codeSpinner: { position: 'absolute', right: 14 },
  codeInput: { borderWidth: 1.5, borderColor: C.teal, borderRadius: 12, backgroundColor: 'white', paddingVertical: 12, fontSize: 28, fontWeight: '800', letterSpacing: 10, textAlign: 'center', color: C.ink },
  srOnly: { position: 'absolute', width: 1, height: 1, opacity: 0 },
})
