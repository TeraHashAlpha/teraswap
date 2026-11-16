# Basket DCA — modelação v2 (RESULTS-2026-11)

**Da Analista para o Arquitecto, o Auditor e o dono.** Gerado a 7 Nov 2026 por `python3 run_all.py`. Responde ao pedido `ANALISTA-basket-dca-modelacao-v2-2026-11-07.md` (rev. 2) sobre a definição em `claude/basket-dca-definicao-mecanismo.md` (regras 1–9, regra 3 corrigida). **Só cenários reais**: cada número vem de uma janela histórica concreta, com os preços que os feeds Chainlink publicaram de facto, lidos às 00:00 UTC — e, na §2.10, hora a hora nos movimentos bruscos dos últimos 5 anos. Nenhuma série sintética, nenhum choque inventado. 146 262 simulações; o script, as séries e todos os CSV estão neste directório.

> Como ler este relatório. Há duas coisas que nunca se misturam:
> **(a) O que o mecanismo garante** — que o capital é repartido exactamente como o utilizador pediu. É uma propriedade das regras, medida aqui em pontos percentuais de desvio.
> **(b) O que aconteceu ao valor da posição** — histórico, para documentar comportamento. Nunca é promessa, nunca é argumento de venda, e aparece sempre separado de (a).


## As oito respostas e a conclusão

**(i) 0% de desvio confirmado em todas as janelas, incluindo as de stress?**

**Sim.** Em 4 567 posições do Basket DCA (2.1–2.5, sem regra 9 ou com regra 9 em modo suave) o desvio máximo foi menor que 10⁻¹² pp — erro de vírgula flutuante, zero na prática. Inclui as 7 janelas de stress (Terra/Luna, FTX, SVB, yen carry, Q1 2025, a pior queda de 2025-26 e a subida violenta de Jul 2022). Com a regra 3 original o defeito de Julho reaparece com dados novos: desvio em 53% das posições, até 30,0 pp (nas 48 posições-âncora: 69%, até 4,5 pp; Julho tinha medido 77% e 23,3 pp). **Excepção legítima**: em modo rígido o desvio existe por desenho, porque há capital que fica por investir (§2.5).

**(ii) Mínimo de ciclos**

**6 ciclos como mínimo; 12 ou mais para a selecção pesar.** A premissa do §7.4 não se confirma: com a regra 3 corrigida a liquidação final nunca domina sem regra 9 — o último ciclo gasta ≈ 1/N do capital, como qualquer outro (excesso máximo 2,6 pp). O que se perde com poucos ciclos é escolha. A parte do capital decidida com ≥ 2 pernas elegíveis (mediana por cadência) vai de 67%–83% com 6 ciclos a 75%–83% com 12, 79%–92% com 26 e 89%–96% com 52. A curva é suave, sem degrau; a partir de 12 ciclos pelo menos três quartos do capital passam por uma decisão real em todas as cadências testadas. **A liquidação final domina, sim, mas por outra causa: a regra 9 em modo suave** (§2.5) — e aí o número de ciclos não ajuda.

**(iii) Limiar inicial recomendado e modo a sugerir no texto**

**Limiar inicial: 25%.** Nas janelas de stress disparou em 32% das posições — em S1, S2, S4, S5, S6 e nunca em S3 nem S7. Com 10–15% dispara em metade das posições, incluindo correcções normais, e no modo rígido chega a deixar 80% do capital parado. **Modo: nenhum por defeito** (decisão do dono), mas o texto tem de dizer o que cada um custa, com números: o rígido deixou por investir até 51% (mediana 0%); o suave cumpre sempre a divisão mas **adia e concentra**: chegou a comprar 37% do capital acima do normal num único último ciclo. Texto proposto no §2.5.

**(iv) Regra para o depeg**

**Perna stable inelegível sempre que o feed se afaste mais de 1% do peg (|preço − 1| > 0,01), independentemente do limiar do utilizador — e também na liquidação final, mesmo em modo suave.** Nos 1 803 ticks diários de 2021-12 a 2026-11 a banda de 1% só disparou no depeg real do USDC (12 Mar 2023) e nunca na USDT: zero falsos positivos. A regra 9 sozinha não chega (limiar ≥ 10% contra um feed que no tick diário marcou 0,968). E há um efeito pior que o depeg em si: a regra 9 nas pernas voláteis **empurra o orçamento para a stable**. O caso que fecha a questão é real: no colapso da UST, sem regra, a perna de 33% encheu-se de UST a 0,085 USD de média; com a banda, a UST deixou de ser comprada no tick em que saiu da banda.

**(v) A fase 2 pode abrir?**

**Pode abrir para tokens com o perfil do AERO, com quatro condições; não como regra geral para qualquer token sem feed.** A garantia não depende do preço: 0% de desvio com qualquer fonte. No AERO o DefiLlama (o que a fase 2 leria) seguiu a Coinbase de perto — mediana 7,9 bps, máximo 147 bps, nenhuma hora acima da tolerância de 300 bps — e a regra 4 tomou a mesma decisão em 99,96% dos ciclos. Dois avisos reais: o DefiLlama marcou o WETH da Base com +2 132 bps (+21%) a 29 Out 2026 21:00 UTC, que só o quórum apanha; e o feed AERO/USD da Chainlink (24 h, desvio de 0,5%) é **pior** para a regra 4 do que o DefiLlama — mudou 12% das decisões face à bolsa. A CoinGecko, o segundo membro do quórum, não tem histórico sem chave, por isso o quórum completo ficou por medir. Condições no §2.7.

**(vi) Capital mínimo por posição**

**Depende do número de ciclos, não da cadência: Cmín ≈ nº de fills × gas por fill ÷ 0,1%.** O Basket faz cerca de 1 fill por ciclo (máximo 1,08 por ciclo em posições de 26+ ciclos; 2,00 nas muito curtas), contra 3 do DCA fixo. Ao gas de mercado na Base, pior caso observado: 30 ciclos diários → 96 USD (rota canónica, 0,003 USD/fill) ou 512 USD (rota agregador, 0,016 USD/fill); 90 ciclos diários → 276 USD ou 1 472 USD; 12 ciclos semanais → 36 USD ou 192 USD. **Com o tier actual do keeper (1,5 gwei) nada disto fecha**: 30 ciclos diários pedem 24 000 USD a 125 760 USD. Corrigir o tier de gas por chain é pré-requisito do Basket, não um detalhe. Tabela no §2.9.

**(vii) Ticks horários em movimentos bruscos (> 15% numa hora)**

**Em 5 anos nunca houve uma hora em que o fecho do ETH, do BTC ou de uma stable curada mudasse mais de 15%** (máximos: ETH −11,9% a 3 Fev 2025 01:00 UTC, BTC −7,3%, USDC 6,6%). Só dentro da hora (mínimo vs máximo da vela, confirmado em duas bolsas) houve 5 episódios em ETH/BTC; a UST também passou os 15% (stable não curada) e o USDC ficou nos 14,6%. Corri **2 072 posições com ticks horários, de 4 em 4 h e diários à hora do evento** à volta desses 7 episódios: o desvio do Basket continuou a ser zero em todas. Um achado: **o feed Chainlink, que é o que o keeper lê, mostrou movimentos bem menores do que as bolsas** — no flash crash do BTC, 9,3% no feed contra ~20% na bolsa.

**(viii) Quantas vezes o Basket venceu os outros dois DCAs**

**Contra o DCA fixo (mesma divisão) é quase moeda ao ar.** Em posições de 30 dias a começar em cada dia de Mar 2022 a Out 2026: em alta volatilidade o Basket acabou à frente em 47% das vezes, em períodos normais em 59%, com diferença mediana de 0,1% do capital. **Contra o DCA só em ETH depende de o ETH subir ou cair**: venceu em 88% das posições em que o ETH caiu e em 26% das que subiu — é a stable a amortecer, não o mecanismo. Ficou à frente dos dois ao mesmo tempo em 28% (alta volatilidade) e 32% (normal) das posições. Isto confirma o §11: vende-se o cumprimento da divisão, nunca desempenho.

> **Conclusão honesta.** O objectivo do Basket não é bater um DCA de um token: é comprar vários activos melhor do que comprá-los todos por igual em cada ciclo. Medido assim — contra o DCA fixo de 3 pernas, com a mesma divisão — o resultado é este:
> **1. A garantia é sólida.** A divisão pedida é cumprida em todas as janelas, horas e cadências testadas, com dados reais.
> **2. A melhoria de preço existe, mas é pequena e só em mercado normal.** Em períodos normais o Basket comprou o ETH e o BTC mais barato do que o DCA fixo em 57% e 58% das posições, e acabou com mais valor em 59%. A diferença mediana é de 0,12% do capital — da ordem da própria fee de 0,1%.
> **3. Em alta volatilidade, quando o utilizador mais espera que «comprar na queda» ajude, a vantagem desaparece**: 47% das posições à frente, mediana −0,04%. Numa queda contínua, o activo que mais caiu tende a continuar a cair.
> **4. Medir «o mais desvalorizado face aos outros» de forma mais directa não ajuda** (§2.12): comparar cada perna com a sua média ou com o preço de entrada melhora pouco em mercado normal e piora em alta volatilidade, com perdas maiores nas caudas.
> **5. O que o Basket tem de real e mensurável**: cumpre a divisão, faz cerca de 1 compra por ciclo em vez de 3 (um terço do gas), e tem protecções (regra 9, banda de peg) que um DCA fixo não tem. Isto pode ser dito ao utilizador. Que compra «na melhor altura» ou «mais barato», não.


## 0. Dados e método

**Tick.** Cada ciclo lê o preço às 00:00 UTC do dia. O valor é a resposta da última ronda com `updatedAt ≤ T` — exactamente o que `latestRoundData()` devolveria a um keeper que lesse o proxy nesse instante. As rondas são lidas com `getRoundData((phaseId << 64) | roundId)` sobre o estado actual (os agregadores guardam todas as rondas), sem nó de arquivo.

