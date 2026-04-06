import { z } from 'zod';
import { ROUTES } from '@onesub/shared';
import type { StatusResponse } from '@onesub/shared';

export const checkStatusInputSchema = {
  serverUrl: z
    .string()
    .url()
    .describe('Base URL of the onesub validation server (e.g. "https://api.yourapp.com")'),
  userId: z.string().min(1).describe('The user ID to check subscription status for'),
};

export async function runCheckStatus(args: {
  serverUrl: string;
  userId: string;
}): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const url = `${args.serverUrl.replace(/\/$/, '')}${ROUTES.STATUS}?userId=${encodeURIComponent(args.userId)}`;

  let data: StatusResponse;
  let httpStatus: number;
  let rawBody: string;

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    httpStatus = response.status;
    rawBody = await response.text();

    if (!response.ok) {
      const text = buildErrorOutput({
        url,
        userId: args.userId,
        httpStatus,
        rawBody,
      });
      return { content: [{ type: 'text', text }] };
    }

    data = JSON.parse(rawBody) as StatusResponse;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const text = buildNetworkErrorOutput({ url, userId: args.userId, message });
    return { content: [{ type: 'text', text }] };
  }

  const text = buildSuccessOutput({ url, userId: args.userId, data });
  return { content: [{ type: 'text', text }] };
}

function buildSuccessOutput(opts: {
  url: string;
  userId: string;
  data: StatusResponse;
}): string {
  const { url, userId, data } = opts;
  const sub = data.subscription;

  const lines: string[] = [
    '# Subscription Status',
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
    lines.push('- Purchase was made with a different user ID');
    lines.push('');
    lines.push('**Next steps:**');
    lines.push('- Run `onesub_setup` to review the integration');
    lines.push('- Use `onesub_troubleshoot` if a purchase was made but status is still inactive');
    return lines.join('\n');
  }

  const expiresAt = new Date(sub.expiresAt);
  const purchasedAt = new Date(sub.purchasedAt);
  const now = new Date();
  const daysUntilExpiry = Math.ceil((expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

  lines.push('## Subscription Details', '');
  lines.push(`| Field | Value |`);
  lines.push(`|-------|-------|`);
  lines.push(`| Product ID | \`${sub.productId}\` |`);
  lines.push(`| Platform | ${sub.platform === 'apple' ? 'Apple App Store' : 'Google Play'} |`);
  lines.push(`| Status | ${sub.status} |`);
  lines.push(`| Will Renew | ${sub.willRenew ? 'Yes' : 'No'} |`);
  lines.push(`| Purchased At | ${purchasedAt.toISOString()} |`);
  lines.push(`| Expires At | ${expiresAt.toISOString()} |`);
  lines.push(
    `| Days Until Expiry | ${daysUntilExpiry > 0 ? daysUntilExpiry : 'Already expired'} |`,
  );
  lines.push(`| Transaction ID | \`${sub.originalTransactionId}\` |`);

  if (!sub.willRenew) {
    lines.push('', '**Note:** This subscription will NOT renew. The user has canceled.');
  }

  if (daysUntilExpiry <= 3 && daysUntilExpiry > 0) {
    lines.push('', '**Warning:** Subscription expires in less than 3 days.');
  }

  return lines.join('\n');
}

function buildErrorOutput(opts: {
  url: string;
  userId: string;
  httpStatus: number;
  rawBody: string;
}): string {
  const { url, userId, httpStatus, rawBody } = opts;

  const lines: string[] = [
    '# Subscription Status — Error',
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
    lines.push('- The server requires authentication. Check if your onesub server is configured to allow status checks.');
    lines.push('- If you added auth middleware, ensure it allows the `/onesub/status` route or provides a service token.');
  } else if (httpStatus === 404) {
    lines.push('- The `/onesub/status` route was not found. Verify `@onesub/server` middleware is mounted correctly.');
    lines.push('- Check that the server is using `createOneSubServer()` or has the onesub router registered.');
  } else if (httpStatus >= 500) {
    lines.push('- The server returned an internal error. Check server logs.');
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
  const isTimeout = message.toLowerCase().includes('timeout') || message.toLowerCase().includes('abort');
  const isConnRefused =
    message.toLowerCase().includes('econnrefused') || message.toLowerCase().includes('failed to fetch');

  const lines: string[] = [
    '# Subscription Status — Connection Failed',
    '',
    `**User ID:** \`${userId}\``,
    `**Endpoint:** \`${url}\``,
    `**Error:** ${message}`,
    '',
    '## Troubleshooting',
  ];

  if (isConnRefused) {
    lines.push('- The onesub server is not running or not reachable at this URL.');
    lines.push('- Start the server: `npm run start` (or `node dist/index.js`)');
    lines.push('- Verify the `serverUrl` is correct (including port if non-standard).');
  } else if (isTimeout) {
    lines.push('- The request timed out after 10 seconds.');
    lines.push('- Check server health and database connectivity.');
    lines.push('- If the server is behind a proxy/load balancer, check its health too.');
  } else {
    lines.push('- Verify the server URL is reachable from this machine.');
    lines.push('- Check for SSL/TLS issues if using HTTPS.');
    lines.push('- Ensure there are no firewall rules blocking the connection.');
  }

  return lines.join('\n');
}
