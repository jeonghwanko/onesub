import { z } from 'zod';
import { ROUTES } from '@onesub/shared';
import type {
  ListSubscriptionsResponse,
  MetricsActiveResponse,
  StatusResponse,
} from '@onesub/shared';
import type { FetchJsonResult } from '../utils.js';
import { normalizeUrl, fetchJson, responseBody } from '../utils.js';

const ADMIN_SECRET_HEADER = 'x-admin-secret';

/** First-page size for the recent-subscriptions table (server caps at 200). */
const SUMMARY_LIST_LIMIT = 10;

export const viewSubscribersInputSchema = {
  serverUrl: z.string().url().describe('onesub server URL'),
  userId: z
    .string()
    .optional()
    .describe('Check specific user (omit for the aggregate summary)'),
  adminSecret: z
    .string()
    .optional()
    .describe(
      "Server admin secret (config.adminSecret, sent as the x-admin-secret header) — gates the aggregate/list queries used when userId is omitted. The per-user status path doesn't need it.",
    ),
};

type ViewSubscribersArgs = {
  serverUrl: string;
  userId?: string;
  adminSecret?: string;
};

export async function runViewSubscribers(
  args: ViewSubscribersArgs,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  if (!args.userId) {
    const text = args.adminSecret
      ? await buildSummaryOutput(args.serverUrl, args.adminSecret)
      : buildNoUserIdOutput(args.serverUrl);
    return { content: [{ type: 'text', text }] };
  }

  const baseUrl = normalizeUrl(args.serverUrl);
  const url = `${baseUrl}${ROUTES.STATUS}?userId=${encodeURIComponent(args.userId)}`;

  const result = await fetchJson<StatusResponse>(url);

  if (!result.ok) {
    const text = result.httpStatus > 0
      ? buildHttpErrorOutput({ url, userId: args.userId, httpStatus: result.httpStatus, rawBody: result.raw ?? result.error })
      : buildNetworkErrorOutput({ url, userId: args.userId, message: result.error });
    return { content: [{ type: 'text', text }] };
  }

  const text = buildUserStatusOutput({ url, userId: args.userId, data: result.data });
  return { content: [{ type: 'text', text }] };
}

function buildNoUserIdOutput(serverUrl: string): string {
  const baseUrl = normalizeUrl(serverUrl);

  const lines: string[] = [
    '# Subscriber Summary',
    '',
    'Aggregate subscriber data is available, but the endpoints are gated behind the',
    "server's admin secret (`config.adminSecret`, sent as the `x-admin-secret` header):",
    '',
    `- \`GET ${ROUTES.METRICS_ACTIVE}\` — active-subscriber counts (by product / platform)`,
    `- \`GET ${ROUTES.ADMIN_SUBSCRIPTIONS}\` — filtered/paginated subscription list`,
    '',
    '## Get the aggregate summary',
    '',
    'Re-run this tool with the `adminSecret` argument:',
    '',
    '```',
    'onesub_view_subscribers',
    `  serverUrl: "${baseUrl}"`,
    '  adminSecret: "<config.adminSecret>"',
    '```',
    '',
    '## Check a single user (no secret required)',
    '',
    'Provide a `userId` to this tool to check a specific user\'s subscription status:',
    '',
    '```',
    'onesub_view_subscribers',
    `  serverUrl: "${baseUrl}"`,
    '  userId: "user_abc123"',
    '```',
    '',
    'Or query the endpoint directly:',
    '',
    '```bash',
    `curl "${baseUrl}${ROUTES.STATUS}?userId=YOUR_USER_ID"`,
    '```',
    '',
    'For revenue metrics (not exposed by onesub), check App Store Connect → Trends →',
    'Subscriptions or Google Play Console → Monetize → Subscriptions.',
  ];

  return lines.join('\n');
}

