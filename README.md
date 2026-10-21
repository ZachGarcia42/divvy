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
| `PORT` | Optional | Defaults to 8787. |

Leave `NODE_ENV` unset on tester hosts; `production` turns off tester sign-in tokens.
