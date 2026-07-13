#!/usr/bin/env node

import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ignoredDirectories = new Set([
  '.git',
  '.next',
  'dist',
  'Library',
  'node_modules',
  'Temp',
]);

const failures = [];

async function collectMarkdown(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectMarkdown(path));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) files.push(path);
  }
  return files;
}

function displayPath(path) {
  return relative(root, path).split(sep).join('/');
}

function lineNumberAt(text, index) {
  return text.slice(0, index).split('\n').length;
}

function normalizeLinkTarget(raw) {
  let target = raw.trim();
  if (target.startsWith('<') && target.includes('>')) {
    target = target.slice(1, target.indexOf('>'));
  } else {
    // Markdown permits an optional title after whitespace. Repository paths do
    // not contain unescaped spaces, so the first token is the target.
    target = target.split(/\s+/u)[0];
  }
  target = target.split('#')[0].split('?')[0];
  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
}

function isExternalOrAnchor(target) {
  return (
    target === '' ||
    target.startsWith('#') ||
    /^(?:https?:|mailto:|data:)/iu.test(target)
  );
}

function referencesGeneratedArtifact(target) {
  return target.split('/').some((segment) => ignoredDirectories.has(segment));
}

async function validateMarkdown(path) {
  const text = await readFile(path, 'utf8');
  const name = displayPath(path);

  for (const match of text.matchAll(/[ \t]+$/gmu)) {
    failures.push(`${name}:${lineNumberAt(text, match.index)} trailing whitespace`);
  }

  // Validate inline Markdown links and images. External URLs and same-page
  // anchors are intentionally skipped; this command requires no network.
  for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/gu)) {
    const rawTarget = match[1].trim();
    if (isExternalOrAnchor(rawTarget)) continue;
    const target = normalizeLinkTarget(rawTarget);
    if (!target) continue;
    const resolved = target.startsWith('/')
      ? resolve(root, `.${target}`)
      : resolve(dirname(path), target);
    if (!existsSync(resolved)) {
      failures.push(`${name}:${lineNumberAt(text, match.index)} broken local link: ${rawTarget}`);
    }
  }

  // Code snippets often name repository source/test files without making them
  // Markdown links. Catch stale package paths such as renamed focused tests.
  for (const match of text.matchAll(/\bpackages\/[A-Za-z0-9_./\-[\]]+\.(?:cs|js|json|md|mjs|ps1|sql|ts|tsx)\b/gu)) {
    const target = match[0];
    // Commands may legitimately reference build output that is absent in a
    // fresh checkout. Source links are still checked for drift.
    if (referencesGeneratedArtifact(target)) continue;
    if (!existsSync(resolve(root, target))) {
      failures.push(`${name}:${lineNumberAt(text, match.index)} missing referenced file: ${target}`);
    }
  }
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

function compareSets(label, sourceValues, documentedValues) {
  const source = sortedUnique(sourceValues);
  const documented = sortedUnique(documentedValues);
  const missing = source.filter((value) => !documented.includes(value));
  const extra = documented.filter((value) => !source.includes(value));
  if (missing.length) failures.push(`${label}: undocumented: ${missing.join(', ')}`);
  if (extra.length) failures.push(`${label}: documented but not registered: ${extra.join(', ')}`);
  return source.length;
}

async function validateWorkspaceMap() {
  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const guide = await readFile(join(root, 'AGENTS.md'), 'utf8');
  for (const workspace of packageJson.workspaces ?? []) {
    if (!guide.includes(workspace)) {
      failures.push(`AGENTS.md: npm workspace is missing from repository map: ${workspace}`);
    }
  }
  return packageJson.workspaces?.length ?? 0;
}

