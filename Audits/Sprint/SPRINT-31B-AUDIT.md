# Audit Report — Sprint 31B (Portfolio Alchemy Token Discovery)

| Field | Value |
|---|---|
| **Sprint** | 31B |
| **Branch** | `feat/sprint-31b-alchemy-discovery` (merged to main) |
| **Commits** | 4 (`997e506`, `a14e9e0`, `f197d44`, `f6c7074`) |
| **Prompts** | P179–P182 |
| **Auditor** | Claude (Senior Security Auditor) |
| **Date** | 2026-05-27 |
| **Verdict** | **APPROVED — 0C / 0H / 0M / 0L / 4 INFO** |

---

## Scope

Portfolio token discovery via Alchemy Enhanced API: new server-side API route (`/api/portfolio/tokens`) calling `alchemy_getTokenBalances` + `alchemy_getTokenMetadata`, client-side integration hook (`useDiscoveredTokens`) with transparent fallback to wagmi multicall on 503, discovered tokens UI with import CTA, and 24 new tests across 3 files. 7 files changed, +1294 lines.

### Files in diff

| File | Change | Prompt |
|---|---|---|
| `src/app/api/portfolio/tokens/route.ts` | **NEW** | P179 |
| `src/hooks/usePortfolio.ts` | Modified (major refactor) | P180 |
| `src/components/PortfolioTab.tsx` | Modified (+166 lines) | P181 |
| `src/app/api/portfolio/tokens/route.test.ts` | **NEW** | P182 |
| `src/hooks/usePortfolio.test.ts` | Modified (+8 tests) | P182 |
| `src/components/PortfolioTab.test.tsx` | Modified (+5 tests) | P182 |
| `.env.example` | Modified (+7 lines) | P179 |

---

## P179 — Alchemy Token Discovery API Route (`997e506`) — 259 lines

### Security checklist

| Check | Result |
|---|---|
| `ALCHEMY_API_KEY` from `process.env` (server-only) | ✅ No `NEXT_PUBLIC_` prefix |
| API key never logged to console | ✅ Lines 178/216 log `err.message` only, never the URL containing the key |
| Alchemy URL construction: `${ALCHEMY_BASE}/${apiKey}` | ✅ Key in path segment, standard Alchemy pattern |
| Address validated with `isValidAddress()` before Alchemy call | ✅ Line 53 — rejects before any external request |
| Rate limit: `portfolio-tokens:${ip}`, 5 req/min | ✅ Per-IP, via `checkRateLimit` |
| `AbortController` with 5s timeout on Alchemy fetch | ✅ Lines 160–165 |
| Only `'erc20'` token type requested | ✅ `tokenType: 'ERC20'` in JSON-RPC params |
| Zero balances filtered | ✅ `.filter(b => b.tokenBalance && b.tokenBalance !== '0x0' && b.tokenBalance !== '0x')` |
| Token cap: `MAX_TOKENS = 200` via `.slice(0, MAX_TOKENS)` | ✅ Prevents unbounded response |
| `resolveMetadataBatched()` uses `Promise.allSettled` | ✅ One failed metadata call doesn't crash the batch |
| `METADATA_CONCURRENCY = 20` | ✅ Bounded parallelism — max 20 concurrent Alchemy calls |
| `hexToDecimalString()` handles null, '0x', malformed hex | ✅ try/catch → '0' fallback |
| DEFAULT_TOKENS metadata used for known tokens | ✅ Skips metadata RPC for curated tokens |
| Fallback metadata for unknown tokens | ✅ `{ symbol: addr.slice(0,6), name: 'Unknown Token', decimals: 18, logoURI: null }` |
| Missing ALCHEMY_API_KEY → 503 | ✅ Graceful degradation, not 500 |
| Alchemy error → 502 | ✅ Correct — upstream provider error |
| Cache-Control: `public, s-maxage=30, stale-while-revalidate=60` | ✅ Short TTL appropriate for balance data |
| No Alchemy SDK — raw fetch + JSON-RPC | ✅ Zero new npm dependencies |
| No `package.json` changes | ✅ Confirmed — diff is empty |

