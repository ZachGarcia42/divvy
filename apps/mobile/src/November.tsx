// November screens: check your email, expired link, name sheet / first-run prompt, join card, toast.
// All decisions live in ./flows so they can be unit-tested; these components only render them.
import { useEffect, useState } from 'react'
import { Modal, Pressable, SafeAreaView, StyleSheet, Text, TextInput, View } from 'react-native'
import { DEAD_TITLE, deadCopy, type JoinView } from './flows/join'
import { checkName, saveNameError } from './flows/names'
import { resendButton, sendErrorMessage } from './flows/signin'

const C = { ink: '#14221c', body: '#3d4741', muted: '#6b7a72', teal: '#0f766e', line: '#e4e8e2', bg: '#f6f7f4', soft: '#f3faf7', softLine: '#cfe3db', red: '#8d2f39', redSoft: '#fbeef0' }

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(timer)
  }, [active])
  return now
}

export function CheckEmail({ email, pendingInvite, onResend, onBack }: {
  email: string
  pendingInvite: boolean
  onResend: () => Promise<void>
  onBack: () => void
}) {
  const [sentAt] = useState(() => Date.now())
  const [resentAt, setResentAt] = useState<number | null>(null)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const now = useNow(true)
  const button = resendButton({ sentAt, resentAt, sending }, now)
  return (
    <SafeAreaView style={s.screen}>
      <View style={s.center} testID="check-email">
        <View style={s.badge}><Text style={s.badgeText}>✉</Text></View>
        <Text style={s.title}>Check your email</Text>
        <Text style={s.body}>We sent a sign-in link to <Text style={s.strong}>{email}</Text>. Open it on this phone.</Text>
        {pendingInvite
          ? <View style={s.note}><Text style={s.noteText}>🔗  After you sign in, we’ll open the group link.</Text></View>
          : <Text style={s.muted}>It works for 15 minutes. Not there? Check spam.</Text>}
        {error && <Text style={s.error} testID="resend-error">{error}</Text>}
        <Pressable testID="resend" disabled={button.disabled} style={[s.secondary, button.disabled && s.disabled]} onPress={async () => {
          setSending(true)
          setError(null)
          try {
            await onResend()
            setResentAt(Date.now())
          } catch (reason) {
            setError(sendErrorMessage(reason))
          } finally {
            setSending(false)
          }
        }}>
          <Text style={s.secondaryText}>{button.label}</Text>
        </Pressable>
        <Pressable testID="different-email" onPress={onBack} style={s.link}><Text style={s.linkText}>Use a different email</Text></Pressable>
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
        <View style={[s.badge, s.badgeRed]}><Text style={[s.badgeText, { color: C.red }]}>!</Text></View>
        <Text style={s.title}>That link has expired</Text>
        <Text style={s.body}>Sign-in links work once, for 15 minutes. We can send you a fresh one.</Text>
        {error && <Text style={s.error}>{error}</Text>}
        <Pressable style={[s.primary, busy && s.disabled]} disabled={busy} onPress={async () => {
          if (!hasEmail) return onBack()
          setBusy(true)
          setError(null)
          try { await onSendNew() } catch (reason) { setError(sendErrorMessage(reason)) } finally { setBusy(false) }
        }}>
          <Text style={s.primaryText}>{busy ? 'Sending…' : 'Send a new link'}</Text>
        </Pressable>
        <Pressable onPress={onBack} style={s.link}><Text style={s.linkText}>Use a different email</Text></Pressable>
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
        />
        {counter && <Text style={[s.counter, error && { color: C.red }]}>{counter}</Text>}
      </View>
      {error && <Text style={s.error} testID="name-error">{error}</Text>}
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
      <Pressable style={s.scrim} onPress={onClose} />
      <View style={s.sheet} testID="name-sheet">
        <View style={s.grabber} />
        <Text style={s.sheetTitle}>Your name</Text>
        <Text style={s.muted}>Friends see this in every group.</Text>
        <NameField value={form.value} onChange={form.change} onSubmit={form.submit} error={form.error} counter={form.counter} />
        <View style={s.row}>
          <Pressable style={[s.secondary, s.grow]} onPress={onClose} testID="name-cancel"><Text style={s.secondaryText}>Cancel</Text></Pressable>
          <Pressable style={[s.primary, s.grow, !form.canSave && s.disabled]} disabled={!form.canSave} onPress={form.submit} testID="name-save">
            <Text style={s.primaryText}>{form.saving ? 'Saving…' : 'Save'}</Text>
          </Pressable>
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
        <Text style={s.title}>What should friends call you?</Text>
        <Text style={s.body}>Right now you show up as “{current}”.</Text>
        <NameField value={form.value} onChange={form.change} onSubmit={form.submit} error={form.error} counter={form.counter} selectAll />
        <Pressable style={[s.primary, !form.canSave && s.disabled]} disabled={!form.canSave} onPress={form.submit} testID="name-firstrun-save">
          <Text style={s.primaryText}>{form.saving ? 'Saving…' : 'Save'}</Text>
        </Pressable>
        <Pressable style={s.link} onPress={() => onDone(null)} testID="name-firstrun-skip"><Text style={s.linkText}>Skip</Text></Pressable>
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
        <Text style={s.cardTitle}>Couldn’t load the group link</Text>
        <Text style={s.body}>Check your signal and try again.</Text>
        <View style={s.row}>
          <Pressable style={[s.secondary, s.grow]} onPress={onNotNow}><Text style={s.secondaryText}>Not now</Text></Pressable>
          <Pressable style={[s.primary, s.grow]} onPress={onRetry}><Text style={s.primaryText}>Try again</Text></Pressable>
        </View>
      </View>
    )
  }
  if (view.kind === 'dead') {
    return (
      <View style={s.card} testID="join-dead">
        <View style={[s.badge, s.badgeRed]}><Text style={[s.badgeText, { color: C.red }]}>!</Text></View>
        <Text style={s.cardTitle}>{DEAD_TITLE}</Text>
        <Text style={s.body}>{deadCopy(view.reason)}</Text>
        <Pressable style={s.primary} onPress={onOk} testID="join-dead-ok"><Text style={s.primaryText}>OK</Text></Pressable>
      </View>
    )
  }
  if (view.kind !== 'preview') return null
  return (
    <View style={s.card} testID="join-card">
      <Text style={s.eyebrow}>Group link</Text>
      <Text style={s.cardTitle}>Join {view.groupName}</Text>
      {view.members.map((member) => (
        <View key={member.id} style={s.member}>
          <View style={s.avatar}><Text style={s.avatarText}>{member.name.charAt(0).toUpperCase()}</Text></View>
          <Text style={s.memberName}>{member.name}</Text>
        </View>
      ))}
      <View style={s.note}><Text style={s.noteText}>👁  Joining shows the group’s whole history: every expense and payment so far.</Text></View>
      {view.error && <Text style={s.error} testID="join-error">{view.error}</Text>}
      <View style={s.row}>
        <Pressable style={[s.secondary, s.grow]} onPress={onNotNow} testID="join-not-now"><Text style={s.secondaryText}>Not now</Text></Pressable>
        <Pressable style={[s.primary, s.grow, view.joining && s.disabled]} disabled={view.joining} onPress={onJoin} testID="join-accept">
          <Text style={s.primaryText}>{view.joining ? 'Joining…' : 'Join'}</Text>
        </Pressable>
      </View>
    </View>
  )
}

export function Toast({ text }: { text: string | null }) {
  if (!text) return null
  return <View style={s.toast} testID="toast" pointerEvents="none"><Text style={s.toastText}>{text}</Text></View>
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
})
