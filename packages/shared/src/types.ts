/** Subscription status */
export type SubscriptionStatus = 'active' | 'expired' | 'canceled' | 'none';

/** Store platform */
export type Platform = 'apple' | 'google';

/** Receipt validation request */
export interface ValidateReceiptRequest {
  platform: Platform;
  receipt: string;
  userId: string;
  productId: string;
}

/** Receipt validation response */
export interface ValidateReceiptResponse {
  valid: boolean;
  subscription: SubscriptionInfo | null;
  error?: string;
}

/** Subscription info returned by server */
export interface SubscriptionInfo {
  userId: string;
  productId: string;
  platform: Platform;
  status: SubscriptionStatus;
  expiresAt: string;
  originalTransactionId: string;
  purchasedAt: string;
  willRenew: boolean;
}

/** Subscription status check response */
export interface StatusResponse {
  active: boolean;
  subscription: SubscriptionInfo | null;
}

/** Apple Server Notification V2 */
export interface AppleNotificationPayload {
  notificationType: string;
  subtype?: string;
  data: {
    signedTransactionInfo: string;
    signedRenewalInfo: string;
  };
}

/** Google RTDN (Real-Time Developer Notification) */
export interface GoogleNotificationPayload {
  message: {
    data: string; // base64 encoded
    messageId: string;
  };
  subscription: string;
}

/** Server config */
export interface OneSubServerConfig {
  apple?: {
    bundleId: string;
    sharedSecret?: string;
    keyId?: string;
    issuerId?: string;
    privateKey?: string;
    /** Skip JWS signature verification (for development/testing only) */
    skipJwsVerification?: boolean;
  };
  google?: {
    packageName: string;
    serviceAccountKey?: string;
    /**
     * Expected `aud` claim for incoming Pub/Sub push JWT tokens.
     * When set, the Google webhook endpoint verifies the `Authorization: Bearer <token>`
     * header as a Google-signed JWT whose `aud` matches this value.
     * If omitted, no authentication is performed on the webhook (backward compatible).
     *
     * Set this to the push endpoint URL registered in your Pub/Sub subscription,
     * e.g. `https://your-server.example.com/onesub/webhook/google`.
     */
    pushAudience?: string;
  };
  database: {
    url: string;
  };
  webhookSecret?: string;
}

/** SDK config (client-side) */
export interface OneSubConfig {
  serverUrl: string;
  productId: string;
  /** Apple product ID (defaults to productId) */
  appleProductId?: string;
  /** Google product ID (defaults to productId) */
  googleProductId?: string;
}

/** Paywall config */
export interface PaywallConfig {
  title: string;
  subtitle?: string;
  features: string[];
  price: string;
  ctaText: string;
  /** Restore button text */
  restoreText?: string;
}
