// Web: an <img> cannot send the Authorization header, so a saved photo is fetched with it and shown as a data: URL
// (allowed by the page's CSP; nothing public, no blob: needed). A just-picked photo is already a data: URL.
import { useEffect, useState } from 'react'
import { Image, type ImageStyle, type StyleProp } from 'react-native'
import type { ReceiptSource } from './flows/photo'

const cache = new Map<string, string>()
/** Keyed by who is signed in as well, so a cached picture is never handed to a different account. */
const cacheKey = (source: Extract<ReceiptSource, { kind: 'remote' }>) => `${source.headers.authorization ?? ''}|${source.key}`

function toDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new (globalThis as any).FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('read'))
    reader.readAsDataURL(blob)
  })
}

export function PhotoImage({ source, style, resizeMode = 'cover', testID, label }: {
  source: ReceiptSource; style?: StyleProp<ImageStyle>; resizeMode?: 'cover' | 'contain'; testID?: string; label: string
}) {
  const key = source.kind === 'remote' ? source.key : null
  const [loaded, setLoaded] = useState<string | null>(source.kind === 'remote' ? cache.get(cacheKey(source)) ?? null : null)
  useEffect(() => {
    if (source.kind !== 'remote') return
    const hit = cache.get(cacheKey(source))
    if (hit) { setLoaded(hit); return }
    let cancelled = false
    setLoaded(null)
    fetch(source.url, { headers: source.headers })
      .then((res) => (res.ok ? res.blob() : Promise.reject(new Error('photo'))))
      .then(toDataUrl)
      .then((url) => { cache.set(cacheKey(source), url); if (!cancelled) setLoaded(url) })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [key])
  const uri = source.kind === 'local' ? source.uri : loaded
  if (!uri) return <Image source={{ uri: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' }} style={style} accessibilityLabel={label} testID={testID} />
  return <Image source={{ uri }} style={style} resizeMode={resizeMode} accessibilityLabel={label} testID={testID} />
}
