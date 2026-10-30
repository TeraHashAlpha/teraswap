# feat/ui-v2-dca-signing — feedback (B6b)

Off origin/main `d8d658c` (#624 B6a merged). Signed, noreply, no PR. Diff only `src/ui/v2/**` + this file/folder.
**AUDITOR REQUIRED before merge (fund flow: signs orders).** Tests mock wallet/RPC/API; no wallet connected, nothing signed or sent.

## Checklist
- [x] C1 Create DCA → v1 path (createOrder → EIP-712 review → confirmOrder), consent/409, signing/created/failure, wrong network
- [ ] C2 cancel → v1 path (cancelOrder → cancel review → confirmCancel), Cancel All, positions from the engine
- [ ] C3 a11y + edge (focus, Esc, draft key, double press, reduced motion)
- [ ] evidence 1-6
