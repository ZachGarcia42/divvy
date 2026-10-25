import { LedgerError } from '@divvy/domain'
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose'

export type Provider = 'google' | 'apple'
export type VerifiedIdentity = { provider: Provider; sub: string; email: string | null; emailVerified: boolean; name: string | null }

export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs'
export const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys'
const ISSUERS: Record<Provider, string[]> = {
  google: ['accounts.google.com', 'https://accounts.google.com'],
  apple: ['https://appleid.apple.com'],
}

export const parseClientIds = (raw: string | string[] | null | undefined) =>
  raw == null ? [] : (Array.isArray(raw) ? raw : raw.split(',')).map((id) => id.trim()).filter(Boolean)

const truthy = (value: unknown) => value === true || value === 'true'

export type IdTokenVerifier = (token: string) => Promise<VerifiedIdentity>

/**
 * Verifies a provider ID token: signature against the provider's JWKS, issuer, audience (one of
 * clientIds), and exp/nbf. Any failure is a 401 BAD_TOKEN. `keys` is injectable so tests can sign locally.
 */
export function createVerifier(provider: Provider, clientIds: string[], options?: { keys?: JWTVerifyGetKey; now?: () => Date }): IdTokenVerifier {
  const keys = options?.keys ?? createRemoteJWKSet(new URL(provider === 'google' ? GOOGLE_JWKS_URL : APPLE_JWKS_URL))
  return async (token) => {
    let payload
    try {
      ({ payload } = await jwtVerify(token, keys, {
        issuer: ISSUERS[provider],
        audience: clientIds,
        algorithms: ['RS256'],
        requiredClaims: ['sub', 'exp'],
        currentDate: options?.now?.(),
      }))
    } catch {
      throw new LedgerError('BAD_TOKEN', 'That sign-in didn’t work. Try again.')
    }
    const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : null
    const name = typeof payload.name === 'string' ? payload.name : null
    return { provider, sub: String(payload.sub), email, emailVerified: truthy(payload.email_verified), name }
  }
}
