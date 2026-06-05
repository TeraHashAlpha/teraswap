# Auditoria Sprint 13B — Personal Analytics Dashboard

**Auditor:** Claude (Senior Security Auditor)
**Data:** 2026-05-14
**Scope:** 3 commits — P98 (ba56af5), P99 (fc96134), P100 (89bfcf2)
**Baseline:** Sprint 13A APPROVED (0C/0H/0M/2L, 2026-05-13). 550 tests (branch base pre-Sprint 14/15).
**Testes:** 568/568 passing (+18 novos)

---

## Resumo Executivo

Sprint 13B adiciona um dashboard de analytics pessoal por-wallet: aggregation server-side com caching KV, 4 KPI cards com source win-rates e timing insights, e CSV export para import em tax software. Não há alterações a contratos, fund flows, ou endpoints de swap existentes. O sprint segue o padrão de acesso existente (unauthenticated wallet parameter + service-role Supabase).

Dois LOW findings: (1) o CSV export não sanitiza prefixos de fórmula (`=`, `+`, `-`, `@`) — tokens scam com símbolos como `=DROP` executariam como fórmulas no Excel; (2) o comentário da rota falsamente afirma que RLS é a autoridade de acesso quando o service-role key a bypassa. Um MEDIUM-scope issue: a inconsistência de fetch entre analytics (client-filter) e export (Supabase-filter) desperdiça largura de banda.

**Veredicto: APPROVED — 0 CRITICAL / 0 HIGH / 0 MEDIUM / 2 LOW / 2 INFO**

---

## Checklist de Segurança

| Item | Status | Notas |
|------|--------|-------|
| Contratos alterados? | **Não** | |
| Fund flows alterados? | **Não** | |
| Novos endpoints? | **Sim** | `/api/analytics/personal` (GET), `/api/analytics/export` (GET), `/analytics` page |
| Novos secrets/env vars? | **Não** | Usa SUPABASE_SERVICE_ROLE_KEY existente + Upstash KV existente |
| Dependências adicionadas? | **Não** | |
| RLS impactado? | **Não** | Endpoints usam service-role (bypasses RLS) — padrão existente |
| CI alterado? | **Não** | |
| Testes: 568/568 | **Sim** | +10 (aggregation) + 8 (CSV export) = +18 novos |
| Build limpo? | **Sim** | |

---

## Findings

### 13B-L-01 — CSV formula injection via unsanitised cell prefixes

**Severidade:** LOW
**Ficheiro:** `src/app/api/analytics/export/route.ts` L61-68 (`csvEscape`)
**Descrição:**

A função `csvEscape` wrapa valores com `,`, `"`, `\r`, `\n` em double-quotes por RFC-4180, mas **não sanitiza prefixos que activam fórmulas** em spreadsheet software: `=`, `+`, `-`, `@`, `\t`, `\r`.

Exemplos de passthrough não-escapado:
- `=1+1` → output `=1+1` → Excel avalia como fórmula
- `+APY` → output `+APY` → Excel interpreta como fórmula
- `-DROP` → output `-DROP` → potencial avaliação

O vector de ataque no contexto DeFi: tokens scam com símbolos maliciosos (e.g., `=HYPERLINK("evil.com","USDC")`) existem on-chain. Se um utilizador fizer swap com um destes tokens e depois exportar CSV, o símbolo seria renderizado como fórmula no Excel/Sheets. Valores contendo `"` (como `=CMD("calc")`) SÃO capturados pela regex existente e wrapped em quotes, mas o conteúdo pós-unwrap continua a ser avaliado como fórmula pelo Excel.

**Impacto:** LOW — requer cadeia multi-step (swap com scam token → export → open em Excel) e Excel moderno mostra warning antes de avaliar fórmulas externas. Mas é um vector conhecido e o fix é trivial.

**Recomendação:** Prefixar cells que começam com `=`, `+`, `-`, `@`, `\t`, ou `\r` com um tab character ou apóstrofo:

