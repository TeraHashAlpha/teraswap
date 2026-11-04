#!/usr/bin/env node
/**
 * CI audit gate with a documented, temporary allowlist.
 *
 * Replaces a bare `npm audit --audit-level=high`. Behaviour:
 *   - FAILS (exit 1) on ANY high/critical advisory that is NOT in audit-allowlist.json.
 *   - PASSES (exit 0) when every remaining high/critical is explicitly allowlisted.
 *   - ENFORCES allowlist expiry: an entry whose `expires` (ISO date) is in the past no longer
 *     allowlists — the advisory blocks with an `EXPIRED allowlist entry …` line. An entry with no
 *     `expires` is INVALID (blocks) unless it is explicitly `noPatch: true` with a `reviewDate`.
 *     The rules live in scripts/audit-gate-lib.mjs (unit-tested in audit-gate.test.mjs).
 *   - WARNS (does not fail) when an allowlist entry is stale (its fix has aged past
 *     min-release-age and should now be converted to an `overrides` pin), or when an
 *     allowlisted advisory is no longer present (entry can be deleted).
 *
 * The allowlist exists ONLY for fixes that are published but temporarily un-installable
 * under .npmrc `min-release-age=7`. It never silences an un-triaged finding: anything not
 * listed still reds the gate. See audit-allowlist.json for the policy + per-entry TODOs.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { evaluateAllowlist, expiredLine, invalidLine, isIsoDate } from "./audit-gate-lib.mjs";

const ROOT = new URL("../", import.meta.url);
const allowlist = JSON.parse(readFileSync(new URL("audit-allowlist.json", ROOT), "utf8"));
const allow = allowlist.allow || [];

// npm audit exits non-zero when vulnerabilities exist — capture stdout regardless.
// Static argv + no shell (execFileSync): no command-injection surface.
let raw = "{}";
try {
  raw = execFileSync("npm", ["audit", "--json"], {
    cwd: fileURLToPath(ROOT),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
} catch (err) {
  raw = err.stdout || "{}";
}

let data;
try {
  data = JSON.parse(raw);
} catch {
  console.error("audit-gate: could not parse `npm audit --json` output — failing closed.");
  process.exit(1);
}

const BLOCKING = new Set(["high", "critical"]);
const found = new Map(); // GHSA id -> { pkg, severity, url, title }
for (const vuln of Object.values(data.vulnerabilities || {})) {
  for (const via of vuln.via || []) {
    if (typeof via === "object" && BLOCKING.has(via.severity)) {
      const id = (via.url || "").split("/").pop() || String(via.source);
      if (!found.has(id)) {
        found.set(id, { pkg: via.name, severity: via.severity, url: via.url, title: via.title });
      }
    }
  }
}

// [fix/flaky-tests-allowlist-expiry] `today` decides expiry, so AUDIT_GATE_TODAY (a test/debug
// override) is honoured only outside CI — otherwise setting it to a past date would un-expire entries.
const override = process.env.AUDIT_GATE_TODAY;
const useOverride = isIsoDate(override) && !process.env.CI;
if (override && !useOverride) console.log("audit-gate: ignoring AUDIT_GATE_TODAY (CI, or not an ISO date).");
const today = useOverride ? override : new Date().toISOString().slice(0, 10);

const { allowlisted: usedAllow, blocking, invalidEntries } = evaluateAllowlist(allow, found, today);

console.log(
  `audit-gate: ${found.size} high/critical advisor${found.size === 1 ? "y" : "ies"} present, ` +
    `${usedAllow.length} allowlisted, ${blocking.length} blocking.`
);
for (const { id, info, entry, label } of usedAllow) {
  console.log(
    `  ALLOWLISTED  ${info.severity.toUpperCase().padEnd(8)} ${info.pkg} (${id}) — fix ${entry.fixedIn}, ${label}`
  );
}

// Staleness / cleanup nudges (warn-only — must never re-red the gate on a future date).
for (const a of allow) {
  if (a.ageInOn && a.ageInOn <= today && found.has(a.id)) {
    console.log(
      `  ⚠ STALE     ${a.package} (${a.id}) aged in on ${a.ageInOn} — replace this allowlist entry with an \`overrides\` pin "${a.package}": "${a.fixedIn}".`
    );
  }
  if (!found.has(a.id)) {
    console.log(`  ⓘ RESOLVED  ${a.package} (${a.id}) no longer appears in npm audit — delete this allowlist entry.`);
  }
}

// Fail closed on a malformed allowlist even when the bad entry is currently unused.
const invalidUnused = invalidEntries.filter((e) => !blocking.some((b) => b.id === e.id));

if (blocking.length || invalidUnused.length) {
  const total = blocking.length + invalidUnused.length;
  console.error(`\naudit-gate FAILED — ${total} problem${total === 1 ? "" : "s"}:`);
  for (const b of blocking) {
    if (b.reason === "expired") {
      console.error(`  ${expiredLine(b.id, b.date)}`);
    } else if (b.reason === "invalid") {
      console.error(`  ${invalidLine(b.id, b.detail)}`);
    } else {
      console.error(`  NOT allowlisted:`);
    }
    console.error(`  ${b.info.severity.toUpperCase()}  ${b.info.pkg} (${b.id}) — ${b.info.title}`);
    console.error(`      ${b.info.url}`);
  }
  for (const e of invalidUnused) console.error(`  ${invalidLine(e.id, e.detail)}`);
  console.error(
    "\nResolve via an npm `overrides` pin to a patched version. ONLY if the patch is blocked by\n" +
      ".npmrc min-release-age, add a justified, dated entry to audit-allowlist.json (Architect review)."
  );
  process.exit(1);
}

console.log("audit-gate PASSED — no un-allowlisted high/critical advisories.");
