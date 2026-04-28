import { z } from 'zod';
import { ROUTES, type StatusResponse, type PurchaseStatusResponse } from '@onesub/shared';
import { normalizeUrl, fetchJson, type FetchJsonResult } from '../utils.js';

export const inspectStateInputSchema = {
  serverUrl: z
    .string()
    .url()
    .default('http://localhost:4100')
    .describe('Base URL of the onesub server (default: http://localhost:4100)'),
  userId: z.string().min(1).describe('User ID to look up'),
};

export async function runInspectState(args: {
  serverUrl: string;
  userId: string;
}): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const base = normalizeUrl(args.serverUrl);
  const userParam = encodeURIComponent(args.userId);

  const [subRes, purRes] = await Promise.all([
    fetchJson(`${base}${ROUTES.STATUS}?userId=${userParam}`),
    fetchJson(`${base}${ROUTES.PURCHASE_STATUS}?userId=${userParam}`),
  ]);

  return {
    content: [{ type: 'text', text: buildOutput(args, subRes, purRes) }],
  };
}

type FetchResult = FetchJsonResult;

function buildOutput(
  args: { serverUrl: string; userId: string },
  subRes: FetchResult,
  purRes: FetchResult,
): string {
  const lines: string[] = [
    `# onesub state — user \`${args.userId}\``,
    '',
    `**Server:** \`${args.serverUrl}\``,
    '',
  ];

  // Connection error on either endpoint — surface prominently
  if (!subRes.ok && subRes.httpStatus === 0) {
    lines.push(`**Connection failed:** ${subRes.error}`);
    lines.push('', 'Start the dev server: `npx @onesub/cli dev`');
    return lines.join('\n');
  }

  // ── Subscription block ────────────────────────────────
  lines.push('## Subscription (`/onesub/status`)', '');
  if (!subRes.ok) {
    lines.push(`Error: ${subRes.error}${subRes.raw ? ' — ' + subRes.raw.slice(0, 200) : ''}`, '');
  } else {
    const data = subRes.data as StatusResponse;
    if (!data.active || !data.subscription) {
      lines.push('No active subscription.', '');
    } else {
      const sub = data.subscription;
      lines.push('| Field | Value |');
      lines.push('|---|---|');
      lines.push(`| Product | \`${sub.productId}\` |`);
      lines.push(`| Platform | ${sub.platform} |`);
      lines.push(`| Status | ${sub.status} |`);
      lines.push(`| Will Renew | ${sub.willRenew ? 'Yes' : 'No'} |`);
      lines.push(`| Purchased | ${sub.purchasedAt} |`);
      lines.push(`| Expires | ${sub.expiresAt} |`);
      lines.push(`| Transaction ID | \`${sub.originalTransactionId}\` |`);
      lines.push('');
    }
  }

  // ── One-time purchases block ──────────────────────────
  lines.push('## One-time purchases (`/onesub/purchase/status`)', '');
  if (!purRes.ok) {
    lines.push(`Error: ${purRes.error}${purRes.raw ? ' — ' + purRes.raw.slice(0, 200) : ''}`, '');
  } else {
    const data = purRes.data as PurchaseStatusResponse;
    if (!data.purchases || data.purchases.length === 0) {
      lines.push('No purchases.', '');
    } else {
      lines.push('| Product | Type | Platform | Transaction ID | Purchased |');
      lines.push('|---|---|---|---|---|');
      for (const p of data.purchases) {
        lines.push(
          `| \`${p.productId}\` | ${p.type} | ${p.platform} | \`${p.transactionId}\` | ${p.purchasedAt} |`,
        );
      }
      lines.push('', `Total: **${data.purchases.length}**`);
    }
  }

  return lines.join('\n');
}
