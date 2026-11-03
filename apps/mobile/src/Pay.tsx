// Payment links (design 18–21): the "Pay <name> with" rows on Settle up, the Account → Payment names form, and the
// "Did you send…?" sheet. Text labels in coloured initial squares, no brand logos. Divvy never moves money; every
// record still starts from a tap on one of these buttons.
import { PAY_FIELD, PAY_LABELS, PAY_PROVIDERS, checkHandle, formatMoney, type PayHandles, type PayProvider } from '@divvy/domain'
import { useState } from 'react'
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { BottomSheet } from './BottomSheet'
import { PAY_TILE, RETURN_HINT, returnQuestion, type PayRow, type PayRows, type PendingPay } from './flows/pay'

const C = { bg: '#f6f7f4', card: '#ffffff', line: '#e4e8e2', teal: '#0f766e', mint: '#cfe3db', soft: '#f3faf7', ink: '#14221c', muted: '#5f6f67', hint: '#5f6f67', red: '#b4323f' }
const web = Platform.OS === 'web'
const noOutline = (web ? { outlineStyle: 'none' } : {}) as object

function Tile({ provider, dim = false }: { provider: PayProvider; dim?: boolean }) {
  const tile = PAY_TILE[provider]
  return (
    <View accessible={false} importantForAccessibility="no-hide-descendants" style={[s.tile, { backgroundColor: dim ? '#cfd6d2' : tile.color }]}>
      <Text style={s.tileText}>{tile.initial}</Text>
    </View>
  )
}

/** The Pay <name> with rows. `rows` are already built for the amount shown above, in the group's currency. */
export function PayRowsSection({ payeeName, pay, onOpen }: { payeeName: string; pay: PayRows; onOpen: (row: PayRow) => void }) {
  const first = payeeName.split(' ')[0] || payeeName
  if (pay.nothing) {
    return (
      <View testID="pay-none" style={[s.row, s.dashed]}>
        <View style={[s.tile, { backgroundColor: '#cfd6d2' }]}><Text style={s.tileText}>–</Text></View>
        <View style={s.grow}><Text style={[s.name, { color: C.muted }]}>{first} hasn’t added payment names</Text><Text style={s.sub}>Pay another way, then record it below.</Text></View>
      </View>
    )
  }
  return (
    <>
      {pay.rows.map((row) => (
        <Pressable key={row.provider} style={s.row} onPress={() => onOpen(row)} accessibilityRole="link" accessibilityLabel={`Pay ${first} with ${row.label}, opens ${row.label} with ${row.opensWith}`} testID={`pay-${row.provider}`}>
          <Tile provider={row.provider} />
          <View style={s.grow}><Text style={s.name}>{row.label}</Text><Text style={s.sub}>{row.sub}</Text></View>
          <Text style={s.out} accessible={false}>↗</Text>
        </Pressable>
      ))}
      {pay.missing.map((provider) => (
        <View key={provider} style={[s.row, s.dashed]} testID={`pay-missing-${provider}`}>
          <Tile provider={provider} dim />
          <View style={s.grow}><Text style={[s.name, { color: C.muted }]}>{PAY_LABELS[provider]}</Text><Text style={s.sub}>{first} hasn’t added {PAY_LABELS[provider]}</Text></View>
        </View>
      ))}
    </>
  )
}

export function PayNudge({ onAdd }: { onAdd: () => void }) {
  return (
    <View style={s.nudge} testID="pay-nudge">
      <Text style={s.nudgeTitle}>Get paid in one tap</Text>
      <Text style={s.nudgeBody}>Add your Venmo, PayPal or Cash App name and friends get a pay button with the amount filled in.</Text>
      <Pressable style={s.btn} onPress={onAdd} accessibilityRole="button" testID="pay-nudge-add"><Text style={s.btnText}>Add payment names</Text></Pressable>
    </View>
  )
}

/** One-line summary for the Account row. */
export function paySummary(pay: PayHandles | undefined): string {
  const names = PAY_PROVIDERS.filter((provider) => pay?.[provider]).map((provider) => PAY_LABELS[provider])
  return names.length === 0 ? 'Add Venmo, PayPal or Cash App so friends can pay you' : names.join(' · ')
}

const PREFIX: Record<PayProvider, string> = { venmo: '@', paypal: 'paypal.me/', cashapp: '$' }

