// Expo config plugin: mark the camera as optional on Android.
// android.permission.CAMERA (added by expo-image-picker) makes Play assume android.hardware.camera is required, which
// filters out Chromebooks, cars, TVs and camera-less tablets. Declaring the features with required="false" keeps them
// eligible; the receipt sheet hides "Take photo" when no camera exists (see pickPhoto.ts).
const { withAndroidManifest } = require('expo/config-plugins')

const OPTIONAL_FEATURES = ['android.hardware.camera', 'android.hardware.camera.autofocus']

/** Pure manifest edit (exported for tests): adds or rewrites each feature as required="false". */
function addOptionalCameraFeatures(androidManifest) {
  const manifest = androidManifest.manifest
  const features = (manifest['uses-feature'] ??= [])
  for (const name of OPTIONAL_FEATURES) {
    const existing = features.find((feature) => feature.$?.['android:name'] === name)
    if (existing) existing.$['android:required'] = 'false'
    else features.push({ $: { 'android:name': name, 'android:required': 'false' } })
  }
  return androidManifest
}

const withOptionalCamera = (config) => withAndroidManifest(config, (mod) => {
  mod.modResults = addOptionalCameraFeatures(mod.modResults)
  return mod
})

module.exports = withOptionalCamera
module.exports.addOptionalCameraFeatures = addOptionalCameraFeatures
module.exports.OPTIONAL_FEATURES = OPTIONAL_FEATURES