```typescript
export function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return ''
  const str = String(value)
  // Sanitise formula-triggering prefixes (defence against CSV injection)
  const safe = /^[=+\-@\t\r]/.test(str) ? `\t${str}` : str
  if (/[",\r\n]/.test(safe)) {
    return `"${safe.replace(/"/g, '""')}"`
  }
  return safe
}
```

### 13B-L-02 — Route comment falsely claims RLS as access control authority

**Severidade:** LOW
**Ficheiro:** `src/app/api/analytics/personal/route.ts` L10-11
**Descrição:**

O comentário JSDoc afirma: "The Supabase RLS on `swaps` is the authority — anon callers only ever see their own wallet's rows." Isto é **factualmente incorrecto**:

1. O `getSupabase()` (`src/lib/supabase.ts` L13) usa `SUPABASE_SERVICE_ROLE_KEY`, que **bypassa todas as RLS policies**.
2. A tabela `swaps` tem RLS enabled (`supabase/schema.sql` L115) mas **zero policies definidas** (linhas 120-121 estão comentadas).
3. O schema explicitamente documenta (L113, L118): "Disable RLS since we use service-role key from server-side API routes" e "Service role bypasses RLS, so no policies needed."

O resultado prático: ambos os endpoints analytics aceitam qualquer endereço de wallet sem prova de ownership. Isto **não é uma regressão** — é o padrão existente no codebase (`/api/history`, `/api/orders/[id]`, `/api/orders/stats` todos seguem a mesma abordagem). Dados de swap são visíveis on-chain. Mas o comentário falso poderia levar futuros developers a adicionar dados sensíveis à tabela `swaps` assumindo que RLS os protege.

**Impacto:** LOW — sem regressão de segurança (segue padrão existente), mas o comentário é enganoso e cria risco de confusão futura.

**Recomendação:** Corrigir o comentário para reflectir a realidade:

```typescript
// Access model: the wallet address acts as a public key — anyone who
// knows it can query its analytics (same as on-chain data visibility).
// Supabase uses service-role key (bypasses RLS). Rate limiting is the
// primary abuse-prevention mechanism.
```

### 13B-I-01 — Personal analytics fetches all rows, filters in JS; export filters at Supabase level

**Severidade:** INFO
**Ficheiros:** `src/lib/personal-analytics.ts` L192-203, `src/app/api/analytics/export/route.ts` L197-205
**Descrição:**

- `fetchPersonalAnalytics` (P98): Busca todas as colunas seleccionadas sem filtro de status, depois filtra em JS com `rows.filter(isCompleted)`. Uma wallet com 50% de swaps falhados/abandonados transfere o dobro dos dados necessários.
- O export route (P100): Filtra no Supabase com `.or('status.eq.confirmed,and(status.eq.pending,tx_hash.not.is.null)')` — correcto e eficiente.

A inconsistência não é um risco de segurança, mas desperdiça largura de banda Supabase→Vercel. Com o limit de 10k rows, o overhead é bounded, mas poderia ser eliminado adicionando o mesmo filtro `.or(...)` à query do `fetchPersonalAnalytics`.

**Recomendação:** Alinhar o filtro de status entre ambas as queries. Non-blocking.

### 13B-I-02 — TOKEN_DECIMALS fallback to 18 for unknown tokens

**Severidade:** INFO
**Ficheiro:** `src/app/api/analytics/export/route.ts` L35-38 (`getDecimals`)
**Descrição:** Tokens não presentes no map `TOKEN_DECIMALS` (L25-33) usam fallback de 18 decimals. Isto é correcto para a maioria dos ERC-20 tokens mas produz amounts incorrectos para tokens exotic com decimals diferentes (e.g., GUSD=2, EURS=2, WDGLD=8). A mitigação existente é boa: `humanAmount` detecta values que já contêm `.` e faz passthrough (legacy rows com amounts já em decimal). Para wei amounts de tokens desconhecidos, o display será errado por factor de 10^(18-actual).
**Recomendação:** Aceitar como is. Se necessário no futuro, considerar on-chain decimal lookup via ERC-20 `decimals()` call (cached). Non-blocking.

---

## Análise por Prompt

### P98 (ba56af5) — Personal analytics data layer + API

**Resultado:** PASS

**Verificações:**

1. **RLS enforcement (Review Focus #1):**
   - O API retorna dados filtrados por `.eq('wallet', walletLc)` — apenas a wallet requisitada.
   - **Pode um utilizador consultar outra wallet?** Sim — o endpoint não requer prova de ownership. Mas isto segue o padrão existente de `/api/history` e é aceitável dado que swap data é visível on-chain.
   - O serviço usa service-role key que bypassa RLS. **VER 13B-L-02** para o comentário enganoso.

2. **Wallet validation (Review Focus #2):**
   - `isValidAddress(wallet)` usa regex `^0x[a-fA-F0-9]{40}$` — permite apenas hex addresses de 20 bytes. **Suficiente para prevenir injection.** A regex é anchored (^/$), length-bounded (exactamente 42 chars), e character-restricted (hex only). Não há risco de SQL injection (Supabase parameteriza), XSS, ou path traversal.
   - Wallet é lowercased antes de qualquer uso (`walletLc`). **Correcto** — addresses no DB estão em lowercase.

3. **KV cache (Review Focus #3):**
   - TTL de 5 min (`CACHE_TTL_SECONDS = 300`). **Adequado** — analytics são read-mostly, dados mudam apenas quando novos swaps são logged.
   - KV failure handling: `try/catch` em cache read → fall-through to Supabase. Cache write é `.catch()` fire-and-forget. **Correcto — KV-failure-tolerant.** Consistente com o padrão H-01 (KV fallback).
   - Cache key: `analytics:personal:${wallet.toLowerCase()}`. **Correcto** — per-wallet isolation.
   - Cache validation: `if (cached && cached.wallet === walletLc)` — verifica que o cached object pertence à wallet correcta. **Defesa extra contra key collision.** Boa prática.

4. **Rate limit:** `10 req/min per wallet` via `checkRateLimit`. Key: `analytics-personal:${walletLc}`. **Adequado** — absorve refreshes de dashboard sem permitir abuse. Headers 429 incluem `X-RateLimit-*` e `Retry-After`. **Correcto.**

5. **`aggregatePersonalAnalytics` — pure function:**
   - Status filtering: `isCompleted(row)` = `confirmed || (pending && tx_hash)`. **Correcto** — mesma lógica que `/api/stats` e export.
   - Volume sum: `Number(row.amount_in_usd ?? 0)` com `Number.isFinite && > 0` guard. **Safe** contra NaN/null/negative.
   - Gasless ratio: `gaslessSwapCount / totalSwaps` com guard `totalSwaps > 0`. **Safe** contra division by zero.
   - Source win-rates: `(count / totalSwaps) * 100` com `.toFixed(2)`. Percentages sum to 100 (confirmed by test). **Correcto.**
   - Top pairs: sorted by count desc, then volume desc. Sliced to 5. **Correcto.**
   - Timing: `bestHour`/`bestDayOfWeek` only computed when `totalSwaps >= 10`. **Boa prática** — previne insights misleading com poucos dados. UTC-based. **Correcto.**
   - Period bounds: tracked via `periodStartMs`/`periodEndMs` with `Number.isFinite` guard. **Safe.**

6. **`fetchPersonalAnalytics` — Supabase wrapper:**
   - Select: minimal column set (9 columns, not `*`). **Boa prática.**
   - Limit: 10k rows. **Adequado** para retail use. Comment explains rationale.
   - Error handling: logs and returns `emptyAnalytics`. **Correcto** — não expõe erro ao cliente.
   - **VER 13B-I-01** para a inconsistência de filtro status (fetches all, filters in JS).

7. **`usePersonalAnalytics` hook:**
   - `useAccount()` para obter `address`. Refetch on `address` change. **Correcto.**
   - `AbortController` para cancelar pending requests. Cleanup em unmount. **Correcto** — previne state updates em componentes unmounted.
   - Skip refetch-on-focus (deliberado, documentado). **Aceitável** — analytics é stale-tolerant.
   - Error handling: wrapped em `.catch()`, renders no UI via `error` state. **Correcto.**

8. **10 testes:** Empty wallet, status filtering, volume sum, gasless ratio, source win-rates sum to 100, top-5 pairs, timing threshold (≥10), bestHour/bestDow, period bounds, wallet normalisation. **Cobertura adequada da pure function.**

### P99 (fc96134) — PersonalDashboard component + /analytics page

**Resultado:** PASS

**Verificações:**

1. **SSR disabled (Review Focus #4):**
   - `dynamic(() => import('@/components/PersonalDashboard'), { ssr: false })` no `page.tsx`. **Correcto** — o componente depende de Wagmi hooks (`useAccount`), que requerem browser context (wallet provider). SSR produziria hydration mismatch ou crash. Mesma postura que o `AnalyticsDashboard` protocol-wide.
   - `'use client'` em `PersonalDashboard.tsx` e `page.tsx`. **Correcto.**

2. **Connect prompt:** Quando `!isConnected`, mostra CTA com `<ConnectButton />`. **Correcto** — não tenta fetch sem wallet.

3. **Loading state:** `if (isLoading && !data) return <DashboardSkeleton />`. O `!data` guard preserva stale data durante refetch. **Correcto.**

4. **Empty state:** `if (!data || data.totalSwaps === 0) return <EmptyState />` com CTA "Swap Now" → `/`. **Correcto.**

5. **KPI cards:** 4 cards: Total Swaps, Total Volume, Gas Saved, Gasless Ratio. Valores formatados com `formatUsd`, `toLocaleString`, percentages. **Correcto.**

6. **Source win-rates:** CSS-only horizontal bars. Top 5 only. `sourceLabel(source)` falls back to raw string. **Correcto.**

7. **Timing insight:** Conditionally rendered only when `totalSwaps >= 10 && bestHour !== null && bestDayOfWeek !== null`. Non-null assertion (`!`) is safe here because the `showTiming` guard ensures non-null. **Correcto.**

8. **Export CSV link:** `href={/api/analytics/export?wallet=${data.wallet}&format=csv}`. Uses `data.wallet` (already lowercased from API response). **Correcto.**

9. **Header nav link:** "My Analytics" gated on `useAccount().isConnected`. Desktop + mobile menus. Mobile closes `mobileMenu` on click. **Correcto.**

10. **Responsive grid:** `grid-cols-1 sm:grid-cols-2 lg:grid-cols-4` for KPI cards. `md:grid-cols-2` for source/pairs. **Correcto.**

11. **Error display:** `{error}` rendered inside styled error div. O erro vem do hook que extrai `body.error` ou uses generic message. **Correcto** — não expõe stack traces.

### P100 (89bfcf2) — CSV export endpoint

**Resultado:** PASS (com 13B-L-01 para CSV injection)

**Verificações:**

1. **CSV injection (Review Focus #5):**
   - `csvEscape` escapa RFC-4180 (commas, quotes, newlines). **NÃO escapa** prefixos de fórmula (`=`, `+`, `-`, `@`). **VER 13B-L-01.**
   - Campos que poderiam conter fórmulas: `token_in_symbol` e `token_out_symbol` (originados de APIs de aggregators, não controlados pelo TeraSwap). Tokens scam com símbolos como `=DROP` ou `+APY` existem on-chain.
   - `source` é de aggregator names hardcoded — safe. `tx_hash` é hex — safe. Dates são ISO — safe. Amounts são numeric — safe.

2. **Rate limit (Review Focus #6):**
   - `5 req/hour per wallet` via `checkRateLimit`. Key: `analytics-export:${walletLc}`. **Adequado** — CSV export é ocasional (tax season, audits). 5/hour previne scraping automatizado enquanto permite retry em caso de erro. **Correcto.**

3. **Wei→decimal conversion (Review Focus #7):**
   - `humanAmount(raw, symbol)`: se `raw` contém `.`, passthrough (legacy decimal). Senão, `formatUnits(BigInt(raw), getDecimals(symbol))`. **Correcto.**
   - `getDecimals(symbol)`: lookup em `TOKEN_DECIMALS`, fallback 18. **VER 13B-I-02** para tokens exóticos.
   - `TOKEN_DECIMALS` cobre ~40 tokens (ETH variants, stablecoins, major DeFi). USDC/USDT correctamente a 6, WBTC a 8. **Adequado para cobertura de 95%+ do volume.**
   - `try/catch` em `BigInt(raw)` — se raw não é parseable, retorna raw. **Safe.**

4. **RFC-4180 compliance:**
   - `\r\n` line endings. **Correcto per RFC-4180.**
   - Header row presente. **Correcto.**
   - Terminal `\r\n` após última row. **Correcto per RFC-4180 §2.2.**

5. **Content-Disposition:** `attachment; filename="teraswap-history-{short}-{date}.csv"`. Filename usa wallet abbreviation (6+4 chars) + ISO date. **Correcto** — no path traversal possible (wallet is hex-validated).

6. **Cache-Control:** `no-store`. **Correcto** — dados pessoais não devem ser cached por CDN/proxies.

7. **Supabase query:**
   - Filters: `.eq('wallet', walletLc)` + `.or('status.eq.confirmed,and(status.eq.pending,tx_hash.not.is.null)')`. **Correcto** — filtra no Supabase level (vs. analytics que filtra em JS — ver 13B-I-01).
   - Select: 12 columns (minimais). **Correcto.**
   - Limit: 10k. **Adequate.**
   - Error: 502 com mensagem genérica. **Correcto** — não expõe detalhes Supabase.

8. **WalletHistory export button:**
   - `aria-disabled` + click prevention when `swaps.length === 0`. **Correcto** — UX guard.
   - URL: `/api/analytics/export?wallet=${address}&format=csv`. `address` vem de `useAccount()` — a wallet conectada. **Correcto.**

9. **8 testes:** csvEscape (plain passthrough, null/undefined, comma/quote/newline escaping), rowsToCsv (empty wallet header-only, ISO dates + wei→decimal, gasless/gasSaved, legacy decimal passthrough, comma/quote escaping). **Cobertura adequada.**

---

## Cross-cutting Verification

| Check | Status |
|-------|--------|
| Zero contract changes | **Confirmado** |
| Zero fund flow changes | **Confirmado** |
| 2 novos endpoints + 1 page | **Confirmado** — `/api/analytics/personal`, `/api/analytics/export`, `/analytics` |
| Zero novas env vars | **Confirmado** — usa Supabase + KV existentes |
| Zero dependências adicionadas | **Confirmado** |
| Wallet validation adequate | **Confirmado** — `^0x[a-fA-F0-9]{40}$` anchored, length-bounded, hex-only |
| KV failure tolerant | **Confirmado** — try/catch on read, fire-and-forget on write |
| Rate limits appropriate | **Confirmado** — 10/min analytics, 5/hour export |
| SSR disabled correctly | **Confirmado** — Wagmi hooks require browser context |
| No sensitive data exposed | **Confirmado** — swap data is on-chain public |
| Follows existing access pattern | **Confirmado** — same as /api/history, /api/orders |
| 568 tests passing | **Confirmado** (+18 novos: 10 aggregation + 8 CSV) |

---

## Review Focus Responses

1. **P98 RLS enforcement:** A API retorna apenas dados da wallet requisitada (filtro `.eq('wallet', walletLc)`). No entanto, **qualquer utilizador pode consultar qualquer wallet** — não há prova de ownership. Isto segue o padrão existente do codebase (history, orders) e é aceitável dado que swap data é on-chain. O comentário sobre RLS é **falso** (service-role bypassa) — ver 13B-L-02.

2. **P98 wallet validation:** `isValidAddress` usa regex `^0x[a-fA-F0-9]{40}$` — anchored, length-bounded, character-restricted. Suficiente contra injection (Supabase parameteriza queries). O wallet é lowercased antes de uso — matches DB storage format.

3. **P98 KV cache:** 5-min TTL é adequado para read-mostly analytics. KV failure é handled gracefully: `try/catch` no read → fall-through to fresh aggregation; `.catch()` no write → silencioso. O cached object é validado (`cached.wallet === walletLc`) contra key collision.

4. **P99 SSR disabled:** Correcto. `PersonalDashboard` usa `useAccount()` e `usePersonalAnalytics()` que dependem de Wagmi provider (browser-only). SSR produziria hydration mismatch. `dynamic(() => import(...), { ssr: false })` é o padrão correcto.

5. **P100 CSV injection:** `csvEscape` escapa RFC-4180 (commas, quotes, newlines) mas **não sanitiza prefixos de fórmula** (`=`, `+`, `-`, `@`). Token symbols são o vector — scam tokens com nomes maliciosos existem on-chain. **Ver 13B-L-01.**

6. **P100 rate limit:** 5 req/hour per wallet é adequado. CSV export é operação ocasional (tax reporting, audits). O rate limit previne scraping automatizado. `Retry-After` header incluído na resposta 429.

7. **P100 wei→decimal:** `TOKEN_DECIMALS` cobre ~40 tokens com decimals correctos (USDC/USDT=6, WBTC=8, maioria=18). Fallback 18 é correcto para a vasta maioria dos ERC-20. Legacy rows com amounts já em decimal (contêm `.`) fazem passthrough. **Ver 13B-I-02** para tokens exóticos.

---

## Veredicto Final

| Severidade | Count |
|------------|-------|
| CRITICAL   | 0     |
| HIGH       | 0     |
| MEDIUM     | 0     |
| LOW        | 2     |
| INFO       | 2     |

### APPROVED — 0C / 0H / 0M / 2L

Sprint 13B está limpo para merge. O dashboard de analytics pessoal é bem construído com caching tolerante a falhas, rate limiting adequado, e aggregation correcta. Os 2 LOWs (CSV formula injection e comentário RLS falso) são non-blocking — ambos têm fix trivial e risco limitado. O CSV injection é o mais importante: recomenda-se fix antes de promover o export feature a utilizadores.

Contagem de testes na branch: **568** (550 base + 18 Sprint 13B).

---

## Fix Prompts

### 13B-FIX-01 — Sanitise CSV formula-triggering prefixes

**Context:** `csvEscape` in `src/app/api/analytics/export/route.ts` L61-68 handles RFC-4180 escaping (commas, quotes, newlines) but does not sanitise cell prefixes that trigger formula evaluation in Excel and Google Sheets (`=`, `+`, `-`, `@`, `\t`, `\r`). Token symbols from DeFi aggregator APIs can contain these characters (scam tokens like `=DROP`, `+APY`).

**Objective:** Add formula-prefix sanitisation to `csvEscape` so that cells starting with `=`, `+`, `-`, `@`, `\t`, or `\r` are prefixed with a tab character (`\t`) before RFC-4180 escaping. This is the standard mitigation recommended by OWASP for CSV injection.

**Requirements:**
1. In `csvEscape`, after the null check and `String(value)` conversion, add a prefix check:
   ```typescript
   const safe = /^[=+\-@\t\r]/.test(str) ? `\t${str}` : str
   ```
   Then apply RFC-4180 escaping to `safe` instead of `str`.
2. Add 3 tests to `route.test.ts`:
   - `csvEscape('=CMD("calc")')` → starts with tab, contains the original string
   - `csvEscape('+APY')` → starts with tab
   - `csvEscape('-DROP')` → starts with tab
   - `csvEscape('USDC')` → unchanged (no prefix added for normal values)

**Do NOT:**
- Change the RFC-4180 escaping logic (commas, quotes, newlines)
- Modify `rowsToCsv` or `humanAmount`
- Add formula sanitisation to the `/api/analytics/personal` route (JSON endpoint, not affected)

**Files affected:** `src/app/api/analytics/export/route.ts`, `src/app/api/analytics/export/route.test.ts`
**Expected output:** 1 commit, 571+ tests passing. Build clean.
**Quality criteria:** `npx tsc --noEmit` clean. Existing 8 CSV tests pass. New tests confirm tab prefix on formula-triggering cells.

### 13B-FIX-02 — Correct misleading RLS comment on personal analytics route

**Context:** The JSDoc comment on `/api/analytics/personal/route.ts` L10-11 states "The Supabase RLS on `swaps` is the authority — anon callers only ever see their own wallet's rows." This is factually incorrect: `getSupabase()` uses `SUPABASE_SERVICE_ROLE_KEY` which bypasses all RLS policies. The `swaps` table has RLS enabled but zero policies defined (all commented out in `supabase/schema.sql` L120-121).

**Objective:** Replace the misleading comment with an accurate description of the access model.

**Requirements:**
1. In `src/app/api/analytics/personal/route.ts`, replace lines 10-13:
   ```typescript
   // Access model: the wallet parameter is treated as a public key —
   // anyone who knows a wallet address can query its swap analytics
   // (consistent with on-chain data visibility). The Supabase client uses
   // service-role key (bypasses RLS). Rate limiting is the primary
   // abuse-prevention mechanism; the address validation here is
   // defence-in-depth for clean input.
   ```
2. No functional changes. Zero test impact.

**Do NOT:**
- Add SIWE or any authentication (that's a product decision for a future sprint)
- Change the Supabase client from service-role to anon key (would break all existing routes)
- Modify the export route's comments (they don't make the same false claim)

**Files affected:** `src/app/api/analytics/personal/route.ts`
**Expected output:** 1 commit. Comment-only change. Build clean.

---

*Relatório gerado por Claude (Senior Security Auditor) — 2026-05-14*
