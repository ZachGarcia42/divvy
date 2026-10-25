// Serves the Expo web export (WEB_DIST) for non-/api GETs, with an SPA fallback to index.html.
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'

/** The web app's CSP: its own bundle plus Google Identity Services (script, button iframe, FedCM/fetches). */
export const APP_CSP = [
  "default-src 'self'",
  "script-src 'self' https://accounts.google.com/gsi/client",
  "style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "connect-src 'self' https://accounts.google.com/gsi/",
  "frame-src https://accounts.google.com/gsi/",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ')

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.webp': 'image/webp', '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
}
// Expo puts content-hashed bundles and assets here; they never change under the same name.
const HASHED = /^\/(?:_expo\/static\/|assets\/)/

const isFile = async (path: string) => { try { return (await stat(path)).isFile() } catch { return false } }

export type WebResponse = { status: number; body: Uint8Array; headers: Record<string, string> } | null

/** null means "not ours" (no dist configured, or an /api path): let the caller 404 as before. */
export function createWebDist(dir: string | null | undefined) {
  const root = dir?.trim() ? resolve(dir.trim()) : null
  const indexHtml = async (): Promise<WebResponse> => {
    if (!root) return null
    const file = join(root, 'index.html')
    if (!(await isFile(file))) return null
    return { status: 200, body: await readFile(file), headers: htmlHeaders() }
  }
  const serve = async (pathname: string): Promise<WebResponse> => {
    if (!root || pathname === '/api' || pathname.startsWith('/api/')) return null
    let decoded: string
    try { decoded = decodeURIComponent(pathname) } catch { return notFound() }
    if (decoded.includes('\0') || decoded.includes('\\')) return notFound()
    const file = normalize(join(root, decoded))
    if (file !== root && !file.startsWith(root + sep)) return notFound()
    const ext = extname(decoded).toLowerCase()
    if (decoded !== '/' && !decoded.endsWith('/') && await isFile(file)) {
      if (ext === '.html') return { status: 200, body: await readFile(file), headers: htmlHeaders() }
      return {
        status: 200,
        body: await readFile(file),
        headers: {
          'content-type': TYPES[ext] ?? 'application/octet-stream',
          'cache-control': HASHED.test(decoded) ? 'public, max-age=31536000, immutable' : 'no-cache',
        },
      }
    }
    // A missing file with an extension (or anything under the hashed dirs) is a real 404, not the app shell.
    if (ext || HASHED.test(decoded)) return notFound()
    return indexHtml()
  }
  return { enabled: !!root, serve, indexHtml }
}

function htmlHeaders() {
  return {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-cache',
    'content-security-policy': APP_CSP,
    // Google Identity Services needs the origin in the referrer and a popup it can talk back to.
    'referrer-policy': 'strict-origin-when-cross-origin',
    'cross-origin-opener-policy': 'same-origin-allow-popups',
  }
}
const notFound = (): WebResponse => ({ status: 404, body: new TextEncoder().encode('Not found'), headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache' } })
