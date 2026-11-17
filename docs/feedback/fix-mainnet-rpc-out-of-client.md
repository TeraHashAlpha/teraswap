## Feedback — fix/mainnet-rpc-out-of-client (SEC-5, security audit 2026-11-17)

**Draft + Auditor required** (provider key in a client chunk; server RPC chain changed). Long tables: `fix-mainnet-rpc-out-of-client.tables.md`.

### Checklist
- [x] Step 0 before: marker build of origin/main `4a4129ef`, marker found in a client chunk, CI bundle test red
- [ ] 1. No client-reachable read of `NEXT_PUBLIC_RPC_URL`; mainnet built like Base/Arbitrum
- [ ] 2. rpc-env server chain RPC_URL_1 → RPC_URL → public default; env-validation follows; ENV-RPC runbook
- [ ] 3. CI bundle markers for the three mainnet names; unit guard on `NEXT_PUBLIC_*RPC*` reads
- [ ] 4. Mainnet browser session RPC calls vs 300/min, method allow-list coverage
- [ ] Tests: server (RPC_URL_1 only / none / NEXT_PUBLIC alone), e2e v1+v2, Base/Arbitrum unchanged, mutation proof
- [ ] Step 0 after: zero hits
- [ ] Verify: `agent-verify.sh --codeql`, `gen-claude-state.mjs --check`, lint delta 0
- [ ] Push, compare link

### Owner answers (asked once, 2026-11-17; they supersede the goal text)
One AskUserQuestion, four parts, before any code.
- **E2E quote** — answered: browser reads hit the REAL `/api/rpc` handler, upstream = a local ABI-aware JSON-RPC
  stub; `/api/quote` answered by a fixture; the rig is committed with its own local-only Playwright config (CI does not run it).
- **Guard scope, env checks, fallback names** — no answer came back. Not re-asked (the goal says ask ONCE); the
  recommended reading of each was applied, and each one follows the goal's letter:
  - Guard: server-only = `src/app/api/**` plus rpc-env.ts's computed, window-guarded `readServerOnly` (the Base/Arbitrum
    deprecated fallback, kept byte-identical). Any literal read of a `NEXT_PUBLIC_*RPC*` name elsewhere under src/ fails;
    the three mainnet names appear in no non-test code under src/.
  - env-validation: the `required` `NEXT_PUBLIC_RPC_URL` rule is removed; `RPC_URL_1` stays optional (warning), label =
    the new chain. No check reads a dead name.
  - `NEXT_PUBLIC_FALLBACK_RPC_1/_2`: dropped. They fed only wagmi's SERVER-side mainnet transport; mainnet now uses the
    same builder as Base/Arbitrum. The owner deletes them in Vercel after deploy.
