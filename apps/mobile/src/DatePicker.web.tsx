// Web date chip, styled like the mockup (calendar icon + "Today" / "Yesterday" / "Tue, Oct 27", teal ring while open) with its own
// calendar (screen 13): month title with ‹ ›, a Sunday-first grid, and Today / Cancel / OK. Days after today cannot be picked (the API
// rejects future dates), and "next month" stops at this month. The open state can be owned by the sheet (`open`, `onOpenChange`) so
// browser Back can close the calendar before the sheet.
import { useEffect, useRef, useState } from 'react'
import { Modal, Pressable, StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native'
import { useEscape } from './useEscape'
import { dateFromIso, dateLabel, dayForKey, monthGrid, monthTitle, shiftMonth } from './flows/date'

type Props = {
  value: string; today: string; onChange: (iso: string) => void
  style?: StyleProp<ViewStyle>; activeStyle?: StyleProp<ViewStyle>; textStyle?: StyleProp<TextStyle>; boldStyle?: StyleProp<TextStyle>; testID?: string
  open?: boolean; onOpenChange?: (open: boolean) => void
}

const TEAL = '#0f766e'
const INK = '#14221c'
// Just the DOM this file touches (the app's tsconfig has no DOM lib).
type El = { focus(): void; setAttribute(name: string, value: string): void; isConnected: boolean; contains(other: unknown): boolean; getAttribute(name: string): string | null; querySelector(sel: string): El | null; querySelectorAll(sel: string): ArrayLike<El> }
type KeyEv = { key: string; shiftKey: boolean; preventDefault(): void; stopPropagation(): void }
type Doc = { activeElement: El | null; addEventListener(t: 'keydown', f: (e: KeyEv) => void, capture: boolean): void; removeEventListener(t: 'keydown', f: (e: KeyEv) => void, capture: boolean): void }
const doc = () => (globalThis as unknown as { document: Doc }).document

const LONG_DAY = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })

export function DateChip({ value, today, onChange, style, activeStyle, textStyle, boldStyle, testID, open: openProp, onOpenChange }: Props) {
  const [own, setOwn] = useState(false)
  const open = openProp ?? own
  const setOpen = (next: boolean) => { setOwn(next); onOpenChange?.(next) }
  const label = dateLabel(value, today)
  return (
    <View>
      <Pressable style={[style, open && activeStyle]} onPress={() => setOpen(!open)} accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={`Expense date, ${label}. Opens a calendar`} testID={testID}>
        <Text style={textStyle}><Text accessible={false}>📅 </Text><Text style={boldStyle}>{label}</Text></Text>
      </Pressable>
      {open && <Calendar value={value} today={today} onPick={(iso) => { setOpen(false); if (iso <= today) onChange(iso) }} onClose={() => setOpen(false)} />}
    </View>
  )
}

