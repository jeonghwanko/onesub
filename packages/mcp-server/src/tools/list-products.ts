import { z } from 'zod';
import {
  listAppleProducts,
  listGoogleProducts,
  type AppleProductRecord,
  type GoogleProductRecord,
} from '@onesub/providers';

export const listProductsInputSchema = {
  platform: z.enum(['apple', 'google', 'both']).default('both'),
  appleKeyId: z.string().optional(),
  appleIssuerId: z.string().optional(),
  applePrivateKey: z.string().optional(),
  appleAppId: z.string().optional(),
  googlePackageName: z.string().optional(),
  googleServiceAccountKey: z.string().optional(),
};

type ListProductsArgs = {
  platform?: 'apple' | 'google' | 'both';
  appleKeyId?: string;
  appleIssuerId?: string;
  applePrivateKey?: string;
  appleAppId?: string;
  googlePackageName?: string;
  googleServiceAccountKey?: string;
};

export async function runListProducts(
  args: ListProductsArgs,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const platform = args.platform ?? 'both';
  const needsApple = platform === 'apple' || platform === 'both';
  const needsGoogle = platform === 'google' || platform === 'both';

  let appleProducts: AppleProductRecord[] | null = null;
  let googleProducts: GoogleProductRecord[] | null = null;
  let appleError: string | null = null;
  let googleError: string | null = null;

  if (needsApple) {
    if (!args.appleKeyId || !args.appleIssuerId || !args.applePrivateKey || !args.appleAppId) {
      appleError =
        'Missing required Apple credentials: appleKeyId, appleIssuerId, applePrivateKey, appleAppId';
    } else {
      try {
        appleProducts = await listAppleProducts({
          keyId: args.appleKeyId,
          issuerId: args.appleIssuerId,
          privateKey: args.applePrivateKey,
          appId: args.appleAppId,
        });
      } catch (err: unknown) {
        appleError = err instanceof Error ? err.message : String(err);
      }
    }
  }

  if (needsGoogle) {
    if (!args.googlePackageName || !args.googleServiceAccountKey) {
      googleError =
        'Missing required Google credentials: googlePackageName, googleServiceAccountKey';
    } else {
      try {
        googleProducts = await listGoogleProducts({
          packageName: args.googlePackageName,
          serviceAccountKey: args.googleServiceAccountKey,
        });
      } catch (err: unknown) {
        googleError = err instanceof Error ? err.message : String(err);
      }
    }
  }

  const text = buildListOutput({
    needsApple,
    needsGoogle,
    appleProducts,
    googleProducts,
    appleError,
    googleError,
  });

  return { content: [{ type: 'text', text }] };
}

function buildListOutput(opts: {
  needsApple: boolean;
  needsGoogle: boolean;
  appleProducts: AppleProductRecord[] | null;
  googleProducts: GoogleProductRecord[] | null;
  appleError: string | null;
  googleError: string | null;
}): string {
  const { needsApple, needsGoogle, appleProducts, googleProducts, appleError, googleError } = opts;

  const lines: string[] = ['# IAP Products', ''];

  if (needsApple) {
    lines.push('## Apple App Store Connect', '');
    if (appleError) {
      lines.push(`**Error:** ${appleError}`, '');
    } else if (!appleProducts || appleProducts.length === 0) {
      lines.push('No products found.', '');
    } else {
      lines.push(`Found **${appleProducts.length}** product(s).`, '');
      lines.push('| Product ID | Name | Type | Status | Price |');
      lines.push('|------------|------|------|--------|-------|');
      for (const p of appleProducts) {
        const name = p.name ?? '—';
        const type = p.type ?? '—';
        const status = p.status ?? '—';
        const price =
          p.price != null && p.currency
            ? `${p.price} ${p.currency}`
            : p.price != null
              ? String(p.price)
              : '—';
        lines.push(`| \`${p.productId}\` | ${name} | ${type} | ${status} | ${price} |`);
      }
      lines.push('');
    }
  }

  if (needsGoogle) {
    lines.push('## Google Play Console', '');
    if (googleError) {
      lines.push(`**Error:** ${googleError}`, '');
    } else if (!googleProducts || googleProducts.length === 0) {
      lines.push('No products found.', '');
    } else {
      lines.push(`Found **${googleProducts.length}** product(s).`, '');
      lines.push('| Product ID | Name | Type | Status | Price |');
      lines.push('|------------|------|------|--------|-------|');
      for (const p of googleProducts) {
        const name = p.name ?? '—';
        const type = p.type ?? '—';
        const status = p.status ?? '—';
        const price =
          p.price != null && p.currency
            ? `${p.price} ${p.currency}`
            : p.price != null
              ? String(p.price)
              : '—';
        lines.push(`| \`${p.productId}\` | ${name} | ${type} | ${status} | ${price} |`);
      }
      lines.push('');
    }
  }

  lines.push('---', '');
  lines.push(
    'Use `onesub_create_product` to add new products, `onesub_manage_product` to update or delete, or `onesub_check_status` to verify a user\'s subscription.',
  );

  return lines.join('\n');
}
