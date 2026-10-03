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
