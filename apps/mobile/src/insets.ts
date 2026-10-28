// Bottom safe-area inset for sheets and bars. Android draws edge to edge, so the gesture/nav bar sits over the bottom of the
// window. While the keyboard is up it already covers that area, so the inset drops to 0 and sheets don't float above the keys.
import { useEffect, useState } from 'react'
import { Keyboard, Platform } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

export function useBottomInset(): number {
  const { bottom } = useSafeAreaInsets()
  const [keyboard, setKeyboard] = useState(false)
  useEffect(() => {
    if (Platform.OS === 'web') return
    const show = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', () => setKeyboard(true))
    const hide = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', () => setKeyboard(false))
    return () => { show.remove(); hide.remove() }
  }, [])
  return keyboard ? 0 : bottom
}

/** A style's numeric paddingBottom (0 when absent), so the inset can be added on top of the sheet's own padding. */
export function basePaddingBottom(style: unknown): number {
  const flat = Array.isArray(style) ? Object.assign({}, ...style.flat(Infinity).filter(Boolean)) : (style ?? {})
  const value = (flat as { paddingBottom?: unknown }).paddingBottom
  return typeof value === 'number' ? value : 0
}
