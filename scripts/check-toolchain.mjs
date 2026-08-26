import { readFile } from 'node:fs/promises';
import path from 'node:path';

const REQUIRED_NODE = [20, 17, 0];
const REQUIRED_NPM = '11.6.2';

function compareVersion(actual, required) {
  const parts = actual.replace(/^v/, '').split('.').map(Number);
  for (let index = 0; index < required.length; index += 1) {
    const difference = (parts[index] ?? 0) - required[index];
    if (difference !== 0) return difference;
  }
  return 0;
}

if (compareVersion(process.version, REQUIRED_NODE) < 0) {
  console.error(
    `[onesub] Node ${REQUIRED_NODE.join('.')} or newer is required; found ${process.version}.`,
  );
  process.exit(1);
}

// Prefer the npm CLI package that launched this lifecycle. An outer `npx`
// process can leave its older user-agent in the environment even though it is
// correctly executing the pinned npm CLI.
let npmVersion;
if (process.env.npm_execpath?.endsWith('npm-cli.js')) {
  try {
    const npmPackage = JSON.parse(
      await readFile(path.resolve(path.dirname(process.env.npm_execpath), '..', 'package.json'), 'utf8'),
    );
    npmVersion = npmPackage.version;
  } catch {
    // Fall back to the lifecycle user-agent below.
  }
}
npmVersion ??= process.env.npm_config_user_agent?.match(/^npm\/([^ ]+)/)?.[1];
if (npmVersion && npmVersion !== REQUIRED_NPM) {
  console.error(
    `[onesub] npm ${REQUIRED_NPM} is required; found ${npmVersion}. Run installs with ` +
      '`corepack npm ci` (or `corepack npm install` when changing dependencies).',
  );
  process.exit(1);
}
