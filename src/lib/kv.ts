import { Redis } from '@upstash/redis'

/**
 * Centralised KV client — all modules import from here.
 *
 * Env vars (Vercel Marketplace Upstash integration):
 *   UPSTASH_REDIS_REST_URL   — Upstash REST endpoint
 *   UPSTASH_REDIS_REST_TOKEN — Upstash REST auth token
 */
export const kv = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
})
