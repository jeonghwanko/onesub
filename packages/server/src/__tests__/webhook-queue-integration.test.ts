/**
 * Integration tests for the webhook queue wiring (config.webhookQueue).
 *
 * Covers:
 *   - Queue mode: gating runs inline, decoded work is enqueued, the handler
 *     registered in createWebhookRouter applies the state change (Apple + Google)
 *   - Queue mode gating: invalid payloads 400 inline and are never enqueued;
 *     duplicate event ids are deduped without a second job
 *   - Job payloads survive a JSON round-trip (BullMQ ships them through Redis)
 *   - Enqueue failure → 500 + unmark, so the source retry is processed
 *   - Handler (job) failure does NOT unmark — the queue's retries/dead-letter
 *     own recovery, and a source retry must stay deduped
 *   - InProcessWebhookQueue works as a configured queue (synchronous inline run)
 *   - Full middleware wiring via createOneSubMiddleware, including the admin
 *     dead-letter endpoint reading from the configured queue
 *   - BullMQWebhookQueue.setHandler without bullmq installed: no unhandled
 *     rejection; the startup error surfaces on the next enqueue()
 */

import { describe, it, expect } from 'vitest';
import express from 'express';
import type { OneSubServerConfig, SubscriptionInfo } from '@onesub/shared';
import { SUBSCRIPTION_STATUS } from '@onesub/shared';
import { createWebhookRouter } from '../routes/webhook.js';
import { createOneSubMiddleware } from '../index.js';
import { InMemorySubscriptionStore, InMemoryPurchaseStore } from '../store.js';
import { InMemoryWebhookEventStore } from '../webhook-events.js';
import { InProcessWebhookQueue, BullMQWebhookQueue } from '../webhook-queue.js';
import type { WebhookQueue, WebhookJob, WebhookHandler, DeadLetterRecord } from '../webhook-queue.js';

// ── test queue ───────────────────────────────────────────────────────────────

/**
 * Recording queue. 'sync' runs the handler inside enqueue (like
 * InProcessWebhookQueue, but with job capture); 'deferred' only records, so
 * tests can prove the route acks before processing and drive the handler
 * explicitly. Jobs are JSON round-tripped to mirror the Redis serialization
 * BullMQ performs.
 */
class TestQueue implements WebhookQueue {
  jobs: WebhookJob[] = [];
  handler: WebhookHandler | null = null;

  constructor(private readonly mode: 'sync' | 'deferred' = 'sync') {}

  setHandler<T>(handler: WebhookHandler<T>): void {
    this.handler = handler as WebhookHandler;
  }

  async enqueue<T>(job: WebhookJob<T>): Promise<void> {
    const serialized = JSON.parse(JSON.stringify(job)) as WebhookJob;
    this.jobs.push(serialized);
    if (this.mode === 'sync') {
      if (!this.handler) throw new Error('no handler registered');
      await this.handler(serialized);
    }
  }

  /** Run the handler over every recorded job (deferred mode). */
  async drain(): Promise<void> {
    for (const job of this.jobs) {
      await this.handler!(job);
    }
  }
}

// ── payload helpers (same shapes as webhook-apple/google unit tests) ────────

function makeJws(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'ES256' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.fakesig`;
}

function applePayload(opts: {
  notificationType: string;
  notificationUUID?: string;
  originalTransactionId: string;
  bundleId?: string;
}): unknown {
  const signedTransactionInfo = makeJws({
    bundleId: opts.bundleId ?? 'com.example.app',
    type: 'Auto-Renewable Subscription',
    productId: 'pro_monthly',
    transactionId: `tx_${Date.now()}`,
    originalTransactionId: opts.originalTransactionId,
    purchaseDate: Date.now() - 86400000,
    expiresDate: Date.now() + 30 * 86400000,
    environment: 'Production',
  });
  const signedRenewalInfo = makeJws({ autoRenewStatus: 1 });
  const inner: Record<string, unknown> = {
    notificationType: opts.notificationType,
    data: { signedTransactionInfo, signedRenewalInfo },
  };
  if (opts.notificationUUID) inner.notificationUUID = opts.notificationUUID;
  return { signedPayload: makeJws(inner) };
}

function googlePushBody(notificationType: number, purchaseToken: string, opts?: {
  packageName?: string;
  messageId?: string;
}): unknown {
  const json = JSON.stringify({
    version: '1.0',
    packageName: opts?.packageName ?? 'com.example.app',
    eventTimeMillis: String(Date.now()),
    subscriptionNotification: {
      version: '1.0',
      notificationType,
      purchaseToken,
      subscriptionId: 'pro_monthly',
    },
  });
  return {
    message: {
      data: Buffer.from(json).toString('base64'),
      messageId: opts?.messageId ?? `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    },
    subscription: 'projects/x/subscriptions/y',
  };
}

