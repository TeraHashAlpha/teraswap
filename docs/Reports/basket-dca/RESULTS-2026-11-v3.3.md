# Basket DCA — modelação v3.3: acções tokenizadas da Coinbase como pernas do Split DCA

**Pedido:** o dono (16 Nov 2026), depois da avaliação `claude/accoes-tokenizadas-base-avaliacao-2026-11-16.md`: listar as acções no swap (com aviso e bloqueio) e resolver o Split DCA com acções. **Pacote:** o mesmo; `python3 run_all.py --v33-only` refaz só esta parte; v2 a v3.2 não mudam (md5 dos relatórios: `bee70ee6`, `b2d00edb`, `dcf5387d`, `65078768`). Tabelas em `results/v33/`.

> Separação de sempre: **(a)** a garantia — a ordem completa? quanto fica por comprar? quanto se concentra num ciclo? — e **(b)** o preço pago: histórico, nunca promessa.

**0 — Correcção: o que o executor faz com um feed parado**

**Uma correcção ao que disse ao dono a 16 Nov.** Escrevi que, com o maxStaleness de 90 000 s, «o executor recusa as acções ao fim-de-semana». Não é assim. No `TeraSwapOrderExecutorV3.sol`, um feed parado não reverte nada: `_readFeedUsd` devolve `ok = false` e o piso do oráculo desaparece; fica só o mínimo assinado pelo utilizador (`scaledMin`), como para um par sem feed. Com 90 000 s, isso acontece em todos os fins-de-semana, a partir de 25 h depois da última ronda. A compra não pára; perde o piso do oráculo.

**2 — maxStaleness dos feeds das acções**

**Registar os feeds com maxStaleness de 360 000 s (100 h).** Os fechos do mercado 24/5 são de 48 h (fim-de-semana) e 72 h (fim-de-semana com feriado: 21 em 185 fechos desde Set 2023, pelo calendário da NYSE). A última ronda pode chegar até um heartbeat (24 h) antes do fecho, por isso a idade pode chegar às 96 h. Nos feeds reais da Coinbase, o maior silêncio foi de 81,6 h (fim-de-semana do Labor Day). Com 100 h, o último preço de fecho serve de piso em todos os fechos. Com 90 000 s, o piso desaparece a meio de cada fim-de-semana. **Custo:** na janela real, nenhuma compra de fim-de-semana falhou o piso de 3% (os preços DEX ficaram a ±1% do fecho: P5/P95). Na amostra longa, em 2,2% dos pares fecho × acção a reabertura ficou mais de 3,09% acima do fecho; só aí uma compra de fim-de-semana poderia ser recusada pelo piso, e só se o DEX já tivesse antecipado a subida. **O registo tem de ser executado num dia de mercado:** `executeTokenUsdFeed` exige `block.timestamp − updatedAt < 86400` («Feed seems dead»). **Isto vale também para o DCA simples** nestas acções: o registo dá-lhe o mesmo piso ao fim-de-semana.

**3 — Ciclos ao fim-de-semana e nos feriados**

**Recomendo a opção C: ao fim-de-semana e nos feriados, a perna da acção compra ao preço on-chain (DEX), e o keeper decide pelo preço do ADR-024, como em qualquer perna.** Na janela real (25 Ago – 15 Nov 2026, 112 304 posições, 8 cestos, todas as cadências): 0 posições incompletas, maior gasto num ciclo 25%. Na diária, 19% do capital das acções foi comprado com o mercado fechado. Face ao primeiro preço da reabertura, essas compras pagaram em média −0,18% (por posição: P5 −0,9%, P95 0,7%; pior compra +2,7%; histórico). **A opção A (a acção fica sem preço com o mercado fechado) tem de ser rejeitada.** Na semanal, um ciclo que caia ao sábado ou domingo cai sempre nesse dia, e a perna nunca compra: 35% das posições semanais ficaram incompletas (até 100% do capital). Na amostra longa (Set 2023 – Nov 2026) foram 28%. **A opção B (ciclos só em dias de mercado) também completa sempre** (0 incompletas, maior gasto num ciclo 25%). Mas atrasa as pernas cripto e reduz o N máximo da ordem: na diária, de 85 para 53 no pior arranque; na de 3 dias, de 25 para 15. É a alternativa se o dono não quiser comprar acções fora do horário dos EUA.

