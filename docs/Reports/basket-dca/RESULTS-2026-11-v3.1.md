# Basket DCA — modelação v3.1 (RESULTS-2026-11-v3.1)

**Da Analista para o Arquitecto.** Responde a `claude/basket-dca-pedido-modelacao-v3.1-2026-11-07.md`. Mede o **A+ discreto** — o Basket como o contrato V3 o executa: uma ordem DCA por perna, chunk fixo, no máximo L chunks por perna e por ciclo, `expiry` com 3 ciclos extra — contra o A+ contínuo da v3 e o B+, nos dois cestos (três voláteis primeiro), em modo suave e rígido, regra 9 a 25%. Faz a verificação on-chain na Base, simula a tua regra da banda e gera a tabela do aviso. Mesmo pacote e mesmo comando (`python3 run_all.py --no-fetch`); a v3 não muda (`RESULTS-2026-11-v3.md`, md5 `b2d00edbaf7e8265d74327678f67f192`); a v2 também não.

> Separação de sempre: **(a)** a garantia — o que foi comprado cumpre a divisão? quanto ficou por comprar? — e **(b)** o que aconteceu ao valor e ao preço, histórico, nunca promessa. Mínimo / mediana / máximo, cada número com o seu cenário.


## As respostas

**§2.1 — O A+ discreto mantém as conclusões da v3 (T3, T6, T8)?**

**Sim, com uma troca.** A garantia fica mais forte: cada perna vende chunks inteiros e nunca mais do que o montante assinado, por isso **o que é comprado cumpre a divisão por construção** (teste novo; todas as 271 056 corridas com chunks exactos). O que muda é o fim: o que antes se comprava «de uma vez» agora pode ficar por comprar. **T3:** o problema da concentração desaparece — a maior compra única é um chunk (≤ 13,3% do capital em posições com 8 ou mais ciclos, contra 22,5% no A+ contínuo); o E deixa de ser um parâmetro e passa a ser o próprio contrato. **T6:** continua sem vencedor: o A+ discreto (L = 2) ficou à frente do B+ em 53% das posições da amostra de 5 anos (três voláteis; mediana 0,14%) e, face ao A+ contínuo, à frente em 42%, empatado em 22% e atrás em 36% (com chunks iguais ao orçamento do ciclo, os dois fazem muitas vezes exactamente as mesmas compras); faz uma compra por ciclo, como o A+ contínuo (30 e 30 numa posição de 30 dias), contra 45 do B+. **T8:** a regra 9 continua a ser a que pesa; no discreto, em vez de concentrar o fim, deixa chunks por executar: no modo suave, nas cadências do produto (diária e semanal), 1 800 posições de três voláteis (4,3%) fecham incompletas com L = 1 e 102 (0,24%) com L = 2; no rígido, 24,0% e 21,7%.

**§2.2 — L = 1 ou L = 2?**

**L = 2.** No modo suave e nas cadências do produto, L = 2 deixa 102 de 41 636 posições de três voláteis por completar (no máximo 4 chunks, 6,5% do capital), contra 1 800 (4,3%; até 17 chunks e 27,4% do capital) com L = 1. No cesto com stable: 0 contra 195. O preço de L = 2 é pequeno: o maior gasto num ciclo sobe de 23,8% para 25,0% do capital (posições com 8 ou mais ciclos), e cada compra continua a ser um chunk. No modo rígido L não ajuda (24,0% → 21,7%): a perna protegida até ao fim não compra, com 1 ou 2 chunks.

**§2.3 — Que regra de arredondamento de n_i, e quantas compras a mais no pior caso?**

**Maior resto (Hamilton) com mínimo de 1 chunk por perna e tecto pelo minFill**: `n_i = ⌊w_i·N⌋`, as unidades que faltam para chegar a N vão para os maiores restos, cada perna tem pelo menos 1 chunk, e `n_i ≤ ⌊w_i·C ÷ minFill⌋`. Dá Σ n_i = N sempre que o minFill não morde. **Compras a mais no pior caso: 1** (posições de 2 ciclos, onde 3 pernas precisam de 3 chunks; 5,3% das configurações medidas têm alguma compra a mais). Com `⌈w_i·N⌉` seriam até 2 a mais (62% das configurações); com arredondamento simples, até 1 (32%). O minFill de 16 USD morde quando o chunk ficaria abaixo dele, ou seja em posições longas ou pequenas (90 ciclos diários a 1 000 USD dão 61 chunks em vez de 90, e os ciclos a mais ficam sem compra); acontece em 15,8% das configurações medidas.

**§3 — Verificação on-chain na Base e a regra da banda**

**Registo:** VIRTUAL, COMP, cbBTC, USDC e WETH estão todos registados em `tokenUsdFeeds` no executor V3 da Base (`0x686b4f812291F4De238E59ED00BA6dD6129e60a0`, lido a 2026-11-07 18:17 UTC); **AERO não está** — sem piso de preço on-chain, como previsto para a fase 2. **USDC/USD da Base:** limiar de desvio 0,3% e heartbeat 86 400 s no directório; nas 1 223 rondas observadas, 97% são de heartbeat e o passo mediano entre rondas é de 0,004% — o feed quase só se mexe pelo relógio. maxStaleness no executor: 90 000 s. **A tua regra da banda**, nos eventos reais da T7 (feeds Chainlink de Ethereum como substitutos, porque o feed da Base só existe desde Ago 2023): com banda de 1% muda 322 de 3 330 decisões horárias: 78 passam a «não compra» (soma o limiar à última resposta, por isso marca o descolamento à mesma hora ou antes e durante mais tempo), 224 passam a «compra» (falsos alarmes do DefiLlama que o feed não confirmava, quase todos no USDS em Out 2024) e as restantes deixam de saltar por falta de preço; com 2%, 348 (200 / 128). No próprio USDC da Base, que não descolou, elimina 15 horas de «fora da banda» falsas que o DefiLlama dava com a regra dos 600 s (e 3 horas sem preço).

**§1 — O aviso: a tabela X → (N, R) e se o texto alguma vez é falso**

