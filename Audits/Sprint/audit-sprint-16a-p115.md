# Auditoria Sprint 16A — P115 (M-01 Phase 1)

**Auditor:** Claude (Senior Security Auditor)
**Data:** 2026-05-14
**Scope:** 2 commits no branch `fix/sprint-16a-frontend-tests`
**Baseline:** Sprint 16A P109-P114 + Hotfix Quote Flood + UI MEV Disclaimer APPROVED.
**Commits:**
- `fd06fea` — test(hooks): useChainlinkPrice, useQuote, useApproval, useSwap + test-utils infra
- `ca86a0f` — test(components): TransactionPreview, SwapButton, Permit2EducationModal + localStorage polyfill
**Ficheiros:** 13 files, +2522/−1 lines
**Testes:** 86 novos (40 hooks + 46 componentes). Total esperado: ~694 TS.

---

## Resumo Executivo

P115 implementa a Phase 1 dos testes de integração frontend identificados como M-01 na análise externa. O scope cobre os 4 hooks críticos do swap pipeline (`useChainlinkPrice`, `useQuote`, `useApproval`, `useSwap`) e 3 componentes de segurança (`TransactionPreview`, `SwapButton`, `Permit2EducationModal`), totalizando 86 novos testes.

A infra de testing introduz `@testing-library/react` + `jsdom` (devDependencies), um wrapper de render com `ToastProvider`, mocks canónicos para wagmi hooks, e um polyfill `localStorage` para jsdom 29. O `vitest.config.ts` foi expandido para incluir `.test.tsx` files e o `setupFiles` global. **Zero alterações a código de produção.**

Cobertura de segurança verificada: todos os branches de `validateRouterAddress`, `validateCallDataRecipient`, `validateFeeIntegrity`, e `PriceGuardError` estão pinned nos testes de `useSwap`. Cada nível de `PriceCheck` (none/warn/danger) está coberto em `useChainlinkPrice`. O finding HF-L-01 (ausência de testes de backoff) está **CLOSED** — `useQuote.test.ts` tem 4 testes explícitos para 429 backoff, in-flight guard, doFetch identity stability, e recovery on success.

**Veredicto: APPROVED — 0 CRITICAL / 0 HIGH / 0 MEDIUM / 0 LOW / 3 INFO**

Finding externo M-01 (Phase 1) correctamente fechado. Sprint 16A 100% completo.

---

## Checklist de Segurança

| Item | Status | Notas |
|------|--------|-------|
| Contratos alterados? | **Não** | |
| Fund flows alterados? | **Não** | |
| ABI alterado? | **Não** | |
| Novos endpoints? | **Não** | |
| Novos secrets/env vars? | **Não** | |
| Dependências adicionadas? | **Sim** | 5 devDependencies: `@testing-library/{dom,jest-dom,react,user-event}`, `jsdom`. Todas em `devDependencies` — não entram no bundle de produção. |
| Dados sensíveis? | **Não** | Apenas endereços públicos (FeeCollector V2, USDC, WETH). |
| Código de produção alterado? | **Não** | Apenas `vitest.config.ts` (include pattern + setupFiles) + `package.json` (devDeps). |
| Testes: +86 novos | **Sim** | 9+10+12+9 hooks + 15+18+13 componentes = 86 `it()` calls. |
| Build/CI impacto? | **Mínimo** | `.tsx` tests adicionados ao include. `setupFiles` global mas lightweight (jest-dom + cleanup + localStorage polyfill). |

---

## Findings

### 16A-I-08 — localStorage polyfill é global e não faz clear entre testes

