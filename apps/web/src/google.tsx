import { useEffect, useRef } from 'react'

// Google Identity Services: renders the official button and hands back the ID token ("credential").
// Shown only when VITE_GOOGLE_CLIENT_ID is set (the web OAuth client id, also listed in GOOGLE_CLIENT_IDS).
type Gis = {
  accounts: { id: {
    initialize: (options: { client_id: string; callback: (response: { credential?: string }) => void; ux_mode?: 'popup'; nonce?: string }) => void
    renderButton: (parent: HTMLElement, options: Record<string, unknown>) => void
  } }
}
const CLIENT_ID = (import.meta as unknown as { env: Record<string, string | undefined> }).env.VITE_GOOGLE_CLIENT_ID?.trim()
let loading: Promise<Gis> | null = null
const loadGis = () => loading ??= new Promise<Gis>((resolve, reject) => {
  const existing = (window as unknown as { google?: Gis }).google
  if (existing?.accounts?.id) return resolve(existing)
  const script = document.createElement('script')
  script.src = 'https://accounts.google.com/gsi/client'
  script.async = true
  script.onload = () => resolve((window as unknown as { google: Gis }).google)
  script.onerror = () => { loading = null; reject(new Error('Couldn’t load Google sign-in')) }
  document.head.appendChild(script)
})

/** Raw nonce goes to the API; GIS gets sha256(raw) hex, which Google copies into the ID token's nonce claim. */
async function newNonce() {
  const raw = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('')
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw)))
  return { raw, hashed: Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('') }
}

export function GoogleButton({ onCredential, onError }: { onCredential: (credential: string, nonce: string) => void; onError: (message: string) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const handler = useRef(onCredential)
  handler.current = onCredential
  useEffect(() => {
    if (!CLIENT_ID) return
    let live = true
    Promise.all([loadGis(), newNonce()]).then(([gis, nonce]) => {
      if (!live || !ref.current) return
      gis.accounts.id.initialize({ client_id: CLIENT_ID, ux_mode: 'popup', nonce: nonce.hashed, callback: (response) => { if (response.credential) handler.current(response.credential, nonce.raw) } })
      gis.accounts.id.renderButton(ref.current, { type: 'standard', theme: 'outline', size: 'large', text: 'signin_with', shape: 'rectangular', width: 320 })
    }).catch((reason: Error) => onError(reason.message))
    return () => { live = false }
  }, [])
  if (!CLIENT_ID) return null
  return <div ref={ref} className="google-button" />
}