async function buildSummaryOutput(serverUrl: string, adminSecret: string): Promise<string> {
  const baseUrl = normalizeUrl(serverUrl);
  const headers = { [ADMIN_SECRET_HEADER]: adminSecret };

  const metricsUrl = `${baseUrl}${ROUTES.METRICS_ACTIVE}`;
  const metrics = await fetchJson<MetricsActiveResponse>(metricsUrl, { headers });
  if (!metrics.ok) {
    return buildSummaryErrorOutput({ url: metricsUrl, result: metrics });
  }

  // Best-effort first page — the counts above are the primary payload, so a
  // list failure degrades to counts-only output instead of an error.
  const listUrl = `${baseUrl}${ROUTES.ADMIN_SUBSCRIPTIONS}?limit=${SUMMARY_LIST_LIMIT}`;
  const listResult = await fetchJson<ListSubscriptionsResponse>(listUrl, { headers });
  const list = listResult.ok ? listResult.data : null;

  const m = metrics.data;
  const lines: string[] = [
    '# Subscriber Summary',
    '',
    `**Server:** \`${baseUrl}\``,
    '',
    '## Active Entitlements',
    '',
    '| Metric | Count |',
    '|--------|-------|',
    `| Total entitled users | ${m.total} |`,
    `| Active subscriptions | ${m.activeSubscriptions} |`,
    `| — in grace period | ${m.gracePeriodSubscriptions} |`,
    `| Lifetime (non-consumable) purchases | ${m.nonConsumablePurchases} |`,
    '',
    `**By subscription product:** ${formatDistribution(m.byProduct)}`,
    `**By lifetime product:** ${formatDistribution(m.byProductPurchases)}`,
    `**By platform:** ${formatDistribution(m.byPlatform)}`,
  ];

  if (list) {
    lines.push('', `## Subscriptions (first ${Math.min(list.items.length, SUMMARY_LIST_LIMIT)} of ${list.total})`, '');
    if (list.items.length === 0) {
      lines.push('No subscription records yet.');
    } else {
      lines.push('| Product | Status | Expires At |');
      lines.push('|---------|--------|------------|');
      for (const sub of list.items) {
        lines.push(`| \`${sub.productId}\` | ${sub.status} | ${sub.expiresAt} |`);
      }
      if (list.total > list.items.length) {
        lines.push(
          '',
          `Page through the rest with \`GET ${ROUTES.ADMIN_SUBSCRIPTIONS}?limit=&offset=\` (filters: userId, status, productId, platform).`,
        );
      }
    }
  } else {
    lines.push(
      '',
      `_Subscription list unavailable (\`GET ${ROUTES.ADMIN_SUBSCRIPTIONS}\` failed) — counts above are still accurate._`,
    );
  }

  return lines.join('\n');
}

function formatDistribution(dist: Record<string, number>): string {
  const entries = Object.entries(dist).sort(([, a], [, b]) => b - a);
  if (entries.length === 0) return '—';
  return entries.map(([key, count]) => `\`${key}\` ×${count}`).join(', ');
}

function buildSummaryErrorOutput(opts: {
  url: string;
  result: FetchJsonResult & { ok: false };
}): string {
  const { url, result } = opts;
  const body = responseBody(result);
  const bodyText = typeof body === 'string' ? body : JSON.stringify(body, null, 2);

  const lines: string[] = [
    '# Subscriber Summary — Error',
    '',
    `**Endpoint:** \`${url}\``,
    result.httpStatus > 0 ? `**HTTP Status:** ${result.httpStatus}` : `**Error:** ${result.error}`,
    '',
    '## Server Response',
    '```',
    bodyText.slice(0, 500),
    '```',
    '',
    '## Troubleshooting',
  ];

  if (result.httpStatus === 401 || result.httpStatus === 403) {
    lines.push('- The provided `adminSecret` was rejected (`INVALID_ADMIN_SECRET`).');
    lines.push("- Verify it matches the server's `config.adminSecret` exactly.");
  } else if (result.httpStatus === 404) {
    lines.push('- The metrics routes are not mounted — the server only mounts them when `config.adminSecret` is set.');
    lines.push('- Set `adminSecret` in the server config, restart, then retry.');
  } else if (result.httpStatus >= 500) {
    lines.push('- The server returned an internal error. Check server logs for details.');
  } else if (result.httpStatus === 0) {
    lines.push('- The onesub server is not running or unreachable at this URL.');
    lines.push('- Start the server and verify the `serverUrl` (including port).');
  }

  return lines.join('\n');
}

