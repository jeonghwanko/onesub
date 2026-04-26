# @onesub/dashboard

Self-hosted operations dashboard for [`@onesub/server`](https://www.npmjs.com/package/@onesub/server). View active subscriptions, lifecycle distribution, and operational state without standing up Grafana.

> **Status: 0.1 (Phase 1a)** — overview metrics page only. Subscriptions list, charts, and customer search ship in subsequent phases.

## Quick start (Docker)

```bash
docker run -p 4101:4101 \
  -e ONESUB_SERVER_URL=http://your-onesub-server:4100 \
  ghcr.io/jeonghwanko/onesub-dashboard:latest
```

Open <http://localhost:4101> and paste your server's `adminSecret` on the login screen.

## Build the image yourself

```bash
# from the monorepo root
docker build -f packages/dashboard/Dockerfile -t onesub-dashboard .
docker run -p 4101:4101 -e ONESUB_SERVER_URL=http://host.docker.internal:4100 onesub-dashboard
```

## Local development

```bash
# from the monorepo root
npm install
npm run build -w @onesub/shared

cd packages/dashboard
ONESUB_SERVER_URL=http://localhost:4100 npm run dev
```

The dev server listens on port 4101 and proxies metric calls to `ONESUB_SERVER_URL`.

## Configuration

| Env var | Required | Notes |
|---|---|---|
| `ONESUB_SERVER_URL` | yes | Base URL of your `@onesub/server` (e.g. `http://localhost:4100`) |
| `NODE_ENV=production` | recommended | Enables `Secure` cookie flag — required when serving over HTTPS |

The dashboard does **not** persist anything itself — every page render fetches fresh state from the onesub server. The browser cookie holds your `adminSecret` (HTTP-only, 8h sliding window); no other state is kept.

## Auth model

- The dashboard reuses your server's `adminSecret`. If the server doesn't have one set, mount it first (`createOneSubMiddleware({ ..., adminSecret: process.env.ADMIN_SECRET })`) — the metrics endpoints depend on it.
- After successful login, the secret is stored as an `HttpOnly` cookie on this dashboard's domain. It never travels to the browser; only server components read it.
- Phase 3 introduces a token-exchange layer (cookie holds an opaque session id, secret stays server-side) for multi-operator deployments. v0.1 is single-operator by design.

## Pages (current)

- `/login` — operator login
- `/dashboard` — overview: total entitled, active subs, grace_period (at risk), non-consumable purchases, distribution by product + platform

## Roadmap

- Phase 1b: `/dashboard/subscriptions` — list, filter, search by userId
- Phase 2: time-series charts (started / churned over selectable windows)
- Phase 3: customer search, audit log, manual grant UI

## License

MIT — same as the rest of onesub.