function Calendar({ value, today, onPick, onClose }: { value: string; today: string; onPick: (iso: string) => void; onClose: () => void }) {
  const start = dateFromIso(value) ?? dateFromIso(today) ?? new Date()
  const now = dateFromIso(today) ?? new Date()
  const [view, setView] = useState({ year: start.getFullYear(), month: start.getMonth() })
  const [chosen, setChosen] = useState(value)
  const atNow = view.year === now.getFullYear() && view.month === now.getMonth()
  useEscape(onClose)
  const step = (by: number) => setView((v) => shiftMonth(v.year, v.month, by))
  const cells = monthGrid(view.year, view.month)
  // Keyboard: focus stays inside the panel (Tab wraps), one day cell is in the Tab order (the roving `focusDay`), arrows / Home / End
  // move it (switching month as needed, never past today) and Enter or Space picks it. Focus returns to the chip on close.
  const panel = useRef<El | null>(null)
  const [focusDay, setFocusDay] = useState(chosen <= today ? chosen : today)
  const wantFocus = useRef(true)
  const live = useRef({ focusDay, today })
  live.current = { focusDay, today }
  const dayEl = (iso: string) => panel.current?.querySelector(`[data-testid="date-day-${iso}"]`) ?? null
  useEffect(() => {
    // Roving tab stop: only the focused day is in the Tab order (react-native-web ignores `focusable` on its <button>s).
    const root = panel.current
    if (!root) return
    const days = root.querySelectorAll('[data-testid^="date-day-"]')
    for (let i = 0; i < days.length; i++) days[i].setAttribute('tabindex', days[i].getAttribute('data-testid') === `date-day-${focusDay}` ? '0' : '-1')
  })
  useEffect(() => {
    if (!wantFocus.current) return
    const el = dayEl(focusDay)
    if (!el) return
    wantFocus.current = false
    el.focus()
  })
  useEffect(() => {
    // The add sheet's own Modal traps focus too, and the two traps pull focus back and forth (ending on the backdrop). Focus that lands
    // inside the calendar is handled here, so stop it before either trap sees it (window capture runs before document capture).
    const w = globalThis as unknown as { addEventListener(t: 'focus', f: (e: { target: unknown; stopImmediatePropagation(): void }) => void, c: boolean): void; removeEventListener(t: 'focus', f: (e: { target: unknown; stopImmediatePropagation(): void }) => void, c: boolean): void }
    const onFocus = (event: { target: unknown; stopImmediatePropagation(): void }) => { if (panel.current && panel.current.contains(event.target)) event.stopImmediatePropagation() }
    w.addEventListener('focus', onFocus, true)
    return () => w.removeEventListener('focus', onFocus, true)
  }, [])
  useEffect(() => {
    // The Modal moves focus to its first focusable once it has mounted; take it back into the panel.
    const timers = [0, 50, 150].map((ms) => setTimeout(() => { if (panel.current && !panel.current.contains(doc().activeElement)) dayEl(live.current.focusDay)?.focus() }, ms))
    return () => timers.forEach(clearTimeout)
  }, [])
  useEffect(() => {
    const opener = doc().activeElement as El | null
    const onKey = (event: KeyEv) => {
      const root = panel.current
      if (!root) return
      if (event.key === 'Tab') {
        const items = Array.from(root.querySelectorAll('[tabindex="0"]')).filter((el) => el.getAttribute('aria-disabled') !== 'true')
        if (items.length === 0) return
        const at = items.indexOf(doc().activeElement as El)
        const next = event.shiftKey ? (at <= 0 ? items.length - 1 : at - 1) : (at === -1 || at === items.length - 1 ? 0 : at + 1)
        event.preventDefault(); items[next].focus()
        return
      }
      const active = doc().activeElement as El | null
      const onDay = !!active && root.contains(active) && (active.getAttribute('data-testid') ?? '').startsWith('date-day-')
      if (!onDay) return
      const iso = (active!.getAttribute('data-testid') ?? '').slice('date-day-'.length)
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault(); event.stopPropagation()
        if (iso <= live.current.today) setChosen(iso)
        return
      }
      const to = dayForKey(iso, event.key, live.current.today)
      if (!to) return
      event.preventDefault(); event.stopPropagation()
      const d = dateFromIso(to)!
      setView({ year: d.getFullYear(), month: d.getMonth() })
      setFocusDay(to)
      wantFocus.current = true
    }
    doc().addEventListener('keydown', onKey, true)
    return () => {
      doc().removeEventListener('keydown', onKey, true)
      if (opener && opener.isConnected) opener.focus()
    }
  }, [])
  return (
    <Modal transparent animationType="fade" visible onRequestClose={onClose} statusBarTranslucent>
      <View style={s.scrim} testID="date-picker">
        <Pressable style={StyleSheet.absoluteFillObject} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close the calendar" focusable={false} {...({ tabIndex: -1 } as object)} />
        <View style={s.panel} accessibilityViewIsModal ref={(el) => { panel.current = el as unknown as El | null }} {...({ role: 'dialog', 'aria-modal': true, 'aria-label': 'Choose the expense date' } as object)}>
          <View style={s.head}>
            <Text style={s.title} accessibilityRole="header" testID="date-month">{monthTitle(view.year, view.month)}</Text>
            <Pressable style={s.nav} onPress={() => step(-1)} accessibilityRole="button" accessibilityLabel="Previous month" testID="date-prev"><Text style={s.navText}>‹</Text></Pressable>
            <Pressable style={[s.nav, atNow && s.navOff]} disabled={atNow} onPress={() => step(1)} accessibilityRole="button" accessibilityLabel="Next month" accessibilityState={{ disabled: atNow }} testID="date-next"><Text style={s.navText}>›</Text></Pressable>
          </View>
          <View style={s.week} accessible={false}>
            {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => <Text key={i} style={s.weekDay}>{d}</Text>)}
          </View>
          <View style={s.grid}>
            {cells.map((iso, i) => {
              if (!iso) return <View key={`b${i}`} style={s.cell} />
              const future = iso > today
              const on = iso === chosen
              return (
                <View key={iso} style={s.cell}>
                  <Pressable style={[s.day, iso === today && s.dayToday, on && s.dayOn]} disabled={future} onPress={() => { setChosen(iso); setFocusDay(iso) }}
                    accessibilityRole="button" accessibilityLabel={LONG_DAY.format(dateFromIso(iso)!)} accessibilityState={{ selected: on, disabled: future }} testID={`date-day-${iso}`}>
                    <Text style={[s.dayText, future && s.dayOff, on && s.dayTextOn]}>{Number(iso.slice(8))}</Text>
                  </Pressable>
                </View>
              )
            })}
          </View>
          <View style={s.foot}>
            <Pressable onPress={() => onPick(today)} accessibilityRole="button" style={s.act} testID="date-today"><Text style={s.actText}>Today</Text></Pressable>
            <View style={s.grow} />
            <Pressable onPress={onClose} accessibilityRole="button" style={s.act} testID="date-cancel"><Text style={s.actText}>Cancel</Text></Pressable>
            <Pressable onPress={() => onPick(chosen)} accessibilityRole="button" style={s.act} testID="date-ok"><Text style={s.actText}>OK</Text></Pressable>
          </View>
        </View>
      </View>
    </Modal>
  )
}

