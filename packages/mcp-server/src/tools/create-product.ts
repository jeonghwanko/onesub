import { z } from 'zod';
import {
  createAppleSubscription,
  createAppleOneTimePurchase,
  listAppleProducts,
  resolveAppleAppId,
  createGoogleSubscription,
  createGoogleOneTimePurchase,
  type AppleCreateSubscriptionResult,
  type AppleCreateOneTimePurchaseResult,
  type AppleProductRecord,
  type GoogleCreateSubscriptionResult,
  type GoogleCreateOneTimePurchaseResult,
  type RegionPrice,
} from '@onesub/providers';

export const createProductInputSchema = {
  platform: z.enum(['apple', 'google', 'both']).describe('Target platform'),
  productId: z.string().describe('Product ID (e.g. "premium_monthly")'),
  name: z.string().describe('Display name (e.g. "Premium Monthly")'),
  price: z
    .number()
    .describe('Price in the smallest unit (e.g. 499 for $4.99, 4900 for ₩4,900)'),
  currency: z.string().default('USD').describe('Currency code (USD, KRW, etc.)'),
  productType: z
    .enum(['subscription', 'consumable', 'non_consumable'])
    .default('subscription')
    .describe('Product type: subscription (auto-renewable), consumable (can be bought multiple times), or non_consumable (one-time purchase)'),
  period: z
    .enum(['monthly', 'yearly'])
    .default('monthly')
    .describe('Billing period — only applies to subscriptions'),
  extraRegions: z
    .array(z.object({ currency: z.string(), price: z.number() }))
    .optional()
    .describe('Additional region prices, e.g. [{ currency: "KRW", price: 4900 }, { currency: "JPY", price: 600 }]'),
  appleKeyId: z.string().optional().describe('App Store Connect API Key ID'),
  appleIssuerId: z.string().optional().describe('App Store Connect Issuer ID'),
  applePrivateKey: z.string().optional().describe('P8 private key contents'),
  appleAppId: z
    .string()
    .optional()
    .describe('App Store Connect numeric App ID (e.g. "6504191153")'),
  appleBundleId: z
    .string()
    .optional()
    .describe('iOS bundle ID (e.g. "gg.pryzm.carrot") — auto-resolves to App ID if appleAppId is not provided'),
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
  productType?: 'subscription' | 'consumable' | 'non_consumable';
  period?: 'monthly' | 'yearly';
  extraRegions?: RegionPrice[];
  appleKeyId?: string;
  appleIssuerId?: string;
  applePrivateKey?: string;
  appleAppId?: string;
  appleBundleId?: string;
  googlePackageName?: string;
  googleServiceAccountKey?: string;
};

type AppleCreateResult = AppleCreateSubscriptionResult | AppleCreateOneTimePurchaseResult;
type GoogleCreateResult = GoogleCreateSubscriptionResult | GoogleCreateOneTimePurchaseResult;

