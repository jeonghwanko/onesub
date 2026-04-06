import React from 'react';
import { Modal, SafeAreaView, StyleSheet } from 'react-native';
import { Paywall } from './Paywall.js';
import type { PaywallProps } from './Paywall.js';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------
export interface PaywallModalProps extends PaywallProps {
  /** Controls modal visibility */
  visible: boolean;
  /** Called when the modal should close (via the close button or back gesture) */
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// PaywallModal
// ---------------------------------------------------------------------------
/**
 * Wraps <Paywall> in a React Native Modal for convenience.
 *
 * @example
 * ```tsx
 * const [showPaywall, setShowPaywall] = useState(false);
 * const { subscribe, restore, isLoading } = useOneSub();
 *
 * <PaywallModal
 *   visible={showPaywall}
 *   onClose={() => setShowPaywall(false)}
 *   config={paywallConfig}
 *   onSubscribe={subscribe}
 *   onRestore={restore}
 *   isLoading={isLoading}
 * />
 * ```
 */
export function PaywallModal({
  visible,
  onClose,
  config,
  onSubscribe,
  onRestore,
  isLoading,
}: PaywallModalProps) {
  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <SafeAreaView style={styles.safeArea}>
        <Paywall
          config={config}
          onSubscribe={onSubscribe}
          onRestore={onRestore}
          onClose={onClose}
          isLoading={isLoading}
        />
      </SafeAreaView>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
});