**Nenhuma banda acima de 10% produz um texto falso**, com dois cuidados que já estão no script: com R = 1 o verbo vai para o singular («só 1 recuperou») e com R = 0 a frase passa a «nenhuma recuperou» (bandas de 80% ou mais); **com 100% não há N** (nenhuma stable caiu mais de 100%) e o aviso fica só com a frase dos 80%. **Uma correcção à rev. 3 da v3:** D = 2 137 dias, não 2 501. O universo completo (todas as stablecoins do registo do DefiLlama) só está coberto desde 30 Dez 2020; antes disso só as moedas curadas tinham histórico. A tabela e o D usam essa data. Exemplos: 20% → 16 stables, 3 recuperaram; 50% → 13, 1; 80% → 10, 0.


## §2 — O A+ discreto

**O mecanismo, tal como foi modelado.** Uma ordem DCA por perna: `amountIn_i = w_i·C`, `dcaTotal_i = n_i`, chunk fixo `w_i·C ÷ n_i` (o último leva o resto exacto). **Calendário:** até ao fim do ciclo t (t < N) o cesto deve ter executado ⌈Σn·(t+1)/N⌉ chunks; no último ciclo e nos 3 de graça, tudo o que falta. **Regra 4 (com P):** o primeiro chunk de um ciclo vai para a perna elegível com a pior variação; **regra 5:** não a mesma do primeiro chunk do ciclo anterior, salvo se for a única. **Recuperação:** os chunks seguintes devidos no mesmo ciclo vão para as pernas elegíveis mais atrasadas na sua própria contagem, nunca mais de L por perna (L = 2 ↔ `dcaInterval = cadência ÷ 2`). **Regra 6:** a perna tranca no último chunk (`DCAComplete`). **Regra 9:** a perna protegida não é elegível; no modo suave deixa de bloquear nos últimos 10 ciclos e nos 3 de graça (a forma discreta do E); no rígido bloqueia sempre. **Banda B** e **sem preço**: como no A+. **Fim:** `expiry = início + (N + 3) × cadência`; o que não executar fica na carteira. Compras ao preço do feed no tick; nos ciclos de graça, ao feed nesse tick (ao preço de decisão quando não temos o feed nessa hora). minFill = 16 USD (rota agregador), posições de 1 000 USD.

**Janelas:** 2.1 (S1–S7), 2.3 (Jul–Out 2026), §2.10 (episódios horários) e, para a separação por regime, a amostra de 5 anos (2.11), como na T6/T8 da v3. Nos episódios as cadências horária e de 4 h já não são do produto (cadência mínima diária, aceite por ti); aparecem em linha própria.


### A garantia: o que fica por comprar

*Todas as janelas · o que foi comprado cumpre sempre a divisão (chunks inteiros); o que fica por comprar nunca saiu da carteira · com stable, inclui a perna stable bloqueada pela banda até ao fim (UST, USDC no SVB)*

