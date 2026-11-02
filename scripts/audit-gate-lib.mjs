/**
 * Pure allowlist logic for scripts/audit-gate.mjs (no I/O, so it is unit-testable).
 *
 * An allowlist entry only silences an advisory while it is VALID:
 *   - `expires` is an ISO date (YYYY-MM-DD) that is today or later; or
 *   - `expires` is absent AND the entry is explicitly `noPatch: true` with a `reviewDate`
 *     (ISO date, same rule) — "no upstream fix exists, a human must re-review by that date".
 * An entry whose date is strictly in the past is EXPIRED: it no longer allowlists anything.
 * An entry with no usable date (missing/malformed `expires`, or `noPatch` without a valid
 * `reviewDate`) is INVALID: it never allowlists, and is a config error even when unused.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value) {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function dated(date, label, today) {
  return date < today
    ? { state: "expired", date, label }
    : { state: "valid", date, label: `${label} ${date}` };
}

/** @returns {{state:"valid"|"expired"|"invalid", date?:string, label?:string, detail?:string}} */
export function entryStatus(entry, today) {
  const hasExpires = entry.expires !== undefined && entry.expires !== null && entry.expires !== "";
  if (hasExpires) {
    if (!isIsoDate(entry.expires)) {
      return { state: "invalid", detail: `\`expires\` ${JSON.stringify(entry.expires)} is not an ISO date (YYYY-MM-DD)` };
    }
    return dated(entry.expires, "expires", today);
  }
  if (entry.noPatch === true) {
    if (!isIsoDate(entry.reviewDate)) {
      return { state: "invalid", detail: "`noPatch: true` requires a `reviewDate` (ISO date, YYYY-MM-DD)" };
    }
    return dated(entry.reviewDate, "review by", today);
  }
  return {
    state: "invalid",
    detail: "missing `expires` (only `noPatch: true` entries with a `reviewDate` may omit it)",
  };
}

/**
 * @param {Array<object>} allow  audit-allowlist.json `allow`
 * @param {Map<string, object>} found  GHSA id -> advisory info (high/critical present in npm audit)
 * @param {string} today  YYYY-MM-DD
 */
export function evaluateAllowlist(allow, found, today) {
  const byId = new Map();
  const invalidEntries = [];
  for (const entry of allow) {
    const status = entryStatus(entry, today);
    byId.set(entry.id, { entry, ...status });
    if (status.state === "invalid") invalidEntries.push({ id: entry.id, detail: status.detail });
  }
  const allowlisted = [];
  const blocking = [];
  for (const [id, info] of found) {
    const s = byId.get(id);
    if (!s) blocking.push({ id, info, reason: "unlisted" });
    else if (s.state === "valid") allowlisted.push({ id, info, entry: s.entry, label: s.label });
    else if (s.state === "expired") blocking.push({ id, info, reason: "expired", date: s.date });
    else blocking.push({ id, info, reason: "invalid", detail: s.detail });
  }
  return { allowlisted, blocking, invalidEntries };
}

export function expiredLine(id, date) {
  return `EXPIRED allowlist entry ${id} (expired ${date}) — pin the patch or renew with Architect review`;
}

export function invalidLine(id, detail) {
  return `INVALID allowlist entry ${id} — ${detail}`;
}