**Severidade:** INFO
**Ficheiro:** `src/test-utils/setup.ts` L29-47
**Descrição:** O polyfill `installStoragePolyfill()` instala um `localStorage` in-memory no `globalThis` quando jsdom não fornece um `Storage` funcional. Este polyfill é **global** e persiste entre testes — não há `afterEach(() => localStorage.clear())` no setup global. Ficheiros individuais que usam localStorage (como `Permit2EducationModal.test.tsx`) fazem `localStorage.clear()` no seu `beforeEach`, o que é correcto. Contudo, se um futuro ficheiro de teste escrever em localStorage sem cleanup, pode sofrer contaminação entre testes.
**Recomendação:** Aceitar como is. O padrão actual (cleanup per-file) é suficiente. Um `afterEach(() => localStorage.clear())` global seria mais defensivo mas poderia interferir com testes que intencionalmente testam persistência entre renders.

### 16A-I-09 — useQuote backoff testa comportamento mas não timing exacto

**Severidade:** INFO
**Ficheiro:** `src/hooks/useQuote.test.ts` L171-249
**Descrição:** Os testes HF-L-01 verificam que (1) o erro permanece visível durante backoff, (2) um 200 após 429 limpa o erro e recupera, e (3) erros non-429 não entram em backoff. No entanto, não verificam os intervalos exactos do backoff exponencial (30s → 60s → 120s cap). Isto requereria `vi.useFakeTimers()` com `vi.advanceTimersByTime()`, que conflitua com `@testing-library`'s `waitFor` (comentado no código: "fake timers break @testing-library's waitFor"). O comportamento de gate/recovery está pinned; o timing preciso é verificável apenas via inspecção de código.
**Recomendação:** Aceitar como is. O valor de segurança dos testes está no comportamento (429 enters backoff, success exits), não nos intervalos exactos. Os intervalos são constantes no código (`QUOTE_REFRESH_MS = 15_000`, `MAX_BACKOFF_MS = 120_000`) — se alterados, o impacto seria apenas UX, não segurança.

### 16A-I-10 — `renderWithProviders` re-exporta todo `@testing-library/react` via `export *`

**Severidade:** INFO
**Ficheiro:** `src/test-utils/render.tsx` L43
**Descrição:** `export * from '@testing-library/react'` re-exporta toda a API de `@testing-library/react`, incluindo o `render` original sem providers. Isto significa que ficheiros de teste podem importar tanto `renderWithProviders` como `render` do mesmo módulo — se alguém usar `render` por acidente, não terá o `ToastProvider`. Padrão comum na comunidade Testing Library (documentado no guia oficial), mas levemente confuso.
**Recomendação:** Aceitar como is. A convenção é clara nos ficheiros existentes — componentes que precisam de providers usam `renderWithProviders`, componentes simples usam `render` directamente.

---

## Análise Detalhada — Commit 1: Hooks (fd06fea)

### 1. Infraestrutura de Testes

#### `vitest.config.ts`
- `include` expandido de `['src/**/*.test.ts']` para `['src/**/*.test.ts', 'src/**/*.test.tsx']`. ✓
- `environment` mantido como `'node'` (default rápido). Ficheiros que precisam de DOM declaram `// @vitest-environment jsdom` no topo. ✓ — Abordagem correcta: não penaliza a suite pure-logic com bootstrap jsdom.
- `setupFiles: ['./src/test-utils/setup.ts']` adicionado. ✓

#### `src/test-utils/setup.ts`
- Importa `@testing-library/jest-dom/vitest` — adiciona matchers DOM (`toBeInTheDocument`, etc.). ✓
- `afterEach(() => cleanup())` — limpa DOM entre testes. No-op em testes node-env. ✓
- `installStoragePolyfill()` — cria `localStorage`/`sessionStorage` in-memory quando jsdom não fornece um `Storage` funcional. Verifica `typeof getItem === 'function'` antes de instalar. ✓

**Avaliação polyfill:** O polyfill é defensivo — só instala quando necessário. A interface `Storage` completa é implementada (`length`, `key`, `getItem`, `setItem`, `removeItem`, `clear`). Não interfere com jsdom's native Storage quando este funciona correctamente (guard no início). ✓

