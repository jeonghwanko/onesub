# @onesub/dashboard

Self-hosted operations dashboard for [`@onesub/server`](https://www.npmjs.com/package/@onesub/server). View active subscriptions, lifecycle distribution, daily growth, per-customer state, and run common CS write actions — without standing up Grafana or wiring up a third-party admin service.

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

The dev server listens on port 4101 and proxies admin/metrics calls to `ONESUB_SERVER_URL`.

For a `.env.local`-style setup, drop `ONESUB_SERVER_URL=http://localhost:4100` into `packages/dashboard/.env.local` (the file is gitignored) and just run `npm run dev -w @onesub/dashboard` from the monorepo root.

## Configuration

| Env var | Required | Notes |
|---|---|---|
| `ONESUB_SERVER_URL` | yes | Base URL of your `@onesub/server` mount (e.g. `http://localhost:4100`, or `https://api.example.com/api` when onesub is mounted under a path prefix) |
| `NODE_ENV=production` | recommended | Enables `Secure` cookie flag — required when serving over HTTPS |

The dashboard does **not** persist anything itself — every page render fetches fresh state from the onesub server. The browser cookie holds your `adminSecret` (HTTP-only, 8h sliding window); no other state is kept.

## Auth model

- The dashboard reuses your server's `adminSecret`. If the server doesn't have one set, mount it first (`createOneSubMiddleware({ ..., adminSecret: process.env.ADMIN_SECRET })`) — every dashboard page depends on the admin scope being mounted.
- After successful login, the secret is stored as an `HttpOnly` cookie on the dashboard's domain. It never travels to the browser; only server components and server actions read it.
- Single-operator by design — a token-exchange layer (cookie holds an opaque session id, secret stays env-only) is on the roadmap when multi-operator + audit log land.

## Pages

| Path | What it shows |
|---|---|
| `/login` | Operator login. Probes the upstream onesub server with the candidate secret before setting the cookie. |
| `/dashboard` | **Overview** — total entitled, active subs, `grace_period` (at-risk), non-consumable purchases. Two charts (started-vs-expired subscriptions and non-consumable purchases over the last 30 UTC days) + three distribution panels (by product / by non-consumable product / by platform). |
| `/dashboard/subscriptions` | **Subscription list** — filter by userId / status / productId / platform; URL-driven pagination (50 per page, capped at 200 server-side). Row userId → customer detail; productId / transactionId → subscription detail. |
| `/dashboard/subscriptions/[transactionId]` | **Subscription detail** — every field from `SubscriptionInfo`, with relative-time anchors next to absolute timestamps and a Google-only card for `linkedPurchaseToken` / `autoResumeTime` when present. |
| `/dashboard/customers` | **Customer search** — server-action search form (userId → redirect to detail). |
| `/dashboard/customers/[userId]` | **Customer detail** — three tables (Entitlements when configured / Subscriptions / Purchases) plus admin write actions (see below). |

## Admin write actions

Available on the customer detail page:

| Action | What it does | Server endpoint |
|---|---|---|
| **Grant non-consumable** | Manually create a purchase row for a `userId + productId`. Skips receipt verification — operator asserts entitlement (refund recovery, goodwill, beta gift). | `POST /onesub/purchase/admin/grant` |
| **Transfer purchase** | Reassign a `transactionId`'s owner to a new userId. For legitimate device migration / account merge. | `POST /onesub/purchase/admin/transfer` |
| **Delete purchases** | Drop every purchase row matching `userId + productId`. Used to let a user re-test a non-consumable flow. | `DELETE /onesub/purchase/admin/:userId/:productId` |

All three are server actions that revalidate the customer detail page after success. Subscriptions cannot be granted directly from the dashboard — receipt validation is the source of truth for subs.

## Mounting onesub behind a path prefix

If your host app mounts onesub under a sub-path (e.g. `app.use('/api', createRouter())` so the routes are at `/api/onesub/*`), point `ONESUB_SERVER_URL` at the prefix and the dashboard will reach the right paths automatically.

## Roadmap

- Audit log of admin write actions (who / when / what)
- Token-exchange auth for multi-operator setups
- Subscription manual grant (paired with a `subscriptionStore.save` admin endpoint)
- Mobile-friendly layout polish

## License

MIT — same as the rest of onesub.