**Endereços.** Nenhum foi escrito à mão. Cada feed é escolhido por código no directório oficial da Chainlink (entrada canónica com nome ENS, não escondida), cruzado por igualdade calculada com o repo (`dca-feed-registrations.json`, `chainlink-feeds.ts`, `constants.ts` no commit `50c142d90ba6`) e verificado on-chain por `description()` e `decimals()` antes de qualquer leitura (regra do ADR-018). **17/17 feeds confirmaram a identidade.**

*Feeds usados — verificação on-chain (data/series/feed_verification.csv)*

| Série | Rede | Proxy | description() | dec. | heartbeat (s) | no repo |
|---|---|---|---|---|---|---|
| ETH | arbitrum | `0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612` | ETH / USD | 8 | 1755 | sim |
| WBTC | arbitrum | `0xd0C7101eACbB49F3deCcCc166d238410D6D46d57` | WBTC / USD | 8 | 86400 | sim |
| USDC | arbitrum | `0x50834F3163758fcC1Df9973b6e91f0F0F0434aD3` | USDC / USD | 8 | 255 | sim |
| USDT | arbitrum | `0x3f3f5dF88dC9F13eac63DF89EC16ef6e7E25DdE7` | USDT / USD | 8 | 255 | sim |
| DAI | arbitrum | `0xc5C8E77B397E531B8EC06BFb0048328B30E9eCfB` | DAI / USD | 8 | 86400 | sim |
| SOL | arbitrum | `0x24ceA4b8ce57cdA5058b924B9B9987992450590c` | SOL / USD | 8 | 86400 | só directório |
| XRP | arbitrum | `0xB4AD57B52aB9141de9926a3e0C8dc6264c2ef205` | XRP / USD | 8 | 86400 | só directório |
| CRV | arbitrum | `0xaebDA2c976cfd1eE1977Eac079B4382acb849325` | CRV / USD | 8 | 3600 | sim |
| cbBTC | base | `0x07DA0E54543a844a80ABE69c8A12F22B3aA59f9D` | cbBTC / USD | 8 | 1200 | sim |
| AERO | base | `0x4EC5970fC728C5f65ba413992CD5fF6FD70fcfF0` | AERO / USD | 8 | 86400 | sim |
| UST_ETH | mainnet | `0xa20623070413d42a5C01Db2c8111640DD7A5A03a` | USTC / ETH | 18 | 86400 | só directório |
| ETH_mainnet | mainnet | `0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419` | ETH / USD | 8 | 3600 | sim |
| WBTC_BTC_mainnet | mainnet | `0xfdFD9C85aD200c506Cf9e21F1FD8dd01932FBB23` | WBTC / BTC | 8 | 86400 | só directório |
| BTC_mainnet | mainnet | `0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c` | BTC / USD | 8 | 3600 | só directório |
| SOL_mainnet | mainnet | `0x4ffC43a60e009B551865A93d232E33Fce9f01507` | SOL / USD | 8 | 86400 | só directório |
| CRV_mainnet | mainnet | `0xCd627aA160A6fA45Eb793D19Ef54f5062F20f33f` | CRV / USD | 8 | 86400 | só directório |
| ETH_base | base | `0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70` | ETH / USD | 8 | 1200 | sim |

**Uma fonte por perna e por posição, nunca misturada dentro da posição.** Prioridade, primeira que cobre a posição inteira:

- **Perna BTC**: cbBTC/USD (Base, existe desde 13 Set 2024) → WBTC/USD (Arbitrum, desde 25 Nov 2022) → WBTC/BTC × BTC/USD (Ethereum, a composição que o próprio repo usa em mainnet). **Nunca BTC spot em silêncio**: a coluna «fontes» de cada CSV diz qual foi usada.
- **SOL, CRV**: feed Arbitrum (desde 15 Fev 2022) → feed Ethereum. **XRP**: feed Arbitrum (desde 25 Ago 2022) → vela diária da Bitstamp (abertura 00:00 UTC), declarada como fonte de exchange — a Coinbase teve o XRP suspenso de Jan 2021 a Jul 2023.
- **ETH, USDC, USDT, DAI**: feeds Arbitrum. **UST** (caso extra do §2.6): USTC/ETH × ETH/USD na Ethereum.
- **Fase 2 (§2.7)**: DefiLlama `coins.llama.fi/chart` (a perna DefiLlama do quórum do keeper, historicamente), Coinbase Exchange (velas horárias) e o feed AERO/USD da Chainlink na Base, que existe mas o TeraSwap não regista.

**Escolhas de modelação** (iguais em todas as estratégias): capital de 1 000 USD por posição (o desvio é independente da escala); orçamento por ciclo = C/N; um ciclo sem pernas elegíveis é saltado e o dinheiro espera (ADR-024: «skip the cycle, never the order»); variação da regra 4 = preço(t)/preço(t−1 cadência) − 1, e no tick 0 contra o preço de uma cadência antes; cooldown da regra 5 só na perna vencedora primária; compras ao preço do feed no tick, sem slippage nem fee (a garantia testada é a divisão em USD, que não depende do preço de execução).


## 1. Base de comparação

Cada cenário corre quatro estratégias no mesmo capital, na mesma janela e na mesma cadência:

- **A — Basket DCA**: regras 1–9 com a regra 3 corrigida.
- **A0 — regra 3 original** (Julho): o ciclo inteiro vai para a vencedora, sem rolar o remanescente; a liquidação final ainda respeita o cooldown. Só existe para mostrar o defeito com dados novos.
- **B — DCA fixo por 3 pernas**: cada ciclo compra as três na proporção, sem selecção. É o «outro produto» do §8 fase 3.
- **C — DCA simples em ETH**, como referência. O desvio de C face à repartição não se aplica (é 100 − w(ETH) por construção).


## 2.1 Janelas de stress

*Cada janela × 4 repartições × cadência diária e semanal × (janela inteira, 30 dias a partir do pior dia de ETH)*

| # | Janela | Datas (UTC) | ETH mín. vs início | Vol. realizada (anual.) | Perna BTC | Posições | Desvio A máx. (pp) | A0: % com desvio · máx. pp |
|---|---|---|---|---|---|---|---|---|
| S1 | Terra/Luna + Celsius | 5 Mai 2022 – 20 Jun 2022 | −66% | 115% | WBTC/BTC × BTC/USD · Ethereum | 16 | 0 | 75% · 15,0 |
| S2 | FTX | 2 Nov 2022 – 30 Nov 2022 | −30% | 121% | WBTC/BTC × BTC/USD · Ethereum | 16 | 0 | 69% · 15,0 |
| S3 | SVB / depeg USDC | 9 Mar 2023 – 20 Mar 2023 | −7% | 79% | WBTC/USD · Arbitrum | 16 | 0 | 62% · 25,0 |
| S4 | Yen carry unwind | 29 Jul 2024 – 15 Ago 2024 | −29% | 106% | WBTC/USD · Arbitrum | 16 | 0 | 62% · 16,7 |
| S5 | Correcção Q1 2025 | 1 Fev 2025 – 15 Abr 2025 | −55% | 92% | cbBTC/USD · Base | 16 | 0 | 75% · 15,0 |
| S6 | Pior queda de 30 d do ETH em 2025-26 (−45,7% entre 15/1 e 6/2/2026) | 15 Jan 2026 – 14 Fev 2026 | −46% | 100% | cbBTC/USD · Base | 16 | 0 | 69% · 15,0 |
| S7 | Maior volatilidade de 30 d fora de S1–S6 (subida pós-Celsius) | 29 Jun 2022 – 28 Jul 2022 | −9% | 111% | WBTC/BTC × BTC/USD · Ethereum | 16 | 0 | 44% · 30,0 |

**S6** escolhida por código: maior queda de ETH com o fundo até 30 dias depois do pico, picos entre 1 Mai 2025 e 6 Nov 2026 — Pior queda de 30 d do ETH em 2025-26 (−45,7% entre 15/1 e 6/2/2026). Janela = do pico a 30 dias depois. **S7** acrescentada pelo critério do pedido: é a janela de 30 dias com a maior volatilidade realizada fora de S1–S6 (111% anualizada, 29 Jun – 28 Jul 2022), acima de S3, S4, S5 e S6. Nenhuma janela fora de S1–S6 supera S1 e S2. S7 tem uma vantagem: é volatilidade **a subir** (ETH +50% no mês), um regime que as outras não testam. A volatilidade da tabela é a das rentabilidades diárias dentro de cada janela.

![Gráfico T1 · A divisão pedida é a divisão obtida, nas 112 posições de stress; a regra 3 original espalha-se à volta do alvo](charts/T1-divisao-cumprida.svg)

*Gráfico T1 · A divisão pedida é a divisão obtida, nas 112 posições de stress; a regra 3 original espalha-se à volta do alvo* — dados: [`charts/T1-divisao-cumprida.csv`](charts/T1-divisao-cumprida.csv)

![Gráfico T2 · Para onde foi cada ciclo em S1 (Terra/Luna + Celsius): uma compra por ciclo, dividida só quando a vencedora atinge o alvo](charts/T2-para-onde-foi-cada-ciclo.svg)

*Gráfico T2 · Para onde foi cada ciclo em S1 (Terra/Luna + Celsius): uma compra por ciclo, dividida só quando a vencedora atinge o alvo* — dados: [`charts/T2-para-onde-foi-cada-ciclo.csv`](charts/T2-para-onde-foi-cada-ciclo.csv)


### O que aconteceu ao valor (histórico, não é promessa)

*Variação do valor da posição no fim da janela inteira, cadência diária · mín / mediana / máx sobre as 4 repartições*

| # | A — Basket (%) | B — DCA fixo (%) | C — só ETH (%) | A: drawdown máx. mediano (%) |
|---|---|---|---|---|
| S1 | −24,3 / −21,4 / −19,2 | −25,8 / −20,4 / −16,1 | −36,2 / −36,2 / −36,2 | 25,2 |
| S2 | −4,9 / −4,5 / −4,4 | −4,2 / −3,3 / −2,6 | −4,8 / −4,8 / −4,8 | 8,5 |
| S3 | 11,1 / 11,5 / 12,3 | 7,6 / 9,5 / 11,9 | 10,3 / 10,3 / 10,3 | 1,0 |
| S4 | −2,7 / −2,6 / −2,5 | −3,0 / −2,4 / −1,9 | −4,1 / −4,1 / −4,1 | 7,0 |
| S5 | −10,3 / −10,0 / −9,3 | −11,1 / −8,8 / −7,0 | −23,8 / −23,8 / −23,8 | 15,2 |
| S6 | −12,8 / −12,6 / −12,5 | −13,3 / −10,5 / −8,3 | −18,9 / −18,9 / −18,9 | 17,1 |
| S7 | 13,0 / 13,8 / 14,3 | 9,8 / 12,5 / 15,8 | 30,1 / 30,1 / 30,1 | 5,1 |

