/**
 * Consumables / Non-consumables demo screen.
 *
 * Shows three flows the SDK supports beyond the headline subscription:
 *   1. Consumable purchase (e.g. 100 coins)
 *   2. Non-consumable purchase (e.g. lifetime "remove ads")
 *   3. Entitlement gating (`hasEntitlement('premium_features')`)
 *
 * Wire your real productIds in the constants below.
 */

import { View, Text, TouchableOpacity, StyleSheet, Alert, ScrollView } from 'react-native';
import { useOneSub } from '@onesub/sdk';

const COIN_PACK_PRODUCT = 'coin_pack_100';
const REMOVE_ADS_PRODUCT = 'remove_ads_lifetime';
const PREMIUM_ENTITLEMENT = 'premium_features';

export default function ConsumablesScreen() {
  const { purchaseProduct, hasEntitlement, isLoading } = useOneSub();

  async function buyCoins() {
    try {
      const result = await purchaseProduct(COIN_PACK_PRODUCT, 'consumable');
      if (result) Alert.alert('+100 coins', `transaction ${result.transactionId}`);
    } catch (err) {
      Alert.alert('Purchase failed', String((err as Error).message));
    }
  }

  async function buyRemoveAds() {
    try {
      const result = await purchaseProduct(REMOVE_ADS_PRODUCT, 'non_consumable');
      if (result) {
        const verb = result.action === 'restored' ? 'restored' : 'unlocked';
        Alert.alert(`Ads ${verb}`, `transaction ${result.transactionId}`);
      }
    } catch (err) {
      Alert.alert('Purchase failed', String((err as Error).message));
    }
  }

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.container}>
      <Text style={styles.title}>One-time purchases</Text>
      <Text style={styles.subtitle}>Demonstrates consumables, non-consumables, and entitlement checks.</Text>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>100 Coin Pack</Text>
        <Text style={styles.cardCopy}>Consumable — can be purchased repeatedly.</Text>
        <TouchableOpacity style={styles.cta} onPress={buyCoins} disabled={isLoading}>
          <Text style={styles.ctaText}>Buy 100 coins</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Remove Ads (Lifetime)</Text>
        <Text style={styles.cardCopy}>Non-consumable — unlocks once, restorable across devices.</Text>
        <TouchableOpacity style={styles.cta} onPress={buyRemoveAds} disabled={isLoading}>
          <Text style={styles.ctaText}>Unlock</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Entitlement gate</Text>
        <Text style={styles.cardCopy}>
          {hasEntitlement(PREMIUM_ENTITLEMENT)
            ? `✓ "${PREMIUM_ENTITLEMENT}" granted — render premium UI.`
            : `× "${PREMIUM_ENTITLEMENT}" not granted — render upgrade prompt.`}
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: '#fff' },
  container: { padding: 24, paddingTop: 80 },
  title: { fontSize: 24, fontWeight: '700', color: '#111', marginBottom: 8 },
  subtitle: { fontSize: 14, color: '#6b7280', marginBottom: 24 },
  card: {
    backgroundColor: '#f9fafb',
    borderRadius: 12,
    padding: 20,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  cardTitle: { fontSize: 18, fontWeight: '600', color: '#111', marginBottom: 4 },
  cardCopy: { fontSize: 14, color: '#374151', marginBottom: 16 },
  cta: { backgroundColor: '#2563eb', borderRadius: 8, paddingVertical: 12, alignItems: 'center' },
  ctaText: { color: '#fff', fontSize: 15, fontWeight: '600' },
});
