// The bottom sheet used for create group, switch group and add expense. The grab pill drags the panel:
//  - compact (content height) sheets that are `resizable` grow to a tall snap point when dragged up, shrink back when
//    dragged down, and close only when dragged down past a third of their height or flicked down fast;
//  - fixed-height sheets close by the same rule, and otherwise snap back.
// The sheet slides in on its own while the scrim fades, so the dimmed layer never travels up with the panel (a stock
// `animationType="slide"` Modal slides everything, scrim included, which shows as a dark band above the panel).
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Animated, Dimensions, Easing, KeyboardAvoidingView, Modal, PanResponder, Platform, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'
import { basePaddingBottom, useBottomInset } from './insets'
import { dragOffset, dragOutcome, releaseVelocity, type DragSample, type SheetSnap } from './flows/sheet'

const web = Platform.OS === 'web'
const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())
/** When the pointer event happened (DOM timeStamp, same origin as performance.now), not when this handler got to run: a busy main thread can hold events back. */
const stamp = (event: { nativeEvent?: { timestamp?: number; timeStamp?: number } } | undefined): number => {
  const t = event?.nativeEvent?.timestamp ?? event?.nativeEvent?.timeStamp
  return typeof t === 'number' && Number.isFinite(t) && t > 0 ? t : clock()
}
const noSelect = (web ? { userSelect: 'none', WebkitUserSelect: 'none', touchAction: 'none', cursor: 'grab' } : null) as object | null

export function BottomSheet({ onClose, panelStyle, pillColor, resizable = false, fixedHeight = false, testID, children }: {
  onClose: () => void; panelStyle: StyleProp<ViewStyle>; pillColor: string; resizable?: boolean; fixedHeight?: boolean; testID?: string; children: ReactNode
}) {
  const [snap, setSnap] = useState<SheetSnap>(fixedHeight ? 'tall' : 'compact')
  const enter = useRef(new Animated.Value(Dimensions.get('window').height)).current
  const fade = useRef(new Animated.Value(0)).current
  const drag = useRef(new Animated.Value(0)).current
  const live = useRef({ snap, onClose })
  live.current = { snap, onClose }
  const panelHeight = useRef(0) // measured panel height; the dismiss distance is a third of it
  const samples = useRef<DragSample[]>([]) // recent pointer positions with performance.now times, for the web flick speed
  const native = !web
  const inset = useBottomInset()

  useEffect(() => {
    const run = Animated.parallel([
      Animated.timing(enter, { toValue: 0, duration: 260, easing: Easing.out(Easing.cubic), useNativeDriver: native }),
      Animated.timing(fade, { toValue: 1, duration: 220, useNativeDriver: native }),
    ])
    run.start()
    return () => run.stop()
  }, [enter, fade, native])

  const back = () => Animated.spring(drag, { toValue: 0, useNativeDriver: native, bounciness: 4 }).start()
  const pan = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: (event) => { samples.current = [{ t: stamp(event), y: 0 }] },
    onPanResponderMove: (event, g) => {
      samples.current.push({ t: stamp(event), y: g.dy }); if (samples.current.length > 24) samples.current.shift()
      drag.setValue(dragOffset(g.dy, live.current.snap, resizable && !fixedHeight))
    },
    onPanResponderRelease: (event, g) => {
      // react-native-web's g.vy is just the last move's delta over the gap before it (and ~0 for a one-move flick); use a window.
      const vy = web ? releaseVelocity(samples.current, stamp(event)) : g.vy
      const outcome = dragOutcome({ dy: g.dy, vy, snap: live.current.snap, resizable: resizable && !fixedHeight, height: panelHeight.current || undefined })
      const tap = Math.abs(g.dx) < 6 && Math.abs(g.dy) < 6
      if (tap && resizable && !fixedHeight) { setSnap((s) => (s === 'tall' ? 'compact' : 'tall')); back(); return }
      if (outcome === 'expand') setSnap('tall')
      if (outcome === 'collapse') setSnap('compact')
      if (outcome === 'dismiss') {
        // Slide a little further down, then ask to close. If the owner keeps the sheet (a "discard?" prompt), it springs back.
        Animated.timing(drag, { toValue: g.dy + 140, duration: 120, useNativeDriver: native }).start(() => { live.current.onClose(); back() })
        return
      }
      back()
    },
    onPanResponderTerminate: back,
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [resizable, fixedHeight, drag, native])

  return (
    <Modal transparent animationType="none" visible onRequestClose={onClose} statusBarTranslucent navigationBarTranslucent>
      <View style={styles.root}>
        <Animated.View style={[StyleSheet.absoluteFill, styles.scrim, { opacity: fade }]} pointerEvents="none" />
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" tabIndex={-1} />
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.wrap} pointerEvents="box-none">
          <Animated.View
            style={[panelStyle, !fixedHeight && snap === 'tall' && styles.tall, inset ? { paddingBottom: basePaddingBottom(panelStyle) + inset } : null, { transform: [{ translateY: Animated.add(enter, drag) }] }]}
            testID={testID}
            onLayout={(e) => { panelHeight.current = e.nativeEvent.layout.height }}
          >
            <View
              {...pan.panHandlers}
              style={[styles.pillHit, noSelect, web ? ({ order: -3 } as object) : null]}
              accessible
              accessibilityRole="button"
              accessibilityLabel={resizable && !fixedHeight ? 'Panel handle. Drag to resize or close' : 'Panel handle. Drag down to close'}
              testID="sheet-pill"
              {...(web ? ({ tabIndex: -1 } as object) : null)}
            >
              <View style={[styles.pill, { backgroundColor: pillColor }]} />
            </View>
            {children}
          </Animated.View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  scrim: { backgroundColor: 'rgba(20,34,28,0.45)' },
  wrap: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, justifyContent: 'flex-end', pointerEvents: 'box-none' } as object,
  tall: { height: '92%' },
  pillHit: { alignSelf: 'stretch', height: 24, marginTop: -8, alignItems: 'center', justifyContent: 'center' },
  pill: { width: 40, height: 5, borderRadius: 3 },
})
