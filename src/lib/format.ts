/**
 * Format a number string with spaces as thousand separators.
 * Works for both integers and decimals.
 *
 * Examples:
 *   "111111"     → "111 111"
 *   "1234567.89" → "1 234 567.89"
 *   "0.001234"   → "0.001234"
 *   ""           → ""
 */
export function formatWithSeparator(value: string): string {
  if (!value) return value
  const [intPart, decPart] = value.split('.')
  // Add spaces every 3 digits from the right in the integer part
  const formatted = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
  return decPart !== undefined ? `${formatted}.${decPart}` : formatted
}

/**
 * Strip thousand separators (spaces) so the raw number can be parsed.
 * "111 111.5" → "111111.5"
 */
export function stripSeparator(value: string): string {
  return value.replace(/\s/g, '')
}

/**
 * Format a numeric display value with thousand separators.
 * Use this for output amounts, balances, etc.
 *
 * @param value  - number or string to format
 * @param maxDecimals - max decimal places to show (default: 4)
 */
export function formatDisplay(value: number | string, maxDecimals: number = 4): string {
  const num = typeof value === 'number' ? value : parseFloat(value)
  if (isNaN(num)) return '0'
  // For very small numbers, show more decimals
  if (num > 0 && num < 0.0001) {
    return formatWithSeparator(num.toFixed(8))
  }
  return formatWithSeparator(num.toFixed(maxDecimals))
}
