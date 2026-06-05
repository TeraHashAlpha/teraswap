# Audit Report — Sprint 35 (Wagmi v3 Migration Prep)

| Field | Value |
|---|---|
| **Sprint** | 35 |
| **Branch** | `chore/sprint-35-wagmi-v3-prep` |
| **Commits** | 6 (`4f6f70c`, `f8a1307`, `68cd78c`, `57ab15c`, `e28eb92`, `8673fbb`) |
| **Prompts** | P183, P184, P185, P186 + 2 feedback commits |
| **Auditor** | Claude (Senior Security Auditor) |
| **Date** | 2026-05-28 |
| **Verdict** | **APPROVED — 0C / 0H / 0M / 0L / 4 INFO** |

---

## Scope

Wagmi v3 migration prep: TypeScript semver tightening, wallet connector peer dep preinstall, `useChains()` refactor in SwapButton, ADR-008 index, plus 2 feedback documentation commits. 5 files changed (excluding `package-lock.json`), +208 lines. Zero contract/fund-flow changes.

### Files in diff

| File | Change | Prompt |
|---|---|---|
| `package.json` | Modified (+2 deps, TS semver) | P183, P184 |
| `package-lock.json` | Regenerated | P183, P184 |
| `src/components/SwapButton.tsx` | Modified (+4/-2 lines) | P185 |
| `src/components/SwapButton.test.tsx` | Modified (+1 line) | P185 |
| `ARCHITECT-INDEX.md` | **NEW** (136 lines) | P186 |
| `FEEDBACK.md` | Modified (+64 lines) | feedback commits |

---

## P183 — TypeScript semver tightening (`57ab15c`)

### Analysis

**Original intent:** Upgrade TypeScript from 5.5 to 5.9.x. **Actual state:** TypeScript was already at 5.9.3 on `main` (bumped by Dependabot in Sprint 30, P167). The Code Agent documented this in FEEDBACK.md.

**What the commit does:** Tightens the version specifier from `"5.9.3"` (exact) to `"~5.9.3"` (tilde range — accepts 5.9.x patches, locks minor).

### Checklist

| Check | Result |
|---|---|
| `typescript` version in package.json | ✅ `"~5.9.3"` — correct tilde range |
| No `tsconfig.json` changes | ✅ Not in diff |
| No source code changes | ✅ Only `package.json` + lockfile |
| Semver intent matches architect's `~5.9` | ✅ `~5.9.3` is functionally equivalent |

**Verdict:** Conforme. A mudança é mínima mas defensiva — garante que `npm install` puxa patches 5.9.x automaticamente sem saltar para 5.10.

---

## P184 — Connector peer deps preinstall (`4f6f70c`)

### Checklist

| Check | Result |
|---|---|
| `@walletconnect/ethereum-provider` in dependencies | ✅ Version `2.23.9` |
| `@coinbase/wallet-sdk` in dependencies | ✅ Version `4.3.7` |
| `@metamask/connect-evm` NOT in package.json | ✅ Zero matches |
| `@metamask/connect-evm` NOT in package-lock.json | ✅ Zero matches |
| No source code changes | ✅ Only package.json + lockfile |
| wagmi version unchanged | ✅ `2.19.5` on both main and branch |
| viem version unchanged | ✅ `2.47.4` on both main and branch |
| RainbowKit version unchanged | ✅ `2.1.0` on both main and branch |

### Dependency analysis

`@coinbase/wallet-sdk` bumped from 4.3.6 (transitive via wagmi) to 4.3.7 (explicit). A versão 4.3.7 remove dependências internas (`idb-keyval`, `zustand`, `ox`) e relaxa ranges (`@noble/hashes` de `1.4.0` para `^1.4.0`). Isto é um patch release de cleanup — sem mudanças de API, sem risco de regressão.

`@walletconnect/ethereum-provider` 2.23.9 é a versão compatível com wagmi 2.19.5 — era transitiva, agora é explícita.

**Verdict:** Conforme. P184 fecha correctamente o requisito de peer deps explícitos sem alterar versões core.

---

## P185 — `useChains()` refactor (`e28eb92`)

### Analysis

**Original intent:** Replace `useSwitchChain().chains` with `useChains()`. **Actual state:** SwapButton never destructured `.chains` from `useSwitchChain()` — it only used `{ switchChain }`. The Code Agent documented this in FEEDBACK.md.

**What the commit does:** Adds `useChains()` import and uses it to derive the chain name dynamically for the "Switch to {chainName}" button text, replacing the previously hardcoded `"Switch to Ethereum"`.

### Checklist

