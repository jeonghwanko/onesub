# onesub Expo example

Expo Router app that exercises every public surface of `@onesub/sdk`:
subscriptions, consumables, non-consumables, and entitlement gates.

## Quick start (5 minutes)

```bash
# 1. Boot the server (Postgres + Redis + onesub)
cd ../server
docker compose up -d

# 2. Install + start the app on a physical device
cd ../expo-app
npm install
npx expo start
```

`docker compose` brings up:

- Postgres on `5432` (subscription + purchase store)
- Redis on `6379` (shared cache + idempotency + BullMQ queue)
- onesub on `4100` (HTTP middleware)

## Screens

| File | Demonstrates |
|------|--------------|
| [app/_layout.tsx](app/_layout.tsx) | `<OneSubProvider>` wrapping the navigation tree |
| [app/index.tsx](app/index.tsx) | `useOneSub().isActive` + `subscribe()` + `restore()` |
| [app/consumables.tsx](app/consumables.tsx) | `purchaseProduct()` for consumables and non-consumables, plus `hasEntitlement()` |

## Configuration

Edit `app/_layout.tsx`:

```ts
const SERVER_URL = 'http://YOUR_PC_IP:4100';  // your onesub server
const PRODUCT_ID = 'premium_monthly';          // App Store / Google Play product ID
const USER_ID = 'your-user-id';                // from your auth system
```

If you run the server on `localhost`, replace it with your machine's LAN IP
(the device can't reach `localhost` of the dev machine).

## Prerequisites

1. Run the server example (see above)
2. Create matching products in App Store Connect / Google Play Console:
   - Subscription: `premium_monthly`
   - Consumable: `coin_pack_100`
   - Non-consumable: `remove_ads_lifetime`
3. Use a **physical device** — IAP doesn't work in simulators
