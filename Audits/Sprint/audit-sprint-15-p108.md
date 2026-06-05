# Auditoria P108 — ERC-7730 v1→v2 Descriptor Migration

**Auditor:** Claude (Senior Security Auditor)
**Data:** 2026-05-14
**Scope:** 1 commit — P108 (e2e9368)
**Baseline:** Sprint 15 APPROVED (0C/0H/0M/0L/2I, 2026-05-14). 590 tests (pre-P108, P105/P106/P107).
**Testes:** 608/608 passing (+18 desde Sprint 15 baseline, +0 novos neste commit — testes P106 actualizados, não adicionados)

---

## Resumo Executivo

P108 migra o descriptor ERC-7730 do FeeCollector V2 de v1 para v2 schema, conforme exigido pelo CI do registry LedgerHQ. Migração correcta: `excluded`/`required` removidos, `routerData` declarado com `"visible": "never"`, `nativeCurrencyAddress` substitui `nativeCurrency`, `metadata.contractName` adicionado, campos v1-only (`legalName`, `lastUpdate`) removidos. Ficheiro de test fixtures adicionado. ABI e selectors inalterados. `erc7730 lint` passou com 0 erros.

**Veredicto: APPROVED — 0 CRITICAL / 0 HIGH / 0 MEDIUM / 0 LOW / 2 INFO**

Descriptor pronto para submissão ao registry.

---

## Checklist de Segurança

| Item | Status | Notas |
|------|--------|-------|
| Contratos alterados? | **Não** | |
| Fund flows alterados? | **Não** | |
| ABI alterado? | **Não** | Idêntico a v1. Selectors verificados: `0x7f7663d4`, `0x7739563c`. |
| Novos endpoints? | **Não** | |
| Novos secrets/env vars? | **Não** | |
| Dependências adicionadas? | **Não** | |
| Dados sensíveis? | **Não** | Apenas endereços de contrato públicos (Etherscan-verified). |
| Testes: 608/608 | **Sim** | 7 selector-drift tests actualizados para v2 shape. |
| Build limpo? | **Sim** | `npx tsc --noEmit` clean. |
| Lint externo? | **Sim** | `erc7730 lint --skip-abi-validation` → 0 errors. |

---

## Findings

### P108-I-01 — Test fixture rawTx uses placeholder txHash

**Severidade:** INFO
**Ficheiro:** `contracts/clear-signing/registry-submission/tests/calldata-TeraSwapFeeCollector.tests.json`
**Descrição:** O `txHash` no test fixture é `0x0000...0000` (placeholder). O `rawTx` é ABI-encoded correctamente (selector `0x7f7663d4` + USDC/1inch/WETH/0.1ETH), mas o hash zero não corresponde a uma transacção real. O README e o description do fixture documentam explicitamente que deve ser substituído antes do PR ao registry. O registry CI pode ou não validar o txHash — depende da implementação.
**Recomendação:** Substituir com o txHash do primeiro swap real via FeeCollector V2 em mainnet antes de submeter o PR. Documentação existente já cobre isto — nenhuma acção adicional necessária.

### P108-I-02 — `$schema` uses registry-relative path

**Severidade:** INFO
**Ficheiros:** `erc7730-feecollector-v2.json` L1, `calldata-TeraSwapFeeCollector.json` L1
**Descrição:** `"$schema": "../../specs/erc7730-v2.schema.json"` é um path relativo que assume a estrutura de directórios do registry LedgerHQ (`registry/teraswap/` → `../../specs/`). No repo TeraSwap, este path não resolve (não existe `specs/` two levels up). Isto é intencional — o descriptor é desenhado para ser validado dentro do fork do registry, não no repo TeraSwap directamente. O teste CI no TeraSwap valida via `erc7730-descriptor.test.ts` (que lê o JSON e verifica fields), não via JSON Schema validation.
**Recomendação:** Aceitar como is. Documentar no README que o `$schema` resolve dentro do fork do registry (já implícito no README section "erc7730 lint").

---

## Análise Detalhada

### 1. Schema Compliance

