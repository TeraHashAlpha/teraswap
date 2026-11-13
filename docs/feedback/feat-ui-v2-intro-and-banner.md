# feat/ui-v2-intro-and-banner

## Tasks
- [ ] Commit 1: entry animation on the v2 landing (intro.css + Intro.tsx, tests)
- [ ] Commit 2: notice banner restyle. BLOCKED, see Premise below
- [ ] Verify: agent-verify.sh --codeql, gen-claude-state --check, v1 proof, push, compare link

## Premise findings (asked once, then the conservative reading)
- `~/Desktop/teraswap-round2-pack/round10-intro-banner/` does not exist (the pack folder is empty). `banner/` exists nowhere on this Mac.
  Commit 2 is NOT done: designing it from memory is ruled out by the goal.
- `arc-reveal.mp4` was found at `~/Downloads/arc-reveal.mp4` (1600x900, 3.9 s, per mdls), so Commit 1 is built from it.
- The landing is NOT server-rendered: `src/app/client-providers.tsx` loads `Providers` with `ssr: false`, so the whole page mounts on the client.
  The overlay therefore lives inside `LandingV2` and mounts in the same commit as the landing (no flash of landing before it).