**4 — A regra 4 com o preço parado**

**O viés da regra 4 é desprezável e não pede regra nova.** O keeper decide pelo ADR-024 (feed só se a ronda tiver ≤ 600 s, senão DefiLlama). Nas acções isto quer dizer DefiLlama na maior parte das horas, mesmo com o mercado aberto: o feed decide em 5–11% das horas, consoante a acção. Ao fim-de-semana o preço DEX continua a mexer (pouco). Se o keeper decidisse pelo feed parado (0% de variação), a acção ganharia a primeira compra do ciclo em 39,7% dos ciclos fechados, contra 40,3% com o ADR-024 (cestos 2 cripto + 1 acção).

**5 — Splits e eventos corporativos**

**Splits e eventos corporativos: os feeds da Coinbase são de retorno total e não têm salto.** Maior variação entre rondas consecutivas, nas 7 acções: 6,6% (resultados de empresa, não splits). Não houve nenhum congelamento em dia útil na janela (os 13 fechos foram fins-de-semana e um feriado). **O perigo está num preço por acção.** O feed NVDA/USD da Arbitrum (per-share) mostra o split de 10:1 de 10 Jun 2024 como uma queda de 90%. Nas 940 posições ETH + BTC + NVDA que atravessam o split, esse preço disparou a regra 9 em 61% das posições, contra 0% com o preço ajustado. No modo suave ficaram 13 posições incompletas contra 0; no rígido, 802 contra 2 (até 50% por comprar). Cadências diária e de 3 dias. **Regras para o keeper:** (1) a perna de uma acção usa só preços do próprio token (o feed da Coinbase ou o DefiLlama/DEX do token), nunca um feed por acção; (2) quando o registo de oráculos da Coinbase tem a pausa ligada (evento corporativo), a perna fica «sem preço» nesse ciclo (ADR-024: salta o ciclo, nunca a ordem). O endereço e a ABI do registo não estão na documentação lida; o goal do keeper tem de os ler on-chain.

**6 — Que combinações de pernas**

**Todas as combinações completam com a opção C** (0 incompletas). Maior gasto num ciclo e capital das acções comprado com o mercado fechado: 2 cripto + 1 acção: 25% e 14%; 1 cripto + 2 acções: 25% e 22%; 3 acções: 25% e 32%; cripto + acção + stable: 25% e 11%; 2 acções + stable: 25% e 22%. Com três acções, todas as posições compraram alguma coisa com o mercado fechado. Com uma stable, a banda de 1% não bloqueou a USDT nenhuma vez neste período. Proposta: permitir todas, com no máximo uma stable, como hoje.


## 1. Os dados

*Todas as rondas on-chain até 16 Nov 2026 · 0,5% / 86 400 s, 24/5, retorno total · endereços do directório da Chainlink, iguais à página da Base; description() on-chain confere em 22 de 22 feeds · DEX = preço horário do token no DefiLlama (para INTCc e CRCLc é escasso e não serve: 100 e 118 pontos)*

