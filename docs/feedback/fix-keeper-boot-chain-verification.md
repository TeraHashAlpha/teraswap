# Feedback — fix/keeper-boot-chain-verification

### The Auditor found a production fail-open, not just a bad test
The gate's timeout timer was `.unref()`'d. The gate runs before the health server, the monitor and
the poll interval exist, so when an RPC accepts the connection then goes silent it is the ONLY thing
on the event loop: Node drains it and the process dies with a bare "unsettled top-level await" —
exit without ever printing the refusal. Reproduced in isolation (exit 13, no output). Fixed by
ref'ing the timer; pinned by a subprocess test that runs the gate with nothing else alive, because
no in-process test can catch it (the runner's own handle masks it). My "376/0/0" was real for Node
25.6.1 and worthless as evidence — the suite's completion depended on the runner, not the code.

### Identity method — verified on-chain for v2, NOT for v3
`ORDER_TYPEHASH()` (v2 `TeraSwapOrderExecutor.sol:107`, v3 `…V3.sol:120`). Both live v2 deployments
(mainnet `0xeFC3…f130`, Base `0x135B…2598`) return `0x4c8bd2ee…f11c9be5`, matching the source-derived
pin. **No live v3 address exists in this repo (env-only), so the v3 pin
`0xfc939b74…7204cbc0` is source-derived only.** If a deployed v3 predates the current source, that
keeper now refuses to boot. Ops must read `ORDER_TYPEHASH()` off the deployed v3 and confirm before
the next Base keeper restart.

### What a per-chain address table in the keeper would require (not done, per constraint)
1. A committed `ORDER_EXECUTOR_BY_CHAIN` mirroring `src/lib/order-engine/config.ts` plus a drift
   test pinning the two, and a precedence rule when the env var disagrees (fail-closed is the only
   safe answer).
2. An ops migration: `ORDER_EXECUTOR_ADDRESS` stops being the source of truth for every existing
   deployment (pm2 units, `.env.executor`, runbooks), and a chain with no entry must refuse rather
   than fall back to the env — i.e. it changes the ops config contract, not just code.

### Test-surface facts
`node --test` auto-discovers `*.test.mjs`, so this file joins `keeper-tests` CI with no workflow
edit. The keeper suite is NOT part of `npx vitest run` — separate runner, separate job; a green
vitest number says nothing about these 80 tests.

### Could not reproduce the 2 pre-existing failures
389/0/0 exit 0 here, both with root-hoisted viem 2.55.2 and after `npm ci` in
`contracts/order-engine/executor` (viem 2.47.10, the CI config). Left untouched as instructed;
the Auditor's environment differs in something I cannot see from here.

### Defects my own tests found in my error paths
`JSON.stringify` throws on a BigInt (a malformed `ORDER_TYPEHASH` of `1n` turned a refusal into a
`TypeError`), and `errText` leaked the keyed RPC URL for any non-viem error. Both fixed
(`describeValue`, `redactUrls`).

---

## Redaction follow-up (defect A + B)

### CodeQL at `chain-verify.test.mjs:514` is a false positive — left untouched
`assert.doesNotMatch(err.message, /alchemy\.com/)`. `js/incomplete-url-substring-sanitization`
assumes a match means ACCEPT, so an unanchored host lets `evil.com/alchemy.com` through a whitelist.
Both premises are inverted here: the subject is a refusal sentence, not a URL, and the assertion is
negative — unanchored is the *strictest* form an absence check can take, and `^…$` would gut it. The
two obvious rewrites are no better: `.includes("alchemy.com")` is flagged by the same query, and
anchoring silently weakens the test. **This needs an owner decision — dismiss as false positive or
add an inline suppression. The CodeQL job on #381 stays red until then.** My new assertions use
sentinels with no dots and no TLD shape, so they add no further findings.

### `err.value` is NOT redacted, and a caller that logs it leaks
Redaction covers emitted strings (`errText`, `describeValue`). `ChainVerificationError.value` carries
the RAW answer for structured logging and is pinned that way by the identity tests
(`assert.equal(err.value, wrong)`), so it can hold an unredacted RPC URL. `executor.js` logs only
`err.message` today, so nothing leaks — but any future Sentry/Telegram hook that serialises the whole
error will. Either redact at the sink or make `value` a redacted accessor; not done here because it
would change what the tests pin.

### `errText` never reads `.cause`
A URL that exists only in a nested cause cannot leak — and also cannot inform. An undici
`fetch failed` whose real reason is one level down renders as three words. Deliberate (unchanged
semantics), but it is why the boot-refusal line is sometimes thinner than the failure deserves.

### Over-redaction has a readability cost, accepted on purpose
Inside redacted text only, a dotted token followed by `/` or `:` goes whole — so `chain-verify.js:120`
and a `12:30` timestamp are eaten. Version-shaped numbers (`viem 2.47.10`, `1.5 gwei`) survive, which
is the case that actually mattered. Losing a host costs a lookup; losing a key costs a rotation.

### The M01–M20 table was not in this file
Only the commit body for `c91488b` summarised it ("20 rows … all 20 RED"); the rows themselves were
never written down. I reconstructed them 1:1 from the module's guards and added M21–M27 for this
change. The runner is now reproducible rather than a claim. **27/27 RED, no survivors**, baseline and
restore both 406/0/0, `git diff` empty after. Worth committing the runner if this repeats.
