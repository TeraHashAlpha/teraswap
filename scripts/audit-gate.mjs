#!/usr/bin/env node
/**
 * CI audit gate with a documented, temporary allowlist.
 *
 * Replaces a bare `npm audit --audit-level=high`. Behaviour:
 *   - FAILS (exit 1) on ANY high/critical advisory that is NOT in audit-allowlist.json.
 *   - PASSES (exit 0) when every remaining high/critical is explicitly allowlisted.
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

const ROOT = new URL("../", import.meta.url);
const allowlist = JSON.parse(readFileSync(new URL("audit-allowlist.json", ROOT), "utf8"));
const allowed = new Map((allowlist.allow || []).map((a) => [a.id, a]));

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

const unallowed = [...found].filter(([id]) => !allowed.has(id));
const usedAllow = [...found].filter(([id]) => allowed.has(id));

console.log(
  `audit-gate: ${found.size} high/critical advisor${found.size === 1 ? "y" : "ies"} present, ` +
    `${usedAllow.length} allowlisted, ${unallowed.length} blocking.`
);
for (const [id, info] of usedAllow) {
  const meta = allowed.get(id);
  console.log(
    `  ALLOWLISTED  ${info.severity.toUpperCase().padEnd(8)} ${info.pkg} (${id}) — fix ${meta.fixedIn}, ages in ${meta.ageInOn}`
  );
}

// Staleness / cleanup nudges (warn-only — must never re-red the gate on a future date).
const today = process.env.AUDIT_GATE_TODAY || new Date().toISOString().slice(0, 10);
for (const a of allowlist.allow || []) {
  if (a.ageInOn && a.ageInOn <= today && found.has(a.id)) {
    console.log(
      `  ⚠ STALE     ${a.package} (${a.id}) aged in on ${a.ageInOn} — replace this allowlist entry with an \`overrides\` pin "${a.package}": "${a.fixedIn}".`
    );
  }
  if (!found.has(a.id)) {
    console.log(`  ⓘ RESOLVED  ${a.package} (${a.id}) no longer appears in npm audit — delete this allowlist entry.`);
  }
}

if (unallowed.length) {
  console.error(
    `\naudit-gate FAILED — ${unallowed.length} high/critical advisor${unallowed.length === 1 ? "y is" : "ies are"} NOT allowlisted:`
  );
  for (const [id, info] of unallowed) {
    console.error(`  ${info.severity.toUpperCase()}  ${info.pkg} (${id}) — ${info.title}`);
    console.error(`      ${info.url}`);
  }
  console.error(
    "\nResolve via an npm `overrides` pin to a patched version. ONLY if the patch is blocked by\n" +
      ".npmrc min-release-age, add a justified, dated entry to audit-allowlist.json (Architect review)."
  );
  process.exit(1);
}

console.log("audit-gate PASSED — no un-allowlisted high/critical advisories.");
