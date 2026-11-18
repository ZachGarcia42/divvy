// Receipt photos, the parts that need no screen: sizing, what the sheet should do on Save, the upload call, and error wording.
import type { PhotoInfo } from '../types'

/** The long edge of an uploaded receipt, in pixels. Bigger photos are scaled down; smaller ones are never scaled up. */
export const PHOTO_MAX_EDGE = 1600
export const PHOTO_JPEG_QUALITY = 0.8
/** The server refuses more than this (5 MB); checked here too so a huge file fails before it uploads. */
export const PHOTO_MAX_BYTES = 5 * 1024 * 1024

export function fitWithin(width: number, height: number, max = PHOTO_MAX_EDGE): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) return { width: max, height: max }
  const scale = Math.min(1, max / Math.max(width, height))
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

/** A photo already shrunk to JPEG on the device. `blob` is set on web (data: URLs cannot be fetched under the page's CSP). */
export type PickedPhoto = { uri: string; width: number; height: number; bytes?: number; blob?: Blob; fileName?: string }

/** What the Add/Edit sheet will do to the photo when Save is tapped. */
export type PhotoDraft = { kind: 'keep' } | { kind: 'set'; photo: PickedPhoto } | { kind: 'remove' }
export const KEEP_PHOTO: PhotoDraft = { kind: 'keep' }

/** What the sheet shows in its receipt row. */
export function shownPhoto(current: PhotoInfo | null, draft: PhotoDraft): { kind: 'none' } | { kind: 'current'; info: PhotoInfo } | { kind: 'new'; photo: PickedPhoto } {
  if (draft.kind === 'set') return { kind: 'new', photo: draft.photo }
  if (draft.kind === 'remove' || !current) return { kind: 'none' }
  return { kind: 'current', info: current }
}

/** The one call Save has to make after the expense itself is saved. */
export function photoPlan(current: PhotoInfo | null, draft: PhotoDraft): 'none' | 'upload' | 'delete' {
  if (draft.kind === 'set') return 'upload'
  if (draft.kind === 'remove' && current) return 'delete'
  return 'none'
}

/** Removing a picked-but-not-saved photo just forgets it; removing the saved one is a pending delete. */
export function removeDraft(current: PhotoInfo | null, draft: PhotoDraft): PhotoDraft {
  void draft
  return current ? { kind: 'remove' } : KEEP_PHOTO
}

export const photoDirty = (current: PhotoInfo | null, draft: PhotoDraft) => photoPlan(current, draft) !== 'none'

export const receiptPath = (groupId: string, expenseId: string) => `/api/groups/${groupId}/expenses/${expenseId}/photo`

export function megabytes(bytes: number) {
  return `${(Math.round((bytes / (1024 * 1024)) * 10) / 10).toFixed(1)} MB`
}

/** Subtitle under "Receipt attached": "Receipt photo · 0.8 MB · tap to view" (fixed title so long picker names do not clip "tap to view"). */
export function receiptAttachedLabel(opts: { fileName?: string | null; bytes?: number | null; contentType?: string | null } = {}) {
  void opts.fileName
  void opts.contentType
  const parts = ['Receipt photo']
  if (opts.bytes && opts.bytes > 0) parts.push(megabytes(opts.bytes))
  parts.push('tap to view')
  return parts.join(' · ')
}

const MESSAGES: Record<string, string> = {
  PHOTO_TOO_LARGE: 'That photo is too big (over 5 MB). Choose a smaller one.',
  PHOTO_HEIC: 'That photo format isn’t supported. Choose a JPEG or PNG.',
  PHOTO_TYPE: 'Only JPEG, PNG and WebP photos can be added.',
  PHOTO_EMPTY: 'That photo is empty. Choose another.',
  NETWORK: 'Couldn’t reach Divvy. Check your connection and try again.',
  PHOTO_PERMISSION: 'Allow camera access in Settings to take a photo.',
  PHOTO_UNREADABLE: 'That photo couldn’t be read. Try a JPEG or PNG.',
  NO_CAMERA: 'This device has no camera. Choose a photo from your library instead.',
}

/**
 * Errors that mean "there is no camera here": expo-image-picker on Android throws MissingActivityToHandleIntent when no app
 * handles the capture intent (camera-less Chromebooks, cars, tablets); iOS throws on the simulator.
 */
export function isNoCameraError(reason: unknown) {
  const code = (reason as { code?: string } | null)?.code
  return code === 'NO_CAMERA' || code === 'ERR_MISSING_ACTIVITY_TO_HANDLE_INTENT' || code === 'ERR_CAMERA_UNAVAILABLE_ON_SIMULATOR'
}

/**
 * Web: does the browser report a camera? Only a non-empty device list with no videoinput counts as "no camera"; an empty
 * or unreadable list (some browsers hide devices before permission) keeps "Take photo" so phones never lose it.
 */
export function webHasCamera(devices: ReadonlyArray<{ kind?: string }> | null | undefined) {
  if (!devices || devices.length === 0) return true
  return devices.some((device) => device.kind === 'videoinput')
}

/** Android feature that means "this device has some kind of camera" (rear, front, or external). */
export const ANDROID_CAMERA_ANY = 'android.hardware.camera.any'

