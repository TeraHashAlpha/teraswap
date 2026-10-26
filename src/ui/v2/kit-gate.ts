/** [ADR-025] The dev kit (/v2/_kit) exists only on Vercel Preview or `next dev`. Read per request. */
export function isV2KitEnabled(): boolean {
  return process.env.VERCEL_ENV === 'preview' || process.env.NODE_ENV === 'development'
}
