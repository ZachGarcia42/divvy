import { formatMoney } from './money.ts'

/** "split equally" when the shares are an even split (at most one minor unit apart), else "custom split". */
export function splitPhrase(shares: { minor: number }[]): 'split equally' | 'custom split' {
  const amounts = shares.map((share) => share.minor).filter((minor) => minor !== 0)
  if (amounts.length === 0) return 'split equally'
  return Math.max(...amounts) - Math.min(...amounts) <= 1 ? 'split equally' : 'custom split'
}

/** Error for custom shares that miss the total, saying how far off they are. */
export function shareGapMessage(sumMinor: number, totalMinor: number, currency: string) {
  const gap = totalMinor - sumMinor
  if (gap === 0) return null
  return `Shares have to add up to the total. ${formatMoney(Math.abs(gap), currency)} ${gap > 0 ? 'left' : 'over'}.`
}
