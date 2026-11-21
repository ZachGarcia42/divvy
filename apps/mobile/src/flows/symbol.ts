// The currency sign shown before typed amounts and on the currency picker tiles.
// Hermes on iOS/macOS has no Intl.NumberFormat.prototype.formatToParts (compiled out under __APPLE__), so without a
// fallback every prefix read "USD" instead of "$" on iPhone. Without it, the symbol is what format(0) prints minus
// the digits, separators and spaces; any Intl failure falls back to the code. Locale and options are unchanged
// ('en', style currency, default symbol display), so Android and web output is the same as before.
export function symbolOf(currency: string): string {
  try {
    const nf = new Intl.NumberFormat('en', { style: 'currency', currency })
    if (typeof nf.formatToParts === 'function') return nf.formatToParts(0).find((part) => part.type === 'currency')?.value ?? currency
    return nf.format(0).replace(/[0-9.,\s\u00a0\u202f\u200e\u200f-]/g, '') || currency
  } catch {
    return currency
  }
}
