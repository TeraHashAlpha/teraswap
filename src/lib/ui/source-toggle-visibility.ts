/**
 * [SPRINT-9F bug5] Whether to render the Liquidity Sources selector.
 *
 * Show it when the engine returned more than one quote (the normal multi-source
 * case) OR when the user has excluded at least one source — so a user who
 * narrowed down to a single source (or excluded everything) can always re-open
 * the selector and re-enable sources, instead of being trapped until a remount.
 *
 * Byte-identical to the old `meta.all.length > 1` gate whenever nothing is
 * excluded (the mainnet default), so it never changes existing behaviour.
 */
export function shouldShowSourceToggle(
  metaAllLength: number | null | undefined,
  excludedCount: number,
): boolean {
  return (metaAllLength != null && metaAllLength > 1) || excludedCount > 0
}
