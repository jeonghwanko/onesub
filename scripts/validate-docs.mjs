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

if (failures.length) {
  console.error(`Documentation validation failed (${failures.length} issue${failures.length === 1 ? '' : 's'}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `Documentation OK: ${markdownFiles.length} Markdown files, ${workspaceCount} workspaces, ` +
  `${mcpToolCount} MCP tools, ${cliCommandCount} CLI commands.`,
);
