import { z } from 'zod';
import { ROUTES, DEFAULT_PORT } from '@onesub/shared';

export const setupInputSchema = {
  projectPath: z.string().describe('Absolute path to the project root directory'),
  productId: z.string().describe('Your subscription product ID (e.g. "com.yourapp.pro_monthly")'),
  price: z.string().describe('Display price for the subscription (e.g. "$4.99/month")'),
  serverUrl: z
    .string()
    .url()
    .optional()
    .describe(`URL where @onesub/server is hosted (default: http://localhost:${DEFAULT_PORT})`),
};

export async function runSetup(args: {
  projectPath: string;
  productId: string;
  price: string;
  serverUrl?: string;
}): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const serverUrl = args.serverUrl ?? `http://localhost:${DEFAULT_PORT}`;

  const output = buildSetupInstructions({
    productId: args.productId,
    price: args.price,
    serverUrl,
  });

  return { content: [{ type: 'text', text: output }] };
}

function buildSetupInstructions(opts: {
  productId: string;
  price: string;
  serverUrl: string;
}): string {
  const { productId, price, serverUrl } = opts;

  const providerCode = `// app/_layout.tsx  (or App.tsx for bare React Native)
import { OneSubProvider } from 'onesub';

export default function RootLayout() {
  return (
    <OneSubProvider
      config={{
        serverUrl: '${serverUrl}',
        productId: '${productId}',
      }}
    >
      {/* your existing app layout */}
    </OneSubProvider>
  );
}`;

  const paywallCode = buildMinimalPaywall({ productId, price });

  const gateCode = `// anywhere in your app — gate premium features
import { useOneSub } from 'onesub';

export function PremiumFeature() {
  const { isActive, isLoading, subscribe } = useOneSub();

  if (isLoading) return <ActivityIndicator />;

  if (!isActive) {
    return (
      <View>
        <Text>This feature requires a subscription.</Text>
        <Button title="Upgrade" onPress={subscribe} />
      </View>
    );
  }

  return <YourPremiumContent />;
}`;

  const serverCode = `// server.ts (standalone onesub validation server)
import { createOneSubServer } from '@onesub/server';

const app = createOneSubServer({
  apple: {
    bundleId: 'com.yourcompany.yourapp',
    sharedSecret: process.env.APPLE_SHARED_SECRET!,
    // For StoreKit 2 (recommended):
    keyId: process.env.APPLE_KEY_ID!,
    issuerId: process.env.APPLE_ISSUER_ID!,
    privateKey: process.env.APPLE_PRIVATE_KEY!,
  },
  google: {
    packageName: 'com.yourcompany.yourapp',
    serviceAccountKey: process.env.GOOGLE_SERVICE_ACCOUNT_KEY!,
  },
  database: {
    url: process.env.DATABASE_URL!,
  },
});

app.listen(${DEFAULT_PORT}, () => {
  console.log('onesub server running on port ${DEFAULT_PORT}');
});`;

  const envCode = `# .env
APPLE_SHARED_SECRET=your_apple_shared_secret
APPLE_KEY_ID=your_key_id
APPLE_ISSUER_ID=your_issuer_id
APPLE_PRIVATE_KEY="-----BEGIN EC PRIVATE KEY-----\\n...\\n-----END EC PRIVATE KEY-----"
GOOGLE_SERVICE_ACCOUNT_KEY='{"type":"service_account",...}'
DATABASE_URL=postgresql://user:password@localhost:5432/onesub`;

  const sections: string[] = [
    '# onesub Integration Setup',
    '',
    `Setting up onesub for product **${productId}** at **${price}**.`,
    '',

    '---',
    '## Step 1 — Install packages',
    '',
    '**In your React Native / Expo project:**',
    '```bash',
    '# Expo (recommended)',
    'npx expo install onesub expo-in-app-purchases',
    '',
    '# Bare React Native (uses react-native-iap)',
    'npm install onesub react-native-iap',
    'cd ios && pod install',
    '```',
    '',
    '**For the validation server (separate Node.js project or same repo):**',
    '```bash',
    'npm install @onesub/server',
    '```',
    '',

    '---',
    '## Step 2 — Wrap your app with OneSubProvider',
    '',
    '```tsx',
    providerCode,
    '```',
    '',

    '---',
    '## Step 3 — Add a paywall screen',
    '',
    `Create the file \`screens/PaywallScreen.tsx\` (or \`app/paywall.tsx\` for Expo Router):`,
    '',
    '```tsx',
    paywallCode,
    '```',
    '',

    '---',
    '## Step 4 — Gate premium features',
    '',
    '```tsx',
    gateCode,
    '```',
    '',

    '---',
    '## Step 5 — Set up the validation server',
    '',
    '```ts',
    serverCode,
    '```',
    '',
    'Environment variables:',
    '```bash',
    envCode,
    '```',
    '',

    '---',
    '## Step 6 — App Store Connect setup (iOS)',
    '',
    '1. Open [App Store Connect](https://appstoreconnect.apple.com) → your app → **Subscriptions**.',
    '2. Create a **Subscription Group** (e.g. "Premium").',
    `3. Add a subscription product with ID: \`${productId}\``,
    `4. Set price to **${price}** (or the closest tier).`,
    '5. Add a **Shared Secret** under App Information → App-Specific Shared Secret.',
    '6. For StoreKit 2 (recommended): create an **In-App Purchase key** under Users and Access → Keys.',
    '7. Submit for **Sandbox testing** before going live.',
    '',
    '**Webhook (optional but recommended):**',
    `Register your server notification URL in App Store Connect:`,
    `\`${serverUrl}${ROUTES.WEBHOOK_APPLE}\``,
    '',

    '---',
    '## Step 7 — Google Play Console setup (Android)',
    '',
    '1. Open [Google Play Console](https://play.google.com/console) → your app → **Monetize → Subscriptions**.',
    `2. Create a subscription with Product ID: \`${productId}\``,
    `3. Set the base plan price to **${price}**.`,
    '4. Enable the subscription and roll it out.',
    '5. Create a **Service Account** in Google Cloud Console with "Android Publisher" role.',
    '6. Download the JSON key and set it as `GOOGLE_SERVICE_ACCOUNT_KEY`.',
    '',
    '**Real-Time Developer Notifications (RTDN):**',
    'Set up a Pub/Sub topic and point it to:',
    `\`${serverUrl}${ROUTES.WEBHOOK_GOOGLE}\``,
    '',

    '---',
    '## Verify the integration',
    '',
    '```bash',
    '# Check a user\'s subscription status',
    `curl "${serverUrl}${ROUTES.STATUS}?userId=test_user_123"`,
    '```',
    '',
    'Expected response when no active subscription:',
    '```json',
    '{ "active": false, "subscription": null }',
    '```',
    '',
    'Use sandbox/test accounts to complete a purchase, then check again — `"active": true` confirms the full flow works.',
  ];

  return sections.join('\n');
}

