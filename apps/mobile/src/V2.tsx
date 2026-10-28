// Design v2 screens: Groups home, group view, Add-expense ink sheet, expense detail, settle up.
// Data logic stays in App.tsx (Ledger) and flows/*; these components only render and report taps.
import { formatMoney, parseMajor, type SplitMethod, type SplitSpec } from '@divvy/domain'
import { useMemo, useState, type ReactNode } from 'react'
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { evaluate, majorString, METHOD_LABELS, METHODS, newDraft, switchMethod, type Draft } from './flows/split'
import {
  breakdown, groupByDate, historyLines, methodPhrase, monthDay, netTone, NET_WORDS, overallUsd, paidPhrase, peopleCount,
  signedMoney, splitGroupName, TEMPLATES, templateName, updatedPhrase, yourPosition, type HistoryEntry,
} from './flows/view'
import { middleEllipsis } from './flows/composer'
import type { Expense, GroupDetail, Home, HomeGroup, Payment, Settlement } from './types'

export const T = {
  bg: '#f6f7f4', card: '#ffffff', line: '#e4e8e2', teal: '#0f766e', tealD: '#0b5c56', mint: '#cfe3db', soft: '#f3faf7',
  ink: '#14221c', body: '#3d4741', muted: '#6b7a72', hint: '#8aa099', red: '#b4323f', redS: '#fbf1f2', amber: '#a15c07', amberS: '#fdf4e3',
  aqua: '#2dd4bf', ok: '#8ee0c9', bad: '#ffb3ba',
}
const AVATARS = [['#d9efe9', '#0f766e'], ['#fde8d4', '#a15c07'], ['#e4e1fb', '#4b3fa8'], ['#fbe1e5', '#b4323f'], ['#e1eefb', '#245a9c']] as const
const web = Platform.OS === 'web'
const noOutline = (web ? { outlineStyle: 'none' } : {}) as object

export function Avatar({ name, index = 0, size = 34 }: { name: string; index?: number; size?: number }) {
  const [bg, fg] = AVATARS[index % AVATARS.length]!
  return (
    <View accessible={false} importantForAccessibility="no-hide-descendants" style={{ width: size, height: size, borderRadius: size * 0.34, backgroundColor: bg, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ color: fg, fontWeight: '900', fontSize: size * 0.4 }}>{(name.trim().charAt(0) || '?').toUpperCase()}</Text>
    </View>
  )
}

