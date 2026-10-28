// Web date chip, styled like the mockup (calendar icon + "Today" / "Yesterday" / "Tue, Oct 27", teal ring while open).
// The visible chip is a normal button. A real <input type="date"> sits beside it, visually hidden and out of the tab order,
// so it never covers the label; pressing the chip asks the browser to open its calendar (showPicker) on that input.
import { createElement, useRef, useState } from 'react'
import { Pressable, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native'
import { dateLabel } from './flows/date'

type Props = {
  value: string; today: string; onChange: (iso: string) => void
  style?: StyleProp<ViewStyle>; activeStyle?: StyleProp<ViewStyle>; textStyle?: StyleProp<TextStyle>; boldStyle?: StyleProp<TextStyle>; testID?: string
}

type DateInput = { showPicker?: () => void; focus: () => void; click: () => void }
const HIDDEN = { position: 'absolute', width: 1, height: 1, left: 0, bottom: 0, opacity: 0, overflow: 'hidden', pointerEvents: 'none', border: 0, padding: 0, margin: 0 } as const

export function DateChip({ value, today, onChange, style, activeStyle, textStyle, boldStyle, testID }: Props) {
  const input = useRef<DateInput | null>(null)
  const [open, setOpen] = useState(false)
  const label = dateLabel(value, today)
  const press = () => {
    const el = input.current
    if (!el) return
    setOpen(true)
    try { if (el.showPicker) el.showPicker(); else throw new Error('no showPicker') } catch { el.focus(); el.click() }
  }
  return (
    <View style={{ position: 'relative' }}>
      <Pressable style={[style, open && activeStyle]} onPress={press} accessibilityRole="button" accessibilityLabel={`Expense date, ${label}. Opens a calendar`} testID={testID}>
        <Text style={textStyle}><Text accessible={false}>📅 </Text><Text style={boldStyle}>{label}</Text></Text>
      </Pressable>
      {createElement('input', {
        ref: input,
        type: 'date',
        value,
        max: today,
        required: true,
        tabIndex: -1,
        'aria-hidden': true,
        'data-testid': 'date-input',
        onChange: (event: { target: { value: string } }) => { setOpen(false); if (event.target.value) onChange(event.target.value) },
        onBlur: () => setOpen(false),
        style: HIDDEN,
      })}
    </View>
  )
}
