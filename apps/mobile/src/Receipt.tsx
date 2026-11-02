// Receipt photo UI: the "Add receipt" row in the Add/Edit sheet, the Receipt card on the expense detail, the take/choose
// sheet and the full-screen viewer (designs 08-11). One photo per expense. Plain colours here so V2.tsx can import this file.
import { Ionicons } from '@expo/vector-icons'
import { useState } from 'react'
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native'
import { megabytes, photoErrorText, type PickedPhoto, type ReceiptSource } from './flows/photo'
import type { PhotoInfo } from './types'
import { PhotoImage } from './PhotoImage'
import { pickReceipt, type PhotoSource } from './pickPhoto'

const C = { teal: '#0f766e', ink: '#14221c', muted: '#6b7a72', line: '#e4e8e2', card: '#ffffff', red: '#b4323f', bad: '#ffb3ba', aqua: '#2dd4bf' }

/** Take photo / Choose from library / Cancel. Picks, shrinks, and hands the JPEG back; errors come back as text. */
export function ReceiptSourceSheet({ onPicked, onError, onClose }: { onPicked: (photo: PickedPhoto) => void; onError: (text: string) => void; onClose: () => void }) {
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
      onError(photoErrorText(reason, 'That photo couldn’t be added.'))
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
export function ReceiptRow({ source, bytes, onAdd, onView, onRemove, error }: {
  source: ReceiptSource | null; bytes?: number; onAdd: () => void; onView: () => void; onRemove: () => void; error: string | null
}) {
  return (
    <View style={{ marginHorizontal: 18, marginTop: 12 }}>
      {source ? (
        <View style={r.attached} testID="receipt-attached">
          <Pressable style={r.attachedMain} onPress={onView} accessibilityRole="button" accessibilityLabel="Receipt attached. View full size" testID="receipt-view">
            <PhotoImage source={source} style={r.thumbSm} label="Receipt thumbnail" />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={r.title}>Receipt attached</Text>
              <Text style={r.sub} numberOfLines={1}>{bytes ? `${megabytes(bytes)} · ` : ''}tap to view</Text>
            </View>
          </Pressable>
          <Pressable onPress={onRemove} accessibilityRole="button" accessibilityLabel="Remove receipt" hitSlop={8} testID="receipt-remove"><Text style={r.remove}>Remove</Text></Pressable>
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
      {error && <Text style={r.error} testID="receipt-error">{error}</Text>}
    </View>
  )
}

/** The Receipt card on the expense detail. Editors with no photo see a dashed Add row; everyone else sees nothing. */
export function ReceiptCard({ youId, photo, source, canEdit, busy, error, onAdd, onView }: {
  youId?: string | null; photo: PhotoInfo | null | undefined; source: ReceiptSource | null; canEdit: boolean; busy: boolean; error: string | null; onAdd: () => void; onView: () => void
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
        {error && <Text style={r.errorLight} testID="receipt-error">{error}</Text>}
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
      {error && <Text style={r.errorLight} testID="receipt-error">{error}</Text>}
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

/** Full-screen, near-black. Replace and Remove show only when the person can edit the expense. */
export function ReceiptViewer({ source, title, subtitle, canEdit, busy, onClose, onReplace, onRemove }: {
  source: ReceiptSource; title: string; subtitle: string; canEdit: boolean; busy?: boolean; onClose: () => void; onReplace?: () => void; onRemove?: () => void
}) {
  return (
    <Modal animationType="fade" onRequestClose={onClose} visible statusBarTranslucent>
      <View style={v.screen} testID="receipt-viewer">
        <View style={v.head}>
          <Pressable style={v.close} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close receipt" testID="receipt-viewer-close"><Ionicons name="close" size={22} color="#fff" /></Pressable>
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Text style={v.title} numberOfLines={1}>{title}</Text>
            <Text style={v.sub} numberOfLines={1}>{subtitle}</Text>
          </View>
          <View style={{ width: 40 }} />
        </View>
        <View style={v.frame}><PhotoImage source={source} style={v.image} resizeMode="contain" label="Receipt photo" testID="receipt-viewer-image" /></View>
        {canEdit && (
          <View style={v.actions}>
            <Pressable style={[v.btn, busy && { opacity: 0.5 }]} disabled={busy} onPress={onReplace} accessibilityRole="button" testID="receipt-replace"><Text style={v.btnText}>Replace</Text></Pressable>
            <Pressable style={[v.btn, v.btnRed, busy && { opacity: 0.5 }]} disabled={busy} onPress={onRemove} accessibilityRole="button" testID="receipt-viewer-remove"><Text style={[v.btnText, { color: C.bad }]}>Remove</Text></Pressable>
          </View>
        )}
      </View>
    </Modal>
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
  attached: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, borderColor: '#ffffff26', backgroundColor: '#ffffff0d', borderRadius: 16, padding: 10 },
  attachedMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12, minWidth: 0 },
  thumbSm: { width: 48, height: 62, borderRadius: 8, backgroundColor: '#ffffff22' },
  remove: { color: C.bad, fontSize: 15, fontWeight: '800', paddingHorizontal: 6 },
  error: { color: C.bad, marginTop: 8, fontWeight: '600' },
  errorLight: { color: C.red, marginTop: 8, fontWeight: '600', marginHorizontal: 4 },
})
const c = StyleSheet.create({
  eyebrow: { fontSize: 12, fontWeight: '800', letterSpacing: 1.1, textTransform: 'uppercase', color: C.muted, marginBottom: 8, marginHorizontal: 4 },
  card: { flexDirection: 'row', alignItems: 'center', gap: 14, backgroundColor: C.card, borderWidth: 1, borderColor: C.line, borderRadius: 20, padding: 12 },
  thumb: { width: 76, height: 100, borderRadius: 10, backgroundColor: '#eef2ee' },
  title: { fontSize: 16, fontWeight: '800', color: C.ink },
  sub: { fontSize: 13, fontWeight: '600', color: C.muted, marginTop: 2 },
  view: { fontSize: 15, fontWeight: '800', color: C.teal, marginTop: 8 },
  add: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, minHeight: 56, borderWidth: 1.5, borderStyle: 'dashed', borderColor: '#b9d3c9', borderRadius: 20, backgroundColor: '#f3faf7' },
  addText: { fontSize: 16, fontWeight: '800', color: C.teal },
})
const v = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0b100e', paddingTop: 16 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingBottom: 12 },
  close: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#ffffff1f', alignItems: 'center', justifyContent: 'center' },
  title: { color: '#fff', fontSize: 16, fontWeight: '800' },
  sub: { color: '#9db3a9', fontSize: 12, fontWeight: '600', marginTop: 1 },
  frame: { flex: 1, margin: 8 },
  image: { flex: 1, width: '100%' },
  actions: { flexDirection: 'row', gap: 12, padding: 16, paddingBottom: 28 },
  btn: { flex: 1, minHeight: 52, borderRadius: 16, backgroundColor: '#1f2b26', alignItems: 'center', justifyContent: 'center' },
  btnRed: { backgroundColor: '#3a2a2c' },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '800' },
})
