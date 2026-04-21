#!/usr/bin/env node
/**
 * onesub CLI — scaffolds a starter server (+ optional Expo app) in a new or
 * existing directory.
 *
 * Usage:
 *   npx @onesub/cli init [directory]
 *   npx @onesub/cli --help
 */

import { mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// dist/index.js → packages/cli/templates
const TEMPLATES_DIR = resolve(here, '..', 'templates');

const HELP = `onesub — scaffold a receipt-validation server and paywall app

Usage:
  onesub init [directory]   Create a new onesub project in <directory> (default: .)
  onesub --help             Show this help

What 'init' creates:
  server.ts                 Express server with createOneSubMiddleware() wired up
  .env.example              Apple + Google credential placeholders
  package.json              With @onesub/server as a dependency
  docker-compose.yml        Postgres + server, schema auto-initialized
  README.md                 Next-steps guide

After init:
  cd <directory>
  cp .env.example .env      # fill in your credentials
  npm install
  npm start                 # http://localhost:4100
`;

function parseArgs(argv: string[]): { cmd: string; target: string } {
  const args = argv.slice(2);
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    return { cmd: 'help', target: '.' };
  }
  if (args[0] !== 'init') {
    return { cmd: 'unknown', target: args[0] ?? '' };
  }
  return { cmd: 'init', target: args[1] ?? '.' };
}

async function isEmpty(dir: string): Promise<boolean> {
  if (!existsSync(dir)) return true;
  const entries = await readdir(dir);
  return entries.length === 0;
}

async function copyTemplate(relPath: string, destDir: string): Promise<void> {
  const src = join(TEMPLATES_DIR, relPath);
  const dst = join(destDir, relPath);
  await mkdir(dirname(dst), { recursive: true });
  const content = await readFile(src, 'utf8');
  await writeFile(dst, content, 'utf8');
  console.log(`  ${relPath}`);
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

  const files = [
    'package.json',
    'server.ts',
    'tsconfig.json',
    '.env.example',
    'docker-compose.yml',
    'README.md',
    '.gitignore',
  ];

  for (const f of files) {
    await copyTemplate(f, dir);
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

async function main(): Promise<void> {
  const { cmd, target } = parseArgs(process.argv);
  switch (cmd) {
    case 'help':
      console.log(HELP);
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