#### `src/test-utils/mock-wagmi.ts`
- `makeWagmiMocks(overrides)` — factory que constrói um bundle de mocks wagmi. ✓
- Defaults: connected, mainnet, 1 ETH balance, 20 gwei gas. ✓
- Cada mock é um `vi.fn()` — permite `.mockReturnValueOnce()` per-test. ✓
- Não é usado directamente nos testes actuais (cada test file define os seus mocks inline via `vi.mock('wagmi', ...)`), mas é exportado como canonical shape para futuros testes. ✓

#### `src/test-utils/render.tsx`
- `renderWithProviders(ui, options)` — wraps com `ToastProvider`. ✓
- `toast: true` default — opt-out via `{ toast: false }`. ✓
- WagmiConfig **não** incluído (comentário explica: mocks at import boundary). ✓
- `export * from '@testing-library/react'` — re-export padrão. ✓

### 2. `useChainlinkPrice.test.ts` — 9 testes

| # | Teste | Branch coberto | Status |
|---|-------|---------------|--------|
| 1 | `oracleUnavailable when no feed` | `getChainlinkFeed → null` | ✓ |
| 2 | `level='none' when tokenAddress undefined` | Early return — no token | ✓ |
| 3 | `level='none' within 2%` | `deviation < WARN_THRESHOLD` | ✓ |
| 4 | `level='warn' between 2%-3%` | `WARN_THRESHOLD ≤ deviation < DANGER_THRESHOLD` | ✓ |
| 5 | `level='danger' at/above 3%` | `deviation ≥ DANGER_THRESHOLD` (blocks swap) | ✓ |
| 6 | `stale: updatedAt > 25h` | Timestamp staleness check | ✓ |
| 7 | `stale: answeredInRound < roundId` | Round staleness check | ✓ |
| 8 | `zero/negative answer → invalid` | `answer ≤ 0` guard | ✓ |
| 9 | `no execution price → deviation=0` | Graceful null-executionPrice | ✓ |

**Avaliação de mocks:**
- `useReadContract` branched por `functionName` (latestRoundData vs decimals). Minimal — testa o hook's decision logic, não wagmi's internals. ✓
- `getChainlinkFeed` mocked per-test via `mockReturnValue`. ✓
- `roundData()` helper produz o tuple correcto (5 fields) que `latestRoundData()` retorna. ✓

**Cobertura de segurança:** Todos os branches do price guard estão pinned. O `level='danger'` que bloqueia o swap (H-02 fix) tem um teste explícito com `deviation ≥ 3%`. ✓

### 3. `useQuote.test.ts` — 10 testes

#### Phase 1 (M-01) — 4 testes

| # | Teste | Status |
|---|-------|--------|
| 1 | Fetch once on mount with valid inputs | ✓ |
| 2 | No fetch when `enabled=false` | ✓ |
| 3 | No fetch when amount is zero/empty | ✓ |
| 4 | Error populated on 500 | ✓ |
| 5 | Gasless overlay populated on success | ✓ |

#### HF-L-01 — doFetch stability (2 testes)

| # | Teste | Verifica | Status |
|---|-------|----------|--------|
| 6 | `doFetch identity stable across rerenders` | 5 rerenders → 0 extra fetches. Pre-hotfix, `estimateGasCost` rebuilding caused identity churn → request flood. | ✓ |
| 7 | `in-flight guard` | 3 concurrent `refetch()` while pending → still 1 fetch | ✓ |

#### HF-L-01 — 429 backoff (3 testes)

| # | Teste | Verifica | Status |
|---|-------|----------|--------|
| 8 | `error visible during backoff` | 429 error persists across manual refetch (no null blip) | ✓ |
| 9 | `recovery on 200 after 429` | Error clears, meta populated, backoff resets | ✓ |
| 10 | `non-429 does NOT enter backoff` | 500 error → normal path, next success clears | ✓ |

