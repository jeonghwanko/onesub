/**
 * Holds every `log.*` call site in the package to the field vocabulary declared in
 * `log-format.ts`.
 *
 * Why a source-scanning test rather than more per-call-site assertions. The value of
 * moving data out of the message is that an operator can filter on `productId` — and
 * that value is destroyed by one file calling it `product`, silently, on a path no
 * test happens to exercise. That is not hypothetical: while building
 * `provider-log-fields.test.ts` a mutation renaming `productId` to `product` at the
 * "No orderId in product purchase" site **passed all 13 of its tests**, because that
 * site is not one of the ones asserted. Covering ~100 sites individually to close
 * that gap is not maintainable; checking the vocabulary once, over all of them, is.
 *
 * The vocabulary lives in `log-format.ts`'s module doc and is parsed out of it here,
 * so there is exactly one list. A doc comment is an odd place for an enforced
 * contract, but the alternative — an exported `const` array — would ship a
 * test-only value in the bundle that `npm run size` gates.
 *
 * What this test cannot do: it does not know whether a field is *correctly named*
 * for its value, only that the name is one of the sanctioned ones. `bundleId:
 * tx.productId` passes here. Per-site assertions in `provider-log-fields.test.ts`
 * cover that for the paths that matter.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const SRC = dirname(dirname(fileURLToPath(import.meta.url)));

/** Every .ts file under packages/server/src, excluding tests. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__' || entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * The argument text of every `log.<level>( ... )` call, with string literals blanked.
 *
 * Blanking rather than removing keeps offsets stable and, more importantly, stops a
 * message like `'state:'` from being mistaken for a field key.
 */
function logCallArgs(src: string): string[] {
  const calls: string[] = [];
  const re = /\blog\.(?:info|warn|error)\(/g;
  let match: RegExpExecArray | null;

  while ((match = re.exec(src)) !== null) {
    let i = match.index + match[0].length;
    const start = i;
    let depth = 1;
    let text = '';

    while (i < src.length && depth > 0) {
      const ch = src[i]!;
      if (ch === "'" || ch === '"' || ch === '`') {
        // Skip the literal, emitting spaces so a quoted `foo:` cannot read as a key.
        const quote = ch;
        text += ' ';
        i++;
        while (i < src.length && src[i] !== quote) {
          if (src[i] === '\\') {
            text += ' ';
            i++;
          }
          text += ' ';
          i++;
        }
        text += ' ';
        i++;
        continue;
      }
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (depth > 0) text += ch;
      i++;
    }

    if (start < src.length) calls.push(text);
  }

  return calls;
}

/**
 * Field keys used in one log call — `{ a: expr, b }` yields `a` and `b`.
 *
 * A regex cannot do this: `{ product: productId }` matches `productId` as a
 * shorthand key just as readily as `product`, which made the first version of this
 * test report both. So it walks the object at brace depth 1, reading an identifier
 * as a key and then, if a `:` follows, skipping the value expression entirely.
 *
 * Still not an AST — nested objects and arrays are skipped as opaque values rather
 * than descended into, because a nested field is not something an operator filters
 * on anyway.
 */
function fieldKeys(callText: string): string[] {
  const open = callText.indexOf('{');
  if (open === -1) return [];

  const keys: string[] = [];
  let i = open + 1;
  let depth = 1;

  while (i < callText.length && depth > 0) {
    const ch = callText[i]!;

    if (/\s|,/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '}') break;

    // An identifier in key position.
    const ident = /^[A-Za-z_$][\w$]*/.exec(callText.slice(i));
    if (!ident) {
      i++;
      continue;
    }
    const name = ident[0];
    let j = i + name.length;
    while (j < callText.length && /\s/.test(callText[j]!)) j++;

    if (callText[j] === ':') {
      // `name: <expr>` — record the key, then skip the value to the next comma at
      // this depth (or the closing brace).
      keys.push(name);
      j++;
      while (j < callText.length) {
        const v = callText[j]!;
        if (v === '{' || v === '[') depth++;
        else if (v === ']') depth--;
        else if (v === '}') {
          if (depth === 1) break;
          depth--;
        } else if (v === ',' && depth === 1) break;
        j++;
      }
      i = j;
      continue;
    }

    // Shorthand `{ name }` or `{ name, ... }`.
    if (callText[j] === ',' || callText[j] === '}' || j >= callText.length) keys.push(name);
    i = j;
  }

  return keys;
}

/** Parse the enforced list out of `log-format.ts`'s module doc. */
function vocabulary(): Set<string> {
  const src = readFileSync(join(SRC, 'log-format.ts'), 'utf8');
  const block = /FIELD VOCABULARY START([\s\S]*?)FIELD VOCABULARY END/.exec(src);
  if (!block) throw new Error('log-format.ts no longer declares a FIELD VOCABULARY block');
  return new Set(block[1]!.match(/[A-Za-z_$][\w$]*/g) ?? []);
}

describe('log field vocabulary', () => {
  const allowed = vocabulary();

  it('is declared in log-format.ts and non-trivial', () => {
    // A parse that silently produced {} would make every assertion below vacuous.
    expect(allowed.size).toBeGreaterThan(10);
    expect(allowed.has('productId')).toBe(true);
    expect(allowed.has('err')).toBe(true);
  });

  it('covers every field name used at every log call site', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(SRC)) {
      const src = readFileSync(file, 'utf8');
      for (const call of logCallArgs(src)) {
        for (const key of fieldKeys(call)) {
          if (!allowed.has(key)) offenders.push(`${file.slice(SRC.length + 1)}: ${key}`);
        }
      }
    }

    // Listing them is the point — the message has to say which name to fix.
    expect(offenders).toEqual([]);
  });

  it('actually finds the call sites it claims to check', () => {
    // Without this, a regex that matched nothing would report a clean sweep.
    const apple = readFileSync(join(SRC, 'providers', 'apple.ts'), 'utf8');
    const calls = logCallArgs(apple);
    const keys = calls.flatMap(fieldKeys);

    expect(calls.length).toBeGreaterThan(20);
    expect(keys).toContain('bundleId');
    expect(keys).toContain('originalTransactionId');
    expect(keys).toContain('err');
  });

  it('does not mistake text inside a message for a field name', () => {
    // The pre-migration style was `log.warn('... state:', value)`. If the scanner
    // read inside string literals, `state` would look like a field key.
    const keys = logCallArgs(`log.warn('[onesub/x] Purchase not completed, state:', v);`).flatMap(fieldKeys);

    expect(keys).toEqual([]);
  });

  it('rejects a synonym, which is the drift it exists to catch', () => {
    const keys = logCallArgs(`log.warn('msg', { product: productId });`).flatMap(fieldKeys);

    expect(keys).toEqual(['product']);
    expect(allowed.has('product')).toBe(false);
  });
});
