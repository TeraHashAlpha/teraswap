# CHORE-OZ-SUBMODULE — restore test-contracts (Foundry) to green

## Why (high priority)
The `CI / test-contracts` (Foundry) check has failed on EVERY PR for the whole 9x arc — it's been
treated as "chronic, ignore it." That means **there is currently NO contract-regression signal in CI**:
a real Solidity change that breaks the contracts would pass unnoticed in the red noise. For a protocol
with on-chain fund flows (FeeCollector), that's the scariest CI gap. Fix it so test-contracts is
meaningful again.

## Known symptom
`forge` fails to compile the formal-verification harnesses:
`Source "lib/openzeppelin-contracts/fv/patched/access/Ownable.sol" not found` (and Pausable,
TimelockController). The `contracts/order-engine/lib/openzeppelin-contracts` submodule is out of sync /
the `fv/patched/**` files the harnesses import are missing. Working tree has shown this submodule
"modified" for weeks.

## Task (investigate → fix the build, NO contract logic changes)
1. Diagnose: is it (a) the OZ submodule not initialized/pinned to the right commit, (b) the `fv/patched`
   harness files referencing paths that don't exist in the pinned OZ version, (c) a `remappings.txt` /
   `foundry.toml` resolution issue, or (d) the harnesses are stale/abandoned and should be excluded?
2. Fix the BUILD so `forge build` + `forge test` compile and run green:
   - If submodule sync: `git submodule update --init --recursive` to the pinned commit; if the pin is
     wrong, set it to the OZ version the harnesses + contracts actually need (document the version).
   - If the `fv/patched` harnesses are obsolete formal-verification scaffolding not part of the real
     test suite: exclude them from the Foundry build/test (e.g. foundry.toml `test`/`script` paths or a
     `.forgeignore`) so the REAL contract tests (TeraSwapFeeCollector.t.sol, TeraSwapOrderExecutor.t.sol
     — the 19+ Foundry tests) run and pass. Document why the harnesses were excluded.
   - Fix remappings if that's the resolution gap.
3. Confirm the REAL contract tests actually RUN and PASS (not just "compiles") — the FeeCollector +
   OrderExecutor suites. Capture `forge test` output in the commit body.
4. Make the CI job (`.github/workflows/*` test-contracts) green on a fresh checkout (submodule init in
   CI if needed).

## Do NOT
- Do NOT change any contract SOURCE logic (TeraSwapFeeCollector.sol, TeraSwapOrderExecutor.sol, etc.) —
  this is a build/CI fix only. No redeploy. If a contract test reveals a real bug, STOP and report
  (separate, audited sprint — rules #2/#3).
- Do NOT disable/skip real contract tests to force green — only exclude genuinely-obsolete FV
  scaffolding, with justification.
- Branch `chore/oz-submodule-test-contracts`, atomic SSH-signed commits, append FEEDBACK with the root
  cause + the OZ version + what (if anything) was excluded and why. Open PR; confirm test-contracts
  goes GREEN on the PR.