| Aspecto v2 | Status | Verificação |
|------------|--------|-------------|
| `$schema` → v2 | ✓ | `../../specs/erc7730-v2.schema.json` (registry-relative) |
| `excluded` array removido | ✓ | Zero ocorrências em ambos os formatos |
| `required` array removido | ✓ | Zero ocorrências em ambos os formatos |
| `routerData` com `visible: "never"` | ✓ | Presente em ambos os formatos (L85-89, L125-129) |
| `metadata.contractName` | ✓ | `"TeraSwapFeeCollector"` (L44) |
| `legalName` removido | ✓ | Não presente em metadata.info |
| `lastUpdate` removido | ✓ | Não presente em metadata.info |
| `erc7730 lint` → 0 errors | ✓ | Confirmado pelo commit message (erc7730 1.0.6) |

### 2. Selector Integrity — CRITICAL CHECK

**Verificação independente** (computada neste audit via `viem.keccak256`):

| Function | Selector | Match |
|----------|----------|-------|
| `swapTokenWithFee(address,uint256,address,bytes,address,uint256)` | `0x7f7663d4` | ✓ |
| `swapETHWithFee(address,bytes,address,uint256)` | `0x7739563c` | ✓ |

**ABI comparison v1→v2:** A secção `context.contract.abi` é **byte-identical** entre v1 e v2. Ambas as funções mantêm os mesmos nomes, tipos, e ordem de parâmetros. **Zero drift.**

**Selector-drift tests:** Os 2 `it.each` tests pinam `0x7f7663d4` e `0x7739563c` e re-computam via `keccak256`. **Inalterados.** O cross-reference com `FEE_COLLECTOR_ABI` do frontend continua activo.

### 3. Field Mapping Correctness

**`swapTokenWithFee`:**

| Path | Format | Params | v1→v2 Change | Correcto? |
|------|--------|--------|--------------|-----------|
| `token` | `addressName` | `types: ["token"]` | Unchanged | ✓ |
| `totalAmount` | `tokenAmount` | `tokenPath: "token"` | Unchanged | ✓ |
| `tokenOut` | `addressName` | `types: ["token"]` | Unchanged | ✓ |
| `minimumOutput` | `tokenAmount` | `tokenPath: "tokenOut"` | Unchanged | ✓ |
| `router` | `addressName` | `types: ["contract"]` | Unchanged | ✓ |
| `routerData` | `raw` | — | **NEW** (was `excluded`) | ✓ — `visible: "never"` hides it |

**`swapETHWithFee`:**

| Path | Format | Params | v1→v2 Change | Correcto? |
|------|--------|--------|--------------|-----------|
| `@.value` | `tokenAmount` | `nativeCurrencyAddress: [0xEeee..., 0x0000...]` | **CHANGED** from `nativeCurrency: "ETH"` | ✓ |
| `tokenOut` | `addressName` | `types: ["token"]` | Unchanged | ✓ |
| `minimumOutput` | `tokenAmount` | `tokenPath: "tokenOut"` | Unchanged | ✓ |
| `router` | `addressName` | `types: ["contract"]` | Unchanged | ✓ |
| `routerData` | `raw` | — | **NEW** (was `excluded`) | ✓ — `visible: "never"` |

**`nativeCurrencyAddress` convention:** O v2 schema usa um array de endereços que representam ETH nativamente:
- `0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE` — Placeholder address usado por 1inch, Kyberswap, e a maioria dos DEX aggregators para representar ETH nativamente.
- `0x0000000000000000000000000000000000000000` — Zero address, usado por alguns protocols como representação alternativa de ETH.

Este é o padrão observado nos descriptors existentes no registry LedgerHQ. **Correcto.**

### 4. Registry Submission Package

| Check | Status |
|-------|--------|
| File renamed: `calldata-FeeCollectorV2.json` → `calldata-TeraSwapFeeCollector.json` | ✓ — matches `calldata-{ContractName}` com `contractName = "TeraSwapFeeCollector"` |
| Old file removed | ✓ — `calldata-FeeCollectorV2.json` não existe |
| Content synced with main descriptor | ✓ — `diff` retorna vazio |
| Test fixture `$schema` | ✓ — `"../../../specs/erc7730-tests.schema.json"` (registry-relative) |
| Test fixture `tests` array | ✓ — 1 entry com `description`, `rawTx`, `txHash`, `expectedTexts` |
| rawTx selector | ✓ — `0x7f7663d4` (swapTokenWithFee) |
| rawTx ABI encoding | ✓ — decoded: USDC (`0xa0b8...`), 1000 USDC (`1000000000`), 1inch v6 router (`0x1111...`), WETH (`0xc02a...`), 0.1 ETH minimum (`100000000000000000`) |
| rawTx addresses are real mainnet contracts | ✓ — USDC, 1inch v6, WETH verified |
| expectedTexts match intent + field labels | ✓ — `["Swap tokens via TeraSwap", "Input Token", "Amount In", "Output Token", "Minimum Output", "Router"]` |
| txHash placeholder documented | ✓ — description explicitly says "Replace with real mainnet rawTx + txHash" |