| Feed «Coinbase X» (Base) | Tier Chainlink | Rondas | Desde | Maior silêncio (h) | Silêncios de 20–26 h com o mercado aberto | Maior passo entre rondas | DEX face ao feed, aberto: mediana / P95 | DEX face ao feed parado, fechado: P5 / P95 | Horas abertas em que o ADR-024 decide pelo feed |
|---|---|---|---|---|---|---|---|---|---|
| TSLA | custom | 1 565 | 2026-08-03 | 76,0 | 0 | 2,03% | 0,16% / 0,43% | −0,9% / 0,5% | 11% |
| AMZN | custom | 919 | 2026-08-03 | 75,9 | 2 | 6,58% | 0,16% / 0,44% | −1,1% / 0,4% | 6% |
| GOOGL | low | 885 | 2026-08-03 | 81,6 | 3 | 5,66% | 0,17% / 0,41% | −0,7% / 0,7% | 7% |
| SNDK | custom | 5 691 | 2026-08-03 | 75,7 | 0 | 7,40% | 0,17% / 0,76% | −2,6% / 1,2% | 27% |
| INTC | custom | 3 855 | 2026-08-03 | 76,1 | 0 | 6,59% | 0,81% / 9,76% | −2,5% / 2,6% | 22% |
| COIN | custom | 3 356 | 2026-08-03 | 76,0 | 0 | 2,15% | — | — | — |
| CRCL | custom | 4 683 | 2026-08-03 | 77,0 | 0 | 3,90% | 12,94% / 91,04% | −6,2% / 37,8% | 25% |
| META | custom | 1 456 | 2026-08-03 | 76,8 | 1 | 2,03% | 0,16% / 0,45% | −0,8% / 0,4% | 11% |
| MSTR | custom | 4 467 | 2026-08-03 | 74,5 | 0 | 5,37% | 0,17% / 0,63% | −8,0% / 2,3% | 29% |
| MSFT | custom | 818 | 2026-08-03 | 80,4 | 3 | 1,66% | 0,15% / 0,42% | −0,7% / 0,4% | 5% |
| NVDA | custom | 1 438 | 2026-08-03 | 77,9 | 0 | 3,29% | 0,16% / 0,46% | −0,9% / 0,7% | 10% |
| SPCX | custom | 3 406 | 2026-08-03 | 76,1 | 0 | 2,79% | 0,17% / 0,51% | −1,0% / 1,0% | 15% |
| AAPL | custom | 628 | 2026-08-03 | 76,0 | 4 | 2,11% | 0,15% / 0,43% | −0,5% / 0,4% | 5% |

**Lista oficial:** 358 tokens (`api.coinbase.com/v1/tokenized-stocks`, lida a 2026-11-16 13:31 UTC). Só 13 têm feed Chainlink na Base; os 7 com liquidez (NVDAc, GOOGLc, AMZNc, AAPLc, METAc, TSLAc, MSFTc) estão entre eles. **Feeds por acção na Arbitrum (NYSE, Chainlink, preço por acção):** desde Set 2023 (NVDA desde Abr 2024). Servem para a amostra longa e para o caso do split. Publicam alguns preços em dias fechados; o calendário de fechos vem por isso da NYSE (biblioteca `exchange_calendars`, guardado em `data/series/v33/xnys_sessions.csv`).

*Janela real · fechado = os 13 feeds da Coinbase calados ao mesmo tempo (cada um num silêncio de mais de 26 h)*

| Fecho começa (UTC) | Dia | Horas |
|---|---|---|
| 2026-08-22 01:00 | Saturday | 48 |
| 2026-08-28 21:00 | Friday | 52 |
| 2026-09-04 22:00 | Friday | 75 |
| 2026-09-12 00:00 | Saturday | 49 |
| 2026-09-19 00:00 | Saturday | 49 |
| 2026-09-26 00:00 | Saturday | 49 |
| 2026-10-03 00:00 | Saturday | 49 |
| 2026-10-09 20:00 | Friday | 53 |
| 2026-10-17 00:00 | Saturday | 49 |
| 2026-10-24 00:00 | Saturday | 49 |
| 2026-10-31 00:00 | Saturday | 50 |
| 2026-11-07 01:00 | Saturday | 49 |
| 2026-11-14 01:00 | Saturday | 47 |


## 2. maxStaleness

