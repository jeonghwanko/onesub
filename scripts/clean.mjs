import { readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const packagesDir = fileURLToPath(new URL('../packages/', import.meta.url));
const entries = await readdir(packagesDir, { withFileTypes: true });

await Promise.all(
  entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => rm(new URL(`../packages/${entry.name}/dist/`, import.meta.url), {
      force: true,
      recursive: true,
    })),
);