### Architecture assessment

A implementação é correcta e segue as melhores práticas:

1. **Server-only boundary:** A API key do Alchemy nunca sai do servidor. A construção do URL (`${ALCHEMY_BASE}/${apiKey}`) é passada apenas ao `fetch()` interno — os dois `console.warn` nas linhas 178 e 216 logam apenas `err.message`, nunca o URL ou a key.

2. **Defence in depth:** Três camadas de protecção: (a) validação de address com `isValidAddress()` antes de qualquer chamada externa, (b) rate limit per-IP para prevenir abuso, (c) `AbortController` com timeout de 5s para prevenir requests pendurados.

3. **Graceful degradation:** `503` quando a key não está configurada permite ao frontend fazer fallback transparente ao multicall — o mesmo endpoint pode funcionar em ambientes sem Alchemy.

4. **Zero dependencies:** Raw fetch + JSON-RPC elimina supply chain risk. Não há Alchemy SDK, não há novos packages.

**Verdict:** Conforme.

---

## P180 — usePortfolio Hook Refactor (`a14e9e0`)

### Security checklist

| Check | Result |
|---|---|
| `useDiscoveredTokens()` fetches from `/api/portfolio/tokens?address=...` | ✅ Server-side route, not direct Alchemy call |
| `fetchIdRef` stale-request guard | ✅ Prevents race conditions on rapid address changes |
| `useTokenBalances(enabled)` accepts `enabled` param | ✅ wagmi hooks get `enabled: false` when Alchemy available |
| 503 from discovery → `isAvailable = false` → fallback to multicall | ✅ Transparent degradation |
| `DEFAULT_BY_ADDRESS` map for curated metadata override | ✅ Prevents Alchemy metadata overriding trusted data |
| Non-default tokens get `category: 'Other' as TokenCategory` | ✅ Clear separation from curated tokens |
| `logo1inch()` fallback for discovered tokens without Alchemy logo | ✅ |
| BigInt conversion: `try { raw = BigInt(d.balance) } catch { continue }` | ✅ Malformed balances skipped silently |
| `if (raw <= 0n) continue` after BigInt conversion | ✅ Zero/negative balances excluded |
| `fetchPricesBatched()`: chunks at `PRICES_BATCH_SIZE = 100` | ✅ Bounded batch size |
| `refresh()` calls `discovery.bump()` | ✅ Both data sources refresh together |
| Cleanup: `cancelled = true; clearInterval(interval)` in useEffect | ✅ No stale updates after unmount |

### Fallback integrity analysis

O padrão de fallback é robusto:

1. **Detecção de 503:** Se `/api/portfolio/tokens` retorna 503 (sem ALCHEMY_API_KEY), o hook marca `isAvailable = false` e a flag `enabled: false` desactiva o polling.
2. **Activação do multicall:** Com `isAvailable = false`, os hooks wagmi recebem `enabled: true` e assumem a responsabilidade de leitura de balances — exactamente o comportamento Sprint 31 original.
3. **Sem mistura de dados:** O hook usa **ou** dados Alchemy **ou** dados multicall, nunca ambos simultaneamente. A flag `isAvailable` é o switch atómico.
4. **Re-tentativa:** Se o Alchemy recuperar (e.g., key adicionada), o próximo refresh tenta novamente e `isAvailable` volta a `true`.

**Verdict:** Conforme.

---

## P181 — PortfolioTab Discovered Tokens UI (`f197d44`)

### Security checklist

