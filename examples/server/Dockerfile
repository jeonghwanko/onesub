# Production-style image for the onesub example server.
#
# Unlike docker-compose.yml (which bind-mounts the local workspace for fast
# iteration), this Dockerfile installs `@onesub/server` from npm and bakes the
# result into an immutable image — what you'd actually ship.
#
# Build:
#   docker build -t onesub-server -f examples/server/Dockerfile examples/server
#
# Run:
#   docker run --rm -p 4100:4100 --env-file examples/server/.env onesub-server

# ─── deps: install only production dependencies ──────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json ./
# `npm install` (not `ci`) because examples/server has no package-lock — it
# resolves against the latest published @onesub/server.
RUN npm install --omit=dev --no-audit --no-fund

# ─── runtime: minimal image with just node + the app ─────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app

# Run as non-root. node:alpine ships with the `node` user (uid 1000).
ENV NODE_ENV=production \
    PORT=4100

COPY --from=deps /app/node_modules ./node_modules
COPY package.json server.js ./

USER node
EXPOSE 4100

# Healthcheck hits the example server's /health endpoint. If you change the
# path or port, update here.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
