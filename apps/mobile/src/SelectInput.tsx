// A TextInput that selects its text when focused. Native uses the built-in `selectTextOnFocus`.
//
// react-native-web implements that prop with a setTimeout(select) after focus. If someone focuses a field and starts
// typing straight away (or presses Ctrl+A and types fast), the delayed select() lands in the middle of what they typed,
// the next key replaces it, and "1.50" ends up as ".50". On web we select ourselves and only when nothing has been
// typed in the meantime.
import { forwardRef } from 'react'
import { Platform, TextInput, type TextInputProps } from 'react-native'

type Field = { value: string; select(): void; ownerDocument: { activeElement: unknown } }

export const SelectInput = forwardRef<TextInput, TextInputProps>(function SelectInput({ onFocus, ...rest }, ref) {
  if (Platform.OS !== 'web') return <TextInput ref={ref} selectTextOnFocus onFocus={onFocus} {...rest} />
  return (
    <TextInput
      ref={ref}
      {...rest}
      onFocus={(event) => {
        onFocus?.(event)
        const field = event.target as unknown as Field
        const before = field.value
        setTimeout(() => {
          if (field.ownerDocument.activeElement === field && field.value === before) field.select()
        }, 0)
      }}
    />
  )
})
