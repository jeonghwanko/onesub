import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rootManifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const npmCli = process.env.npm_execpath;

if (!npmCli) {
  console.error('Run this check through `npm run package:check` so the pinned npm CLI is available.');
  process.exit(1);
}

function collectExportTargets(value, targets = new Set()) {
  if (typeof value === 'string') {
    if (value.startsWith('./')) targets.add(value.slice(2));
    return targets;
  }
  if (!value || typeof value !== 'object') return targets;
  for (const nested of Object.values(value)) collectExportTargets(nested, targets);
  return targets;
}

function declaredEntryPoints(manifest) {
  const targets = collectExportTargets(manifest.exports);
  for (const field of ['main', 'module', 'types']) {
    if (typeof manifest[field] === 'string') targets.add(manifest[field].replace(/^\.\//, ''));
  }
  if (typeof manifest.bin === 'string') {
    targets.add(manifest.bin.replace(/^\.\//, ''));
  } else if (manifest.bin && typeof manifest.bin === 'object') {
    for (const target of Object.values(manifest.bin)) {
      if (typeof target === 'string') targets.add(target.replace(/^\.\//, ''));
    }
  }
  return targets;
}

const failures = [];

for (const workspace of rootManifest.workspaces) {
  const manifest = JSON.parse(readFileSync(resolve(root, workspace, 'package.json'), 'utf8'));
  if (manifest.private) continue;

  const packed = spawnSync(
    process.execPath,
    [npmCli, 'pack', '--dry-run', '--json', '--ignore-scripts', '--workspace', manifest.name],
    { cwd: root, encoding: 'utf8' },
  );
  if (packed.status !== 0) {
    failures.push(`${manifest.name}: npm pack failed\n${packed.stderr.trim()}`);
    continue;
  }

  let report;
  try {
    [report] = JSON.parse(packed.stdout);
  } catch {
    failures.push(`${manifest.name}: npm pack did not return valid JSON`);
    continue;
  }
  if (!report || !Array.isArray(report.files) || typeof report.size !== 'number') {
    failures.push(`${manifest.name}: npm pack returned an unexpected report shape`);
    continue;
  }

  const files = new Set(report.files.map(({ path }) => path.replaceAll('\\', '/')));
  const testArtifacts = [...files].filter(
    (path) =>
      /(^|\/)(__tests__|tests?)(\/|$)/.test(path) ||
      /(^|\/)[^/]+\.(test|spec)\.[^/]+$/.test(path),
  );
  const credentialLikeFiles = [...files].filter((path) => {
    const basename = path.split('/').at(-1)?.toLowerCase() ?? '';
    const isEnvironmentFile =
      basename === '.env' ||
      (basename.startsWith('.env.') && !/^\.env\.(example|sample|template)$/.test(basename));
    return (
      isEnvironmentFile ||
      basename === 'keystore.properties' ||
      /\.(key|pem|p12|pfx|keystore)$/.test(basename)
    );
  });
  const missingEntryPoints = [...declaredEntryPoints(manifest)].filter((path) => !files.has(path));

  if (testArtifacts.length > 0) {
    failures.push(`${manifest.name}: test artifacts shipped: ${testArtifacts.join(', ')}`);
  }
  if (credentialLikeFiles.length > 0) {
    failures.push(`${manifest.name}: credential-like files shipped: ${credentialLikeFiles.join(', ')}`);
  }
  if (missingEntryPoints.length > 0) {
    failures.push(`${manifest.name}: declared entry points missing: ${missingEntryPoints.join(', ')}`);
  }

  console.log(`[package:check] ${manifest.name}: ${files.size} files, ${report.size} bytes`);
}

if (failures.length > 0) {
  console.error(`Package validation failed (${failures.length} issue${failures.length === 1 ? '' : 's'}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[package:check] All public package archives passed.');