**Avaliação de mocks:**
- `useDebounce` bypassed (passthrough). ✓ — Permite testes síncronos sem fake timers.
- `analyzeGasless` mocked com retorno estático. ✓ — Testa que o hook integra o resultado, não a lógica do engine.
- `logQuoteToSupabase` mocked como no-op. ✓ — Fire-and-forget analytics.
- `useEthGasCost` mocked com `estimateCallCount` counter — permite verificar que o ref pattern evita chamadas desnecessárias. ✓
- `fetch` mocked per-test via `vi.spyOn(global, 'fetch')` com factory functions `mockFetchSuccess`/`mockFetchStatus`. ✓

**HF-L-01 CLOSED:** Os 3 testes de backoff + 2 testes de stability cobrem exactamente os 3 cenários do finding: (1) identity stability, (2) in-flight guard, (3) 429 exponential backoff com recovery. ✓

### 4. `useApproval.test.ts` — 12 testes

| # | Teste | Branch | Status |
|---|-------|--------|--------|
| 1 | Native ETH → no approval | `isNativeETH` early return | ✓ |
| 2 | No token → null plan | Guard | ✓ |
| 3 | Zero amount → null plan | Guard | ✓ |
| 4 | Empty string → null plan | Guard | ✓ |
| 5 | Invalid amount (NaN) → null | `parseFloat` guard | ✓ |
| 6 | Sufficient direct allowance → skip | `allowance ≥ amount` | ✓ |
| 7 | Insufficient allowance → exact approve | `allowance < amount` | ✓ |
| 8 | Partial allowance → still requires | `allowance > 0 but < amount` | ✓ |
| 9 | Undefined spender → no crash | Defensive guard | ✓ |
| 10 | Idle status on need-approve | State machine initial | ✓ |
| 11 | EIP-2612 nonces() success | Permit detection | ✓ |
| 12 | EIP-2612 nonces() error → fallback | Permit fallback | ✓ |

**Avaliação de mocks:**
- `useReadContract` branched por `functionName` (nonces vs allowance) e por `args[1]` (Permit2 spender vs direct). ✓ — Distingue os dois `allowance()` calls correctamente.
- `useWriteContract` e `useWaitForTransactionReceipt` mocked com stubs. ✓ — Testa planning, não execution (sem wallet sandbox).
- `isPermit2Educated` mocked como `false`. ✓ — O hook always selects `method: 'exact'` em produção.

### 5. `useSwap.test.ts` — 9 testes

| # | Teste | Validator | Status |
|---|-------|-----------|--------|
| 1 | Idle state + no error | Init | ✓ |
| 2 | Truncated calldata (<10) | Length check | ✓ |
| 3 | Oversized calldata (>100KB) | Length check (overflow guard) | ✓ |
| 4 | Unknown selector | `KNOWN_SWAP_SELECTORS` | ✓ |
| 5 | Router not whitelisted | `validateRouterAddress` | ✓ |
| 6 | Recipient mismatch | `validateCallDataRecipient` | ✓ |
| 7 | Fee integrity failure | `validateFeeIntegrity` | ✓ |
| 8 | PriceGuardError (422 + priceGuard:true) | `priceGuardBlocked` + `priceGuardDeviation` | ✓ |
| 9 | `reset()` returns to idle | State reset | ✓ |

**Avaliação de mocks:**
- Validators (`validateRouterAddress`, `validateFeeIntegrity`, `validateCallDataRecipient`) mocked individualmente com `mockReturnValueOnce` per-test. ✓ — Cada teste isola exactamente o gate que quer exercitar, com todos os outros passing by default.
- `KNOWN_SWAP_SELECTORS` importado do módulo real (`vi.importActual`). ✓ — Usa o primeiro selector do set para construir calldata válida.
- `getPrivateClient` mocked com `call: vi.fn(async () => '0x')`. ✓ — Simulation pass-through.
- `swapResponse()` helper com defaults que passam todos os gates. ✓ — Cada teste override apenas o campo sob teste.

