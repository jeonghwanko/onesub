# onesub server example

Minimal Express server with Apple + Google receipt validation.

## Quick Start

```bash
cd examples/server
cp .env.example .env    # fill in your credentials
npm install
npm start               # http://localhost:4100
```

## Test it

```bash
# Check health
curl http://localhost:4100/health

# Check subscription status
curl http://localhost:4100/onesub/status?userId=test-user-123

# Validate a receipt (from your mobile app)
curl -X POST http://localhost:4100/onesub/validate \
  -H "Content-Type: application/json" \
  -d '{"platform":"apple","receipt":"<JWS_RECEIPT>","userId":"test-user-123","productId":"premium_monthly"}'
```

## With PostgreSQL

```bash
# Set DATABASE_URL in .env
DATABASE_URL=postgresql://user:pass@localhost:5432/onesub

# The table is auto-created on startup
npm start
```

## Mount in your existing app

If you already have an Express server, skip this example and just add one line:

```js
import { createOneSubMiddleware } from '@onesub/server';
app.use(createOneSubMiddleware(config));
```