async function validateMcpTools() {
  const source = await readFile(join(root, 'packages/mcp-server/src/index.ts'), 'utf8');
  const docs = await readFile(join(root, 'packages/mcp-server/README.md'), 'utf8');
  const registered = [...source.matchAll(/server\.tool\(\s*['"](onesub_[^'"]+)['"]/gu)]
    .map((match) => match[1]);
  const documented = [...docs.matchAll(/`(onesub_[^`]+)`/gu)].map((match) => match[1]);
  return compareSets('MCP tools', registered, documented);
}

// Canonical route names live in @onesub/shared as ROUTES; openapi.ts keys its
// `paths` off them (or off a literal, for parameterized routes). openapi.test.ts
// already asserts openapi.ts against the actually mounted routers, so binding
// the server README to openapi.ts makes the whole chain machine-checked:
// mounted routers -> openapi.ts -> packages/server/README.md.
function parseRoutesConstant(source) {
  const block = /export const ROUTES = \{([\s\S]*?)\n\} as const;/u.exec(source);
  if (!block) throw new Error('could not locate ROUTES in packages/shared/src/constants.ts');
  const routes = new Map();
  for (const match of block[1].matchAll(/^\s*([A-Z_]+):\s*'([^']+)'/gmu)) {
    routes.set(match[1], match[2]);
  }
  if (!routes.size) throw new Error('parsed no entries from ROUTES');
  return routes;
}

// Express writes `:userId`, OpenAPI writes `{userId}`. Compare in one form.
function canonicalPath(path) {
  return path.split('?')[0].trim().replace(/\{([^}]+)\}/gu, ':$1');
}

function parseOpenApiOperations(source, routes) {
  const operations = [];
  let currentPath = null;
  for (const line of source.split('\n')) {
    const pathKey = /^ {4}(?:\[ROUTES\.([A-Z_]+)\]|'([^']+)'):\s*\{/u.exec(line);
    if (pathKey) {
      const [, routeName, literal] = pathKey;
      if (routeName && !routes.has(routeName)) {
        throw new Error(`openapi.ts references unknown ROUTES.${routeName}`);
      }
      currentPath = canonicalPath(routeName ? routes.get(routeName) : literal);
      continue;
    }
    // Any other line at path-key depth closes the current block. Without this a
    // path key we failed to parse would silently donate its methods to the
    // previous route.
    if (/^ {4}\S/u.test(line)) {
      currentPath = null;
      continue;
    }
    const method = /^ {6}(get|post|put|patch|delete):\s*\{/u.exec(line);
    if (method && currentPath) operations.push(`${method[1].toUpperCase()} ${currentPath}`);
  }
  if (!operations.length) {
    throw new Error('parsed no operations from packages/server/src/openapi.ts — the shape changed');
  }
  return operations;
}

async function validateServerRoutes() {
  const constants = await readFile(join(root, 'packages/shared/src/constants.ts'), 'utf8');
  const openapi = await readFile(join(root, 'packages/server/src/openapi.ts'), 'utf8');
  const docs = await readFile(join(root, 'packages/server/README.md'), 'utf8');

  const specified = parseOpenApiOperations(openapi, parseRoutesConstant(constants));

  // Only middleware-mounted routes are compared. `/openapi.json` is mounted by
  // the host via openapiHandler(), so it is documented without being in the spec.
  const documented = [...docs.matchAll(/^\|\s*`(GET|POST|PUT|PATCH|DELETE)\s+([^`]+)`/gmu)]
    .map((match) => `${match[1]} ${canonicalPath(match[2])}`)
    .filter((entry) => entry.includes(' /onesub/'));

  return compareSets('server routes', specified, documented);
}

async function validateCliCommands() {
  const source = await readFile(join(root, 'packages/cli/src/index.ts'), 'utf8');
  const docs = await readFile(join(root, 'packages/cli/README.md'), 'utf8');
  const commandPattern = /^\s*onesub\s+(init|dev|--help)\b/gmu;
  const registered = [...source.matchAll(commandPattern)].map((match) => match[1]);
  const documented = [...docs.matchAll(commandPattern)].map((match) => match[1]);
  return compareSets('CLI commands', registered, documented);
}

const markdownFiles = await collectMarkdown(root);
await Promise.all(markdownFiles.map(validateMarkdown));
const workspaceCount = await validateWorkspaceMap();
const mcpToolCount = await validateMcpTools();
const cliCommandCount = await validateCliCommands();
const routeCount = await validateServerRoutes();

if (failures.length) {
  console.error(`Documentation validation failed (${failures.length} issue${failures.length === 1 ? '' : 's'}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `Documentation OK: ${markdownFiles.length} Markdown files, ${workspaceCount} workspaces, ` +
  `${mcpToolCount} MCP tools, ${cliCommandCount} CLI commands, ${routeCount} server routes.`,
);
