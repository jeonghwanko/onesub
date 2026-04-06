/** API route paths */
export const ROUTES = {
  VALIDATE: '/onesub/validate',
  STATUS: '/onesub/status',
  WEBHOOK_APPLE: '/onesub/webhook/apple',
  WEBHOOK_GOOGLE: '/onesub/webhook/google',
} as const;

/** Default server port */
export const DEFAULT_PORT = 4100;

/** Subscription status values */
export const SUBSCRIPTION_STATUS = {
  ACTIVE: 'active',
  EXPIRED: 'expired',
  CANCELED: 'canceled',
  NONE: 'none',
} as const;