function buildMinimalPaywall(opts: { productId: string; price: string }): string {
  const { productId, price } = opts;

  return `import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { useOneSub } from 'onesub';

export default function PaywallScreen() {
  const { subscribe, restore, isLoading } = useOneSub();

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Go Premium</Text>
      <Text style={styles.price}>${price}</Text>

      <View style={styles.features}>
        {/* Add your feature list here */}
        <Text style={styles.feature}>✓ Unlimited access</Text>
        <Text style={styles.feature}>✓ Priority support</Text>
        <Text style={styles.feature}>✓ No ads</Text>
      </View>

      <TouchableOpacity
        style={styles.cta}
        onPress={subscribe}
        disabled={isLoading}
      >
        {isLoading ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.ctaText}>Subscribe Now</Text>
        )}
      </TouchableOpacity>

      <TouchableOpacity onPress={restore} disabled={isLoading}>
        <Text style={styles.restore}>Restore Purchases</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: '#fff' },
  title: { fontSize: 28, fontWeight: '700', marginBottom: 8, color: '#111' },
  price: { fontSize: 20, color: '#6366f1', fontWeight: '600', marginBottom: 24 },
  features: { gap: 10, marginBottom: 32, alignSelf: 'stretch' },
  feature: { fontSize: 16, color: '#374151' },
  cta: { backgroundColor: '#6366f1', borderRadius: 12, paddingVertical: 16, paddingHorizontal: 48, marginBottom: 16 },
  ctaText: { color: '#fff', fontSize: 17, fontWeight: '700' },
  restore: { color: '#9ca3af', fontSize: 14 },
});`;
}
