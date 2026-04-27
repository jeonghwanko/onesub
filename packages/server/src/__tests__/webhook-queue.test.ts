import { describe, expect, it } from 'vitest';
import { InProcessWebhookQueue } from '../webhook-queue.js';
import type { WebhookJob } from '../webhook-queue.js';

describe('InProcessWebhookQueue', () => {
  it('runs the handler synchronously inside enqueue', async () => {
    const queue = new InProcessWebhookQueue();
    const seen: WebhookJob[] = [];
    queue.setHandler(async (job) => {
      seen.push(job);
    });
    await queue.enqueue({ provider: 'apple', eventId: 'uuid-1', payload: { foo: 'bar' } });
    expect(seen).toHaveLength(1);
    expect(seen[0].eventId).toBe('uuid-1');
  });

  it('throws if no handler has been registered', async () => {
    const queue = new InProcessWebhookQueue();
    await expect(
      queue.enqueue({ provider: 'apple', eventId: 'uuid-1', payload: {} }),
    ).rejects.toThrow(/no handler/);
  });

  it('propagates handler errors to enqueue', async () => {
    const queue = new InProcessWebhookQueue();
    queue.setHandler(async () => {
      throw new Error('downstream failed');
    });
    await expect(
      queue.enqueue({ provider: 'apple', eventId: 'uuid-1', payload: {} }),
    ).rejects.toThrow(/downstream failed/);
  });
});
