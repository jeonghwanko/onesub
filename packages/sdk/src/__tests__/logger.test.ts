import { describe, it, expect, vi } from 'vitest';
import { createSdkLogger } from '../logger.js';

function makeSink() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe('createSdkLogger', () => {
  it('trace is no-op when debug is false/undefined', () => {
    const sink = makeSink();
    const logger = createSdkLogger({ logger: sink });
    logger.trace('hello');
    expect(sink.info).not.toHaveBeenCalled();
  });

  it('trace routes to sink.info with [onesub] tag when debug is true', () => {
    const sink = makeSink();
    const logger = createSdkLogger({ debug: true, logger: sink });
    logger.trace('event received', { productId: 'p1' });
    expect(sink.info).toHaveBeenCalledWith('[onesub]', 'event received', { productId: 'p1' });
  });

  it('info / warn / error always route to sink, regardless of debug', () => {
    const sink = makeSink();
    const logger = createSdkLogger({ debug: false, logger: sink });
    logger.info('hi');
    logger.warn('oops');
    logger.error('bad');
    expect(sink.info).toHaveBeenCalledWith('[onesub]', 'hi');
    expect(sink.warn).toHaveBeenCalledWith('[onesub]', 'oops');
    expect(sink.error).toHaveBeenCalledWith('[onesub]', 'bad');
  });

  it('falls back to console when no logger is provided', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const logger = createSdkLogger({ debug: true });
      logger.trace('hello');
      expect(spy).toHaveBeenCalledWith('[onesub]', 'hello');
    } finally {
      spy.mockRestore();
    }
  });

  it('trace stays no-op even if logger is provided, when debug is unset', () => {
    const sink = makeSink();
    const logger = createSdkLogger({ logger: sink });
    logger.trace('silent');
    expect(sink.info).not.toHaveBeenCalled();
    expect(sink.warn).not.toHaveBeenCalled();
    expect(sink.error).not.toHaveBeenCalled();
  });
});
