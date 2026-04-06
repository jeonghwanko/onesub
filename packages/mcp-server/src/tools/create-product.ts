import { z } from 'zod';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const appleConnect = require('../../providers/apple-connect.js') as {
  createAppleSubscription: (opts: AppleCreateOpts) => Promise<AppleCreateResult>;
  listAppleProducts: (opts: AppleListOpts) => Promise<AppleProduct[]>;
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const googlePlay = require('../../providers/google-play.js') as {
  createGoogleSubscription: (opts: GoogleCreateOpts) => Promise<GoogleCreateResult>;
  listGoogleProducts: (opts: GoogleListOpts) => Promise<GoogleProduct[]>;
};

interface AppleCreateOpts {
  productId: string;
  name: string;
  price: number;
  currency: string;
  period: 'monthly' | 'yearly';
  keyId: string;
  issuerId: string;
  privateKey: string;
  appId: string;
}

interface AppleCreateResult {
  success: boolean;
  productId?: string;
  error?: string;
}

interface AppleListOpts {
  keyId: string;
  issuerId: string;
  privateKey: string;
  appId: string;
}

interface AppleProduct {
  productId: string;
  name?: string;
}

interface GoogleCreateOpts {
  productId: string;
  name: string;
  price: number;
  currency: string;
  period: 'monthly' | 'yearly';
  packageName: string;
  serviceAccountKey: string;
}

interface GoogleCreateResult {
  success: boolean;
  productId?: string;
  error?: string;
}

interface GoogleListOpts {
  packageName: string;
  serviceAccountKey: string;
}

interface GoogleProduct {
  productId: string;
  name?: string;
}

export const createProductInputSchema = {
  platform: z.enum(['apple', 'google', 'both']).describe('Target platform'),
  productId: z.string().describe('Product ID (e.g. "premium_monthly")'),
  name: z.string().describe('Display name (e.g. "Premium Monthly")'),
  price: z
    .number()
    .describe('Price in the smallest unit (e.g. 499 for $4.99, 4900 for ₩4,900)'),
  currency: z.string().default('USD').describe('Currency code (USD, KRW, etc.)'),
  period: z
    .enum(['monthly', 'yearly'])
    .default('monthly')
    .describe('Billing period'),
  appleKeyId: z.string().optional().describe('App Store Connect API Key ID'),
  appleIssuerId: z.string().optional().describe('App Store Connect Issuer ID'),
  applePrivateKey: z.string().optional().describe('P8 private key contents'),
  appleAppId: z.string().optional().describe('App Store Connect App ID'),
  googlePackageName: z.string().optional().describe('Android package name'),
  googleServiceAccountKey: z
    .string()
    .optional()
    .describe('Google service account JSON key'),
};

type CreateProductArgs = {
  platform: 'apple' | 'google' | 'both';
  productId: string;
  name: string;
  price: number;
  currency?: string;
  period?: 'monthly' | 'yearly';
  appleKeyId?: string;
  appleIssuerId?: string;
  applePrivateKey?: string;
  appleAppId?: string;
  googlePackageName?: string;
  googleServiceAccountKey?: string;
};

export async function runCreateProduct(
  args: CreateProductArgs,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const currency = args.currency ?? 'USD';
  const period = args.period ?? 'monthly';

  const needsApple = args.platform === 'apple' || args.platform === 'both';
  const needsGoogle = args.platform === 'google' || args.platform === 'both';

  let appleResult: AppleCreateResult | null = null;
  let googleResult: GoogleCreateResult | null = null;
  let appleConfigError: string | null = null;
  let googleConfigError: string | null = null;

  if (needsApple) {
    if (
      !args.appleKeyId ||
      !args.appleIssuerId ||
      !args.applePrivateKey ||
      !args.appleAppId
    ) {
      appleConfigError =
        'Missing required Apple config: appleKeyId, appleIssuerId, applePrivateKey, appleAppId';
    } else {
      try {
        appleResult = await appleConnect.createAppleSubscription({
          productId: args.productId,
          name: args.name,
          price: args.price,
          currency,
          period,
          keyId: args.appleKeyId,
          issuerId: args.appleIssuerId,
          privateKey: args.applePrivateKey,
          appId: args.appleAppId,
        });
      } catch (err: unknown) {
        appleResult = {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
  }

  if (needsGoogle) {
    if (!args.googlePackageName || !args.googleServiceAccountKey) {
      googleConfigError =
        'Missing required Google config: googlePackageName, googleServiceAccountKey';
    } else {
      try {
        googleResult = await googlePlay.createGoogleSubscription({
          productId: args.productId,
          name: args.name,
          price: args.price,
          currency,
          period,
          packageName: args.googlePackageName,
          serviceAccountKey: args.googleServiceAccountKey,
        });
      } catch (err: unknown) {
        googleResult = {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
  }

  const text = buildCreateOutput({
    productId: args.productId,
    name: args.name,
    price: args.price,
    currency,
    period,
    needsApple,
    needsGoogle,
    appleResult,
    googleResult,
    appleConfigError,
    googleConfigError,
  });

  return { content: [{ type: 'text', text }] };
}

function buildCreateOutput(opts: {
  productId: string;
  name: string;
  price: number;
  currency: string;
  period: string;
  needsApple: boolean;
  needsGoogle: boolean;
  appleResult: AppleCreateResult | null;
  googleResult: GoogleCreateResult | null;
  appleConfigError: string | null;
  googleConfigError: string | null;
}): string {
  const {
    productId,
    name,
    price,
    currency,
    period,
    needsApple,
    needsGoogle,
    appleResult,
    googleResult,
    appleConfigError,
    googleConfigError,
  } = opts;

  const lines: string[] = [
    '# Create Subscription Product',
    '',
    `**Product ID:** \`${productId}\``,
    `**Name:** ${name}`,
    `**Price:** ${price} ${currency} / ${period}`,
    `**Platforms configured:** ${[needsApple && 'Apple', needsGoogle && 'Google'].filter(Boolean).join(', ')}`,
    '',
    '---',
  ];

  if (needsApple) {
    lines.push('', '## Apple App Store Connect');
    if (appleConfigError) {
      lines.push('', `**Status:** Failed (configuration error)`);
      lines.push(`**Error:** ${appleConfigError}`);
      lines.push('', '**Required fields:**');
      lines.push('- `appleKeyId` — App Store Connect API Key ID');
      lines.push('- `appleIssuerId` — App Store Connect Issuer ID');
      lines.push('- `applePrivateKey` — Contents of the .p8 private key file');
      lines.push('- `appleAppId` — Your app\'s App Store Connect App ID');
    } else if (appleResult) {
      if (appleResult.success) {
        lines.push('', `**Status:** Success`);
        lines.push(`**Created product ID:** \`${appleResult.productId ?? productId}\``);
        lines.push('', '**Next steps:**');
        lines.push('1. Open [App Store Connect](https://appstoreconnect.apple.com) → your app → Subscriptions.');
        lines.push('2. Locate the newly created product and set up pricing tiers for each storefront.');
        lines.push('3. Add localized descriptions and screenshots if required.');
        lines.push('4. Submit the subscription for App Review before going live.');
      } else {
        lines.push('', `**Status:** Failed`);
        lines.push(`**Error:** ${appleResult.error ?? 'Unknown error'}`);
        lines.push('', '**Troubleshooting tips:**');
        lines.push('- Verify the API key has the "App Manager" or higher role in App Store Connect.');
        lines.push('- Ensure the private key has not been revoked.');
        lines.push('- Check that `appleAppId` matches the app in App Store Connect.');
      }
    }
  }

  if (needsGoogle) {
    lines.push('', '## Google Play Console');
    if (googleConfigError) {
      lines.push('', `**Status:** Failed (configuration error)`);
      lines.push(`**Error:** ${googleConfigError}`);
      lines.push('', '**Required fields:**');
      lines.push('- `googlePackageName` — Android package name (e.g. `com.yourapp`)');
      lines.push('- `googleServiceAccountKey` — Contents of the service account JSON key');
    } else if (googleResult) {
      if (googleResult.success) {
        lines.push('', `**Status:** Success`);
        lines.push(`**Created product ID:** \`${googleResult.productId ?? productId}\``);
        lines.push('', '**Next steps:**');
        lines.push('1. Open [Google Play Console](https://play.google.com/console) → your app → Monetize → Subscriptions.');
        lines.push('2. Locate the subscription and **activate the base plan** (required before purchases work).');
        lines.push('3. Add pricing for each target country/region.');
        lines.push('4. Set up Real-Time Developer Notifications (RTDN) via Google Cloud Pub/Sub.');
      } else {
        lines.push('', `**Status:** Failed`);
        lines.push(`**Error:** ${googleResult.error ?? 'Unknown error'}`);
        lines.push('', '**Troubleshooting tips:**');
        lines.push('- Verify the service account has the "Financial data viewer" and "Manage orders" permissions in Play Console.');
        lines.push('- Ensure the Google Play Android Developer API is enabled in Google Cloud Console.');
        lines.push('- Check that `googlePackageName` exactly matches the published app package name.');
      }
    }
  }

  lines.push('', '---', '');

  const allSucceeded =
    (!needsApple || (appleResult?.success === true && !appleConfigError)) &&
    (!needsGoogle || (googleResult?.success === true && !googleConfigError));

  const anyFailed =
    (needsApple && (!!appleConfigError || appleResult?.success === false)) ||
    (needsGoogle && (!!googleConfigError || googleResult?.success === false));

  if (allSucceeded) {
    lines.push('**All platforms configured successfully.** Use `onesub_list_products` to verify the products are visible.');
  } else if (anyFailed) {
    lines.push('**One or more platforms encountered errors.** Review the details above and retry with corrected credentials.');
  }

  return lines.join('\n');
}