export async function runCreateProduct(
  args: CreateProductArgs,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const currency = args.currency ?? 'USD';
  const productType = args.productType ?? 'subscription';
  const period = args.period ?? 'monthly';
  const extraRegions = args.extraRegions ?? [];

  const needsApple = args.platform === 'apple' || args.platform === 'both';
  const needsGoogle = args.platform === 'google' || args.platform === 'both';

  let appleResult: AppleCreateResult | null = null;
  let googleResult: GoogleCreateResult | null = null;
  let appleConfigError: string | null = null;
  let googleConfigError: string | null = null;
  let resolvedAppleAppId: string | undefined = args.appleAppId;

  if (needsApple) {
    if (!args.appleKeyId || !args.appleIssuerId || !args.applePrivateKey) {
      appleConfigError =
        'Missing required Apple config: appleKeyId, appleIssuerId, applePrivateKey';
    } else if (!args.appleAppId && !args.appleBundleId) {
      appleConfigError =
        'Missing required Apple config: provide either appleAppId (numeric App Store Connect ID) or appleBundleId (e.g. "gg.pryzm.carrot")';
    } else {
      if (!args.appleAppId && args.appleBundleId) {
        try {
          const resolved = await resolveAppleAppId(
            { keyId: args.appleKeyId, issuerId: args.appleIssuerId, privateKey: args.applePrivateKey },
            args.appleBundleId,
          );
          if (resolved) resolvedAppleAppId = resolved;
        } catch { /* non-fatal */ }
      }

      try {
        const creds = {
          keyId: args.appleKeyId,
          issuerId: args.appleIssuerId,
          privateKey: args.applePrivateKey,
          appId: args.appleAppId,
          bundleId: args.appleBundleId,
        };
        if (productType === 'subscription') {
          appleResult = await createAppleSubscription({ ...creds, productId: args.productId, name: args.name, price: args.price, currency, period, extraRegions });
        } else {
          appleResult = await createAppleOneTimePurchase({ ...creds, productId: args.productId, name: args.name, price: args.price, currency, type: productType, extraRegions });
        }
      } catch (err: unknown) {
        appleResult = {
          success: false,
          error: err instanceof Error ? err.message : String(err),
          errorType: 'UNKNOWN',
        };
      }
    }
  }

  let existingAppleProducts: AppleProductRecord[] | null = null;
  if (
    needsApple &&
    appleResult?.errorType === 'DUPLICATE' &&
    resolvedAppleAppId &&
    args.appleKeyId &&
    args.appleIssuerId &&
    args.applePrivateKey
  ) {
    try {
      existingAppleProducts = await listAppleProducts({
        keyId: args.appleKeyId,
        issuerId: args.appleIssuerId,
        privateKey: args.applePrivateKey,
        appId: resolvedAppleAppId,
      });
    } catch { /* non-fatal */ }
  }

  if (needsGoogle) {
    if (!args.googlePackageName || !args.googleServiceAccountKey) {
      googleConfigError =
        'Missing required Google config: googlePackageName, googleServiceAccountKey';
    } else {
      try {
        if (productType === 'subscription') {
          googleResult = await createGoogleSubscription({
            productId: args.productId,
            name: args.name,
            price: args.price,
            currency,
            period,
            extraRegions,
            packageName: args.googlePackageName,
            serviceAccountKey: args.googleServiceAccountKey,
          });
        } else {
          googleResult = await createGoogleOneTimePurchase({
            productId: args.productId,
            name: args.name,
            price: args.price,
            currency,
            type: productType,
            extraRegions,
            packageName: args.googlePackageName,
            serviceAccountKey: args.googleServiceAccountKey,
          });
        }
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
    productType,
    period,
    needsApple,
    needsGoogle,
    appleResult,
    googleResult,
    appleConfigError,
    googleConfigError,
    existingAppleProducts,
  });

  return { content: [{ type: 'text', text }] };
}

function buildCreateOutput(opts: {
  productId: string;
  name: string;
  price: number;
  currency: string;
  productType: string;
  period: string;
  needsApple: boolean;
  needsGoogle: boolean;
  appleResult: AppleCreateResult | null;
  googleResult: GoogleCreateResult | null;
  appleConfigError: string | null;
  googleConfigError: string | null;
  existingAppleProducts: AppleProductRecord[] | null;
}): string {
  const {
    productId, name, price, currency, productType, period,
    needsApple, needsGoogle,
    appleResult, googleResult,
    appleConfigError, googleConfigError,
    existingAppleProducts,
  } = opts;

  const typeLabel = productType === 'subscription'
    ? `subscription / ${period}`
    : productType === 'consumable' ? 'consumable (one-time)' : 'non-consumable (one-time)';

  const lines: string[] = [
    '# Create IAP Product',
    '',
    `**Product ID:** \`${productId}\``,
    `**Name:** ${name}`,
    `**Type:** ${typeLabel}`,
    `**Price:** ${price} ${currency}`,
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
      lines.push('- `appleAppId` — Your app\'s numeric App Store Connect App ID, OR');
      lines.push('- `appleBundleId` — Your iOS bundle ID (e.g. `gg.pryzm.carrot`) for automatic lookup');
    } else if (appleResult) {
      if (appleResult.success) {
        lines.push('', `**Status:** Success`);
        lines.push(`**Created product ID:** \`${appleResult.productId ?? productId}\``);
        if ('internalId' in appleResult && appleResult.internalId) {
          lines.push(`**Internal ID:** \`${appleResult.internalId}\``);
        }

        if (appleResult.priceSet) {
          lines.push(`**Price:** Set automatically (${price} ${currency})`);
        } else if (appleResult.priceNearest && appleResult.priceNearest.length > 0) {
          lines.push('');
          lines.push(`**Price:** Not set — ${price.toLocaleString()} ${currency} is not an Apple price tier.`);
          lines.push('Apple uses fixed price tiers. Nearest available options:');
          for (const p of appleResult.priceNearest) {
            lines.push(`  - ${parseFloat(p.price).toLocaleString()} ${currency} (price point ID: \`${p.id}\`)`);
          }
          lines.push('');
          lines.push('Set the price manually in [App Store Connect](https://appstoreconnect.apple.com).');
        } else {
          lines.push('**Price:** Not set automatically — set manually in App Store Connect.');
        }

        if ('extraRegionsSet' in appleResult && appleResult.extraRegionsSet && appleResult.extraRegionsSet.length > 0) {
          lines.push(`**Extra regions set:** ${appleResult.extraRegionsSet.join(', ')}`);
        }

        if ('localizationAdded' in appleResult && appleResult.localizationAdded) {
          lines.push('**Korean localization:** Added');
        }

        lines.push('', '**Next steps:**');
        if (productType === 'subscription') {
          if (!appleResult.priceSet) {
            lines.push('1. Set the subscription price in App Store Connect.');
          }
          lines.push(`${!appleResult.priceSet ? '2' : '1'}. Add localized descriptions in App Store Connect if required.`);
          lines.push(`${!appleResult.priceSet ? '3' : '2'}. Submit the subscription for App Review before going live.`);
        } else {
          if (!appleResult.priceSet) {
            lines.push('1. Set the product price in App Store Connect.');
          }
          lines.push(`${!appleResult.priceSet ? '2' : '1'}. Add a localized description in App Store Connect if required.`);
        }
      } else {
        lines.push('', `**Status:** Failed`);
        lines.push(`**Error:** ${appleResult.error ?? 'Unknown error'}`);

        switch (appleResult.errorType) {
          case 'DUPLICATE':
            lines.push('', '**This product ID already exists.** Options:');
            lines.push('- Choose a different `productId` and retry.');
            lines.push('- Use `onesub_list_products` to see all existing products.');
            if (existingAppleProducts && existingAppleProducts.length > 0) {
              lines.push('', '**Existing products on this app:**');
              for (const p of existingAppleProducts) {
                const label = p.name ? ` — ${p.name}` : '';
                lines.push(`  - \`${p.productId}\`${label}`);
              }
            }
            break;
          case 'AUTH':
            lines.push('', '**How to fix:**');
            lines.push('1. Go to [App Store Connect → Users and Access → Keys](https://appstoreconnect.apple.com/access/api).');
            lines.push('2. Verify the key is active and has not been revoked.');
            lines.push('3. Ensure the key role is "App Manager" or higher.');
            lines.push('4. Confirm `appleKeyId` and `appleIssuerId` match the key in App Store Connect.');
            break;
          case 'RELATIONSHIP':
            lines.push('', '**Troubleshooting tips:**');
            lines.push('- Verify `appleAppId` (or `appleBundleId`) points to the correct app.');
            lines.push('- Ensure the API key has access to the target app.');
            break;
          default:
            lines.push('', '**Troubleshooting tips:**');
            lines.push('- Verify the API key has the "App Manager" or higher role in App Store Connect.');
            lines.push('- Check that `appleAppId` matches the app in App Store Connect.');
        }
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
        if (productType === 'subscription') {
          lines.push('1. Open [Google Play Console](https://play.google.com/console) → your app → Monetize → Subscriptions.');
          lines.push('2. Locate the subscription and **activate the base plan** (required before purchases work).');
          lines.push('3. Set up Real-Time Developer Notifications (RTDN) via Google Cloud Pub/Sub.');
        } else {
          lines.push('1. Open [Google Play Console](https://play.google.com/console) → your app → Monetize → In-app products.');
          lines.push('2. Verify the product is active and pricing is correct.');
        }
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
    lines.push('**All platforms configured successfully.** Use `onesub_list_products` to verify.');
  } else if (anyFailed) {
    lines.push('**One or more platforms encountered errors.** Review the details above and retry with corrected credentials.');
  }

  return lines.join('\n');
}
