// Web date chip, styled like the mockup (calendar icon + "Today" / "Yesterday" / "Tue, Oct 27", teal ring while open) with its own
// calendar (screen 13): month title with ‹ ›, a Sunday-first grid, and Today / Cancel / OK. Days after today cannot be picked (the API
// rejects future dates), and "next month" stops at this month. The open state can be owned by the sheet (`open`, `onOpenChange`) so
// browser Back can close the calendar before the sheet.
import { useState } from 'react'
import { Modal, Pressable, StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native'
import { useEscape } from './useEscape'
import { dateFromIso, dateLabel, monthGrid, monthTitle, shiftMonth } from './flows/date'

type Props = {
  value: string; today: string; onChange: (iso: string) => void
  style?: StyleProp<ViewStyle>; activeStyle?: StyleProp<ViewStyle>; textStyle?: StyleProp<TextStyle>; boldStyle?: StyleProp<TextStyle>; testID?: string
  open?: boolean; onOpenChange?: (open: boolean) => void
}

const TEAL = '#0f766e'
const INK = '#14221c'
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
  return (
    <Modal transparent animationType="fade" visible onRequestClose={onClose} statusBarTranslucent>
      <View style={s.scrim} testID="date-picker">
        <Pressable style={StyleSheet.absoluteFillObject} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close the calendar" />
        <View style={s.panel} accessibilityViewIsModal>
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
                  <Pressable style={[s.day, iso === today && s.dayToday, on && s.dayOn]} disabled={future} onPress={() => setChosen(iso)}
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
