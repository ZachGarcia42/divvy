// Extends app.json with the native sign-in plugins. The Google iOS URL scheme is the reversed iOS
// client id (com.googleusercontent.apps.<id>); set EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME, or it is
// derived from EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID.
function googleIosUrlScheme(env) {
  if (env.EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME) return env.EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME.trim()
  const id = env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID?.trim()
  if (!id) return null
  return `com.googleusercontent.apps.${id.replace(/\.apps\.googleusercontent\.com$/, '')}`
}

module.exports = ({ config }) => {
  const scheme = googleIosUrlScheme(process.env)
  return {
    ...config,
    ios: { ...config.ios, usesAppleSignIn: true },
    plugins: [
      ...(config.plugins ?? []),
      'expo-apple-authentication',
      // Without an iOS scheme the plugin still configures Android; iOS Google sign-in stays hidden.
      scheme ? ['@react-native-google-signin/google-signin', { iosUrlScheme: scheme }] : '@react-native-google-signin/google-signin',
    ],
  }
}
module.exports.googleIosUrlScheme = googleIosUrlScheme
