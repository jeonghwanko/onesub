import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rootPackage = JSON.parse(await readFile(path.join(rootDir, 'package.json'), 'utf8'));
const workspacePaths = rootPackage.workspaces ?? [];
const packages = new Map();

for (const workspacePath of workspacePaths) {
  if (workspacePath.includes('*')) {
    throw new Error(`[audit:prod] Glob workspaces are not supported yet: ${workspacePath}`);
  }
  const manifest = JSON.parse(
    await readFile(path.join(rootDir, workspacePath, 'package.json'), 'utf8'),
  );
  packages.set(manifest.name, { manifest, workspacePath });
}

const sdkName = '@jeonghwanko/onesub-sdk';
const ordinaryWorkspaces = [...packages.keys()].filter((name) => name !== sdkName);

function runNpm(args, cwd = rootDir) {
  const npmExecPath = process.env.npm_execpath;
  const command = npmExecPath ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const commandArgs = npmExecPath ? [npmExecPath, ...args] : args;
  const result = spawnSync(command, commandArgs, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

const workspaceArgs = ordinaryWorkspaces.flatMap((name) => ['--workspace', name]);
let exitCode = runNpm(['audit', '--omit=dev', ...workspaceArgs, '--audit-level=high']);

// The React Native SDK intentionally leaves host-owned native packages as
// peers. npm's workspace audit follows optional peer edges and reports the
// host's toolchain, so audit the SDK's actual shipped dependency closure in an
// isolated lockfile instead. This still catches any future direct runtime
// dependency added to the SDK or one of its local workspace dependencies.
if (packages.has(sdkName)) {
  const externalDependencies = {};
  const visited = new Set();

  function collectRuntimeDependencies(packageName) {
    if (visited.has(packageName)) return;
    visited.add(packageName);
    const workspace = packages.get(packageName);
    if (!workspace) return;

    const runtimeDependencies = {
      ...workspace.manifest.dependencies,
      ...workspace.manifest.optionalDependencies,
    };
    for (const [dependencyName, version] of Object.entries(runtimeDependencies)) {
      if (packages.has(dependencyName)) {
        collectRuntimeDependencies(dependencyName);
      } else {
        externalDependencies[dependencyName] = version;
      }
    }
  }

  collectRuntimeDependencies(sdkName);

  if (Object.keys(externalDependencies).length === 0) {
    console.log('[audit:prod] SDK shipped dependency closure has no external packages.');
  } else {
    const auditDir = await mkdtemp(path.join(tmpdir(), 'onesub-sdk-audit-'));
    try {
      await writeFile(
        path.join(auditDir, 'package.json'),
        `${JSON.stringify({ name: 'onesub-sdk-production-audit', private: true, dependencies: externalDependencies }, null, 2)}\n`,
      );
      const installCode = runNpm(
        ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'],
        auditDir,
      );
      if (installCode !== 0) {
        exitCode = installCode;
      } else {
        exitCode = Math.max(
          exitCode,
          runNpm(['audit', '--omit=dev', '--audit-level=high'], auditDir),
        );
      }
    } finally {
      await rm(auditDir, { recursive: true, force: true });
    }
  }
}

process.exitCode = exitCode;