*Calendário da NYSE (XNYS) · 1 dia = feriado a meio da semana · 3 dias = fim-de-semana com feriado*

| Dias seguidos sem sessão | Fechos (Set 2023 – Nov 2026) | Horas de fecho no mercado 24/5 |
|---|---|---|
| 1 | 12 | 24 |
| 2 | 152 | 48 |
| 3 | 21 | 72 |

*Reabertura face ao último fecho, por acção, ajustado a splits · 7 acções · fecho às 16:00 ET, reabertura às 09:30 ET (inclui a sessão da noite; no 24/5 o salto é menor) · é o que um piso parado tem de absorver*

| Dias fechados | Fechos × acções | P1 | P5 | Mediana | P95 | P99 | Mín. | Máx. |
|---|---|---|---|---|---|---|---|---|
| 1 | 76 | −1,9% | −1,0% | 0,34% | 1,6% | 2,1% | −2,8% | 2,9% |
| 2 | 997 | −5,6% | −2,2% | 0,42% | 2,4% | 5,0% | −12,6% | 11,2% |
| 3 | 136 | −4,1% | −2,4% | −0,32% | 1,6% | 2,6% | −8,0% | 3,6% |

**Leitura.** Um maxStaleness de 100 h cobre todos os fechos normais, incluindo uma última ronda até 24 h antes do fecho. Quem passa disto é só um congelamento por evento corporativo, que o keeper trata pela pausa do registo. O preço de fecho como piso de 3% recusaria uma compra de fim-de-semana só se o DEX já estivesse mais de 3,09% acima do fecho. Na janela real isso não aconteceu nas 7 acções. Na MSTR, que segue o bitcoin, aconteceu em 1,9% das horas fechadas.


## 3. Ciclos com o mercado fechado

*Janela real, 25 Ago – 15 Nov 2026, hora a hora: arranques em todos os dias às 00, 06, 12 e 18 UTC · 8 cestos (secção 6) × 4 divisões · Split DCA da spec (L = 2, Hamilton, k_soft = ⌈N ÷ 4⌉, regra 9 a 25%, suave), 1 000 USD · N da grelha da v3.2 que cabe em (N + 4) × cadência < 90 dias e na janela · piso on-chain de 3% (o valor por defeito da app) · compra recusada pelo piso = sem compra nesse ciclo*

| Opção | Cadência | Posições | Incompletas | Máx. chunks · % por comprar | Maior gasto num ciclo: P95 / máx. | Compras nos ciclos extra (média) | Capital das acções comprado com o mercado fechado · posições com essas compras | Preço dessas compras face à reabertura: média (P5 / P95 por posição) · pior compra |
|---|---|---|---|---|---|---|---|---|
| A · a acção fica sem preço com o mercado fechado | diária | 74 160 | 71 (0,1%) | 1 · 20% | 40% / 73% | 0,43 | — | — |
|  | 3 dias | 34 608 | 0 (0,0%) | — | 33% / 53% | 0,22 | — | — |
|  | semanal | 3 536 | 1 251 (35,4%) | 6 · 100% | 25% / 67% | 0,07 | — | — |
| B · ciclos só em dias de mercado | diária | 42 496 | 0 (0,0%) | — | 20% / 25% | 0,00 | — | — |
|  | 3 dias | 13 280 | 0 (0,0%) | — | 25% / 25% | 0,00 | — | — |
|  | semanal | 2 080 | 0 (0,0%) | — | 25% / 25% | 0,00 | — | — |
| C · compra ao preço do DEX; piso on-chain até 90 000 s | diária | 74 160 | 0 (0,0%) | — | 20% / 25% | 0,00 | 19,0% · 92% | −0,18% (−0,9 / 0,7) · máx. 2,7% |
|  | 3 dias | 34 608 | 0 (0,0%) | — | 20% / 25% | 0,00 | 18,1% · 82% | −0,22% (−1,0 / 0,4) · máx. 1,6% |
|  | semanal | 3 536 | 0 (0,0%) | — | 25% / 25% | 0,00 | 16,9% · 40% | 0,09% (−0,5 / 0,7) · máx. 1,6% |
| C · compra ao preço do DEX; piso on-chain até 100 h | diária | 74 160 | 0 (0,0%) | — | 20% / 25% | 0,00 | 19,0% · 92% | −0,18% (−0,9 / 0,7) · máx. 2,7% |
|  | 3 dias | 34 608 | 0 (0,0%) | — | 20% / 25% | 0,00 | 18,1% · 82% | −0,22% (−1,0 / 0,4) · máx. 1,6% |
|  | semanal | 3 536 | 0 (0,0%) | — | 25% / 25% | 0,00 | 16,9% · 40% | 0,09% (−0,5 / 0,7) · máx. 1,6% |

