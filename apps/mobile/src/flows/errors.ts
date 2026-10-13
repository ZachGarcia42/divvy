// Errors from the API carry the server's code; network failures carry NETWORK.
export type ApiError = Error & { code?: string; status?: number }

export function codeOf(reason: unknown): string | undefined {
  return reason && typeof reason === 'object' ? (reason as ApiError).code : undefined
}

export function isNetwork(reason: unknown) {
  return codeOf(reason) === 'NETWORK'
}

export function statusOf(reason: unknown): number | undefined {
  return reason && typeof reason === 'object' ? (reason as ApiError).status : undefined
}

/** Network failure, timeout, or a server/proxy error (5xx): worth a Try again, never a dead end. */
export function isTransient(reason: unknown) {
  const status = statusOf(reason)
  const code = codeOf(reason)
  return isNetwork(reason) || code === 'INTERNAL' || (status !== undefined && status >= 500) || /^HTTP_5\d\d$/.test(code ?? '')
}

export function isUnauthenticated(reason: unknown) {
  // The API also sends BAD_TOKEN (a dead invite or sign-in link) as 401; that is not a session problem.
  const code = codeOf(reason)
  return code === 'UNAUTHENTICATED' || (statusOf(reason) === 401 && code !== 'BAD_TOKEN')
}
