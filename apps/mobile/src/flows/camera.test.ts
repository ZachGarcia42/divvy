import { describe, expect, it } from 'vitest'
import { isNoCameraError, nativeHasCamera, photoErrorText, photoUiError, receiptSourceOptions, webHasCamera } from './photo'
// eslint-disable-next-line @typescript-eslint/no-require-imports
const plugin = require('../../plugins/withOptionalCamera.js') as {
  addOptionalCameraFeatures: (manifest: { manifest: Record<string, any> }) => { manifest: Record<string, any> }
  OPTIONAL_FEATURES: string[]
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const appConfig = require('../../app.config.js') as (input: { config: Record<string, any> }) => Record<string, any>

const err = (code: string) => Object.assign(new Error('x'), { code })
const features = (manifest: { manifest: Record<string, any> }) =>
  (manifest.manifest['uses-feature'] as { $: Record<string, string> }[]).map((feature) => feature.$)

describe('camera is optional on Android', () => {
  it('declares camera and autofocus with required="false"', () => {
    const out = plugin.addOptionalCameraFeatures({ manifest: { $: {} } })
    expect(features(out)).toEqual([
      { 'android:name': 'android.hardware.camera', 'android:required': 'false' },
      { 'android:name': 'android.hardware.camera.autofocus', 'android:required': 'false' },
    ])
  })

  it('rewrites an existing required camera feature instead of duplicating it', () => {
    const out = plugin.addOptionalCameraFeatures({ manifest: { 'uses-feature': [{ $: { 'android:name': 'android.hardware.camera', 'android:required': 'true' } }] } })
    expect(features(out)).toHaveLength(2)
    expect(features(out).every((feature) => feature['android:required'] === 'false')).toBe(true)
  })

  it('is wired into app.config.js', () => {
    const out = appConfig({ config: { plugins: ['expo-secure-store'] } })
    expect(out.plugins).toContain('./plugins/withOptionalCamera')
  })
})

describe('no camera on the device', () => {
  it('recognises the picker errors that mean there is no camera', () => {
    expect(isNoCameraError(err('NO_CAMERA'))).toBe(true)
    expect(isNoCameraError(err('ERR_MISSING_ACTIVITY_TO_HANDLE_INTENT'))).toBe(true)
    expect(isNoCameraError(err('ERR_CAMERA_UNAVAILABLE_ON_SIMULATOR'))).toBe(true)
    expect(isNoCameraError(err('PHOTO_PERMISSION'))).toBe(false)
    expect(isNoCameraError(null)).toBe(false)
  })

  it('points to the library when there is no camera', () => {
    expect(photoErrorText(err('NO_CAMERA'))).toMatch(/no camera.*library/i)
    expect(photoUiError(err('NO_CAMERA')).openSettings).toBe(false)
  })

  it('hides Take photo on web only when the browser lists devices and none is a camera', () => {
    expect(webHasCamera([{ kind: 'audioinput' }, { kind: 'audiooutput' }])).toBe(false)
    expect(webHasCamera([{ kind: 'audioinput' }, { kind: 'videoinput' }])).toBe(true)
    expect(webHasCamera([])).toBe(true)
    expect(webHasCamera(null)).toBe(true)
  })

  it('hides Take photo when Android reports no camera.any, leaving only library and Cancel', () => {
    const hasCamera = nativeHasCamera('android', { cameraAny: false })
    expect(hasCamera).toBe(false)
    expect(receiptSourceOptions(hasCamera).map((option) => option.label)).toEqual(['Choose from library', 'Cancel'])
  })

  it('offers Take photo, library and Cancel when Android reports a camera', () => {
    const hasCamera = nativeHasCamera('android', { cameraAny: true })
    expect(hasCamera).toBe(true)
    expect(receiptSourceOptions(hasCamera).map((option) => option.label)).toEqual(['Take photo', 'Choose from library', 'Cancel'])
  })

  it('hides Take photo on the iOS simulator, and keeps it when the feature check is missing', () => {
    expect(nativeHasCamera('ios', { isDevice: false })).toBe(false)
    expect(receiptSourceOptions(nativeHasCamera('ios', { isDevice: false })).map((option) => option.label)).toEqual(['Choose from library', 'Cancel'])
    expect(nativeHasCamera('android', null)).toBe(true)
    expect(nativeHasCamera('ios', { isDevice: true })).toBe(true)
    expect(nativeHasCamera('android', { cameraAny: false }, true)).toBe(false)
  })
})
