# feat/ui-v2-swap-modals — feedback (B4)

Off origin/main `9e7aefa` (B3 merged). Dedicated worktree, real `npm ci`. No PR (owner opens it). SSH-signed, noreply. Code diff only under `src/ui/v2/**`; v1 components/hooks/lib/api untouched. Display only — no wallet action is sent (B5 wires Confirm → sign).
- [ ] C1 slippage (22) + token selector (23/m02) · [ ] C2 Permit2 (25) + review (26/m03) + split/CoW (27) · [ ] C3 route label + gas · [ ] evidence 1–7

## Premises (recorded; owner answered in-session)
- **No `SwapReview*` exists.** Frame 26/m03 "Review Transaction" is v1 `TransactionPreview.tsx`; frame 27 is `SplitReviewModal.tsx` + `CowOrderReviewModal.tsx`. Owner: **add those three to read-only scope**, and the review sheet shows **frame 26's fields + the goal's extras** (slippage / fee / gas / tier line from the quote object).
- Also read for C3 (needed to find the "~0 ETH" cause, not in the list): `src/hooks/useEthGasCost.ts` — see C3.
- **Frame copy ≠ v1 copy** in 23 (chip "All", re-worded import notice), 25 ("How Permit2 approvals work", "TeraSwap uses Permit2…") and 27 (CoW box). Goal says v1 verbatim → v1 wins; frame structure/layout is kept, frame wording is not.
- **Environment event (not mine):** at ~13:04 the whole of `~/ts-worktrees/*` (this worktree and every sibling, incl. other branches' worktrees) was deleted by something outside this session while I worked. Branch refs and pushed commits are intact (`git for-each-ref`), but any uncommitted work in those worktrees is gone. I rebuilt this worktree and re-created the lost files from context; commits are pushed as they land.

## Findings so far
- v1 `SlippageModal`: an empty custom field + OK sets **0.01 %** (`Number('')`→0→clamped up). v2 disables OK / Enter on an empty field; the 0.01–15 clamp is otherwise identical (bounds unchanged, tested against v1's calls).
- v1 modals each hand-roll (or lack) focus handling; v2 has one `modals/Sheet` (trap, Esc, restore focus, bottom sheet ≤ 600 px) tested once.
