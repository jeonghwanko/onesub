#!/usr/bin/env node
/**
 * onesub CLI — scaffolds a starter server (+ optional Expo app) in a new or
 * existing directory.
 *
 * Usage:
 *   npx @onesub/cli init [directory]
 *   npx @onesub/cli dev [--port N]
 *   npx @onesub/cli --help
 */

import { mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// dist/index.js → packages/cli/templates
const TEMPLATES_DIR = resolve(here, '..', 'templates');

const HELP = `onesub — scaffold and run a receipt-validation server locally

Usage:
  onesub init [directory]   Create a new onesub project in <directory> (default: .)
  onesub dev [--port N]     Start a fully-mocked onesub server for local testing
  onesub --help             Show this help

── init ─────────────────────────────────────────────────────────────────
Creates server.ts, .env.example, package.json, docker-compose.yml, README.md,
tsconfig.json, .gitignore. After:
  cd <directory> && cp .env.example .env && npm install && npm start

── dev ──────────────────────────────────────────────────────────────────
Zero-config server with mock Apple / Google providers + in-memory stores.
No credentials needed. Use for local testing, CI, or AI-driven flows:
  POST /onesub/validate                { platform, receipt, userId, productId }
  POST /onesub/purchase/validate       { ...same + type }
  GET  /onesub/status?userId=
  GET  /onesub/purchase/status?userId=

Receipt patterns (prefix match):
  MOCK_VALID_* / any other string   → valid
  MOCK_REVOKED_*                    → revoked/refunded (422)
  MOCK_EXPIRED_*                    → 72h expired (422)
  MOCK_INVALID_* / MOCK_BAD_SIG_*   → bad signature (422)
  MOCK_NETWORK_ERROR_*              → simulated upstream failure (500)
  MOCK_SANDBOX_*                    → valid but short expiry

No persistence — restarting clears all purchases.
`;

interface ParsedArgs {
  cmd: 'help' | 'init' | 'dev' | 'unknown';
  target: string;
  port: number;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  const portFlag = args.findIndex((a) => a === '--port' || a === '-p');
  let port = 4100;
  if (portFlag >= 0) {
    const rawPort = args[portFlag + 1];
    // Number() is stricter than parseInt() — '80abc' must not pass as 80.
    const parsed = rawPort !== undefined && rawPort !== '' ? Number(rawPort) : NaN;
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      console.error(
        `error: --port expects an integer between 1 and 65535 (got ${rawPort === undefined ? 'nothing' : `"${rawPort}"`})`,
      );
      process.exit(1);
    }
    port = parsed;
  }
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    return { cmd: 'help', target: '.', port };
  }
  if (args[0] === 'init') {
    const target = args[1] ?? '.';
    // A directory target starting with '-' is almost certainly a mistyped
    // flag — refuse rather than scaffold into a directory literally named
    // e.g. "--port".
    if (target.startsWith('-')) {
      console.error(`error: invalid init directory "${target}" — directory names must not start with '-'`);
      process.exit(1);
    }
    return { cmd: 'init', target, port };
  }
  if (args[0] === 'dev') {
    return { cmd: 'dev', target: '.', port };
  }
  return { cmd: 'unknown', target: args[0] ?? '', port };
}

async function isEmpty(dir: string): Promise<boolean> {
  if (!existsSync(dir)) return true;
  const entries = await readdir(dir);
  return entries.length === 0;
}

async function copyTemplate(relPath: string, destDir: string, destName?: string): Promise<void> {
  const src = join(TEMPLATES_DIR, relPath);
  const dst = join(destDir, destName ?? relPath);
  await mkdir(dirname(dst), { recursive: true });
  const content = await readFile(src, 'utf8');
  await writeFile(dst, content, 'utf8');
  console.log(`  ${destName ?? relPath}`);
}

