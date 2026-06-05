# TeraSwap — CoW Swap Incident Response
**Date:** 14 April 2026
**Status:** DRAFT — pending approval by Architect + Security Auditor
**Incident:** CoW Protocol frontend (swap.cow.fi) compromised via DNS hijacking

---

## A. Twitter / X Thread (EN)

**1/6 — Hook**
We're aware of the security incident affecting CoW Swap's frontend (swap.cow.fi), which CoW Protocol has confirmed was compromised via DNS hijacking.

TeraSwap users are safe. Our interface at teraswap.app and our infrastructure are independent and unaffected. 🧵

**2/6 — Why TeraSwap users are safe**
TeraSwap operates its own frontend and communicates with aggregators exclusively through backend APIs.

Our users have never interacted with swap.cow.fi. The compromised domain is not a surface our users are exposed to at any point in the swap flow.

**3/6 — Defense-in-depth**
Even in the unlikely scenario of a compromised aggregator API, three independent layers protect every TeraSwap trade:

• Calldata Recipient Validation — funds can only be routed to your wallet or our verified fee collector.
• Selector Whitelist — only audited function calls are accepted; unknown calldata is rejected.
• Price Guard — every quote is cross-checked against an independent DefiLlama oracle; abnormal slippage is blocked pre-execution.

**4/6 — Preventive action**
Out of an abundance of caution, we have preventively disabled CoW Protocol as a source until their team publishes a full post-mortem and confirms the integrity of their API infrastructure.

Our 10 other aggregator sources — 1inch, 0x, KyberSwap, Odos, Velora, OpenOcean, Uniswap V3, SushiSwap, Balancer, Curve — continue to operate normally. Routing quality is unaffected.

**5/6 — If you used swap.cow.fi today**
• DO NOT visit swap.cow.fi
• DO NOT sign any message or transaction from that domain
• If you already connected your wallet there, go to revoke.cash immediately and revoke all token approvals
• TeraSwap users on teraswap.app are unaffected

**6/6 — Commitment**
Security is the foundation of TeraSwap. We will continue to monitor the situation and share updates as CoW Protocol publishes their post-mortem.

Our architecture is built on redundancy and independent verification — no single point of failure. That principle is working exactly as designed today.

Questions? Reply below or join us on Discord/Telegram.

---

## B. Website Notice (EN)

**Banner (top of site, dismissable):**