| Cesto | Modo | L | Cadência | Posições | Fecham com chunks por executar | Chunks por executar (mín. / med. / máx.) | Por comprar, % do capital (mín. / med. / máx.) |
|---|---|---|---|---|---|---|---|
| 3 voláteis (VIRTUAL, COMP, AERO) | suave | 1 | 1 h (episódios) | 1 152 | 24 (2,08%) | 1 / 3 / 13 | 1,6 / 5,3 / 21,0 |
| 3 voláteis (VIRTUAL, COMP, AERO) | suave | 1 | 24 h (episódios) | 1 308 | 1 (0,08%) | 1 / 1 / 1 | 3,3 / 3,3 / 3,3 |
| 3 voláteis (VIRTUAL, COMP, AERO) | suave | 1 | 4 h (episódios) | 916 | 63 (6,88%) | 1 / 4 / 11 | 1,7 / 6,7 / 18,3 |
| 3 voláteis (VIRTUAL, COMP, AERO) | suave | 1 | diária | 27 240 | 1 800 (6,61%) | 1 / 5 / 17 | 1,6 / 8,0 / 27,4 |
| 3 voláteis (VIRTUAL, COMP, AERO) | suave | 1 | semanal | 14 396 | 0 (0,00%) | — | — |
| 3 voláteis (VIRTUAL, COMP, AERO) | suave | 2 | 1 h (episódios) | 1 152 | 0 (0,00%) | — | — |
| 3 voláteis (VIRTUAL, COMP, AERO) | suave | 2 | 24 h (episódios) | 1 308 | 0 (0,00%) | — | — |
| 3 voláteis (VIRTUAL, COMP, AERO) | suave | 2 | 4 h (episódios) | 916 | 0 (0,00%) | — | — |
| 3 voláteis (VIRTUAL, COMP, AERO) | suave | 2 | diária | 27 240 | 102 (0,37%) | 1 / 2 / 4 | 1,6 / 3,2 / 6,5 |
| 3 voláteis (VIRTUAL, COMP, AERO) | suave | 2 | semanal | 14 396 | 0 (0,00%) | — | — |
| 3 voláteis (VIRTUAL, COMP, AERO) | rígido | 1 | 1 h (episódios) | 1 152 | 167 (14,50%) | 1 / 4 / 25 | 1,6 / 8,3 / 40,3 |
| 3 voláteis (VIRTUAL, COMP, AERO) | rígido | 1 | 24 h (episódios) | 1 308 | 480 (36,70%) | 1 / 4 / 21 | 3,3 / 20,0 / 70,0 |
| 3 voláteis (VIRTUAL, COMP, AERO) | rígido | 1 | 4 h (episódios) | 916 | 335 (36,57%) | 1 / 5 / 34 | 1,7 / 11,7 / 56,7 |
| 3 voláteis (VIRTUAL, COMP, AERO) | rígido | 1 | diária | 27 240 | 6 532 (23,98%) | 1 / 8 / 43 | 1,6 / 16,7 / 70,1 |
| 3 voláteis (VIRTUAL, COMP, AERO) | rígido | 1 | semanal | 14 396 | 3 458 (24,02%) | 1 / 3 / 10 | 6,7 / 20,0 / 78,7 |
| 3 voláteis (VIRTUAL, COMP, AERO) | rígido | 2 | 1 h (episódios) | 1 152 | 127 (11,02%) | 1 / 4 / 24 | 1,6 / 8,3 / 38,7 |
| 3 voláteis (VIRTUAL, COMP, AERO) | rígido | 2 | 24 h (episódios) | 1 308 | 457 (34,94%) | 1 / 4 / 21 | 3,3 / 20,0 / 70,0 |
| 3 voláteis (VIRTUAL, COMP, AERO) | rígido | 2 | 4 h (episódios) | 916 | 282 (30,79%) | 1 / 6 / 33 | 1,7 / 13,3 / 55,0 |
| 3 voláteis (VIRTUAL, COMP, AERO) | rígido | 2 | diária | 27 240 | 5 957 (21,87%) | 1 / 8 / 43 | 1,6 / 16,7 / 70,1 |
| 3 voláteis (VIRTUAL, COMP, AERO) | rígido | 2 | semanal | 14 396 | 3 063 (21,28%) | 1 / 2 / 10 | 6,7 / 20,0 / 78,7 |
| ETH + cbBTC + USDC (com stable) | suave | 1 | 1 h (episódios) | 672 | 174 (25,89%) | 1 / 10 / 31 | 1,6 / 28,2 / 50,0 |
| ETH + cbBTC + USDC (com stable) | suave | 1 | 24 h (episódios) | 840 | 111 (13,21%) | 1 / 5 / 15 | 6,7 / 26,7 / 50,0 |
| ETH + cbBTC + USDC (com stable) | suave | 1 | 4 h (episódios) | 560 | 116 (20,71%) | 1 / 8 / 30 | 1,7 / 20,0 / 50,0 |
| ETH + cbBTC + USDC (com stable) | suave | 1 | diária | 13 656 | 195 (1,43%) | 1 / 3 / 12 | 1,6 / 5,0 / 19,2 |
| ETH + cbBTC + USDC (com stable) | suave | 1 | semanal | 7 024 | 0 (0,00%) | — | — |
| ETH + cbBTC + USDC (com stable) | suave | 2 | 1 h (episódios) | 672 | 167 (24,85%) | 1 / 10 / 31 | 1,7 / 29,2 / 50,0 |
| ETH + cbBTC + USDC (com stable) | suave | 2 | 24 h (episódios) | 840 | 111 (13,21%) | 1 / 5 / 15 | 6,7 / 26,7 / 50,0 |
| ETH + cbBTC + USDC (com stable) | suave | 2 | 4 h (episódios) | 560 | 102 (18,21%) | 1 / 10 / 30 | 1,7 / 23,3 / 50,0 |
| ETH + cbBTC + USDC (com stable) | suave | 2 | diária | 13 656 | 0 (0,00%) | — | — |
| ETH + cbBTC + USDC (com stable) | suave | 2 | semanal | 7 024 | 0 (0,00%) | — | — |
| ETH + cbBTC + USDC (com stable) | rígido | 1 | 1 h (episódios) | 672 | 176 (26,19%) | 1 / 10 / 31 | 1,6 / 27,7 / 50,0 |
| ETH + cbBTC + USDC (com stable) | rígido | 1 | 24 h (episódios) | 840 | 214 (25,48%) | 1 / 5 / 18 | 3,1 / 26,7 / 60,0 |
| ETH + cbBTC + USDC (com stable) | rígido | 1 | 4 h (episódios) | 560 | 161 (28,75%) | 1 / 9 / 30 | 1,7 / 20,0 / 50,0 |
| ETH + cbBTC + USDC (com stable) | rígido | 1 | diária | 13 656 | 1 473 (10,79%) | 1 / 6 / 36 | 1,6 / 11,7 / 63,3 |
| ETH + cbBTC + USDC (com stable) | rígido | 1 | semanal | 7 024 | 809 (11,52%) | 1 / 2 / 8 | 6,7 / 13,3 / 64,0 |
| ETH + cbBTC + USDC (com stable) | rígido | 2 | 1 h (episódios) | 672 | 167 (24,85%) | 1 / 10 / 31 | 1,7 / 29,2 / 50,0 |
| ETH + cbBTC + USDC (com stable) | rígido | 2 | 24 h (episódios) | 840 | 213 (25,36%) | 1 / 5 / 18 | 3,1 / 26,7 / 60,0 |
| ETH + cbBTC + USDC (com stable) | rígido | 2 | 4 h (episódios) | 560 | 148 (26,43%) | 1 / 10 / 30 | 1,7 / 20,0 / 50,0 |
| ETH + cbBTC + USDC (com stable) | rígido | 2 | diária | 13 656 | 1 368 (10,02%) | 1 / 6 / 36 | 1,6 / 11,7 / 63,3 |
| ETH + cbBTC + USDC (com stable) | rígido | 2 | semanal | 7 024 | 694 (9,88%) | 1 / 2 / 8 | 6,7 / 13,3 / 64,0 |


### Tamanho das compras e número de compras

*No A+ contínuo e no B+ uma compra é o que uma perna compra num ciclo; no discreto é um chunk*

