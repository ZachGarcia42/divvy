# Divvy

A shared expense ledger for iOS, Android, and the web. People record who paid and how a bill was split. Divvy calculates balances. It does not send money.

## Run

```bash
npm install
npm test
npm run dev
```

The web app is at http://localhost:5173 and the API is at http://localhost:8787. On the sign-in screen, choose “Open the sample apartment”.

Without `DATABASE_URL`, the API stores data in embedded Postgres under `data/pglite`. Set `DATABASE_URL` to use a Postgres server instead.

The Expo app lives in `apps/mobile` and talks to the same API:

```bash
npm run start -w @divvy/mobile
```

Set `EXPO_PUBLIC_API_URL` if the phone cannot reach `http://localhost:8787`.

## Hosting

Set these on the host:

| Variable | Needed | What it does |
| --- | --- | --- |
| `WEB_ORIGIN` | Yes when hosted | The public origin people open, for example `http://divvy.mooo.com:8787`. Group links and sign-in emails use it. When it points at the API itself, the API serves small `/login` and `/invite/<token>` pages that open the app. It defaults to `http://localhost:5173`, which only works on the dev machine. The API refuses to start when `DEV_SIGNIN_EMAILS` is set and `WEB_ORIGIN` is not, and prints a loud warning otherwise. |
| `DEV_SIGNIN_EMAILS` | Tester builds | Comma-separated tester emails that get an instant sign-in token and code. Setting it at all (even empty) locks the API: other emails get no token and `/api/dev/*` returns 404. |
| `ADMIN_TOKEN` | Optional | Secret for admin routes. Unset means admin routes are off. |
| `TRUST_PROXY` | Optional | `1` only behind a proxy you control; the rate limiter then uses the last `X-Forwarded-For` entry. |
| `CORS_ORIGIN` | Optional | Comma-separated browser origins allowed to call the API with cookies, for example `https://divvy.example.com`. Defaults to `http://localhost:5173,http://localhost:8081`. The mobile app doesn't need it; set it only when a web app is served from another origin. |
| `GOOGLE_CLIENT_IDS` | For Google sign-in | Comma-separated Google OAuth client ids accepted as the ID token `aud`: the Web client id (Android and iOS tokens from `@react-native-google-signin` carry it) plus the iOS client id. Unset or empty means `POST /api/auth/google` returns 503. |
| `APPLE_CLIENT_IDS` | Optional | Comma-separated Apple audiences for `POST /api/auth/apple` (iOS bundle id `app.divvy.ledger`, plus any Service IDs). **No default: Apple is off (503) until this is set.** |
| `APPLE_WEB_CLIENT_IDS` | Optional | Apple Service IDs (web/Android flow). When set, tokens from `platform: ios` must carry a non-Service aud and `web`/`android` must carry a Service ID. |
| `APPLE_REQUIRE_NONCE` | Optional | Default `true`. The token's `nonce` claim must equal sha256-hex of the raw `nonce` in the body. |
| `GOOGLE_REQUIRE_NONCE` | Optional | Default `false`, because the free `@react-native-google-signin` v16 `signIn()` can't pass a nonce. A nonce that is sent (web GIS) is always checked; a token with a nonce claim always needs the raw nonce. |
| `PORT` | Optional | Defaults to 8787. |

Leave `NODE_ENV` unset on tester hosts; `production` turns off tester sign-in tokens.

### Sign in with Google and Apple

`POST /api/auth/google {idToken, next?}` and `POST /api/auth/apple {identityToken, fullName?, next?}` verify the token against the provider's JWKS (issuer, audience, expiry; Google also needs `email_verified`). Users are linked by provider + `sub`; the first sign-in matches an existing account by verified email. Both return the same session as the email path. `GET /api/auth/providers` tells clients which buttons to show (`{google, apple, email}`); `email` is the tester path and stays on while `DEV_SIGNIN_EMAILS` lists anyone.

Client build variables (EAS env or `apps/mobile/.env`):

| Variable | What it is |
| --- | --- |
| `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` | Google OAuth **Web** client id. Required for Google on both platforms. |
| `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` | Google OAuth **iOS** client id (bundle `app.divvy.ledger`). Required for Google on iOS. |
| `EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME` | Optional; the reversed iOS client id. Derived from the iOS client id if unset. |
| `EXPO_PUBLIC_API_URL` | The API origin (set per profile in `eas.json`). |
| `VITE_GOOGLE_CLIENT_ID` | Web app only: the Web client id for the Google button. |

Setup checklist:

1. Google Cloud console → new project → OAuth consent screen (External, Testing; add tester Gmail addresses as test users).
2. Credentials → create OAuth client ids: **Web** (authorized JavaScript origin = the public HTTPS web origin), **iOS** (bundle id `app.divvy.ledger`), **Android** (package `app.divvy.ledger` + the SHA-1 of the EAS signing key from `eas credentials`; add the debug SHA-1 too for dev builds).
3. Server: `GOOGLE_CLIENT_IDS=<web id>,<ios id>`; restart.
4. EAS: set `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` and `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID`, then `eas build --profile preview -p android` (internal APK) or `--profile development`. Google and Apple sign-in need a real build; they don't run in Expo Go.
5. Apple: in the Apple developer team, enable *Sign in with Apple* on the `app.divvy.ledger` App ID (EAS does this when it manages credentials). No server secret is needed for native iOS sign-in; set `APPLE_CLIENT_IDS=app.divvy.ledger` to turn Apple on.
6. Smoke test: `curl $API/api/auth/providers` shows `google: true`.

### Sign-in linking rules and known limitations
- **Nonce:** clients generate a random raw nonce, give the provider sha256(raw) as hex (Apple's convention, also used for web GIS) and send raw to the API, which compares. Google on mobile sends no nonce (library limitation; see `GOOGLE_REQUIRE_NONCE`).
- **Google** links to an existing account by email on first sign-in only when the email is `@gmail.com` or the token has an `hd` (Workspace) claim. Otherwise it creates a new account if the email is free, and returns 409 `EMAIL_IN_USE` if an account already has it (sign in the old way).
- **Apple private relay** (`@privaterelay.appleid.com`) never auto-links. Known limitation: those users get their own account, so invites/claims sent to their real email won't attach until a link-email flow exists.
- Apple `fullName` parts are capped at 100 characters before parsing (stored name max 60). Suspended users get 403 `SUSPENDED` and no session.