| Check | Result |
|---|---|
| `useChains` imported from `'wagmi'` | ✅ Line 1 |
| `useSwitchChain()` only destructures `switchChain` | ✅ No `.chains` removed |
| `useAccount` NOT renamed to `useConnection` | ✅ Zero `useConnection` in entire sprint diff |
| `const configuredChains = useChains()` | ✅ Line 35 |
| `targetChainName` derived via `.find((c) => c.id === CHAIN_ID)?.name ?? 'Ethereum'` | ✅ Line 36 |
| Button text: `Switch to ${targetChainName}` | ✅ Line 45 |
| Test mock updated: `useChains: vi.fn(() => [{ id: 1, name: 'Ethereum' }])` | ✅ |
| No other hooks renamed | ✅ Only `SwapButton.tsx` and its test changed |
| Functionally equivalent | ✅ — defaults to `'Ethereum'` when CHAIN_ID (1) is found, same as before |

### Security assessment

A mudança é funcional e correcta:

1. **`useChains()` é estável em wagmi v2** — exportado desde wagmi 2.x, não é v3-only. A importação não causa conflito com a versão actual.
2. **Fallback `?? 'Ethereum'`** garante que mesmo que `CHAIN_ID` não esteja na lista de chains configuradas, o botão mostra um nome legível em vez de `undefined`.
3. **A lógica de `switchChain({ chainId: CHAIN_ID })` não mudou** — apenas o texto do botão é afectado.
4. **O mock no teste retorna `[{ id: 1, name: 'Ethereum' }]`** — matchando a configuração real do TeraSwap (Ethereum Mainnet, chain ID 1).

**Verdict:** Conforme. A mudança vai além do pedido original (que era no-op) mas é um refactor defensivo válido para v3 prep.

---

## P186 — ADR-008 index (`f8a1307`)

### Checklist

| Check | Result |
|---|---|
| `ARCHITECT-INDEX.md` created with ADR-008 row | ✅ `ADR-008 | Wagmi v3 Migration | Proposed | Defer until RainbowKit v3 compat` |
| `docs/ADR/ADR-008-wagmi-v3-migration.md` NOT modified | ✅ Zero diff |
| ADR-008 row format consistent with other ADR rows | ✅ Same table format |
| No source code changes | ✅ |

### Observation

O `ARCHITECT-INDEX.md` é um ficheiro **novo** de 136 linhas — não uma edição a um ficheiro existente. Contém o índice completo de artefactos arquitecturais (ADRs, incidentes, sprints, runbooks, audits, memória). A row do ADR-008 está correctamente posicionada na tabela de ADRs (secção 1), após o ADR-005.

**Nota:** A tabela pula de ADR-005 para ADR-008 — ADR-006 e ADR-007 não aparecem. Isto pode ser intencional (ADRs ainda não indexados de sprints anteriores) ou um gap.

**Verdict:** Conforme. ADR-008 correctamente indexado, ADR-008 source não modificado.

---

## Feedback commits (`68cd78c`, `8673fbb`)

### First feedback (`68cd78c`)

Documenta que P183 e P185 foram inicialmente no-ops:
- **P183:** TypeScript já estava em 5.9.3 (Dependabot P167). Verificação typecheck/build/test passou com a versão existente.
- **P185:** SwapButton não usava `.chains` de `useSwitchChain()` — não havia nada para substituir.
- **Edge case:** `.next/types/validator.ts` stale referenciava `.js` em vez de `.ts` — resolvido com `rm -rf .next/`.

### Second feedback (`8673fbb`)

Documenta a reconciliação: P183 e P185 foram subsequentemente implementados com scope adaptado (tilde semver e useChains() para label dinâmico). Code Agent nota que vitest count é 1108, não 1132+ como o sprint packet indicava.

### FEEDBACK.md assessment

| Check | Result |
|---|---|
| Append-only | ✅ Zero lines removed |
| No security concerns raised | ✅ |
| Test count discrepancy flagged | ✅ 1108 vs. 1132 — see 35-I-02 |
| Code Agent correctly flagged scope deviation | ✅ Transparent documentation |

**Verdict:** Conforme. Documentação de feedback exemplar — transparente sobre desvios do plano.

---

## Negative checks

| Check | Result |
|---|---|
| wagmi version unchanged (2.19.5) | ✅ |
| viem version unchanged (2.47.4) | ✅ |
| RainbowKit version unchanged (2.1.0) | ✅ |
| No `useAccount` → `useConnection` renames | ✅ Zero matches in diff |
| No `@metamask/connect-evm` in package.json | ✅ |
| No `@metamask/connect-evm` in package-lock.json | ✅ |
| Only 2 source files changed (`SwapButton.tsx` + test) | ✅ |
| No contract/fund-flow changes | ✅ |
| No API route changes | ✅ |
| No security-critical path changes | ✅ |
| No new `NEXT_PUBLIC_` env vars | ✅ |
| No hardcoded secrets | ✅ |

