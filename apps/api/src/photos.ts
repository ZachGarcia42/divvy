// Receipt photos: format sniffing by magic bytes and a small on-disk store. No image library, no public URLs:
// files live under the data directory with random names and are only ever served through an authenticated route.
import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LedgerError } from '@divvy/domain'

/** Largest upload accepted (bytes). The client resizes to about 1600px JPEG, which is far below this. */
export const PHOTO_MAX_BYTES = 5 * 1024 * 1024

export type PhotoType = 'image/jpeg' | 'image/png' | 'image/webp'

const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1'])

const ascii = (bytes: Uint8Array, from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to))

/** What the bytes really are, whatever the client claimed. 'heic' is recognised only so it can be refused with a clear message. */
export function sniffImage(bytes: Uint8Array): PhotoType | 'heic' | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(bytes, 1, 4) === 'PNG' && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'image/png'
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'image/webp'
  if (bytes.length >= 12 && ascii(bytes, 4, 8) === 'ftyp' && HEIC_BRANDS.has(ascii(bytes, 8, 12))) return 'heic'
  return null
}

/**
 * Validates an upload and returns its type. Throws LedgerError: PHOTO_EMPTY, PHOTO_TOO_LARGE, PHOTO_HEIC, PHOTO_TYPE.
 * HEIC is refused (not converted): the apps always send a JPEG, and converting needs a native decoder on the server.
 */
export function checkPhoto(bytes: Uint8Array): PhotoType {
  if (bytes.length === 0) throw new LedgerError('PHOTO_EMPTY', 'That photo is empty')
  if (bytes.length > PHOTO_MAX_BYTES) throw new LedgerError('PHOTO_TOO_LARGE', 'That photo is over 5 MB. Choose a smaller one.')
  const kind = sniffImage(bytes)
  if (kind === 'heic') throw new LedgerError('PHOTO_HEIC', 'HEIC photos aren’t supported yet. Use a JPEG, PNG or WebP (on iPhone, Settings › Camera › Formats › Most Compatible).')
  if (!kind) throw new LedgerError('PHOTO_TYPE', 'Only JPEG, PNG and WebP photos can be added')
  return kind
}

const PHOTO_ID = /^[a-f0-9]{32}$/
export const newPhotoId = () => randomBytes(16).toString('hex')

/** The default folder: <data>/photos, next to the database (so the existing data backups include it). PHOTO_DIR overrides. */
export function defaultPhotoDir(env: Record<string, string | undefined> = process.env) {
  const fromEnv = env.PHOTO_DIR?.trim()
  if (fromEnv) return resolve(fromEnv)
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../../data/photos')
}

export type PhotoStore = {
  readonly dir: string
  put(id: string, bytes: Uint8Array): Promise<void>
  get(id: string): Promise<Uint8Array | null>
  remove(id: string): Promise<void>
}

/** Files named by random id only, written atomically (temp file then rename). Ids that are not 32 hex chars are never touched. */
export function createPhotoStore(dir: string): PhotoStore {
  const root = resolve(dir)
  const path = (id: string) => {
    if (!PHOTO_ID.test(id)) throw new Error('bad photo id')
    return join(root, id)
  }
  return {
    dir: root,
    async put(id, bytes) {
      const target = path(id)
      mkdirSync(root, { recursive: true, mode: 0o700 })
      const temp = `${target}.${randomBytes(4).toString('hex')}.tmp`
      await writeFile(temp, bytes, { mode: 0o600 })
      await rename(temp, target)
    },
    async get(id) {
      try { return await readFile(path(id)) } catch { return null }
    },
    async remove(id) {
      await rm(path(id), { force: true })
    },
  }
}
