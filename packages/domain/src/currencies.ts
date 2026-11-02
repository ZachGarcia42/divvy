/**
 * The currencies the exchange-rate source (ECB reference rates, via frankfurter) publishes, with names for the picker.
 * Any other ISO code is still accepted by the API, but only with a manually entered rate.
 */
export const FX_CURRENCIES: readonly { code: string; name: string }[] = [
  { code: 'USD', name: 'US dollar' },
  { code: 'EUR', name: 'Euro' },
  { code: 'GBP', name: 'British pound' },
  { code: 'CAD', name: 'Canadian dollar' },
  { code: 'AUD', name: 'Australian dollar' },
  { code: 'JPY', name: 'Japanese yen' },
  { code: 'MXN', name: 'Mexican peso' },
  { code: 'CHF', name: 'Swiss franc' },
  { code: 'CNY', name: 'Chinese yuan' },
  { code: 'INR', name: 'Indian rupee' },
  { code: 'KRW', name: 'South Korean won' },
  { code: 'BRL', name: 'Brazilian real' },
  { code: 'CZK', name: 'Czech koruna' },
  { code: 'DKK', name: 'Danish krone' },
  { code: 'HKD', name: 'Hong Kong dollar' },
  { code: 'HUF', name: 'Hungarian forint' },
  { code: 'IDR', name: 'Indonesian rupiah' },
  { code: 'ILS', name: 'Israeli shekel' },
  { code: 'ISK', name: 'Icelandic króna' },
  { code: 'MYR', name: 'Malaysian ringgit' },
  { code: 'NOK', name: 'Norwegian krone' },
  { code: 'NZD', name: 'New Zealand dollar' },
  { code: 'PHP', name: 'Philippine peso' },
  { code: 'PLN', name: 'Polish złoty' },
  { code: 'RON', name: 'Romanian leu' },
  { code: 'SEK', name: 'Swedish krona' },
  { code: 'SGD', name: 'Singapore dollar' },
  { code: 'THB', name: 'Thai baht' },
  { code: 'TRY', name: 'Turkish lira' },
  { code: 'ZAR', name: 'South African rand' },
]

export function currencyName(code: string): string {
  return FX_CURRENCIES.find((row) => row.code === code.toUpperCase())?.name ?? code.toUpperCase()
}

/** Case-insensitive match on code or name, for the picker's search box. An empty query lists everything. */
export function searchCurrencies(query: string): { code: string; name: string }[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...FX_CURRENCIES]
  return FX_CURRENCIES.filter((row) => row.code.toLowerCase().includes(q) || row.name.toLowerCase().includes(q))
}