| Cesto | Modo | Estratégia | Maior compra única (≥ 8 ciclos) | Maior gasto num ciclo (≥ 8 ciclos) | Compras numa posição de 30 dias (mediana) | Chunks acima de N (máx.) |
|---|---|---|---|---|---|---|
| 3 voláteis (VIRTUAL, COMP, AERO) | suave | A+ contínuo | 22,5% | 22,5% | 30 | — |
| 3 voláteis (VIRTUAL, COMP, AERO) | suave | B+ | 20,3% | 20,3% | 45 | — |
| 3 voláteis (VIRTUAL, COMP, AERO) | suave | A+ discreto L1 | 13,3% | 23,8% | 30 | 1 |
| 3 voláteis (VIRTUAL, COMP, AERO) | suave | A+ discreto L2 | 13,3% | 25,0% | 30 | 1 |
| 3 voláteis (VIRTUAL, COMP, AERO) | rígido | A+ contínuo | 47,8% | 47,8% | 30 | — |
| 3 voláteis (VIRTUAL, COMP, AERO) | rígido | B+ | 48,3% | 48,3% | 45 | — |
| 3 voláteis (VIRTUAL, COMP, AERO) | rígido | A+ discreto L1 | 13,3% | 23,8% | 30 | 1 |
| 3 voláteis (VIRTUAL, COMP, AERO) | rígido | A+ discreto L2 | 13,3% | 46,7% | 30 | 1 |
| ETH + cbBTC + USDC (com stable) | suave | A+ contínuo | 26,7% | 26,7% | 30 | — |
| ETH + cbBTC + USDC (com stable) | suave | B+ | 33,3% | 33,3% | 45 | — |
| ETH + cbBTC + USDC (com stable) | suave | A+ discreto L1 | 13,3% | 16,7% | 30 | 1 |
| ETH + cbBTC + USDC (com stable) | suave | A+ discreto L2 | 13,3% | 16,7% | 30 | 1 |
| ETH + cbBTC + USDC (com stable) | rígido | A+ contínuo | 32,3% | 32,3% | 30 | — |
| ETH + cbBTC + USDC (com stable) | rígido | B+ | 35,4% | 35,4% | 45 | — |
| ETH + cbBTC + USDC (com stable) | rígido | A+ discreto L1 | 13,3% | 16,7% | 30 | 1 |
| ETH + cbBTC + USDC (com stable) | rígido | A+ discreto L2 | 13,3% | 32,0% | 30 | 1 |


### Valor contra o A+ contínuo e contra o B+ (histórico)

*Valor no fim da posição (comprado ao preço do feed + o que ficou na carteira), em % do capital · empate < 0,01%*

| Cesto | Janelas | Modo | Posições | Discreto L2 face ao A+ contínuo: à frente / empate / atrás · mediana (P5 / P95) | Discreto L2 > B+: % · mediana (P5 / P95) | L2 > L1: % · mediana |
|---|---|---|---|---|---|---|
| 3 voláteis (VIRTUAL, COMP, AERO) | S1–S7 (stress) | suave | 192 | 31% / 28% / 42% · 0,00% (−6,8 / 2,1) | 41% · −0,47% (−9,4 / 3,0) | 4% · 0,00% |
| 3 voláteis (VIRTUAL, COMP, AERO) | S1–S7 (stress) | rígido | 192 | 31% / 34% / 35% · 0,00% (−2,5 / 1,8) | 41% · −0,41% (−6,4 / 2,8) | 5% · 0,00% |
| 3 voláteis (VIRTUAL, COMP, AERO) | Jul–Out 2026 | suave | 5 040 | 30% / 45% / 25% · 0,00% (−1,2 / 1,6) | 63% · 0,40% (−2,8 / 3,9) | 0% · 0,00% |
| 3 voláteis (VIRTUAL, COMP, AERO) | Jul–Out 2026 | rígido | 5 040 | 30% / 46% / 25% · 0,00% (−1,3 / 1,6) | 63% · 0,40% (−2,8 / 3,9) | 0% · 0,00% |
| 3 voláteis (VIRTUAL, COMP, AERO) | amostra de 5 anos | suave | 36 404 | 42% / 22% / 36% · 0,00% (−2,3 / 3,3) | 53% · 0,14% (−4,6 / 4,8) | 7% · 0,00% |
| 3 voláteis (VIRTUAL, COMP, AERO) | amostra de 5 anos | rígido | 36 404 | 36% / 25% / 38% · 0,00% (−2,2 / 2,3) | 50% · 0,02% (−4,6 / 4,3) | 7% · 0,00% |
| 3 voláteis (VIRTUAL, COMP, AERO) | episódios horários | suave | 3 376 | 38% / 34% / 28% · 0,00% (−0,8 / 1,0) | 41% · −0,19% (−2,1 / 1,5) | 5% · 0,00% |
| 3 voláteis (VIRTUAL, COMP, AERO) | episódios horários | rígido | 3 376 | 22% / 48% / 30% · 0,00% (−0,6 / 0,4) | 37% · −0,24% (−2,1 / 1,2) | 7% · 0,00% |
| ETH + cbBTC + USDC (com stable) | S1–S7 (stress) | suave | 112 | 35% / 35% / 30% · 0,00% (−3,3 / 1,3) | 55% · 0,15% (−4,5 / 3,3) | 1% · 0,00% |
| ETH + cbBTC + USDC (com stable) | S1–S7 (stress) | rígido | 112 | 34% / 38% / 28% · 0,00% (−1,5 / 1,2) | 55% · 0,11% (−3,4 / 3,1) | 4% · 0,00% |
| ETH + cbBTC + USDC (com stable) | Jul–Out 2026 | suave | 1 680 | 31% / 46% / 22% · 0,00% (−0,6 / 1,5) | 55% · 0,16% (−2,3 / 3,0) | 0% · 0,00% |
| ETH + cbBTC + USDC (com stable) | Jul–Out 2026 | rígido | 1 680 | 31% / 46% / 22% · 0,00% (−0,6 / 1,5) | 55% · 0,16% (−2,3 / 3,0) | 0% · 0,00% |
| ETH + cbBTC + USDC (com stable) | amostra de 5 anos | suave | 18 888 | 39% / 26% / 35% · 0,00% (−1,4 / 2,2) | 54% · 0,10% (−2,9 / 3,1) | 3% · 0,00% |
| ETH + cbBTC + USDC (com stable) | amostra de 5 anos | rígido | 18 888 | 36% / 27% / 37% · 0,00% (−1,4 / 1,6) | 52% · 0,06% (−3,0 / 2,8) | 3% · 0,00% |
| ETH + cbBTC + USDC (com stable) | episódios horários | suave | 2 072 | 28% / 48% / 25% · 0,00% (−0,6 / 0,6) | 43% · −0,13% (−2,5 / 3,0) | 3% · 0,00% |
| ETH + cbBTC + USDC (com stable) | episódios horários | rígido | 2 072 | 23% / 54% / 23% · 0,00% (−0,4 / 0,3) | 42% · −0,15% (−2,3 / 3,0) | 2% · 0,00% |

