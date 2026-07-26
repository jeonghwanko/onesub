/**
 * The process-wide logger, and specifically that a caller cannot forge log lines.
 *
 * Much of what this server logs is attacker-influenced — `userId` arrives in the
 * request body, and bundle ids, package names and receipt previews come out of
 * submitted receipts. A newline in any of those would let a caller end the current
 * line and write an entry of their own, and these logs are what support and fraud
 * decisions get read from.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OneSubLogger } from '@onesub/shared';
import { log, setLogger } from '../logger.js';

/** Captures the exact argument list each level received. */
function recorder() {
  const calls: { level: string; args: unknown[] }[] = [];
  const logger: OneSubLogger = {
    info: (...args: unknown[]) => calls.push({ level: 'info', args }),
    warn: (...args: unknown[]) => calls.push({ level: 'warn', args }),
    error: (...args: unknown[]) => calls.push({ level: 'error', args }),
  };
  return { logger, calls };
}

afterEach(() => {
  // The logger is module-level state; hand it back to console so one test cannot
  // silently capture another file's output.
  setLogger(console);
  vi.restoreAllMocks();
});

describe('routing', () => {
  it('sends each level to the configured logger', () => {
    const { logger, calls } = recorder();
    setLogger(logger);

    log.info('i');
    log.warn('w');
    log.error('e');

    expect(calls.map((c) => c.level)).toEqual(['info', 'warn', 'error']);
  });

  it('ignores an undefined logger rather than losing output', () => {
    const { logger, calls } = recorder();
    setLogger(logger);
    setLogger(undefined);

    log.info('still here');

    expect(calls).toHaveLength(1);
  });
});

describe('log-line forgery', () => {
  it('escapes a newline in a user-controlled value', () => {
    const { logger, calls } = recorder();
    setLogger(logger);

    // What a malicious userId would try to do.
    log.warn(`[onesub/status] userId: alice\n[onesub] admin granted premium to mallory`);

    const line = calls[0]!.args[0] as string;
    expect(line).not.toContain('\n');
    expect(line).toContain('\\n');
    // The attempt is still legible — scrubbing must not hide that it happened.
    expect(line).toContain('admin granted premium to mallory');
  });

  it('escapes carriage returns and unicode line separators', () => {
    const { logger, calls } = recorder();
    setLogger(logger);

    log.info('a\rb c d');

    const line = calls[0]!.args[0] as string;
    expect(line).toBe('a\\rb\\u2028c\\u2029d');
  });

  it('scrubs every string argument, not only the first', () => {
    const { logger, calls } = recorder();
    setLogger(logger);

    log.error('prefix', 'mid\ndle', 'suffix\n');

    expect(calls[0]!.args).toEqual(['prefix', 'mid\\ndle', 'suffix\\n']);
  });

  it('keeps a real newline distinguishable from a submitted backslash-n', () => {
    // Escaping `\n` to `\` + `n` without escaping `\` first makes these two
    // inputs render identically, and an operator reading the log then cannot
    // tell an escaped terminator from two characters the caller typed — which
    // is the forensic value the escaping exists to protect.
    const { logger, calls } = recorder();
    setLogger(logger);

    log.warn('userId: alice\nFORGED');
    log.warn('userId: alice\\nFORGED');

    const [fromRealNewline, fromLiteral] = calls.map((c) => c.args[0] as string);
    expect(fromRealNewline).toBe('userId: alice\\nFORGED');
    expect(fromLiteral).toBe('userId: alice\\\\nFORGED');
    expect(fromRealNewline).not.toBe(fromLiteral);
  });

  it('escapes a backslash before anything that produces one', () => {
    const { logger, calls } = recorder();
    setLogger(logger);

    log.info('path C:\\tmp\\r');

    // Neither the `\t` nor the `\r` here is a control character — they are
    // literal pairs, and must not be mistaken for escaped ones.
    expect(calls[0]!.args[0]).toBe('path C:\\\\tmp\\\\r');
  });

  it('leaves ordinary text untouched, including tabs', () => {
    const { logger, calls } = recorder();
    setLogger(logger);

    log.info('[onesub/apple] bundle\tid ok — 100% fine');

    expect(calls[0]!.args[0]).toBe('[onesub/apple] bundle\tid ok — 100% fine');
  });

  it('passes non-strings through unchanged', () => {
    // Structured loggers serialise objects and Errors themselves; rewriting them
    // here would corrupt what the operator asked to see.
    const { logger, calls } = recorder();
    setLogger(logger);
    const err = new Error('boom');
    const detail = { userId: 'alice\nnot-scrubbed-here', count: 2 };

    log.error('failed:', err, detail, 42, null, undefined);

    expect(calls[0]!.args[1]).toBe(err);
    expect(calls[0]!.args[2]).toBe(detail);
    expect(calls[0]!.args.slice(3)).toEqual([42, null, undefined]);
  });
});
