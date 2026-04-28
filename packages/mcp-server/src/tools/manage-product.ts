import { z } from 'zod';
import {
  updateAppleProduct,
  deleteAppleProduct,
  updateGoogleProduct,
  deleteGoogleProduct,
  type AppleUpdateProductResult,
  type AppleDeleteProductResult,
  type GoogleUpdateProductResult,
  type GoogleDeleteProductResult,
  type AppleProductType,
  type GoogleProductType,
} from '@onesub/providers';

export const manageProductInputSchema = {
  action: z.enum(['update', 'delete']).describe('"update" to rename a product, "delete" to remove it'),
  platform: z.enum(['apple', 'google', 'both']).describe('Target platform'),
  productId: z.string().describe('Product ID to update or delete'),
  productType: z
    .enum(['subscription', 'consumable', 'non_consumable'])
    .describe('Product type — required to route to the correct API endpoint'),
  name: z.string().optional().describe('New display name (required for update action)'),
  appleKeyId: z.string().optional().describe('App Store Connect API Key ID'),
  appleIssuerId: z.string().optional().describe('App Store Connect Issuer ID'),
  applePrivateKey: z.string().optional().describe('P8 private key contents'),
  appleAppId: z.string().optional().describe('App Store Connect numeric App ID'),
  appleBundleId: z.string().optional().describe('iOS bundle ID (used to resolve App ID if appleAppId is not provided)'),
  googlePackageName: z.string().optional().describe('Android package name'),
  googleServiceAccountKey: z.string().optional().describe('Google service account JSON key'),
};

type ManageProductArgs = {
  action: 'update' | 'delete';
  platform: 'apple' | 'google' | 'both';
  productId: string;
  productType: 'subscription' | 'consumable' | 'non_consumable';
  name?: string;
  appleKeyId?: string;
  appleIssuerId?: string;
  applePrivateKey?: string;
  appleAppId?: string;
  appleBundleId?: string;
  googlePackageName?: string;
  googleServiceAccountKey?: string;
};

export async function runManageProduct(
  args: ManageProductArgs,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const needsApple = args.platform === 'apple' || args.platform === 'both';
  const needsGoogle = args.platform === 'google' || args.platform === 'both';

  let appleResult: AppleUpdateProductResult | AppleDeleteProductResult | null = null;
  let googleResult: GoogleUpdateProductResult | GoogleDeleteProductResult | null = null;
  let appleConfigError: string | null = null;
  let googleConfigError: string | null = null;

  if (args.action === 'update' && !args.name) {
    return {
      content: [{ type: 'text', text: '**Error:** `name` is required for the update action.' }],
    };
  }

  if (needsApple) {
    if (!args.appleKeyId || !args.appleIssuerId || !args.applePrivateKey) {
      appleConfigError = 'Missing required Apple config: appleKeyId, appleIssuerId, applePrivateKey';
    } else if (!args.appleAppId && !args.appleBundleId) {
      appleConfigError = 'Missing required Apple config: provide either appleAppId or appleBundleId';
    } else {
      try {
        const creds = {
          keyId: args.appleKeyId,
          issuerId: args.appleIssuerId,
          privateKey: args.applePrivateKey,
          appId: args.appleAppId,
          bundleId: args.appleBundleId,
        };
        const productType = args.productType as AppleProductType;
        if (args.action === 'update') {
          appleResult = await updateAppleProduct({ ...creds, productId: args.productId, productType, name: args.name });
        } else {
          appleResult = await deleteAppleProduct({ ...creds, productId: args.productId, productType });
        }
      } catch (err: unknown) {
        appleResult = {
          success: false,
          ...(args.action === 'update' ? { updated: [] } : {}),
          error: err instanceof Error ? err.message : String(err),
          errorType: 'UNKNOWN',
        } as AppleUpdateProductResult | AppleDeleteProductResult;
      }
    }
  }

  if (needsGoogle) {
    if (!args.googlePackageName || !args.googleServiceAccountKey) {
      googleConfigError = 'Missing required Google config: googlePackageName, googleServiceAccountKey';
    } else {
      try {
        const googleCreds = {
          packageName: args.googlePackageName,
          serviceAccountKey: args.googleServiceAccountKey,
        };
        const productType = args.productType as GoogleProductType;
        if (args.action === 'update') {
          googleResult = await updateGoogleProduct({ ...googleCreds, productId: args.productId, productType, name: args.name });
        } else {
          googleResult = await deleteGoogleProduct({ ...googleCreds, productId: args.productId, productType });
        }
      } catch (err: unknown) {
        googleResult = {
          success: false,
          ...(args.action === 'update' ? { updated: [] } : {}),
          error: err instanceof Error ? err.message : String(err),
        } as GoogleUpdateProductResult | GoogleDeleteProductResult;
      }
    }
  }

  const text = buildManageOutput({
    action: args.action,
    productId: args.productId,
    name: args.name,
    needsApple,
    needsGoogle,
    appleResult,
    googleResult,
    appleConfigError,
    googleConfigError,
  });

  return { content: [{ type: 'text', text }] };
}