**Cobertura de segurança — CRÍTICA:**
- `validateRouterAddress`: rejeitado quando `valid: false` com reason surfaced. ✓
- `validateCallDataRecipient`: rejeitado com `extracted` address visível + reason. ✓ — Protege contra redirect attacks.
- `validateFeeIntegrity`: rejeitado com reason. ✓ — Protege contra fee extraction.
- `PriceGuardError`: `priceGuardBlocked=true`, `priceGuardDeviation` exposto. ✓ — Bloqueia swaps com desvio oracle.
- Selector allowlist: `0xdeadbeef` rejeitado. ✓ — Protege contra arbitrary function calls.

---

## Análise Detalhada — Commit 2: Componentes (ca86a0f)

### 6. `TransactionPreview.test.tsx` — 15 testes

| # | Teste | Branch | Status |
|---|-------|--------|--------|
| 1 | Dialog renders with header + amounts | Base render | ✓ |
| 2 | 'Your wallet' badge | `recipient === userAddress` | ✓ |
| 3 | 'FeeCollector' badge | `recipient === FEE_COLLECTOR_ADDRESS` | ✓ |
| 4 | 'Unknown' badge | `recipient !== user && !== FeeCollector` | ✓ |
| 5 | 'Implicit' badge | `recipient === null` | ✓ |
| 6 | FeeCollector minimumOutput rendered | `routeViaFeeCollector + minimumOutput bigint` | ✓ |
| 7 | Calldata-decoded amountOutMin fallback | Non-FeeCollector path | ✓ |
| 8 | Decode-failure warning | `functionName='unknown'` | ✓ |
| 9 | Gasless chip for CoW | `source='cowswap'` | ✓ |
| 10 | No gasless chip for non-CoW | `source='1inch'` | ✓ |
| 11 | 'Validated selector' chip | `decoded.validated=true` | ✓ |
| 12 | Validation warning text | `decoded.validated=false` | ✓ |
| 13 | onConfirm fires | Button click | ✓ |
| 14 | onCancel fires | Button click | ✓ |
| 15 | Backdrop click → onCancel | Overlay click | ✓ |

**Avaliação de mocks:**
- `decodeTransactionPreview` mocked com `mockDecoded` mutável por teste. ✓ — Controla o decoded output sem craftar calldata real.
- `FEE_COLLECTOR_ADDRESS` mocked via `vi.mock('@/lib/constants')` com o endereço V2 real. ✓ — Garante que o badge branch funciona com o endereço correcto.
- Locale-safe assertions (`/0[.,]42\s*ETH/`) para minimumOutput rendering. ✓ — Funciona em locales com vírgula ou ponto decimal.

**Cobertura de segurança:**
- Recipient badge differentiação (4 branches) é security-critical — utilizadores precisam de saber para onde os funds vão. ✓
- FeeCollector minimumOutput rendering com "Enforced on-chain" chip. ✓
- Decode-failure warning (ainda permite signing mas avisa). ✓

### 7. `SwapButton.test.tsx` — 18 testes

| # | Teste | CTA State | Status |
|---|-------|-----------|--------|
| 1 | Connect Wallet (disconnected) | `!isConnected` | ✓ |
| 2 | Switch to Ethereum (wrong chain) | `chainId !== 1` | ✓ |
| 3 | Connect Wallet click → modal | Handler | ✓ |
| 4 | Switch chain click → switchChain(1) | Handler | ✓ |
| 5 | Enter amount (disabled) | `!hasAmount` | ✓ |
| 6 | Insufficient balance (disabled) | `!hasSufficientBalance` | ✓ |
| 7 | Finding best route (disabled) | `quoteLoading` | ✓ |
| 8 | No quotes available (disabled) | `!hasQuote` | ✓ |
| 9 | Price blocked danger (disabled) | `priceBlocked + danger` | ✓ |
| 10 | Price blocked oracle (disabled) | `priceBlocked + oracle` | ✓ |
| 11 | Approve & Swap (enabled) | `!approvalReady` | ✓ |
| 12 | Approve click → onApprove | Handler | ✓ |
| 13 | Swap (enabled) | Ready state | ✓ |
| 14 | Swap click → onSwap | Handler | ✓ |
| 15 | Error retry (enabled) | `swapStatus='error'` | ✓ |
| 16 | CoW stepper | `cow_signing` | ✓ |
| 17 | Approve→swap stepper | `approving_permit2` | ✓ |
| 18 | Exact approval disclaimer | `!approvalReady` | ✓ |

