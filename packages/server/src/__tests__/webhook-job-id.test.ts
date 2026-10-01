/**
 * bullmq is an optional peer and is not installed in this repository, so the
 * BullMQ queue's `add()` never runs in tests. This holds the job id to the rule
 * BullMQ 5 enforces in `Job.validateOptions` instead — the rule the old
 * `${provider}:${eventId}` id broke on every enqueue.
 */

import { describe, it, expect } from 'vitest';
import { webhookJobId } from '../webhook-queue.js';

/** Mirrors bullmq@5 `Job.validateOptions` jobId checks (dist/cjs/classes/job.js). */
function bullmqAcceptsJobId(jobId: string): boolean {
  if (`${parseInt(jobId, 10)}` === jobId) return false;
  if (jobId.includes(':') && jobId.split(':').length !== 3) return false;
  return true;
}

describe('webhookJobId', () => {
  it.each([
    ['apple', '6f5a0b3e-2c1d-4e8f-9a7b-1c2d3e4f5a6b'],
    ['google', '1234567890123456'],
    ['google', '1'],
  ] as const)('produces an id BullMQ accepts for %s event %s', (provider, eventId) => {
    const id = webhookJobId({ provider, eventId });
    expect(bullmqAcceptsJobId(id)).toBe(true);
  });

  it('keeps providers apart for the same event id', () => {
    expect(webhookJobId({ provider: 'apple', eventId: 'x' })).not.toBe(
      webhookJobId({ provider: 'google', eventId: 'x' }),
    );
  });

  it('the previous colon-joined id is exactly what BullMQ rejects', () => {
    expect(bullmqAcceptsJobId('apple:6f5a0b3e-2c1d-4e8f-9a7b-1c2d3e4f5a6b')).toBe(false);
  });
});