/**
 * Native "is there a camera?", from the OS feature check. Android uses hasPlatformFeature(camera.any);
 * iOS uses expo-device isDevice (the simulator has no camera). A missing or failed check keeps Take photo,
 * matching cameraAvailable(). knownNoCamera is the session flag set after a capture attempt proves there is none.
 */
export function nativeHasCamera(
  os: string,
  check: { cameraAny?: boolean; isDevice?: boolean } | null | undefined,
  knownNoCamera = false,
) {
  if (knownNoCamera) return false
  if (!check) return true
  if (os === 'android') return check.cameraAny !== false
  if (os === 'ios') return check.isDevice !== false
  return true
}

export type ReceiptSourceOption = { source: 'camera' | 'library' | 'cancel'; label: string }

/**
 * Options on the Add receipt photo sheet, in order. Library and Cancel are always offered;
 * Take photo only when the device has a camera.
 */
export function receiptSourceOptions(hasCamera: boolean): ReceiptSourceOption[] {
  return [
    ...(hasCamera ? [{ source: 'camera' as const, label: 'Take photo' }] : []),
    { source: 'library', label: 'Choose from library' },
    { source: 'cancel', label: 'Cancel' },
  ]
}

export function photoErrorText(reason: unknown, fallback = 'Couldn’t save the photo. Try again.') {
  const code = (reason as { code?: string } | null)?.code
  if (code && MESSAGES[code]) return MESSAGES[code]
  const message = reason instanceof Error ? reason.message : ''
  return message && message !== 'Request failed' ? message : fallback
}

/** UI error for receipt flows. openSettings is set when the camera was denied forever. */
export type PhotoUiError = { text: string; openSettings?: boolean }

export function photoUiError(reason: unknown, fallback?: string): PhotoUiError {
  return {
    text: photoErrorText(reason, fallback),
    openSettings: !!(reason as { openSettings?: boolean } | null)?.openSettings,
  }
}

/** "Receipt · Oct 27" style helper for the viewer header. */
export const receiptSubtitle = (dateText: string) => `Receipt · ${dateText}`

type FetchLike = typeof fetch
export type PhotoApi = { base: string; token: string | null; platform: string; fetchImpl?: FetchLike }

const headersOf = (api: PhotoApi, extra: Record<string, string> = {}) => ({
  ...(api.token ? { authorization: `Bearer ${api.token}` } : {}),
  'x-divvy-platform': api.platform,
  ...extra,
})

async function failure(response: Response) {
  const body = await response.json().catch(() => ({})) as { error?: { code?: string; message?: string } }
  return Object.assign(new Error(body.error?.message ?? 'Request failed'), { code: body.error?.code ?? `HTTP_${response.status}`, status: response.status })
}

async function bodyOf(photo: PickedPhoto, fetchImpl: FetchLike): Promise<Blob> {
  if (photo.blob) return photo.blob
  const local = await fetchImpl(photo.uri)
  return local.blob()
}

/** Sends the photo as raw bytes (PUT, no JSON wrapper). Throws an Error with .code on failure. */
export async function uploadReceipt(api: PhotoApi, groupId: string, expenseId: string, photo: PickedPhoto): Promise<PhotoInfo> {
  const doFetch = api.fetchImpl ?? fetch
  const body = await bodyOf(photo, doFetch)
  if (body.size > PHOTO_MAX_BYTES) throw Object.assign(new Error(MESSAGES.PHOTO_TOO_LARGE), { code: 'PHOTO_TOO_LARGE' })
  let response: Response
  try {
    response = await doFetch(`${api.base}${receiptPath(groupId, expenseId)}`, { method: 'PUT', headers: headersOf(api, { 'content-type': 'image/jpeg' }), body })
  } catch {
    throw Object.assign(new Error(MESSAGES.NETWORK), { code: 'NETWORK' })
  }
  if (!response.ok) throw await failure(response)
  return ((await response.json()) as { photo: PhotoInfo }).photo
}

export async function deleteReceipt(api: PhotoApi, groupId: string, expenseId: string): Promise<void> {
  const doFetch = api.fetchImpl ?? fetch
  let response: Response
  try {
    response = await doFetch(`${api.base}${receiptPath(groupId, expenseId)}`, { method: 'DELETE', headers: headersOf(api) })
  } catch {
    throw Object.assign(new Error(MESSAGES.NETWORK), { code: 'NETWORK' })
  }
  if (!response.ok) throw await failure(response)
}

/** Where the picture comes from, and the headers it needs (the server serves photos only to signed-in members). */
export type ReceiptSource = { kind: 'remote'; url: string; headers: Record<string, string>; key: string } | { kind: 'local'; uri: string }

export function remoteSource(api: PhotoApi, groupId: string, expenseId: string, info: PhotoInfo): ReceiptSource {
  return { kind: 'remote', url: `${api.base}${receiptPath(groupId, expenseId)}?v=${info.id}`, headers: headersOf(api), key: info.id }
}

/** One toast for the save-then-photo sequence. */
export function savedWithPhotoProblem(editing: boolean, reason: unknown) {
  return `${editing ? 'Expense updated' : 'Expense added'}, but the photo didn’t save. ${photoErrorText(reason, 'Open the expense to try again.')}`
}