| Check | Result |
|---|---|
| `DEFAULT_TOKEN_ADDRESSES` Set for `isDefaultToken` check | ✅ Clear boundary between curated and discovered |
| `shortenAddress()`: `addr.slice(0, 6)…addr.slice(-4)` | ✅ Safe string operation |
| Token name/symbol rendered as JSX text (no `dangerouslySetInnerHTML`) | ✅ React auto-escapes all text content |
| `DiscoveredRow` component: dashed border (pre-import), solid border (post-import) | ✅ Visual distinction |
| `handleAdd()` calls `importToken(token.address)` | ✅ Goes through full `useTokenImport` validation |
| `importedAddrs` tracked in per-session state | ✅ Not persisted — resets on page reload |
| "Discovered in Wallet" section appears AFTER all CATEGORY_DISPLAY_ORDER groups | ✅ Clear visual hierarchy |
| logoURI from Alchemy used as `<img src>` | ✅ Standard browser behaviour — see 31B-I-01 |

### Trust boundary analysis

A importação de tokens descobertos segue um pipeline de validação correcto:

1. **Display (transiente):** Metadata do Alchemy é exibida como texto JSX (auto-escaped pelo React). Mesmo que o Alchemy retorne metadata maliciosa, não há XSS — `<script>` em text nodes é renderizado como texto literal.

2. **Import (persistente):** Quando o utilizador clica "Add", `useTokenImport.importToken(address)` é chamado. Este hook:
   - Valida o address com `getAddress()` (EIP-55 checksum via viem)
   - Re-lê on-chain: `symbol()`, `name()`, `decimals()` via RPC (não confia na metadata Alchemy)
   - Aplica `sanitizeTokenField()` — [F-03]: strip `<>`, non-printable chars, limit length
   - Só então persiste via `addCustomToken()`

3. **Consequência:** A metadata Alchemy é usada apenas para display transiente. A metadata persistida vem sempre de on-chain + sanitização. Esta é a arquitectura correcta.

**Verdict:** Conforme.

---

## P182 — Tests (`f6c7074`) — 24 new tests

### Coverage matrix — `route.test.ts` (11 tests)

| Scenario | Status | Verdict |
|---|---|---|
| Missing `address` param → 400 | ✅ | |
| Invalid address → 400 | ✅ | |
| Missing ALCHEMY_API_KEY → 503 | ✅ | |
| Rate limit exceeded → 429 | ✅ | |
| Empty balances → 200 with empty array | ✅ | |
| Mixed default/unknown tokens → correct metadata | ✅ | |
| Metadata fallback for failed Alchemy call | ✅ | |
| Alchemy network error → 502 | ✅ | |
| 200-token cap enforced | ✅ | |
| Response shape validation | ✅ | |
| Zero balance filtering | ✅ | |

### Coverage matrix — `usePortfolio.test.ts` (+8 tests)

| Scenario | Status | Verdict |
|---|---|---|
| Alchemy discovered tokens appear in portfolio | ✅ | |
| DEFAULT metadata wins over Alchemy metadata | ✅ | |
| Non-default tokens get 'Other' category | ✅ | |
| 503 fallback to wagmi multicall | ✅ | |
| wagmi hooks not consulted when Alchemy available | ✅ | |
| Price fetch includes discovered token addresses | ✅ | |
| BigInt conversion handles malformed balance | ✅ | |
| >100 tokens triggers batched price fetching | ✅ | |

### Coverage matrix — `PortfolioTab.test.tsx` (+5 tests)

| Scenario | Status | Verdict |
|---|---|---|
| Discovered section visible with non-default tokens | ✅ | |
| Truncated address displayed correctly | ✅ | |
| Add button triggers import flow | ✅ | |
| No discovered section when all tokens are default | ✅ | |
| No discovered section in multicall fallback mode | ✅ | |

### Security-relevant test observations

1. **503 fallback test**: Verifica que quando o Alchemy retorna 503, o hook transparentemente activa o wagmi multicall e os dados aparecem correctamente. Cobre o cenário de degradação graceful.
2. **wagmi not consulted test**: Confirma que quando o Alchemy está disponível, os hooks wagmi recebem `enabled: false` — evita requests duplicados e dados inconsistentes.
3. **DEFAULT metadata wins test**: Garante que tokens conhecidos (ETH, USDC, etc.) usam metadata curada mesmo quando o Alchemy retorna metadata diferente.
4. **200-token cap test**: Verifica que a resposta é truncada a 200 tokens independentemente do que o Alchemy retorna.