export const todayIso = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
export const localIso = (offsetDays = 0) => {
  const d = new Date()
  d.setDate(d.getDate() + offsetDays)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function IconButton({ label, glyph, onPress, testID }: { label: string; glyph: string; onPress: () => void; testID?: string }) {
  return (
    <Pressable style={k.ib} onPress={onPress} accessibilityRole="button" accessibilityLabel={label} testID={testID}>
      <Text style={k.ibText} accessible={false}>{glyph}</Text>
    </Pressable>
  )
}

export type Tab = 'groups' | 'account'
export function TabBar({ tab, onTab }: { tab: Tab; onTab: (tab: Tab) => void }) {
  const item = (id: Tab, glyph: string, label: string) => (
    <Pressable key={id} style={k.tabItem} onPress={() => onTab(id)} accessibilityRole="tab" accessibilityLabel={label} accessibilityState={{ selected: tab === id }} testID={`tab-${id}`}>
      <Text style={[k.tabGlyph, tab === id && k.tabOn]} accessible={false}>{glyph}</Text>
      <Text style={[k.tabLabel, tab === id && k.tabOn]}>{label}</Text>
    </Pressable>
  )
  return <View style={k.tabBar}>{item('groups', '◫', 'Groups')}{item('account', '☺', 'Account')}</View>
}

function Eyebrow({ children }: { children: ReactNode }) { return <Text style={k.eye}>{children}</Text> }

// ───────────────────────── Groups home ─────────────────────────

export function GroupsHome({ home, onOpen, onCreate, onPaste, onJoinLink }: {
  home: Home; onOpen: (id: string) => void; onCreate: (templateId?: string) => void; onPaste: () => void; onJoinLink?: ReactNode
}) {
  const groups = home.groups.filter((group) => !group.archived)
  const today = todayIso()
  const overall = overallUsd(home.groups)
  if (groups.length === 0) return <EmptyGroups onCreate={onCreate} onPaste={onPaste} />
  const tone = netTone(overall.net)
  return (
    <>
      <View style={k.top}>
        <Text style={k.h1} accessibilityRole="header">Groups</Text>
        <IconButton label="Create a group" glyph="+" onPress={() => onCreate()} testID="create-group-plus" />
      </View>
      <View style={k.hero} testID="overall">
        <Text style={k.heroK}>Overall, across {overall.groupCount} {overall.groupCount === 1 ? 'group' : 'groups'}</Text>
        <Text style={k.heroV} testID="overall-net">{overall.net === 0 ? '$0.00' : signedMoney(overall.net)}</Text>
        <Text style={k.heroS}>
          {tone === 'settled' && overall.owed === 0 ? 'All settled up' : `You're owed ${formatMoney(overall.owed, 'USD')} · you owe ${formatMoney(overall.owe, 'USD')}`}
        </Text>
        {overall.leftOut > 0 && <Text style={k.heroNote}>USD groups only. {overall.leftOut} in other currencies not counted.</Text>}
      </View>
      <Eyebrow>Your groups</Eyebrow>
      <View style={k.card}>
        {groups.map((group, i) => <GroupRow key={group.id} group={group} index={i} today={today} first={i === 0} onPress={() => onOpen(group.id)} />)}
      </View>
      <Pressable style={k.dashed} onPress={() => onCreate()} accessibilityRole="button" accessibilityLabel="Create a group" testID="create-group-card">
        <Text style={k.dashedText}>+  Create a group</Text>
        <Text style={k.dashedSub}>Start from a template: trip, home, couple, dinners</Text>
      </Pressable>
      {onJoinLink}
    </>
  )
}

function GroupRow({ group, index, today, first, onPress }: { group: HomeGroup; index: number; today: string; first: boolean; onPress: () => void }) {
  const { emoji, title } = splitGroupName(group.name)
  const tone = netTone(group.yourNetMinor)
  const count = group.members?.length
  const sub = [count ? peopleCount(count) : null, updatedPhrase(group.latest?.date, today)].filter(Boolean).join(' · ')
  const [bg] = AVATARS[index % AVATARS.length]!
  return (
    <Pressable style={[k.row, !first && k.rowLine]} onPress={onPress} accessibilityRole="button" accessibilityLabel={`${title}, ${tone === 'settled' ? 'settled up' : `${NET_WORDS[tone]} ${formatMoney(Math.abs(group.yourNetMinor), group.currency)}`}`} testID={`group-${group.id}`}>
      <View style={[k.groupIcon, { backgroundColor: bg }]}><Text style={k.groupEmoji} accessible={false}>{emoji}</Text></View>
      <View style={k.grow}>
        <Text style={k.t} numberOfLines={1}>{title}</Text>
        <Text style={k.m} numberOfLines={1}>{sub}</Text>
      </View>
      <View style={k.right}>
        <Text style={[k.amt, tone === 'owed' ? k.pos : tone === 'owe' ? k.neg : k.zero]}>
          {tone === 'settled' ? 'Settled up' : formatMoney(Math.abs(group.yourNetMinor), group.currency)}
        </Text>
        {tone !== 'settled' && <Text style={k.sm}>{NET_WORDS[tone]}</Text>}
      </View>
    </Pressable>
  )
}

export function EmptyGroups({ onCreate, onPaste }: { onCreate: (templateId?: string) => void; onPaste: () => void }) {
  return (
    <View style={k.empty} testID="no-groups">
      <View style={k.emptyArt}><Text style={k.emptyEmoji} accessible={false}>🧾</Text></View>
      <Text style={k.h1c} accessibilityRole="header">Split your first bill</Text>
      <Text style={k.emptyCopy}>Make a group for a trip, your home or a dinner, then add what each of you owes. Divvy keeps the running total.</Text>
      <Pressable style={k.btn} onPress={() => onCreate()} accessibilityRole="button" testID="empty-create"><Text style={k.btnText}>Create a group</Text></Pressable>
      <Pressable style={[k.btn, k.ghost]} onPress={onPaste} accessibilityRole="button" testID="empty-invite"><Text style={[k.btnText, { color: T.teal }]}>I have an invite link</Text></Pressable>
      <Text style={k.emptyHint}>OR START FROM</Text>
      <View style={k.chips}>
        {TEMPLATES.map((t) => (
          <Pressable key={t.id} style={k.chip} onPress={() => onCreate(t.id)} accessibilityRole="button" accessibilityLabel={`${t.label} template`} testID={`template-${t.id}`}>
            <Text style={k.chipText}>{t.emoji}  {t.label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  )
}

export function CreateGroupSheet({ initialTemplate, busy, error, onCreate, onClose }: {
  initialTemplate?: string; busy: boolean; error: string | null; onCreate: (name: string, currency: string) => void; onClose: () => void
}) {
  const start = TEMPLATES.find((t) => t.id === initialTemplate)
  const [name, setName] = useState(start ? templateName(start) : '')
  const [currency, setCurrency] = useState('USD')
  const valid = name.trim().length > 0 && name.trim().length <= 80 && /^[A-Za-z]{3}$/.test(currency)
  return (
    <Modal transparent animationType="slide" visible onRequestClose={onClose}>
      <Pressable style={k.scrim} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" />
      <View style={[k.lightSheet, web && k.sheetWeb]} testID="create-group-sheet">
        <View style={k.grabberDark} />
        <Text style={k.sheetTitle} accessibilityRole="header">Create a group</Text>
        <View style={k.chips}>
          {TEMPLATES.map((t) => (
            <Pressable key={t.id} style={[k.chip, name === templateName(t) && k.chipOn]} onPress={() => setName(templateName(t))} accessibilityRole="button" accessibilityState={{ selected: name === templateName(t) }} testID={`template-pick-${t.id}`}>
              <Text style={[k.chipText, name === templateName(t) && k.chipTextOn]}>{t.emoji}  {t.label}</Text>
            </Pressable>
          ))}
        </View>
        <Text style={k.label}>Name</Text>
        <TextInput testID="group-name" autoFocus value={name} onChangeText={setName} maxLength={80} placeholder="🏔️ Tahoe weekend" placeholderTextColor={T.hint} style={[k.input, noOutline]} returnKeyType="done" onSubmitEditing={() => valid && !busy && onCreate(name.trim(), currency.toUpperCase())} />
        <Text style={k.hintSmall}>Start with an emoji to give it an icon.</Text>
        <Text style={k.label}>Currency</Text>
        <TextInput testID="group-currency" value={currency} onChangeText={(text) => setCurrency(text.toUpperCase().slice(0, 3))} autoCapitalize="characters" autoCorrect={false} style={[k.input, noOutline, { width: 110 }]} />
        {error && <Text style={k.error} testID="create-group-error">{error}</Text>}
        <View style={k.sheetButtons}>
          <Pressable style={[k.btn, k.ghost, k.flex1]} onPress={onClose} accessibilityRole="button"><Text style={[k.btnText, { color: T.teal }]}>Cancel</Text></Pressable>
          <Pressable style={[k.btn, k.flex1, (!valid || busy) && k.btnOff]} disabled={!valid || busy} onPress={() => onCreate(name.trim(), currency.toUpperCase())} accessibilityRole="button" accessibilityState={{ disabled: !valid || busy, busy }} testID="create-group-save">
            <Text style={k.btnText}>{busy ? 'Creating…' : 'Create'}</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  )
}

export function SwitcherSheet({ groups, currentId, onPick, onAll, onClose }: {
  groups: HomeGroup[]; currentId: string | null; onPick: (id: string) => void; onAll: () => void; onClose: () => void
}) {
  return (
    <Modal transparent animationType="slide" visible onRequestClose={onClose}>
      <Pressable style={k.scrim} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" />
      <View style={[k.lightSheet, web && k.sheetWeb]} testID="switcher">
        <View style={k.grabberDark} />
        <Text style={k.sheetTitle} accessibilityRole="header">Switch group</Text>
        <ScrollView style={{ maxHeight: 360 }}>
          {groups.filter((g) => !g.archived).map((group, i) => {
            const { emoji, title } = splitGroupName(group.name)
            const tone = netTone(group.yourNetMinor)
            return (
              <Pressable key={group.id} style={[k.row, i > 0 && k.rowLine]} onPress={() => onPick(group.id)} accessibilityRole="button" accessibilityState={{ selected: group.id === currentId }} accessibilityLabel={`${title} group`} testID={`switch-${group.id}`}>
                <Text style={k.groupEmojiSm} accessible={false}>{emoji}</Text>
                <Text style={[k.t, k.grow]} numberOfLines={1}>{title}</Text>
                <Text style={[k.amt, tone === 'owed' ? k.pos : tone === 'owe' ? k.neg : k.zero]}>{tone === 'settled' ? 'Settled' : formatMoney(Math.abs(group.yourNetMinor), group.currency)}</Text>
                <Text style={k.check} accessible={false}>{group.id === currentId ? '✓' : ''}</Text>
              </Pressable>
            )
          })}
        </ScrollView>
        <Pressable style={[k.btn, k.ghost]} onPress={onAll} accessibilityRole="button" testID="switch-all"><Text style={[k.btnText, { color: T.teal }]}>All groups</Text></Pressable>
      </View>
    </Modal>
  )
}

export function AccountScreen({ name, email, onEditName, onSignOut }: { name: string; email?: string | null; onEditName: () => void; onSignOut: () => void }) {
  return (
    <>
      <View style={k.top}><Text style={k.h1} accessibilityRole="header">Account</Text></View>
      <View style={k.card}>
        <Pressable style={k.row} onPress={onEditName} accessibilityRole="button" accessibilityLabel={`Your name, ${name}. Edit`} testID="name-chip">
          <Avatar name={name} size={42} />
          <View style={k.grow}><Text style={k.t}>{name}</Text><Text style={k.m}>{email ?? 'Friends see this name in every group'}</Text></View>
          <Text style={k.edit} accessible={false}>✎</Text>
        </Pressable>
      </View>
      <Pressable style={[k.btn, k.ghost, { marginTop: 16 }]} onPress={onSignOut} accessibilityRole="button" testID="sign-out"><Text style={[k.btnText, { color: T.red }]}>Sign out</Text></Pressable>
    </>
  )
}

// ───────────────────────── Group view (read-only) ─────────────────────────

export function memberName(detail: GroupDetail, id: string, you = 'You') {
  if (id === detail.yourParticipantId) return you
  return detail.members.find((m) => m.id === id)?.name ?? 'Someone'
}

export function GroupView({ detail, today, banner, footer, onBack, onSwitcher, onShare, onOpenExpense, onSettle }: {
  detail: GroupDetail; today: string; banner?: ReactNode; footer?: ReactNode
  onBack: () => void; onSwitcher: () => void; onShare: () => void; onOpenExpense: (id: string) => void; onSettle: () => void; onAdd: () => void
}) {
  const { emoji, title } = splitGroupName(detail.group.name)
  const youNet = detail.nets.find((n) => n.participantId === detail.yourParticipantId)?.netMinor ?? 0
  const spend = detail.expenses.filter((e) => e.kind !== 'reimbursement').reduce((a, e) => a + e.settlementMinor, 0)
  const active = detail.members.filter((m) => !m.removed)
  const days = groupByDate(detail.expenses.map((e) => ({ ...e, payers: e.payers, shares: e.shares })), today)
  const payments = [...detail.payments].sort((a, b) => b.minor - a.minor)
  return (
    <>
      <View style={k.top}>
        <IconButton label="Back to Groups" glyph="‹" onPress={onBack} testID="back-to-groups" />
        <Pressable style={k.titleChip} onPress={onSwitcher} accessibilityRole="button" accessibilityLabel={`${title}. Switch group`} testID="group-title-chip">
          <Text style={k.groupEmojiSm} accessible={false}>{emoji}</Text>
          <Text style={k.titleChipText} numberOfLines={1}>{title}</Text>
          <Text style={k.caret} accessible={false}>▾</Text>
        </Pressable>
        <IconButton label="Share group link" glyph="⇪" onPress={onShare} testID="share-group-link" />
      </View>
      {banner}
      <View style={k.hero}>
        <Text style={k.heroK}>Your balance</Text>
        <Text style={k.heroV} testID="group-balance">{youNet === 0 ? 'Settled up' : signedMoney(youNet, detail.currency)}</Text>
        <Text style={k.heroS}>
          {youNet === 0 ? `Group spend ${formatMoney(spend, detail.currency)}` : `${youNet > 0 ? 'You are owed' : 'You owe'} · Group spend ${formatMoney(spend, detail.currency)}`}
        </Text>
      </View>
      <Eyebrow>Who pays whom</Eyebrow>
      <View style={k.card}>
        {payments.length === 0 && <Text style={k.m}>{detail.expenses.length === 0 ? 'Nothing to settle yet.' : 'Everyone is settled up.'}</Text>}
        {payments.map((p, i) => (
          <View key={`${p.fromId}-${p.toId}`} style={[k.row, i > 0 && k.rowLine, { paddingVertical: 8 }]}>
            <Avatar name={memberName(detail, p.fromId)} index={i} size={30} />
            <Text style={[k.grow, k.payText]} numberOfLines={1}>{memberName(detail, p.fromId)} <Text style={k.arrow}>→</Text> {memberName(detail, p.toId)}</Text>
            <Text style={k.amt}>{formatMoney(p.minor, detail.currency)}</Text>
          </View>
        ))}
        {payments.length > 0 && (
          <Pressable style={[k.btn, k.ghost, { marginTop: 10, paddingVertical: 12 }]} onPress={onSettle} accessibilityRole="button" testID="settle-up"><Text style={[k.btnText, { color: T.teal, fontSize: 15 }]}>Settle up</Text></Pressable>
        )}
        {payments.length === 0 && detail.settlements.length > 0 && (
          <Pressable style={[k.btn, k.ghost, { marginTop: 10, paddingVertical: 12 }]} onPress={onSettle} accessibilityRole="button" testID="settle-up"><Text style={[k.btnText, { color: T.teal, fontSize: 15 }]}>See recorded payments</Text></Pressable>
        )}
      </View>
      {detail.expenses.length === 0 && (
        <View style={[k.card, { marginTop: 14 }]}>
          <Text style={k.t}>No expenses yet</Text>
          <Text style={k.m}>{active.length < 2 ? 'Share the group link so a friend can join, then add the first expense.' : 'Tap Add expense to log the first one.'}</Text>
        </View>
      )}
      {days.map((day) => (
        <View key={day.date}>
          <Text style={k.date}>{day.heading}</Text>
          <View style={k.card}>
            {day.items.map((expense, i) => {
              const pos = yourPosition(expense, detail.yourParticipantId)
              return (
                <Pressable key={expense.id} style={[k.row, i > 0 && k.rowLine]} onPress={() => onOpenExpense(expense.id)} accessibilityRole="button" accessibilityLabel={`${expense.description || 'Expense'}, ${formatMoney(expense.settlementMinor, detail.currency)}`} testID={`expense-${expense.id}`}>
                  <View style={k.expIcon}><Text style={{ fontSize: 18 }} accessible={false}>🧾</Text></View>
                  <View style={k.grow}>
                    <Text style={k.t} numberOfLines={1}>{expense.description.trim() || 'Expense'}</Text>
                    <Text style={k.m} numberOfLines={1}>{paidPhrase(expense, detail.yourParticipantId, detail.currency)} · {methodPhrase(expense.splitMethod)}</Text>
                  </View>
                  <View style={k.right}>
                    {pos.kind === 'none' ? <Text style={[k.amt, k.zero]}>not involved</Text> : (
                      <>
                        <Text style={[k.amt, pos.kind === 'lent' ? k.pos : k.neg]}>{formatMoney(pos.minor, detail.currency)}</Text>
                        <Text style={k.sm}>you {pos.kind}</Text>
                      </>
                    )}
                  </View>
                </Pressable>
              )
            })}
          </View>
        </View>
      ))}
      {footer}
    </>
  )
}

export function Fab({ onPress }: { onPress: () => void }) {
  return <Pressable style={k.fab} onPress={onPress} accessibilityRole="button" accessibilityLabel="Add expense" testID="add-expense"><Text style={k.fabText}>+  Add expense</Text></Pressable>
}

export function InviteCard({ url, onShare }: { url: string | null; onShare: () => void }) {
  return (
    <View style={[k.card, { marginTop: 16 }]}>
      <Text style={k.t}>Group link</Text>
      <Text selectable numberOfLines={1} style={k.link} testID="group-link" accessibilityLabel={url ?? undefined}>{url ? middleEllipsis(url, 36) : 'Preparing a link…'}</Text>
      <Text style={k.m}>Anyone already signed in can open this.</Text>
      {url && <Pressable style={[k.btn, k.ghost, { marginTop: 10, paddingVertical: 12 }]} onPress={onShare} accessibilityRole="button" testID="share-group-link-card"><Text style={[k.btnText, { color: T.teal, fontSize: 15 }]}>Share</Text></Pressable>}
    </View>
  )
}

// ───────────────────────── Add / edit expense (ink sheet) ─────────────────────────

export type SheetInitial = { amountText: string; description: string; draft: Draft; payerId: string; date: string | null }
export type SheetSave = { description: string; minor: number; payerId: string; spec: SplitSpec; date: string | null }

export function AddSheet({ members, youId, currency, groupName, initial, onClose, onSave }: {
  members: { id: string; name: string }[]; youId: string; currency: string; groupName: string
  initial: SheetInitial | null; onClose: () => void; onSave: (value: SheetSave) => Promise<void>
}) {
  const ids = useMemo(() => members.map((m) => m.id), [members])
  const nameOf = (id: string) => (id === youId ? 'You' : members.find((m) => m.id === id)?.name ?? 'Someone')
  const [amountText, setAmount] = useState(initial?.amountText ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [draft, setDraft] = useState<Draft>(() => initial?.draft ?? newDraft(ids))
  const [payerId, setPayer] = useState(initial?.payerId ?? youId)
  const [when, setWhen] = useState<'today' | 'yesterday' | 'keep'>(initial?.date ? 'keep' : 'today')
  const [pickPayer, setPickPayer] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [focused, setFocused] = useState<string | null>(null)
  const [lastEdited, setLastEdited] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ev = useMemo(() => evaluate(draft, ids, amountText, currency, payerId, nameOf), [draft, ids, amountText, currency, payerId])
  const alone = ids.length < 2
  const canSave = ev.ok && !saving && !alone
  const dirty = useMemo(() => {
    if (initial) return JSON.stringify([amountText, description, draft, payerId, when]) !== JSON.stringify([initial.amountText, initial.description, initial.draft, initial.payerId, initial.date ? 'keep' : 'today'])
    return !!amountText.trim() || !!description.trim() || payerId !== youId || when !== 'today' || draft.method !== 'equal' || ids.some((id) => !draft.included[id] || draft.shares[id] !== 1 || draft.exact[id] || draft.percent[id] || draft.adjust[id])
  }, [initial, amountText, description, draft, payerId, when, ids, youId])
  const tryClose = () => (dirty && !saving ? setConfirmDiscard(true) : onClose())
  const patch = (key: 'exact' | 'percent' | 'adjust', id: string, text: string) => {
    setLastEdited(id)
    setError(null)
    setDraft((d) => ({ ...d, [key]: { ...d[key], [id]: text } }))
  }
  const save = async () => {
    if (!canSave || !ev.spec) return
    let minor: number
    try { minor = parseMajor(amountText, currency) } catch { return }
    setSaving(true)
    setError(null)
    try {
      await onSave({ description: description.trim(), minor, payerId, spec: ev.spec, date: when === 'keep' ? (initial?.date ?? null) : when === 'yesterday' ? localIso(-1) : null })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not save that')
      setSaving(false)
    }
  }
  const barBad = ev.bar.tone === 'bad'
  const overField = barBad ? lastEdited : null
  const title = initial ? 'Edit expense' : `New expense · ${groupName}`
  return (
    <Modal transparent animationType="slide" visible onRequestClose={tryClose}>
      <Pressable style={k.scrim} onPress={tryClose} accessibilityRole="button" accessibilityLabel="Close" />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={k.inkWrap} pointerEvents="box-none">
        <View style={[k.ink, web && k.sheetWeb]} testID="add-sheet">
          <View style={k.grabber} />
          <View style={k.sheetHead}>
            <Pressable onPress={tryClose} accessibilityRole="button" testID="sheet-cancel"><Text style={k.inkCancel}>Cancel</Text></Pressable>
            <Text style={k.inkTitle} numberOfLines={1} accessibilityRole="header">{title}</Text>
            <Pressable onPress={save} disabled={!canSave} accessibilityRole="button" accessibilityState={{ disabled: !canSave }} testID="sheet-save">
              <Text style={[k.inkSave, !canSave && k.inkSaveOff]}>{saving ? 'Saving…' : 'Save'}</Text>
            </Pressable>
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 12 }}>
            <View style={k.bigRow}>
              <Text style={k.bigC}>$</Text>
              <TextInput testID="expense-amount" autoFocus value={amountText} onChangeText={(text) => { setError(null); setAmount(text) }} placeholder="0.00" placeholderTextColor="#ffffff40" keyboardType="decimal-pad" inputMode="decimal" style={[k.big, noOutline]} accessibilityLabel="Amount" />
            </View>
            <TextInput testID="expense-description" value={description} onChangeText={setDescription} maxLength={80} placeholder="What was it for?" placeholderTextColor="#ffffff59" style={[k.desc, noOutline]} accessibilityLabel="Description" />
            <View style={k.pick}>
              <Pressable style={k.dp} onPress={() => setPickPayer((v) => !v)} accessibilityRole="button" testID="payer-chip"><Text style={k.dpText}>Paid by <Text style={k.dpB}>{nameOf(payerId)} ▾</Text></Text></Pressable>
              <Pressable style={k.dp} onPress={() => setWhen((w) => (w === 'today' ? 'yesterday' : w === 'yesterday' && initial?.date ? 'keep' : 'today'))} accessibilityRole="button" testID="date-chip">
                <Text style={k.dpText}><Text style={k.dpB}>{when === 'today' ? 'Today' : when === 'yesterday' ? 'Yesterday' : monthDay(initial?.date ?? '')} ▾</Text></Text>
              </Pressable>
            </View>
            {pickPayer && (
              <View style={k.payerList}>
                {members.map((m) => (
                  <Pressable key={m.id} style={[k.dp, m.id === payerId && k.dpOn]} onPress={() => { setPayer(m.id); setPickPayer(false) }} accessibilityRole="button" accessibilityState={{ selected: m.id === payerId }} testID={`payer-${m.id}`}>
                    <Text style={[k.dpText, m.id === payerId && { color: T.ink }]}>{nameOf(m.id)}</Text>
                  </Pressable>
                ))}
              </View>
            )}
            <View style={k.seg} accessibilityRole="tablist">
              {METHODS.map((method) => (
                <Pressable key={method} style={[k.segItem, draft.method === method && k.segOn]} onPress={() => { setLastEdited(null); setDraft((d) => switchMethod(d, method as SplitMethod, ids, amountText, currency, payerId)) }} accessibilityRole="tab" accessibilityState={{ selected: draft.method === method }} testID={`method-${method}`}>
                  <Text style={[k.segText, draft.method === method && k.segTextOn]}>{METHOD_LABELS[method]}</Text>
                </Pressable>
              ))}
            </View>
            <View style={k.ppl}>
              {members.map((m, i) => {
                const result = ev.results[m.id]
                const money = result === undefined ? '' : formatMoney(Math.abs(result), currency)
                const off = draft.method === 'equal' && !draft.included[m.id]
                const left = (
                  <>
                    <Avatar name={nameOf(m.id)} index={i} size={34} />
                    <View style={k.grow}>
                      <Text style={k.t} numberOfLines={1}>{nameOf(m.id)}</Text>
                      {draft.method === 'percent' && <View style={k.bar}><View style={[k.barFill, { width: `${Math.min(100, Math.max(0, (parsePct(draft.percent[m.id]) ?? 0) / 100))}%` }]} /></View>}
                      {draft.method !== 'exact' && draft.method !== 'equal' && money !== '' && <Text style={k.m}>{draft.method === 'adjust' ? `= ${money}` : money}</Text>}
                      {draft.method === 'equal' && <Text style={k.m}>{off ? 'Not included' : money}</Text>}
                    </View>
                  </>
                )
                const line = [k.pRow, i > 0 && k.rowLine]
                if (draft.method === 'equal') {
                  return (
                    <Pressable key={m.id} style={line} onPress={() => setDraft((d) => ({ ...d, included: { ...d.included, [m.id]: !d.included[m.id] } }))} accessibilityRole="checkbox" accessibilityState={{ checked: !off }} accessibilityLabel={nameOf(m.id)} testID={`person-${m.id}`}>
                      {left}
                      <View style={[k.tog, off && k.togOff]}><Text style={k.togTick} accessible={false}>{off ? '' : '✓'}</Text></View>
                    </Pressable>
                  )
                }
                if (draft.method === 'shares') {
                  const n = draft.shares[m.id] ?? 0
                  const step = (by: number) => setDraft((d) => ({ ...d, shares: { ...d.shares, [m.id]: Math.max(0, Math.min(99, (d.shares[m.id] ?? 0) + by)) } }))
                  return (
                    <View key={m.id} style={line}>
                      {left}
                      <View style={k.step}>
                        <Pressable style={k.stepBtn} onPress={() => step(-1)} accessibilityRole="button" accessibilityLabel={`Fewer shares for ${nameOf(m.id)}`} testID={`share-minus-${m.id}`}><Text style={k.stepText}>−</Text></Pressable>
                        <Text style={k.stepN} testID={`share-n-${m.id}`}>{n}</Text>
                        <Pressable style={k.stepBtn} onPress={() => step(1)} accessibilityRole="button" accessibilityLabel={`More shares for ${nameOf(m.id)}`} testID={`share-plus-${m.id}`}><Text style={k.stepText}>+</Text></Pressable>
                      </View>
                    </View>
                  )
                }
                const key = draft.method as 'exact' | 'percent' | 'adjust'
                const value = draft[key][m.id] ?? ''
                const bad = overField === m.id
                const field = (
                  <View style={[k.inpWrap, focused === m.id && k.inpF, bad && k.inpBad]}>
                    {key === 'exact' && <Text style={k.inpPre}>$</Text>}
                    <TextInput
                      testID={`${key}-${m.id}`}
                      value={key === 'adjust' ? value.replace(/^[+\-−]/, '') : value}
                      onChangeText={(text) => patch(key, m.id, key === 'adjust' ? (value.startsWith('-') || value.startsWith('−') ? '-' : '+') + text : text)}
                      onFocus={() => setFocused(m.id)}
                      onBlur={() => setFocused((f) => (f === m.id ? null : f))}
                      keyboardType="decimal-pad"
                      inputMode="decimal"
                      placeholder="0.00"
                      placeholderTextColor={T.hint}
                      selectTextOnFocus
                      accessibilityLabel={`${nameOf(m.id)} ${key === 'percent' ? 'percent' : key === 'adjust' ? 'adjustment' : 'amount'}`}
                      style={[k.inp, noOutline]}
                    />
                    {key === 'percent' && <Text style={k.inpPre}>%</Text>}
                  </View>
                )
                return (
                  <View key={m.id} style={line}>
                    {left}
                    {key === 'adjust' && (
                      <Pressable style={k.signBtn} onPress={() => patch('adjust', m.id, (value.startsWith('-') ? '+' : '-') + value.replace(/^[+\-−]/, ''))} accessibilityRole="button" accessibilityLabel={`${nameOf(m.id)} adjustment sign`} testID={`adjust-sign-${m.id}`}>
                        <Text style={k.signText}>{value.startsWith('-') ? '−' : '+'}</Text>
                      </Pressable>
                    )}
                    {field}
                  </View>
                )
              })}
            </View>
            {draft.method === 'adjust' && <Text style={k.inkHint}>Adjustments come off the top; the rest is split equally.</Text>}
            <View style={[k.val, ev.bar.tone === 'ok' ? k.valOk : barBad ? k.valBad : k.valIdle]} accessibilityLiveRegion="polite" testID="validation-bar">
              <Text style={[k.valText, ev.bar.tone === 'ok' ? { color: T.ok } : barBad ? { color: T.bad } : { color: '#b9c9c1' }]}>{alone ? 'Invite someone to split with' : ev.bar.left}</Text>
              <Text style={[k.valText, ev.bar.tone === 'ok' ? { color: T.ok } : barBad ? { color: T.bad } : { color: '#b9c9c1' }]}>{alone ? '' : ev.bar.right}</Text>
            </View>
            {error && <Text style={k.inkError} testID="sheet-error">{error}</Text>}
          </ScrollView>
          <View style={k.foot}>
            <Pressable style={[k.inkBtn, !canSave && k.inkBtnOff]} disabled={!canSave} onPress={save} accessibilityRole="button" accessibilityState={{ disabled: !canSave, busy: saving }} testID="sheet-cta">
              <Text style={[k.inkBtnText, !canSave && k.inkBtnTextOff]}>{saving ? 'Saving…' : alone ? 'Needs two people' : initial && ev.cta === 'Add expense' ? 'Save changes' : ev.cta}</Text>
            </Pressable>
          </View>
          {confirmDiscard && (
            <View style={k.discardWrap} testID="discard-confirm">
              <View style={k.discard}>
                <Text style={k.discardTitle} accessibilityRole="header">Discard expense?</Text>
                <Text style={k.discardCopy}>{initial ? 'Your changes to this expense will be lost.' : 'What you typed will be lost.'}</Text>
                <Pressable style={[k.inkBtn, { marginTop: 14 }]} onPress={() => setConfirmDiscard(false)} accessibilityRole="button" testID="discard-keep"><Text style={k.inkBtnText}>Keep editing</Text></Pressable>
                <Pressable style={[k.inkBtn, k.discardBtn]} onPress={onClose} accessibilityRole="button" testID="discard-yes"><Text style={[k.inkBtnText, { color: T.bad }]}>Discard</Text></Pressable>
              </View>
            </View>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  )
}

function parsePct(text: string | undefined) {
  const n = Number((text ?? '').replace('%', '').trim())
  return Number.isFinite(n) ? n * 100 : null
}

// ───────────────────────── Expense detail ─────────────────────────

export function ExpenseDetail({ detail, expense, history, canEdit, whyNoEdit, busy, onBack, onEdit, onDelete, timeText }: {
  detail: GroupDetail; expense: Expense; history: HistoryEntry[] | null; canEdit: boolean; whyNoEdit: string | null; busy: boolean
  onBack: () => void; onEdit: () => void; onDelete: () => void; timeText: (iso: string) => string
}) {
  const [confirm, setConfirm] = useState(false)
  const you = detail.yourParticipantId
  const nameOf = (id: string) => memberName(detail, id)
  const method = expense.splitMethod ?? 'exact'
  const rows = breakdown(expense, nameOf, method, expense.splitInputs)
  const pos = yourPosition(expense, you)
  const lines = history ? historyLines(history, you, detail.currency, nameOf, timeText) : null
  const payerText = (() => {
    const paying = expense.payers.filter((p) => p.minor > 0)
    return paying.map((p) => (p.participantId === you ? 'You' : p.name)).join(', ') || 'Someone'
  })()
  const { emoji, title } = splitGroupName(detail.group.name)
  return (
    <>
      <View style={k.top}>
        <IconButton label="Back to group" glyph="‹" onPress={onBack} testID="back-to-group" />
        <Text style={k.topTitle} accessibilityRole="header">Expense</Text>
        {canEdit ? <IconButton label="Edit expense" glyph="✎" onPress={onEdit} testID="edit-expense" /> : <View style={{ width: 40 }} />}
      </View>
      <View style={[k.card, { alignItems: 'center', gap: 4 }]} testID="expense-header">
        <View style={[k.expIcon, { width: 52, height: 52, borderRadius: 16 }]}><Text style={{ fontSize: 24 }} accessible={false}>🧾</Text></View>
        <Text style={k.detailTitle}>{expense.description.trim() || 'Expense'}</Text>
        <Text style={k.detailAmt} testID="expense-total">{formatMoney(expense.settlementMinor, detail.currency)}</Text>
        <Text style={k.m}>Paid by {payerText} · {monthDay(expense.date)} · {emoji} {title}</Text>
        <View style={k.methodChip}><Text style={k.methodChipText} testID="method-chip">Split {methodPhrase(method).replace(/^split /, '')}</Text></View>
      </View>
      {!canEdit && whyNoEdit && <Text style={[k.m, { marginTop: 8, textAlign: 'center' }]}>{whyNoEdit}</Text>}
      <Eyebrow>Split breakdown</Eyebrow>
      <View style={k.card} testID="breakdown">
        {rows.map((row, i) => (
          <View key={row.id} style={[k.row, i > 0 && k.rowLine]}>
            <Avatar name={row.name} index={i} size={34} />
            <View style={k.grow}>
              <Text style={k.t}>{row.name}</Text>
              <Text style={k.m}>{[row.paid > 0 ? `Paid ${formatMoney(row.paid, detail.currency)}` : null, row.note || null].filter(Boolean).join(' · ') || 'No payment'}</Text>
            </View>
            <View style={k.right}>
              <Text style={k.amt}>{formatMoney(row.share, detail.currency)}</Text>
              <Text style={k.sm}>owes</Text>
            </View>
          </View>
        ))}
        {pos.kind !== 'none' && (
          <View style={k.lent} testID="your-position">
            <Text style={[k.lentText, pos.kind === 'lent' ? k.pos : k.neg]}>You {pos.kind} {formatMoney(pos.minor, detail.currency)}</Text>
          </View>
        )}
      </View>
      <Eyebrow>History</Eyebrow>
      <View style={k.card} testID="history">
        {!lines && <Text style={k.m}>Loading…</Text>}
        {lines && lines.length === 0 && <Text style={k.m}>No history yet.</Text>}
        {lines && lines.map((line, i) => (
          <View key={line.id} style={[k.histRow, i > 0 && k.rowLine]}>
            <Text style={[k.histText, k.grow]}>{line.text}</Text>
            <Text style={k.histTime}>{line.time}</Text>
          </View>
        ))}
      </View>
      {!confirm ? (
        <Pressable style={k.del} onPress={() => setConfirm(true)} accessibilityRole="button" testID="delete-expense"><Text style={k.delText}>Delete expense</Text></Pressable>
      ) : (
        <View style={k.delBox} testID="delete-confirm">
          <Text style={k.t}>Delete this expense?</Text>
          <Text style={k.m}>Balances update right away. You can undo for a few seconds after.</Text>
          <View style={k.sheetButtons}>
            <Pressable style={[k.btn, k.ghost, k.flex1]} onPress={() => setConfirm(false)} accessibilityRole="button"><Text style={[k.btnText, { color: T.teal }]}>Keep it</Text></Pressable>
            <Pressable style={[k.btn, k.btnRed, k.flex1, busy && k.btnOff]} disabled={busy} onPress={onDelete} accessibilityRole="button" testID="delete-yes"><Text style={k.btnText}>{busy ? 'Deleting…' : 'Delete'}</Text></Pressable>
          </View>
        </View>
      )}
    </>
  )
}

// ───────────────────────── Settle up ─────────────────────────

export function SettleScreen({ detail, busyKey, onBack, onRecord, onUndo }: {
  detail: GroupDetail; busyKey: string | null; onBack: () => void; onRecord: (payment: Payment) => void; onUndo: (settlementId: string) => void
}) {
  const payments = [...detail.payments].sort((a, b) => b.minor - a.minor)
  const [selKey, setSel] = useState<string | null>(null)
  const [amountText, setAmountText] = useState<string | null>(null)
  const keyOf = (p: Payment) => `${p.fromId}:${p.toId}`
  const current = payments.find((p) => keyOf(p) === selKey) ?? payments[0] ?? null
  const others = payments.filter((p) => p !== current)
  const name = (id: string) => memberName(detail, id)
  let minor = current?.minor ?? 0
  let amountError: string | null = null
  if (current && amountText !== null) {
    try {
      minor = parseMajor(amountText, detail.currency)
      if (minor > current.minor) amountError = `That is more than the ${formatMoney(current.minor, detail.currency)} owed`
    } catch (reason) { amountError = reason instanceof Error ? reason.message : 'Enter an amount' }
  }
  const busy = busyKey !== null
  const label = (s: Settlement) => `${s.fromId === detail.yourParticipantId ? 'You' : s.fromName} paid ${s.toId === detail.yourParticipantId ? 'You' : s.toName}`
  return (
    <>
      <View style={k.top}>
        <IconButton label="Back to group" glyph="‹" onPress={onBack} testID="back-to-group" />
        <Text style={k.topTitle} accessibilityRole="header">Settle up</Text>
        <View style={{ width: 40 }} />
      </View>
      {current ? (
        <View style={[k.card, { alignItems: 'center', gap: 6 }]} testID="settle-card">
          <View style={k.pair}>
            <Avatar name={name(current.fromId)} index={0} size={46} />
            <Text style={k.pairArrow} accessible={false}>→</Text>
            <Avatar name={name(current.toId)} index={1} size={46} />
          </View>
          <Text style={k.t}>{name(current.fromId)} {current.fromId === detail.yourParticipantId ? 'pay' : 'paid'} {name(current.toId)}</Text>
          <View style={k.settleAmtRow}>
            <Text style={k.settleC}>$</Text>
            <TextInput testID="settle-amount" value={amountText ?? majorStringLocal(current.minor, detail.currency)} onChangeText={setAmountText} keyboardType="decimal-pad" inputMode="decimal" selectTextOnFocus style={[k.settleAmt, noOutline]} accessibilityLabel="Amount to record" />
          </View>
          <Text style={k.m}>{amountText === null ? 'Full balance · tap to change' : amountError ?? 'Part payment'}</Text>
        </View>
      ) : (
        <View style={k.card}><Text style={k.t}>Everyone is settled up.</Text></View>
      )}
      <View style={k.notice} testID="no-money-notice"><Text style={k.noticeText}>Divvy doesn’t move money. Pay each other however you like, then record it here so balances update.</Text></View>
      {others.length > 0 && (
        <>
          <Eyebrow>Or record another</Eyebrow>
          <View style={k.card}>
            {others.map((p, i) => (
              <Pressable key={keyOf(p)} style={[k.row, i > 0 && k.rowLine]} onPress={() => { setSel(keyOf(p)); setAmountText(null) }} accessibilityRole="button" accessibilityLabel={`Record: ${name(p.fromId)} pays ${name(p.toId)}`} testID={`pick-${p.fromId}-${p.toId}`}>
                <Avatar name={name(p.fromId)} index={i + 1} size={30} />
                <Text style={[k.grow, k.payText]} numberOfLines={1}>{name(p.fromId)} <Text style={k.arrow}>→</Text> {name(p.toId)}</Text>
                <Text style={k.amt}>{formatMoney(p.minor, detail.currency)}</Text>
              </Pressable>
            ))}
          </View>
        </>
      )}
      {current && (
        <Pressable style={[k.btn, { marginTop: 18 }, (busy || !!amountError || minor <= 0) && k.btnOff]} disabled={busy || !!amountError || minor <= 0}
          onPress={() => { onRecord({ ...current, minor }); setAmountText(null); setSel(null) }} accessibilityRole="button" accessibilityState={{ busy, disabled: busy || !!amountError || minor <= 0 }} testID={`record-${current.fromId}-${current.toId}`}>
          <Text style={k.btnText}>{busyKey === keyOf(current) ? 'Recording…' : `Record ${formatMoney(minor, detail.currency)}`}</Text>
        </Pressable>
      )}
      {detail.settlements.length > 0 && (
        <>
          <Eyebrow>Recorded payments</Eyebrow>
          <View style={k.card}>
            {detail.settlements.map((s, i) => (
              <View key={s.id} style={[k.row, i > 0 && k.rowLine]}>
                <Text style={[k.grow, k.payText]}>{label(s)}</Text>
                <Text style={k.amt}>{formatMoney(s.minor, detail.currency)}</Text>
                <Pressable style={k.undo} onPress={() => onUndo(s.id)} disabled={busy} accessibilityRole="button" accessibilityLabel={`Undo: ${label(s)}`} accessibilityState={{ busy: busyKey === s.id, disabled: busy }} testID={`undo-${s.id}`}>
                  <Text style={k.undoText}>{busyKey === s.id ? 'Undoing' : 'Undo'}</Text>
                </Pressable>
              </View>
            ))}
          </View>
        </>
      )}
    </>
  )
}

const majorStringLocal = (minor: number, currency: string) => majorString(minor, currency)

export function Snack({ text, action, onAction }: { text: string | null; action?: string; onAction?: () => void }) {
  if (!text) return null
  return (
    <View style={[k.snack, web && k.snackWeb]} testID="snack" accessibilityLiveRegion="polite">
      <Text style={k.snackText}>{text}</Text>
      {action && onAction && <Pressable onPress={onAction} accessibilityRole="button" accessibilityLabel={action} testID="snack-action"><Text style={k.snackAction}>{action}</Text></Pressable>}
    </View>
  )
}

export function PasteCard({ show, value, onChange, onOpen, onToggle }: { show: boolean; value: string; onChange: (v: string) => void; onOpen: () => void; onToggle: (v: boolean) => void }) {
  return (
    <View style={[k.card, { marginTop: 14 }]} testID="paste-card">
      {show ? (
        <>
          <TextInput testID="invite-paste" autoCapitalize="none" autoCorrect={false} value={value} onChangeText={onChange} placeholder="Paste a group link" placeholderTextColor={T.hint} style={[k.input, noOutline]} />
          <View style={k.sheetButtons}>
            <Pressable testID="invite-open" style={[k.btn, k.flex1]} accessibilityRole="button" onPress={onOpen}><Text style={k.btnText}>Open</Text></Pressable>
            <Pressable style={[k.btn, k.ghost, k.flex1]} onPress={() => onToggle(false)} accessibilityRole="button"><Text style={[k.btnText, { color: T.teal }]}>Close</Text></Pressable>
          </View>
        </>
      ) : (
        <Pressable onPress={() => onToggle(true)} accessibilityRole="button" testID="open-link"><Text style={k.openLink}>Open a group link</Text></Pressable>
      )}
    </View>
  )
}

const k = StyleSheet.create({
  flex1: { flex: 1 },
  grow: { flex: 1, minWidth: 0 },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingTop: 8, paddingBottom: 8 },
  topTitle: { fontSize: 17, fontWeight: '900', color: T.ink },
  h1: { fontSize: 30, fontWeight: '900', letterSpacing: -1, color: T.ink },
  h1c: { fontSize: 28, fontWeight: '900', letterSpacing: -0.8, color: T.ink, textAlign: 'center' },
  ib: { width: 40, height: 40, borderRadius: 20, backgroundColor: T.card, borderWidth: 1, borderColor: T.line, alignItems: 'center', justifyContent: 'center' },
  ibText: { fontSize: 20, fontWeight: '800', color: T.ink },
  card: { backgroundColor: T.card, borderWidth: 1, borderColor: T.line, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 12 },
  hero: { backgroundColor: T.teal, borderRadius: 24, paddingVertical: 18, paddingHorizontal: 20 },
  heroK: { color: '#ffffffbf', fontSize: 12, fontWeight: '800', letterSpacing: 1.1, textTransform: 'uppercase' },
  heroV: { color: 'white', fontSize: 38, fontWeight: '900', letterSpacing: -1.4, marginVertical: 4 },
  heroS: { color: '#ffffffd9', fontSize: 14, fontWeight: '600' },
  heroNote: { color: '#ffffffb3', fontSize: 12, fontWeight: '600', marginTop: 6 },
  eye: { fontSize: 12, fontWeight: '800', letterSpacing: 1.1, textTransform: 'uppercase', color: T.muted, marginTop: 20, marginBottom: 8, marginHorizontal: 4 },
  date: { fontSize: 12, fontWeight: '800', color: T.muted, letterSpacing: 0.7, textTransform: 'uppercase', marginTop: 16, marginBottom: 6, marginHorizontal: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
  rowLine: { borderTopWidth: 1, borderTopColor: '#eef2ee' },
  groupIcon: { width: 42, height: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  groupEmoji: { fontSize: 22 },
  groupEmojiSm: { fontSize: 18 },
  t: { fontWeight: '800', fontSize: 16, color: T.ink },
  m: { fontSize: 13, color: T.muted, fontWeight: '600', marginTop: 2 },
  right: { alignItems: 'flex-end' },
  amt: { fontSize: 16, fontWeight: '800', color: T.ink, textAlign: 'right' },
  sm: { fontSize: 12, fontWeight: '700', color: T.muted },
  pos: { color: T.teal },
  neg: { color: T.red },
  zero: { color: T.hint },
  dashed: { marginTop: 14, borderWidth: 1.5, borderStyle: 'dashed', borderColor: T.mint, borderRadius: 20, paddingVertical: 16, alignItems: 'center', gap: 2 },
  dashedText: { color: T.teal, fontWeight: '900', fontSize: 16 },
  dashedSub: { color: T.muted, fontSize: 12, fontWeight: '600' },
  empty: { alignItems: 'center', gap: 12, paddingTop: 40, paddingHorizontal: 6 },
  emptyArt: { width: 96, height: 96, borderRadius: 30, backgroundColor: T.soft, borderWidth: 1, borderColor: T.mint, alignItems: 'center', justifyContent: 'center', marginBottom: 6 },
  emptyEmoji: { fontSize: 44 },
  emptyCopy: { color: T.body, fontSize: 15, textAlign: 'center', lineHeight: 21, marginBottom: 6 },
  emptyHint: { fontSize: 12, fontWeight: '800', letterSpacing: 1.1, color: T.muted, marginTop: 14 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'center' },
  chip: { backgroundColor: T.card, borderWidth: 1, borderColor: T.line, borderRadius: 999, paddingVertical: 8, paddingHorizontal: 14 },
  chipOn: { backgroundColor: T.ink, borderColor: T.ink },
  chipText: { fontWeight: '800', fontSize: 14, color: T.ink },
  chipTextOn: { color: 'white' },
  btn: { backgroundColor: T.teal, borderRadius: 16, paddingVertical: 16, paddingHorizontal: 16, alignItems: 'center', alignSelf: 'stretch' },
  btnText: { color: 'white', fontWeight: '800', fontSize: 17 },
  btnOff: { backgroundColor: '#c9d3ce' },
  btnRed: { backgroundColor: T.red },
  ghost: { backgroundColor: T.card, borderWidth: 1.5, borderColor: T.mint },
  scrim: { flex: 1, backgroundColor: 'rgba(20,34,28,0.45)' },
  lightSheet: { backgroundColor: T.bg, borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 18, paddingBottom: 28, gap: 10 },
  sheetWeb: { width: '100%', maxWidth: 480, alignSelf: 'center' },
  grabberDark: { width: 40, height: 5, borderRadius: 3, backgroundColor: '#14221c26', alignSelf: 'center', marginBottom: 4 },
  grabber: { width: 40, height: 5, borderRadius: 3, backgroundColor: '#ffffff40', alignSelf: 'center', marginTop: 8, marginBottom: 4 },
  sheetTitle: { fontSize: 20, fontWeight: '900', color: T.ink },
  sheetButtons: { flexDirection: 'row', gap: 10, marginTop: 8 },
  label: { fontSize: 12, fontWeight: '800', letterSpacing: 1, textTransform: 'uppercase', color: T.muted, marginTop: 6 },
  input: { backgroundColor: T.card, borderWidth: 1.5, borderColor: T.line, borderRadius: 12, padding: 14, color: T.ink, fontSize: 16 },
  hintSmall: { fontSize: 12, color: T.muted },
  error: { color: T.red, fontWeight: '600' },
  check: { width: 20, color: T.teal, fontWeight: '900', fontSize: 16 },
  edit: { fontSize: 18, color: T.muted },
  titleChip: { flexShrink: 1, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: T.card, borderWidth: 1, borderColor: T.line, borderRadius: 999, paddingVertical: 8, paddingHorizontal: 14 },
  titleChipText: { fontWeight: '900', fontSize: 15, color: T.ink, flexShrink: 1 },
  caret: { color: T.muted, fontSize: 12 },
  payText: { fontWeight: '800', fontSize: 15, color: T.ink },
  arrow: { color: T.hint },
  expIcon: { width: 42, height: 42, borderRadius: 14, backgroundColor: T.soft, borderWidth: 1, borderColor: T.mint, alignItems: 'center', justifyContent: 'center' },
  link: { color: T.ink, fontSize: 14, marginTop: 6 },
  fab: { position: 'absolute', right: 18, bottom: 18, backgroundColor: T.teal, borderRadius: 22, paddingVertical: 17, paddingHorizontal: 22, shadowColor: T.teal, shadowOpacity: 0.35, shadowRadius: 12, shadowOffset: { width: 0, height: 8 }, elevation: 6 },
  fabText: { color: 'white', fontWeight: '900', fontSize: 17 },
  tabBar: { flexDirection: 'row', justifyContent: 'space-around', backgroundColor: T.card, borderTopWidth: 1, borderTopColor: T.line, paddingTop: 8, paddingBottom: 14 },
  tabItem: { alignItems: 'center', paddingHorizontal: 24, paddingVertical: 2 },
  tabGlyph: { fontSize: 20, color: T.hint },
  tabLabel: { fontSize: 11, fontWeight: '800', color: T.hint, marginTop: 2 },
  tabOn: { color: T.teal },
  // ink sheet
  inkWrap: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, justifyContent: 'flex-end', pointerEvents: 'box-none' } as object,
  ink: { height: '92%', backgroundColor: T.ink, borderTopLeftRadius: 28, borderTopRightRadius: 28, overflow: 'hidden' },
  sheetHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18, paddingVertical: 8, gap: 10 },
  inkCancel: { color: '#b9c9c1', fontWeight: '700', fontSize: 16 },
  inkTitle: { color: 'white', fontWeight: '900', fontSize: 16, flexShrink: 1 },
  inkSave: { color: T.aqua, fontWeight: '900', fontSize: 16 },
  inkSaveOff: { color: '#ffffff40' },
  bigRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginTop: 8 },
  bigC: { color: '#7fa597', fontSize: 34, fontWeight: '900', marginRight: 4 },
  big: { color: 'white', fontSize: 54, fontWeight: '900', letterSpacing: -2, minWidth: 120, textAlign: 'center', padding: 0 },
  desc: { marginHorizontal: 18, marginTop: 6, textAlign: 'center', fontSize: 17, fontWeight: '700', color: '#e6efe9', borderBottomWidth: 1, borderBottomColor: '#ffffff26', paddingTop: 8, paddingBottom: 12 },
  pick: { flexDirection: 'row', gap: 8, paddingHorizontal: 18, paddingTop: 12, paddingBottom: 4, justifyContent: 'center', flexWrap: 'wrap' },
  payerList: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 18, paddingTop: 4, justifyContent: 'center' },
  dp: { backgroundColor: '#ffffff14', borderWidth: 1, borderColor: '#ffffff22', borderRadius: 999, paddingVertical: 8, paddingHorizontal: 12 },
  dpOn: { backgroundColor: T.ok, borderColor: T.ok },
  dpText: { color: '#e6efe9', fontSize: 13, fontWeight: '800' },
  dpB: { color: T.ok },
  seg: { flexDirection: 'row', marginHorizontal: 14, marginTop: 12, backgroundColor: '#ffffff12', borderRadius: 14, padding: 4 },
  segItem: { flex: 1, alignItems: 'center', paddingVertical: 9, borderRadius: 11 },
  segOn: { backgroundColor: 'white' },
  segText: { color: '#b9c9c1', fontSize: 12.5, fontWeight: '800' },
  segTextOn: { color: T.ink },
  ppl: { backgroundColor: 'white', marginHorizontal: 14, marginTop: 12, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 4 },
  pRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10 },
  tog: { width: 28, height: 28, borderRadius: 9, backgroundColor: T.teal, alignItems: 'center', justifyContent: 'center' },
  togOff: { backgroundColor: 'white', borderWidth: 2, borderColor: '#cbd5cf' },
  togTick: { color: 'white', fontWeight: '900', fontSize: 15 },
  step: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  stepBtn: { width: 32, height: 32, borderRadius: 10, borderWidth: 1.5, borderColor: T.line, alignItems: 'center', justifyContent: 'center' },
  stepText: { fontWeight: '900', fontSize: 18, color: T.teal },
  stepN: { minWidth: 22, textAlign: 'center', fontWeight: '900', fontSize: 16, color: T.ink },
  inpWrap: { flexDirection: 'row', alignItems: 'center', width: 104, borderWidth: 1.5, borderColor: T.line, borderRadius: 12, backgroundColor: T.bg, paddingHorizontal: 8 },
  inpF: { borderColor: T.teal, backgroundColor: 'white' },
  inpBad: { borderColor: T.red, backgroundColor: T.redS },
  inpPre: { color: T.muted, fontWeight: '800' },
  inp: { flex: 1, minWidth: 0, paddingVertical: 9, paddingHorizontal: 2, textAlign: 'right', fontWeight: '800', fontSize: 16, color: T.ink },
  signBtn: { width: 30, height: 36, borderRadius: 10, backgroundColor: T.soft, borderWidth: 1, borderColor: T.mint, alignItems: 'center', justifyContent: 'center' },
  signText: { fontWeight: '900', fontSize: 18, color: T.teal },
  bar: { height: 8, borderRadius: 4, backgroundColor: '#eef2ee', overflow: 'hidden', marginTop: 6 },
  barFill: { height: '100%', backgroundColor: T.teal },
  inkHint: { color: '#b9c9c1', fontSize: 12, marginHorizontal: 18, marginTop: 8 },
  val: { marginHorizontal: 14, marginTop: 10, borderRadius: 14, paddingVertical: 11, paddingHorizontal: 14, flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  valOk: { backgroundColor: '#8ee0c922' },
  valBad: { backgroundColor: '#ff8a9433' },
  valIdle: { backgroundColor: '#ffffff12' },
  valText: { fontWeight: '800', fontSize: 14, flexShrink: 1 },
  inkError: { color: T.bad, marginHorizontal: 18, marginTop: 8, fontWeight: '600' },
  foot: { paddingHorizontal: 14, paddingTop: 12, paddingBottom: 26 },
  inkBtn: { backgroundColor: T.aqua, borderRadius: 16, paddingVertical: 16, alignItems: 'center' },
  inkBtnOff: { backgroundColor: '#ffffff1f' },
  inkBtnText: { color: T.ink, fontWeight: '850' as '800', fontSize: 17 },
  inkBtnTextOff: { color: '#ffffff80' },
  discardWrap: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', padding: 24 },
  discard: { backgroundColor: '#1d3128', borderRadius: 20, padding: 20, gap: 4 },
  discardTitle: { color: 'white', fontWeight: '900', fontSize: 20 },
  discardCopy: { color: '#b9c9c1', fontSize: 14 },
  discardBtn: { backgroundColor: '#ffffff14', marginTop: 8 },
  // detail
  detailTitle: { fontSize: 22, fontWeight: '900', color: T.ink, textAlign: 'center' },
  detailAmt: { fontSize: 40, fontWeight: '900', letterSpacing: -1.5, color: T.ink },
  methodChip: { backgroundColor: T.soft, borderWidth: 1, borderColor: T.mint, borderRadius: 999, paddingVertical: 5, paddingHorizontal: 12, marginTop: 6 },
  methodChipText: { color: T.teal, fontWeight: '800', fontSize: 13 },
  lent: { borderTopWidth: 1, borderTopColor: '#eef2ee', paddingTop: 10, paddingBottom: 2 },
  lentText: { fontWeight: '900', fontSize: 15, textAlign: 'right' },
  histRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 },
  histText: { color: T.ink, fontWeight: '700', fontSize: 14 },
  histTime: { color: T.muted, fontSize: 12, fontWeight: '700' },
  del: { alignItems: 'center', paddingVertical: 16, marginTop: 16, borderRadius: 16, backgroundColor: T.redS, borderWidth: 1, borderColor: '#f1c9cf' },
  delText: { color: T.red, fontWeight: '900', fontSize: 16 },
  delBox: { marginTop: 16, backgroundColor: T.redS, borderRadius: 16, borderWidth: 1, borderColor: '#f1c9cf', padding: 14, gap: 4 },
  // settle
  pair: { flexDirection: 'row', alignItems: 'center', gap: 14, marginTop: 4 },
  pairArrow: { fontSize: 22, color: T.hint, fontWeight: '800' },
  settleAmtRow: { flexDirection: 'row', alignItems: 'center' },
  settleC: { fontSize: 28, fontWeight: '900', color: T.hint, marginRight: 4 },
  settleAmt: { fontSize: 44, fontWeight: '900', letterSpacing: -1.5, color: T.ink, minWidth: 120, textAlign: 'center', padding: 0 },
  notice: { marginTop: 14, backgroundColor: T.amberS, borderWidth: 1, borderColor: '#f0dcb4', borderRadius: 14, padding: 12 },
  noticeText: { color: T.amber, fontWeight: '700', fontSize: 13, lineHeight: 18 },
  undo: { borderRadius: 999, paddingVertical: 6, paddingHorizontal: 12, borderWidth: 1, borderColor: T.mint, backgroundColor: T.soft },
  undoText: { color: T.teal, fontWeight: '800' },
  snack: { position: 'absolute', left: 16, right: 16, bottom: 92, backgroundColor: T.ink, borderRadius: 14, paddingVertical: 14, paddingHorizontal: 16, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12, shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 10, elevation: 8 },
  snackWeb: { alignSelf: 'center', width: 'auto', maxWidth: 448 },
  snackText: { color: 'white', fontWeight: '700', flexShrink: 1 },
  snackAction: { color: T.aqua, fontWeight: '900' },
  openLink: { color: T.teal, fontWeight: '800', textAlign: 'center' },
  pairDummy: {},
})
