// Startup checks for the hosted (locked) API. Kept pure so it can be tested.
export type StartupCheck = { ok: true; warnings: string[] } | { ok: false; error: string }

export function checkStartupEnv(env: Record<string, string | undefined>): StartupCheck {
  const webOrigin = env.WEB_ORIGIN?.trim()
  const locked = env.DEV_SIGNIN_EMAILS !== undefined
  if (!webOrigin) {
    if (locked) {
      return {
        ok: false,
        error: 'WEB_ORIGIN is not set, but DEV_SIGNIN_EMAILS is (hosted mode). Group links and sign-in emails would point at '
          + 'http://localhost:5173. Set WEB_ORIGIN to the public URL people open, for example WEB_ORIGIN=http://divvy.mooo.com:8787.',
      }
    }
    return { ok: true, warnings: ['WARNING: WEB_ORIGIN is not set. Group links and sign-in emails will point at http://localhost:5173, which only works on this machine.'] }
  }
  if (!/^https?:\/\/[^/\s]+$/.test(webOrigin.replace(/\/$/, ''))) {
    return { ok: false, error: `WEB_ORIGIN must be an origin like https://divvy.example.com (no path); got ${JSON.stringify(webOrigin)}.` }
  }
  return { ok: true, warnings: [] }
}

/** Where to listen. HOST unset keeps the old behavior (all interfaces); HOST=127.0.0.1 keeps the API behind Caddy. */
export function listenOptions(env: Record<string, string | undefined>): { port: number; hostname?: string } {
  const port = Number(env.PORT ?? 8787)
  const hostname = env.HOST?.trim()
  return hostname ? { port, hostname } : { port }
}
