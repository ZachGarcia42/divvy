// Pure deep-link parsing so it can be unit-tested without React Native.
// Handles divvy://login?token=..., divvy://invite/<token>, and the same paths on the web origin.

export type DeepLink =
  | { kind: 'login'; token: string; next: string | null }
  | { kind: 'invite'; token: string }

export const PENDING_INVITE_KEY = 'divvy.pendingInvite'

function param(query: string, name: string) {
  for (const part of query.split('&')) {
    const [key, value = ''] = part.split('=')
    if (key === name) {
      try {
        return decodeURIComponent(value.replace(/\+/g, ' '))
      } catch {
        return null
      }
    }
  }
  return null
}

export function parseDeepLink(url: string | null | undefined): DeepLink | null {
  if (!url) return null
  const trimmed = url.trim()
  // divvy://login?token=... has "login" as the host; https://host/login?token=... has it as the path.
  const login = trimmed.match(/^(?:divvy:\/\/|https?:\/\/[^/]+\/|\/)login\/?\?([^#]*)/i)
  if (login) {
    const token = param(login[1]!, 'token')
    if (!token) return null
    const next = param(login[1]!, 'next')
    return { kind: 'login', token, next: next && next.startsWith('/') && !next.startsWith('//') ? next : null }
  }
  const invite = trimmed.match(/^(?:divvy:\/\/|https?:\/\/[^/]+\/|\/)invite\/([^/?#\s]+)/i)
  if (invite?.[1]) {
    try {
      return { kind: 'invite', token: decodeURIComponent(invite[1]) }
    } catch {
      return null
    }
  }
  return null
}

/** The invite token inside a `next` path like /invite/<token>, if any. */
export function inviteFromNext(next: string | null | undefined) {
  const link = next ? parseDeepLink(next) : null
  return link?.kind === 'invite' ? link.token : null
}