**Avaliação de mocks:**
- Wagmi mocks (`useAccount`, `useSwitchChain`) com variáveis mutáveis (`mockIsConnected`, `mockChainId`). ✓
- RainbowKit `useConnectModal` mock com `mockOpenConnectModal`. ✓
- `playTouchMP3` no-op. ✓
- Props-driven: cada teste configura o `baseProps` com override. ✓ — Testa renderização, não lógica interna.

**Cobertura de segurança:**
- Price blocked states (danger + oracle) correctamente disabled. ✓
- "Exact approval only" disclaimer visível quando approval é necessário. ✓
- CoW stepper com "Solver fills" text. ✓

### 8. `Permit2EducationModal.test.tsx` — 13 testes

| # | Teste | Branch | Status |
|---|-------|--------|--------|
| 1 | Nothing rendered when `open=false` | Conditional render | ✓ |
| 2 | Dialog rendered when `open=true` | Mount | ✓ |
| 3 | Amount + tokenSymbol row | Optional props | ✓ |
| 4 | Escape → onCancel | Key handler | ✓ |
| 5 | Backdrop click → onCancel | Click handler | ✓ |
| 6 | Dialog click does NOT fire onCancel | stopPropagation | ✓ |
| 7 | Continue → onConfirm | Button click | ✓ |
| 8 | Cancel button → onCancel | Button click | ✓ |
| 9 | "Don't show again" + confirm → localStorage | Persistence | ✓ |
| 10 | Unchecked → no localStorage write | Guard | ✓ |
| 11 | `isPermit2Educated()` reads flag | Reader function | ✓ |
| 12 | Focus on Cancel on open | Focus trap entry | ✓ |
| 13 | Keydown listener removed on close | Cleanup | ✓ |

**Avaliação de mocks:**
- Nenhum mock wagmi necessário — componente pure UI. ✓
- `localStorage.clear()` em `beforeEach`. ✓ — Isolamento entre testes.
- `userEvent.setup()` usado para clicks (mais realista que `fireEvent.click`). ✓

**Cobertura de segurança:**
- "Don't show again" only persists when checkbox checked + confirmed (not just checkbox). ✓ — Previne skip acidental.
- `isPermit2Educated()` correctamente lê a flag. ✓
- Focus trap entry point pinned. ✓
- Keydown cleanup verificado (no phantom Escape after unmount). ✓

---

## Cross-cutting Verification

