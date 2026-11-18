// Native receipt picker: camera or library, then shrink to a JPEG (long edge 1600px). Re-encoding also turns iPhone HEIC into
// JPEG and drops the location tags in the photo's metadata. The web version lives in pickPhoto.web.ts.
import * as ImageManipulator from 'expo-image-manipulator'
import * as ImagePicker from 'expo-image-picker'
import { Platform } from 'react-native'
import { fitWithin, isNoCameraError, PHOTO_JPEG_QUALITY, type PickedPhoto } from './flows/photo'

export type PhotoSource = 'camera' | 'library'

const noCamera = () => Object.assign(new Error('This device has no camera.'), { code: 'NO_CAMERA' })
// Set once a capture attempt proves there is no camera, so the sheet stops offering it for the rest of the session.
let knownNoCamera = false

/** Whether "Take photo" can work here. Android asks the OS for any camera; iOS has one on every real device. */
export async function cameraAvailable(): Promise<boolean> {
  if (knownNoCamera) return false
  try {
    // Lazy require: Expo Go and older dev clients may not have expo-device; then assume a camera, as before.
    const Device = require('expo-device') as typeof import('expo-device')
    if (Platform.OS === 'android') return await Device.hasPlatformFeatureAsync('android.hardware.camera.any')
    if (Platform.OS === 'ios') return Device.isDevice
  } catch { /* unknown: keep the option */ }
  return true
}

/** null when the person cancels. Throws an Error with .code (NO_CAMERA, PHOTO_PERMISSION, PHOTO_UNREADABLE) when it cannot continue. */
export async function pickReceipt(source: PhotoSource): Promise<PickedPhoto | null> {
  if (source === 'camera') {
    if (!(await cameraAvailable())) throw noCamera()
    const allowed = await ImagePicker.requestCameraPermissionsAsync()
    if (!allowed.granted) {
      // canAskAgain:false means the OS will not show the dialog again; offer Open Settings in the UI.
      throw Object.assign(new Error('Allow camera access in Settings to take a photo.'), {
        code: 'PHOTO_PERMISSION',
        openSettings: allowed.canAskAgain === false,
      })
    }
  }
  const options: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], quality: 1, allowsEditing: false, exif: false }
  let result: ImagePicker.ImagePickerResult
  try {
    result = source === 'camera' ? await ImagePicker.launchCameraAsync(options) : await ImagePicker.launchImageLibraryAsync(options)
  } catch (reason) {
    if (source === 'camera' && isNoCameraError(reason)) { knownNoCamera = true; throw noCamera() }
    throw reason
  }
  if (result.canceled || !result.assets[0]) return null
  const asset = result.assets[0]
  try {
    const size = fitWithin(asset.width, asset.height)
    const scaled = size.width !== asset.width || size.height !== asset.height
    const out = await ImageManipulator.manipulateAsync(asset.uri, scaled ? [{ resize: size }] : [], { compress: PHOTO_JPEG_QUALITY, format: ImageManipulator.SaveFormat.JPEG })
    let bytes = asset.fileSize ?? undefined
    try {
      const blob = await (await fetch(out.uri)).blob()
      bytes = blob.size
    } catch { /* keep fileSize if the local fetch fails */ }
    const rawName = asset.fileName?.trim()
    const fileName = rawName ? rawName.replace(/\.[^.]+$/, '.jpg') : 'receipt.jpg'
    return { uri: out.uri, width: out.width, height: out.height, bytes, fileName }
  } catch {
    throw Object.assign(new Error('That photo couldn’t be read. Try a JPEG or PNG.'), { code: 'PHOTO_UNREADABLE' })
  }
}
