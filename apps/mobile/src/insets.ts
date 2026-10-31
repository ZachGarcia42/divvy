// Bottom safe-area inset for sheets and bars. Android draws edge to edge, so the gesture/nav bar sits over the bottom of the
// window. While the keyboard is up it already covers that area, so the inset drops to 0 and sheets don't float above the keys.
import { useEffect, useState } from 'react'
import { Keyboard, Platform } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { keyboardLift } from './flows/sheet'

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

/**
 * How far a sheet must lift to clear the keyboard (px; 0 while it is hidden and on web). Android draws edge to edge and a Modal
 * window is not resized for the keyboard, so every sheet pads its bottom by this amount instead of relying on adjustResize.
 */
export function useKeyboardLift(): number {
  const [height, setHeight] = useState(0)
  const { bottom } = useSafeAreaInsets() // the nav-bar inset RN leaves out of the keyboard height on Android
  useEffect(() => {
    if (Platform.OS === 'web') return
    const ios = Platform.OS === 'ios'
    const show = Keyboard.addListener(ios ? 'keyboardWillShow' : 'keyboardDidShow', (e) => setHeight(e.endCoordinates?.height ?? 0))
    const hide = Keyboard.addListener(ios ? 'keyboardWillHide' : 'keyboardDidHide', () => setHeight(0))
    return () => { show.remove(); hide.remove() }
  }, [])
  return keyboardLift(height, Platform.OS, bottom)
}
