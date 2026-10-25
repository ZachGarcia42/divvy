# Divvy on the web

`npm run export:web` (in apps/mobile) writes the Expo web export to `dist-web/`. The API serves it when
`WEB_DIST` points at that directory: static files, hashed `/_expo/static/*` cached for a year, and
`index.html` (no-cache, app CSP) for every other non-`/api` GET. `/login` and `/invite/<token>` stay
landing pages and link to `/app/login?...` and `/app/invite/<token>` in the web app.

- API calls are same-origin on web (override with `EXPO_PUBLIC_WEB_API_URL` for local dev).
- The session token lives in localStorage on web (expo-secure-store has no web build).
- Google: Google Identity Services button, nonce = sha256(raw) to Google and raw to `POST /api/auth/google`
  with `platform: 'web'`. `https://divvy.mooo.com` must be an Authorized JavaScript origin on the Web client.

## Sign in with Apple on web (not built)

1. On the Apple developer team: a **Services ID** (e.g. `app.divvy.ledger.web`) with Sign in with Apple
   enabled and grouped with the primary App ID `app.divvy.ledger`.
2. In its configuration: domain `divvy.mooo.com` and return URL `https://divvy.mooo.com/app/auth/apple`
   (Apple JS popup mode still requires a registered return URL; it must be https).
3. Domain verification if Apple asks for it: host `/.well-known/apple-developer-domain-association.txt`
   (the API would serve it from WEB_DIST/.well-known/).
4. Server: add the Services ID to `APPLE_CLIENT_IDS` and `APPLE_WEB_CLIENT_IDS` (aud check: web tokens
   must carry the Services ID, iOS ones the bundle id).
5. Client: `SocialSignIn.web.tsx` loads `https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js`,
   `AppleID.auth.init({ clientId, scope: 'name email', redirectURI, usePopup: true, nonce: sha256(raw) })`,
   then posts `identityToken`, raw nonce, `platform: 'web'` and any `user.name` to `/api/auth/apple`.
   CSP: add `https://appleid.cdn-apple.com` to script-src and `https://appleid.apple.com` to frame-src/connect-src.