A e B ficam sempre perto um do outro, porque as duas compram a mesma divisão; a diferença está em **quando** cada perna é comprada. O gráfico T4 mostra que essa diferença não tem sinal fixo: o Basket pagou em mediana um pouco mais pelo ETH e um pouco menos pelo BTC do que o DCA fixo. **Isto confirma a nota de linguagem do §11: o mecanismo garante a repartição, não um preço melhor.**

![Gráfico T4 · Preço médio pago pelo Basket face ao DCA fixo, posição a posição — histórico, sem sinal fixo](charts/T4-preco-medio-A-vs-B.svg)

*Gráfico T4 · Preço médio pago pelo Basket face ao DCA fixo, posição a posição — histórico, sem sinal fixo* — dados: [`charts/T4-preco-medio-A-vs-B.csv`](charts/T4-preco-medio-A-vs-B.csv)


## 2.2 Reprodução de Julho com dados actuais (âncora)

Os três meses de maior volatilidade realizada de ETH em cada ano, recalculados com as séries novas:

| Ano | Meses (vol. anualizada) |
|---|---|
| 2022 | Jun (118%), Nov (117%), Jul (107%) |
| 2023 | Mar (64%), Nov (60%), Jan (52%) |
| 2024 | Ago (88%), Nov (81%), Mai (77%) |
| 2025 | Mar (95%), Abr (93%), Ago (91%) |

| Variante | Posições A | Desvio A máx. (pp) | A0 com desvio | A0 desvio máx. (pp) | Fontes da 2.ª/3.ª perna |
|---|---|---|---|---|---|
| ETH + BTC + USDC (48 posições-âncora) | 48 | 0 | 69% | 4,5 | WBTC/BTC × BTC/USD · Ethereum; WBTC/USD · Arbitrum; cbBTC/USD · Base |
| ETH + BTC + USDT | 48 | 0 | 69% | 4,5 | USDT/USD · Arbitrum; WBTC/BTC × BTC/USD · Ethereum; WBTC/USD · Arbitrum; cbBTC/USD · Base |
| Ciclos curtos: posições de 5 ticks diários | 288 | 0 | 71% | 30,0 | WBTC/BTC × BTC/USD · Ethereum; WBTC/USD · Arbitrum; cbBTC/USD · Base |
| ETH + SOL + USDC | 48 | 0 | 69% | 4,5 | SOL/USD · Arbitrum |
| ETH + XRP + USDC | 48 | 0 | 69% | 4,5 | Bitstamp XRP/USD (abertura da vela diária, 00:00 UTC); XRP/USD · Arbitrum |
| ETH + CRV + USDC | 48 | 0 | 69% | 4,5 | CRV/USD · Arbitrum |

**Confirmado**: 0% de desvio em todas as variantes com a regra 3 corrigida. **O defeito de Julho reproduz-se**: nas 48 posições-âncora a regra original desvia em 69% delas, até 4,5 pp (Julho: 77%, 23,3 pp). **O defeito é sobretudo aritmético, não de mercado**: o excesso nasce de o último pagamento de cada perna valer um orçamento inteiro, e depende de w × N. Trocar as pernas quase não o muda (diferença entre variantes na mesma posição: mediana 0 pp, máximo 3,5 pp). O máximo de 23,3 pp de Julho não se reproduz com posições mensais diárias; aparece, e é ultrapassado, nas posições curtas (até 30,0 pp) e semanais (§2.3). A definição exacta das posições de Julho perdeu-se com os ficheiros originais.


## 2.3 Janela recente (Jul–Out 2026)

*Uma posição a começar em cada dia de 1 Jul a 15 Out 2026, terminando até 6 Nov 2026 · ETH + cbBTC + USDC · 4 repartições*

| Duração | Cadência | Posições A | Desvio A máx. (pp) | A0 com desvio | A0 máx. (pp) | Fills A (mediana) |
|---|---|---|---|---|---|---|
| 30 dias | diária | 400 | 0 | 25% | 3,3 | 30 |
| 30 dias | semanal | 400 | 0 | 69% | 30,0 | 7 |
| 60 dias | diária | 280 | 0 | 0% | 0,0 | 60 |
| 60 dias | semanal | 280 | 0 | 75% | 16,7 | 11 |
| 90 dias | diária | 160 | 0 | 25% | 1,1 | 90 |
| 90 dias | semanal | 160 | 0 | 100% | 11,5 | 15 |

Com o mercado de agora o comportamento é o mesmo: 0% de desvio. A regra original falha sobretudo em cadência semanal, onde cada ciclo pesa mais.

![Gráfico N2 · Dispersão do desvio final por estratégia, em todas as posições de 2.1, 2.2 e 2.3](charts/N2-desvio-por-estrategia.svg)

*Gráfico N2 · Dispersão do desvio final por estratégia, em todas as posições de 2.1, 2.2 e 2.3* — dados: [`charts/N2-desvio-por-estrategia.csv`](charts/N2-desvio-por-estrategia.csv)


## 2.4 Cadência e duração

*Parte do capital decidida com ≥ 2 pernas elegíveis · mediana (mín–máx) · 33-33-33 · uma posição a começar em cada dia da janela*

| Janela de início | Cadência | 6 ciclos | 12 ciclos | 26 ciclos | 52 ciclos |
|---|---|---|---|---|---|
| S5 (Fev–Abr 2025, stress) | 1 d | 75% (67–83) · n=74 | 83% (67–92) · n=74 | 87% (76–95) · n=74 | 89% (81–95) · n=74 |
| S5 (Fev–Abr 2025, stress) | 3 d | 67% (67–83) · n=74 | 75% (67–92) · n=74 | 79% (72–95) · n=74 | 89% (79–98) · n=74 |
| S5 (Fev–Abr 2025, stress) | 7 d | 83% (67–83) · n=74 | 75% (67–92) · n=74 | 87% (72–95) · n=74 | 96% (85–98) · n=74 |
| Jul–Out 2026 (calma) | 1 d | 67% (67–83) · n=107 | 83% (67–92) · n=107 | 92% (79–95) · n=104 | 95% (89–98) · n=78 |
| Jul–Out 2026 (calma) | 3 d | 83% (67–83) · n=107 | 83% (67–92) · n=96 | 87% (76–95) · n=54 | não cabe nos dados |
| Jul–Out 2026 (calma) | 7 d | 67% (67–83) · n=94 | 75% (67–92) · n=52 | não cabe nos dados | não cabe nos dados |

**A pergunta mudou de natureza.** O §7.4 dizia que abaixo de ~6 ciclos «a liquidação final domina». Com a regra 3 corrigida isso não acontece: cada ciclo gasta o orçamento inteiro (rolando o remanescente), por isso o último ciclo compra ≈ 1/N, como qualquer outro — o excesso máximo observado foi 2,6 pp. A liquidação final só domina quando há ciclos saltados, e isso é obra da regra 9 (§2.5), não do número de ciclos. O que o número de ciclos controla é a **margem de escolha**: nos últimos ciclos as pernas já trancaram e a compra é forçada. Daí a recomendação: 6 ciclos como mínimo, 12 ou mais para a selecção pesar.

![Gráfico E1 · Capital decidido por escolha real, por nº de ciclos e cadência](charts/E1-escolha-vs-ciclos.svg)

*Gráfico E1 · Capital decidido por escolha real, por nº de ciclos e cadência* — dados: [`charts/E1-escolha-vs-ciclos.csv`](charts/E1-escolha-vs-ciclos.csv)


## 2.5 Regra 9 — limiar e modo

*S1–S7 × 4 repartições × diária/semanal × (janela, 30 d após o pior dia) = 112 posições por linha e por modo*

| Limiar | Posições onde disparou | Ticks protegidos, quando dispara (mediana) | Rígido: por investir % (med/máx) | Rígido: desvio máx. pp | Suave: compra extra no último ciclo % (med/máx) | Suave: desvio máx. pp |
|---|---|---|---|---|---|---|
| 10% | 50% | 15 | 0,0 / 80,0 | 40,0 | 0,0 / 73,6 | 0 |
| 15% | 46% | 12 | 0,0 / 80,0 | 40,0 | 0,0 / 69,4 | 0 |
| 20% | 36% | 10 | 0,0 / 80,0 | 40,0 | 0,0 / 67,2 | 0 |
| 25% | 32% | 7 | 0,0 / 51,4 | 40,0 | 0,0 / 37,4 | 0 |
| 30% | 25% | 7 | 0,0 / 33,6 | 33,6 | 0,0 / 31,5 | 0 |

![Gráfico N3 · Mapa limiar × modo, uma linha por janela de stress](charts/N3-limiar-x-modo.svg)

*Gráfico N3 · Mapa limiar × modo, uma linha por janela de stress* — dados: [`charts/N3-limiar-x-modo.csv`](charts/N3-limiar-x-modo.csv)

**O achado mais importante desta secção é sobre o modo suave.** «Suave» não quer dizer «protecção leve». Quer dizer: deixa de comprar enquanto a perna está protegida e **compra tudo de uma vez no último ciclo**. Em S1 com limiar de 20%, a posição comprou USDC nas primeiras semanas, ficou parada e no último dia comprou mais de metade do capital em ETH e WBTC, com o ETH 60% abaixo da entrada (gráfico N1). A divisão é cumprida ao cêntimo; o preço desse último dia é o que calhar.

![Gráfico N1 · Caminho da repartição em S1, modo suave, limiar 20%: preço face à entrada, compras por ciclo e convergência para o alvo, com cooldown (regra 5), lock (regra 6) e protecção (regra 9)](charts/N1-caminho-da-reparticao-S1-suave.svg)

