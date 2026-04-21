import { Redis } from '@upstash/redis'

/**
 * Centralised KV client.
 * All modules MUST import from here — never import @upstash/redis directly.
 *
 * Env vars (auto-provisioned by Vercel Marketplace Upstash integration):
 *   UPSTASH_REDIS_REST_URL   — Upstash REST endpoint
 *   UPSTASH_REDIS_REST_TOKEN — Upstash REST auth token
 *
 * Falls back to KV_REST_API_URL / KV_REST_API_TOKEN for backward compatibility
 * during the migration window (remove fallback after env vars are renamed).
 */
export const kv = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN!,
})
