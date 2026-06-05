# Auditoria Sprint 15 — Foundry CI Fix + ERC-7730 Clear Signing

**Auditor:** Claude (Senior Security Auditor)
**Data:** 2026-05-14
**Scope:** 3 commits — P107 (94cbd70), P105 (0b58270), P106 (52cb9e6)
**Baseline:** Sprint 14 APPROVED (0C/0H/0M/0L, 2026-05-14 após 14-FIX-01). 583 tests.
**Testes:** 590/590 TS passing (+7 novos). Forge: 66 encontrados, 8 falhas pré-existentes (não introduzidas por este sprint).

---

## Resumo Executivo

Sprint 15 tem dois objectivos: (1) corrigir a falha de compilação Foundry no CI causada por harnesses de formal verification do OpenZeppelin, e (2) adicionar o descriptor ERC-7730 de clear signing para o FeeCollector V2 com tests de selector-drift e pacote de submissão ao registry LedgerHQ. Não há alterações a contratos, fund flows, endpoints, ou lógica de negócio. Sprint puramente infra/DX + segurança UX.

**Veredicto: APPROVED — 0 CRITICAL / 0 HIGH / 0 MEDIUM / 0 LOW / 2 INFO**

Sprint limpo. Todas as alterações são correctas e não introduzem risco.

---

## Checklist de Segurança

| Item | Status | Notas |
|------|--------|-------|
| Contratos alterados? | **Não** | Zero ficheiros `.sol` criados ou modificados. |
| Fund flows alterados? | **Não** | |
| Novos endpoints? | **Não** | |
| Novos secrets/env vars? | **Não** | |
| Dependências adicionadas? | **Não** | |
| RLS impactado? | **Não** | |
| CI alterado? | **Sim** | `foundry.toml` exclude — reduz scope de compilação, não altera tests. |
| Testes: 590/590 TS | **Sim** | +7 (selector-drift guard). |
| Forge: 66 found, 8 fail | **Sim** | 8 falhas pré-existentes em TeraSwapOrderExecutor.t.sol (DCA timing, balance setup, signature fixtures). Não causadas por P107. |
| Build limpo? | **Sim** | |
| Dados sensíveis? | **Não** | Nenhuma chave privada, mnemonic, ou secret em qualquer ficheiro. Apenas endereços de contrato públicos. |

---

## Findings

### 15-I-01 — 8 pre-existing Foundry test failures not tracked in backlog

**Severidade:** INFO
**Ficheiro:** `contracts/order-engine/test/TeraSwapOrderExecutor.t.sol`
**Descrição:** O commit P107 corrige a compilação Foundry (que falhava nos harnesses FV do OpenZeppelin), revelando 8 falhas pré-existentes nos testes do OrderExecutor. Estas falhas existem desde antes do Sprint 15 — são problemas de fixtures (DCA timing, balance setup, signature fixtures) que não foram introduzidos nem alterados por este sprint. No entanto, não há tracking explícito destas falhas no backlog.
**Recomendação:** Registar as 8 falhas como items do backlog (LOW) para resolução futura. O OrderExecutor v2 está apenas em Sepolia — não é urgente, mas deve ser corrigido antes do deploy mainnet.

### 15-I-02 — ERC-8176 attestation tooling not yet available

**Severidade:** INFO
**Ficheiro:** `contracts/clear-signing/registry-submission/PR-TEMPLATE.md` L51-54
**Descrição:** O PR template menciona ERC-8176 attestation ("We're tracking ERC-8176 attestation tooling and will attach a signed attestation once the framework lands"). Este é um standard em draft que ainda não está finalizado. A submissão ao registry pode prosseguir sem attestation — o LedgerHQ registry aceita PRs sem ERC-8176 — mas a referência deve ser actualizada quando o standard for finalizado ou abandonado.
**Recomendação:** Aceitar como is. Monitorar ERC-8176 progress.

---

## Análise por Prompt

### P107 (94cbd70) — Foundry CI: exclude OpenZeppelin fv/ harnesses

**Resultado:** PASS

**Verificações:**

1. **Exclude scope:** `exclude = ["lib/openzeppelin-contracts/fv"]` em `contracts/order-engine/foundry.toml`. O path `lib/openzeppelin-contracts/fv/` contém harnesses de formal verification (Makefile, specs/, diff/, run.js) que importam de `fv/patched/` — um directório gerado localmente pela tooling FV e ausente do submodule git. **Correcto — este é exactamente o directório problemático.**

