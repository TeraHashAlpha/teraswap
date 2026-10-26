/** [ADR-025] The dev kit (/v2/_kit) exists only on Vercel Preview or `next dev`. Read per request. */
export function isV2KitEnabled(): boolean {
  return process.env.VERCEL_ENV === 'preview' || process.env.NODE_ENV === 'development'
}

/** `/v2/_enable` (cookie opt-in for previews) is the same kind of tool as the kit: same gate, one definition. */
export const isV2EnableEnabled = isV2KitEnabled