function buildUserStatusOutput(opts: {
  url: string;
  userId: string;
  data: StatusResponse;
}): string {
  const { url, userId, data } = opts;
  const sub = data.subscription;

  const lines: string[] = [
    '# Subscriber Status',
    '',
    `**User ID:** \`${userId}\``,
    `**Endpoint:** \`${url}\``,
    '',
    `**Active:** ${data.active ? 'YES' : 'NO'}`,
    '',
  ];

  if (!data.active || sub === null) {
    lines.push('No active subscription found for this user.', '');
    lines.push('**Possible reasons:**');
    lines.push('- User has never purchased a subscription');
    lines.push('- Subscription has expired or been canceled');
    lines.push('- Purchase was made under a different user ID');
    lines.push('');
    lines.push('**Next steps:**');
    lines.push('- Run `onesub_setup` to review the client-side integration');
    lines.push('- Use `onesub_troubleshoot` if a purchase was made but status is still inactive');
    return lines.join('\n');
  }

  const expiresAt = new Date(sub.expiresAt);
  const purchasedAt = new Date(sub.purchasedAt);
  const now = new Date();
  const daysUntilExpiry = Math.ceil(
    (expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
  );

  lines.push('## Subscription Details', '');
  lines.push('| Field | Value |');
  lines.push('|-------|-------|');
  lines.push(`| Product ID | \`${sub.productId}\` |`);
  lines.push(
    `| Platform | ${sub.platform === 'apple' ? 'Apple App Store' : 'Google Play'} |`,
  );
  lines.push(`| Status | ${sub.status} |`);
  lines.push(`| Will Renew | ${sub.willRenew ? 'Yes' : 'No'} |`);
  lines.push(`| Purchased At | ${purchasedAt.toISOString()} |`);
  lines.push(`| Expires At | ${expiresAt.toISOString()} |`);
  lines.push(
    `| Days Until Expiry | ${daysUntilExpiry > 0 ? daysUntilExpiry : 'Already expired'} |`,
  );
  lines.push(`| Transaction ID | \`${sub.originalTransactionId}\` |`);

  if (!sub.willRenew) {
    lines.push('', '**Note:** This subscription will NOT auto-renew. The user has canceled.');
  }

  if (daysUntilExpiry <= 3 && daysUntilExpiry > 0) {
    lines.push('', '**Warning:** Subscription expires in less than 3 days.');
  }

  if (daysUntilExpiry <= 0) {
    lines.push('', '**Warning:** Subscription has already expired. `active: true` may be stale — check server-side receipt validation.');
  }

  return lines.join('\n');
}

function buildHttpErrorOutput(opts: {
  url: string;
  userId: string;
  httpStatus: number;
  rawBody: string;
}): string {
  const { url, userId, httpStatus, rawBody } = opts;

  const lines: string[] = [
    '# Subscriber Status — Error',
    '',
    `**User ID:** \`${userId}\``,
    `**Endpoint:** \`${url}\``,
    `**HTTP Status:** ${httpStatus}`,
    '',
    '## Server Response',
    '```',
    rawBody.slice(0, 500),
    '```',
    '',
    '## Troubleshooting',
  ];

  if (httpStatus === 401 || httpStatus === 403) {
    lines.push('- The server requires authentication for this endpoint.');
    lines.push('- If your onesub server has auth middleware, ensure `/onesub/status` is accessible.');
  } else if (httpStatus === 404) {
    lines.push('- The `/onesub/status` route was not found.');
    lines.push('- Verify `@onesub/server` middleware is mounted and the server is running.');
  } else if (httpStatus >= 500) {
    lines.push('- The server returned an internal error. Check server logs for details.');
    lines.push('- Common causes: database connection failure, missing environment variables.');
  }

  lines.push('', 'Run `onesub_troubleshoot` for a deeper diagnosis.');
  return lines.join('\n');
}

function buildNetworkErrorOutput(opts: {
  url: string;
  userId: string;
  message: string;
}): string {
  const { url, userId, message } = opts;
  const isTimeout =
    message.toLowerCase().includes('timeout') || message.toLowerCase().includes('abort');
  const isConnRefused =
    message.toLowerCase().includes('econnrefused') ||
    message.toLowerCase().includes('failed to fetch');

  const lines: string[] = [
    '# Subscriber Status — Connection Failed',
    '',
    `**User ID:** \`${userId}\``,
    `**Endpoint:** \`${url}\``,
    `**Error:** ${message}`,
    '',
    '## Troubleshooting',
  ];

  if (isConnRefused) {
    lines.push('- The onesub server is not running or unreachable at this URL.');
    lines.push('- Start the server and verify the `serverUrl` (including port).');
  } else if (isTimeout) {
    lines.push('- The request timed out after 10 seconds.');
    lines.push('- Check server health and database connectivity.');
  } else {
    lines.push('- Verify the server URL is reachable from this machine.');
    lines.push('- Check for SSL/TLS issues if using HTTPS.');
  }

  return lines.join('\n');
}