*Opção B: a ordem conta só dias de mercado e tem de acabar (com os 3 ciclos extra) antes de 90 dias · todos os arranques possíveis do calendário XNYS, Set 2023 – Nov 2026*

| Cadência | N máximo hoje (calendário) | N máximo com a opção B, pior arranque | Mediana dos arranques |
|---|---|---|---|
| diária | 85 | 53 | 57 |
| 3 dias | 25 | 15 | 16 |
| semanal | 8 | 8 | 8 |

*Amostra longa, Set 2023 – Nov 2026, um tick por dia às 12:00 UTC, arranque dia sim dia não · acções = feed por acção da Arbitrum ajustado a splits (sem sessão da noite nem dividendos: aproximação) · só as opções A e B: sem preço DEX das acções antes de Ago 2026*

| Cesto | Opção | Cadência | Posições | Incompletas | Maior gasto num ciclo: P95 / máx. |
|---|---|---|---|---|---|
| ETH+BTC+NVDA | A | diária | 20 412 | 0 (0,0%) | 22% / 40% |
| ETH+BTC+NVDA | A | 3 dias | 14 524 | 0 (0,0%) | 25% / 40% |
| ETH+BTC+NVDA | A | semanal | 5 276 | 1 500 (28,4%) | 25% / 40% |
| ETH+BTC+NVDA | B | diária | 12 760 | 0 (0,0%) | 20% / 25% |
| ETH+BTC+NVDA | B | 3 dias | 8 560 | 0 (0,0%) | 20% / 32% |
| ETH+BTC+NVDA | B | semanal | 3 596 | 0 (0,0%) | 25% / 40% |
| ETH+NVDA+USDT | A | diária | 20 412 | 0 (0,0%) | 20% / 40% |
| ETH+NVDA+USDT | A | 3 dias | 14 524 | 0 (0,0%) | 22% / 40% |
| ETH+NVDA+USDT | A | semanal | 5 276 | 1 500 (28,4%) | 25% / 33% |
| ETH+NVDA+USDT | B | diária | 12 760 | 0 (0,0%) | 20% / 25% |
| ETH+NVDA+USDT | B | 3 dias | 8 560 | 0 (0,0%) | 20% / 27% |
| ETH+NVDA+USDT | B | semanal | 3 596 | 0 (0,0%) | 25% / 25% |
| NVDA+AAPL+MSFT | A | diária | 20 412 | 0 (0,0%) | 50% / 73% |
| NVDA+AAPL+MSFT | A | 3 dias | 14 524 | 0 (0,0%) | 38% / 73% |
| NVDA+AAPL+MSFT | A | semanal | 5 276 | 1 500 (28,4%) | 30% / 58% |
| NVDA+AAPL+MSFT | B | diária | 12 760 | 0 (0,0%) | 20% / 25% |
| NVDA+AAPL+MSFT | B | 3 dias | 8 560 | 0 (0,0%) | 20% / 25% |
| NVDA+AAPL+MSFT | B | semanal | 3 596 | 0 (0,0%) | 25% / 25% |

