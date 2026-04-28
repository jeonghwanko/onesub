import { z } from 'zod';
import { ROUTES, type Platform } from '@onesub/shared';
import { normalizeUrl, fetchJson } from '../utils.js';

// ── Apple notification types ─────────────────────────────────────────────────

const APPLE_NOTIFICATION_TYPES = [
  'SUBSCRIBED',
  'DID_RENEW',
  'DID_RECOVER',
  'OFFER_REDEEMED',
  'DID_FAIL_TO_RENEW',
  'GRACE_PERIOD_EXPIRED',
  'EXPIRED',
  'REFUND',
  'REVOKE',
] as const;
type AppleNotificationType = (typeof APPLE_NOTIFICATION_TYPES)[number];

// Expected status after notification — for output hints
const APPLE_EXPECTED_STATUS: Record<AppleNotificationType, string> = {
  SUBSCRIBED: 'active',
  DID_RENEW: 'active',
  DID_RECOVER: 'active',
  OFFER_REDEEMED: 'active',
  DID_FAIL_TO_RENEW: 'grace_period (with subtype=GRACE_PERIOD) or on_hold (no subtype)',
  GRACE_PERIOD_EXPIRED: 'on_hold',
  EXPIRED: 'expired',
  REFUND: 'canceled',
  REVOKE: 'canceled',
};

// ── Google notification types ────────────────────────────────────────────────

const GOOGLE_NOTIFICATION_TYPE_MAP: Record<string, number> = {
  purchased: 4,
  renewed: 2,
  recovered: 1,
  restarted: 7,
  canceled: 3,
  revoked: 12,
  expired: 13,
  on_hold: 5,
  grace_period: 6,
  paused: 10,
  price_change_confirmed: 8,
} as const;

const GOOGLE_EXPECTED_STATUS: Record<string, string> = {
  purchased: 'active',
  renewed: 'active',
  recovered: 'active',
  restarted: 'active',
  canceled: 'canceled',
  revoked: 'canceled',
  expired: 'expired',
  on_hold: 'on_hold',
  grace_period: 'grace_period',
  paused: 'paused',
  price_change_confirmed: 'active (+ onPriceChangeConfirmed hook if configured)',
};

// ── Input schema ─────────────────────────────────────────────────────────────

export const simulateWebhookInputSchema = {
  serverUrl: z
    .string()
    .url()
    .default('http://localhost:4100')
    .describe('Base URL of the onesub server (default: http://localhost:4100). Apple webhooks require skipJwsVerification: true in the server config (set automatically by `npx @onesub/cli dev`).'),
  platform: z
    .enum(['apple', 'google'])
    .describe('Store platform to simulate.'),
  notificationType: z
    .string()
    .describe(
      'Notification type to send.\n' +
      'Apple types: ' + APPLE_NOTIFICATION_TYPES.join(', ') + '\n' +
      'Google types: ' + Object.keys(GOOGLE_NOTIFICATION_TYPE_MAP).join(', '),
    ),
  transactionId: z
    .string()
    .min(1)
    .describe('originalTransactionId (Apple) or purchaseToken (Google). Must match an existing record in the server store for the status update to apply.'),
  productId: z
    .string()
    .default('pro_monthly')
    .describe('Subscription product ID (Apple: used in signedTransactionInfo; Google: subscriptionId).'),
  subtype: z
    .string()
    .optional()
    .describe('Apple only — subtype for DID_FAIL_TO_RENEW. Pass "GRACE_PERIOD" to land in grace_period status; omit for on_hold.'),
  bundleId: z
    .string()
    .default('com.example.app')
    .describe('Apple only — bundle ID embedded in the fake JWS payload.'),
  packageName: z
    .string()
    .default('com.example.app')
    .describe('Google only — package name embedded in the Pub/Sub message.'),
  expiresInDays: z
    .number()
    .int()
    .default(30)
    .describe('Apple only — how many days from now to set expiresDate in the fake JWS (default 30). Use a negative number to simulate an already-expired receipt.'),
};

// ── JWS helpers (no real crypto — server must have skipJwsVerification: true) ──