*Gráfico N1 · Caminho da repartição em S1, modo suave, limiar 20%: preço face à entrada, compras por ciclo e convergência para o alvo, com cooldown (regra 5), lock (regra 6) e protecção (regra 9)* — dados: [`charts/N1-caminho-da-reparticao-S1-suave.csv`](charts/N1-caminho-da-reparticao-S1-suave.csv)

![Gráfico T3 · A mesma posição em modo rígido: a protecção pára as compras e o capital fica por investir](charts/T3-proteccao-S1-rigido.svg)

*Gráfico T3 · A mesma posição em modo rígido: a protecção pára as compras e o capital fica por investir* — dados: [`charts/T3-proteccao-S1-rigido.csv`](charts/T3-proteccao-S1-rigido.csv)

**Recomendação: valor inicial 25%.** É o ponto onde a protecção dispara nas quedas grandes (32% das posições, todas em S1, S2, S5 ou S6) e fica calada nas correcções e no ruído; com 10–15% dispara em metade das posições. Abaixo de 25% o custo cresce depressa no modo rígido (máximo por investir: 80% com 10%, 51% com 25%, 34% com 30%).

**Texto proposto para a escolha do modo** (o utilizador escolhe, sem default):

> **Rígido** — Se uma perna cair mais do que o limiar face ao preço de entrada, deixamos de a comprar até recuperar, até ao fim. Pode ficar capital por investir, que continua na tua carteira. Nas quedas de 2022–2026, com limiar de 25%, ficou por investir até 51% do capital.
> **Suave** — Pausamos as compras dessa perna enquanto estiver abaixo do limiar, mas no último ciclo completamos sempre a divisão que pediste. Isso pode significar comprar de uma só vez, ao preço desse dia, a parte que ficou adiada: nas mesmas quedas, até 37% do capital acima de um ciclo normal.


## 2.6 Depeg da perna stable — só eventos reais

*33-33-33 · diária · posição de 30 d antes a 30 d depois do evento · capital 1 000 USD*

| Evento | Mín. no tick diário | Mín. horário do feed | USD na stable durante o evento: A vs B | … A com regra 9 a 10% | Preço médio pago pela stable (A) |
|---|---|---|---|---|---|
| USDC · SVB (9–13 Mar 2023) | 0,9684 | 0.8849 às 2023-03-11T08:00 | 30,8 vs 30,8 | 46,2 | 0,998 |
| DAI · exposição a USDC (11–13 Mar 2023) | 0,9703 | 0.8976 às 2023-03-11T08:00 | 31,7 vs 21,2 | 31,7 | 0,998 |
| USDT · contágio Terra (12 Mai 2022) | 0,9960 | 0.9780 às 2022-05-12T07:00 | 16,4 vs 10,9 | 32,8 | 1,000 |
| UST · Terra, o peg nunca voltou (7–13 Mai 2022) | 0,0150 | — | 29,9 vs 39,8 | 44,8 | 0,085 |

**O que os dados mostram.**

- **A hora do tick decide o que se vê.** O feed USDC/USD marcou 0,885 às 08:00 UTC de 11 Mar 2023, mas o tick das 00:00 só viu 0,968 (12 Mar). Um keeper que leia à hora errada compra USDC a 0,89 ou nem nota o depeg.
- **A regra 4 compra a stable quando ela cai** — é «quem mais caiu». No USDC e na USDT a aposta correu bem porque o peg voltou em dias. Na UST não voltou: sem regra, a perna de 33% foi preenchida a 0,085 USD de média, e 30 dias depois do fim da posição a UST valia 0,048.
- **A regra 9 empurra dinheiro para a stable.** Quando ETH e BTC ficam protegidos, a stable é a única elegível e recebe o orçamento. Com limiar de 10%, a compra de UST durante o colapso subiu de 29,9 para 44,8 USD. As duas protecções interagem e a pior combinação é exactamente a do depeg.
- **A regra 9 com entry ≈ 1 só trava a stable com limiar ≤ 10% e no tick certo**: o USDC só esteve abaixo de 0,90 numa hora de todo o evento.

*Antes/depois · USD comprados da stable durante o evento · preço médio da stable · capital por investir no fim · 33-33-33 · diária*

| Evento | Posição | Sem regra | Banda 1% · fim suave | Banda 1% · fim rígido (proposta) |
|---|---|---|---|---|
| USDC-2023 | ±30 d | 30,8 USD · méd. 0,998 · por investir 0,0% | 15,4 USD · méd. 0,999 · por investir 0,0% | 15,4 USD · méd. 0,999 · por investir 0,0% |
| USDC-2023 | termina no pior tick | 75,3 USD · méd. 0,997 · por investir 0,0% | 75,3 USD · méd. 0,997 · por investir 0,0% | 43,0 USD · méd. 1,000 · por investir 3,2% |
| DAI-2023 | ±30 d | 31,7 USD · méd. 0,998 · por investir 0,0% | 15,9 USD · méd. 0,999 · por investir 0,0% | 15,9 USD · méd. 0,999 · por investir 0,0% |
| DAI-2023 | termina no pior tick | 43,0 USD · méd. 0,998 · por investir 0,0% | 43,0 USD · méd. 0,998 · por investir 0,0% | 21,5 USD · méd. 1,000 · por investir 2,2% |
| USDT-2022 | ±30 d | 16,4 USD · méd. 1,000 · por investir 0,0% | 16,4 USD · méd. 1,000 · por investir 0,0% | 16,4 USD · méd. 1,000 · por investir 0,0% |
| USDT-2022 | termina no pior tick | 32,3 USD · méd. 1,000 · por investir 0,0% | 32,3 USD · méd. 1,000 · por investir 0,0% | 32,3 USD · méd. 1,000 · por investir 0,0% |
| UST-2022 | ±30 d | 29,9 USD · méd. 0,085 · por investir 0,0% | 0,0 USD · méd. 0,025 · por investir 0,0% | 0,0 USD · méd. 1,002 · por investir 19,9% |
| UST-2022 | termina no pior tick | 43,0 USD · méd. 0,971 · por investir 0,0% | 107,5 USD · méd. 0,350 · por investir 0,0% | 21,5 USD · méd. 1,001 · por investir 8,6% |

*Calibração da banda: quantas leituras do feed ficaram fora de ±banda em torno de 1 (diário: falsos positivos; horário: o que um fill a essa hora veria)*

| Stable | Âmbito | Leituras | Banda | Fora da banda | Quando / mínimo |
|---|---|---|---|---|---|
| USDC | ticks diários 2021-12-01–2026-11-07 | 1803 | 0,5% | 2 | 2023-03-12, 2023-03-13 |
| USDC | ticks diários 2021-12-01–2026-11-07 | 1803 | 1,0% | 1 | 2023-03-12 |
| USDC | ticks diários 2021-12-01–2026-11-07 | 1803 | 2,0% | 1 | 2023-03-12 |
| USDC | horário 2023-03-01–2023-03-25 | 577 | 0,5% | 61 | mín 0.8849 às 2023-03-11T08:00 |
| USDC | horário 2023-03-01–2023-03-25 | 577 | 1,0% | 48 | mín 0.8849 às 2023-03-11T08:00 |
| USDC | horário 2023-03-01–2023-03-25 | 577 | 2,0% | 43 | mín 0.8849 às 2023-03-11T08:00 |
| USDC | horário 2023-03-01–2023-03-25 | 577 | 10,0% | 1 | mín 0.8849 às 2023-03-11T08:00 |
| USDT | ticks diários 2021-12-01–2026-11-07 | 1803 | 0,5% | 2 | 2023-03-12, 2023-03-13 |
| USDT | ticks diários 2021-12-01–2026-11-07 | 1803 | 1,0% | 0 | — |
| USDT | ticks diários 2021-12-01–2026-11-07 | 1803 | 2,0% | 0 | — |
| USDT | horário 2022-05-01–2022-05-25 | 577 | 0,5% | 10 | mín 0.9780 às 2022-05-12T07:00 |
| USDT | horário 2022-05-01–2022-05-25 | 577 | 1,0% | 5 | mín 0.9780 às 2022-05-12T07:00 |
| USDT | horário 2022-05-01–2022-05-25 | 577 | 2,0% | 1 | mín 0.9780 às 2022-05-12T07:00 |
| USDT | horário 2022-05-01–2022-05-25 | 577 | 10,0% | 0 | mín 0.9780 às 2022-05-12T07:00 |
| DAI | ticks diários 2022-12-01–2023-06-30 | 212 | 0,5% | 2 | 2023-03-12, 2023-03-13 |
| DAI | ticks diários 2022-12-01–2023-06-30 | 212 | 1,0% | 1 | 2023-03-12 |
| DAI | ticks diários 2022-12-01–2023-06-30 | 212 | 2,0% | 1 | 2023-03-12 |
| DAI | horário 2023-03-01–2023-03-25 | 577 | 0,5% | 60 | mín 0.8976 às 2023-03-11T08:00 |
| DAI | horário 2023-03-01–2023-03-25 | 577 | 1,0% | 48 | mín 0.8976 às 2023-03-11T08:00 |
| DAI | horário 2023-03-01–2023-03-25 | 577 | 2,0% | 42 | mín 0.8976 às 2023-03-11T08:00 |
| DAI | horário 2023-03-01–2023-03-25 | 577 | 10,0% | 1 | mín 0.8976 às 2023-03-11T08:00 |

**Recomendação concreta (iv):**

1. **Banda de peg de 1%**: a perna stable é inelegível sempre que |preço do feed − 1| > 0,01, nos dois sentidos, independentemente do limiar e do modo escolhidos pelo utilizador. Nos 1 803 ticks diários de 2021-12 a 2026-11 a banda disparou só no depeg real do USDC; na USDT, nunca (zero falsos positivos). No contágio de Mai 2022 a USDT saiu da banda de 1% durante cinco horas (mínimo 0,978 às 07:00 UTC de 12 Mai); com 2% teria saído uma hora só.
2. **Também na liquidação final, mesmo em modo suave**: uma stable fora da banda no último ciclo não é comprada; o remanescente fica por investir e o utilizador é avisado. É o único caso em que o modo suave não completa a divisão, e o caso UST mostra porquê.
3. **Avaliar a banda na hora do fill**, com o feed da stable (USDC/USD e USDT/USD na Arbitrum actualizam a cada ~255 s desde 2026-Q2), e não num preço guardado no início do ciclo.
4. **Para o Arquitecto**: uma stable bloqueada pela banda deve contar como «sem preço utilizável» para efeitos do ADR-024 (saltar a compra dessa perna), nunca como preço válido.