| Check | Status |
|-------|--------|
| Zero alterações a código de produção | **Confirmado** — diff contains only `.test.ts(x)`, `test-utils/`, `vitest.config.ts`, `package.json` |
| 86 novos testes (40 hooks + 46 componentes) | **Confirmado** — 9+10+12+9 + 15+18+13 = 86 `it()` calls |
| Todas as novas dependências em `devDependencies` | **Confirmado** — `@testing-library/*`, `jsdom` |
| `vitest.config.ts`: `.tsx` pattern + setupFiles | **Confirmado** — sem alteração a environment default (`node`) |
| localStorage polyfill: guard antes de instalar | **Confirmado** — `typeof getItem === 'function'` check |
| localStorage polyfill: Storage interface completa | **Confirmado** — length, key, getItem, setItem, removeItem, clear |
| Permit2 tests: `localStorage.clear()` em beforeEach | **Confirmado** |
| HF-L-01: doFetch identity stability | **Confirmado** — 5 rerenders → 0 extra fetches |
| HF-L-01: in-flight guard | **Confirmado** — 3 concurrent refetch → 1 fetch |
| HF-L-01: 429 backoff → error persists | **Confirmado** |
| HF-L-01: 200 after 429 → recovery | **Confirmado** |
| HF-L-01: non-429 → normal path | **Confirmado** |
| useChainlinkPrice: todos os PriceCheck levels | **Confirmado** — none, warn, danger, stale, invalid, oracleUnavailable |
| useSwap: validateRouterAddress | **Confirmado** — blocked with reason surfaced |
| useSwap: validateCallDataRecipient | **Confirmado** — mismatch blocked |
| useSwap: validateFeeIntegrity | **Confirmado** — failure blocked |
| useSwap: PriceGuardError | **Confirmado** — priceGuardBlocked=true + deviation |
| useSwap: selector allowlist | **Confirmado** — `0xdeadbeef` rejected |
| useSwap: calldata length guards | **Confirmado** — too short + too long |
| TransactionPreview: 4 recipient badge branches | **Confirmado** — user/FeeCollector/unknown/implicit |
| TransactionPreview: FeeCollector minimumOutput | **Confirmado** — bigint → human-readable |
| TransactionPreview: decode-failure warning | **Confirmado** |
| SwapButton: price-blocked disabled states | **Confirmado** — danger + oracle |
| Permit2: localStorage persistence + guard | **Confirmado** — only on checkbox + confirm |
| Permit2: focus trap + cleanup | **Confirmado** |
| Mocks minimal — assertions test behaviour not implementation | **Confirmado** |
| Nenhum dado sensível no diff | **Confirmado** |

---

## Avaliação de Qualidade dos Mocks

Os mocks seguem boas práticas:

1. **Wagmi hooks mocked at import boundary** (vi.mock factory, not runtime patch). ✓
2. **Per-test override via module-scope variables** (`mockRoundData`, `mockIsConnected`, etc.) instead of global state mutation. ✓
3. **Validators mocked individually** — cada teste isola exactamente o gate sob teste, com todos os outros passing by default. ✓
4. **No testing of implementation details** — assertions verificam output do hook (state, error message, flag) e não internals (como quantas vezes um setter foi chamado). ✓
5. **Factory helpers** (`roundData()`, `swapResponse()`, `mockFetchSuccess()`) reduzem boilerplate sem esconder o setup. ✓
6. **`vi.importActual` para módulos parciais** — `KNOWN_SWAP_SELECTORS` importado do real, validators substituídos. ✓

**Excepção aceitável:** `useDebounce` bypassed para evitar fake timers. Isto é standard na comunidade Testing Library e documentado no código. ✓

---

## Veredicto Final

| Severidade | Count |
|------------|-------|
| CRITICAL   | 0     |
| HIGH       | 0     |
| MEDIUM     | 0     |
| LOW        | 0     |
| INFO       | 3     |

### APPROVED — 0C / 0H / 0M / 0L

P115 fecha correctamente M-01 Phase 1 com 86 testes de integração frontend cobrindo os 4 hooks críticos do swap pipeline e 3 componentes de segurança. Zero alterações a código de produção. Infraestrutura de testing bem arquitectada com mocks minimais, cleanup adequado, e polyfill defensivo.

Finding externo M-01 (Phase 1): **CLOSED**.
Finding interno HF-L-01 (backoff tests): **CLOSED**.

**Sprint 16A está 100% completo.**

| Prompt | Finding | Status |
|--------|---------|--------|
| P109 | M-05 | ✅ CLOSED |
| P110 | M-04 | ✅ CLOSED |
| P111 | 14-I-02 | ✅ CLOSED |
| P113 | 15-I-01 | ✅ CLOSED |
| P112 | M-02 | ✅ CLOSED |
| P114 | M-03 | ✅ CLOSED |
| P115 | M-01 (Phase 1) | ✅ CLOSED |
| Hotfix | quote-flood | ✅ APPROVED |
| Hotfix | HF-L-01 | ✅ CLOSED |
| Hotfix UI | MEV disclaimer | ✅ APPROVED |

---

*Relatório gerado por Claude (Senior Security Auditor) — 2026-05-14*
