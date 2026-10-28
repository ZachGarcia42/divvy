// Web date chip: shows "Today" / "Yesterday" / "Mon, Oct 26" and opens the browser's calendar. The real <input type="date">
// sits invisibly over the chip, so it is the thing that gets focus, keyboard input and screen-reader semantics.
import { createElement } from 'react'
import { Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native'
import { dateLabel } from './flows/date'

type Props = {
  value: string; today: string; onChange: (iso: string) => void
  style?: StyleProp<ViewStyle>; textStyle?: StyleProp<TextStyle>; boldStyle?: StyleProp<TextStyle>; testID?: string
}

export function DateChip({ value, today, onChange, style, textStyle, boldStyle, testID }: Props) {
  return (
    <View style={[style, { position: 'relative' }]} testID={testID}>
      <Text style={textStyle} accessible={false}><Text style={boldStyle}>{dateLabel(value, today)} ▾</Text></Text>
      {createElement('input', {
        type: 'date',
        value,
        max: today,
        required: true,
        'aria-label': `Expense date, ${dateLabel(value, today)}`,
        'data-testid': 'date-input',
        onChange: (event: { target: { value: string } }) => { if (event.target.value) onChange(event.target.value) },
        onClick: (event: { currentTarget: { showPicker?: () => void } }) => { try { event.currentTarget.showPicker?.() } catch { /* already open */ } },
        style: { position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', opacity: 0, cursor: 'pointer', border: 0, padding: 0, margin: 0, font: 'inherit' },
      })}
    </View>
  )
}
