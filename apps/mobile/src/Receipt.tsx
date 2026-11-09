// Receipt photo UI: the "Add receipt" row in the Add/Edit sheet, the Receipt card on the expense detail, the take/choose
// sheet and the full-screen viewer (designs 08-11). One photo per expense. Plain colours here so V2.tsx can import this file.
import { Ionicons } from '@expo/vector-icons'
import { useRef, useState } from 'react'
import { Animated, Linking, Modal, PanResponder, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { photoUiError, receiptAttachedLabel, type PhotoUiError, type PickedPhoto, type ReceiptSource } from './flows/photo'
import type { PhotoInfo } from './types'
import { PhotoImage } from './PhotoImage'
import { pickReceipt, type PhotoSource } from './pickPhoto'

const C = { teal: '#0f766e', ink: '#14221c', muted: '#5f6f67', line: '#e4e8e2', card: '#ffffff', red: '#b4323f', bad: '#ffb3ba', aqua: '#2dd4bf' }

/** Take photo / Choose from library / Cancel. Picks, shrinks, and hands the JPEG back; errors come back as text. */
export function ReceiptSourceSheet({ onPicked, onError, onClose }: { onPicked: (photo: PickedPhoto) => void; onError: (error: PhotoUiError) => void; onClose: () => void }) {
  const [busy, setBusy] = useState(false)
  const choose = async (source: PhotoSource) => {
    if (busy) return
    setBusy(true)
    try {
      const photo = await pickReceipt(source)
      onClose()
      if (photo) onPicked(photo)
    } catch (reason) {
      onClose()
      onError(photoUiError(reason, 'That photo couldn’t be added.'))
    }
  }
  return (
    <Modal transparent animationType="fade" onRequestClose={onClose} visible statusBarTranslucent>
      <View style={s.scrim} testID="receipt-source-sheet">
        <Pressable style={s.scrimFill} onPress={onClose} accessibilityLabel="Close" accessibilityRole="button" />
        <View style={s.sheet}>
          <View style={s.group}>
            <Pressable style={s.option} onPress={() => { void choose('camera') }} accessibilityRole="button" testID="receipt-take">
              <Ionicons name="camera-outline" size={20} color={C.teal} /><Text style={s.optionText}>Take photo</Text>
            </Pressable>
            <View style={s.sep} />
            <Pressable style={s.option} onPress={() => { void choose('library') }} accessibilityRole="button" testID="receipt-library">
              <Ionicons name="image-outline" size={20} color={C.teal} /><Text style={s.optionText}>Choose from library</Text>
            </Pressable>
          </View>
          <Pressable style={[s.group, s.option, { marginTop: 8 }]} onPress={onClose} accessibilityRole="button" testID="receipt-cancel"><Text style={[s.optionText, { color: C.ink }]}>Cancel</Text></Pressable>
        </View>
      </View>
    </Modal>
  )
}

/** The row under the chips in the Add/Edit sheet: dashed "Add receipt · Optional", or the attached receipt with Remove. */
export function ReceiptRow({ source, bytes, fileName, contentType, onAdd, onView, onRemove, error }: {
  source: ReceiptSource | null; bytes?: number; fileName?: string | null; contentType?: string | null
  onAdd: () => void; onView: () => void; onRemove: () => void; error: PhotoUiError | string | null
}) {
  const sub = receiptAttachedLabel({ fileName, bytes, contentType })
  return (
    <View style={{ marginHorizontal: 18, marginTop: 12 }}>
      {source ? (
        <View style={r.attached} testID="receipt-attached">
          <Pressable style={r.attachedMain} onPress={onView} accessibilityRole="button" accessibilityLabel={`Receipt attached. ${sub}`} testID="receipt-view">
            <PhotoImage source={source} style={r.thumbSm} label="Receipt thumbnail" />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={r.title}>Receipt attached</Text>
              <Text style={r.sub} numberOfLines={1}>{sub}</Text>
            </View>
          </Pressable>
          <Pressable onPress={onRemove} accessibilityRole="button" accessibilityLabel="Remove receipt" hitSlop={8} testID="receipt-remove" style={r.removeHit}>
            <Text style={r.remove}>Remove</Text>
          </Pressable>
        </View>
      ) : (
        <Pressable style={r.empty} onPress={onAdd} accessibilityRole="button" accessibilityLabel="Add receipt, optional" testID="receipt-add">
          <View style={r.cam}><Ionicons name="camera-outline" size={20} color={C.aqua} /></View>
          <View style={{ flex: 1 }}>
            <Text style={r.title}>Add receipt</Text>
            <Text style={r.sub}>Optional · photo of the bill</Text>
          </View>
          <Text style={r.plus} accessible={false}>+</Text>
        </Pressable>
      )}
      <ReceiptError error={error} tone="dark" />
    </View>
  )
}

/** The Receipt card on the expense detail. Editors with no photo see a dashed Add row; everyone else sees nothing. */
export function ReceiptCard({ youId, photo, source, canEdit, busy, error, onAdd, onView }: {
  youId?: string | null; photo: PhotoInfo | null | undefined; source: ReceiptSource | null; canEdit: boolean; busy: boolean; error: PhotoUiError | string | null; onAdd: () => void; onView: () => void
}) {
  if (photo === undefined) return null
  if (!photo || !source) {
    if (!canEdit) return null
    return (
      <View style={{ marginTop: 20 }}>
        <Text style={c.eyebrow}>Receipt</Text>
        <Pressable style={[c.add, busy && { opacity: 0.5 }]} disabled={busy} onPress={onAdd} accessibilityRole="button" accessibilityLabel="Add receipt photo" testID="receipt-add">
          <Ionicons name="camera-outline" size={22} color={C.teal} />
          <Text style={c.addText}>{busy ? 'Adding…' : 'Add receipt'}</Text>
        </Pressable>
        <ReceiptError error={error} tone="light" />
      </View>
    )
  }
  return (
    <View style={{ marginTop: 20 }}>
      <Text style={c.eyebrow}>Receipt</Text>
      <Pressable style={c.card} onPress={onView} accessibilityRole="button" accessibilityLabel="Receipt photo. View full size" testID="receipt-view">
        <PhotoImage source={source} style={c.thumb} label="Receipt thumbnail" />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={c.title}>Receipt photo</Text>
          <Text style={c.sub} numberOfLines={2}>{busy ? 'Updating…' : photoByline(photo, youId)}</Text>
          <Text style={c.view}>View full size ›</Text>
        </View>
      </Pressable>
      <ReceiptError error={error} tone="light" />
    </View>
  )
}

/** "Added by You · Oct 27, 8:12 AM". */
export function photoByline(photo: PhotoInfo, youId?: string | null) {
  const who = photo.byId && youId && photo.byId === youId ? 'You' : photo.byName ?? 'Someone'
  const when = new Date(photo.at)
  const text = Number.isNaN(when.getTime()) ? '' : ` · ${when.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
  return `Added by ${who}${text}`
}

/** Gestures that this viewer actually supports without gesture-handler / reanimated. */
function viewerHint(): string {
  // iOS ScrollView gives real pinch zoom; every platform gets double-tap zoom + swipe-down close.
  if (Platform.OS === 'ios') return 'Pinch or double-tap to zoom · swipe down to close'
  return 'Double-tap to zoom · swipe down to close'
}

/** Full-screen, near-black. Replace and Remove show only when the person can edit the expense. Share is deferred. */
export function ReceiptViewer({ source, title, subtitle, canEdit, busy, onClose, onReplace, onRemove }: {
  source: ReceiptSource; title: string; subtitle: string; canEdit: boolean; busy?: boolean; onClose: () => void; onReplace?: () => void; onRemove?: () => void
}) {
  // Modal keeps the app's SafeAreaProvider context (same pattern as NameSheet); pad past the status bar / home indicator.
  const insets = useSafeAreaInsets()
  return (
    <Modal animationType="fade" onRequestClose={onClose} visible statusBarTranslucent>
      <View style={[v.screen, { paddingTop: insets.top + 16 }]} testID="receipt-viewer">
        <View style={v.head}>
          <Pressable style={v.close} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close receipt" testID="receipt-viewer-close"><Ionicons name="close" size={22} color="#fff" /></Pressable>
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Text style={v.title} numberOfLines={1}>{title}</Text>
            <Text style={v.sub} numberOfLines={1}>{subtitle}</Text>
          </View>
          <View style={{ width: 40 }} />
        </View>
        <ViewerImage source={source} onClose={onClose} />
        <View style={[v.footer, { paddingBottom: 16 + insets.bottom }]}>
          <Text style={v.hint} testID="receipt-viewer-hint">{viewerHint()}</Text>
          {canEdit && (
            <View style={v.actions}>
              <Pressable style={[v.btn, busy && { opacity: 0.5 }]} disabled={busy} onPress={onReplace} accessibilityRole="button" testID="receipt-replace"><Text style={v.btnText}>Replace</Text></Pressable>
              <Pressable style={[v.btn, v.btnRed, busy && { opacity: 0.5 }]} disabled={busy} onPress={onRemove} accessibilityRole="button" testID="receipt-viewer-remove"><Text style={[v.btnText, { color: C.bad }]}>Remove</Text></Pressable>
            </View>
          )}
        </View>
      </View>
    </Modal>
  )
}

/** Zoomable receipt image: double-tap zoom + swipe-down close everywhere; pinch via ScrollView on iOS only. */
function ViewerImage({ source, onClose }: { source: ReceiptSource; onClose: () => void }) {
  const scale = useRef(new Animated.Value(1)).current
  const translateY = useRef(new Animated.Value(0)).current
  const zoomed = useRef(false)
  const lastTap = useRef(0)

  const setZoom = (on: boolean) => {
    zoomed.current = on
    Animated.spring(scale, { toValue: on ? 2.5 : 1, useNativeDriver: true, friction: 7 }).start()
    if (!on) translateY.setValue(0)
  }

  const onImagePress = () => {
    const now = Date.now()
    if (now - lastTap.current < 280) setZoom(!zoomed.current)
    lastTap.current = now
  }

  const pan = useRef(PanResponder.create({
    onMoveShouldSetPanResponder: (_, g) => !zoomed.current && g.dy > 10 && Math.abs(g.dy) > Math.abs(g.dx) * 1.2,
    onPanResponderMove: (_, g) => { if (g.dy > 0) translateY.setValue(g.dy) },
    onPanResponderRelease: (_, g) => {
      if (g.dy > 100 || g.vy > 1.0) onClose()
      else Animated.spring(translateY, { toValue: 0, useNativeDriver: true }).start()
    },
  })).current

  // iOS: native ScrollView pinch zoom (maximumZoomScale). Double-tap still toggles via the overlay Pressable.
  // Android/web have no ScrollView pinch without gesture-handler, so they rely on double-tap only.
  if (Platform.OS === 'ios') {
    return (
      <Animated.View style={[v.frame, { transform: [{ translateY }] }]} {...pan.panHandlers} testID="receipt-viewer-zoom">
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={v.zoomContent}
          maximumZoomScale={4}
          minimumZoomScale={1}
          centerContent
          showsHorizontalScrollIndicator={false}
          showsVerticalScrollIndicator={false}
          bouncesZoom
        >
          <Pressable onPress={onImagePress} accessibilityRole="image" accessibilityLabel="Receipt photo. Double-tap to zoom">
            <Animated.View style={{ transform: [{ scale }] }}>
              <PhotoImage source={source} style={v.imageFixed} resizeMode="contain" label="Receipt photo" testID="receipt-viewer-image" />
            </Animated.View>
          </Pressable>
        </ScrollView>
      </Animated.View>
    )
  }

  return (
    <Animated.View
      style={[v.frame, { transform: [{ translateY }, { scale }] }]}
      {...pan.panHandlers}
      testID="receipt-viewer-zoom"
    >
      <Pressable style={{ flex: 1 }} onPress={onImagePress} accessibilityRole="image" accessibilityLabel="Receipt photo. Double-tap to zoom">
        <PhotoImage source={source} style={v.image} resizeMode="contain" label="Receipt photo" testID="receipt-viewer-image" />
      </Pressable>
    </Animated.View>
  )
}

/** Permission / pick error under the receipt row. Shows Open Settings when the camera was denied forever. */
function ReceiptError({ error, tone }: { error: PhotoUiError | string | null; tone: 'dark' | 'light' }) {
  if (!error) return null
  const text = typeof error === 'string' ? error : error.text
  const openSettings = typeof error === 'string' ? false : !!error.openSettings
  const textStyle = tone === 'dark' ? r.error : r.errorLight
  return (
    <View style={r.errorRow} testID="receipt-error">
      <Text style={[textStyle, { flex: 1, marginTop: 0 }]}>{text}</Text>
      {openSettings && (
        <Pressable
          style={r.settingsBtn}
          onPress={() => { void Linking.openSettings() }}
          accessibilityRole="button"
          accessibilityLabel="Open Settings"
          testID="receipt-open-settings"
        >
          <Text style={r.settingsText}>Open Settings</Text>
        </Pressable>
      )}
    </View>
  )
}

const s = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: '#00000066', justifyContent: 'flex-end' },
  scrimFill: { ...StyleSheet.absoluteFillObject },
  sheet: { padding: 12, paddingBottom: 24, width: '100%', maxWidth: 480, alignSelf: 'center' },
  group: { backgroundColor: C.card, borderRadius: 18, overflow: 'hidden' },
  option: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, minHeight: 56 },
  optionText: { fontSize: 17, fontWeight: '800', color: C.teal },
  sep: { height: 1, backgroundColor: C.line },
})
const r = StyleSheet.create({
  empty: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1.5, borderStyle: 'dashed', borderColor: '#ffffff33', borderRadius: 16, padding: 12 },
  cam: { width: 40, height: 40, borderRadius: 12, backgroundColor: '#ffffff14', alignItems: 'center', justifyContent: 'center' },
  title: { color: '#ffffff', fontSize: 16, fontWeight: '800' },
  sub: { color: '#b9c9c1', fontSize: 13, fontWeight: '600', marginTop: 1 },
  plus: { color: '#b9c9c1', fontSize: 24, fontWeight: '600' },
  attached: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, borderStyle: 'solid', borderColor: '#ffffff26', backgroundColor: '#ffffff0d', borderRadius: 16, padding: 10 },
  attachedMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12, minWidth: 0 },
  thumbSm: { width: 48, height: 62, borderRadius: 8, backgroundColor: '#ffffff22' },
  removeHit: { minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
  remove: { color: C.bad, fontSize: 15, fontWeight: '800' },
  error: { color: C.bad, marginTop: 8, fontWeight: '600' },
  errorLight: { color: C.red, marginTop: 8, fontWeight: '600', marginHorizontal: 4 },
  errorRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 8, marginHorizontal: 4 },
  settingsBtn: { minHeight: 44, minWidth: 44, paddingHorizontal: 12, borderRadius: 12, backgroundColor: '#0f766e22', alignItems: 'center', justifyContent: 'center' },
  settingsText: { color: C.teal, fontSize: 14, fontWeight: '800' },
})
const c = StyleSheet.create({
  eyebrow: { fontSize: 12, fontWeight: '800', letterSpacing: 1.1, textTransform: 'uppercase', color: C.muted, marginBottom: 8, marginHorizontal: 4 },
  // Solid white card once a receipt is attached (design 10). Dashed border stays only on the empty Add row.
  card: { flexDirection: 'row', alignItems: 'center', gap: 14, backgroundColor: C.card, borderWidth: 1, borderStyle: 'solid', borderColor: C.line, borderRadius: 20, padding: 12 },
  thumb: { width: 76, height: 100, borderRadius: 10, backgroundColor: '#eef2ee' },
  title: { fontSize: 16, fontWeight: '800', color: C.ink },
  sub: { fontSize: 13, fontWeight: '600', color: C.muted, marginTop: 2 },
  view: { fontSize: 15, fontWeight: '800', color: C.teal, marginTop: 8 },
  add: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, minHeight: 56, borderWidth: 1.5, borderStyle: 'dashed', borderColor: '#b9d3c9', borderRadius: 20, backgroundColor: '#f3faf7' },
  addText: { fontSize: 16, fontWeight: '800', color: C.teal },
})
const v = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0b100e' },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingBottom: 12 },
  close: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#ffffff1f', alignItems: 'center', justifyContent: 'center' },
  title: { color: '#fff', fontSize: 16, fontWeight: '800' },
  sub: { color: '#9db3a9', fontSize: 12, fontWeight: '600', marginTop: 1 },
  frame: { flex: 1, margin: 8 },
  zoomContent: { flexGrow: 1, justifyContent: 'center', alignItems: 'center' },
  image: { flex: 1, width: '100%' },
  imageFixed: { width: 320, height: 420 },
  footer: { paddingHorizontal: 16, paddingTop: 4 },
  hint: { textAlign: 'center', color: '#9fb4aa', fontSize: 12.5, fontWeight: '600', marginBottom: 14 },
  actions: { flexDirection: 'row', gap: 12 },
  btn: { flex: 1, minHeight: 52, borderRadius: 16, backgroundColor: '#1f2b26', alignItems: 'center', justifyContent: 'center' },
  btnRed: { backgroundColor: '#3a2a2c' },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '800' },
})
