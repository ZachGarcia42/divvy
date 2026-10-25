import { useEffect, useState } from 'react'
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native'
import * as Crypto from 'expo-crypto'
import { appleFullName, googleIds, nonceFromBytes, providerBody, providerErrorMessage, visibleButtons, type Providers } from './flows/providers'

// Native modules are loaded lazily: Expo Go has neither, and a top-level import would crash the login screen there.
type AppleModule = typeof import('expo-apple-authentication')
type GoogleModule = typeof import('@react-native-google-signin/google-signin')
const loadApple = (): AppleModule | null => {
  if (Platform.OS !== 'ios') return null
  try { return require('expo-apple-authentication') as AppleModule } catch { return null }
}
let googleConfigured = false
const loadGoogle = (): GoogleModule | null => {
  const ids = googleIds({
    // Literal reads: Expo only inlines EXPO_PUBLIC_* when accessed by name.
    EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID,
    EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID: process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID,
  }, Platform.OS)
  if (!ids) return null
  try {
    const google = require('@react-native-google-signin/google-signin') as GoogleModule
    if (!googleConfigured) { google.GoogleSignin.configure(ids); googleConfigured = true }
    return google
  } catch {
    return null
  }
}

export function SocialSignIn({ providers, next, onSignIn, onError }: {
  providers: Providers
  next: string | null
  /** Posts the provider body to /api/auth/<provider> and finishes sign-in. Throws API errors. */
  onSignIn: (provider: 'google' | 'apple', body: Record<string, unknown>) => Promise<void>
  onError: (message: string | null) => void
}) {
  const [appleAvailable, setAppleAvailable] = useState(false)
  const [busy, setBusy] = useState<'google' | 'apple' | null>(null)
  const [google] = useState(loadGoogle)
  useEffect(() => {
    const apple = loadApple()
    apple?.isAvailableAsync().then(setAppleAvailable).catch(() => setAppleAvailable(false))
  }, [])
  const shown = visibleButtons(providers, { os: Platform.OS, appleAvailable, googleConfigured: !!google })

  const run = async (provider: 'google' | 'apple', getBody: () => Promise<Record<string, unknown> | null>) => {
    setBusy(provider)
    onError(null)
    try {
      const body = await getBody()
      if (body) await onSignIn(provider, body)
    } catch (reason) {
      onError(providerErrorMessage(provider, reason))
    } finally {
      setBusy(null)
    }
  }

  const signInWithApple = () => run('apple', async () => {
    const apple = loadApple()!
    const nonce = nonceFromBytes(Crypto.getRandomBytes(32))
    const hashed = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, nonce, { encoding: Crypto.CryptoEncoding.HEX })
    const credential = await apple.signInAsync({
      requestedScopes: [apple.AppleAuthenticationScope.FULL_NAME, apple.AppleAuthenticationScope.EMAIL],
      nonce: hashed,
    })
    if (!credential.identityToken) throw Object.assign(new Error('No token'), { code: 'BAD_TOKEN' })
    return providerBody('apple', credential.identityToken, next, appleFullName(credential.fullName), { nonce, platform: Platform.OS })
  })

  const signInWithGoogle = () => run('google', async () => {
    const { GoogleSignin, isSuccessResponse } = google!
    if (Platform.OS === 'android') await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true })
    const response = await GoogleSignin.signIn()
    if (!isSuccessResponse(response)) return null // cancelled
    if (!response.data.idToken) throw Object.assign(new Error('No token'), { code: 'BAD_TOKEN' })
    // google-signin v16 has no nonce option; see providers.ts.
    return providerBody('google', response.data.idToken, next, undefined, { platform: Platform.OS })
  })

  if (!shown.apple && !shown.google) return null
  const Apple = shown.apple ? loadApple() : null
  return (
    <View style={styles.stack} testID="social-sign-in">
      {Apple && (
        <Apple.AppleAuthenticationButton
          buttonType={Apple.AppleAuthenticationButtonType.SIGN_IN}
          buttonStyle={Apple.AppleAuthenticationButtonStyle.BLACK}
          cornerRadius={12}
          style={styles.apple}
          onPress={busy ? () => undefined : signInWithApple}
        />
      )}
      {shown.google && (
        <Pressable style={[styles.google, busy && styles.disabled]} disabled={!!busy} onPress={signInWithGoogle} testID="sign-in-google"
          accessibilityRole="button" accessibilityLabel="Sign in with Google" accessibilityState={{ disabled: !!busy, busy: busy === 'google' }}>
          <Text style={styles.googleText}>{busy === 'google' ? 'Signing in…' : 'Sign in with Google'}</Text>
        </Pressable>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  stack: { gap: 10 },
  apple: { height: 48, width: '100%' },
  google: { height: 48, borderRadius: 12, borderWidth: 1, borderColor: '#c9d3cd', backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  googleText: { fontSize: 16, fontWeight: '700', color: '#14221c' },
  disabled: { opacity: 0.5 },
})
