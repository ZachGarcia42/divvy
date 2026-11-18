// Web build: Sign in with Apple (Apple JS popup) and Sign in with Google (Google Identity Services button), each with a
// nonce: the provider gets sha256(raw) as hex and POST /api/auth/<provider> gets raw with platform 'web'.
import { Ionicons } from '@expo/vector-icons'
import { useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { appleWebConfig, appleWebError, appleWebName, nonceFromBytes, providerBody, providerErrorMessage, visibleButtons, type Providers } from './flows/providers'
import { sha256Hex, SIGN_IN_WIDTH } from './flows/web'

const GIS_SRC = 'https://accounts.google.com/gsi/client'
const APPLE_SRC = 'https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js'
// Literal reads: Expo only inlines EXPO_PUBLIC_* when accessed by name.
const WEB_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID?.trim() || ''
const APPLE_WEB = appleWebConfig({
  EXPO_PUBLIC_APPLE_WEB_SERVICES_ID: process.env.EXPO_PUBLIC_APPLE_WEB_SERVICES_ID,
  EXPO_PUBLIC_APPLE_WEB_REDIRECT_URI: process.env.EXPO_PUBLIC_APPLE_WEB_REDIRECT_URI,
})

type Gis = {
  accounts: { id: {
    initialize(options: Record<string, unknown>): void
    renderButton(parent: unknown, options: Record<string, unknown>): void
    cancel(): void
  } }
}
type AppleSignInResponse = { authorization?: { id_token?: string }; user?: { name?: { firstName?: string; lastName?: string } } }
type AppleJs = { auth: { init(options: Record<string, unknown>): void; signIn(): Promise<AppleSignInResponse> } }
const browser = globalThis as unknown as {
  document: { createElement(tag: string): any; head: { appendChild(node: unknown): void }; querySelector(selector: string): any }
  crypto: { getRandomValues(bytes: Uint8Array): Uint8Array; subtle: { digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer> } }
  google?: Gis
  AppleID?: AppleJs
}

const loading = new Map<string, Promise<void>>()
/** Adds the script tag once; resolves when it has loaded. */
function loadScript(src: string): Promise<void> {
  let pending = loading.get(src)
  if (!pending) {
    pending = new Promise<void>((resolve, reject) => {
      const existing = browser.document.querySelector(`script[src="${src}"]`)
      const script = existing ?? browser.document.createElement('script')
      script.addEventListener('load', () => resolve())
      script.addEventListener('error', () => { loading.delete(src); reject(Object.assign(new Error('Script failed'), { code: 'NETWORK' })) })
      if (!existing) {
        script.src = src
        script.async = true
        browser.document.head.appendChild(script)
      }
    })
    loading.set(src, pending)
  }
  return pending
}
async function loadGis(): Promise<Gis> {
  if (!browser.google?.accounts?.id) await loadScript(GIS_SRC)
  if (!browser.google) throw new Error('GIS missing')
  return browser.google
}
async function loadAppleJs(): Promise<AppleJs> {
  if (!browser.AppleID?.auth) await loadScript(APPLE_SRC)
  if (!browser.AppleID?.auth) throw new Error('Apple JS missing')
  return browser.AppleID
}
const freshNonce = async () => {
  const raw = nonceFromBytes(browser.crypto.getRandomValues(new Uint8Array(32)))
  return { raw, hashed: await sha256Hex(raw, browser.crypto.subtle) }
}

export function SocialSignIn({ providers, next, onSignIn, onError }: {
  providers: Providers
  next: string | null
  onSignIn: (provider: 'google' | 'apple', body: Record<string, unknown>) => Promise<void>
  onError: (message: string | null) => void
}) {
  const shown = visibleButtons(providers, { os: 'web', appleAvailable: !!APPLE_WEB, googleConfigured: !!WEB_CLIENT_ID })
  const host = useRef<any>(null)
  const [busy, setBusy] = useState<'google' | 'apple' | null>(null)
  const [round, setRound] = useState(0)
  const latest = useRef({ next, onSignIn, onError })
  latest.current = { next, onSignIn, onError }

  // Apple: init ahead of the tap with a fresh nonce, so the click calls signIn() synchronously and the popup isn't blocked.
  const apple = useRef<{ js: AppleJs; raw: string } | null>(null)
  const [appleRound, setAppleRound] = useState(0)
  useEffect(() => {
    if (!shown.apple || !APPLE_WEB) return
    let live = true
    apple.current = null
    Promise.all([loadAppleJs(), freshNonce()]).then(([js, { raw, hashed }]) => {
      if (!live) return
      js.auth.init({ clientId: APPLE_WEB.clientId, scope: 'name email', redirectURI: APPLE_WEB.redirectURI, usePopup: true, nonce: hashed })
      apple.current = { js, raw }
    }).catch((reason) => { if (live) latest.current.onError(providerErrorMessage('apple', reason)) })
    return () => { live = false }
  }, [shown.apple, appleRound])

  const signInWithApple = () => {
    const ready = apple.current
    if (busy || !ready) return
    apple.current = null // each nonce is used once
    const pending = ready.js.auth.signIn()
    const { next: target, onSignIn: send, onError: report } = latest.current
    setBusy('apple')
    report(null)
    void (async () => {
      try {
        const response = await pending.catch((reason) => { throw appleWebError(reason) })
        const token = response?.authorization?.id_token
        if (!token) throw Object.assign(new Error('No token'), { code: 'BAD_TOKEN' })
        await send('apple', providerBody('apple', token, target, appleWebName(response.user), { nonce: ready.raw, platform: 'web' }))
      } catch (reason) {
        report(providerErrorMessage('apple', reason))
      } finally {
        setBusy(null)
        setAppleRound((value) => value + 1)
      }
    })()
  }

  useEffect(() => {
    if (!shown.google) return
    let live = true
    // A fresh nonce for every render of the button; the API takes each ID token once.
    Promise.all([loadGis(), freshNonce()]).then(([gis, { raw, hashed }]) => {
      if (!live || !host.current) return
      gis.accounts.id.initialize({
        client_id: WEB_CLIENT_ID,
        // GIS has only a top-level nonce option; GIS itself builds the FedCM navigator.credentials.get call, so
        // Chrome's "nonce should be in params" console warning comes from Google's library, not this code.
        nonce: hashed,
        ux_mode: 'popup',
        auto_select: false,
        itp_support: true,
        // Button only (no One Tap prompt is ever shown, so use_fedcm_for_prompt is irrelevant and left unset).
        use_fedcm_for_button: true,
        callback: async (response: { credential?: string }) => {
          const { next: target, onSignIn: send, onError: report } = latest.current
          if (!response.credential) return
          setBusy('google')
          report(null)
          try {
            await send('google', providerBody('google', response.credential, target, undefined, { nonce: raw, platform: 'web' }))
          } catch (reason) {
            report(providerErrorMessage('google', reason))
          } finally {
            if (live) { setBusy(null); setRound((value) => value + 1) }
          }
        },
      })
      gis.accounts.id.renderButton(host.current, { type: 'standard', theme: 'outline', size: 'large', text: 'signin_with', shape: 'rectangular', width: Math.max(200, Math.min(SIGN_IN_WIDTH, Math.floor((host.current as unknown as { getBoundingClientRect?: () => { width: number } }).getBoundingClientRect?.().width || SIGN_IN_WIDTH))) })
    }).catch((reason) => { if (live) latest.current.onError(providerErrorMessage('google', reason)) })
    return () => { live = false; browser.google?.accounts?.id?.cancel() }
  }, [shown.google, round])

  if (!shown.google && !shown.apple) return null
  return (
    <View style={styles.stack} testID="social-sign-in">
      {shown.apple && (
        <Pressable style={[styles.apple, !!busy && styles.disabled]} disabled={!!busy} onPress={signInWithApple} testID="sign-in-apple"
          accessibilityRole="button" accessibilityLabel="Sign in with Apple" accessibilityState={{ disabled: !!busy, busy: busy === 'apple' }}>
          <Ionicons name="logo-apple" size={20} color="#fff" />
          <Text style={styles.appleText}>{busy === 'apple' ? 'Signing in…' : 'Sign in with Apple'}</Text>
        </Pressable>
      )}
      {shown.google && <View ref={host} style={styles.google} testID="sign-in-google" accessibilityLabel="Sign in with Google" />}
      {busy === 'google' && <Text style={styles.busy}>Signing in…</Text>}
    </View>
  )
}

const styles = StyleSheet.create({
  stack: { gap: 10, alignItems: 'center' },
  apple: { minHeight: 44, height: 44, width: '100%', maxWidth: SIGN_IN_WIDTH, alignSelf: 'center', flexDirection: 'row', gap: 8, borderRadius: 4, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' },
  appleText: { fontSize: 16, fontWeight: '600', color: '#fff' },
  disabled: { opacity: 0.5 },
  google: { minHeight: 44, width: '100%', maxWidth: SIGN_IN_WIDTH, alignSelf: 'center', alignItems: 'center' },
  busy: { fontSize: 14, color: '#4b5a53' },
})
