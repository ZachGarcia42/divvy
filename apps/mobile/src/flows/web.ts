// Web-only helpers kept pure so they can be unit-tested without a browser.

/** The landing pages link into the web app under /app/...; map that back to the paths parseDeepLink knows. */
export function webLinkUrl(href: string | null | undefined) {
  if (!href) return null
  const match = href.match(/^(https?:\/\/[^/]+)\/app(\/(?:login|invite)\b.*)$/i)
  return match ? `${match[1]}${match[2]}` : href
}

/** Same origin on web (the API serves the app); a native build keeps EXPO_PUBLIC_API_URL. */
export function apiBase(os: string, env: { api?: string; webApi?: string }) {
  if (os === 'web') return (env.webApi ?? '').replace(/\/+$/, '')
  return env.api ?? 'http://localhost:8787'
}

/** sha256 hex of the raw nonce: Google gets this, the API gets the raw value. */
export async function sha256Hex(value: string, subtle: { digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer> }) {
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
