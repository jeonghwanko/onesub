/**
 * Home screen — shows premium content or paywall.
 *
 * This is the simplest possible integration:
 *   const { isActive } = useOneSub();
 *   if (!isActive) → show paywall
 *   if (isActive)  → show premium content
 */

import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { useOneSub } from '@onesub/sdk';

export default function HomeScreen() {
  const { isActive, isLoading, subscribe, restore } = useOneSub();

  if (isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#2563eb" />
        <Text style={styles.loadingText}>Checking subscription...</Text>
      </View>
    );
  }

  // ── Subscribed → Premium Content ─────────────────────────────────────────
  if (isActive) {
    return (
      <View style={styles.center}>
        <Text style={styles.icon}>🎉</Text>
        <Text style={styles.title}>Welcome, Premium User!</Text>
        <Text style={styles.subtitle}>You have full access to all features.</Text>
      </View>
    );
  }

  // ── Not Subscribed → Paywall ─────────────────────────────────────────────
  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.icon}>🔒</Text>
        <Text style={styles.title}>Go Premium</Text>
        <Text style={styles.subtitle}>Unlock all features with a monthly subscription</Text>
      </View>

      <View style={styles.features}>
        {['Unlimited access', 'No ads', 'Priority support', 'Exclusive content'].map(
          (feature) => (
            <View key={feature} style={styles.featureRow}>
              <Text style={styles.check}>✓</Text>
              <Text style={styles.featureText}>{feature}</Text>
            </View>
          ),
        )}
      </View>

      <TouchableOpacity style={styles.cta} onPress={subscribe}>
        <Text style={styles.ctaText}>Subscribe Now</Text>
      </TouchableOpacity>

      <TouchableOpacity style={styles.restoreBtn} onPress={restore}>
        <Text style={styles.restoreText}>Restore Purchase</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, backgroundColor: '#fff' },
  container: { flex: 1, padding: 24, paddingTop: 80, backgroundColor: '#fff' },
  header: { alignItems: 'center', marginBottom: 40 },
  icon: { fontSize: 48, marginBottom: 16 },
  title: { fontSize: 28, fontWeight: '700', color: '#111', marginBottom: 8 },
  subtitle: { fontSize: 16, color: '#6b7280', textAlign: 'center' },
  loadingText: { marginTop: 12, fontSize: 14, color: '#6b7280' },
  features: { marginBottom: 40, gap: 12 },
  featureRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  check: { fontSize: 18, color: '#16a34a', fontWeight: '700' },
  featureText: { fontSize: 16, color: '#374151' },
  cta: { backgroundColor: '#2563eb', borderRadius: 12, paddingVertical: 16, alignItems: 'center', marginBottom: 16 },
  ctaText: { color: '#fff', fontSize: 17, fontWeight: '700' },
  restoreBtn: { alignItems: 'center', paddingVertical: 12 },
  restoreText: { color: '#9ca3af', fontSize: 14 },
});