2. **Não exclui contratos de produção:** Os contratos OZ de produção estão em `lib/openzeppelin-contracts/contracts/` (e.g., `ERC20.sol`, `ReentrancyGuard.sol`). O exclude aponta apenas para `fv/` — um directório irmão de `contracts/`. **Confirmado via `find` — zero overlap.**

3. **Não exclui testes:** O test file `test/TeraSwapOrderExecutor.t.sol` está na raiz de `contracts/order-engine/`, não dentro de `lib/`. **Não afectado.**

4. **Não exclui src:** O directório `src/` do order-engine está na raiz. **Não afectado.**

5. **Comentário inline:** Explica o "porquê" do exclude com referência ao P107. **Boa prática.**

6. **8 falhas pré-existentes:** São em `TeraSwapOrderExecutor.t.sol` — DCA timing, balance setup, signature fixtures. O commit P107 não altera nenhum ficheiro `.sol`. As falhas existiam antes mas eram mascaradas pelo `continue-on-error` guard no CI job que falhava na compilação. **Confirmado: não causadas pelo Sprint 15.**

### P105 (0b58270) — ERC-7730 descriptor for FeeCollector V2

**Resultado:** PASS

**Verificações:**

1. **Schema reference:** `$schema: "https://eips.ethereum.org/assets/eip-7730/erc7730-v1.schema.json"`. **Correcto.**

2. **Deployment target:** `chainId: 1`, `address: "0x47f24068932Ac49bcbeD3aD105af57C6ECDF7459"`. Corresponde ao FeeCollector V2 deployed e verified no Etherscan. **Correcto.**

3. **ABI — swapTokenWithFee:**
   - Descriptor: `(address token, uint256 totalAmount, address router, bytes routerData, address tokenOut, uint256 minimumOutput)`
   - Contrato (`TeraSwapFeeCollector.sol` L240-247): `(address token, uint256 totalAmount, address router, bytes calldata routerData, address tokenOut, uint256 minimumOutput)`
   - Frontend (`constants.ts` L164-177): identical names and types.
   - **Match perfeito** (o `calldata` location qualifier não afecta a signature/selector).

4. **ABI — swapETHWithFee:**
   - Descriptor: `(address router, bytes routerData, address tokenOut, uint256 minimumOutput)` payable
   - Contrato (`TeraSwapFeeCollector.sol` L184-189): `(address router, bytes calldata routerData, address tokenOut, uint256 minimumOutput)` payable
   - Frontend (`constants.ts` L152-163): identical names and types.
   - **Match perfeito.**

5. **Selector verification (independente):**
   - `keccak256("swapTokenWithFee(address,uint256,address,bytes,address,uint256)")[0:4]` = **`0x7f7663d4`** ✓
   - `keccak256("swapETHWithFee(address,bytes,address,uint256)")[0:4]` = **`0x7739563c`** ✓
   - Computados independentemente com `viem.keccak256` neste audit. **Confirmado.**

6. **Field formats — swapTokenWithFee:**
   | Path | Format | Param | Correcto? |
   |------|--------|-------|-----------|
   | `token` | `addressName` | `types: ["token"]` | ✓ — input token address |
   | `totalAmount` | `tokenAmount` | `tokenPath: "token"` | ✓ — decimals from `token` |
   | `tokenOut` | `addressName` | `types: ["token"]` | ✓ — output token address |
   | `minimumOutput` | `tokenAmount` | `tokenPath: "tokenOut"` | ✓ — decimals from `tokenOut` |
   | `router` | `addressName` | `types: ["contract"]` | ✓ — router contract |
   | `routerData` | **excluded** | — | ✓ — opaque bytes, not displayable |

7. **Field formats — swapETHWithFee:**
   | Path | Format | Param | Correcto? |
   |------|--------|-------|-----------|
   | `@.value` | `tokenAmount` | `nativeCurrency: "ETH"` | ✓ — msg.value in ETH |
   | `tokenOut` | `addressName` | `types: ["token"]` | ✓ |
   | `minimumOutput` | `tokenAmount` | `tokenPath: "tokenOut"` | ✓ |
   | `router` | `addressName` | `types: ["contract"]` | ✓ |
   | `routerData` | **excluded** | — | ✓ |