const appleConfig: OneSubServerConfig = {
  apple: { bundleId: 'com.example.app', skipJwsVerification: true },
  database: { url: '' },
};

// No pushAudience → push-token auth is skipped (matches unit test setup).
const googleConfig: OneSubServerConfig = {
  google: { packageName: 'com.example.app' },
  database: { url: '' },
};

const sampleSub = (overrides?: Partial<SubscriptionInfo>): SubscriptionInfo => ({
  userId: 'user_q',
  productId: 'pro_monthly',
  platform: 'apple',
  status: 'active',
  expiresAt: '2099-01-01T00:00:00.000Z',
  originalTransactionId: 'orig_q',
  purchasedAt: '2026-01-01T00:00:00.000Z',
  willRenew: true,
  ...overrides,
});

interface TestServer {
  request: (path: string, body: unknown) => Promise<{ status: number; body: unknown }>;
  get: (path: string, headers?: Record<string, string>) => Promise<{ status: number; body: unknown }>;
}

function serve(app: express.Express): TestServer {
  const exec = async (path: string, init: RequestInit): Promise<{ status: number; body: unknown }> => {
    const srv = app.listen(0);
    const port = (srv.address() as { port: number }).port;
    try {
      const resp = await fetch(`http://127.0.0.1:${port}${path}`, init);
      const text = await resp.text();
      let parsed: unknown = text;
      try { parsed = JSON.parse(text); } catch { /* keep as text */ }
      return { status: resp.status, body: parsed };
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  };
  return {
    request: (path, body) => exec(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    get: (path, headers) => exec(path, { method: 'GET', headers }),
  };
}

function buildServer(
  config: OneSubServerConfig,
  store: InMemorySubscriptionStore,
  webhookEventStore?: InMemoryWebhookEventStore,
  webhookQueue?: WebhookQueue,
): TestServer {
  const app = express();
  app.use(express.json());
  app.use(createWebhookRouter(config, store, new InMemoryPurchaseStore(), webhookEventStore, webhookQueue));
  return serve(app);
}

// ── Apple queue mode ─────────────────────────────────────────────────────────

describe('Apple webhook — queue mode', () => {
  it('enqueues after inline gating and the registered handler applies the state change', async () => {
    const store = new InMemorySubscriptionStore();
    const queue = new TestQueue('sync');
    const server = buildServer(appleConfig, store, undefined, queue);
    await store.save(sampleSub({ originalTransactionId: 'orig_qa1' }));

    const resp = await server.request('/onesub/webhook/apple', applePayload({
      notificationType: 'EXPIRED',
      notificationUUID: 'uuid-qa-1',
      originalTransactionId: 'orig_qa1',
    }));

    expect(resp.status).toBe(200);
    expect((resp.body as { queued?: boolean }).queued).toBe(true);
    expect(queue.jobs).toHaveLength(1);
    expect(queue.jobs[0].provider).toBe('apple');
    expect(queue.jobs[0].eventId).toBe('uuid-qa-1');
    // The state change happened through the queue handler (JSON round-tripped job).
    expect((await store.getByTransactionId('orig_qa1'))?.status).toBe(SUBSCRIPTION_STATUS.EXPIRED);
  });

  it('acks before processing when the queue is deferred; drain applies the change', async () => {
    const store = new InMemorySubscriptionStore();
    const queue = new TestQueue('deferred');
    const server = buildServer(appleConfig, store, undefined, queue);
    await store.save(sampleSub({ originalTransactionId: 'orig_qa2' }));

    const resp = await server.request('/onesub/webhook/apple', applePayload({
      notificationType: 'EXPIRED',
      originalTransactionId: 'orig_qa2',
    }));

    expect(resp.status).toBe(200);
    // Not processed yet — the 200 only means "durably enqueued".
    expect((await store.getByTransactionId('orig_qa2'))?.status).toBe(SUBSCRIPTION_STATUS.ACTIVE);

    await queue.drain();
    expect((await store.getByTransactionId('orig_qa2'))?.status).toBe(SUBSCRIPTION_STATUS.EXPIRED);
  });

  it('invalid payload 400s inline and is never enqueued', async () => {
    const store = new InMemorySubscriptionStore();
    const queue = new TestQueue('sync');
    const server = buildServer(appleConfig, store, undefined, queue);

    const missing = await server.request('/onesub/webhook/apple', {});
    expect(missing.status).toBe(400);

    const invalid = await server.request('/onesub/webhook/apple', { signedPayload: 'not-a-jws' });
    expect(invalid.status).toBe(400);

    expect(queue.jobs).toHaveLength(0);
  });

  it('bundleId mismatch 400s inline and is never enqueued', async () => {
    const store = new InMemorySubscriptionStore();
    const queue = new TestQueue('sync');
    const server = buildServer(appleConfig, store, undefined, queue);

    const resp = await server.request('/onesub/webhook/apple', applePayload({
      notificationType: 'REFUND',
      originalTransactionId: 'orig_foreign',
      bundleId: 'com.attacker.other',
    }));

    expect(resp.status).toBe(400);
    expect((resp.body as { errorCode?: string }).errorCode).toBe('BUNDLE_ID_MISMATCH');
    expect(queue.jobs).toHaveLength(0);
  });

  it('duplicate notificationUUID is deduped without a second job', async () => {
    const store = new InMemorySubscriptionStore();
    const queue = new TestQueue('sync');
    const events = new InMemoryWebhookEventStore();
    const server = buildServer(appleConfig, store, events, queue);
    await store.save(sampleSub({ originalTransactionId: 'orig_qa3' }));

    const payload = applePayload({
      notificationType: 'EXPIRED',
      notificationUUID: 'uuid-qa-dup',
      originalTransactionId: 'orig_qa3',
    });

    const first = await server.request('/onesub/webhook/apple', payload);
    expect(first.status).toBe(200);
    expect(queue.jobs).toHaveLength(1);

    const replay = await server.request('/onesub/webhook/apple', payload);
    expect(replay.status).toBe(200);
    expect((replay.body as { deduped?: boolean }).deduped).toBe(true);
    expect(queue.jobs).toHaveLength(1);
  });

  it('enqueue failure → 500 + unmark, so the source retry is processed', async () => {
    class FlakyEnqueueQueue extends TestQueue {
      failures = 1;
      override async enqueue<T>(job: WebhookJob<T>): Promise<void> {
        if (this.failures > 0) {
          this.failures -= 1;
          throw new Error('redis down');
        }
        return super.enqueue(job);
      }
    }
    const store = new InMemorySubscriptionStore();
    const queue = new FlakyEnqueueQueue('sync');
    const events = new InMemoryWebhookEventStore();
    const server = buildServer(appleConfig, store, events, queue);
    await store.save(sampleSub({ originalTransactionId: 'orig_qa4' }));

    const payload = applePayload({
      notificationType: 'EXPIRED',
      notificationUUID: 'uuid-qa-enq-fail',
      originalTransactionId: 'orig_qa4',
    });

    const first = await server.request('/onesub/webhook/apple', payload);
    expect(first.status).toBe(500);

    // Apple retries with the SAME notificationUUID — it must not be deduped.
    const second = await server.request('/onesub/webhook/apple', payload);
    expect(second.status).toBe(200);
    expect((second.body as { deduped?: boolean }).deduped).toBeUndefined();
    expect((await store.getByTransactionId('orig_qa4'))?.status).toBe(SUBSCRIPTION_STATUS.EXPIRED);
  });

  it('job (handler) failure does NOT unmark — the queue owns retries; source retry stays deduped', async () => {
    class FailingStore extends InMemorySubscriptionStore {
      override async save(): Promise<void> {
        throw new Error('store down');
      }
    }
    const store = new FailingStore();
    const queue = new TestQueue('deferred');
    const events = new InMemoryWebhookEventStore();
    const server = buildServer(appleConfig, store, events, queue);
    await InMemorySubscriptionStore.prototype.save.call(store, sampleSub({ originalTransactionId: 'orig_qa5' }));

    const payload = applePayload({
      notificationType: 'EXPIRED',
      notificationUUID: 'uuid-qa-job-fail',
      originalTransactionId: 'orig_qa5',
    });

    // Enqueued fine → 200 to the source.
    const first = await server.request('/onesub/webhook/apple', payload);
    expect(first.status).toBe(200);

    // The job fails when the worker runs it — that's the queue's retry (and
    // eventually dead-letter) territory, not the source's.
    await expect(queue.drain()).rejects.toThrow('store down');

    // A source retry with the same UUID must stay deduped: the event was
    // durably enqueued, so unmarking would double-apply once the queue retry
    // (or an admin dead-letter replay) succeeds.
    const retry = await server.request('/onesub/webhook/apple', payload);
    expect(retry.status).toBe(200);
    expect((retry.body as { deduped?: boolean }).deduped).toBe(true);
    expect(queue.jobs).toHaveLength(1);
  });

  it('works with InProcessWebhookQueue as the configured queue', async () => {
    const store = new InMemorySubscriptionStore();
    const server = buildServer(appleConfig, store, undefined, new InProcessWebhookQueue());
    await store.save(sampleSub({ originalTransactionId: 'orig_qa6' }));

    const resp = await server.request('/onesub/webhook/apple', applePayload({
      notificationType: 'EXPIRED',
      originalTransactionId: 'orig_qa6',
    }));

    expect(resp.status).toBe(200);
    expect((await store.getByTransactionId('orig_qa6'))?.status).toBe(SUBSCRIPTION_STATUS.EXPIRED);
  });
});

// ── Google queue mode ────────────────────────────────────────────────────────

describe('Google webhook — queue mode', () => {
  it('enqueues after inline gating and the registered handler applies the state change', async () => {
    const store = new InMemorySubscriptionStore();
    const queue = new TestQueue('sync');
    const server = buildServer(googleConfig, store, undefined, queue);
    await store.save(sampleSub({ platform: 'google', originalTransactionId: 'tok_qg1' }));

    const resp = await server.request('/onesub/webhook/google', googlePushBody(3 /* CANCELED */, 'tok_qg1', { messageId: 'msg-qg-1' }));

    expect(resp.status).toBe(200);
    expect((resp.body as { queued?: boolean }).queued).toBe(true);
    expect(queue.jobs).toHaveLength(1);
    expect(queue.jobs[0].provider).toBe('google');
    expect(queue.jobs[0].eventId).toBe('msg-qg-1');
    expect((await store.getByTransactionId('tok_qg1'))?.status).toBe(SUBSCRIPTION_STATUS.CANCELED);
  });

  it('invalid payload 400s inline and is never enqueued', async () => {
    const store = new InMemorySubscriptionStore();
    const queue = new TestQueue('sync');
    const server = buildServer(googleConfig, store, undefined, queue);

    const resp = await server.request('/onesub/webhook/google', { message: { messageId: '1' }, subscription: 's' });
    expect(resp.status).toBe(400);
    expect((resp.body as { errorCode?: string }).errorCode).toBe('MISSING_MESSAGE_DATA');
    expect(queue.jobs).toHaveLength(0);
  });

  it('packageName mismatch 400s inline and is never enqueued', async () => {
    const store = new InMemorySubscriptionStore();
    const queue = new TestQueue('sync');
    const server = buildServer(googleConfig, store, undefined, queue);

    const resp = await server.request('/onesub/webhook/google', googlePushBody(3, 'tok_qg2', { packageName: 'com.attacker.app' }));
    expect(resp.status).toBe(400);
    expect((resp.body as { errorCode?: string }).errorCode).toBe('PACKAGE_NAME_MISMATCH');
    expect(queue.jobs).toHaveLength(0);
  });

  it('duplicate messageId is deduped without a second job', async () => {
    const store = new InMemorySubscriptionStore();
    const queue = new TestQueue('sync');
    const events = new InMemoryWebhookEventStore();
    const server = buildServer(googleConfig, store, events, queue);
    await store.save(sampleSub({ platform: 'google', originalTransactionId: 'tok_qg3' }));

    const body = googlePushBody(3, 'tok_qg3', { messageId: 'msg-qg-dup' });

    const first = await server.request('/onesub/webhook/google', body);
    expect(first.status).toBe(200);
    expect(queue.jobs).toHaveLength(1);

    const replay = await server.request('/onesub/webhook/google', body);
    expect(replay.status).toBe(200);
    expect((replay.body as { deduped?: boolean }).deduped).toBe(true);
    expect(queue.jobs).toHaveLength(1);
  });

  it('unrecognized notification format acks 200 without enqueueing', async () => {
    const store = new InMemorySubscriptionStore();
    const queue = new TestQueue('sync');
    const server = buildServer(googleConfig, store, undefined, queue);

    const json = JSON.stringify({ version: '1.0', packageName: 'com.example.app' });
    const resp = await server.request('/onesub/webhook/google', {
      message: { data: Buffer.from(json).toString('base64'), messageId: 'msg-qg-unknown' },
      subscription: 's',
    });

    expect(resp.status).toBe(200);
    expect((resp.body as { received: boolean }).received).toBe(true);
    expect(queue.jobs).toHaveLength(0);
  });
});

// ── Full middleware wiring (createOneSubMiddleware) ──────────────────────────

describe('createOneSubMiddleware — webhookQueue wiring', () => {
  it('registers the handler on config.webhookQueue and exposes dead letters via admin', async () => {
    class DeadLetterQueue extends TestQueue {
      deadLetters: DeadLetterRecord[] = [
        {
          id: 'dl-1',
          job: { provider: 'apple', eventId: 'uuid-dead', payload: {} },
          attempts: 5,
          lastError: 'store down',
          failedAt: '2026-07-03T00:00:00.000Z',
        },
      ];
      async listDeadLetters(): Promise<DeadLetterRecord[]> {
        return this.deadLetters;
      }
    }

    const store = new InMemorySubscriptionStore();
    const queue = new DeadLetterQueue('sync');
    const app = express();
    app.use(createOneSubMiddleware({
      ...appleConfig,
      adminSecret: 'test-secret',
      store,
      webhookQueue: queue,
    }));
    const server = serve(app);
    await store.save(sampleSub({ originalTransactionId: 'orig_mw1' }));

    // Webhook flows through the queue registered via config.
    const resp = await server.request('/onesub/webhook/apple', applePayload({
      notificationType: 'EXPIRED',
      originalTransactionId: 'orig_mw1',
    }));
    expect(resp.status).toBe(200);
    expect((resp.body as { queued?: boolean }).queued).toBe(true);
    expect(queue.jobs).toHaveLength(1);
    expect((await store.getByTransactionId('orig_mw1'))?.status).toBe(SUBSCRIPTION_STATUS.EXPIRED);

    // Dead-letter admin endpoint reads from the same queue.
    const dead = await server.get('/onesub/admin/webhook-deadletters', { 'x-admin-secret': 'test-secret' });
    expect(dead.status).toBe(200);
    expect((dead.body as { items: DeadLetterRecord[] }).items).toHaveLength(1);
    expect((dead.body as { items: DeadLetterRecord[] }).items[0].id).toBe('dl-1');
  });
});

// ── BullMQWebhookQueue startup hardening ─────────────────────────────────────

describe('BullMQWebhookQueue — bullmq not installed', () => {
  it('setHandler does not crash the process; the error surfaces on the next enqueue', async () => {
    const queue = new BullMQWebhookQueue({ connection: {} });

    // Pre-fix this kicked off a floating worker promise whose rejection was
    // unhandled (process crash under Node's default policy).
    queue.setHandler(async () => {});

    // Give the background worker-startup promise a tick to settle.
    await new Promise((r) => setTimeout(r, 20));

    await expect(
      queue.enqueue({ provider: 'apple', eventId: 'uuid-x', payload: {} }),
    ).rejects.toThrow(/bullmq/);

    // close() after a failed startup must not throw either.
    await expect(queue.close()).resolves.toBeUndefined();
  });
});
