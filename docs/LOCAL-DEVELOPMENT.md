# Local Development

This guide takes a new contributor from a clean clone to a validated local workspace. For coding
rules and package ownership, read [`../AGENTS.md`](../AGENTS.md) first.

## Prerequisites

- Node.js 20 or newer. CI uses Node.js 22, so Node 22 is the closest local match.
- npm with lockfile support (`npm ci`).
- Git.
- Docker, only for the PostgreSQL example or dashboard image.
- PowerShell 7 (`pwsh`), only for the Unity package-boundary validator.
- Unity 2022.3, only for running the Unity Editor tests.

Never commit `.env` files. The repository ignores `.env` and `.env.*` while retaining
`.env.example` templates.

## Clone and Establish a Baseline

```bash
git clone https://github.com/jeonghwanko/onesub.git
cd onesub
npm ci
npm run build
npm test
npm run type-check
```

The root build runs packages in dependency order:

```text
shared -> providers -> server -> sdk -> mcp-server -> cli
```

It intentionally excludes the Next.js dashboard. A clean baseline makes it easier to distinguish a
new regression from a machine-specific setup problem.

## Focused Development

Run the smallest useful check while iterating:

```bash
# One test file
npm test -- packages/server/src/__tests__/apps.test.ts

# One package (build shared first when starting from a clean checkout)
npm run build -w @onesub/shared
npm run build -w @onesub/server

# Type-check one workspace
npm run type-check -w @onesub/mcp-server
```

The root `npm run dev:server` command starts TypeScript watch mode; it does not launch an HTTP server.
Use the mocked CLI server below for an immediately runnable local API.

## Run the Mocked Server

After `npm run build`, run the CLI built from the current checkout:

```bash
node packages/cli/dist/index.js dev --port 4100
```

The server binds to `127.0.0.1`, uses in-memory stores, enables Apple and Google mock providers, and
prints request examples. Restarting it clears all state. Its development admin secret is
`dev-admin-secret`; never expose this server through a public tunnel.

Verify it:

```bash
curl http://localhost:4100/health

curl -X POST http://localhost:4100/onesub/validate \
  -H "Content-Type: application/json" \
  -d '{"platform":"apple","receipt":"MOCK_VALID_sub","userId":"u1","productId":"pro"}'

curl "http://localhost:4100/onesub/status?userId=u1"
```

Mock receipt prefixes and expected outcomes are documented in [`TESTING.md`](TESTING.md).

## Run the Example Server

The example can use in-memory, PostgreSQL, or Redis-backed components depending on its environment:

```bash
cd examples/server
cp .env.example .env
npm install
npm start
```

Alternatively, start the example server, PostgreSQL, and Redis together:

```bash
cd examples/server
docker compose up
```

Use fake/local credentials only for mock mode. Real Apple and Google credentials belong in a secret
manager or an untracked local environment file.

`examples/` is not an npm workspace. It installs `@onesub/server` from npm at the version pinned in
its own `package.json`, so **it does not exercise your working tree** — a change you just made to
`packages/server` will not appear here. Use it to check the published integration story; use the
checkout-built mock server above to validate local changes.

## Run the Dashboard

Start a OneSub server with `adminSecret` configured, then in another terminal:

```bash
npm run build -w @onesub/shared
ONESUB_SERVER_URL=http://localhost:4100 npm run dev -w @onesub/dashboard
```

PowerShell equivalent:

```powershell
$env:ONESUB_SERVER_URL = 'http://localhost:4100'
npm run dev -w @onesub/dashboard
```

Open <http://localhost:4101> and enter the server's admin secret. For the mocked CLI server, use
`dev-admin-secret`.

Before finishing a dashboard change, run:

```bash
npm run type-check -w @onesub/dashboard
npm run build -w @onesub/dashboard
```

## Work on Unity Packages

The Unity packages are not npm workspaces. Validate their manifest and assembly boundaries from the
repository root:

```bash
pwsh ./validate-unity-packages.ps1
```

Behavior tests live under `packages/unity/Tests/Editor` and must be run with Unity Test Framework in
a Unity 2022.3 project. Purchasing code belongs in `packages/unity`; optional sharing, review,
leaderboard, and authentication helpers belong in `packages/unity-platform-services`.

## Common Setup Problems

| Symptom | Likely cause | Resolution |
|---|---|---|
| Package types cannot be resolved | Dependency workspace has not been built | Run the root build or build `@onesub/shared`/`@onesub/providers` first |
| Dashboard cannot start | `ONESUB_SERVER_URL` is missing | Point it at the running OneSub server |
| Dashboard login fails | Server has no matching `adminSecret` | Configure the server secret and enter the same value in the dashboard |
| Mock state disappears | The CLI dev server restarted | Expected: mock stores are in-memory |
| `RN_IAP_NOT_INSTALLED` | React Native peer dependency is absent | Install `react-native-iap` in the consuming app and rebuild native code |
| Real Apple/Google E2E exits immediately | Required secret environment variables are missing | Use the manual E2E workflow or provide sandbox credentials locally |
| Unity boundary script fails | Optional service code leaked into Core, or package versions differ | Restore the package boundary described in `docs/UNITY-PRO.md` |

## Before Opening a Pull Request

Run checks proportional to the changed surface, then use the full baseline for cross-package changes:

```bash
npm run build
npm test
npm run type-check
npm run docs:check
```

Published-package behavior changes need a Changeset. Documentation-only, test-only, CI-only, and
example-only changes do not.