### 5. Test Coverage

| Test | Status | v1→v2 Change |
|------|--------|--------------|
| Deployment pinning (chainId 1, address) | ✓ | Unchanged |
| Exactly 2 functions | ✓ | Unchanged |
| Format key = canonical signature | ✓ | Unchanged |
| **routerData hidden** | ✓ | **CHANGED**: was `excluded` check → now `visible: "never"` check |
| Selector pinning ×2 | ✓ | Unchanged |
| Frontend ABI cross-reference | ✓ | Unchanged |
| **Erc7730Descriptor interface** | ✓ | **UPDATED**: `Erc7730Field` added with `visible?: 'never'`, `params?`; `excluded?` and `required?` removed from format type |

**Total:** 7 tests (5 `it()` + 1 `it.each` with 2 entries). 608/608 suite-wide.

### 6. Security — No Sensitive Data

Diff scanned for `private`, `secret`, `key`, `password`, `mnemonic`, `seed`, `deployer` — zero hits. All addresses are public contracts (Etherscan-verified):
- FeeCollector V2: `0x47f24068932Ac49bcbeD3aD105af57C6ECDF7459`
- USDC: `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`
- 1inch v6: `0x111111125421cA6dc452d289314280a0f8842A65`
- WETH: `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2`

### 7. Code Agent Deviation — `params.types` on `addressName` fields

**Review:** O prompt especificava remover `params.types` dos campos `addressName`, alegando que v2 os deprecava. O Code Agent manteve-os e reportou que o `erc7730 lint` v2 **requer** que `addressName` declare `types` (token/contract). O Agent re-added `types` após a falha do lint.

**Verificação:** Os tipos estão semanticamente correctos:
- `token` → `types: ["token"]` — Input token address, resolved contra token lists. ✓
- `tokenOut` → `types: ["token"]` — Output token address. ✓
- `router` → `types: ["contract"]` — Router contract address. ✓

**Veredito:** A deviação está correcta. O prompt continha informação errada sobre a remoção de `types` em v2. O Agent corrigiu com evidência do lint. **Nenhuma acção necessária.**

---

## Cross-cutting Verification

| Check | Status |
|-------|--------|
| Selectors inalterados | **Confirmado** — `0x7f7663d4`, `0x7739563c` verificados independentemente |
| ABI idêntico a v1 | **Confirmado** — zero changes a nomes, tipos, ou ordem de params |
| `excluded`/`required` removidos | **Confirmado** — zero ocorrências |
| `routerData` hidden via `visible: "never"` | **Confirmado** — ambos os formatos |
| `metadata.contractName` presente | **Confirmado** — `"TeraSwapFeeCollector"` |
| `nativeCurrencyAddress` correcta | **Confirmado** — `[0xEeee..., 0x0000...]` |
| Registry copy synced | **Confirmado** — `diff` vazio |
| Test fixture rawTx valid | **Confirmado** — selector + ABI encoding decoded com endereços reais |
| Old file removed | **Confirmado** — `calldata-FeeCollectorV2.json` ausente |
| No sensitive data | **Confirmado** |
| 608 tests passing | **Confirmado** |

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

P108 migra correctamente o descriptor ERC-7730 de v1 para v2. Todos os campos, selectors, e field mappings estão intactos. A deviação do Code Agent (manter `params.types`) está correcta — o lint v2 exige-os. O descriptor está pronto para submissão ao registry LedgerHQ após substituição do txHash placeholder no test fixture.

Contagem cumulativa de testes: **608** (590 Sprint 15 + 18 Sprint 13B on parallel branch).

---

*Relatório gerado por Claude (Senior Security Auditor) — 2026-05-14*
