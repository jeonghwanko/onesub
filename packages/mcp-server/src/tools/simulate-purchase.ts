import { z } from 'zod';
import {
  ROUTES,
  PURCHASE_TYPE,
  MOCK_RECEIPT_PREFIX,
  type PurchaseType,
  type Platform,
} from '@onesub/shared';

export const simulatePurchaseInputSchema = {
  serverUrl: z
    .string()
    .url()
    .default('http://localhost:4100')
    .describe('Base URL of the onesub server running in mockMode (default: http://localhost:4100 from `npx @onesub/cli dev`)'),
  userId: z.string().min(1).describe('User ID to associate the purchase with'),
  productId: z.string().min(1).describe('Product ID (arbitrary in mockMode, but must match what your app uses)'),
  platform: z.enum(['apple', 'google']).describe('Store platform to simulate'),
  type: z
    .enum(['subscription', 'consumable', 'non_consumable'])
    .describe('Purchase type. `subscription` hits /onesub/validate; consumable/non_consumable hit /onesub/purchase/validate'),
  scenario: z
    .enum(['new', 'revoked', 'expired', 'invalid', 'network_error', 'sandbox'])
    .default('new')
    .describe('Which mock outcome to exercise. Uses MOCK_* receipt prefixes — see docs/RECEIPT-ERRORS.md'),
};

const SCENARIO_PREFIX: Record<string, string> = {
  new: 'MOCK_VALID',
  revoked: MOCK_RECEIPT_PREFIX.REVOKED,
  expired: MOCK_RECEIPT_PREFIX.EXPIRED,
  invalid: MOCK_RECEIPT_PREFIX.INVALID,
  network_error: MOCK_RECEIPT_PREFIX.NETWORK_ERROR,
  sandbox: MOCK_RECEIPT_PREFIX.SANDBOX,
};

export async function runSimulatePurchase(args: {
  serverUrl: string;
  userId: string;
  productId: string;
  platform: Platform;
  type: 'subscription' | 'consumable' | 'non_consumable';
  scenario: 'new' | 'revoked' | 'expired' | 'invalid' | 'network_error' | 'sandbox';
}): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const base = args.serverUrl.replace(/\/$/, '');
  const receipt = `${SCENARIO_PREFIX[args.scenario]}_${args.productId}_${Date.now()}`;

  const isSubscription = args.type === 'subscription';
  const endpoint = isSubscription ? ROUTES.VALIDATE : ROUTES.VALIDATE_PURCHASE;
  const url = `${base}${endpoint}`;

  const body: Record<string, unknown> = {
    platform: args.platform,
    receipt,
    userId: args.userId,
    productId: args.productId,
  };
  if (!isSubscription) {
    body.type =
      args.type === 'consumable' ? PURCHASE_TYPE.CONSUMABLE : PURCHASE_TYPE.NON_CONSUMABLE;
  }

  let httpStatus = 0;
  let rawBody = '';
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    httpStatus = res.status;
    rawBody = await res.text();
  } catch (err) {
    return { content: [{ type: 'text', text: buildNetworkErrorOutput(url, err) }] };
  }

  return { content: [{ type: 'text', text: buildOutput({ url, body, httpStatus, rawBody, scenario: args.scenario }) }] };
}

function buildOutput(opts: {
  url: string;
  body: Record<string, unknown>;
  httpStatus: number;
  rawBody: string;
  scenario: string;
}): string {
  const { url, body, httpStatus, rawBody, scenario } = opts;

  let parsed: unknown = rawBody;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    /* leave as raw text */
  }

  const ok = httpStatus >= 200 && httpStatus < 300;
  const lines: string[] = [
    `# Simulated ${scenario} purchase — HTTP ${httpStatus}${ok ? ' ✓' : ''}`,
    '',
    `**Endpoint:** \`POST ${url}\``,
    '',
    '## Request',
    '```json',
    JSON.stringify(body, null, 2),
    '```',
    '',
    '## Response',
    '```json',
    typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2),
    '```',
    '',
  ];

  const parsedObj =
    parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  if (parsedObj) {
    if (parsedObj['errorCode']) {
      lines.push(
        `**errorCode:** \`${String(parsedObj['errorCode'])}\` — see docs/RECEIPT-ERRORS.md for cause/fix`,
      );
    }
    if (parsedObj['action']) {
      lines.push(`**action:** \`${String(parsedObj['action'])}\``);
    }
  }

  const expectedOk = scenario === 'new' || scenario === 'sandbox';
  if (expectedOk && !ok) {
    lines.push('', `**Unexpected:** scenario=${scenario} was expected to succeed but returned ${httpStatus}.`);
  } else if (!expectedOk && ok) {
    lines.push('', `**Unexpected:** scenario=${scenario} was expected to fail but returned ${httpStatus}.`);
  }

  return lines.join('\n');
}

function buildNetworkErrorOutput(url: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  const lines = [
    `# Simulated purchase — connection failed`,
    '',
    `**Endpoint:** \`POST ${url}\``,
    `**Error:** ${msg}`,
    '',
  ];
  if (
    lower.includes('econnrefused') ||
    lower.includes('failed to fetch') ||
    lower.includes('fetch failed')
  ) {
    lines.push('The onesub server is not running. Start it with:');
    lines.push('```');
    lines.push('npx @onesub/cli dev');
    lines.push('```');
  }
  return lines.join('\n');
}