*3 voláteis, modo suave, amostra de 5 anos por regime (25% das janelas com o ETH mais volátil em cada cesto)*

| Posições | Regime | n | Discreto L2 face ao A+ contínuo: à frente / empate / atrás · mediana | Discreto L2 face ao B+: à frente / empate / atrás · mediana |
|---|---|---|---|---|
| 30 dias · diária | alta volatilidade | 3 196 | 29% / 48% / 23% · 0,00% | 50% / 1% / 50% · 0,00% |
| 30 dias · diária | normal | 9 572 | 17% / 66% / 17% · 0,00% | 52% / 1% / 47% · 0,04% |
| 90 dias · diária | alta volatilidade | 2 968 | 53% / 0% / 46% · 0,12% | 45% / 0% / 55% · −0,44% |
| 90 dias · diária | normal | 8 888 | 57% / 1% / 43% · 0,24% | 57% / 0% / 42% · 0,33% |
| 90 dias · semanal | alta volatilidade | 2 948 | 56% / 1% / 44% · 0,25% | 53% / 0% / 47% · 0,26% |
| 90 dias · semanal | normal | 8 832 | 52% / 1% / 47% · 0,04% | 56% / 0% / 43% · 0,36% |

**Preço médio por perna (histórico):** nas posições em que os dois compraram as três pernas, o A+ discreto (L = 2, suave, três voláteis) comprou com custo médio igual ao do A+ contínuo — unidades a mais com mediana 0,00% (P5 −2,0%, P95 2,9%, n = 45 012). Comprar em chunks iguais não piora o preço.


### Ciclos sem compra, e porquê

*% dos ciclos (N + 3 por posição) em que nenhuma perna comprou · a regra 5 nunca deixa um ciclo vazio: só afasta a perna quando há outra*

| Cesto | Modo | L | Calendário (menos chunks do que ciclos, pelo minFill) | Regra 9 | Banda | Sem preço | Regra 6 (tudo comprado) | Regra 5 |
|---|---|---|---|---|---|---|---|---|
| 3 voláteis (VIRTUAL, COMP, AERO) | suave | 1 | 15,57% | 3,67% | 0,00% | 0,06% | 6,82% | 0,00% |
| 3 voláteis (VIRTUAL, COMP, AERO) | suave | 2 | 15,84% | 3,73% | 0,00% | 0,06% | 7,25% | 0,00% |
| 3 voláteis (VIRTUAL, COMP, AERO) | rígido | 1 | 15,46% | 8,42% | 0,00% | 0,07% | 5,30% | 0,00% |
| 3 voláteis (VIRTUAL, COMP, AERO) | rígido | 2 | 15,62% | 8,55% | 0,00% | 0,07% | 5,49% | 0,00% |
| ETH + cbBTC + USDC (com stable) | suave | 1 | 16,93% | 1,05% | 0,53% | 0,06% | 7,00% | 0,00% |
| ETH + cbBTC + USDC (com stable) | suave | 2 | 17,04% | 1,06% | 0,53% | 0,06% | 7,15% | 0,00% |
| ETH + cbBTC + USDC (com stable) | rígido | 1 | 16,85% | 3,03% | 0,55% | 0,07% | 6,24% | 0,00% |
| ETH + cbBTC + USDC (com stable) | rígido | 2 | 16,91% | 3,05% | 0,55% | 0,07% | 6,33% | 0,00% |


### A regra de n_i

*Todas as combinações de N e divisão das posições medidas · 1 000 USD, minFill 16 USD*

| Regra | Configurações (N × divisão) | Chunks acima de N (máx.) | Configurações com chunks a mais | Configurações em que o minFill reduz |
|---|---|---|---|---|
| Maior resto (Hamilton), mínimo 1, tecto minFill — recomendada | 76 | 1 | 5,3% | 15,8% |
| ⌈w_i·N⌉, mínimo 1, tecto minFill | 76 | 2 | 61,8% | 15,8% |
| arredondamento simples, mínimo 1, tecto minFill | 76 | 1 | 31,6% | 26,3% |


## §3 — Verificação on-chain na Base

*OrderExecutorV3 da Base `0x686b4f812291F4De238E59ED00BA6dD6129e60a0` (de docs/DEPLOYMENTS.md) · `tokenUsdFeeds(address)` lido a 2026-11-07 18:17 UTC · igualdades calculadas, endereços nunca escritos à mão · o ETH/USD da Base não está no directório (v3: passo mínimo medido 0,15%)*

| Token | Endereço (catálogo do repo) | Registado | Feed | maxStaleness (s) | tokenDecimals | Limiar / heartbeat (directório) | description() on-chain | Feed = o usado na v3 |
|---|---|---|---|---|---|---|---|---|
| VIRTUAL | `0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b` | sim | `0xeaf310161c9ef7c813a14f8fef6fb271434019f7` | 90 000 | 18 | 0,5% / 86 400 s | VIRTUAL / USD | sim |
| COMP | `0x9e1028F5F1D5eDE59748FFceE5532509976840E0` | sim | `0x9dda783de64a9d1a60c49ca761ebe528c35ba428` | 90 000 | 18 | 0,5% / 86 400 s | COMP / USD | sim |
| cbBTC | `0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf` | sim | `0x07da0e54543a844a80abe69c8a12f22b3aa59f9d` | 4 800 | 8 | 0,3% / 1 200 s | cbBTC / USD | — |
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | sim | `0x7e860098f58bbfc8648a4311b374b1d669a2bc6b` | 90 000 | 6 | 0,3% / 86 400 s | USDC / USD | — |
| WETH | `0x4200000000000000000000000000000000000006` | sim | `0x71041dddad3595f9ced3dccfbe3d1f4b0a16bb70` | 3 600 | 18 | — | ETH / USD | — |
| AERO | `0x940181a94A35A4569E4529A3CDfB74e38FD98631` | **não — sem piso on-chain** | — | — | — | — | — | — |