![Gráfico E2 · Depeg da perna stable: preço no tick e USD comprados por ciclo, sem regra (cinzento) e com a banda (cor)](charts/E2-depeg-stable.svg)

*Gráfico E2 · Depeg da perna stable: preço no tick e USD comprados por ciclo, sem regra (cinzento) e com a banda (cor)* — dados: [`charts/E2-depeg-stable.csv`](charts/E2-depeg-stable.csv)


## 2.7 Qualidade do preço — feed vs quórum, com diferenças reais

**Token escolhido: AERO.** Entre os tokens do catálogo da Base sem feed registado no TeraSwap, o volume do catálogo é volume global da CoinGecko: AAVE, ZRO e CRV vêm à frente, mas o volume deles é quase todo noutras redes. O AERO é o de maior volume nativo da Base, e tem três séries reais independentes para triangular: DefiLlama (o que a fase 2 leria), Coinbase (bolsa) e um feed AERO/USD da Chainlink que existe na Base mas não está registado no executor. **ETH** serve de calibração, onde o feed é o que o keeper já usa.

*Hora a hora, 1 Jul – 6 Nov 2026 · DefiLlama alinhado à hora certa (±10 min) · Coinbase = abertura da vela horária · Chainlink = última ronda ≤ T*

| Token | Par de fontes | Horas | |Δ| mediana (bps) | P95 | P99 | Máx. | Pior hora (UTC) | > 100 bps | > 300 bps | Desfasamento |
|---|---|---|---|---|---|---|---|---|---|---|
| AERO | DefiLlama (fase 2) vs Coinbase | 3094 | 7,9 | 36,0 | 62,9 | 147 | 2026-11-04 02:00 | 7 | 0 | 0 h · ρ 0,97 |
| AERO | DefiLlama (fase 2) vs Chainlink | 3094 | 15,6 | 43,5 | 62,1 | 161 | 2026-10-25 12:00 | 7 | 0 | 0 h · ρ 0,95 |
| AERO | Chainlink vs Coinbase | 3096 | 16,8 | 48,0 | 61,8 | 176 | 2026-11-04 02:00 | 1 | 0 | 0 h · ρ 0,95 |
| ETH | DefiLlama (fase 2) vs Coinbase | 3096 | 4,3 | 16,8 | 31,3 | 2 132 | 2026-10-29 21:00 | 1 | 1 | 0 h · ρ 0,67 |
| ETH | DefiLlama (fase 2) vs Chainlink | 3096 | 4,9 | 16,6 | 29,5 | 2 114 | 2026-10-29 21:00 | 1 | 1 | 0 h · ρ 0,67 |
| ETH | Chainlink vs Coinbase | 3096 | 4,3 | 13,4 | 18,6 | 60 | 2026-08-22 02:00 | 0 | 0 | 0 h · ρ 0,98 |

*Posições da janela 2.3 (início diário 1 Jul–15 Out 2026; 30/60/90 d; diária/semanal; 4 repartições) · as compras são sempre valorizadas ao preço da referência*

| Token | Fonte da decisão | Posições | Decisões da regra 4 que mudam (mediana / máx.) | Desvio máx. (pp) | Preço médio da perna vs referência, bps (mediana / máx. |Δ|) |
|---|---|---|---|---|---|
| AERO | Chainlink (referência: Coinbase) | 1584 | 0% / 86% | 0 | 0,0 / 1 170 |
| AERO | DefiLlama (fase 2) (referência: Coinbase) | 1584 | 0% / 21% | 0 | 0,0 / 380 |
| ETH | Coinbase (referência: Chainlink) | 1584 | 0% / 75% | 0 | 0,0 / 1 925 |
| ETH | DefiLlama (fase 2) (referência: Chainlink) | 1584 | 0% / 75% | 0 | 0,0 / 1 925 |

**Leitura.**

- **A garantia não depende da fonte**: 0% de desvio com qualquer das três séries. O que muda é **quando** cada perna é comprada.
- **A fonte que muda decisões não é a que se esperava.** O DefiLlama e a Coinbase concordam o suficiente para a regra 4 escolher o mesmo em 99,96% dos ciclos do AERO. O feed AERO/USD da Chainlink, com heartbeat de 24 h e desvio de 0,5%, só actualiza quando o preço se move 0,5% — entre ticks parece parado — e por isso mudou 12% das decisões face à bolsa. **Para a regra 4, «ter feed» não basta: conta a resolução do feed face à variação típica entre ticks.** Isto refina o critério de faseamento do §8.
- No ETH, onde o feed tem desvio de 0,05%, o DefiLlama mudou 1,5% das decisões face ao feed e a Coinbase 0,7%. O efeito no preço médio pago é pequeno e sem sinal fixo.
- **A fonte da fase 2 teve um erro real**: às 21:00 UTC de 29 Out 2026 o DefiLlama marcou o WETH da Base a 2 736,21 USD, com a Coinbase a 2 255,40 e o feed a 2 258,69 (+21%). Um keeper que decidisse com uma só fonte compraria a perna errada; o quórum de 300 bps do ADR-024 rejeitaria a leitura, se houver segunda fonte nesse instante.
- **O quórum real não pôde ser reconstruído**: a CoinGecko não serve histórico sem chave (HTTP 401). Medimos o membro DefiLlama contra referências independentes; o comportamento do par DefiLlama + CoinGecko fica por medir.

**Resposta (v): pode abrir para tokens com o perfil do AERO, com quatro condições.** (1) A regra 4 da fase 2 decide com o preço de quórum do ADR-024 (≥ 2 fontes dentro de 300 bps), nunca com uma fonte só — é o quórum que apanha um erro como o de 29 Out. (2) Uma perna sem quórum num ciclo não entra na comparação desse ciclo: salta, em vez de usar o preço de uma fonte. (3) Validação por token antes de o abrir, com a mesma medição deste §: o AERO é líquido e tem referência de bolsa; um token sem bolsa de referência não ficou provado por este resultado. (4) Medir o quórum completo quando houver chave da CoinGecko. E uma nota para a fase 1: um feed Chainlink com desvio grosseiro (0,5%) não é automaticamente melhor input para a regra 4 do que um quórum off-chain.

![Gráfico E3 · DefiLlama face à Coinbase, hora a hora: AERO dentro da tolerância; ETH com um erro real de +21%](charts/E3-quorum-vs-referencia.svg)

*Gráfico E3 · DefiLlama face à Coinbase, hora a hora: AERO dentro da tolerância; ETH com um erro real de +21%* — dados: [`charts/E3-quorum-vs-referencia.csv`](charts/E3-quorum-vs-referencia.csv)


## 2.8 Três pernas voláteis, sem stable

*S2 (FTX, janela inteira e 30 d após o pior dia) e posições semanais de Jul–Out 2026 · diária e semanal*

| Cesto (33-33-33) | Posições | Ciclos ganhos por perna (1/2/3) | Quando ETH e BTC sobem, a 3.ª perna é comprada em… | Vencedora = a que mais caiu | Drawdown máx. mediano (%) |
|---|---|---|---|---|---|
| ETH + BTC + USDC | 66 | 33% / 33% / 34% | 67% | 71% | 2,4 |
| ETH + BTC + SOL | 66 | 33% / 33% / 34% | 33% | 66% | 4,8 |

Com uma stable, quando as duas voláteis sobem a stable ganha o ciclo: **o mecanismo compra liquidez quando o resto está caro**, um comportamento que se explica numa frase. Com três voláteis, nesse mesmo momento compra a volátil que subiu menos — passa a ser uma rotação de volatilidade, e o drawdown da posição cresce. A recomendação do §8 mantém-se: perna 3 restrita a stablecoins curadas.


## 2.9 Custo operacional

*Capital mínimo para a fee de 0,1% cobrir o gas da posição, no pior caso de fills observado · custos por fill do FILL-ECONOMICS-CALIBRATION (22 Jul 2026, Base)*

