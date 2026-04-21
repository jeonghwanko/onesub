# my-onesub-server

Scaffolded by [`npx @onesub/cli init`](https://github.com/jeonghwanko/onesub).

## Run

```bash
cp .env.example .env   # fill in Apple / Google credentials
npm install
npm run dev            # http://localhost:4100
```

Or the full stack (Postgres + server) with Docker:

```bash
docker compose up
```

## What you got

| File | What |
|------|------|
| `server.ts` | Express server with `createOneSubMiddleware()` wired up |
| `.env.example` | Apple / Google / DB placeholders |
| `docker-compose.yml` | Postgres + server, schema auto-initialized from `@onesub/server/sql/schema.sql` |

## Endpoints mounted

- `POST /onesub/validate` — subscription receipt
- `GET  /onesub/status?userId=` — subscription state
- `POST /onesub/webhook/apple` — App Store Server Notifications V2
- `POST /onesub/webhook/google` — Google Play RTDN
- `POST /onesub/purchase/validate` — one-time purchase (consumable / non-consumable)
- `GET  /onesub/purchase/status?userId=` — list purchases
- `POST /onesub/purchase/admin/*` — admin routes (if `ADMIN_SECRET` is set)

## Next

- Add your own auth middleware before `createOneSubMiddleware(...)` if `userId` should not be client-trusted
- Install [`@jeonghwanko/onesub-sdk`](https://www.npmjs.com/package/@jeonghwanko/onesub-sdk) in your React Native app for the `useOneSub()` hook
- Read [onesub docs](https://github.com/jeonghwanko/onesub)

MIT.
