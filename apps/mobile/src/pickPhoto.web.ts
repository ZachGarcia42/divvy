// Web receipt picker: a file input (the camera on phones when asked), then the same shrink-to-JPEG step on a canvas.
// The result is a data: URL for display (the page's CSP allows data: images, not blob:) plus the Blob to upload.
import { fitWithin, PHOTO_JPEG_QUALITY, webHasCamera, type PickedPhoto } from './flows/photo'

export type PhotoSource = 'camera' | 'library'

/** Hides "Take photo" only when the browser lists devices and none is a camera (e.g. a desktop with no webcam). */
export async function cameraAvailable(): Promise<boolean> {
  const media = (globalThis as any).navigator?.mediaDevices
  if (!media?.enumerateDevices) return true
  try { return webHasCamera(await media.enumerateDevices()) } catch { return true }
}

const unreadable = () => Object.assign(new Error('That photo couldn’t be read here. Try a JPEG or PNG.'), { code: 'PHOTO_UNREADABLE' })

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const FileReaderCtor = (globalThis as any).FileReader
    const reader = new FileReaderCtor()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(unreadable())
    reader.readAsDataURL(blob)
  })
}

/** Shrinks any browser-decodable image file to a JPEG, long edge 1600px, on a white background. */
export async function shrinkToJpeg(file: Blob): Promise<PickedPhoto> {
  const g = globalThis as any
  let bitmap: any
  try { bitmap = await g.createImageBitmap(file) } catch { throw unreadable() }
  const size = fitWithin(bitmap.width, bitmap.height)
  const canvas = g.document.createElement('canvas')
  canvas.width = size.width
  canvas.height = size.height
  const context = canvas.getContext('2d')
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, size.width, size.height)
  context.drawImage(bitmap, 0, 0, size.width, size.height)
  bitmap.close?.()
  const blob: Blob | null = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', PHOTO_JPEG_QUALITY))
  if (!blob) throw unreadable()
  return { uri: await readAsDataUrl(blob), width: size.width, height: size.height, bytes: blob.size, blob, fileName: 'receipt.jpg' }
}

/** Must be called straight from a tap, or the browser will not open the file dialog. null when the dialog is cancelled. */
export function pickReceipt(source: PhotoSource): Promise<PickedPhoto | null> {
  return new Promise((resolve, reject) => {
    const g = globalThis as any
    const input = g.document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    if (source === 'camera') input.setAttribute('capture', 'environment')
    input.onchange = () => {
      const file = input.files?.[0]
      if (!file) return resolve(null)
      shrinkToJpeg(file).then((photo) => {
        const raw = (file.name || '').trim()
        const fileName = raw ? raw.replace(/\.[^.]+$/, '.jpg') : 'receipt.jpg'
        resolve({ ...photo, fileName })
      }, reject)
    }
    input.oncancel = () => resolve(null)
    input.click()
  })
}
