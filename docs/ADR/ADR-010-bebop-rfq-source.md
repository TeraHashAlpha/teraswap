# ADR-010: Bebop como 12.ª fonte (RFQ/solver, chain-agnostic ETH + Base)

**Status:** Proposed
**Date:** 2026-05-31
**Author:** Architect
**Context:** Phase 2 — expansão de fontes de liquidez em Base e mainnet. Pedido: adicionar DEXs/fontes fortes em Base que ainda não usamos (Aerodrome, Bitget, Bebop).

---

## Decisão

Adicionar a **Bebop** como **12.ª fonte** do meta-agregador, **chain-agnostic** (Ethereum `1` + Base `8453`), via a **Aggregation API (JAM)** com `gasless=false` (self-execution), obtendo calldata pronta que encaixa no nosso `NormalizedQuote.tx` sem introduzir um fluxo de assinatura novo.

**Adiar** (com fundamentação abaixo):
- **Aerodrome** — já entra indiretamente nas nossas cotações via OpenOcean/KyberSwap/Velora (confirmado: a resposta da OpenOcean em Base lista `Aerodrome`, `AerodromeSlipstream`, `AerodromeCL`). Integração direta exige adapter on-chain (v2 solidly + Slipstream CL + Quoter off-chain), alto esforço e benefício de preço marginal. Reabrir só se construirmos routing on-chain próprio ligado ao `teraswap_order_engine`.
- **Bitget Wallet Swap** — é um meta-agregador (110+ protocolos) que recentemente integrou 0x/Matcha. Adicioná-lo é "agregar um agregador": sobreposição forte, risco de dupla contagem e necessita de chave enterprise. Baixa prioridade.

## Fundamentação

A Bebop adiciona uma **categoria de liquidez que ainda não temos**: market-makers profissionais (PMM) e solvers, com preço firme e 0% slippage, tipicamente competitivo em majors e em size — complementar ao CoW (intent) e aos agregadores AMM. Suporta ETH e Base nas duas APIs.

Escolhe-se a **Aggregation API (JAM)** em vez da RFQ-PMM pura para a v1 porque:
1. Com `gasless=false` devolve `tx { to, data, value, gas }` self-execution → encaixa no modelo atual (como 0x/1inch), sem alterar o caminho de assinatura.
2. A competição de solvers já inclui liquidez de market-makers, captando grande parte do diferencial.
3. Slug de chain (`ethereum`/`base`) coincide com o nosso `ChainConfig.slug`.

A RFQ-PMM pura fica como *fast-follow* opcional se quisermos quotes firmes dedicados.

## Modelo de fees

A Bebop **não é compatível** com o nosso FeeCollector proxy (a tx é construída pela Bebop para o seu próprio settlement). Trata-se como o 0x/CoW:
- Adicionar `bebop` a `FEE_INCOMPATIBLE_SOURCES` → o caminho FeeCollector é ignorado.
- A nossa receita é cobrada via **partner fee da Bebop**: parâmetros `fee` (bps, a nossa taxa-padrão) + `fee_recipient` (a nossa fee wallet). Sem perda de monetização.

## Segurança (crítico)

A doc da Bebop diz "usar sempre os endereços da resposta do quote, não hardcode". O **nosso** modelo (ver `routers.ts`, regra #2/#9 do CLAUDE.md) exige whitelist estática de spenders/routers por chain. Conciliação:

- Adicionar a `ROUTER_WHITELIST_BY_CHAIN` para `1` **e** `8453` os contratos JAM (iguais em todas as EVM exceto zkSync):
  - **JamSettlement** (`settlementAddress`, alvo de `tx.to`): `0xbeb0b0623f66bE8cE162EbDfA2ec543A522F4ea6`
  - **Balance Manager** (`approvalTarget`, alvo do approve ERC-20): `0xC5a350853E4e36b73EB0C24aaA4b8816C9A3579a`
- Validar em runtime que `tx.to === settlementAddress` da resposta **e** que `settlementAddress` + `approvalTarget` constam da nossa whitelist da chain; caso contrário, rejeitar a swap. Assim, se a Bebop mudar de contrato, o nosso teste/whitelist falha de forma ruidosa (fail-closed) em vez de aprovarmos um spender desconhecido.
- **API key server-only**: `BEBOP_API_KEY` + `BEBOP_SOURCE` (partner id). NUNCA `NEXT_PUBLIC_` (regra #7). Sem key → "demo mode" (quotes alargados) — aceitável só em dev.

## Consequências

- Passamos de 11 → **12 fontes**. O array hardcoded em `api.ts` (`['1inch','0x',...,'Curve']`, indexado por posição) e qualquer contagem fixa de fontes têm de incluir `bebop` na mesma ordem do `ADAPTER_REGISTRY` — caso contrário os erros por-fonte ficam desalinhados. Tech-debt a corrigir no mesmo sprint.
- `taker_address` é obrigatório no quote. Em `fetchQuote` (preço, sem wallet) usa-se um placeholder; o quote firme/executável em `fetchSwapData` usa o `from` real. Validar que a Bebop aceita placeholder para preço indicativo; se não, a fonte fica disponível só com wallet ligada.
- `tx.value` vem em hex (`0x0`) — normalizar para o nosso formato string decimal.

## Alternativas consideradas

1. **RFQ-PMM apenas** — liquidez MM mais "pura", mas fluxo de assinatura dedicado e menor cobertura de pares. Adiado como fast-follow.
2. **Router API (PMM+JAM combinados)** — melhor preço teórico, mas semântica de resposta mais complexa; JAM sozinho cobre a v1.
3. **Aerodrome on-chain** — adiado (já agregado, alto esforço).
4. **Bitget meta-agregador** — adiado (meta-sobre-meta, chave enterprise).

## Referências

- Bebop — How Bebop Works: https://docs.bebop.xyz/how-bebop-works
- Bebop — Aggregation API /v2/quote: https://docs.bebop.xyz/aggregation-api/api-reference/quote
- Bebop — Settlement & Smart Contracts: https://docs.bebop.xyz/core-concepts/settlement-smart-contracts
- Bebop — Authentication: https://docs.bebop.xyz/core-concepts/authentication
- Bebop — Chains Availability: https://docs.bebop.xyz/supported-chains
- Relacionado: [[ADR-009-multi-chain-architecture]]
