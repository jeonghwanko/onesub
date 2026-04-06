import { z } from 'zod';

export const addPaywallInputSchema = {
  title: z.string().describe('Main headline shown on the paywall (e.g. "Unlock Premium")'),
  features: z
    .array(z.string())
    .min(1)
    .max(8)
    .describe('List of benefit strings shown to the user (e.g. ["Unlimited scans", "No ads"])'),
  price: z.string().describe('Price string displayed to the user (e.g. "$4.99/month")'),
  style: z
    .enum(['minimal', 'gradient', 'card'])
    .optional()
    .default('minimal')
    .describe('Visual style of the paywall screen'),
};

export async function runAddPaywall(args: {
  title: string;
  features: string[];
  price: string;
  style?: 'minimal' | 'gradient' | 'card';
}): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const style = args.style ?? 'minimal';
  let code: string;

  switch (style) {
    case 'gradient':
      code = buildGradientPaywall(args);
      break;
    case 'card':
      code = buildCardPaywall(args);
      break;
    default:
      code = buildMinimalPaywall(args);
  }

  const text = [
    `# Paywall Screen — ${style} style`,
    '',
    `Save this file as \`screens/PaywallScreen.tsx\` (bare RN) or \`app/paywall.tsx\` (Expo Router).`,
    '',
    '```tsx',
    code,
    '```',
    '',
    '## Usage',
    '',
    '**Expo Router** — navigate to the paywall:',
    '```ts',
    "import { router } from 'expo-router';",
    "router.push('/paywall');",
    '```',
    '',
    '**React Navigation (bare RN)**:',
    '```ts',
    "navigation.navigate('Paywall');",
    '```',
    '',
    '**Direct trigger via hook** (no navigation):',
    '```ts',
    "import { useSubscription } from 'onesub';",
    'const { showPaywall } = useSubscription();',
    '// call showPaywall() anywhere',
    '```',
    '',
    ...(style === 'gradient'
      ? [
          '## Dependencies',
          '',
          'The gradient style requires `expo-linear-gradient`:',
          '```bash',
          'npx expo install expo-linear-gradient',
          '```',
        ]
      : []),
  ].join('\n');

  return { content: [{ type: 'text', text }] };
}

function featureLines(features: string[], indent = '        '): string {
  return features
    .map((f) => `${indent}<Text style={styles.feature}>✓ {/* ${f} */}</Text>`)
    .join('\n');
}

function featureData(features: string[]): string {
  return features.map((f) => `  '${f.replace(/'/g, "\\'")}',`).join('\n');
}

function buildMinimalPaywall(opts: { title: string; features: string[]; price: string }): string {
  const { title, features, price } = opts;

  return `import React from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  SafeAreaView,
  ScrollView,
} from 'react-native';
import { useSubscription } from 'onesub';

const FEATURES = [
${featureData(features)}
];

export default function PaywallScreen() {
  const { purchase, restore, isLoading, isActive, error } = useSubscription();

  if (isActive) {
    return (
      <SafeAreaView style={styles.container}>
        <Text style={styles.alreadyActive}>You already have an active subscription!</Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <Text style={styles.title}>${title}</Text>
        <Text style={styles.subtitle}>Everything you need, one simple price.</Text>

        <View style={styles.featureList}>
          {FEATURES.map((feature, i) => (
            <View key={i} style={styles.featureRow}>
              <Text style={styles.checkmark}>✓</Text>
              <Text style={styles.featureText}>{feature}</Text>
            </View>
          ))}
        </View>

        <View style={styles.priceBox}>
          <Text style={styles.price}>${price}</Text>
          <Text style={styles.priceSub}>Cancel anytime</Text>
        </View>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <TouchableOpacity
          style={[styles.cta, isLoading && styles.ctaDisabled]}
          onPress={() => purchase()}
          disabled={isLoading}
          activeOpacity={0.85}
        >
          {isLoading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.ctaText}>Get Started</Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity onPress={restore} disabled={isLoading} style={styles.restoreBtn}>
          <Text style={styles.restoreText}>Restore Purchases</Text>
        </TouchableOpacity>

        <Text style={styles.legal}>
          Subscription renews automatically. Cancel anytime in App Store or Google Play settings.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#ffffff' },
  scroll: { flexGrow: 1, alignItems: 'center', padding: 24, paddingBottom: 40 },
  title: { fontSize: 30, fontWeight: '800', color: '#111827', textAlign: 'center', marginBottom: 8 },
  subtitle: { fontSize: 16, color: '#6b7280', textAlign: 'center', marginBottom: 32 },
  featureList: { alignSelf: 'stretch', gap: 14, marginBottom: 32 },
  featureRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  checkmark: { fontSize: 16, color: '#6366f1', fontWeight: '700', marginTop: 1 },
  featureText: { fontSize: 16, color: '#374151', flex: 1, lineHeight: 22 },
  priceBox: { alignItems: 'center', marginBottom: 24 },
  price: { fontSize: 34, fontWeight: '800', color: '#111827' },
  priceSub: { fontSize: 14, color: '#9ca3af', marginTop: 2 },
  error: { color: '#ef4444', marginBottom: 12, textAlign: 'center', fontSize: 14 },
  cta: { backgroundColor: '#6366f1', borderRadius: 14, paddingVertical: 18, paddingHorizontal: 60, marginBottom: 14, alignSelf: 'stretch', alignItems: 'center' },
  ctaDisabled: { opacity: 0.6 },
  ctaText: { color: '#fff', fontSize: 17, fontWeight: '700' },
  restoreBtn: { marginBottom: 20 },
  restoreText: { color: '#9ca3af', fontSize: 14 },
  legal: { fontSize: 12, color: '#d1d5db', textAlign: 'center', lineHeight: 18 },
  alreadyActive: { textAlign: 'center', padding: 24, fontSize: 16, color: '#16a34a' },
});`;
}

