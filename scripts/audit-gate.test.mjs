/**
 * [fix/flaky-tests-allowlist-expiry] audit-gate allowlist EXPIRY enforcement.
 *
 * Two layers: (1) the pure rules in audit-gate-lib.mjs, (2) the real script end to end —
 * copied into a temp tree next to a temp audit-allowlist.json, with a stub `npm` on PATH
 * that prints canned `npm audit --json` output. No network, no repo files touched.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { copyFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { entryStatus, evaluateAllowlist, isIsoDate } from "./audit-gate-lib.mjs";

const TODAY = "2026-11-02";
const ID = "GHSA-aaaa-bbbb-cccc";

describe("audit-gate-lib", () => {
  it("isIsoDate accepts real calendar dates only", () => {
    expect(isIsoDate("2026-11-22")).toBe(true);
    expect(isIsoDate("2026-02-30")).toBe(false);
    expect(isIsoDate("2026-1-2")).toBe(false);
    expect(isIsoDate("tomorrow")).toBe(false);
    expect(isIsoDate(undefined)).toBe(false);
    expect(isIsoDate(20261122)).toBe(false);
  });

  it("valid: expires today or later", () => {
    expect(entryStatus({ expires: "2026-11-22" }, TODAY).state).toBe("valid");
    expect(entryStatus({ expires: TODAY }, TODAY).state).toBe("valid"); // last valid day
  });

  it("expired: expires strictly in the past", () => {
    expect(entryStatus({ expires: "2026-11-01" }, TODAY)).toMatchObject({ state: "expired", date: "2026-11-01" });
  });

  it("invalid: missing or malformed expires", () => {
    expect(entryStatus({}, TODAY).state).toBe("invalid");
    expect(entryStatus({ expires: "" }, TODAY).state).toBe("invalid");
    expect(entryStatus({ expires: "soon" }, TODAY).state).toBe("invalid");
    expect(entryStatus({ expires: "2026-13-01" }, TODAY).state).toBe("invalid");
  });

  it("noPatch: needs a valid reviewDate; a past reviewDate expires", () => {
    expect(entryStatus({ noPatch: true, reviewDate: "2026-12-01" }, TODAY).state).toBe("valid");
    expect(entryStatus({ noPatch: true }, TODAY).state).toBe("invalid");
    expect(entryStatus({ noPatch: true, reviewDate: "later" }, TODAY).state).toBe("invalid");
    expect(entryStatus({ noPatch: true, reviewDate: "2026-10-01" }, TODAY).state).toBe("expired");
    // noPatch must be exactly `true` — a truthy string is not an opt-in.
    expect(entryStatus({ noPatch: "yes", reviewDate: "2026-12-01" }, TODAY).state).toBe("invalid");
  });

  it("an expired entry moves its advisory from allowlisted to blocking", () => {
    const found = new Map([[ID, { pkg: "x", severity: "high", url: "u", title: "t" }]]);
    const live = evaluateAllowlist([{ id: ID, expires: "2026-11-22" }], found, TODAY);
    expect(live.allowlisted).toHaveLength(1);
    expect(live.blocking).toHaveLength(0);
    const dead = evaluateAllowlist([{ id: ID, expires: "2026-11-01" }], found, TODAY);
    expect(dead.allowlisted).toHaveLength(0);
    expect(dead.blocking).toEqual([expect.objectContaining({ id: ID, reason: "expired", date: "2026-11-01" })]);
  });
});

// ── end to end ────────────────────────────────────────────────────────────

let tree;
const here = new URL(".", import.meta.url).pathname;

beforeAll(() => {
  tree = mkdtempSync(join(tmpdir(), "audit-gate-"));
  mkdirSync(join(tree, "scripts"));
  mkdirSync(join(tree, "bin"));
  for (const f of ["audit-gate.mjs", "audit-gate-lib.mjs"]) copyFileSync(join(here, f), join(tree, "scripts", f));
  // Stub npm: print the canned audit JSON and exit non-zero like the real `npm audit`.
  writeFileSync(join(tree, "bin", "npm"), '#!/bin/sh\ncat "$AUDIT_GATE_TEST_AUDIT_JSON"\nexit 1\n');
  chmodSync(join(tree, "bin", "npm"), 0o755);
  writeFileSync(
    join(tree, "audit.json"),
    JSON.stringify({
      vulnerabilities: {
        pkgx: { via: [{ name: "pkgx", severity: "high", url: `https://github.com/advisories/${ID}`, title: "bad thing", source: 1 }] },
      },
    }),
  );
  writeFileSync(join(tree, "audit-none.json"), JSON.stringify({ vulnerabilities: {} }));
});

afterAll(() => rmSync(tree, { recursive: true, force: true }));

function runGate(allow, { auditFile = "audit.json", env = {} } = {}) {
  writeFileSync(join(tree, "audit-allowlist.json"), JSON.stringify({ allow }));
  const base = { ...process.env };
  delete base.CI;
  delete base.AUDIT_GATE_TODAY;
  const r = spawnSync("node", [join(tree, "scripts", "audit-gate.mjs")], {
    encoding: "utf8",
    env: {
      ...base,
      PATH: `${join(tree, "bin")}:${process.env.PATH}`,
      AUDIT_GATE_TEST_AUDIT_JSON: join(tree, auditFile),
      AUDIT_GATE_TODAY: TODAY,
      ...env,
    },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const entry = (over) => ({ id: ID, package: "pkgx", fixedIn: "9.9.9", reason: "r", ...over });

describe("audit-gate script — allowlist expiry", () => {
  it("valid entry passes and prints the real expiry (never 'undefined')", () => {
    const r = runGate([entry({ expires: "2026-11-22" })]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("ALLOWLISTED");
    expect(r.out).toContain("expires 2026-11-22");
    expect(r.out).not.toContain("undefined");
    expect(r.out).toContain("audit-gate PASSED");
  });

  it("an entry expiring today still passes (expiry is strictly 'in the past')", () => {
    expect(runGate([entry({ expires: TODAY })]).code).toBe(0);
  });

  it("expired entry blocks with the EXPIRED line", () => {
    const r = runGate([entry({ expires: "2026-11-01" })]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(
      `EXPIRED allowlist entry ${ID} (expired 2026-11-01) — pin the patch or renew with Architect review`,
    );
    expect(r.out).toContain("0 allowlisted, 1 blocking");
    expect(r.out).not.toContain("audit-gate PASSED");
  });

  it("missing `expires` is invalid and blocks", () => {
    const r = runGate([entry({})]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`INVALID allowlist entry ${ID}`);
    expect(r.err).toContain("missing `expires`");
  });

  it("noPatch + future reviewDate passes; noPatch without reviewDate blocks; past reviewDate is EXPIRED", () => {
    const ok = runGate([entry({ noPatch: true, reviewDate: "2026-12-01" })]);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain("review by 2026-12-01");
    expect(runGate([entry({ noPatch: true })]).code).toBe(1);
    const stale = runGate([entry({ noPatch: true, reviewDate: "2026-10-01" })]);
    expect(stale.code).toBe(1);
    expect(stale.err).toContain(`EXPIRED allowlist entry ${ID} (expired 2026-10-01)`);
  });

  it("an unlisted advisory still blocks", () => {
    const r = runGate([]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("NOT allowlisted");
  });

  it("a malformed entry fails the gate even when its advisory is absent", () => {
    const r = runGate([entry({})], { auditFile: "audit-none.json" });
    expect(r.code).toBe(1);
    expect(r.err).toContain(`INVALID allowlist entry ${ID}`);
  });

  it("an expired entry whose advisory is gone only nudges deletion", () => {
    const r = runGate([entry({ expires: "2026-11-01" })], { auditFile: "audit-none.json" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("RESOLVED");
  });

  it("AUDIT_GATE_TODAY cannot un-expire an entry in CI", () => {
    const r = runGate([entry({ expires: "2026-11-01" })], { env: { CI: "true", AUDIT_GATE_TODAY: "2026-01-01" } });
    expect(r.code).toBe(1);
    expect(r.err).toContain(`EXPIRED allowlist entry ${ID}`);
  });
});