**USDC/USD da Base.** Directório: limiar 0,3%, heartbeat 86 400 s. Observado (todas as 1 223 rondas desde Ago 2023): intervalo mediano 86 418 s, 97% das rondas por heartbeat, passo mediano 0,004% e mínimo lido 0,99936. O executor aceita-o até 90 000 s. **Com a tua regra, o limiar de 0,3% cabe em qualquer banda ≥ 1%.**

*Hora a hora, da véspera do evento a 3 dias depois da recuperação · feed aceite até heartbeat × 90 000 ÷ 86 400 (a proporção do executor da Base) · quórum = DefiLlama (aproximação declarada)*

| Evento | Limiar / heartbeat do feed | Feed aceite até (s) | Banda | Horas | Decisões que mudam (mais estrita / menos) | Horas «fora da banda»: 600 s / tua regra | Horas decididas pelo feed: 600 s / tua regra | Horas sem preço: 600 s / tua regra | Limiar cabe na banda |
|---|---|---|---|---|---|---|---|---|---|
| DAI · Mar 2023 | 0,25% / 3 600 s | 3 750 | 1% | 200 | 4 (4 / 0) | 51 / 55 | 35 / 152 | 0 / 0 | sim |
| DAI · Mar 2023 | 0,25% / 3 600 s | 3 750 | 2% | 200 | 0 (0 / 0) | 42 / 42 | 35 / 152 | 0 / 0 | sim |
| DAI · Mar 2023 | 0,25% / 3 600 s | 3 750 | 5% | 200 | 0 (0 / 0) | 13 / 13 | 35 / 152 | 0 / 0 | sim |
| DAI · Mar 2023 | 0,25% / 3 600 s | 3 750 | 10% | 200 | 0 (0 / 0) | 1 / 1 | 35 / 152 | 0 / 0 | sim |
| FRAX · Mar 2023 | 1,00% / 3 600 s | 3 750 | 1% | 200 | 0 (0 / 0) | 50 / 50 | 12 / 0 | 1 / 1 | não → quórum |
| FRAX · Mar 2023 | 1,00% / 3 600 s | 3 750 | 2% | 200 | 6 (6 / 0) | 42 / 48 | 12 / 152 | 1 / 0 | sim |
| FRAX · Mar 2023 | 1,00% / 3 600 s | 3 750 | 5% | 200 | 9 (9 / 0) | 18 / 27 | 12 / 152 | 1 / 0 | sim |
| FRAX · Mar 2023 | 1,00% / 3 600 s | 3 750 | 10% | 200 | 2 (1 / 0) | 1 / 2 | 12 / 152 | 1 / 0 | sim |
| LUSD · Mar 2023 | 1,00% / 86 400 s | 90 000 | 1% | 157 | 5 (4 / 1) | 57 / 60 | 7 / 0 | 0 / 0 | não → quórum |
| LUSD · Mar 2023 | 1,00% / 86 400 s | 90 000 | 2% | 157 | 53 (53 / 0) | 12 / 65 | 7 / 109 | 0 / 0 | sim |
| LUSD · Mar 2023 | 1,00% / 86 400 s | 90 000 | 5% | 157 | 0 (0 / 0) | 0 / 0 | 7 / 109 | 0 / 0 | sim |
| LUSD · Mar 2023 | 1,00% / 86 400 s | 90 000 | 10% | 157 | 0 (0 / 0) | 0 / 0 | 7 / 109 | 0 / 0 | sim |
| USDP · Mar 2023 | 1,00% / 86 400 s | 90 000 | 1% | 230 | 3 (3 / 0) | 47 / 50 | 39 / 0 | 0 / 0 | não → quórum |
| USDP · Mar 2023 | 1,00% / 86 400 s | 90 000 | 2% | 230 | 17 (15 / 2) | 17 / 30 | 39 / 182 | 0 / 0 | sim |
| USDP · Mar 2023 | 1,00% / 86 400 s | 90 000 | 5% | 230 | 2 (2 / 0) | 0 / 2 | 39 / 182 | 0 / 0 | sim |
| USDP · Mar 2023 | 1,00% / 86 400 s | 90 000 | 10% | 230 | 0 (0 / 0) | 0 / 0 | 39 / 182 | 0 / 0 | sim |
| USDT · May 2022 | 0,25% / 86 400 s | 90 000 | 1% | 182 | 3 (3 / 0) | 4 / 7 | 5 / 182 | 0 / 0 | sim |
| USDT · May 2022 | 0,25% / 86 400 s | 90 000 | 2% | 182 | 0 (0 / 0) | 1 / 1 | 5 / 182 | 0 / 0 | sim |
| USDT · May 2022 | 0,25% / 86 400 s | 90 000 | 5% | 182 | 0 (0 / 0) | 0 / 0 | 5 / 182 | 0 / 0 | sim |
| USDT · May 2022 | 0,25% / 86 400 s | 90 000 | 10% | 182 | 0 (0 / 0) | 0 / 0 | 5 / 182 | 0 / 0 | sim |
| TUSD · Jan 2024 | 0,30% / 86 400 s | 90 000 | 1% | 1 081 | 46 (46 / 0) | 1022 / 1068 | 22 / 1081 | 0 / 0 | sim |
| TUSD · Jan 2024 | 0,30% / 86 400 s | 90 000 | 2% | 1 081 | 127 (125 / 2) | 317 / 440 | 22 / 1081 | 0 / 0 | sim |
| TUSD · Jan 2024 | 0,30% / 86 400 s | 90 000 | 5% | 1 081 | 0 (0 / 0) | 0 / 0 | 22 / 1081 | 0 / 0 | sim |
| TUSD · Jan 2024 | 0,30% / 86 400 s | 90 000 | 10% | 1 081 | 0 (0 / 0) | 0 / 0 | 22 / 1081 | 0 / 0 | sim |
| USDC · Mar 2023 | 0,25% / 82 800 s | 86 250 | 1% | 199 | 7 (6 / 1) | 50 / 55 | 31 / 196 | 0 / 0 | sim |
| USDC · Mar 2023 | 0,25% / 82 800 s | 86 250 | 2% | 199 | 0 (0 / 0) | 43 / 43 | 31 / 196 | 0 / 0 | sim |
| USDC · Mar 2023 | 0,25% / 82 800 s | 86 250 | 5% | 199 | 2 (0 / 2) | 19 / 17 | 31 / 196 | 0 / 0 | sim |
| USDC · Mar 2023 | 0,25% / 82 800 s | 86 250 | 10% | 199 | 0 (0 / 0) | 1 / 1 | 31 / 196 | 0 / 0 | sim |
| USDS · Oct 2024 | 0,30% / 82 800 s | 86 250 | 1% | 1 081 | 254 (12 / 222) | 267 / 57 | 79 / 1081 | 20 / 0 | sim |
| USDS · Oct 2024 | 0,30% / 82 800 s | 86 250 | 2% | 1 081 | 145 (1 / 124) | 145 / 22 | 79 / 1081 | 20 / 0 | sim |
| USDS · Oct 2024 | 0,30% / 82 800 s | 86 250 | 5% | 1 081 | 22 (0 / 2) | 2 / 0 | 79 / 1081 | 20 / 0 | sim |
| USDS · Oct 2024 | 0,30% / 82 800 s | 86 250 | 10% | 1 081 | 20 (0 / 0) | 0 / 0 | 79 / 1081 | 20 / 0 | sim |
| USDC na Base · Aug 2023 – Nov 2026 (sem descolamento) | 0,30% / 86 400 s | 90 000 | 1% | 28 601 | 18 (0 / 15) | 15 / 0 | 191 / 28601 | 3 / 0 | sim |
| USDC na Base · Aug 2023 – Nov 2026 (sem descolamento) | 0,30% / 86 400 s | 90 000 | 2% | 28 601 | 5 (0 / 2) | 2 / 0 | 191 / 28601 | 3 / 0 | sim |
| USDC na Base · Aug 2023 – Nov 2026 (sem descolamento) | 0,30% / 86 400 s | 90 000 | 5% | 28 601 | 3 (0 / 0) | 0 / 0 | 191 / 28601 | 3 / 0 | sim |
| USDC na Base · Aug 2023 – Nov 2026 (sem descolamento) | 0,30% / 86 400 s | 90 000 | 10% | 28 601 | 3 (0 / 0) | 0 / 0 | 191 / 28601 | 3 / 0 | sim |

