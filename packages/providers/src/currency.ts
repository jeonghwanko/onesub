/**
 * Currency helpers shared by the Apple and Google providers.
 */

/** ISO 4217 currencies whose smallest unit is the whole unit (no decimal subdivision). */
export const ZERO_DECIMAL_CURRENCIES = new Set([
  'KRW', 'JPY', 'VND', 'IDR', 'HUF', 'CLP', 'PYG', 'ISK',
  'TWD', 'DJF', 'GNF', 'KMF', 'MGA', 'RWF', 'UGX', 'XAF', 'XOF',
]);