**Verdict:** Conforme. Cobertura abrangente dos paths de segurança.

---

## .env.example update

| Check | Result |
|---|---|
| `ALCHEMY_API_KEY=` adicionado com placeholder vazio | ✅ |
| Comentário documenta: server-only, URL para obter, free tier | ✅ |
| Documenta fallback behaviour quando unset | ✅ "returns 503 and falls back to DEFAULT_TOKENS multicall" |
| Posicionado correctamente (após RPC vars, antes de Aggregator keys) | ✅ |
| Sem valor real/secret no placeholder | ✅ |

**Verdict:** Conforme.

---

## Cross-cutting checks

| Check | Result |
|---|---|
| No changes to swap-flow / TokenSelector | ✅ |
| No changes to contracts / fund flows | ✅ |
| No new npm dependencies | ✅ `package.json` unchanged — raw fetch, no Alchemy SDK |
| No hardcoded secrets in any file | ✅ API key via env var only |
| No new `NEXT_PUBLIC_` env vars | ✅ `ALCHEMY_API_KEY` is server-only |
| Alchemy API key never logged | ✅ console.warn logs err.message, not URL |
| Token metadata rendered as text only (no dangerouslySetInnerHTML) | ✅ |
| Import pipeline re-reads on-chain + sanitizes | ✅ Does not trust Alchemy metadata for persistence |
| Fallback integrity: Alchemy OR multicall, never mixed | ✅ |
| CSP impact | ✅ None — Alchemy calls are server-side only |
| Test files don't execute production code with side effects | ✅ All mocked |

---

## Findings

### 31B-I-01 — Alchemy `logoURI` passed through without validation (INFO)

**Ficheiro:** `src/app/api/portfolio/tokens/route.ts:198`, `src/components/PortfolioTab.tsx`

O `logoURI` retornado pelo Alchemy `getTokenMetadata` é passado diretamente ao frontend e usado como `<img src>`. Não há validação de URL (scheme, domain, etc.) no API route.

**Risco real:** Mínimo. Tags `<img>` no browser não executam scripts. O pior cenário é um pixel de tracking (mas o Alchemy já conhece o address consultado) ou uma imagem de conteúdo inapropriado. O React renderiza `<img>` sem risco de XSS.

**Mitigação existente:** A CSP `img-src` limita as origens de imagens permitidas. Se o Alchemy retornar um URL de domínio não autorizado pela CSP, o browser bloqueia silenciosamente.

**Recomendação:** Para defense-in-depth, considerar validar que `logoURI` começa com `https://` e pertence a uma whitelist de CDNs de tokens conhecidos (e.g., `tokens.1inch.io`, `assets.coingecko.com`, Alchemy CDN). Prioridade baixa.

**Severidade:** INFO — risco mitigado pela CSP e pelo modelo de segurança do browser.

---

### 31B-I-02 — Alchemy metadata não sanitizada na API boundary (INFO)

**Ficheiro:** `src/app/api/portfolio/tokens/route.ts:190-200`

Os campos `symbol` e `name` retornados pelo Alchemy `getTokenMetadata` são incluídos na resposta JSON sem sanitização. A sanitização (`sanitizeTokenField` com strip de `<>`, non-printable chars, length cap) existe no `useTokenImport.ts` mas só é aplicada no momento da importação, não no display transiente.

**Risco real:** Nenhum para XSS — o React auto-escape protege contra injecção em text nodes. O cenário teórico seria um token cujo nome contém caracteres de controlo Unicode (e.g., RTL override U+202E) que poderia confundir o layout visual. Impacto: confusão visual temporária, não escalável a exploração.

**Mitigação existente:**
1. React JSX auto-escapes text content ✅
2. `sanitizeTokenField()` em `useTokenImport.ts` strip non-printable + `<>` no momento da importação ✅
3. DEFAULT_TOKENS override garante metadata curada para tokens conhecidos ✅