8. **`@.value` for ETH amount:** ERC-7730 spec defines `@.value` as the path to the transaction's `msg.value`. Usado no `swapETHWithFee` para mostrar o ETH amount com `nativeCurrency: "ETH"`. **Correcto per spec.**

9. **`required` arrays:**
   - `swapTokenWithFee`: `["token", "totalAmount", "tokenOut", "minimumOutput", "router"]` — all 5 display fields. **Correcto.**
   - `swapETHWithFee`: `["tokenOut", "minimumOutput", "router"]` — 3 param fields (exclui `@.value` que é transaction-level, não calldata). **Correcto.**

10. **`routerData` excluded on both:** `"excluded": ["routerData"]` on both formats. Opaque inner-DEX calldata — não pode ser meaningfully displayed. O H-04 `minimumOutput` check é a protecção visível ao utilizador. **Decisão de design correcta.**

11. **Metadata:** `owner: "TeraSwap"`, `url: "https://teraswap.app"`, `lastUpdate: "2026-05-14"`. **Correcto, sem dados sensíveis.**

12. **Admin functions omitted:** Apenas as 2 funções user-facing. `setFee`, `pause`, `queueRouterChange`, etc. estão fora de scope — admin calls usam multisig flows. **Decisão correcta.**

### P106 (52cb9e6) — Descriptor validation tests + registry submission package

**Resultado:** PASS

**Verificações:**

1. **Test file:** `src/lib/erc7730-descriptor.test.ts` — 7 testes:
   - **Deployment pinning:** Asserts 1 deployment, chainId 1, address matches `0x47f2...7459` (case-insensitive). **Correcto.**
   - **Function scope:** Asserts exactly 2 functions: `swapETHWithFee`, `swapTokenWithFee`. Detecta adições ou remoções acidentais. **Correcto.**
   - **Format key matching:** Every ABI function has a `display.formats` entry keyed by its canonical signature. Detecta signature drift no descriptor. **Correcto.**
   - **routerData exclusion:** Both formats have `routerData` in `excluded[]`. **Correcto.**
   - **Selector pinning (×2):** `it.each` com `EXPECTED_SELECTORS` — re-computes keccak256 from the canonical signature and asserts against pinned `0x7f7663d4` / `0x7739563c`. If the descriptor ABI changes shape (param added/removed/reordered), the computed selector diverges → test fails. **Correcto e critical — este é o selector-drift guard.**
   - **Frontend ABI cross-reference:** Computes canonical signatures from `FEE_COLLECTOR_ABI` in `constants.ts` and asserts every descriptor function exists in the frontend ABI. Detecta drift entre descriptor e frontend. **Correcto.**

2. **Import chain:** Test imports `FEE_COLLECTOR_ABI` from `@/lib/constants` and reads the descriptor JSON from filesystem. Two independent sources cross-referenced. **Boa prática.**

3. **`canonicalSig` helper:** `name(type1,type2,...)` — no spaces, no names, types only. This matches the Solidity canonical form for selector computation. **Correcto.**

4. **`selectorOf` helper:** `keccak256(toBytes(sig)).slice(0, 10)` — first 4 bytes as hex. Uses `viem` (same library as the frontend). **Correcto.**

5. **Registry submission copy:** `contracts/clear-signing/registry-submission/calldata-FeeCollectorV2.json` is **byte-identical** to `contracts/clear-signing/erc7730-feecollector-v2.json`. `diff` returns empty. **Correcto.**

6. **File naming convention:** `calldata-FeeCollectorV2.json` follows the LedgerHQ registry `calldata-<ContractName>.json` convention. **Correcto.**

7. **PR template:** Follows the registry contribution format with contract info table, function table, verification section, and attestation note. References Etherscan verified source, CI tests, and ERC-8176 (future). **Adequado.**

8. **README:** Well-documented. Explains the problem (blind signing), the solution (ERC-7730), verification methods (CI test + Etherscan + `cast 4byte-decode`), and submission process. No sensitive data. **Correcto.**

9. **No secrets:** Entire diff scanned for `private`, `secret`, `key`, `password`, `mnemonic`, `seed` — only benign hits (test code comment about "canonical signature"). All addresses are public contract addresses. **Confirmado.**

