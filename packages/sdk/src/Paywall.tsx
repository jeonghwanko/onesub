import React from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import type { PaywallConfig } from '@onesub/shared';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------
export interface PaywallProps {
  config: PaywallConfig;
  /** Called when the user taps the main CTA button */
  onSubscribe: () => Promise<void> | void;
  /** Called when the user taps the restore link */
  onRestore?: () => Promise<void> | void;
  /** Called when the user taps the close button (if shown) */
  onClose?: () => void;
  /** Pass true while a purchase / restore is in progress */
  isLoading?: boolean;
}

// ---------------------------------------------------------------------------
// Feature item
// ---------------------------------------------------------------------------
function FeatureItem({ text }: { text: string }) {
  return (
    <View style={styles.featureRow}>
      <View style={styles.featureCheck}>
        <Text style={styles.featureCheckText}>✓</Text>
      </View>
      <Text style={styles.featureText}>{text}</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Paywall
// ---------------------------------------------------------------------------
export function Paywall({ config, onSubscribe, onRestore, onClose, isLoading = false }: PaywallProps) {
  const { title, subtitle, features, price, ctaText, restoreText = 'Restore purchase' } = config;

  return (
    <View style={styles.container}>
      {/* Close button */}
      {onClose && (
        <TouchableOpacity style={styles.closeButton} onPress={onClose} hitSlop={12}>
          <Text style={styles.closeButtonText}>✕</Text>
        </TouchableOpacity>
      )}

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.title}>{title}</Text>
          {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
        </View>

        {/* Feature list */}
        <View style={styles.featuresContainer}>
          {features.map((feature, index) => (
            <FeatureItem key={index} text={feature} />
          ))}
        </View>

        {/* Price block */}
        <View style={styles.priceContainer}>
          <Text style={styles.price}>{price}</Text>
        </View>

        {/* CTA button */}
        <TouchableOpacity
          style={[styles.ctaButton, isLoading && styles.ctaButtonDisabled]}
          onPress={() => { void onSubscribe(); }}
          disabled={isLoading}
          activeOpacity={0.85}
        >
          {isLoading ? (
            <ActivityIndicator color="#ffffff" />
          ) : (
            <Text style={styles.ctaText}>{ctaText}</Text>
          )}
        </TouchableOpacity>

        {/* Restore link */}
        {onRestore && (
          <TouchableOpacity
            style={styles.restoreButton}
            onPress={() => { void onRestore(); }}
            disabled={isLoading}
          >
            <Text style={styles.restoreText}>{restoreText}</Text>
          </TouchableOpacity>
        )}

        {/* Legal note */}
        <Text style={styles.legalText}>
          Payment will be charged to your account at confirmation of purchase.
          Subscription automatically renews unless cancelled at least 24 hours before the end of the current period.
        </Text>
      </ScrollView>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
const PRIMARY = '#2563eb';
const PRIMARY_DARK = '#1d4ed8';
const SUCCESS = '#16a34a';
const TEXT_PRIMARY = '#111827';
const TEXT_SECONDARY = '#6b7280';
const BG = '#ffffff';
const SURFACE = '#f9fafb';
const BORDER = '#e5e7eb';

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: BG,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 24,
    paddingTop: 48,
    paddingBottom: 40,
  },

  // Close
  closeButton: {
    position: 'absolute',
    top: 16,
    right: 16,
    zIndex: 10,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: SURFACE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeButtonText: {
    fontSize: 14,
    color: TEXT_SECONDARY,
    fontWeight: '600',
  },

  // Header
  header: {
    alignItems: 'center',
    marginBottom: 32,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: TEXT_PRIMARY,
    textAlign: 'center',
    letterSpacing: -0.5,
  },
  subtitle: {
    marginTop: 8,
    fontSize: 16,
    color: TEXT_SECONDARY,
    textAlign: 'center',
    lineHeight: 22,
  },

  // Features
  featuresContainer: {
    backgroundColor: SURFACE,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: BORDER,
    paddingVertical: 8,
    paddingHorizontal: 16,
    marginBottom: 28,
  },
  featureRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
  },
  featureCheck: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: SUCCESS,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
    flexShrink: 0,
  },
  featureCheckText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '700',
  },
  featureText: {
    flex: 1,
    fontSize: 15,
    color: TEXT_PRIMARY,
    lineHeight: 20,
  },

  // Price
  priceContainer: {
    alignItems: 'center',
    marginBottom: 20,
  },
  price: {
    fontSize: 32,
    fontWeight: '800',
    color: TEXT_PRIMARY,
    letterSpacing: -0.5,
  },

  // CTA
  ctaButton: {
    backgroundColor: PRIMARY,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
    shadowColor: PRIMARY_DARK,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
    elevation: 4,
    minHeight: 56,
  },
  ctaButtonDisabled: {
    opacity: 0.6,
  },
  ctaText: {
    color: '#ffffff',
    fontSize: 17,
    fontWeight: '700',
    letterSpacing: 0.2,
  },

  // Restore
  restoreButton: {
    alignItems: 'center',
    paddingVertical: 10,
    marginBottom: 20,
  },
  restoreText: {
    fontSize: 14,
    color: PRIMARY,
    fontWeight: '500',
  },

  // Legal
  legalText: {
    fontSize: 11,
    color: TEXT_SECONDARY,
    textAlign: 'center',
    lineHeight: 16,
  },
});
