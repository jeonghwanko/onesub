/**
 * Webhook processing queue.
 *
 * The default in-process queue runs the handler synchronously inside the HTTP
 * request — the same behavior you got before this interface existed. For
 * production deployments that want decoupled retries, swap in a queue-backed
 * implementation (BullMQ, SQS, etc.) so a slow DB or Apple/Google API call
 * doesn't block the webhook from acknowledging.
 *
 * Failure semantics:
 *   - Handler throws  → queue records the failure and (for retrying queues)
 *                       re-runs with backoff. After max attempts the job
 *                       lands in the dead-letter store.
 *   - Handler returns → ack to source.
 *
 * The HTTP route should always 200 once the job is *enqueued*. Synchronous
 * processing happens to acknowledge later only because the in-process queue
 * runs inline; for any async queue the route should ack after `enqueue()`.
 */
export interface WebhookJob<T = unknown> {
  provider: 'apple' | 'google';
  /** Source-supplied event id (notificationUUID / messageId) for tracing. */
  eventId: string;
  payload: T;
}

export type WebhookHandler<T = unknown> = (job: WebhookJob<T>) => Promise<void>;

export interface WebhookQueue {
  /**
   * Enqueue a job. Returns once the job is durably accepted (synchronous for
   * in-process; persisted-to-Redis for BullMQ).
   */
  enqueue<T>(job: WebhookJob<T>): Promise<void>;
  /** Register the worker handler. Called once during middleware setup. */
  setHandler<T>(handler: WebhookHandler<T>): void;
  /** Optional: list jobs in the dead-letter queue (for the admin replay UI). */
  listDeadLetters?(): Promise<DeadLetterRecord[]>;
  /** Optional: replay a specific dead-letter job back through the handler. */
  replayDeadLetter?(id: string): Promise<void>;
  /** Optional: graceful shutdown. */
  close?(): Promise<void>;
}

export interface DeadLetterRecord {
  id: string;
  job: WebhookJob;
  attempts: number;
  lastError: string;
  failedAt: string;
}

/**
 * Synchronous, in-process implementation. Default — no extra infra required.
 * Handler runs inside the HTTP request, so route latency = handler latency.
 *
 * Failures are NOT retried — the original Apple/Google source retry policy
 * is the durability layer (4xx = no retry, 5xx = source retries). This
 * matches the pre-queue behavior.
 */
export class InProcessWebhookQueue implements WebhookQueue {
  private handler: WebhookHandler | null = null;

  setHandler<T>(handler: WebhookHandler<T>): void {
    this.handler = handler as WebhookHandler;
  }

  async enqueue<T>(job: WebhookJob<T>): Promise<void> {
    if (!this.handler) {
      throw new Error('[onesub] webhook queue has no handler registered');
    }
    await this.handler(job);
  }
}

/**
 * BullMQ-backed implementation — durable Redis queue with retries and a
 * dead-letter list. `bullmq` is an optional peer dependency; install it
 * separately:
 *
 *   npm install bullmq ioredis
 *
 * Usage:
 *   import { Queue, Worker } from 'bullmq';
 *   import IORedis from 'ioredis';
 *   import { BullMQWebhookQueue } from '@onesub/server';
 *
 *   const connection = new IORedis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
 *   const queue = new BullMQWebhookQueue({ connection });
 *
 *   app.use(createOneSubMiddleware({ ...config, webhookQueue: queue }));
 *
 * Note: the worker is started inside `setHandler`. The webhook route
 * `enqueue`s and 200s immediately, so source latency is dominated by the
 * Redis round-trip, not the receipt-validation pipeline.
 */
/**
 * `bullmq` is an optional peer — we don't depend on its types at compile
 * time. The minimal-shape interfaces below keep TS strict-mode happy
 * without forcing every onesub user to install bullmq just to type-check.
 */
