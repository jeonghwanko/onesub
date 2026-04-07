/**
 * Root layout — wraps the entire app with OneSubProvider.
 *
 * Replace SERVER_URL with your onesub server address.
 * Replace PRODUCT_ID with your App Store / Google Play product ID.
 */

import { Stack } from 'expo-router';
import { OneSubProvider } from '@onesub/sdk';

const SERVER_URL = 'http://localhost:4100';
const PRODUCT_ID = 'premium_monthly';

// In a real app, get userId from your auth system
const USER_ID = 'demo-user-123';

export default function RootLayout() {
  return (
    <OneSubProvider
      config={{
        serverUrl: SERVER_URL,
        productId: PRODUCT_ID,
      }}
      userId={USER_ID}
    >
      <Stack screenOptions={{ headerShown: false }} />
    </OneSubProvider>
  );
}