function buildGradientPaywall(opts: {
  title: string;
  features: string[];
  price: string;
}): string {
  const { title, features, price } = opts;

  return `import React from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  SafeAreaView,
  ScrollView,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSubscription } from 'onesub';

// npx expo install expo-linear-gradient

const FEATURES = [
${featureData(features)}
];

export default function PaywallScreen() {
  const { purchase, restore, isLoading, isActive, error } = useSubscription();

  if (isActive) {
    return (
      <SafeAreaView style={styles.container}>
        <Text style={styles.alreadyActive}>You already have an active subscription!</Text>
      </SafeAreaView>
    );
  }

  return (
    <LinearGradient colors={['#6366f1', '#8b5cf6', '#a855f7']} style={styles.container}>
      <SafeAreaView style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
          <Text style={styles.title}>${title}</Text>
          <Text style={styles.subtitle}>One subscription. Unlimited value.</Text>

          <View style={styles.featureList}>
            {FEATURES.map((feature, i) => (
              <View key={i} style={styles.featureRow}>
                <View style={styles.checkCircle}>
                  <Text style={styles.checkmark}>✓</Text>
                </View>
                <Text style={styles.featureText}>{feature}</Text>
              </View>
            ))}
          </View>

          <View style={styles.priceCard}>
            <Text style={styles.price}>${price}</Text>
            <Text style={styles.priceSub}>Billed monthly · Cancel anytime</Text>
          </View>

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <TouchableOpacity
            style={[styles.cta, isLoading && styles.ctaDisabled]}
            onPress={() => purchase()}
            disabled={isLoading}
            activeOpacity={0.9}
          >
            {isLoading ? (
              <ActivityIndicator color="#6366f1" />
            ) : (
              <Text style={styles.ctaText}>Unlock Now</Text>
            )}
          </TouchableOpacity>

          <TouchableOpacity onPress={restore} disabled={isLoading} style={styles.restoreBtn}>
            <Text style={styles.restoreText}>Restore Purchases</Text>
          </TouchableOpacity>

          <Text style={styles.legal}>
            Subscription renews automatically. Cancel anytime in App Store or Google Play settings.
          </Text>
        </ScrollView>
      </SafeAreaView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scroll: { flexGrow: 1, alignItems: 'center', padding: 24, paddingBottom: 40 },
  title: { fontSize: 32, fontWeight: '800', color: '#fff', textAlign: 'center', marginBottom: 8, marginTop: 16 },
  subtitle: { fontSize: 16, color: 'rgba(255,255,255,0.75)', textAlign: 'center', marginBottom: 36 },
  featureList: { alignSelf: 'stretch', gap: 16, marginBottom: 36 },
  featureRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  checkCircle: { width: 26, height: 26, borderRadius: 13, backgroundColor: 'rgba(255,255,255,0.25)', alignItems: 'center', justifyContent: 'center' },
  checkmark: { color: '#fff', fontSize: 13, fontWeight: '700' },
  featureText: { fontSize: 16, color: '#fff', flex: 1, fontWeight: '500' },
  priceCard: { backgroundColor: 'rgba(255,255,255,0.15)', borderRadius: 16, padding: 20, alignItems: 'center', alignSelf: 'stretch', marginBottom: 28 },
  price: { fontSize: 36, fontWeight: '800', color: '#fff' },
  priceSub: { fontSize: 13, color: 'rgba(255,255,255,0.7)', marginTop: 4 },
  error: { color: '#fecaca', marginBottom: 12, textAlign: 'center', fontSize: 14 },
  cta: { backgroundColor: '#fff', borderRadius: 14, paddingVertical: 18, alignSelf: 'stretch', alignItems: 'center', marginBottom: 14 },
  ctaDisabled: { opacity: 0.6 },
  ctaText: { color: '#6366f1', fontSize: 17, fontWeight: '800' },
  restoreBtn: { marginBottom: 20 },
  restoreText: { color: 'rgba(255,255,255,0.6)', fontSize: 14 },
  legal: { fontSize: 12, color: 'rgba(255,255,255,0.45)', textAlign: 'center', lineHeight: 18 },
  alreadyActive: { textAlign: 'center', padding: 24, fontSize: 16, color: '#fff' },
});`;
}

