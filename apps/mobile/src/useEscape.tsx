import { useEffect } from 'react'
import { Platform } from 'react-native'

type KeyEvent = { key: string; stopPropagation(): void; preventDefault(): void }
type Win = { addEventListener(type: 'keyup', handler: (event: KeyEvent) => void, capture: boolean): void; removeEventListener(type: 'keyup', handler: (event: KeyEvent) => void, capture: boolean): void }

/** Web only: Escape closes this layer and nothing underneath it (react-native-web Modals close on the Escape key-up, so the sheet below would close as well). */
export function useEscape(onEscape: () => void) {
  useEffect(() => {
    const win = globalThis as unknown as Partial<Win>
    if (Platform.OS !== 'web' || !win.addEventListener || !win.removeEventListener) return
    const onKey = (event: KeyEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation(); event.preventDefault(); onEscape()
    }
    win.addEventListener('keyup', onKey, true)
    return () => win.removeEventListener!('keyup', onKey, true)
  }, [onEscape])
}

/** Drop inside a layer to make Escape close just that layer. */
export function EscapeLayer({ onEscape }: { onEscape: () => void }) {
  useEscape(onEscape)
  return null
}