function buildManageOutput(opts: {
  action: 'update' | 'delete';
  productId: string;
  name?: string;
  needsApple: boolean;
  needsGoogle: boolean;
  appleResult: AppleUpdateProductResult | AppleDeleteProductResult | null;
  googleResult: GoogleUpdateProductResult | GoogleDeleteProductResult | null;
  appleConfigError: string | null;
  googleConfigError: string | null;
}): string {
  const { action, productId, name, needsApple, needsGoogle, appleResult, googleResult, appleConfigError, googleConfigError } = opts;

  const actionLabel = action === 'update' ? 'Update' : 'Delete';
  const lines: string[] = [
    `# ${actionLabel} IAP Product`,
    '',
    `**Product ID:** \`${productId}\``,
    ...(action === 'update' && name ? [`**New name:** ${name}`] : []),
    `**Platforms:** ${[needsApple && 'Apple', needsGoogle && 'Google'].filter(Boolean).join(', ')}`,
    '',
    '---',
  ];

  if (needsApple) {
    lines.push('', '## Apple App Store Connect');
    if (appleConfigError) {
      lines.push('', `**Status:** Failed (configuration error)`);
      lines.push(`**Error:** ${appleConfigError}`);
    } else if (appleResult) {
      if (appleResult.success) {
        lines.push('', `**Status:** Success`);
        if (action === 'update' && 'updated' in appleResult && appleResult.updated.length > 0) {
          lines.push(`**Updated fields:** ${appleResult.updated.join(', ')}`);
        }
      } else {
        lines.push('', `**Status:** Failed`);
        lines.push(`**Error:** ${appleResult.error ?? 'Unknown error'}`);
        if ('errorType' in appleResult) {
          switch (appleResult.errorType) {
            case 'CANNOT_DELETE':
              lines.push('', '**Why:** Products that are already approved (READY_FOR_SALE) cannot be deleted via the API.');
              lines.push('**Options:**');
              lines.push('- Remove the product manually in [App Store Connect](https://appstoreconnect.apple.com) → your app → In-App Purchases.');
              lines.push('- If you just want to hide it, set its availability to off instead of deleting.');
              break;
            case 'NOT_FOUND':
              lines.push('', '**Why:** No product with this ID was found. Check `onesub_list_products` for the correct ID.');
              break;
            case 'AUTH':
              lines.push('', '**How to fix:** Verify the API key is active and has "App Manager" or higher role in App Store Connect.');
              break;
          }
        }
      }
    }
  }

  if (needsGoogle) {
    lines.push('', '## Google Play Console');
    if (googleConfigError) {
      lines.push('', `**Status:** Failed (configuration error)`);
      lines.push(`**Error:** ${googleConfigError}`);
    } else if (googleResult) {
      if (googleResult.success) {
        lines.push('', `**Status:** Success`);
        if (action === 'update' && 'updated' in googleResult && googleResult.updated.length > 0) {
          lines.push(`**Updated fields:** ${googleResult.updated.join(', ')}`);
        }
      } else {
        lines.push('', `**Status:** Failed`);
        lines.push(`**Error:** ${googleResult.error ?? 'Unknown error'}`);
        lines.push('', '**Troubleshooting tips:**');
        lines.push('- Verify the service account has the "Manage orders" permission in Play Console.');
        lines.push('- Check that `googlePackageName` exactly matches the published app package name.');
      }
    }
  }

  lines.push('', '---', '');

  const allSucceeded =
    (!needsApple || (appleResult?.success === true && !appleConfigError)) &&
    (!needsGoogle || (googleResult?.success === true && !googleConfigError));

  if (allSucceeded) {
    const verb = action === 'update' ? 'updated' : 'deleted';
    lines.push(`**Product ${verb} successfully on all platforms.** Use \`onesub_list_products\` to verify.`);
  }

  return lines.join('\n');
}
