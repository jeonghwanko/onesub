/**
 * formatLogArgs — the security properties of log rendering.
 *
 * These live here rather than in `logger.test.ts` because they are properties of a
 * pure function from arguments to a string. `logger.ts` holds process-global state
 * and needs `setLogger` juggling; nothing that carries a security claim should
 * depend on that.
 *
 * The central claim is one property, asserted over a hostile matrix rather than
 * case by case: **no byte supplied by a caller can begin a line.** Everything else
 * here is either a corollary or a guard against the formatter throwing on input it
 * will genuinely receive.
 */

import { describe, expect, it } from 'vitest';
import { formatLogArgs, LOG_CONTINUATION } from '../log-format.js';

/** Written as escapes on purpose: a raw U+2028 is a line terminator in source too. */
const LS = '\u2028';
const PS = '\u2029';

const CONTINUATION_PREFIX = LOG_CONTINUATION.slice(1); // without the leading \n

/** The claim, as a function. Every case in the matrix is checked against this. */
function everyLineIsOursOrTheFirst(output: string): boolean {
  const [, ...rest] = output.split('\n');
  return rest.every((line) => line.startsWith(CONTINUATION_PREFIX));
}

/** No terminator other than the ones we write ourselves may survive. */
function hasNoStrayTerminator(output: string): boolean {
  return !output.includes('\r') && !output.includes(LS) && !output.includes(PS);
}

function erroring(message: string): Error {
  // A real Error, so it carries a real multi-line stack.
  return new Error(message);
}

describe('the line invariant', () => {
  const FORGERY = '[onesub] admin granted premium to mallory';

  const hostile: Array<{ name: string; args: unknown[] }> = [
    { name: 'newline in the message', args: [`userId: alice\n${FORGERY}`] },
    { name: 'carriage return in the message', args: [`userId: alice\r${FORGERY}`] },
    { name: 'CRLF in the message', args: [`userId: alice\r\n${FORGERY}`] },
    { name: 'U+2028 in the message', args: [`userId: alice${LS}${FORGERY}`] },
    { name: 'U+2029 in the message', args: [`userId: alice${PS}${FORGERY}`] },
    { name: 'newline in a field value', args: ['lookup', { userId: `alice\n${FORGERY}` }] },
    { name: 'newline in a field KEY', args: ['lookup', { [`a\n${FORGERY}`]: 'x' }] },
    { name: 'newline in a nested object', args: ['lookup', { detail: { userId: `a\n${FORGERY}` } }] },
    { name: 'newline in an array field', args: ['lookup', { skus: [`a\n${FORGERY}`] }] },
    { name: 'error message with a newline', args: ['failed', { err: erroring(`boom\n${FORGERY}`) }] },
    { name: 'error as a positional arg', args: ['failed:', erroring(`boom\n${FORGERY}`)] },
    { name: 'error with a cause chain', args: ['failed', { err: new Error('outer', { cause: erroring(`inner\n${FORGERY}`) }) }] },
    { name: 'aggregate error', args: ['failed', { err: new AggregateError([erroring(`a\n${FORGERY}`), erroring('b')], 'many') }] },
    { name: 'thrown string', args: ['failed', { err: `boom\n${FORGERY}` }] },
    { name: 'thrown object', args: ['failed', { err: { toString: () => `boom\n${FORGERY}` } }] },
    { name: 'legacy varargs with a newline', args: ['prefix:', `a\n${FORGERY}`, 'suffix'] },
    { name: 'a literal backslash-n, not a terminator', args: [`userId: alice\\n${FORGERY}`] },
  ];

  for (const { name, args } of hostile) {
    it(`holds for ${name}`, () => {
      const output = formatLogArgs(args);
      expect(everyLineIsOursOrTheFirst(output)).toBe(true);
      expect(hasNoStrayTerminator(output)).toBe(true);
      // The attempt must still be legible — a guarantee that hid the attack would
      // be worse than none, because nobody would know it happened.
      expect(output).toContain('admin granted premium to mallory');
    });
  }

  it('distinguishes a real terminator from a submitted backslash-n', () => {
    // 0.23.1 shipped an escape that rendered these identically. If they collapse
    // again, an operator cannot tell an escaped newline from two typed characters.
    const fromReal = formatLogArgs(['x', { userId: 'alice\nFORGED' }]);
    const fromLiteral = formatLogArgs(['x', { userId: 'alice\\nFORGED' }]);
    expect(fromReal).not.toBe(fromLiteral);
  });
});