async function init(target: string): Promise<void> {
  const dir = resolve(target);
  const empty = await isEmpty(dir);
  if (!empty) {
    console.error(`error: ${dir} is not empty. Pick a new directory or remove existing files.`);
    process.exit(1);
  }

  await mkdir(dir, { recursive: true });
  console.log(`\nScaffolding onesub server into ${dir}\n`);

  // npm publish excludes files named `.gitignore` / `.env.example` from the
  // tarball in some configurations, so dotfiles are stored under a `_` prefix
  // in the package and renamed on scaffold.
  const files: Array<{ src: string; dst?: string }> = [
    { src: 'package.json' },
    { src: 'server.ts' },
    { src: 'tsconfig.json' },
    { src: '.env.example' },
    { src: 'docker-compose.yml' },
    { src: 'README.md' },
    { src: '_gitignore', dst: '.gitignore' },
  ];

  for (const f of files) {
    await copyTemplate(f.src, dir, f.dst);
  }

  console.log(`
Done. Next steps:

  cd ${target === '.' ? '.' : target}
  cp .env.example .env    # fill in Apple / Google credentials
  npm install
  npm run dev             # http://localhost:4100

Or with Docker (Postgres + server):

  docker compose up

Docs: https://github.com/jeonghwanko/onesub
`);
}

async function dev(port: number): Promise<void> {
  // Lazy imports — only loaded when the dev command runs, so `onesub init`
  // doesn't pay express + @onesub/server startup cost.
  const express = (await import('express')).default;
  const { createOneSubMiddleware, InMemorySubscriptionStore, InMemoryPurchaseStore } =
    await import('@onesub/server');

  const app = express();
  app.use(
    createOneSubMiddleware({
      // skipJwsVerification lets the MCP simulate-webhook tool's fake Apple
      // JWS payloads through — its docs promise the dev server accepts them.
      apple: { bundleId: 'mock.onesub.dev', mockMode: true, skipJwsVerification: true },
      google: { packageName: 'mock.onesub.dev', mockMode: true },
      database: { url: '' },
      store: new InMemorySubscriptionStore(),
      purchaseStore: new InMemoryPurchaseStore(),
      adminSecret: 'dev-admin-secret',
      logger: console,
    }),
  );
  app.get('/health', (_req, res) => {
    res.json({ ok: true, mode: 'mock', uptime: process.uptime() });
  });

  // Bind to loopback so port-forwarding or stray ngrok exposure doesn't
  // let anyone on the internet hit the mock admin routes with the well-known
  // dev secret.
  const server = app.listen(port, '127.0.0.1', () => {
    console.log(`
onesub dev server — mocked Apple / Google providers
───────────────────────────────────────────────────
  http://localhost:${port}/health
  http://localhost:${port}/onesub/*

Try it:

  # validate a mock subscription
  curl -X POST http://localhost:${port}/onesub/validate \\
    -H "Content-Type: application/json" \\
    -d '{"platform":"apple","receipt":"MOCK_VALID_sub","userId":"u1","productId":"pro"}'

  # validate a mock one-time purchase
  curl -X POST http://localhost:${port}/onesub/purchase/validate \\
    -H "Content-Type: application/json" \\
    -d '{"platform":"google","receipt":"MOCK_VALID_prod","userId":"u1","productId":"premium","type":"non_consumable"}'

  # check status
  curl 'http://localhost:${port}/onesub/status?userId=u1'

  # simulate a rejected receipt
  curl -X POST http://localhost:${port}/onesub/purchase/validate \\
    -H "Content-Type: application/json" \\
    -d '{"platform":"apple","receipt":"MOCK_REVOKED","userId":"u1","productId":"premium","type":"non_consumable"}'

Admin secret: "dev-admin-secret"
Ctrl+C to stop. State is in-memory — restarts clear everything.
`);
  });

  const shutdown = () => {
    console.log('\n[onesub] shutting down...');
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function main(): Promise<void> {
  const { cmd, target, port } = parseArgs(process.argv);
  switch (cmd) {
    case 'help':
      console.log(HELP);
      return;
    case 'dev':
      await dev(port);
      return;
    case 'init':
      await init(target);
      return;
    default:
      console.error(`Unknown command: ${target}\n`);
      console.error(HELP);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error('onesub cli failed:', err);
  process.exit(1);
});