---

## Findings

### 35-I-01 — P183/P185 scope deviation from sprint packet (INFO)

**Ficheiros:** `package.json`, `src/components/SwapButton.tsx`

O sprint packet definia:
- P183: `npm install typescript@~5.9` (upgrade de 5.5). Na realidade, 5.9.3 já estava instalado. O commit tightens para `~5.9.3`.
- P185: Substituir `useSwitchChain().chains` por `useChains()`. Na realidade, SwapButton não usava `.chains`. O commit adiciona `useChains()` para label dinâmico.

Ambos os desvios estão documentados no FEEDBACK.md e são defensíveis:
- `~5.9.3` é melhor prática que versão exacta para patches automáticos.
- `useChains()` prepara o componente para v3 e elimina o hardcoded "Ethereum".

O Code Agent reportou transparentemente ambos os desvios antes de implementar a versão adaptada.

**Severidade:** INFO — desvios aceitáveis, bem documentados.

---

### 35-I-02 — Test count discrepancy: 1108 vs. 1132 (INFO)

**Ficheiro:** `FEEDBACK.md`

O sprint packet indica "1132+" testes esperados. O Code Agent reporta 1108 testes em `main`. Esta discrepância pode indicar que os 24 testes do Sprint 31B (P182) não estão contabilizados no baseline do branch, ou que o cálculo do Architect usou um número diferente.

Sprint 33 AUDIT confirma 1108 testes (1014 + 94). Sprint 31B adicionou 24 testes para um total de 1132. Se Sprint 31B está merged em `main` antes de Sprint 35, o count deveria ser 1132. Se Sprint 35 branched de um ponto anterior, 1108 é o baseline correcto.

**Recomendação:** Verificar que Sprint 31B está merged no `main` de onde Sprint 35 fez branch. Se sim, investigar porque vitest reporta 1108 e não 1132.

**Severidade:** INFO — sem impacto na segurança, necessita triagem pelo Architect.

---

### 35-I-03 — ARCHITECT-INDEX.md ADR gap: 006, 007 missing (INFO)

**Ficheiro:** `ARCHITECT-INDEX.md`

A tabela de ADRs salta de ADR-005 para ADR-008. ADR-006 e ADR-007 não aparecem. Possibilidades:
- ADR-006/007 existem mas não foram indexados.
- ADR-006/007 não existem (numeração com gaps).

**Recomendação:** O Architect deve verificar se ADR-006 e ADR-007 existem em `docs/ADR/` e indexá-los se necessário.

**Severidade:** INFO — gap de documentação, sem impacto de segurança.

---

### 35-I-04 — `@coinbase/wallet-sdk` bump 4.3.6 → 4.3.7 (INFO)

**Ficheiro:** `package-lock.json`

A explicitação de `@coinbase/wallet-sdk` no `package.json` puxou a versão 4.3.7 (vs. 4.3.6 transitivo anterior). O bump é um patch release que remove dependências internas (`idb-keyval`, `zustand@5`, `ox`) e relaxa ranges. Isto reduz o tamanho do bundle e elimina uma segunda instância de zustand (v5) que coexistia com a zustand v4 do TeraSwap.

Mudança positiva — menos dependências transitivas, menor superfície de ataque.

**Severidade:** INFO — bump de patch positivo.

---

## Verdict

| Severity | Count | IDs |
|---|---|---|
| Critical | 0 | — |
| High | 0 | — |
| Medium | 0 | — |
| Low | 0 | — |
| Info | 4 | 35-I-01, 35-I-02, 35-I-03, 35-I-04 |

**APPROVED — 0C / 0H / 0M / 0L / 4 INFO**

Sprint 35 é um sprint de preparação para wagmi v3 — zero alterações a lógica de produção, contratos, fund flows, ou paths de segurança. As versões core (wagmi 2.19.5, viem 2.47.4, RainbowKit 2.1.0) estão inalteradas. Os dois connector peer deps (`@walletconnect/ethereum-provider` 2.23.9, `@coinbase/wallet-sdk` 4.3.7) são packages já transitivamente instalados, agora explícitos. O refactor `useChains()` no SwapButton é funcional e forward-compatible. O `@metamask/connect-evm` NÃO foi instalado (correctamente). Nenhum `useAccount→useConnection` rename detectado. ADR-008 indexado sem modificar o ADR source. FEEDBACK.md documenta transparentemente os desvios de scope. Seguro para merge.
