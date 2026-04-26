# onesub-dashboard — Next.js standalone build.
#
# Build:  docker build -f packages/dashboard/Dockerfile -t onesub/dashboard .
# Run:    docker run -p 4101:4101 \
#           -e ONESUB_SERVER_URL=http://onesub-server:4100 \
#           onesub/dashboard
#
# Build context is the monorepo root so workspace dependencies (@onesub/shared)
# resolve correctly during `npm ci`.

# ─── deps ───────────────────────────────────────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /repo
COPY package*.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/dashboard/package.json packages/dashboard/
RUN npm ci --workspaces --include-workspace-root --omit=dev || npm ci --workspaces --include-workspace-root

# ─── build ──────────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /repo
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=deps /repo/packages/dashboard/node_modules ./packages/dashboard/node_modules
COPY package*.json ./
COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY packages/dashboard ./packages/dashboard

RUN npm run build -w @onesub/shared
RUN npm run build -w @onesub/dashboard

# ─── runtime ────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=4101
ENV HOSTNAME=0.0.0.0

# Next.js standalone output bundles every needed file (including a minimal
# node_modules). Copy it as-is.
COPY --from=builder /repo/packages/dashboard/.next/standalone ./
COPY --from=builder /repo/packages/dashboard/.next/static ./packages/dashboard/.next/static
COPY --from=builder /repo/packages/dashboard/public ./packages/dashboard/public

EXPOSE 4101
CMD ["node", "packages/dashboard/server.js"]