**Recomendação:** Considerar aplicar `sanitizeTokenField` aos campos `symbol`/`name` no API route antes de retornar, para defense-in-depth. Prioridade baixa.

**Severidade:** INFO — protecção existente é suficiente.

---

### 31B-I-03 — Rate limit per-IP adequado mas com trade-off documentado (INFO)

**Ficheiro:** `src/app/api/portfolio/tokens/route.ts:58`

O rate limit usa `portfolio-tokens:${ip}` com 5 req/min. Isto é standard para endpoints públicos. O trade-off:

- **Pro:** Simples, previne abuso por IP, não requer autenticação.
- **Con:** Utilizadores atrás de CGNAT/NAT partilham o rate limit. Num cenário teórico, múltiplos utilizadores no mesmo ISP corporativo poderiam esgotar o rate limit mutuamente.

**Risco real:** Mínimo. O endpoint é consultado automaticamente 1x por page load + refresh manual. 5 req/min por IP é generoso para uso normal. O `stale-while-revalidate=60` no Cache-Control reduz ainda mais a frequência de hits reais.

**Severidade:** INFO — trade-off standard, adequado para o scale actual.

---

### 31B-I-04 — Excelente arquitectura de fallback e trust boundary (INFO)

**Observação positiva:**

O Sprint 31B demonstra padrões de segurança maduros:

1. **Fallback atómico:** O switch `isAvailable` garante que o portfolio usa **ou** Alchemy **ou** multicall, nunca misturando dados de fontes diferentes. Elimina uma classe inteira de bugs de consistência.

2. **Trust boundary na importação:** A metadata Alchemy é tratada como untrusted para display transiente (protegida por React auto-escape) e completamente descartada na importação — `useTokenImport` re-lê on-chain e aplica `sanitizeTokenField`. Este é o padrão correcto: display untrusted data safely, validate before persisting.

3. **Zero new dependencies:** Raw fetch + JSON-RPC em vez do Alchemy SDK elimina supply chain risk. A única "dependência" é a API do Alchemy, que é server-side e protegida pelo rate limit + timeout.

4. **Graceful degradation by design:** A resposta 503 quando `ALCHEMY_API_KEY` está ausente não é um erro — é uma feature. Permite deployment sem Alchemy com fallback automático ao comportamento Sprint 31.

5. **Test coverage dos paths de segurança:** Os 24 testes cobrem especificamente: fallback 503→multicall, wagmi disabled quando Alchemy activo, DEFAULT metadata override, BigInt conversion, 200-token cap, e rate limiting.

**Severidade:** INFO — nota de reconhecimento.

---

## Verdict

| Severity | Count | IDs |
|---|---|---|
| Critical | 0 | — |
| High | 0 | — |
| Medium | 0 | — |
| Low | 0 | — |
| Info | 4 | 31B-I-01, 31B-I-02, 31B-I-03, 31B-I-04 |

**APPROVED — 0C / 0H / 0M / 0L / 4 INFO**

Sprint 31B adiciona token discovery via Alchemy Enhanced API com uma arquitectura de segurança sólida. A API key é estritamente server-only e nunca logada. A validação de input (address) ocorre antes de qualquer chamada externa. O fallback para multicall é atómico e transparente. A trust boundary entre display transiente (Alchemy metadata, protegida por React auto-escape) e persistência (on-chain re-read + sanitização) é correcta. Zero novas dependências npm. 24 testes cobrem todos os paths de segurança críticos. Seguro para produção.

### Test count

| File | Tests | Source file |
|---|---|---|
| `route.test.ts` | 11 | `route.ts` (259 lines) |
| `usePortfolio.test.ts` | +8 | `usePortfolio.ts` (refactor) |
| `PortfolioTab.test.tsx` | +5 | `PortfolioTab.tsx` (+166 lines) |
| **Total new** | **24** | |
| **Running total** | **1132** | (1108 existing + 24 new) |