| Estr. | Cadência | Ciclos | Fills (med/máx) | Fills/ciclo (máx) | Cmín · canónica, gas mercado ($0,003) | Cmín · agregador, gas mercado ($0,016) | Cmín · canónica, tier keeper ($0,75) | Cmín · agregador, tier keeper ($3,93) |
|---|---|---|---|---|---|---|---|---|
| A | 1 d | 5 | 7 / 7 | 1,40 | 21 USD | 112 USD | 5 250 USD | 27 510 USD |
| A | 1 d | 6 | 6 / 6 | 1,00 | 18 USD | 96 USD | 4 500 USD | 23 580 USD |
| A | 1 d | 12 | 12 / 14 | 1,17 | 42 USD | 224 USD | 10 500 USD | 55 020 USD |
| A | 1 d | 26 | 28 / 28 | 1,08 | 84 USD | 448 USD | 21 000 USD | 110 040 USD |
| A | 1 d | 30 | 30 / 32 | 1,07 | 96 USD | 512 USD | 24 000 USD | 125 760 USD |
| A | 1 d | 52 | 53 / 54 | 1,04 | 162 USD | 864 USD | 40 500 USD | 212 220 USD |
| A | 1 d | 60 | 60 / 60 | 1,00 | 180 USD | 960 USD | 45 000 USD | 235 800 USD |
| A | 1 d | 90 | 90 / 92 | 1,02 | 276 USD | 1 472 USD | 69 000 USD | 361 560 USD |
| A | 7 d | 5 | 7 / 7 | 1,40 | 21 USD | 112 USD | 5 250 USD | 27 510 USD |
| A | 7 d | 6 | 6 / 6 | 1,00 | 18 USD | 96 USD | 4 500 USD | 23 580 USD |
| A | 7 d | 12 | 12 / 12 | 1,00 | 36 USD | 192 USD | 9 000 USD | 47 160 USD |
| A | 7 d | 26 | 28 / 28 | 1,08 | 84 USD | 448 USD | 21 000 USD | 110 040 USD |
| A | 7 d | 52 | 54 / 54 | 1,04 | 162 USD | 864 USD | 40 500 USD | 212 220 USD |
| B | 1 d | 5 | 15 / 15 | 3,00 | 45 USD | 240 USD | 11 250 USD | 58 950 USD |
| B | 1 d | 6 | 18 / 18 | 3,00 | 54 USD | 288 USD | 13 500 USD | 70 740 USD |
| B | 1 d | 12 | 36 / 36 | 3,00 | 108 USD | 576 USD | 27 000 USD | 141 480 USD |
| B | 1 d | 26 | 78 / 78 | 3,00 | 234 USD | 1 248 USD | 58 500 USD | 306 540 USD |
| B | 1 d | 30 | 90 / 90 | 3,00 | 270 USD | 1 440 USD | 67 500 USD | 353 700 USD |
| B | 1 d | 52 | 156 / 156 | 3,00 | 468 USD | 2 496 USD | 117 000 USD | 613 080 USD |
| B | 1 d | 60 | 180 / 180 | 3,00 | 540 USD | 2 880 USD | 135 000 USD | 707 400 USD |
| B | 1 d | 90 | 270 / 270 | 3,00 | 810 USD | 4 320 USD | 202 500 USD | 1 061 100 USD |
| B | 7 d | 5 | 15 / 15 | 3,00 | 45 USD | 240 USD | 11 250 USD | 58 950 USD |
| B | 7 d | 6 | 18 / 18 | 3,00 | 54 USD | 288 USD | 13 500 USD | 70 740 USD |
| B | 7 d | 12 | 36 / 36 | 3,00 | 108 USD | 576 USD | 27 000 USD | 141 480 USD |
| B | 7 d | 26 | 78 / 78 | 3,00 | 234 USD | 1 248 USD | 58 500 USD | 306 540 USD |
| B | 7 d | 52 | 156 / 156 | 3,00 | 468 USD | 2 496 USD | 117 000 USD | 613 080 USD |

**Achado: fills pequenos.** A correcção da regra 3 cria compras parciais — o fecho do gap da vencedora e o remanescente rolado. Em capital de 1 000 USD a menor compra rolada observada foi 2,70 USD; numa posição de 100 USD seria dez vezes menor. O `DCA_MIN_CHUNK_USD` actual (1 USD por defeito) e o `MIN_ORDER_AMOUNT` (0,01 USDC) deixam passar fills que custam mais gas do que valem. **Proposta ao Arquitecto**: um mínimo por fill (p.ex. o maior entre o chunk mínimo e 10× o custo de gas da chain); um gap abaixo desse mínimo junta-se à compra seguinte dessa perna ou à liquidação final. O desvio continua garantido até esse resíduo.

**Nota de coerência**: a tabela (c) do FILL-ECONOMICS-CALIBRATION assume uma fee de 0,20%; o contrato V3 tem `FEE_BPS = 10` (0,1%) e o ADR-006 fechou 0,1% como invariante. Os números acima usam 0,1%.

![Gráfico E4 · Capital mínimo por posição ao gas de mercado, Basket vs DCA fixo](charts/E4-capital-minimo.svg)

*Gráfico E4 · Capital mínimo por posição ao gas de mercado, Basket vs DCA fixo* — dados: [`charts/E4-capital-minimo.csv`](charts/E4-capital-minimo.csv)


## 2.10 Movimentos bruscos numa hora — ticks horários

**O pedido**: até aqui todos os ciclos liam o preço às 00:00 UTC. Esta secção acrescenta mais de 2 000 posições com ticks a outras horas, nos momentos dos últimos 5 anos em que ETH, BTC ou uma stable variaram mais de 15% numa hora.

**Primeiro, o que os dados dizem sobre esses momentos.** Li as velas horárias de 7 Nov 2021 a 7 Nov 2026 em duas bolsas por activo (Coinbase e Bitstamp; USDC só na Bitstamp, DAI só na Coinbase):

*Velas horárias, Nov 2021 – Nov 2026 · amplitude = máximo ÷ mínimo da própria vela − 1*

| Activo | Bolsa | Horas | Maior variação fecho→fecho | Quando (UTC) | Maior amplitude dentro da hora | Quando (UTC) | Horas > 15% fecho→fecho | Horas > 15% dentro da hora |
|---|---|---|---|---|---|---|---|---|
| ETH | coinbase ETH-USD | 43 812 | −11,6% | 2025-02-03 01:00 | 25,5% | 2025-02-03 02:00 | 0 | 4 |
| ETH | bitstamp ethusd | 43 824 | −11,9% | 2025-02-03 01:00 | 21,6% | 2025-02-03 02:00 | 0 | 6 |
| BTC | coinbase BTC-USD | 43 812 | −7,1% | 2022-05-11 12:00 | 19,5% | 2021-12-04 05:00 | 0 | 1 |
| BTC | bitstamp btcusd | 43 824 | −7,3% | 2022-05-11 12:00 | 20,5% | 2021-12-04 05:00 | 0 | 2 |
| USDC | bitstamp usdcusd | 43 824 | 6,6% | 2023-03-11 08:00 | 14,6% | 2023-03-11 06:00 | 0 | 0 |
| USDT | coinbase USDT-USD | 43 810 | −1,7% | 2022-05-12 06:00 | 7,2% | 2025-10-10 21:00 | 0 | 0 |
| USDT | bitstamp usdtusd | 43 824 | 799,7% (erro de cotação) | 2021-12-15 16:00 | 295 885,2% (erro de cotação) | 2022-11-08 09:00 | 2 | 4 |
| DAI | coinbase DAI-USD | 39 282 | −5,6% | 2023-03-11 07:00 | 9,9% | 2023-03-11 07:00 | 0 | 0 |

**Nunca, em 5 anos, o preço de fecho de ETH, BTC, USDC, USDT ou DAI mudou mais de 15% de uma hora para a outra.** O maior foi o ETH, −11,9% às 01:00 UTC de 3 Fev 2025. Os 15% só aparecem **dentro** da hora, entre o mínimo e o máximo da vela. Para contar como episódio exigi a amplitude acima de 15% numa bolsa e acima de 10% na outra; um pico numa bolsa só é tratado como erro de cotação (é o caso da USDT na Bitstamp, que chegou a «2 960 USD», e do BTC na Bitstamp a 24 Jan 2022). A UST não está nestas bolsas: usei o feed Chainlink USTC/ETH × ETH/USD hora a hora, que passou os 15% repetidamente a partir das 07:00 UTC de 11 Mai 2022. O USDC ficou nos 14,6% e entra assinalado, por ser o único caso numa stable curada.

*O que a bolsa fez dentro da hora e o que o feed Chainlink — o preço que o keeper lê — mostrou na mesma hora*

| # | Episódio | Primeira hora acima do limiar | Amplitude na bolsa | Amplitude no feed (min. a min.) | Feed: hora seguinte vs esta | Feed lido |
|---|---|---|---|---|---|---|
| E1 | BTC · flash crash de 4 Dez 2021 | 2021-12-04 05:00 UTC | 20,5% | 9,3% | −5,1% | BTC/USD · Ethereum (sem WBTC legível em Dez 2021) |
| E2 | UST · colapso Terra, 11 Mai 2022 | 2022-05-11 07:00 UTC | sem bolsa no conjunto | 75,2% | −33,9% | USTC/ETH × ETH/USD · Ethereum |
| E3 | ETH · FOMC + Celsius, 15 Jun 2022 | 2022-06-15 18:00 UTC | 17,6% | 12,4% | 5,6% | ETH/USD · Arbitrum |
| E4 | USDC · SVB, 11 Mar 2023 (14,6%: abaixo do limiar) | 2023-03-11 06:00 UTC | 14,6% (Bitstamp) | 4,7% | −3,6% | USDC/USD · Arbitrum |
| E5 | ETH · yen carry, 5 Ago 2024 | 2024-08-05 01:00 UTC | 20,3% | 15,4% | −8,1% | ETH/USD · Arbitrum |
| E6 | ETH · tarifas, 3 Fev 2025 | 2025-02-03 01:00 UTC | 18,7% | 14,0% | −12,1% | ETH/USD · Arbitrum |
| E7 | ETH · liquidações de 10 Out 2025 | 2025-10-10 21:00 UTC | 19,0% | 12,6% | 2,3% | ETH/USD · Arbitrum |

**O feed amortece os picos.** É a mediana de várias fontes e só actualiza quando o preço se afasta do limiar de desvio, por isso as mechas de uma bolsa quase não aparecem: no flash crash do BTC a bolsa fez ~20% e o feed 9,3%. **Para o keeper, só a UST e o yen carry de Ago 2024 passaram os 15% dentro da hora.** Para o Basket isto é bom: a regra 4 compara o que o feed diz, não as mechas.

**As simulações.** À volta de cada episódio corri 2 072 posições que contêm sempre a hora do evento como tick: cadência horária (24 e 72 ciclos), de 4 em 4 horas (30 e 60 ciclos) e diária (15 e 30 ciclos). Nas cadências de 4 h e diária o tick cai na primeira leitura depois do movimento. Cada posição corre nas 4 repartições e em 7 versões: A, A com regra 9 a 25% (suave e rígido), A com a banda de peg de 1%, A0, B e C — 14 504 simulações. Os preços são do feed Chainlink lido à hora certa.

*Os 7 episódios juntos · capital 1 000 USD*

| Versão | Posições | Desvio máx. (pp) | Com desvio | Por investir máx. (%) | Compra a mais no último ciclo, máx. (%) |
|---|---|---|---|---|---|
| A | 2072 | 0 | 0% | 0,0 | 3,3 |
| A · regra 9 25% suave | 2072 | 0 | 0% | 0,0 | 63,3 |
| A · regra 9 25% rígido | 2072 | 46,67 | 20% | 60,0 | 30,0 |
| A · banda peg 1% | 2072 | 50,00 | 18% | 50,0 | 33,3 |
| A0 | 2072 | 6,67 | 35% | 3,3 | 0,0 |
| B | 2072 | 0 | 0% | 0,0 | 0,0 |