interface BullMQJob {
  id: string | number | undefined;
  data: unknown;
  attemptsMade: number;
  failedReason?: string;
  finishedOn?: number;
  retry(): Promise<unknown>;
}
interface BullMQQueue {
  add(name: string, data: unknown, opts?: unknown): Promise<unknown>;
  getJob(id: string): Promise<BullMQJob | undefined>;
  getFailed(): Promise<BullMQJob[]>;
  close(): Promise<void>;
}
interface BullMQWorker {
  close(): Promise<void>;
}
interface BullMQModule {
  Queue: new (name: string, opts: { connection: unknown }) => BullMQQueue;
  Worker: new (
    name: string,
    fn: (job: { data: unknown }) => Promise<void>,
    opts: { connection: unknown; concurrency?: number },
  ) => BullMQWorker;
}

export interface BullMQWebhookQueueOptions {
  /** ioredis connection (or compatible options). Required. */
  connection: unknown;
  /** Queue name. Defaults to 'onesub-webhooks'. */
  queueName?: string;
  /** Max retry attempts before sending the job to the dead-letter list. */
  maxAttempts?: number;
  /** Backoff (ms) between attempts. Exponential: backoffMs * 2^(attempt-1). */
  backoffMs?: number;
  /** Worker concurrency. Defaults to 4. */
  concurrency?: number;
}

export class BullMQWebhookQueue implements WebhookQueue {
  private queueName: string;
  private maxAttempts: number;
  private backoffMs: number;
  private concurrency: number;
  private connection: unknown;

  // Lazy-loaded so `bullmq` doesn't have to be installed unless this class
  // is instantiated.
  private queuePromise: Promise<BullMQQueue> | null = null;
  private workerPromise: Promise<BullMQWorker> | null = null;
  private handler: WebhookHandler | null = null;

  constructor(opts: BullMQWebhookQueueOptions) {
    this.connection = opts.connection;
    this.queueName = opts.queueName ?? 'onesub-webhooks';
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.backoffMs = opts.backoffMs ?? 1000;
    this.concurrency = opts.concurrency ?? 4;
  }

  private async getBullMQ(): Promise<BullMQModule> {
    return import('bullmq' as string).catch(() => {
      throw new Error('[onesub] BullMQWebhookQueue requires the `bullmq` package. Run: npm install bullmq');
    }) as Promise<BullMQModule>;
  }

  private getQueue(): Promise<BullMQQueue> {
    if (!this.queuePromise) {
      this.queuePromise = (async () => {
        const { Queue } = await this.getBullMQ();
        return new Queue(this.queueName, { connection: this.connection });
      })();
    }
    return this.queuePromise;
  }

  setHandler<T>(handler: WebhookHandler<T>): void {
    this.handler = handler as WebhookHandler;
    if (!this.workerPromise) {
      this.workerPromise = (async () => {
        const { Worker } = await this.getBullMQ();
        return new Worker(
          this.queueName,
          async (job) => {
            if (!this.handler) throw new Error('[onesub] handler not set');
            await this.handler(job.data as WebhookJob);
          },
          {
            connection: this.connection,
            concurrency: this.concurrency,
          },
        );
      })();
    }
  }

  async enqueue<T>(job: WebhookJob<T>): Promise<void> {
    const queue = await this.getQueue();
    await queue.add('webhook', job, {
      attempts: this.maxAttempts,
      backoff: { type: 'exponential', delay: this.backoffMs },
      removeOnFail: false,
      removeOnComplete: { age: 24 * 60 * 60, count: 1000 },
      jobId: `${job.provider}:${job.eventId}`,
    });
  }

  async listDeadLetters(): Promise<DeadLetterRecord[]> {
    const queue = await this.getQueue();
    const failed = await queue.getFailed();
    return failed.map((j) => ({
      id: String(j.id),
      job: j.data as WebhookJob,
      attempts: j.attemptsMade,
      lastError: j.failedReason ?? 'unknown',
      failedAt: new Date(j.finishedOn ?? Date.now()).toISOString(),
    }));
  }

  async replayDeadLetter(id: string): Promise<void> {
    const queue = await this.getQueue();
    const job = await queue.getJob(id);
    if (!job) throw new Error(`[onesub] dead-letter job ${id} not found`);
    await job.retry();
  }

  async close(): Promise<void> {
    if (this.workerPromise) {
      const worker = await this.workerPromise;
      await worker.close();
    }
    if (this.queuePromise) {
      const queue = await this.queuePromise;
      await queue.close();
    }
  }
}
