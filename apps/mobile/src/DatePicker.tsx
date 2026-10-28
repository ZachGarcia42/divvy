// Native date chip: shows "Today" / "Yesterday" / "Mon, Oct 26". Android opens the system date dialog; iOS opens the system
// calendar inline under the chips. Days are local calendar days (see flows/date.ts).
import DateTimePicker, { DateTimePickerAndroid, type DateTimePickerEvent } from '@react-native-community/datetimepicker'
import { useState } from 'react'
import { Platform, Pressable, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native'
import { dateFromIso, dateLabel, isoFromDate } from './flows/date'

type Props = {
  value: string; today: string; onChange: (iso: string) => void
  style?: StyleProp<ViewStyle>; activeStyle?: StyleProp<ViewStyle>; textStyle?: StyleProp<TextStyle>; boldStyle?: StyleProp<TextStyle>; testID?: string
}

export function DateChip({ value, today, onChange, style, activeStyle, textStyle, boldStyle, testID }: Props) {
  const [open, setOpen] = useState(false)
  const current = dateFromIso(value) ?? new Date()
  const max = dateFromIso(today) ?? new Date()
  const picked = (event: DateTimePickerEvent, date?: Date) => {
    setOpen(Platform.OS === 'ios')
    if (event.type === 'set' && date) onChange(isoFromDate(date))
  }
  const press = () => {
    if (Platform.OS === 'android') { setOpen(true); DateTimePickerAndroid.open({ value: current, mode: 'date', maximumDate: max, onChange: picked, onError: () => setOpen(false) }) }
    else setOpen((was) => !was)
  }
  return (
    <>
      <Pressable style={[style, open && activeStyle]} onPress={press} accessibilityRole="button" accessibilityLabel={`Expense date, ${dateLabel(value, today)}`} testID={testID}>
        <Text style={textStyle}>📅 <Text style={boldStyle}>{dateLabel(value, today)}</Text></Text>
      </Pressable>
      {open && Platform.OS === 'ios' && (
        <View style={{ width: '100%', borderRadius: 16, overflow: 'hidden', backgroundColor: '#ffffff14' }}>
          <DateTimePicker value={current} mode="date" display="inline" maximumDate={max} themeVariant="dark" accentColor="#2dd4bf" onChange={picked} />
        </View>
      )}
    </>
  )
}
