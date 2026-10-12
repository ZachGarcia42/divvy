// Pure deep-link parsing so it can be unit-tested without React Native.
// Handles divvy://login?token=..., divvy://invite/<token>, and the same paths on the web origin.
// Tokens must match a strict base64url charset, so a link can never smuggle "/", "..", "?", spaces,
// or anything else into an API path or a `next` value.

export type DeepLink =
  | { kind: 'login'; token: string; next: string | null }
  | { kind: 'invite'; token: string }

export type InvitePreview = { group: { id: string; name: string }; members: { id: string; name: string }[] }

export const PENDING_INVITE_KEY = 'divvy.pendingInvite'

const TOKEN = /^[A-Za-z0-9_-]{16,128}$/

export function isToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN.test(value)
}

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

/** Same rules as the API: relative path, no "//" anywhere, no "." or ".." segments, no backslash/whitespace. */
export function safeNext(next: string | null | undefined) {
  if (!next || next.length > 512 || !next.startsWith('/') || next.includes('//') || /^\/[^/?#]*:/.test(next) || /[\\\s\u0000-\u001f\u007f]/.test(next)) return null
  const path = next.split(/[?#]/)[0]!
  if (path.split('/').some((segment) => segment === '.' || segment === '..')) return null
  return next
}

export function parseDeepLink(url: string | null | undefined): DeepLink | null {
  if (!url) return null
  const trimmed = url.trim()
  // divvy://login?token=... has "login" as the host; https://host/login?token=... has it as the path.
  const login = trimmed.match(/^(?:divvy:\/\/|https?:\/\/[^/]+\/|\/)login\/?\?([^#]*)/i)
  if (login) {
    const token = param(login[1]!, 'token')
    if (!isToken(token)) return null
    return { kind: 'login', token, next: safeNext(param(login[1]!, 'next')) }
  }
  const invite = trimmed.match(/^(?:divvy:\/\/|https?:\/\/[^/]+\/|\/)invite\/([^/?#\s]+)\/?(?:[?#].*)?$/i)
  if (invite?.[1] && isToken(invite[1])) return { kind: 'invite', token: invite[1] }
  return null
}

/** An invite token from a pasted link or a bare token. */
export function tokenFromInput(value: string | null | undefined) {
  if (!value) return null
  const trimmed = value.trim()
  if (TOKEN.test(trimmed)) return trimmed
  const link = parseDeepLink(trimmed)
  if (link?.kind === 'invite') return link.token
  const match = trimmed.match(/\/invite\/([^/?#\s]+)\/?(?:[?#].*)?$/)
  return match?.[1] && isToken(match[1]) ? match[1] : null
}

/** The invite token inside a `next` path like /invite/<token>, if any. */
export function inviteFromNext(next: string | null | undefined) {
  const link = parseDeepLink(safeNext(next))
  return link?.kind === 'invite' ? link.token : null
}

export function invitePath(token: string, suffix = '') {
  return `/api/invites/${encodeURIComponent(token)}${suffix}`
}

/** Only render a preview whose shape we actually expect; anything else is treated as a bad invite. */
export function parseInvitePreview(value: unknown): InvitePreview | null {
  if (!value || typeof value !== 'object') return null
  const { group, members } = value as { group?: unknown; members?: unknown }
  if (!group || typeof group !== 'object') return null
  const { id, name } = group as { id?: unknown; name?: unknown }
  if (typeof id !== 'string' || typeof name !== 'string') return null
  if (!Array.isArray(members)) return null
  const clean: InvitePreview['members'] = []
  for (const member of members) {
    if (!member || typeof member !== 'object') return null
    const m = member as { id?: unknown; name?: unknown }
    if (typeof m.id !== 'string' || typeof m.name !== 'string') return null
    clean.push({ id: m.id, name: m.name })
  }
  return { group: { id, name }, members: clean }
}