**Leitura.** A opção A deixa a perna da acção sem compra sempre que o ciclo cai num fecho. Na diária recupera, mas concentra (até 73% num ciclo com três acções). Na semanal, um arranque ao sábado ou domingo nunca compra a acção. A B e a C completam sempre. A C não mexe no calendário nem no N máximo, e compra ao fim-de-semana a preços que ficaram, em média, a menos de 0,3% da reabertura. A B é mais conservadora, mas encurta as ordens e atrasa as pernas cripto.


## 4. A regra 4 com o preço parado

*Cestos 2 cripto + 1 acção, janela real, ciclos com o mercado fechado e alguma compra · 1/3 seria uma escolha ao acaso*

| Decisão nos ciclos fechados | Primeira compra do ciclo que foi para a acção |
|---|---|
| C · compra ao preço do DEX; piso on-chain até 100 h | 40,3% |
| C com decisão no feed parado (só para medir o viés) | 39,7% |


## 5. Splits e eventos corporativos

*ETH + BTC + NVDA, opção A, cadências diária e de 3 dias, amostra longa · NVDA 10:1 a 10 Jun 2024, lido no próprio feed da Arbitrum (−90% numa ronda) · «ajustado» = dividido por 10 antes do split, como faz um feed de retorno total*

| Modo | Posições que atravessam o split | Regra 9 disparou: ajustado → por acção | Ciclos com a NVDA protegida (média) | Incompletas | Máx. por comprar (por acção) | Maior gasto num ciclo |
|---|---|---|---|---|---|---|
| suave | 940 | 0% → 61% | 0,0 → 8,5 | 0 → 13 | 12% | 40% → 40% |
| rígido | 940 | 0% → 85% | 0,0 → 8,5 | 2 → 802 | 50% | 40% → 25% |

**Leitura.** Com um preço por acção, um split parece uma queda de 90%. A protecção pausa a perna até ao fim (no suave, compra tudo na janela final; no rígido, fica por comprar). Os feeds da Coinbase não têm este problema, porque o multiplicador compensa o preço. O risco está num keeper ou numa fonte de quórum que use o preço por acção.


## 6. Combinações de pernas

*Janela real · cestos: ETH + cbBTC + NVDAc / AAPLc / TSLAc; ETH + NVDAc + MSFTc; NVDAc + AAPLc + MSFTc; AMZNc + GOOGLc + METAc; ETH + NVDAc + USDT; NVDAc + AAPLc + USDT*

| Combinação | Opção | Posições | Incompletas | Maior gasto num ciclo: P95 / máx. | Capital das acções comprado fechado · posições |
|---|---|---|---|---|---|
| 2 cripto + 1 acção | A · a acção fica sem preço com o mercado fechado | 45 628 | 634 (1,4%) | 25% / 40% | — |
|  | B · ciclos só em dias de mercado | 23 660 | 0 (0,0%) | 20% / 25% | — |
|  | C · compra ao preço do DEX; piso on-chain até 100 h | 45 628 | 0 (0,0%) | 20% / 25% | 13,7% · 82% |
| 1 cripto + 2 acções | A · a acção fica sem preço com o mercado fechado | 10 524 | 20 (0,2%) | 33% / 58% | — |
|  | B · ciclos só em dias de mercado | 5 268 | 0 (0,0%) | 20% / 25% | — |
|  | C · compra ao preço do DEX; piso on-chain até 100 h | 10 524 | 0 (0,0%) | 20% / 25% | 21,9% · 96% |
| 3 acções | A · a acção fica sem preço com o mercado fechado | 21 048 | 40 (0,2%) | 50% / 73% | — |
|  | B · ciclos só em dias de mercado | 10 536 | 0 (0,0%) | 20% / 25% | — |
|  | C · compra ao preço do DEX; piso on-chain até 100 h | 21 048 | 0 (0,0%) | 20% / 25% | 32,0% · 100% |
| cripto + acção + stable | A · a acção fica sem preço com o mercado fechado | 17 552 | 310 (1,8%) | 25% / 40% | — |
|  | B · ciclos só em dias de mercado | 9 196 | 0 (0,0%) | 20% / 25% | — |
|  | C · compra ao preço do DEX; piso on-chain até 100 h | 17 552 | 0 (0,0%) | 20% / 25% | 10,6% · 73% |
| 2 acções + stable | A · a acção fica sem preço com o mercado fechado | 17 552 | 318 (1,8%) | 33% / 67% | — |
|  | B · ciclos só em dias de mercado | 9 196 | 0 (0,0%) | 20% / 25% | — |
|  | C · compra ao preço do DEX; piso on-chain até 100 h | 17 552 | 0 (0,0%) | 20% / 25% | 21,6% · 93% |


