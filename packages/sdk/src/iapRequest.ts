interface AndroidSubscriptionOffer {
  offerToken?: string | null;
  offerTokenAndroid?: string | null;
}

export interface SubscriptionProductForRequest {
  subscriptionOffers?: AndroidSubscriptionOffer[] | null;
  subscriptionOfferDetailsAndroid?: AndroidSubscriptionOffer[] | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** @internal Build platform-scoped requestPurchase args for react-native-iap v15. */
export function buildRequestPurchaseArgs(
  sku: string,
  platform: 'ios' | 'android',
  type: 'in-app' | 'subs',
  accountToken?: string,
  subscriptionProduct?: SubscriptionProductForRequest,
) {
  // accountToken binds the purchase to a stable account identity: Apple bakes it
  // into the signed transaction as `appAccountToken` (must be a UUID), Android
  // carries it as `obfuscatedAccountId`. Invalid tokens are omitted so the store
  // can still present checkout for hosts that intentionally use unbound purchases.
  const iosToken = accountToken && UUID_RE.test(accountToken) ? accountToken : undefined;
  const androidToken = accountToken && accountToken.length <= 64 ? accountToken : undefined;
  if (accountToken && typeof console !== 'undefined') {
    if (platform === 'ios' && !iosToken) {
      console.warn('[onesub] accountToken is not a UUID — omitted on iOS; purchase will be unbound');
    } else if (platform === 'android' && !androidToken) {
      console.warn('[onesub] accountToken exceeds 64 chars — omitted on Android; purchase will be unbound');
    }
  }

  const apple = iosToken ? { sku, appAccountToken: iosToken } : { sku };
  const androidExtra = androidToken ? { obfuscatedAccountId: androidToken } : {};

  if (platform === 'ios') {
    return { request: { ios: apple }, type };
  }

  if (type === 'in-app') {
    return { request: { android: { skus: [sku], ...androidExtra } }, type };
  }

  // Google Play requires an offer token for subscriptions. react-native-iap
  // exposes both the standardized OpenIAP field and the legacy Android field;
  // accept both and de-duplicate because current releases can populate both.
  const offerTokens = new Set<string>();
  for (const offer of subscriptionProduct?.subscriptionOffers ?? []) {
    if (offer.offerTokenAndroid) offerTokens.add(offer.offerTokenAndroid);
  }
  for (const offer of subscriptionProduct?.subscriptionOfferDetailsAndroid ?? []) {
    if (offer.offerToken) offerTokens.add(offer.offerToken);
  }

  return {
    request: {
      android: {
        skus: [sku],
        subscriptionOffers: [...offerTokens].map((offerToken) => ({ sku, offerToken })),
        ...androidExtra,
      },
    },
    type,
  };
}
