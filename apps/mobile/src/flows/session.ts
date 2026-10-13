// Session persistence with the storage injected (expo-secure-store in the app, a Map in tests).
import { isUnauthenticated } from './errors'

export const SESSION_KEY = 'divvy.session'

export type KeyStore = {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  remove(key: string): Promise<void>
}

export async function loadSession(store: KeyStore) {
  try {
    const token = await store.get(SESSION_KEY)
    if (!token) return null
    if (/^[A-Za-z0-9_-]{16,256}$/.test(token)) return token
    // Malformed: delete it so it isn't read again on every launch.
    await store.remove(SESSION_KEY).catch(() => undefined)
    return null
  } catch {
    return null
  }
}

/** A 401 on an authenticated request that isn't a dead-link BAD_TOKEN means the session is gone. */
export function isSessionExpiry(reason: unknown, authenticated: boolean) {
  return authenticated && isUnauthenticated(reason)
}

/**
 * One app-wide hook for "the session expired": every authenticated call reports here, and the app
 * clears secure storage and returns to sign-in (keeping any pending invite).
 */
export function createSessionExpiry() {
  let handler: (() => void) | null = null
  return {
    set(next: (() => void) | null) { handler = next },
    report(reason: unknown, authenticated: boolean) {
      if (isSessionExpiry(reason, authenticated)) handler?.()
    },
  }
}

export async function saveSession(store: KeyStore, token: string | null) {
  try {
    if (token) await store.set(SESSION_KEY, token)
    else await store.remove(SESSION_KEY)
  } catch {
    // Storage failure only costs a re-sign-in next launch.
  }
}

/**
 * Checks a stored session with GET /api/me. A 401 (or a null "me") clears it; a network error keeps it,
 * so a tester who opens the app offline isn't signed out.
 */
export async function checkStoredSession<T>(store: KeyStore, token: string, me: () => Promise<T | null>): Promise<{ ok: true; me: T } | { ok: false; reason: 'signed-out' | 'offline' }> {
  try {
    const found = await me()
    if (!found) {
      await saveSession(store, null)
      return { ok: false, reason: 'signed-out' }
    }
    return { ok: true, me: found }
  } catch (reason) {
    if (isUnauthenticated(reason)) {
      await saveSession(store, null)
      return { ok: false, reason: 'signed-out' }
    }
    return { ok: false, reason: 'offline' }
  }
}