/** Account → Payment names. Every field is optional; empty clears it. */
export function PaymentNamesScreen({ initial, onSave, onDone }: { initial: PayHandles; onSave: (pay: Record<PayProvider, string | null>) => Promise<void>; onDone: () => void }) {
  const [values, setValues] = useState<Record<PayProvider, string>>({ venmo: initial.venmo ?? '', paypal: initial.paypal ?? '', cashapp: initial.cashapp ?? '' })
  const [errors, setErrors] = useState<Partial<Record<PayProvider, string>>>({})
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const check = (provider: PayProvider) => {
    const result = checkHandle(provider, values[provider])
    setErrors((current) => ({ ...current, [provider]: result.ok ? undefined : result.message }))
    return result
  }
  const save = async () => {
    if (saving) return
    const next = {} as Record<PayProvider, string | null>
    const bad: Partial<Record<PayProvider, string>> = {}
    for (const provider of PAY_PROVIDERS) {
      const result = checkHandle(provider, values[provider])
      if (result.ok) next[provider] = result.value
      else bad[provider] = result.message
    }
    setErrors(bad)
    setFailed(null)
    if (Object.keys(bad).length > 0) return
    setSaving(true)
    try {
      await onSave(next)
      onDone()
    } catch (reason) {
      setFailed(reason instanceof Error ? reason.message : 'Could not save. Try again.')
    } finally {
      setSaving(false)
    }
  }
  return (
    <>
      <View style={s.top}>
        <Pressable style={s.ib} onPress={onDone} accessibilityRole="button" accessibilityLabel="Back to account" testID="paynames-back"><Text style={s.ibText} accessible={false}>‹</Text></Pressable>
        <Text style={s.topTitle} accessibilityRole="header">Payment names</Text>
        <View style={{ width: 40 }} />
      </View>
      <Text style={s.lead}>Optional. People in your groups see these on Settle up so they can pay you faster. Never shared outside your groups.</Text>
      {PAY_PROVIDERS.map((provider) => (
        <View key={provider}>
          <Text style={s.eye}>{PAY_FIELD[provider].label}</Text>
          <View style={[s.field, errors[provider] ? s.fieldBad : null]}>
            <Text style={s.prefix} accessible={false}>{PREFIX[provider]}</Text>
            <TextInput
              testID={`paynames-${provider}`} value={values[provider]} autoCapitalize="none" autoCorrect={false} spellCheck={false}
              onChangeText={(text) => { setValues((current) => ({ ...current, [provider]: text })); if (errors[provider]) setErrors((current) => ({ ...current, [provider]: undefined })) }}
              onBlur={() => { check(provider) }} placeholder={PAY_FIELD[provider].placeholder} placeholderTextColor={C.hint}
              accessibilityLabel={PAY_FIELD[provider].label} style={[s.input, noOutline]}
            />
          </View>
          <Text style={[s.hint, errors[provider] ? { color: C.red } : null]} testID={`paynames-${provider}-hint`}>{errors[provider] ?? PAY_FIELD[provider].hint}</Text>
        </View>
      ))}
      <Text style={s.hint}>Venmo and Cash App buttons only appear in groups that use US dollars.</Text>
      {failed && <Text style={[s.hint, { color: C.red }]} testID="paynames-error">{failed}</Text>}
      <Pressable style={[s.btn, { marginTop: 22 }, saving && { opacity: 0.6 }]} disabled={saving} onPress={() => { void save() }} accessibilityRole="button" accessibilityState={{ busy: saving, disabled: saving }} testID="paynames-save">
        <Text style={s.btnText}>{saving ? 'Saving…' : 'Save'}</Text>
      </Pressable>
    </>
  )
}

