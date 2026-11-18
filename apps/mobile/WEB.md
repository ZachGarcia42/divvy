# Divvy on the web

`npm run export:web` (in apps/mobile) writes the Expo web export to `dist-web/`. The API serves it when
`WEB_DIST` points at that directory: static files, hashed `/_expo/static/*` cached for a year, and
`index.html` (no-cache, app CSP) for every other non-`/api` GET. `/login` and `/invite/<token>` stay
landing pages and link to `/app/login?...` and `/app/invite/<token>` in the web app.

- API calls are same-origin on web (override with `EXPO_PUBLIC_WEB_API_URL` for local dev).
- The session token lives in localStorage on web (expo-secure-store has no web build).
- Google: Google Identity Services button, nonce = sha256(raw) to Google and raw to `POST /api/auth/google`
  with `platform: 'web'`. `https://divvy.mooo.com` must be an Authorized JavaScript origin on the Web client.

## Sign in with Apple on web

Built. Apple setup (team Oliver Elliott, `5E845TX3E6`):

1. **Services ID** `app.divvy.ledger.web` ("Divvy Web") with Sign in with Apple enabled, grouped with the primary
   App ID `app.divvy.ledger`; domain `divvy.mooo.com`, return URL `https://divvy.mooo.com/app/auth/apple`
   (Apple JS popup mode still requires a registered https return URL). The API serves `/app/auth/apple` as the
   app shell (index.html, app CSP), so it never 404s.
2. Domain verification if Apple asks for it: host `/.well-known/apple-developer-domain-association.txt`
   (the API would serve it from WEB_DIST/.well-known/; dotfile paths are currently refused, so this needs an explicit route).
3. Server env: `APPLE_CLIENT_IDS=app.divvy.ledger,app.divvy.ledger.web` and `APPLE_WEB_CLIENT_IDS=app.divvy.ledger.web`
   (aud check: web tokens must carry the Services ID, iOS ones the bundle id). No Apple private key (.p8) and no client
   secret: the API only verifies Apple's identity token against Apple's public JWKS.
4. Web build env: `EXPO_PUBLIC_APPLE_WEB_SERVICES_ID=app.divvy.ledger.web` and
   `EXPO_PUBLIC_APPLE_WEB_REDIRECT_URI=https://divvy.mooo.com/app/auth/apple`. `npm run export:web` defaults both (like the
   Google web client id); `eas.json` preview/production set them too. The Apple button shows on web only when both are set
   and `/api/auth/providers` reports `apple: true`.
5. Client (`SocialSignIn.web.tsx`): loads `https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js`,
   calls `AppleID.auth.init({ clientId, scope: 'name email', redirectURI, usePopup: true, nonce: sha256hex(raw) })` ahead of
   the tap (fresh nonce each attempt, so `AppleID.auth.signIn()` runs straight from the click and the popup isn't blocked),
   then posts `identityToken`, raw `nonce`, `platform: 'web'` and `fullName` from `user.name` (first sign-in only) to
   `/api/auth/apple`, the same body shape as native (`providerBody`). Closing the popup shows no error.
6. CSP (`apps/api/src/web.ts`): `https://appleid.cdn-apple.com` in script-src; `https://appleid.apple.com` in frame-src,
   connect-src and form-action.