**Leitura.** Nos descolamentos reais as duas regras marcam o início do evento à mesma hora (ou uma hora antes com a tua); a tua acrescenta horas de «não compra» quando o feed está parado perto da borda da banda (TUSD em 2024, LUSD acima do peg em 2023), porque soma o limiar. Fora dos eventos é a tua que é mais limpa: no USDC da Base tira os falsos alarmes e as horas sem preço que o DefiLlama traz; no USDS em 2024 tira 222 horas de «fora da banda» que só o DefiLlama via. No FRAX e no LUSD, com limiar de 1%, a banda de 1% não cabe e a tua regra cai no quórum, como desenhaste.


## §1 — O aviso da banda

*Gerada por `python3 src/experiments_v31.py` (escreve results/v31/aviso_banda.csv) · inventário da T7, «recuperou» = voltou a ≥ 0,99 e ficou 30 dias · stablecoins em USD com ≥ 50 M USD em circulação · desde 30 Dez 2020 (2 137 dias) · conta stables distintas (a sUSD caiu duas vezes: recuperou em 2021, não em 2024; conta como «recuperou»)*

| Banda X | N (stables) | R (recuperaram) | Quedas / recuperadas (eventos) | Texto | Problema |
|---|---|---|---|---|---|
| 10% | 20 | 7 | 21 / 7 | Das 20 stables que caíram mais de 10%, só 7 recuperaram. Nenhuma stable, nos últimos 2137 dias, recuperou de uma queda de 80%. Ainda assim, quer avançar? | nenhum |
| 15% | 17 | 3 | 17 / 3 | Das 17 stables que caíram mais de 15%, só 3 recuperaram. Nenhuma stable, nos últimos 2137 dias, recuperou de uma queda de 80%. Ainda assim, quer avançar? | nenhum |
| 20% | 16 | 3 | 16 / 3 | Das 16 stables que caíram mais de 20%, só 3 recuperaram. Nenhuma stable, nos últimos 2137 dias, recuperou de uma queda de 80%. Ainda assim, quer avançar? | nenhum |
| 25% | 16 | 3 | 16 / 3 | Das 16 stables que caíram mais de 25%, só 3 recuperaram. Nenhuma stable, nos últimos 2137 dias, recuperou de uma queda de 80%. Ainda assim, quer avançar? | nenhum |
| 30% | 13 | 1 | 13 / 1 | Das 13 stables que caíram mais de 30%, só 1 recuperou. Nenhuma stable, nos últimos 2137 dias, recuperou de uma queda de 80%. Ainda assim, quer avançar? | nenhum |
| 35% | 13 | 1 | 13 / 1 | Das 13 stables que caíram mais de 35%, só 1 recuperou. Nenhuma stable, nos últimos 2137 dias, recuperou de uma queda de 80%. Ainda assim, quer avançar? | nenhum |
| 40% | 13 | 1 | 13 / 1 | Das 13 stables que caíram mais de 40%, só 1 recuperou. Nenhuma stable, nos últimos 2137 dias, recuperou de uma queda de 80%. Ainda assim, quer avançar? | nenhum |
| 45% | 13 | 1 | 13 / 1 | Das 13 stables que caíram mais de 45%, só 1 recuperou. Nenhuma stable, nos últimos 2137 dias, recuperou de uma queda de 80%. Ainda assim, quer avançar? | nenhum |
| 50% | 13 | 1 | 13 / 1 | Das 13 stables que caíram mais de 50%, só 1 recuperou. Nenhuma stable, nos últimos 2137 dias, recuperou de uma queda de 80%. Ainda assim, quer avançar? | nenhum |
| 55% | 13 | 1 | 13 / 1 | Das 13 stables que caíram mais de 55%, só 1 recuperou. Nenhuma stable, nos últimos 2137 dias, recuperou de uma queda de 80%. Ainda assim, quer avançar? | nenhum |
| 60% | 13 | 1 | 13 / 1 | Das 13 stables que caíram mais de 60%, só 1 recuperou. Nenhuma stable, nos últimos 2137 dias, recuperou de uma queda de 80%. Ainda assim, quer avançar? | nenhum |
| 65% | 12 | 1 | 12 / 1 | Das 12 stables que caíram mais de 65%, só 1 recuperou. Nenhuma stable, nos últimos 2137 dias, recuperou de uma queda de 80%. Ainda assim, quer avançar? | nenhum |
| 70% | 12 | 1 | 12 / 1 | Das 12 stables que caíram mais de 70%, só 1 recuperou. Nenhuma stable, nos últimos 2137 dias, recuperou de uma queda de 80%. Ainda assim, quer avançar? | nenhum |
| 75% | 12 | 1 | 12 / 1 | Das 12 stables que caíram mais de 75%, só 1 recuperou. Nenhuma stable, nos últimos 2137 dias, recuperou de uma queda de 80%. Ainda assim, quer avançar? | nenhum |
| 80% | 10 | 0 | 10 / 0 | Das 10 stables que caíram mais de 80%, nenhuma recuperou. Nenhuma stable, nos últimos 2137 dias, recuperou de uma queda de 80%. Ainda assim, quer avançar? | nenhum |
| 85% | 10 | 0 | 10 / 0 | Das 10 stables que caíram mais de 85%, nenhuma recuperou. Nenhuma stable, nos últimos 2137 dias, recuperou de uma queda de 80%. Ainda assim, quer avançar? | nenhum |
| 90% | 8 | 0 | 8 / 0 | Das 8 stables que caíram mais de 90%, nenhuma recuperou. Nenhuma stable, nos últimos 2137 dias, recuperou de uma queda de 80%. Ainda assim, quer avançar? | nenhum |
| 95% | 8 | 0 | 8 / 0 | Das 8 stables que caíram mais de 95%, nenhuma recuperou. Nenhuma stable, nos últimos 2137 dias, recuperou de uma queda de 80%. Ainda assim, quer avançar? | nenhum |
| 100% | 0 | 0 | 0 / 0 | Nenhuma stable, nos últimos 2137 dias, recuperou de uma queda de 80%. Ainda assim, quer avançar? | ninguém caiu tanto: a 1.ª frase não se pode dizer |

