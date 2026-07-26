/**
 * The `onesub init` templates must scaffold a project on a current server.
 *
 * ## Why this test exists
 *
 * `templates/package.json` pinned `@onesub/server: ^0.7.0` while the published server
 * was on `0.27.0`. A caret range on a `0.x` version admits only patches — `^0.7.0`
 * resolves to `0.7.x` — so every `onesub init` scaffolded a project **twenty minors
 * behind**, missing the log formatter, the conditional webhook mount and the webhook
 * authentication requirement. It had been that way since the express
 * peerDependencies move.
 *
 * Nothing caught it, and that is the interesting part. Changesets bumps *workspace*
 * versions; this file is copied template content, not a workspace, so no release step
 * touches it. `docs:check` validates links and catalogues, not dependency ranges. The
 * only mechanism was remembering — and twenty releases is a fair sample of how well
 * that works.
 *
 * So the fix is not just the bump. Releasing a server minor now has to bump this pin
 * too, and this test is what says so, at the release that introduces the drift rather
 * than a year later.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const CLI = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const REPO = dirname(dirname(CLI));

function readJson<T>(...parts: string[]): T {
  return JSON.parse(readFileSync(join(...parts), 'utf8')) as T;
}

/**
 * Does a caret range admit this version?
 *
 * Hand-rolled rather than pulling in `semver`, because the CLI has no runtime
 * dependency on it and adding one to satisfy a test is the wrong trade. Only the
 * shapes this repo actually writes are handled: `^x.y.z` and an exact version. A
 * range this cannot parse throws rather than silently passing — a test that quietly
 * approves an unrecognised pin is worse than no test.
 */
function caretAdmits(range: string, version: string): boolean {
  const v = version.split('.').map(Number);
  if (v.length !== 3 || v.some(Number.isNaN)) throw new Error(`unparseable version: ${version}`);

  if (/^\d+\.\d+\.\d+$/.test(range)) return range === version;

  const m = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range);
  if (!m) throw new Error(`unhandled range shape, teach this test about it: ${range}`);
  const [lo0, lo1, lo2] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const [hi0, hi1, hi2] = v as [number, number, number];

  // Below the floor is out, whatever the majors do.
  if (hi0 < lo0) return false;
  if (hi0 === lo0 && (hi1 < lo1 || (hi1 === lo1 && hi2 < lo2))) return false;

  // npm treats a 0.x caret as minor-locked: ^0.7.0 is >=0.7.0 <0.8.0. That is the
  // whole reason the pin went stale, so it is the case worth being explicit about.
  if (lo0 === 0) return hi0 === 0 && hi1 === lo1;
  return hi0 === lo0;
}

describe('caretAdmits', () => {
  // The helper decides whether the assertion below means anything, so it is tested
  // before it is trusted.
  it('locks a 0.x caret to its minor', () => {
    expect(caretAdmits('^0.7.0', '0.7.5')).toBe(true);
    expect(caretAdmits('^0.7.0', '0.8.0')).toBe(false);
    expect(caretAdmits('^0.7.0', '0.27.0')).toBe(false);
    expect(caretAdmits('^0.27.0', '0.27.1')).toBe(true);
  });

  it('allows minors on a stable major', () => {
    expect(caretAdmits('^5.2.1', '5.9.0')).toBe(true);
    expect(caretAdmits('^5.2.1', '6.0.0')).toBe(false);
    expect(caretAdmits('^5.2.1', '5.2.0')).toBe(false);
  });

  it('matches an exact pin exactly', () => {
    expect(caretAdmits('0.27.0', '0.27.0')).toBe(true);
    expect(caretAdmits('0.27.0', '0.27.1')).toBe(false);
  });

  it('refuses to guess at a range shape it does not know', () => {
    expect(() => caretAdmits('>=0.27 <1', '0.27.0')).toThrow(/unhandled range shape/);
    expect(() => caretAdmits('~0.27.0', '0.27.0')).toThrow(/unhandled range shape/);
  });
});

describe('onesub init templates', () => {
  const serverVersion = readJson<{ version: string }>(REPO, 'packages/server/package.json').version;

  it('scaffolds a project that can install the current server', () => {
    const range = readJson<{ dependencies: Record<string, string> }>(CLI, 'templates/package.json')
      .dependencies['@onesub/server'];

    expect(range).toBeDefined();
    expect(
      caretAdmits(range!, serverVersion),
      `templates/package.json pins @onesub/server ${range}, which cannot install ` +
        `${serverVersion}. On a 0.x version a caret admits only patches, so bump the ` +
        `pin in the same change as the server release.`,
    ).toBe(true);
  });

  it('keeps every template the CLI copies present', () => {
    // A missing template makes `onesub init` produce a half-scaffolded project, and
    // the failure surfaces at the user rather than here.
    const src = readFileSync(join(CLI, 'src/index.ts'), 'utf8');
    const declared = [...src.matchAll(/\{\s*src:\s*'([^']+)'/g)].map((m) => m[1]!);

    expect(declared.length).toBeGreaterThan(3);
    for (const file of declared) {
      expect(() => readFileSync(join(CLI, 'templates', file), 'utf8')).not.toThrow();
    }
  });
});