**A garantia aguenta com ticks a qualquer hora**: desvio zero no Basket e no modo suave, em todos os episódios e cadências. O modo rígido e a banda de peg deixam capital por investir, como devem. A banda volta a mostrar o seu valor na UST: valor mediano no fim de 919 USD com a banda contra 786 USD sem ela, por 1 000 investidos.

![Gráfico E6 · O episódio de 3 Fev 2025 visto hora a hora: o feed, as mechas da bolsa e o que uma posição horária comprou](charts/E6-episodio-horario.svg)

*Gráfico E6 · O episódio de 3 Fev 2025 visto hora a hora: o feed, as mechas da bolsa e o que uma posição horária comprou* — dados: [`charts/E6-episodio-horario.csv`](charts/E6-episodio-horario.csv)


## 2.11 Quantas vezes o Basket acabou à frente dos outros dois DCAs

**Definição.** «Venceu» = acabou a posição com mais valor (o que tem, ao preço do feed no último tick, mais o que ficou por investir), com o mesmo capital, a mesma janela e a mesma cadência. Diferenças abaixo de 0,01% do capital são empate. **É histórico, não é promessa** — e não é o que o mecanismo garante.

**Amostra para separar alta volatilidade de períodos normais**: uma posição a começar em cada dia de 31 Mar 2022 a 6 Out 2026 (antes de 31 Mar 2022 não há série WBTC legível para a perna BTC: o feed WBTC/BTC da Ethereum só tem rondas legíveis a partir de 30 Mar 2022), com 30 dias (diária) e 90 dias (diária e semanal), nas 4 repartições — 18 888 posições do Basket, cada uma contra B e C. Cada posição é classificada pela volatilidade realizada do ETH dentro dela: as 25% mais voláteis são «alta volatilidade», as restantes 75% «normal».

*B = DCA fixo com a mesma divisão · C = DCA só em ETH · diferenças em % do capital · ETH+BTC+USDC*

| Posições | Regime | n | A > B | A − B mediana | A − B P5 / P95 (%) | A > C | A − C mediana | A > B e > C |
|---|---|---|---|---|---|---|---|---|
| 30 dias · diária | alta volatilidade (25% mais voláteis) | 1652 | 47% | −0,04% | −2,3 / 1,7 | 67% | 2,8% | 28% |
| 30 dias · diária | normal (restantes 75%) | 4952 | 59% | 0,12% | −1,2 / 1,4 | 55% | 0,4% | 32% |
| 30 dias · diária | ETH caiu na posição | 3364 | 49% | 0,00% | −1,7 / 0,9 | 88% | 2,9% | 43% |
| 30 dias · diária | ETH subiu na posição | 3240 | 64% | 0,20% | −1,4 / 2,1 | 26% | −2,2% | 18% |
| 90 dias · diária | alta volatilidade (25% mais voláteis) | 1540 | 51% | 0,05% | −2,6 / 2,6 | 57% | 1,9% | 22% |
| 90 dias · diária | normal (restantes 75%) | 4616 | 55% | 0,14% | −2,2 / 3,0 | 49% | −0,2% | 24% |
| 90 dias · diária | ETH caiu na posição | 3028 | 46% | −0,08% | −2,3 / 1,6 | 77% | 4,3% | 31% |
| 90 dias · diária | ETH subiu na posição | 3128 | 62% | 0,35% | −2,3 / 3,6 | 26% | −3,1% | 17% |
| 90 dias · semanal | alta volatilidade (25% mais voláteis) | 1532 | 51% | 0,05% | −4,3 / 2,9 | 61% | 3,3% | 28% |
| 90 dias · semanal | normal (restantes 75%) | 4596 | 55% | 0,20% | −3,1 / 2,9 | 48% | −0,3% | 28% |
| 90 dias · semanal | ETH caiu na posição | 3024 | 51% | 0,02% | −3,1 / 2,1 | 78% | 4,6% | 38% |
| 90 dias · semanal | ETH subiu na posição | 3104 | 57% | 0,31% | −3,5 / 3,7 | 25% | −3,8% | 18% |

*As mesmas contas nas outras secções*

| Amostra | n | A > B | A − B mediana | A > C | A > B e > C |
|---|---|---|---|---|---|
| 2.1 janelas de stress S1–S7 (ticks 00:00) | 112 | 62% | 0,46% | 74% | 41% |
| 2.10 movimentos bruscos, ticks horários | 2072 | 48% | −0,02% | 60% | 26% |
| 2.3 Jul–Out 2026 | 1680 | 52% | 0,04% | 34% | 18% |

![Gráfico E5 · Em que parte das posições o Basket acabou à frente de B, de C e dos dois](charts/E5-quem-ficou-a-frente.svg)

*Gráfico E5 · Em que parte das posições o Basket acabou à frente de B, de C e dos dois* — dados: [`charts/E5-quem-ficou-a-frente.csv`](charts/E5-quem-ficou-a-frente.csv)

**Leitura.**

- **Basket vs DCA fixo (B) — é isto que mede o mecanismo**, porque as duas estratégias compram a mesma divisão. Em períodos normais o Basket ficou à frente um pouco mais de metade das vezes; em alta volatilidade, metade. A diferença mediana anda entre 0 e 0,3% do capital, e 90% das posições ficam entre cerca de −2,5% e +3%. **Não há vantagem sistemática.** Escolher «a que mais caiu» não compra mais barato de forma consistente.
- **Basket vs DCA só em ETH (C) — mede sobretudo a stable.** Quando o ETH cai, o Basket fica à frente na grande maioria das posições, porque tem parte do capital em USDC; quando o ETH sobe, o DCA só em ETH ganha quase sempre. É exposição, não habilidade.
- **Nas outras amostras**: nas janelas de stress o Basket ficou à frente de B em 62% das posições, mas são só 112 e muito correlacionadas entre si; nos 2 072 episódios horários, em 48%; em Jul–Out 2026, em 52%. Contra C, o resultado segue a direcção do ETH em cada episódio.
- **Consequência para o produto**: confirma a nota de linguagem do §11. O que se pode dizer ao utilizador é que a divisão pedida é cumprida e que nenhuma perna é comprada às cegas. Não se pode dizer que o Basket rende mais do que um DCA normal.


## 2.12 O sinal de selecção compra melhor? Quatro sinais comparados

**A pergunta certa** não é se o Basket bate um DCA só em ETH; é se, para quem quer vários activos, o mecanismo compra cada um numa altura melhor do que comprar os três por igual em cada ciclo. Para isolar o efeito do sinal, mantive a mecânica toda (regra 3 corrigida, cooldown, lock, liquidação final, sem regra 9) e só troquei o critério que escolhe a perna:

- **tick** — a regra 4 actual: a que mais caiu desde o ciclo anterior.
- **média** — a que está mais abaixo da sua própria média desde o início da posição (a leitura mais directa de «mais desvalorizada face às outras»).
- **entrada** — a que está mais abaixo do seu preço de entrada.
- **rotação** — nenhum sinal: as pernas compram por turnos. Mostra o que é ruído.

*Uma posição por dia de 31 Mar 2022 a 6 Out 2026, cadência diária, ETH + BTC + USDC, 4 repartições · alta vol. = 25% mais voláteis · preço negativo = comprou mais barato do que o DCA fixo*

| Posição | Sinal | Regime | n | Acabou à frente de B | Diferença mediana (% capital) | P5 / P95 | Preço médio ETH vs B · % posições mais barato | Preço médio BTC vs B · % posições mais barato |
|---|---|---|---|---|---|---|---|---|
| 30 dias | tick (actual) | normal | 4952 | 59% | 0,12% | −1,2 / 1,4 | −0,20% · 57% | −0,16% · 58% |
| 30 dias | tick (actual) | alta vol. | 1652 | 47% | −0,04% | −2,3 / 1,7 | 0,03% · 49% | 0,27% · 42% |
| 30 dias | média | normal | 4952 | 61% | 0,19% | −1,6 / 1,7 | −0,51% · 60% | −0,22% · 58% |
| 30 dias | média | alta vol. | 1652 | 43% | −0,23% | −3,5 / 1,7 | 0,94% · 41% | 0,07% · 49% |
| 30 dias | entrada | normal | 4952 | 59% | 0,18% | −1,8 / 1,8 | −0,51% · 59% | −0,21% · 56% |
| 30 dias | entrada | alta vol. | 1652 | 42% | −0,21% | −3,4 / 2,2 | 1,02% · 40% | 0,09% · 49% |
| 30 dias | rotação | normal | 4952 | 51% | 0,03% | −1,0 / 1,5 | −0,05% · 52% | −0,03% · 52% |
| 30 dias | rotação | alta vol. | 1652 | 42% | −0,15% | −1,9 / 1,8 | 0,41% · 40% | 0,05% · 48% |
| 90 dias | tick (actual) | normal | 4616 | 55% | 0,14% | −2,2 / 3,0 | −0,12% · 53% | −0,31% · 59% |
| 90 dias | tick (actual) | alta vol. | 1540 | 51% | 0,05% | −2,6 / 2,6 | −0,47% · 55% | 0,50% · 42% |
| 90 dias | média | normal | 4616 | 55% | 0,24% | −3,2 / 2,5 | −0,48% · 56% | −0,45% · 56% |
| 90 dias | média | alta vol. | 1540 | 47% | −0,15% | −7,2 / 3,8 | −0,94% · 56% | 1,40% · 32% |
| 90 dias | entrada | normal | 4616 | 54% | 0,21% | −3,8 / 3,1 | −0,64% · 56% | −0,39% · 55% |
| 90 dias | entrada | alta vol. | 1540 | 49% | −0,04% | −7,2 / 4,5 | −0,90% · 54% | 1,28% · 36% |
| 90 dias | rotação | normal | 4616 | 55% | 0,06% | −2,1 / 3,1 | −0,13% · 55% | −0,05% · 54% |
| 90 dias | rotação | alta vol. | 1540 | 42% | −0,12% | −2,7 / 2,2 | 0,32% · 42% | 0,11% · 46% |

