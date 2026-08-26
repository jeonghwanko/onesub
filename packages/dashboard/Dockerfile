# onesub-dashboard — Next.js standalone build.
#
# Build:  docker build -f packages/dashboard/Dockerfile -t onesub/dashboard .
# Run:    docker run -p 4101:4101 \
#           -e ONESUB_SERVER_URL=http://onesub-server:4100 \
#           -e ONESUB_SESSION_SECRET=<at-least-32-random-characters> \
#           onesub/dashboard
#
# Build context is the monorepo root so workspace dependencies (@onesub/shared)
# resolve correctly during the lockfile-pinned install.

# ─── deps ───────────────────────────────────────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /repo
COPY package*.json ./
COPY .npmrc ./
COPY scripts/check-toolchain.mjs scripts/
COPY packages/cli/package.json packages/cli/
COPY packages/mcp-server/package.json packages/mcp-server/
COPY packages/providers/package.json packages/providers/
COPY packages/sdk/package.json packages/sdk/
COPY packages/server/package.json packages/server/
COPY packages/shared/package.json packages/shared/
COPY packages/dashboard/package.json packages/dashboard/
# A partial workspace install is not reproducible: npm may attribute a hoisted
# dev dependency to a workspace omitted from the Docker context, then prune it
# even though dashboard declares it too. Install the complete lock graph; the
# runtime stage still receives only Next.js standalone output.
RUN corepack npm ci

# ─── build ──────────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /repo
COPY --from=deps /repo/node_modules ./node_modules
COPY package*.json ./
COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY packages/dashboard ./packages/dashboard
# npm correctly keeps incompatible workspace-specific versions (notably
# dashboard's Node 20 types) under the workspace. Root node_modules alone is
# therefore not a complete install graph.
COPY --from=deps /repo/packages/dashboard/node_modules ./packages/dashboard/node_modules

RUN corepack npm run build -w @onesub/shared
RUN corepack npm run build -w @onesub/dashboard

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