**Verificação.** Para as bandas acima de 10%, o texto é verdadeiro em todas: N e R são exactamente o que o inventário diz, «só» só aparece com R < N, e nenhuma stable recuperou de 80% ou mais. Três notas para a UI: (1) singular com R = 1; (2) «nenhuma recuperou» com R = 0; (3) com X = 100% não há N e o aviso fica só com a segunda frase. **Correcção à rev. 3 da v3:** usei 2 501 dias (desde 1 Jan 2020); o universo completo só está coberto desde 30 Dez 2020, por isso D = 2 137. A v3 fica como estava (regra do pacote); vale este número.


## Testes do motor

- `test_discrete_split_is_exact_by_construction` — S1–S7, os 4 cestos, suave/rígido, L = 1/2: cada compra é exactamente um chunk, nenhuma perna vende mais do que w_i·C, no máximo L chunks por perna por ciclo, nada depois do expiry, o que fica por comprar soma o resto do capital; com todos os chunks executados o desvio é 0.
- `test_chunks_respect_min_fill_and_hamilton_sum` — chunk ≥ minFill, n_i ≥ 1, e Σ n_i = N quando o minFill não morde.
- `test_band_blocks_the_stable_leg_in_the_discrete_basket` — USDC no SVB e UST em Mai 2022, horário, ciclos de graça incluídos: nenhuma compra da stable fora da banda.
- Os 14 testes da v2 e da v3 continuam a passar.


## O que não foi medido, e porquê

- **Gas e falhas de execução por ordem**: 3 ordens por cesto significam 3 assinaturas e até 2 execuções por ciclo com L = 2; o custo por execução é o da v3 (0,003 / 0,016 USD), não medido de novo.
- **A ordem real do keeper dentro de um ciclo** (qual das 3 ordens é submetida primeiro, o que acontece se uma transacção falha): modelei a escolha por regra 4 e a recuperação pela perna mais atrasada; o resto é capacidade do keeper.
- **O `dcaInterval` exacto com L = 2**: modelado como «até 2 chunks por perna por ciclo»; no contrato são 2 janelas de meio ciclo, por isso o segundo chunk sai meio ciclo depois (o preço desse meio ciclo não foi usado).
- **O feed USDC/USD da Base nos eventos reais**: não existia antes de Ago 2023; a regra da banda foi simulada com os feeds de Ethereum de cada stable e o maxStaleness na proporção do executor da Base.
- **O quórum real** (CoinGecko sem histórico) e a disponibilidade ao vivo do DefiLlama, como na v3.


## O que isto muda na spec (proposta)

1. **Basket = 3 ordens DCA do V3**, uma por perna, chunk fixo, `n_i` pela regra do maior resto com mínimo 1 e tecto pelo minFill.
2. **L = 2** (`dcaInterval = cadência ÷ 2`): completa quase todas as posições no modo suave (102 incompletas em 41 636 nas cadências do produto).
3. **`expiry = início + (N + 3) × cadência + margem`**, como propuseste; o que não executar fica na carteira e vai para o relatório de fecho.
4. **Modo suave por defeito.** No rígido, a perna protegida até ao fim fica por comprar em muitas posições de stress; isso deve ser dito ao utilizador quando escolhe o rígido.
5. **Banda na Base com a tua regra** (feed até ao maxStaleness, limiar somado, quórum quando o limiar não cabe).
6. **Aviso** com o texto do dono, lido da tabela X → (N, R), D = 2 137 dias e as três regras de redacção acima.
