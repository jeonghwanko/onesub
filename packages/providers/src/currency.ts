/**
 * Currency helpers shared by the Apple and Google providers.
 */

/** ISO 4217 currencies whose smallest unit is the whole unit (no decimal subdivision). */
export const ZERO_DECIMAL_CURRENCIES = new Set([
  'KRW', 'JPY', 'VND', 'IDR', 'HUF', 'CLP', 'PYG', 'ISK',
  'TWD', 'DJF', 'GNF', 'KMF', 'MGA', 'RWF', 'UGX', 'XAF', 'XOF',
]);

/**
 * Single source of truth for the currencies both providers can price in and
 * how each maps to a store region:
 *  - appleTerritory: App Store Connect territory (ISO 3166-1 alpha-3). EUR maps
 *    to a concrete eurozone base territory (there is no 'EUR' territory).
 *  - googleRegion: Google Play regionCode (ISO 3166-1 alpha-2).
 */
export const SUPPORTED_CURRENCIES: Record<string, { appleTerritory: string; googleRegion: string }> = {
  USD: { appleTerritory: 'USA', googleRegion: 'US' },
  KRW: { appleTerritory: 'KOR', googleRegion: 'KR' },
  EUR: { appleTerritory: 'DEU', googleRegion: 'DE' },
  JPY: { appleTerritory: 'JPN', googleRegion: 'JP' },
  GBP: { appleTerritory: 'GBR', googleRegion: 'GB' },
  AUD: { appleTerritory: 'AUS', googleRegion: 'AU' },
  CAD: { appleTerritory: 'CAN', googleRegion: 'CA' },
  CNY: { appleTerritory: 'CHN', googleRegion: 'CN' },
  SGD: { appleTerritory: 'SGP', googleRegion: 'SG' },
};

export function unsupportedCurrencyError(currency: string): string {
  return `Unsupported currency '${currency}' — supported: ${Object.keys(SUPPORTED_CURRENCIES).join(', ')}.`;
}