function fakeJws(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'ES256' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.SIMULATED_SIG`;
}

function buildApplePayload(args: {
  notificationType: string;
  subtype?: string;
  transactionId: string;
  productId: string;
  bundleId: string;
  expiresInDays: number;
}): Record<string, unknown> {
  const expiresDate = Date.now() + args.expiresInDays * 86_400_000;
  const signedTransactionInfo = fakeJws({
    bundleId: args.bundleId,
    type: 'Auto-Renewable Subscription',
    productId: args.productId,
    transactionId: `sim_tx_${Date.now()}`,
    originalTransactionId: args.transactionId,
    purchaseDate: Date.now() - 86_400_000,
    expiresDate,
    environment: 'Production',
  });
  const signedRenewalInfo = fakeJws({
    autoRenewStatus: args.expiresInDays > 0 ? 1 : 0,
    productId: args.productId,
  });
  const inner: Record<string, unknown> = {
    notificationType: args.notificationType,
    notificationUUID: `sim-${Date.now()}`,
    data: { signedTransactionInfo, signedRenewalInfo },
  };
  if (args.subtype) inner.subtype = args.subtype;
  return { signedPayload: fakeJws(inner) };
}

function buildGooglePayload(args: {
  notificationType: number;
  purchaseToken: string;
  productId: string;
  packageName: string;
}): Record<string, unknown> {
  const json = JSON.stringify({
    version: '1.0',
    packageName: args.packageName,
    eventTimeMillis: String(Date.now()),
    subscriptionNotification: {
      version: '1.0',
      notificationType: args.notificationType,
      purchaseToken: args.purchaseToken,
      subscriptionId: args.productId,
    },
  });
  return {
    message: {
      data: Buffer.from(json, 'utf-8').toString('base64'),
      messageId: `sim-${Date.now()}`,
    },
    subscription: 'projects/onesub-sim/subscriptions/sim',
  };
}

// ── Main runner ───────────────────────────────────────────────────────────────

export async function runSimulateWebhook(args: {
  serverUrl: string;
  platform: Platform;
  notificationType: string;
  transactionId: string;
  productId: string;
  subtype?: string;
  bundleId: string;
  packageName: string;
  expiresInDays: number;
}): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const base = normalizeUrl(args.serverUrl);

  let url: string;
  let body: Record<string, unknown>;
  let expectedStatus: string | undefined;

  if (args.platform === 'apple') {
    const type = args.notificationType as AppleNotificationType;
    if (!APPLE_NOTIFICATION_TYPES.includes(type)) {
      return {
        content: [{
          type: 'text',
          text: [
            `# Unknown Apple notification type: \`${args.notificationType}\``,
            '',
            `**Valid types:** ${APPLE_NOTIFICATION_TYPES.join(', ')}`,
          ].join('\n'),
        }],
      };
    }
    url = `${base}${ROUTES.WEBHOOK_APPLE}`;
    body = buildApplePayload({
      notificationType: args.notificationType,
      subtype: args.subtype,
      transactionId: args.transactionId,
      productId: args.productId,
      bundleId: args.bundleId,
      expiresInDays: args.expiresInDays,
    });
    expectedStatus = APPLE_EXPECTED_STATUS[type];
  } else {
    const typeNum = GOOGLE_NOTIFICATION_TYPE_MAP[args.notificationType];
    if (typeNum === undefined) {
      return {
        content: [{
          type: 'text',
          text: [
            `# Unknown Google notification type: \`${args.notificationType}\``,
            '',
            `**Valid types:** ${Object.keys(GOOGLE_NOTIFICATION_TYPE_MAP).join(', ')}`,
          ].join('\n'),
        }],
      };
    }
    url = `${base}${ROUTES.WEBHOOK_GOOGLE}`;
    body = buildGooglePayload({
      notificationType: typeNum,
      purchaseToken: args.transactionId,
      productId: args.productId,
      packageName: args.packageName,
    });
    expectedStatus = GOOGLE_EXPECTED_STATUS[args.notificationType];
  }

  const result = await fetchJson(url, {
    method: 'POST',
    body: JSON.stringify(body),
  });

  if (!result.ok && result.httpStatus === 0) {
    return {
      content: [{
        type: 'text',
        text: buildNetworkErrorOutput(url, new Error(result.error)),
      }],
    };
  }

  const response: unknown = result.ok ? result.data : (result.raw ?? result.error);
  return {
    content: [{
      type: 'text',
      text: buildOutput({
        url,
        platform: args.platform,
        notificationType: args.notificationType,
        subtype: args.subtype,
        transactionId: args.transactionId,
        httpStatus: result.httpStatus,
        response,
        expectedStatus,
      }),
    }],
  };
}

// ── Output builders ──────────────────────────────────────────────────────────

function buildOutput(opts: {
  url: string;
  platform: Platform;
  notificationType: string;
  subtype?: string;
  transactionId: string;
  httpStatus: number;
  response: unknown;
  expectedStatus?: string;
}): string {
  const { url, platform, notificationType, subtype, transactionId, httpStatus, response, expectedStatus } = opts;
  const ok = httpStatus >= 200 && httpStatus < 300;
  const label = subtype ? `${notificationType}/${subtype}` : notificationType;

  const lines: string[] = [
    `# Simulated ${platform} webhook — ${label} — HTTP ${httpStatus}${ok ? ' ✓' : ''}`,
    '',
    `**Endpoint:** \`POST ${url}\``,
    `**transactionId:** \`${transactionId}\``,
    '',
    '## Response',
    '```json',
    typeof response === 'string' ? response : JSON.stringify(response, null, 2),
    '```',
    '',
  ];

  if (ok && expectedStatus) {
    lines.push(`**Expected status after this notification:** \`${expectedStatus}\``);
    lines.push('');
    lines.push('Verify with `onesub_inspect_state` or `onesub_check_status`.');
  }

  const parsedObj =
    response && typeof response === 'object' ? (response as Record<string, unknown>) : null;
  if (!ok && parsedObj?.['errorCode']) {
    lines.push('');
    lines.push(`**errorCode:** \`${String(parsedObj['errorCode'])}\``);
    if (String(parsedObj['errorCode']) === 'INVALID_SIGNED_PAYLOAD') {
      lines.push('');
      lines.push('Apple webhooks require `skipJwsVerification: true` in the server config.');
      lines.push('When running via `npx @onesub/cli dev` this is set automatically.');
    }
  }

  return lines.join('\n');
}

function buildNetworkErrorOutput(url: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  const lines = [
    `# Simulated webhook — connection failed`,
    '',
    `**Endpoint:** \`POST ${url}\``,
    `**Error:** ${msg}`,
    '',
  ];
  if (lower.includes('econnrefused') || lower.includes('failed to fetch') || lower.includes('fetch failed')) {
    lines.push('The onesub server is not running. Start it with:');
    lines.push('```');
    lines.push('npx @onesub/cli dev');
    lines.push('```');
  }
  return lines.join('\n');
}