describe('field quoting is a control, not formatting', () => {
  /** Count `key=` occurrences outside quotes, the way a logfmt parser would. */
  function bareKeyCount(output: string, key: string): number {
    let count = 0;
    let inQuote = false;
    for (let i = 0; i < output.length; i++) {
      const ch = output[i];
      if (ch === '"' && output[i - 1] !== '\\') inQuote = !inQuote;
      if (!inQuote && output.startsWith(`${key}=`, i)) count++;
    }
    return count;
  }

  it('a value containing key=value does not become a second field', () => {
    // Unquoted, Loki / Splunk / CloudWatch Insights would parse two fields here.
    const output = formatLogArgs(['lookup', { userId: 'alice productId=hacked' }]);
    expect(bareKeyCount(output, 'productId')).toBe(0);
    expect(bareKeyCount(output, 'userId')).toBe(1);
  });

  it('a quote inside a value cannot close the value early', () => {
    const output = formatLogArgs(['lookup', { userId: 'a" productId=hacked "b' }]);
    expect(bareKeyCount(output, 'productId')).toBe(0);
  });

  it('a backslash before a quote cannot escape the escaping', () => {
    const output = formatLogArgs(['lookup', { userId: 'a\\" productId=hacked' }]);
    expect(bareKeyCount(output, 'productId')).toBe(0);
  });

  it('leaves plain tokens unquoted so lines stay readable', () => {
    const output = formatLogArgs(['lookup', { userId: 'alice', productId: 'pro_monthly' }]);
    expect(output).toBe('lookup userId=alice productId=pro_monthly');
  });
});

describe('errors keep their stack', () => {
  it('renders frames as continuation lines, not as one flattened line', () => {
    const output = formatLogArgs(['validation failed', { userId: 'alice', err: erroring('boom') }]);

    expect(output).toContain('err=Error');
    expect(output).toContain('err.msg=boom');
    expect(output).toContain(`${LOG_CONTINUATION}at `);
    // More than one frame, i.e. the stack was not truncated to a single line.
    expect(output.split(LOG_CONTINUATION).length).toBeGreaterThan(2);
  });

  it('drops the header even when the error message spans lines', () => {
    // The header is `Name: message`, which is multi-line when the message is. If it
    // leaked into the frames the forged text would appear at a line start.
    const output = formatLogArgs(['failed', { err: erroring('boom\n    at fake (evil.js:1:1)') }]);
    const frames = output.split(LOG_CONTINUATION).slice(1);
    expect(frames.every((f) => f.startsWith('at ') || f.startsWith('cause:') || f.startsWith('also:'))).toBe(true);
  });

  it('follows a cause chain but does not follow it forever', () => {
    let err = erroring('root');
    for (let i = 0; i < 10; i++) err = new Error(`wrap${i}`, { cause: err });
    const output = formatLogArgs(['failed', { err }]);
    // Bounded: a cause chain is reachable through provider error wrapping, so an
    // unbounded walk is a way to turn one log call into a very large write.
    expect(output.split('cause:').length - 1).toBeLessThanOrEqual(2);
  });

  it('handles a non-Error throw without a stack', () => {
    expect(formatLogArgs(['failed', { err: 'just a string' }])).toContain('err.msg=');
    expect(formatLogArgs(['failed', { err: 42 }])).toContain('err.msg=');
    expect(formatLogArgs(['failed', { err: null }])).toContain('failed');
  });
});

describe('never throws on input it will actually receive', () => {
  const nasty: Array<{ name: string; value: unknown }> = [
    { name: 'a circular object', value: (() => { const o: Record<string, unknown> = {}; o['self'] = o; return o; })() },
    { name: 'a throwing getter', value: { get boom() { throw new Error('nope'); } } },
    { name: 'a throwing toString', value: { toString() { throw new Error('nope'); } } },
    { name: 'a symbol', value: Symbol('s') },
    { name: 'a function', value: () => undefined },
    { name: 'a bigint', value: 10n },
    { name: 'a deeply nested object', value: { a: { b: { c: { d: { e: 1 } } } } } },
  ];

  for (const { name, value } of nasty) {
    it(`survives ${name}`, () => {
      expect(() => formatLogArgs(['x', { field: value }])).not.toThrow();
      expect(() => formatLogArgs(['x', value])).not.toThrow();
    });
  }

  it('omits undefined fields and renders null explicitly', () => {
    const output = formatLogArgs(['x', { a: undefined, b: null, c: 0, d: false }]);
    expect(output).not.toContain('a=');
    expect(output).toContain('b=null');
    expect(output).toContain('c=0');
    expect(output).toContain('d=false');
  });

  it('handles no arguments and an empty fields object', () => {
    expect(formatLogArgs([])).toBe('');
    expect(formatLogArgs(['x', {}])).toBe('x');
  });
});

describe('exact shape', () => {
  // Three snapshots only, as executable documentation of the format. Any more and
  // the suite becomes a formatting snapshot that blocks future adjustment.
  it('message only', () => {
    expect(formatLogArgs(['[onesub/apple] receipt rejected'])).toBe('[onesub/apple] receipt rejected');
  });

  it('message and fields', () => {
    expect(formatLogArgs(['[onesub/validate] account binding mismatch', {
      route: 'validate',
      userId: 'alice',
      originalTransactionId: '2000000123',
    }])).toBe(
      '[onesub/validate] account binding mismatch route=validate userId=alice originalTransactionId=2000000123',
    );
  });

  it('legacy varargs still render sensibly during the migration', () => {
    // Call sites move file by file; an un-migrated one must not produce garbage.
    expect(formatLogArgs(['[onesub/apple] Bundle ID mismatch:', 'com.evil', '!==', 'com.real'])).toBe(
      '[onesub/apple] Bundle ID mismatch: com.evil !== com.real',
    );
  });
});
