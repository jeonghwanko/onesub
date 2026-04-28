import { z } from 'zod';
import { ROUTES } from '@onesub/shared';
import type { StatusResponse } from '@onesub/shared';
import { normalizeUrl, fetchJson } from '../utils.js';

export const viewSubscribersInputSchema = {
  serverUrl: z.string().url().describe('onesub server URL'),
  userId: z
    .string()
    .optional()
    .describe('Check specific user (omit for summary)'),
};

type ViewSubscribersArgs = {
  serverUrl: string;
  userId?: string;
};

export async function runViewSubscribers(
  args: ViewSubscribersArgs,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  if (!args.userId) {
    const text = buildNoUserIdOutput(args.serverUrl);
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
    'The onesub server does not expose a list-all-subscribers endpoint at this time.',
    'Subscriber data is queried per user via the `/onesub/status` endpoint.',
    '',
    '## How to query individual users',
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
    `curl "${baseUrl}/onesub/status?userId=YOUR_USER_ID"`,
    '```',
    '',
    '**Example response (active subscriber):**',
    '```json',
    '{',
    '  "active": true,',
    '  "subscription": {',
    '    "productId": "premium_monthly",',
    '    "platform": "apple",',
    '    "status": "active",',
    '    "willRenew": true,',
    '    "purchasedAt": "2025-01-01T00:00:00.000Z",',
    '    "expiresAt": "2025-02-01T00:00:00.000Z",',
    '    "originalTransactionId": "1234567890"',
    '  }',
    '}',
    '```',
    '',
    '**Example response (no subscription):**',
    '```json',
    '{ "active": false, "subscription": null }',
    '```',
    '',
    '## Alternatives for bulk reporting',
    '',
    'If you need aggregate subscriber counts or analytics, consider:',
    '- Querying your app database directly (the `Subscription` table populated by onesub)',
    '- Checking subscription metrics in [App Store Connect](https://appstoreconnect.apple.com) → Trends → Subscriptions',
    '- Checking subscription metrics in [Google Play Console](https://play.google.com/console) → Monetize → Subscriptions',
  ];

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
