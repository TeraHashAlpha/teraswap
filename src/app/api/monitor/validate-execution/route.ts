/**
 * /api/monitor/validate-execution — CLOSED (goal 139, owner, 2026-11-27).
 *
 * Every method answers 404 with an empty body. The handlers take no argument: no request body, header or secret is
 * read, and nothing is logged. Nothing in this repository calls the route. Next answers a method a route cannot
 * export (e.g. PROPFIND) itself, with an empty 400, before any of this runs.
 *
 * The validator (src/lib/post-execution-validator.ts) and its tests stay; nothing calls it.
 */

export const dynamic = 'force-dynamic'

function notFound(): Response {
  return new Response(null, { status: 404 })
}

export const GET = notFound
export const HEAD = notFound
export const POST = notFound
export const PUT = notFound
export const PATCH = notFound
export const DELETE = notFound
export const OPTIONS = notFound