> **TeraSwap is operating normally and is not affected by the CoW Swap frontend incident.** We have preventively disabled CoW Protocol as a routing source; our 10 other aggregators continue to operate. [Read the full statement →](#twitter-thread-link)

**Alternate shorter version (if space-constrained):**

> **TeraSwap users are safe.** We're unaffected by the CoW Swap frontend incident and have preventively paused CoW as a source. [Details →](#link)

---

## C. Discord / Telegram Announcement (EN)

### Pinned message (short)
> 🛡️ **TeraSwap is not affected by the CoW Swap frontend incident.** Our interface, infrastructure, and your funds are safe. CoW Protocol has been temporarily disabled as a routing source as a precaution — 10 other aggregators remain active. Full statement ↓

### Announcements channel (long)
Hey everyone 👋

You may have seen the news that **CoW Protocol's frontend (swap.cow.fi) was compromised earlier today** via a DNS hijack at the registrar level. CoW's team has confirmed the incident and advised users not to use their frontend while they investigate.

We want to address this directly:

**TeraSwap is not affected.**

Here's why, in plain terms:

**1. Different infrastructure.** TeraSwap runs its own frontend at teraswap.app. We only talk to aggregators through their backend APIs — our users have never been sent to swap.cow.fi at any point in a swap.

**2. Defense in depth.** Even if an aggregator's API returned malicious data, every swap on TeraSwap passes through three independent checks before it's broadcast:
  → We verify the recipient of every transaction is your wallet or our verified fee collector.
  → We only accept audited function calls — anything unexpected is rejected.
  → We cross-check every price against an independent oracle (DefiLlama). Suspicious slippage blocks the trade.

**3. Preventive action.** Out of caution, we've disabled CoW Protocol as a source until their post-mortem is published and API integrity is confirmed. Our other 10 aggregators (1inch, 0x, KyberSwap, Odos, Velora, OpenOcean, Uniswap V3, SushiSwap, Balancer, Curve) continue routing normally. You won't notice any degradation in quotes.

**If you used swap.cow.fi today:**
• Don't return to the site.
• Don't sign any transaction or message from that domain.
• Go to **revoke.cash** and revoke any token approvals you granted today.

If you have any questions or concerns, drop them below or tag a team member — we're around and watching this closely.

Stay safe 🛡️
— The TeraSwap team

### Open invitation line
> Got questions? Drop them in this thread — the team is monitoring and will respond.

---

## D. Portuguese (PT-PT) Versions

### Twitter / X Thread (PT)

**1/6**
Estamos a acompanhar o incidente de segurança que afetou o frontend da CoW Swap (swap.cow.fi), cujo comprometimento via DNS hijacking foi confirmado pela equipa da CoW Protocol.

Os utilizadores da TeraSwap estão seguros. A nossa interface em teraswap.app e a nossa infraestrutura são independentes e não foram afetadas. 🧵

**2/6**
A TeraSwap opera o seu próprio frontend e comunica com os agregadores exclusivamente através de APIs backend.

Os nossos utilizadores nunca interagiram com o swap.cow.fi. Esse domínio comprometido não está em nenhum ponto do fluxo de swap.

**3/6**
Mesmo no cenário improvável de uma API de agregador comprometida, três camadas independentes protegem cada transação na TeraSwap:

• Validação do destinatário da calldata — os fundos só podem ir para a tua wallet ou para o nosso fee collector verificado.
• Whitelist de seletores — apenas chamadas de função auditadas são aceites; calldata desconhecida é rejeitada.
• Price Guard — cada cotação é validada contra um oráculo independente (DefiLlama); slippage anormal é bloqueado antes da execução.

**4/6**
Por precaução, desativámos preventivamente a CoW Protocol como source até que a sua equipa publique o post-mortem completo e confirme a integridade da infraestrutura da API.

Os nossos outros 10 agregadores — 1inch, 0x, KyberSwap, Odos, Velora, OpenOcean, Uniswap V3, SushiSwap, Balancer, Curve — continuam a operar normalmente. Não haverá degradação nas rotas.

**5/6**
Se usaste o swap.cow.fi hoje:
• NÃO voltes a visitar swap.cow.fi
• NÃO assines nenhuma mensagem ou transação desse domínio
• Se já ligaste a carteira, vai ao revoke.cash imediatamente e revoga todas as aprovações de tokens
• Utilizadores da TeraSwap em teraswap.app estão seguros

**6/6**
Segurança é a base da TeraSwap. Vamos continuar a monitorizar a situação e a partilhar atualizações à medida que a CoW Protocol publicar o post-mortem.

A nossa arquitetura assenta em redundância e verificação independente — sem pontos únicos de falha. Esse princípio está a funcionar hoje exatamente como foi desenhado.

Dúvidas? Responde aqui ou junta-te a nós no Discord/Telegram.

### Website Notice (PT)

> **A TeraSwap está a operar normalmente e não foi afetada pelo incidente no frontend da CoW Swap.** Desativámos preventivamente a CoW Protocol como source; os nossos outros 10 agregadores continuam operacionais. [Ler comunicado completo →](#link)

### Discord / Telegram (PT) — Pinned

> 🛡️ **A TeraSwap não foi afetada pelo incidente no frontend da CoW Swap.** A nossa interface, infraestrutura e os teus fundos estão seguros. Desativámos temporariamente a CoW Protocol como source — os outros 10 agregadores continuam ativos. Comunicado completo ↓

---

## Approval Checklist

- [ ] **Architect review** — confirm technical accuracy of:
  - Backend-only API integration claim
  - Description of three defense layers
  - List of 10 active aggregator sources
- [ ] **Security Auditor review** — confirm:
  - Calldata Recipient Validation description is precise
  - Selector Whitelist description matches implementation
  - Price Guard + DefiLlama oracle description is accurate
  - No overclaims or underclaims about protections
- [ ] **Final sign-off** — legal/comms lead before publication

## Publication Checklist (post-approval)

- [ ] Schedule Twitter thread for coordinated release
- [ ] Deploy website banner
- [ ] Post Discord announcement + pin
- [ ] Post Telegram announcement + pin
- [ ] Monitor replies for 4h window; team on-call
- [ ] Prepare follow-up post once CoW publishes post-mortem

---

**Notes for reviewers:**
- The number "11 sources total / 10 remaining active" assumes CoW is the only source paused. Verify this matches current production config.
- The URL `teraswap.app` is used throughout; confirm that matches the canonical production domain (vs. the Vercel preview URL).
- No criticism of CoW Protocol anywhere — they are framed as victims.
- No marketing spin — no "switch to us" language, no crisis-as-opportunity framing.
