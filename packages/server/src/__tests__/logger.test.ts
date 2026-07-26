/**
 * The process-wide logger: routing, and the shape of what reaches the sink.
 *
 * The escaping and rendering details moved to `log-format.test.ts`, which tests them
 * as properties of a pure function over a hostile matrix rather than one case at a
 * time. What is left here is what only this module can answer: that each level goes
 * where it should, and that a sink receives **exactly one string argument**.
 *
 * That last one is the load-bearing assertion. It is the contract every documented
 * sink depends on — `pino` treats a second argument as a printf interpolation
 * parameter, not as structured fields, so anything "helpfully" passing fields
 * alongside the message would silently degrade for the sink this package recommends
 * for production. There is also then no shape for a JSON serialiser to drop: an
 * `Error` passed as an object would serialise to `{}`, because its own properties
 * are non-enumerable.
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

describe('the sink always receives exactly one string', () => {
  it('for a message on its own', () => {
    const { logger, calls } = recorder();
    setLogger(logger);

    log.info('[onesub/apple] receipt rejected');

    expect(calls[0]!.args).toEqual(['[onesub/apple] receipt rejected']);
  });

  it('for a message with fields', () => {
    // Fields are rendered into that one string rather than passed alongside it.
    // Passing them alongside works on `console`, whose util.inspect escapes strings
    // inside objects — but not on `pino`, which would treat the object as a printf
    // argument. Rendering here is what makes the guarantee hold on every sink.
    const { logger, calls } = recorder();
    setLogger(logger);

    log.warn('account binding mismatch', { route: 'validate', userId: 'alice' });

    expect(calls[0]!.args).toHaveLength(1);
    expect(calls[0]!.args[0]).toBe('account binding mismatch route=validate userId=alice');
  });

  it('for a message with an Error', () => {
    const { logger, calls } = recorder();
    setLogger(logger);

    log.error('validation failed', { userId: 'alice', err: new Error('boom') });

    expect(calls[0]!.args).toHaveLength(1);
    const line = calls[0]!.args[0] as string;
    expect(typeof line).toBe('string');
    expect(line).toContain('err=Error');
    expect(line).toContain('err.msg=boom');
    // The stack survives, as continuation lines rather than a flattened blob.
    expect(line).toContain('\n    | at ');
  });

  it('for a legacy varargs call that has not been migrated yet', () => {
    // Call sites move file by file, so an un-migrated one still has to render
    // sensibly — that is what makes the migration incremental, not a flag day.
    const { logger, calls } = recorder();
    setLogger(logger);

    log.warn('[onesub/apple] Bundle ID mismatch:', 'com.evil', '!==', 'com.real');

    expect(calls[0]!.args).toEqual(['[onesub/apple] Bundle ID mismatch: com.evil !== com.real']);
  });
});

describe('log-line forgery, end to end', () => {
  it('a newline in a logged value cannot start a new line', () => {
    // The matrix version of this lives in log-format.test.ts. This one proves the
    // facade actually routes through the formatter, which no pure test can show.
    const { logger, calls } = recorder();
    setLogger(logger);

    log.warn('user lookup', { userId: 'alice\n[onesub] admin granted premium to mallory' });

    const line = calls[0]!.args[0] as string;
    expect(line.split('\n')).toHaveLength(1);
    expect(line).toContain('\\n');
    // The attempt stays legible — a guarantee that hid it would be worse than none.
    expect(line).toContain('admin granted premium to mallory');
  });

  it('leaves ordinary text alone, including tabs', () => {
    const { logger, calls } = recorder();
    setLogger(logger);

    log.info('[onesub/apple] bundle\tid ok — 100% fine');

    expect(calls[0]!.args[0]).toBe('[onesub/apple] bundle\tid ok — 100% fine');
  });
});