const s = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: '#00000066', alignItems: 'center', justifyContent: 'center', padding: 16 },
  panel: { backgroundColor: '#ffffff', borderRadius: 28, paddingHorizontal: 16, paddingTop: 18, paddingBottom: 8, width: '100%', maxWidth: 360 },
  head: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 6, marginBottom: 8 },
  title: { flex: 1, fontSize: 17, fontWeight: '900', color: INK },
  nav: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  navOff: { opacity: 0.3 },
  navText: { color: TEAL, fontSize: 26, fontWeight: '900', lineHeight: 28 },
  week: { flexDirection: 'row' },
  weekDay: { width: `${100 / 7}%`, textAlign: 'center', color: '#5f6f67', fontWeight: '800', fontSize: 12, paddingVertical: 6 },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  cell: { width: `${100 / 7}%`, height: 44, alignItems: 'center', justifyContent: 'center' },
  day: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderColor: 'transparent' },
  dayToday: { borderColor: TEAL },
  dayOn: { backgroundColor: TEAL, borderColor: TEAL },
  dayText: { color: INK, fontWeight: '700', fontSize: 15 },
  dayOff: { color: '#aeb8b2' },
  dayTextOn: { color: '#ffffff', fontWeight: '900' },
  foot: { flexDirection: 'row', alignItems: 'center', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#e4e8e2', marginTop: 6 },
  grow: { flex: 1 },
  act: { paddingVertical: 14, paddingHorizontal: 12, minHeight: 44, justifyContent: 'center' },
  actText: { color: TEAL, fontWeight: '800', fontSize: 15 },
})