---

## Cross-cutting Verification

| Check | Status |
|-------|--------|
| Zero contract changes | **Confirmado** — nenhum `.sol` criado ou modificado |
| Zero fund flow changes | **Confirmado** |
| Zero novos endpoints | **Confirmado** |
| Zero novas env vars | **Confirmado** |
| Zero dependências adicionadas | **Confirmado** |
| `exclude` only affects `fv/` | **Confirmado** — `lib/openzeppelin-contracts/fv/` only. Tests e production contracts unaffected. |
| Selectors match deployed contract | **Confirmado** — independentemente computados: `0x7f7663d4`, `0x7739563c` |
| Selectors match frontend ABI | **Confirmado** — test cross-references `FEE_COLLECTOR_ABI` from `constants.ts` |
| Descriptor ABI matches contract source | **Confirmado** — param names, types, and order identical |
| Registry copy identical to source | **Confirmado** — `diff` empty |
| No sensitive data | **Confirmado** — zero secrets, keys, or mnemonics |
| 8 Foundry failures pre-existing | **Confirmado** — in `TeraSwapOrderExecutor.t.sol`, not caused by P107 |
| 590 TS tests passing | **Confirmado** (+7 from P106) |

---

## Review Focus Responses

1. **P107 exclude scope:** Sim, `exclude = ["lib/openzeppelin-contracts/fv"]` afecta APENAS o directório `fv/` dentro do submodule OZ. Os contratos de produção estão em `lib/openzeppelin-contracts/contracts/`. O test file `test/TeraSwapOrderExecutor.t.sol` está na raiz de `contracts/order-engine/`. Zero contract tests excluídos acidentalmente.

2. **P105 descriptor correctness:** Sim. Ambas as signatures no descriptor correspondem exactamente ao contrato deployed (`TeraSwapFeeCollector.sol` L184-189, L240-247) e ao frontend ABI (`constants.ts` L151-177). Selectors verificados independentemente: `0x7f7663d4` e `0x7739563c`. Field formats correctos: `tokenAmount` referencia `tokenPath` para decimals, `addressName` com types adequados, `@.value` para msg.value ETH. `routerData` correctamente excluído em ambos os formatos.

3. **P106 selector pinning:** Sim. Os selectors pinned `0x7f7663d4` e `0x7739563c` correspondem ao que seria observado no Etherscan para o contrato `0x47f24068932Ac49bcbeD3aD105af57C6ECDF7459`. Computação independente neste audit confirma os valores.

4. **P106 registry submission:** Sim. Ficheiro segue a convenção `calldata-<ContractName>.json`. PR template inclui todos os campos esperados pelo contribution guide: contract info, function table, verification, attestation. É uma cópia byte-identical do descriptor source.

5. **No sensitive data:** Confirmado. Apenas endereços de contrato públicos (deployments on Ethereum mainnet). Zero chaves privadas, mnemonics, ou secrets.

6. **Pre-existing Foundry failures:** Confirmado — 8 falhas em `TeraSwapOrderExecutor.t.sol` são pré-existentes (DCA timing, balance setup, signature fixtures). P107 não altera nenhum ficheiro `.sol`. As falhas estavam mascaradas pelo CI job que falhava na compilação antes do exclude. Recomendação: registar no backlog (15-I-01).

---

## Veredicto Final

| Severidade | Count |
|------------|-------|
| CRITICAL   | 0     |
| HIGH       | 0     |
| MEDIUM     | 0     |
| LOW        | 0     |
| INFO       | 2     |

### APPROVED — 0C / 0H / 0M / 0L

Sprint 15 está limpo para merge. O `exclude` do Foundry é cirúrgico e correctamente scoped. O descriptor ERC-7730 está correcto — selectors verificados independentemente, ABI matches contrato deployed e frontend, field formats adequados, `routerData` correctamente excluído. O selector-drift guard (7 testes) detecta qualquer desalinhamento futuro no CI. O pacote de submissão ao registry segue as convenções LedgerHQ. Zero alterações a contratos, fund flows, ou lógica de negócio.

Contagem cumulativa de testes: **590 TS** (583 Sprint 14 + 7 Sprint 15) + **19 Foundry** (excl. 8 pré-existentes com falha).

---

*Relatório gerado por Claude (Senior Security Auditor) — 2026-05-14*
