import { useEffect, useRef } from 'react'

// Google Identity Services: renders the official button and hands back the ID token ("credential").
// Shown only when VITE_GOOGLE_CLIENT_ID is set (the web OAuth client id, also listed in GOOGLE_CLIENT_IDS).
type Gis = {
  accounts: { id: {
    initialize: (options: { client_id: string; callback: (response: { credential?: string }) => void; ux_mode?: 'popup' }) => void
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

export function GoogleButton({ onCredential, onError }: { onCredential: (credential: string) => void; onError: (message: string) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const handler = useRef(onCredential)
  handler.current = onCredential
  useEffect(() => {
    if (!CLIENT_ID) return
    let live = true
    loadGis().then((gis) => {
      if (!live || !ref.current) return
      gis.accounts.id.initialize({ client_id: CLIENT_ID, ux_mode: 'popup', callback: (response) => { if (response.credential) handler.current(response.credential) } })
      gis.accounts.id.renderButton(ref.current, { type: 'standard', theme: 'outline', size: 'large', text: 'signin_with', shape: 'rectangular', width: 320 })
    }).catch((reason: Error) => onError(reason.message))
    return () => { live = false }
  }, [])
  if (!CLIENT_ID) return null
  return <div ref={ref} className="google-button" />
}