function buildCardPaywall(opts: { title: string; features: string[]; price: string }): string {
  const { title, features, price } = opts;

  return `import React from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  SafeAreaView,
  ScrollView,
} from 'react-native';
import { useSubscription } from 'onesub';

const FEATURES = [
${featureData(features)}
];

export default function PaywallScreen() {
  const { purchase, restore, isLoading, isActive, error } = useSubscription();

  if (isActive) {
    return (
      <SafeAreaView style={styles.container}>
        <Text style={styles.alreadyActive}>You already have an active subscription!</Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <Text style={styles.eyebrow}>PREMIUM</Text>
        <Text style={styles.title}>${title}</Text>

        {/* Pricing card */}
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Text style={styles.cardLabel}>Monthly</Text>
            <View style={styles.badge}><Text style={styles.badgeText}>POPULAR</Text></View>
          </View>
          <Text style={styles.price}>${price}</Text>
          <Text style={styles.priceSub}>Cancel anytime · No commitment</Text>

          <View style={styles.divider} />

          {FEATURES.map((feature, i) => (
            <View key={i} style={styles.featureRow}>
              <Text style={styles.checkmark}>✓</Text>
              <Text style={styles.featureText}>{feature}</Text>
            </View>
          ))}
        </View>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <TouchableOpacity
          style={[styles.cta, isLoading && styles.ctaDisabled]}
          onPress={() => purchase()}
          disabled={isLoading}
          activeOpacity={0.85}
        >
          {isLoading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.ctaText}>Start Subscription</Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity onPress={restore} disabled={isLoading} style={styles.restoreBtn}>
          <Text style={styles.restoreText}>Restore Purchases</Text>
        </TouchableOpacity>

        <Text style={styles.legal}>
          Subscription renews automatically. Cancel anytime in App Store or Google Play settings.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f9fafb' },
  scroll: { flexGrow: 1, alignItems: 'center', padding: 24, paddingBottom: 40 },
  eyebrow: { fontSize: 12, fontWeight: '700', color: '#6366f1', letterSpacing: 2, marginTop: 16, marginBottom: 6 },
  title: { fontSize: 28, fontWeight: '800', color: '#111827', textAlign: 'center', marginBottom: 24 },
  card: { backgroundColor: '#fff', borderRadius: 20, padding: 24, alignSelf: 'stretch', marginBottom: 24, shadowColor: '#000', shadowOpacity: 0.08, shadowOffset: { width: 0, height: 4 }, shadowRadius: 16, elevation: 4 },
  cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  cardLabel: { fontSize: 14, fontWeight: '600', color: '#6b7280' },
  badge: { backgroundColor: '#ede9fe', paddingHorizontal: 10, paddingVertical: 3, borderRadius: 20 },
  badgeText: { fontSize: 11, fontWeight: '700', color: '#6366f1', letterSpacing: 0.5 },
  price: { fontSize: 38, fontWeight: '800', color: '#111827', marginBottom: 4 },
  priceSub: { fontSize: 13, color: '#9ca3af', marginBottom: 16 },
  divider: { height: 1, backgroundColor: '#f3f4f6', marginBottom: 16 },
  featureRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginBottom: 10 },
  checkmark: { fontSize: 15, color: '#6366f1', fontWeight: '700', marginTop: 1 },
  featureText: { fontSize: 15, color: '#374151', flex: 1, lineHeight: 22 },
  error: { color: '#ef4444', marginBottom: 12, textAlign: 'center', fontSize: 14 },
  cta: { backgroundColor: '#6366f1', borderRadius: 14, paddingVertical: 18, alignSelf: 'stretch', alignItems: 'center', marginBottom: 14 },
  ctaDisabled: { opacity: 0.6 },
  ctaText: { color: '#fff', fontSize: 17, fontWeight: '700' },
  restoreBtn: { marginBottom: 20 },
  restoreText: { color: '#9ca3af', fontSize: 14 },
  legal: { fontSize: 12, color: '#d1d5db', textAlign: 'center', lineHeight: 18 },
  alreadyActive: { textAlign: 'center', padding: 24, fontSize: 16, color: '#16a34a' },
});`;
}
