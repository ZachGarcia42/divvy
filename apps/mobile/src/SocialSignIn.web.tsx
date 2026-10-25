// Web build: Sign in with Google through Google Identity Services (the rendered button), with a nonce.
// Apple on web needs a Services ID on the Apple team first, so it is not offered here.
import { useEffect, useRef, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { nonceFromBytes, providerBody, providerErrorMessage, visibleButtons, type Providers } from './flows/providers'
import { sha256Hex } from './flows/web'

const GIS_SRC = 'https://accounts.google.com/gsi/client'
// Literal read: Expo only inlines EXPO_PUBLIC_* when accessed by name.
const WEB_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID?.trim() || ''

type Gis = {
  accounts: { id: {
    initialize(options: Record<string, unknown>): void
    renderButton(parent: unknown, options: Record<string, unknown>): void
    cancel(): void
  } }
}
const browser = globalThis as unknown as {
  document: { createElement(tag: string): any; head: { appendChild(node: unknown): void }; querySelector(selector: string): any }
  crypto: { getRandomValues(bytes: Uint8Array): Uint8Array; subtle: { digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer> } }
  google?: Gis
}

let loading: Promise<Gis> | null = null
function loadGis(): Promise<Gis> {
  if (browser.google?.accounts?.id) return Promise.resolve(browser.google)
  loading ??= new Promise<Gis>((resolve, reject) => {
    const existing = browser.document.querySelector(`script[src="${GIS_SRC}"]`)
    const script = existing ?? browser.document.createElement('script')
    script.addEventListener('load', () => browser.google ? resolve(browser.google) : reject(new Error('GIS missing')))
    script.addEventListener('error', () => { loading = null; reject(Object.assign(new Error('GIS failed'), { code: 'NETWORK' })) })
    if (!existing) {
      script.src = GIS_SRC
      script.async = true
      browser.document.head.appendChild(script)
    }
  })
  return loading
}

export function SocialSignIn({ providers, next, onSignIn, onError }: {
  providers: Providers
  next: string | null
  onSignIn: (provider: 'google' | 'apple', body: Record<string, unknown>) => Promise<void>
  onError: (message: string | null) => void
}) {
  const shown = visibleButtons(providers, { os: 'web', appleAvailable: false, googleConfigured: !!WEB_CLIENT_ID })
  const host = useRef<any>(null)
  const [busy, setBusy] = useState(false)
  const [round, setRound] = useState(0)
  const latest = useRef({ next, onSignIn, onError })
  latest.current = { next, onSignIn, onError }

  useEffect(() => {
    if (!shown.google) return
    let live = true
    // A fresh nonce for every render of the button; the API takes each ID token once.
    const raw = nonceFromBytes(browser.crypto.getRandomValues(new Uint8Array(32)))
    Promise.all([loadGis(), sha256Hex(raw, browser.crypto.subtle)]).then(([gis, hashed]) => {
      if (!live || !host.current) return
      gis.accounts.id.initialize({
        client_id: WEB_CLIENT_ID,
        nonce: hashed,
        ux_mode: 'popup',
        auto_select: false,
        itp_support: true,
        use_fedcm_for_button: true,
        callback: async (response: { credential?: string }) => {
          const { next: target, onSignIn: send, onError: report } = latest.current
          if (!response.credential) return
          setBusy(true)
          report(null)
          try {
            await send('google', providerBody('google', response.credential, target, undefined, { nonce: raw, platform: 'web' }))
          } catch (reason) {
            report(providerErrorMessage('google', reason))
          } finally {
            if (live) { setBusy(false); setRound((value) => value + 1) }
          }
        },
      })
      gis.accounts.id.renderButton(host.current, { type: 'standard', theme: 'outline', size: 'large', text: 'signin_with', shape: 'rectangular', width: 320 })
    }).catch((reason) => { if (live) latest.current.onError(providerErrorMessage('google', reason)) })
    return () => { live = false; browser.google?.accounts?.id?.cancel() }
  }, [shown.google, round])

  if (!shown.google) return null
  return (
    <View style={styles.stack} testID="social-sign-in">
      <View ref={host} style={styles.google} testID="sign-in-google" accessibilityLabel="Sign in with Google" />
      {busy && <Text style={styles.busy}>Signing in…</Text>}
    </View>
  )
}

const styles = StyleSheet.create({
  stack: { gap: 10, alignItems: 'center' },
  google: { minHeight: 44, width: '100%', alignItems: 'center' },
  busy: { fontSize: 14, color: '#4b5a53' },
})