**Leitura.** A rotação fica nos 50% e perto de zero: é o ruído de base. O sinal actual (tick) acrescenta cerca de 5 a 8 pontos percentuais de vitórias e 0,1–0,2% no preço médio em mercado normal, e fica neutro em alta volatilidade. Os sinais de valorização relativa (média, entrada) são um pouco melhores em mercado normal e claramente piores em alta volatilidade, com caudas mais largas: são apostas mais fortes em que o preço volta para trás, e as quedas de 2022–2026 foram tendências. **Dos quatro, o sinal actual é o mais equilibrado e deve ficar.** A razão de fundo é estrutural: o mecanismo só escolhe quando cada perna é comprada dentro da janela, não quanto. ETH e BTC andam muito juntos, e qual deles caiu mais num dia pouco diz sobre o dia seguinte. O ganho possível é pequeno por construção.


## 3. Os gráficos

**Os quatro gráficos de confiança de Julho não foram encontrados** (as páginas PT/EN de 30 Jul não estão em nenhuma pasta ligada). O registo só diz «4 gráficos de confiança». Refi-los com a função que esse nome descreve e com os dados novos:

1. **T1 · A divisão que pedes é a divisão que recebes** — por repartição e por perna, o alvo e o resultado de cada posição de stress; a regra original ao lado para mostrar o que a correcção resolve.
2. **T2 · Para onde foi cada ciclo** — numa janela de stress, o que foi comprado em cada dia e em que perna. Mostra que não há «tudo de uma vez» sem regra 9.
3. **T3 · A protecção a funcionar** — a mesma janela com a regra 9: o preço face à entrada, o limiar, os dias protegidos e as compras a parar.
4. **T4 · O que pagaste** — o preço médio do Basket face ao DCA fixo, posição a posição, rotulado como histórico. Serve para não prometer o que o mecanismo não faz.

Os três pedidos (**N1** caminho da repartição, **N2** dispersão do desvio, **N3** limiar × modo) estão nas secções respectivas. **Desvio ao pedido**: o N1 pedia o preço de ETH num eixo secundário; está num painel próprio por cima, com o mesmo eixo de tempo. Dois eixos verticais no mesmo gráfico inventam correlações (a escala de um é arbitrária face ao outro). Mais quatro: E1 (escolha vs ciclos), E2 (depeg), E3 (fase 2), E4 (capital mínimo). Cada SVG tem ao lado o CSV exacto do que desenha; passar o rato sobre uma marca mostra o valor.


## 4. O que não foi medido, e porquê

- **Quórum completo da fase 2 (DefiLlama + CoinGecko).** A CoinGecko devolve HTTP 401 a pedidos de histórico sem chave. Só o membro DefiLlama foi medido.
- **Preço de pool on-chain do AERO.** Exigiria um nó de arquivo (estado histórico das pools da Aerodrome); os RPCs públicos recusam (`missing trie node` / «archive requests require a token»). Substituído pela Coinbase e pelo feed AERO/USD da Chainlink.
- **Um depeg em que a stable curada nunca recupera.** Não existe janela real com USDC, USDT ou DAI. O caso da UST é real e mostra o mecanismo, mas a UST nunca seria uma stable curada.
- **Ticks intradiários com todas as pernas.** O horário só foi lido para as stables nas janelas de depeg e para AERO/ETH na janela 2.3. O efeito da hora do tick sobre ETH/BTC não foi medido.
- **Execução real** (slippage, rota, MEV, falhas do keeper, gas variável). As compras são ao preço do feed; o custo vem do relatório de calibração, não de execuções deste mecanismo.
- **Cadência e duração longas em 2.3**: 3 dias × 52 ciclos e 7 dias × 26/52 ciclos não cabem entre 1 Jul e 6 Nov 2026.
- **cbBTC antes de 13 Set 2024**: não existia. Antes disso a perna BTC é WBTC (Arbitrum desde 25 Nov 2022; antes, WBTC/BTC × BTC/USD na Ethereum), declarada posição a posição.
- **XRP antes de 25 Ago 2022**: sem feed nas redes usadas; vela diária da Bitstamp (exchange), declarada.
- **Horas com mais de 15% de fecho a fecho**: não existem nos 5 anos em ETH, BTC nem stables curadas. A §2.10 usa a amplitude dentro da hora, confirmada em duas bolsas.
- **WBTC em Dez 2021 (episódio E1)**: o feed WBTC/BTC da Ethereum não tem rondas legíveis antes de Mar 2022; a perna BTC desse episódio usa o feed BTC/USD, declarado na coluna de fontes.
- **O feed dentro da hora** foi lido minuto a minuto só na hora de cada evento e só no activo do evento.


## 5. Achados para o Arquitecto, fora do que foi pedido

1. **O modo suave concentra no último ciclo** (§2.5). Se o dono quiser manter o nome, o texto tem de dizer isto. Alternativa a avaliar: escalonar a liquidação da perna adiada pelos últimos k ciclos, em vez de a concentrar num.
2. **A regra 9 nas voláteis empurra o orçamento para a stable** (§2.6). Em depeg é a pior combinação possível. A banda de 1% resolve.
3. **Fills pequenos criados pela correcção da regra 3** (§2.9). Precisa de um mínimo por fill.
4. **Frescura dos feeds vs ADR-024.** A regra 4 precisa de um preço para cada perna em cada ciclo. Com `MAX_PRICE_AGE_SEC = 600`, a leitura on-chain conta como ausente em muitos ticks: desde 1 Jul 2026, ETH/USD · Arbitrum 12%; ETH/USD · Base 40%; cbBTC/USD · Base 46%; WBTC/USD · Arbitrum 39%; USDC/USD · Arbitrum 0%; USDT/USD · Arbitrum 0%; AERO/USD · Base 74%. Um feed que não actualizou está, por definição, dentro do seu limiar de desvio. Para a comparação da regra 4 o critério natural é o heartbeat do feed × 1,5 (a regra 9V da app), não os 600 s do piso. Decisão do Arquitecto.
5. **USDC/USD e USDT/USD na Arbitrum só passaram a heartbeat de ~255 s em 2026-Q2.** Antes disso a ronda lida tinha horas (mediana de 2 h no USDC, de 9 h na USDT). Os comentários do repo e o ADR-024 descrevem o feed como sempre de 255 s; isso só é verdade desde 2026-Q2.
6. **Erro real do DefiLlama** (+21% no WETH da Base, 29 Out 2026 21:00 UTC). Argumento a favor de nunca decidir com uma fonte só.
7. **Fee no relatório de calibração** (0,20%) incoerente com o contrato (0,1%).
8. **A hora do tick importa nos depegs**: às 00:00 o USDC parecia a 0,968; às 08:00 estava a 0,885. A banda deve ser verificada no momento do fill.

*Frescura dos feeds no momento do tick (achado 4 do §5)*

| Feed | Período | Ticks | Idade mediana (s) | P90 (s) | Máx. (h) | > 600 s (ADR-024) |
|---|---|---|---|---|---|---|
| Chainlink ETH/USD · Arbitrum | todo o período | 1803 | 107 | 496 | 1,1 | 7% |
| Chainlink ETH/USD · Arbitrum | desde 1 Jul 2026 | 130 | 148 | 633 | 0,5 | 12% |
| Chainlink ETH/USD · Base | todo o período | 191 | 489 | 1 021 | 0,3 | 39% |
| Chainlink ETH/USD · Base | desde 1 Jul 2026 | 130 | 514 | 1 003 | 0,3 | 40% |
| Chainlink cbBTC/USD · Base | todo o período | 785 | 657 | 1 180 | 18,7 | 54% |
| Chainlink cbBTC/USD · Base | desde 1 Jul 2026 | 130 | 547 | 1 119 | 0,3 | 46% |
| Chainlink WBTC/USD · Arbitrum | todo o período | 1443 | 238 | 1 074 | 1,8 | 22% |
| Chainlink WBTC/USD · Arbitrum | desde 1 Jul 2026 | 130 | 443 | 1 770 | 1,8 | 39% |
| Chainlink USDC/USD · Arbitrum | todo o período | 1803 | 7 742 | 62 907 | 24,0 | 89% |
| Chainlink USDC/USD · Arbitrum | desde 1 Jul 2026 | 130 | 140 | 244 | 0,1 | 0% |
| Chainlink USDT/USD · Arbitrum | todo o período | 1803 | 33 614 | 77 511 | 23,9 | 89% |
| Chainlink USDT/USD · Arbitrum | desde 1 Jul 2026 | 130 | 128 | 232 | 0,1 | 0% |
| Chainlink AERO/USD · Base | todo o período | 191 | 1 387 | 6 597 | 8,7 | 74% |
| Chainlink AERO/USD · Base | desde 1 Jul 2026 | 130 | 1 569 | 6 372 | 8,7 | 74% |


## Anexo — reprodução e ficheiros

```
cd docs/Reports/basket-dca
pip install -r requirements.txt
python3 run_all.py            # puxa as séries (com cache) e refaz tudo
python3 run_all.py --no-fetch # usa os CSV em data/series tal como estão
python3 -m pytest tests/      # testes do motor sobre janelas reais
```

- `src/feeds_config.py` — escolhe os feeds no directório da Chainlink e cruza com o repo (sem endereços escritos à mão).
- `src/fetch_chainlink.py`, `src/fetch_all.py` — leitura das rondas (cache em `data/raw/chainlink_round_cache/`) e das séries off-chain.
- `src/engine.py` — o mecanismo (A, A0, B, C). `src/scenarios.py`, `src/experiments.py` — o catálogo do §2.
- `data/series/` — todas as séries usadas, com a idade da ronda lida em cada tick (`age_s`). `data/series/feed_verification.csv` — identidade on-chain dos feeds.
- `results/sec_2_*.csv` — uma linha por posição e estratégia, com o cenário completo ao lado de cada número (par, repartição, datas, cadência, limiar, modo, fontes).
- `charts/*.svg` + `charts/*.csv` — cada gráfico e os dados exactos que desenha.

Séries lidas a 7 Nov 2026 (último tick: 00:00 UTC de 7 Nov 2026). Inputs do repo no commit `50c142d90ba6f878ff206315b6b0abcdaea7c0a4`.
