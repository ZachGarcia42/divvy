// Errors from the API carry the server's code; network failures carry NETWORK.
export type ApiError = Error & { code?: string; status?: number }

export function codeOf(reason: unknown): string | undefined {
  return reason && typeof reason === 'object' ? (reason as ApiError).code : undefined
}

export function isNetwork(reason: unknown) {
  return codeOf(reason) === 'NETWORK'
}