## Testes

- `test_closures_are_weekends_and_one_holiday`: os fechos da janela real começam à sexta ou ao sábado, duram 40–80 h e só um passa de 60 h (Labor Day).
- `test_option_A_never_buys_a_stock_leg_while_the_market_is_closed`.
- `test_option_B_ticks_only_on_open_hours`.
- `test_the_floor_is_respected_whenever_the_feed_is_fresh`: nas opções C, nenhuma compra de acção acima de feed ÷ (1 − 3%) enquanto o feed está dentro do maxStaleness.
- `test_total_return_feeds_have_no_split_jump_and_the_raw_feed_shows_the_nvda_split`.
- Os 23 testes da v2 a v3.2 continuam a passar.


## O que não foi medido, e porquê

- **O registo de oráculos da Coinbase** (pausa por evento corporativo): a documentação diz que existe e que o feed o lê, mas não dá o endereço nem a ABI. Não houve nenhuma pausa na janela. O keeper tem de o ler on-chain.
- **A profundidade do DEX ao fim-de-semana para chunks grandes:** usei o preço horário do DefiLlama, sem impacto de preço. Nas posições modeladas (1 000 USD), um chunk de acção vai de dezenas a poucas centenas de USD, face a 0,5–2,5 M USD de liquidez por token.
- **Só um feriado na janela real** (Labor Day) e nenhum split: a amostra longa cobre 21 fins-de-semana com feriado e o split da NVDA, mas com preços por acção e sem a sessão da noite.
- **Dividendos:** entram no multiplicador e no feed de retorno total; não os simulei à parte.
- **Pernas cripto pelo DefiLlama horário** (não pelo Chainlink) nesta versão: a pergunta é sobre a perna da acção, e as cripto ficam iguais em todas as opções.
- **O mínimo assinado** (`scaledMin`) quando o piso do oráculo cai: depende do preço na criação da ordem e não foi modelado.
- **Os feeds da Arbitrum** publicam alguns preços em dias fechados; não os usei para o calendário.


## O que isto muda na spec (proposta)

1. **Registar os feeds «Coinbase X» das 7 acções com liquidez** com maxStaleness de 360 000 s (100 h), executando o registo num dia de mercado. São do tier «custom» (a GOOGL é «low»): decisão do dono.
2. **Split DCA com acções: opção C.** Ao fim-de-semana e nos feriados, a perna da acção compra ao preço on-chain; o keeper decide pelo ADR-024, sem regra nova.
3. **Keeper:** pausa do registo da Coinbase ligada → perna «sem preço»; nunca usar preços por acção.
4. **Todas as combinações de pernas**, com no máximo uma stable.
5. **Texto:** além do aviso do dono quando se escolhe uma acção, o Split DCA diz que a acção pode ser comprada com o mercado americano fechado, ao preço on-chain, e que o preço de referência é o último fecho.
6. **Se o dono preferir não comprar acções fora do horário dos EUA:** opção B, com o N máximo mais curto da secção 3.
