// Native receipt picker: camera or library, then shrink to a JPEG (long edge 1600px). Re-encoding also turns iPhone HEIC into
// JPEG and drops the location tags in the photo's metadata. The web version lives in pickPhoto.web.ts.
import * as ImageManipulator from 'expo-image-manipulator'
import * as ImagePicker from 'expo-image-picker'
import { fitWithin, PHOTO_JPEG_QUALITY, type PickedPhoto } from './flows/photo'

export type PhotoSource = 'camera' | 'library'

/** null when the person cancels. Throws an Error with .code (PHOTO_PERMISSION, PHOTO_UNREADABLE) when it cannot continue. */
export async function pickReceipt(source: PhotoSource): Promise<PickedPhoto | null> {
  if (source === 'camera') {
    const allowed = await ImagePicker.requestCameraPermissionsAsync()
    if (!allowed.granted) throw Object.assign(new Error('Allow camera access in Settings to take a photo.'), { code: 'PHOTO_PERMISSION' })
  }
  const options: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], quality: 1, allowsEditing: false, exif: false }
  const result = source === 'camera' ? await ImagePicker.launchCameraAsync(options) : await ImagePicker.launchImageLibraryAsync(options)
  if (result.canceled || !result.assets[0]) return null
  const asset = result.assets[0]
  try {
    const size = fitWithin(asset.width, asset.height)
    const scaled = size.width !== asset.width || size.height !== asset.height
    const out = await ImageManipulator.manipulateAsync(asset.uri, scaled ? [{ resize: size }] : [], { compress: PHOTO_JPEG_QUALITY, format: ImageManipulator.SaveFormat.JPEG })
    return { uri: out.uri, width: out.width, height: out.height }
  } catch {
    throw Object.assign(new Error('That photo couldn’t be read. Try a JPEG or PNG.'), { code: 'PHOTO_UNREADABLE' })
  }
}