/** Shown when the app comes back after a payment link. It only asks; Yes is the one tap that records. */
export function PayReturnSheet({ pending, busy, onYes, onDifferent, onNotYet }: { pending: PendingPay; busy: boolean; onYes: () => void; onDifferent: () => void; onNotYet: () => void }) {
  const money = formatMoney(pending.minor, pending.currency)
  return (
    <BottomSheet onClose={onNotYet} panelStyle={[s.sheet, web && s.sheetWeb]} pillColor="#14221c26" testID="pay-return">
      <View style={{ gap: 10 }}>
        <Tile provider={pending.provider} />
        <Text style={s.sheetTitle} accessibilityRole="header">{returnQuestion(pending.payeeName, pending.minor, pending.currency, pending.provider)}</Text>
        <Text style={s.sheetBody}>{RETURN_HINT}</Text>
        <Pressable style={[s.btn, busy && { opacity: 0.6 }]} disabled={busy} onPress={onYes} accessibilityRole="button" accessibilityState={{ disabled: busy }} testID="pay-return-yes"><Text style={s.btnText}>{`Yes, record ${money}`}</Text></Pressable>
        <Pressable style={[s.btn, s.ghost]} onPress={onDifferent} accessibilityRole="button" testID="pay-return-different"><Text style={[s.btnText, { color: C.teal }]}>Pay a different amount</Text></Pressable>
        <Pressable style={s.plain} onPress={onNotYet} accessibilityRole="button" testID="pay-return-not-yet"><Text style={s.plainText}>Not yet</Text></Pressable>
      </View>
    </BottomSheet>
  )
}

const s = StyleSheet.create({
  grow: { flex: 1, minWidth: 0 },
  tile: { width: 46, height: 46, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  tileText: { color: 'white', fontWeight: '900', fontSize: 22 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 72, backgroundColor: C.card, borderWidth: 1, borderColor: C.line, borderRadius: 18, paddingHorizontal: 14, paddingVertical: 12, marginBottom: 10 },
  dashed: { backgroundColor: '#f1f3f0', borderStyle: 'dashed', borderColor: '#d3dad5' },
  name: { fontWeight: '800', fontSize: 17, color: C.ink },
  sub: { fontSize: 13, color: C.muted, fontWeight: '600', marginTop: 2 },
  out: { fontSize: 22, color: C.muted },
  nudge: { marginTop: 14, backgroundColor: C.soft, borderWidth: 1, borderColor: C.mint, borderRadius: 18, padding: 14, gap: 6 },
  nudgeTitle: { color: C.teal, fontWeight: '900', fontSize: 17 },
  nudgeBody: { color: C.muted, fontWeight: '600', fontSize: 14, lineHeight: 20, marginBottom: 6 },
  btn: { backgroundColor: C.teal, borderRadius: 16, paddingVertical: 16, paddingHorizontal: 16, alignItems: 'center', alignSelf: 'stretch' },
  btnText: { color: 'white', fontWeight: '800', fontSize: 17 },
  ghost: { backgroundColor: C.card, borderWidth: 1.5, borderColor: C.mint },
  plain: { paddingVertical: 12, alignItems: 'center' },
  plainText: { color: C.muted, fontWeight: '800', fontSize: 16 },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingTop: 8, paddingBottom: 8 },
  topTitle: { fontSize: 17, fontWeight: '900', color: C.ink },
  ib: { width: 40, height: 40, borderRadius: 20, backgroundColor: C.card, borderWidth: 1, borderColor: C.line, alignItems: 'center', justifyContent: 'center' },
  ibText: { fontSize: 24, color: C.ink, marginTop: -2 },
  lead: { color: C.muted, fontWeight: '600', fontSize: 15, lineHeight: 21, marginTop: 4 },
  eye: { fontSize: 12, fontWeight: '800', letterSpacing: 1.1, textTransform: 'uppercase', color: C.muted, marginTop: 18, marginBottom: 8, marginHorizontal: 4 },
  field: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.card, borderWidth: 1.5, borderColor: C.line, borderRadius: 14, paddingHorizontal: 14 },
  fieldBad: { borderColor: C.red },
  prefix: { color: C.hint, fontWeight: '800', fontSize: 16, marginRight: 4 },
  input: { flex: 1, minWidth: 0, paddingVertical: 14, color: C.ink, fontSize: 16, fontWeight: '700' },
  hint: { color: C.muted, fontWeight: '600', fontSize: 13, lineHeight: 18, marginTop: 6, marginHorizontal: 4 },
  sheet: { backgroundColor: C.card, borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 20, paddingBottom: 28, gap: 10, maxHeight: '92%' },
  sheetWeb: { width: '100%', maxWidth: 480, alignSelf: 'center' },
  sheetTitle: { fontSize: 22, fontWeight: '900', color: C.ink, marginTop: 6 },
  sheetBody: { color: C.muted, fontWeight: '600', fontSize: 14, lineHeight: 20, marginBottom: 8 },
})
