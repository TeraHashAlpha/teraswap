# Basket DCA — modelação v3 (RESULTS-2026-11-v3)

**Da Analista para o Arquitecto.** Responde ao pedido `ANALISTA-basket-dca-modelacao-v3-2026-11-07.md`. Mede o **A+** — o A da v2 com quatro interruptores (P preço único, M mínimo por compra, E liquidação escalonada, B banda de peg) — e, como pediu o dono, **com o cesto de três voláteis como produto principal**: ETH + cbBTC + X, com X = VIRTUAL, COMP ou AERO. O cesto com stable (ETH + cbBTC + USDC) corre em todos os testes e aparece sempre em segundo lugar. Só janelas reais: S1–S7, âncora de Julho, Jul–Out 2026, a amostra de 5 anos e os 7 episódios horários. O `RESULTS-2026-11.md` da v2 não muda; um comando (`python3 run_all.py --no-fetch`) refaz v2 e v3. Com todos os interruptores desligados, o A+ reproduz o A da v2 compra a compra (teste no pacote).

> **Rev. 3 (7 Nov 2026, decisões do dono).** (1) O último ciclo sem preço espera até 3 ciclos; se o preço não voltar, a ordem fecha com essa perna por comprar e o utilizador vê porquê num relatório no site; a stable de entrada nunca pausa. (2) Banda de peg: até 10% sem aviso; acima disso, um aviso único com o facto de que nenhuma stable recuperou de uma queda de 80%. Ambas medidas na secção «Decisões do dono»; os números derivados dos dados (D_rec, tecto) ficam em T7 para referência.

> Separação de sempre: **(a)** a garantia — desvio face à divisão pedida, em pp; **(b)** o que aconteceu ao valor e ao preço — histórico, nunca promessa. Cada número tem o seu cenário ao lado; intervalos em mínimo / mediana / máximo.


## As oito respostas

**T8 — Três voláteis como produto principal: a repartição é cumprida? Alguma regra pior?**

**Sim, a repartição é cumprida nas 45 600 posições de três voláteis** (2.1, 2.2, 2.3, 2.11 e §2.10, A+ e B+), nas três escolhas de X. Em 66 delas o último ciclo não tinha preço utilizável; com a regra do dono (esperar até 3 ciclos) todas compraram num dos ciclos seguintes. **A regra que se comporta pior é a 9.** Sem stable, uma queda forte protege as pernas todas ao mesmo tempo: protecção em 47% das posições (cesto com stable: 26%), as três pernas protegidas em simultâneo em 9,6% (com stable: 0,4%, só no colapso da UST), até 48 ciclos seguidos sem nenhuma perna elegível. O E (k = 10, sem tecto) segura a concentração: maior compra única 22,5% no pior caso com todos os interruptores (uma posição COMP semanal de 13 ciclos; ≤ 20% em todas as outras com 8 ou mais ciclos), contra 50% sem o E. As regras 5 e 6 comportam-se como no cesto com stable. **Valor (histórico):** A+ à frente de B+ em 49% das 36 404 posições da amostra de 5 anos (mediana −0,02%), e à frente do DCA só em ETH em 48%. A «rotação de volatilidade» existe — quando duas pernas sobem e uma desce, o ciclo compra a que desceu em 68% dos ciclos em que compra — mas não compra mais barato: unidades a mais face ao B+ com mediana 0,01%, igual à de uma rotação cega (0,10%). É ruído. **Recomendo:** E com k = 10 no cesto de três voláteis; cadência mínima diária; e a regra dos 3 ciclos do dono. A regra 4 não precisa de mudar — não acrescenta nem tira.

**T1 — Preço único (P): a conclusão (viii) muda?**

**A (viii) mantém-se, ligeiramente mais fraca.** No cesto com stable, a regra 4 decide de outra forma numa minoria de ciclos (mediana 0 por posição; média 5,5%; máximo 92%), porque USDC e BTC passam a decidir quase sempre pelo DefiLlama (USDC em 85% dos ticks, BTC em 43%). Contra o DCA fixo, em posições de 30 dias: alta volatilidade 47,5% → 45,8% à frente; normal 59,2% → 57,3%. No cesto de três voláteis o efeito é o mesmo e mais forte em X: os feeds de X têm heartbeat de 24 h, por isso X decide pelo DefiLlama em 71% (VIRTUAL), 80% (COMP) e 100% (AERO) dos ticks diários. **Com P, a diferença entre um X de fase 1 e um de fase 2 quase desaparece na cadência diária.** Sem nenhuma espera, 20 de 20 680 posições partiam a divisão por falta de preço no último ciclo; com a regra do dono (até 3 ciclos), no cesto com stable 23 de 31 compraram num dos ciclos seguintes e nas outras 8 (UST, Mai 2022) o preço voltou com a stable fora da banda, por isso a perna ficou por comprar, como manda a banda.

**T2 — Mínimo por compra (M): cumpre sem estragar a garantia?**

**Sim.** Com 16 USD (rota agregador), uma posição de 100 USD a 30–90 ciclos diários passa de 40 para 7 compras (mediana); com 1 000 USD quase não muda. Nenhuma compra fora do último ciclo ficou abaixo do mínimo (menor: 16,09 USD agregador, 3,03 USD canónica); o último ciclo, isento, chegou a comprar 0,21 USD. Desvio máximo observado: 0,0000 USD por perna (limite: 0,01 USD). Com todos os interruptores, nos três voláteis, o desvio ficou dentro do mesmo limite.

**T3 — Liquidação escalonada (E): que k e que tecto?**

**k = 10, sem tecto.** No cesto de três voláteis, com a regra 9 a 25%, a maior compra única desce de 50,0% (k = 1, a v2) para 19,9%, com desvio 0 em todas as janelas com 6 ou mais ciclos (o pior: AERO · S5 janela semanal · 11 ciclos · 25-25-50). k = 5 falha por pouco (20,3%, mesma posição). No cesto com stable, k = 10 dá 20,8% em S1 semanal (7 ciclos) e 16,8% a partir de 8 ciclos: **com 6–7 ciclos nenhuma combinação cumpre ≤ 20% com desvio 0 no cesto com stable**. O tecto não serve: sempre que trava, parte a divisão (até 40 pp com 10%). Sem stable, as três pernas ficaram protegidas ao mesmo tempo em 300 de 3 568 posições (até 33 ciclos seguidos); com stable, em 92 de 2 184 (todas no colapso da UST).

**T4 — Feeds da Base: bons inputs para a regra 4?**

**O USDC/USD da Base existe e está registado** — no repo (última versão local, 50c142d) e on-chain no próprio OrderExecutorV3 da Base (`tokenUsdFeeds` → registado, maxStaleness 90 000 s). Mas é um feed de 24 h com desvio de 0,3%: a ronda tem em mediana 12 h no tick e está acima de 600 s em 99% das horas, por isso **com o preço único a perna stable e a banda de peg na Base decidem quase sempre pelo DefiLlama**. ETH e cbBTC são bons inputs em cadência diária (decisões que mudam face à bolsa: mediana 4,5% e 2,2%, contra 12% do AERO na v2) e maus em cadência horária (23% e 23%). Nenhum tem o problema do AERO em cadência diária.

**T5 — Capital mínimo face ao cap de 250 USD**

**Confirmado: 15 compras na rota agregador e 83 na canónica** pagam o gas com a fee de uma posição de 250 USD (0,25 USD ÷ 0,016 e ÷ 0,003). **Com M, a fee cobre o gas de todas as compras excepto as do último ciclo, que é isento**: a 250 USD o pior caso medido foi 0,288 USD de gas para 0,25 USD de fee.

**T6 — O que o A+ dá que o B+ não dá, em números**

Nas mesmas janelas e com as mesmas protecções, o A+ fez 30 compras por posição de 30 dias contra 45 do B+ (0,24 USD de gas a menos, rota agregador) e acabou com mais valor em 50% das 45 012 posições de três voláteis (51% das 22 752 com stable), com diferença mediana de 0,00% do capital; a garantia da divisão é a mesma nos dois.

**T7 — Banda de peg: D_rec, tecto e a stable de entrada**

**Os dados dão D_rec = 11,9%** (FRAX no SVB, 11 Mar 2023, feed Chainlink hora a hora; USDC 11,7% no mesmo evento) e, pela regra dos 5 pp, tecto 6,9%. **Decisão do dono: banda até 10% sem aviso; acima, um aviso único:** «Nenhuma stable, nos últimos 2 501 dias, recuperou de uma queda de 80%. Ainda assim, quer avançar?» O facto confirma-se: desde 1 Jan 2020, 10 stables (com ≥ 50 M USD em circulação) caíram 80% ou mais e 0 recuperaram. Os 10% sem aviso ficam abaixo das maiores recuperações confirmadas (FRAX 11,9%, USDC 11,7%). **Uma ressalva:** o aviso fala de 80%, mas quem escolhe, por exemplo, 20% está noutro sítio da história — das 16 stables que caíram mais de 20%, só 3 recuperaram. Proponho que o aviso diga também o número da banda escolhida (texto abaixo). A perda continua limitada ao peso da perna. **Stable de entrada: sem pausa** (decidido). No SVB a pausa a 1% poupava o desconto (mediana 1,01% → 0,13%) mas o valor final ficou pior em 61% das posições; na UST custava −20,6% em mediana.


## Decisões do dono depois da v3 (rev. 2)


### 1. Último ciclo sem preço: esperar até 3 ciclos, depois fechar e explicar

**Regra.** Se no último ciclo uma perna não tem preço utilizável (Chainlink com mais de 600 s e sem quórum), a ordem não fecha logo: tenta de novo nos 3 ciclos seguintes, à cadência da ordem. No primeiro em que houver preço, compra o que falta a essa perna (e a banda de peg continua a valer nesse momento). Se nos 3 não houver, a ordem fecha com essa perna por comprar; esse dinheiro fica com o utilizador e o relatório no site explica porquê. A stable de entrada nunca pausa. **Como foi simulado:** os 3 ciclos seguintes ao fim de cada posição, com o mesmo preço de decisão (P) e execução ao preço do feed nesse ciclo; nos episódios horários, quando não temos o feed nessa hora, ao preço de decisão.

*Todas as posições de T6/T8 (2.1, 2.2, 2.3, 2.11, §2.10) · linhas horárias só onde houve casos*

| Cesto | Estratégia | Cadência | Posições | Último ciclo sem preço | Comprou no 1.º / 2.º / 3.º ciclo seguinte | Fechou por falta de preço | Preço voltou com a stable fora da banda (não compra, por desenho) |
|---|---|---|---|---|---|---|---|
| 3 voláteis (os três X juntos) | A+ | 1 h | 1 152 | 9 | 7 / 0 / 2 | 0 | 0 |
| 3 voláteis (os três X juntos) | A+ | diária | 27 828 | 41 | 41 / 0 / 0 | 0 | 0 |
| 3 voláteis (os três X juntos) | A+ | semanal | 14 396 | 16 | 16 / 0 / 0 | 0 | 0 |
| 3 voláteis (os três X juntos) | B+ | 1 h | 1 152 | 16 | 12 / 0 / 4 | 0 | 0 |
| 3 voláteis (os três X juntos) | B+ | 24 h | 1 308 | 8 | 8 / 0 / 0 | 0 | 0 |
| 3 voláteis (os três X juntos) | B+ | 4 h | 916 | 4 | 4 / 0 / 0 | 0 | 0 |
| 3 voláteis (os três X juntos) | B+ | diária | 27 828 | 65 | 65 / 0 / 0 | 0 | 0 |
| 3 voláteis (os três X juntos) | B+ | semanal | 14 396 | 28 | 28 / 0 / 0 | 0 | 0 |
| ETH + cbBTC + USDC (com stable) | A+ | 24 h | 840 | 4 | 0 / 0 / 0 | 0 | 4 |
| ETH + cbBTC + USDC (com stable) | A+ | 4 h | 560 | 4 | 0 / 0 / 0 | 0 | 4 |
| ETH + cbBTC + USDC (com stable) | A+ | diária | 13 992 | 17 | 17 / 0 / 0 | 0 | 0 |
| ETH + cbBTC + USDC (com stable) | A+ | semanal | 7 024 | 6 | 6 / 0 / 0 | 0 | 0 |
| ETH + cbBTC + USDC (com stable) | B+ | 24 h | 840 | 11 | 11 / 0 / 0 | 0 | 4 |
| ETH + cbBTC + USDC (com stable) | B+ | 4 h | 560 | 4 | 4 / 0 / 0 | 0 | 4 |
| ETH + cbBTC + USDC (com stable) | B+ | diária | 13 992 | 28 | 28 / 0 / 0 | 0 | 0 |
| ETH + cbBTC + USDC (com stable) | B+ | semanal | 7 024 | 12 | 12 / 0 / 0 | 0 | 0 |

**Leitura.** Em 68 688 posições A+ (os dois cestos), o último ciclo ficou sem preço em 97. Nenhuma fechou por falta de preço: o preço voltou no ciclo seguinte em quase todas (nas três voláteis, 64 no 1.º e 2 no 3.º). As 8 que ficaram com uma perna por comprar são todas a UST em Mai 2022: o preço voltou, mas a stable estava fora da banda, e a banda não a deixa comprar — é a banda a fazer o que deve, e é o mesmo relatório que o explica. Os casos vêm das lacunas do histórico do DefiLlama com o feed acima de 600 s; ao vivo, o quórum lê o DefiLlama e a CoinGecko no momento, por isso estes números são um limite superior.

**O relatório no site (proposta de conteúdo).** Um relatório de fecho para todas as ordens, que só fica longo quando alguma coisa correu fora do normal:

- **Divisão pedida contra divisão cumprida**, por perna, em USD e em %.
- **Compras feitas**: data, perna, valor e preço de cada uma.
- **Ciclos sem compra e porquê**: sem preço fiável (feed com mais de 10 minutos e quórum indisponível), perna protegida pela regra 9, stable fora da banda de peg, compra abaixo do mínimo adiada para a seguinte (M).
- **Se uma perna ficou por comprar**: quanto (USD e % da ordem), a razão em linguagem simples (por exemplo, «não houve um preço fiável para AERO no último ciclo nem nos 3 seguintes»), as horas das 4 tentativas e onde está esse dinheiro (na carteira do utilizador, nunca gasto noutra perna).
- O mesmo formato serve para a perna stable que acaba fora da banda e para o modo rígido da regra 9, que também podem deixar dinheiro por investir.


### 2. Banda de peg: até 10% sem aviso; acima, um aviso

**Regra.** O utilizador escolhe a banda (1% por defeito). Até 10% não há aviso. Acima de 10%, um aviso único antes de criar a ordem: «Nenhuma stable, nos últimos 2 501 dias, recuperou de uma queda de 80%. Ainda assim, quer avançar?» Se recusar, a ordem não é criada. **X** = dias de histórico do inventário (de 1 Jan 2020 a 6 Nov 2026 são 2 501); o número sai do mesmo script que faz o inventário e actualiza-se sozinho.

**O facto, medido.** Das stables com pelo menos 50 M USD em circulação, 10 caíram 80% ou mais desde 2020 e nenhuma recuperou (voltar a ≥ 0,99 e lá ficar 30 dias). A maior queda que recuperou foi 75% (MIM, 30 Jan 2024, ao fim de 370 dias, vista só no agregador); confirmada em duas fontes, 11,9%. **Os 10% sem aviso:** ficam abaixo das maiores recuperações confirmadas (FRAX 11,9% e USDC 11,7% no SVB, ambas em 2 dias). Contando também as quedas vistas só no agregador, das 21 stables que caíram mais de 10%, 7 recuperaram.

*Desde 1 Jan 2020 (2 501 dias), stablecoins em USD com ≥ 50 M USD em circulação no início da queda · é a tabela que alimenta o aviso*

| Queda | Stables que chegaram lá | Recuperaram | Não recuperaram | Recuperaram (%) |
|---|---|---|---|---|
| ≥ 5% | 33 | 19 | 14 | 58% |
| ≥ 10% | 21 | 7 | 14 | 33% |
| ≥ 20% | 16 | 3 | 13 | 19% |
| ≥ 30% | 13 | 1 | 12 | 8% |
| ≥ 50% | 13 | 1 | 12 | 8% |
| ≥ 75% | 12 | 1 | 11 | 8% |
| ≥ 80% | 10 | 0 | 10 | 0% |
| ≥ 90% | 8 | 0 | 8 | 0% |

**A ressalva da Analista.** O aviso, tal como está, diz a verdade para quem escolhe 80% ou mais. Para quem escolhe 20% ou 30%, a mesma frase pode ler-se como «até 80% costuma recuperar», e os dados dizem o contrário: das 16 que caíram mais de 20%, recuperaram 3; das 13 que caíram mais de 50%, 1. **Proposta**, com a mesma estrutura de uma pergunta: «A banda que escolheste deixa o Basket continuar a comprar esta stable até X% abaixo de 1 USD. Nos últimos 2 501 dias, das N stables que caíram mais de X%, só R recuperaram, e nenhuma recuperou de uma queda de 80%. Se a stable não recuperar, podes perder até P% desta posição (o peso que lhe deste). Ainda assim, quer avançar?» Com X = 20%: N = 16, R = 3; com X = 50%: N = 13, R = 1. A decisão é tua.

*As stables que não recuperaram: quanto tempo uma banda de 10% ainda compraria (até passar −10%) e quanto demoraram a chegar a −80% (agregador: mínimo sustentado)*

| Stable | Início | Confirmado | Queda máx. (%) | Passou −10% (fim da banda sem aviso) | Passou −80% | Entre os dois | Último preço | Estado |
|---|---|---|---|---|---|---|---|---|
| DEUSD | 6 Nov 2025 | só agregador | 100,0 | 2025-11-06 15:58 | 2025-11-06 15:58 | 0,0 d | 0,0000 | colapsou |
| UST | 9 Mai 2022 | sim | 99,3 | 2022-05-09 23:00 | 2022-05-13 02:00 | 3,1 d | 0,0000 | colapsou |
| USDX | 6 Nov 2025 | só agregador | 99,3 | 2025-11-06 12:59 | 2025-11-07 10:58 | 0,9 d | 0,0074 | colapsou |
| YU | 16 Nov 2025 | só agregador | 99,2 | 2025-11-17 19:58 | 2025-11-17 23:59 | 0,2 d | 0,3837 | colapsou |
| PUSD | 20 Mar 2026 | só agregador | 99,2 | 2026-04-23 13:58 | 2026-04-23 13:58 | 0,0 d | 0,0323 | colapsou |
| USDN | 28 Set 2021 | só agregador | 98,5 | 2022-04-05 00:00 | 2023-03-12 00:00 | 341,0 d | 0,0157 | colapsou |
| HUSD | 11 Out 2022 | só agregador | 97,6 | 2022-10-28 11:58 | 2022-11-09 08:57 | 11,9 d | 0,0341 | colapsou |
| USR | 22 Mar 2026 | só agregador | 96,0 | 2026-03-22 02:59 | 2026-03-26 15:58 | 4,5 d | 0,0408 | colapsou |
| USDX | 29 Set 2021 | só agregador | 90,0 | 2022-05-09 00:00 | 2023-04-11 00:00 | 337,0 d | 0,6583 | não recuperou |
| MSUSD | 20 Jun 2026 | só agregador | 86,9 | 2026-06-20 15:59 | 2026-06-20 17:58 | 0,1 d | 0,5268 | em curso |
| sUSD | 30 Dez 2024 | só agregador | 77,2 | 2025-04-09 10:59 | — | — | 0,2319 | colapsou |
| pmUSD | 3 Mai 2026 | só agregador | 60,3 | 2026-05-04 15:58 | — | — | 0,5627 | não recuperou |
| apxUSD | 3 Jun 2026 | só agregador | 25,2 | 2026-06-17 00:00 | — | — | 0,9925 | em curso |
| USDA | 6 Jul 2026 | só agregador | 19,2 | 2026-08-01 04:52 | — | — | 0,9080 | em curso |


### 3. Stable de entrada: sem pausa

Aceite. O Basket e o DCA de um token continuam a comprar enquanto a stable de entrada estiver descolada; a análise que levou à recomendação está em T7.


## Os X escolhidos (§0.1)

*Três X (o pedido dizia 3 a 5): os outros X de fase 1 do catálogo têm feeds com menos de um ano de histórico e não acrescentavam janelas reais*

| X | Fase | Feed (do registo do repo / directório; description() verificada on-chain) | Desde | Porquê |
|---|---|---|---|---|
| VIRTUAL | fase 1 (registado, enabled) | `0xEaf310161c9eF7c813A14f8FEF6Fb271434019F7` · VIRTUAL / USD · Base | 17 Jan 2025 | Nativo da Base, o X de fase 1 com mais volume no catálogo; o mais volátil dos três |
| COMP | fase 1 (registado, enabled) | `0x9DDa783DE64A9d1A60c49ca761EbE528C35BA428` · COMP / USD · Base; antes de Ago 2023 `0xdbd020CAeF83eFd542f4De03e3cF0C28A4428bd5` (Ethereum) | 1 Dez 2021 | O único X com histórico Chainlink que cobre 2022 (S1, S2, S3, S7 e os episódios E1–E4) |
| AERO | fase 2 (feed existe, não registado) | `0x4EC5970fC728C5f65ba413992CD5fF6FD70fcfF0` · AERO / USD · Base (só para executar; a decisão é pelo quórum) | 5 Abr 2024 | O perfil que pediste: sem feed na keeper, decide pelo quórum (DefiLlama aqui) |

Uma janela entra num cesto só se as três pernas tiverem série Chainlink para a posição inteira; o resto vai para «não medido». BTC = cbBTC na Base quando existe, como na v2 (WBTC antes). Os feeds dos X têm heartbeat de 24 h e desvio de 0,5%; os preços de execução são os do feed, como na v2.


## T8 — O cesto de três voláteis como produto principal

**Mecânica.** A+ = P + M (16 USD, rota agregador) + E (k = 10, sem tecto, de T3) + regra 9 a 25% em modo suave; no cesto com stable, também B (banda 1%). B+ = DCA fixo de 3 pernas com exactamente as mesmas regra 9, E, M, P (e B). C = DCA só em ETH, mesmo capital e cadência. Todos com a regra do dono para o último ciclo sem preço (até 3 ciclos; ver «Decisões do dono»).


### A garantia: desvio final

*Desvio = max |gasto na perna ÷ capital − peso pedido| · M deixa no máximo 0,01 USD por perna · fora disso, só a banda de peg (UST em Mai 2022, USDC em Mar 2023, por desenho) e a regra dos 3 ciclos do dono (perna por comprar, reportada) deixam desvio*

| Cesto | Janelas | Posições | Desvio máx. A+ (pp) | Desvio máx. B+ (pp) | Posições A+ com desvio | Último ciclo sem preço, A+ / B+ | Fechou com perna por comprar (3 ciclos), A+ / B+ |
|---|---|---|---|---|---|---|---|
| ETH + cbBTC + VIRTUAL | S1–S7 (stress) | 32 | 0 | 0 | 0 | 0 / 0 | 0 / 0 |
| ETH + cbBTC + VIRTUAL | âncora de Julho (meses voláteis) | 84 | 0 | 0 | 0 | 0 / 0 | 0 / 0 |
| ETH + cbBTC + VIRTUAL | Jul–Out 2026 | 1 680 | 0 | 0 | 0 | 0 / 0 | 0 / 0 |
| ETH + cbBTC + VIRTUAL | amostra de 5 anos | 7 036 | 0 | 0 | 0 | 0 / 0 | 0 / 0 |
| ETH + cbBTC + VIRTUAL | episódios horários | 564 | 0 | 0 | 0 | 0 / 0 | 0 / 0 |
| ETH + cbBTC + COMP | S1–S7 (stress) | 112 | 0 | 0 | 0 | 0 / 0 | 0 / 0 |
| ETH + cbBTC + COMP | âncora de Julho (meses voláteis) | 336 | 0 | 0 | 0 | 4 / 8 | 0 / 0 |
| ETH + cbBTC + COMP | Jul–Out 2026 | 1 680 | 0 | 0 | 0 | 0 / 0 | 0 / 0 |
| ETH + cbBTC + COMP | amostra de 5 anos | 18 888 | 0 | 0 | 0 | 53 / 85 | 0 / 0 |
| ETH + cbBTC + COMP | episódios horários | 1 924 | 0 | 0 | 0 | 9 / 28 | 0 / 0 |
| ETH + cbBTC + AERO | S1–S7 (stress) | 48 | 0 | 0 | 0 | 0 / 0 | 0 / 0 |
| ETH + cbBTC + AERO | âncora de Julho (meses voláteis) | 168 | 0 | 0 | 0 | 0 / 0 | 0 / 0 |
| ETH + cbBTC + AERO | Jul–Out 2026 | 1 680 | 0 | 0 | 0 | 0 / 0 | 0 / 0 |
| ETH + cbBTC + AERO | amostra de 5 anos | 10 480 | 0 | 0 | 0 | 0 / 0 | 0 / 0 |
| ETH + cbBTC + AERO | episódios horários | 888 | 0 | 0 | 0 | 0 / 0 | 0 / 0 |
| ETH + cbBTC + USDC (com stable) | S1–S7 (stress) | 112 | 0 | 0 | 0 | 0 / 0 | 0 / 0 |
| ETH + cbBTC + USDC (com stable) | âncora de Julho (meses voláteis) | 336 | 0 | 0 | 0 | 0 / 0 | 0 / 0 |
| ETH + cbBTC + USDC (com stable) | Jul–Out 2026 | 1 680 | 0 | 0 | 0 | 0 / 0 | 0 / 0 |
| ETH + cbBTC + USDC (com stable) | amostra de 5 anos | 18 888 | 5,00 | 4,26 | 9 (9 pela banda, 0 por falta de preço) | 23 / 40 | 0 / 0 |
| ETH + cbBTC + USDC (com stable) | episódios horários | 2 072 | 50,00 | 50,00 | 401 (401 pela banda, 0 por falta de preço) | 8 / 15 | 0 / 0 |


### A+ contra B+ e contra o DCA só em ETH, por regime (histórico)

*Amostra de 5 anos (início diário desde 31 Mar 2022, ou desde que X tem feed) · «alta volatilidade» = 25% das janelas com o ETH mais volátil, em cada cesto e duração · empate (< 0,01%) não conta como vitória*

| Posições | Regime | n (3 voláteis) | A+ > B+ | A+ > só ETH | A+ > ambos | A+ − B+ mediana (P5 / P95) | Com stable: A+ > B+ | Com stable: mediana |
|---|---|---|---|---|---|---|---|---|
| 30 dias · diária | alta volatilidade | 3 196 | 46,6% | 54,8% | 23,1% | −0,10% (−2,4 / 2,6) | 41,9% | −0,17% |
| 30 dias · diária | normal | 9 572 | 51,4% | 45,1% | 24,0% | 0,04% (−2,1 / 1,8) | 57,5% | 0,11% |
| 90 dias · diária | alta volatilidade | 2 968 | 39,3% | 51,3% | 16,8% | −0,68% (−5,7 / 7,0) | 57,5% | 0,39% |
| 90 dias · diária | normal | 8 888 | 48,4% | 45,5% | 28,2% | −0,07% (−4,3 / 4,7) | 47,3% | −0,08% |
| 90 dias · semanal | alta volatilidade | 2 948 | 37,8% | 54,4% | 16,8% | −0,64% (−5,8 / 4,0) | 44,1% | −0,20% |
| 90 dias · semanal | normal | 8 832 | 54,8% | 47,5% | 29,8% | 0,22% (−4,0 / 4,1) | 54,9% | 0,19% |

*As outras janelas, por X*

| Cesto | Janelas | Posições | A+ > B+ | A+ > só ETH | A+ − B+ mediana (mín. / máx.) |
|---|---|---|---|---|---|
| 3 voláteis (os três X juntos) | S1–S7 (stress) | 192 | 39% | 61% | −0,41% (−6,1 / 5,6) |
| 3 voláteis (os três X juntos) | âncora de Julho (meses voláteis) | 588 | 46% | 40% | −0,06% (−8,3 / 9,4) |
| 3 voláteis (os três X juntos) | Jul–Out 2026 | 5 040 | 63% | 54% | 0,40% (−10,9 / 11,5) |
| 3 voláteis (os três X juntos) | episódios horários | 3 376 | 39% | 47% | −0,20% (−5,6 / 5,3) |
| ETH + cbBTC + VIRTUAL | S1–S7 (stress) | 32 | 28% | 81% | −1,73% (−5,8 / 3,2) |
| ETH + cbBTC + VIRTUAL | âncora de Julho (meses voláteis) | 84 | 43% | 43% | −0,15% (−8,3 / 9,4) |
| ETH + cbBTC + VIRTUAL | Jul–Out 2026 | 1 680 | 68% | 41% | 0,46% (−3,2 / 3,6) |
| ETH + cbBTC + VIRTUAL | episódios horários | 564 | 32% | 28% | −0,56% (−5,6 / 5,3) |
| ETH + cbBTC + COMP | S1–S7 (stress) | 112 | 38% | 59% | −0,32% (−6,1 / 5,6) |
| ETH + cbBTC + COMP | âncora de Julho (meses voláteis) | 336 | 45% | 39% | −0,06% (−3,5 / 4,0) |
| ETH + cbBTC + COMP | Jul–Out 2026 | 1 680 | 66% | 57% | 0,44% (−3,9 / 3,6) |
| ETH + cbBTC + COMP | episódios horários | 1 924 | 40% | 47% | −0,16% (−5,5 / 3,5) |
| ETH + cbBTC + AERO | S1–S7 (stress) | 48 | 46% | 54% | −0,10% (−4,5 / 2,1) |
| ETH + cbBTC + AERO | âncora de Julho (meses voláteis) | 168 | 48% | 40% | −0,03% (−3,2 / 4,1) |
| ETH + cbBTC + AERO | Jul–Out 2026 | 1 680 | 55% | 65% | 0,24% (−10,9 / 11,5) |
| ETH + cbBTC + AERO | episódios horários | 888 | 42% | 57% | −0,14% (−4,4 / 2,0) |
| ETH + cbBTC + USDC (com stable) | S1–S7 (stress) | 112 | 60% | 69% | 0,29% (−4,9 / 3,3) |
| ETH + cbBTC + USDC (com stable) | âncora de Julho (meses voláteis) | 336 | 52% | 42% | 0,04% (−4,4 / 3,6) |
| ETH + cbBTC + USDC (com stable) | Jul–Out 2026 | 1 680 | 53% | 34% | 0,07% (−4,6 / 5,1) |
| ETH + cbBTC + USDC (com stable) | episódios horários | 2 072 | 43% | 66% | −0,13% (−7,7 / 11,4) |

**Leitura.** Com três voláteis o A+ e o B+ continuam empatados no agregado (49% contra 50% na amostra de 5 anos; com stable 52% contra 47%), com mais dispersão (P5/P95 de −4,1% / 3,7%, contra −2,9% / 2,5% com stable). Em alta volatilidade e 90 dias o A+ ficou atrás mais vezes (39% diária, 38% semanal): é o regime em que a regra 9 protege as três pernas e empurra compras para o fim. Em Jul–Out 2026 o A+ ficou à frente em 63%: um período, não uma tendência.


### A «rotação de volatilidade», medida

*Todas as posições (2.1, 2.2, 2.3, 2.11, §2.10) · «unidades a mais» = Σ peso × (preço médio B+ ÷ preço médio A+ − 1): com a divisão cumprida, é exactamente quanto mais barato o A+ comprou · rotação cega = o sinal «rotação» da §2.12 (perna da vez, sem olhar ao preço)*

| Cesto | Ciclos com 2 a subir e 1 a descer | A+ comprou a que desceu (% desses ciclos) | … dos ciclos em que comprou | Rotação cega comprou a que desceu | A+: unidades a mais face a B+, mediana (P5 / P95) | Rotação cega: o mesmo |
|---|---|---|---|---|---|---|
| 3 voláteis (os três X juntos) | 312 568 | 45% | 68% | 21% | 0,01% (−3,9 / 3,0) | 0,10% (−3,1 / 2,8) |
| ETH + cbBTC + VIRTUAL | 58 952 | 46% | 70% | 22% | 0,13% (−4,5 / 3,3) | 0,14% (−3,3 / 3,6) |
| ETH + cbBTC + COMP | 161 640 | 46% | 70% | 22% | −0,01% (−3,3 / 2,4) | 0,12% (−2,5 / 2,4) |
| ETH + cbBTC + AERO | 91 976 | 42% | 64% | 21% | −0,05% (−4,4 / 3,5) | −0,02% (−3,8 / 3,1) |
| ETH + cbBTC + USDC (com stable) | 243 572 | 47% | 71% | 23% | 0,03% (−2,8 / 2,2) | 0,01% (−2,3 / 2,6) |

**Leitura.** O mecanismo faz o que diz: quando duas pernas sobem e uma desce, compra a que desceu em cerca de 68% dos ciclos em que compra (nos outros, a perna que desceu estava em cooldown, bloqueada pela regra 6 ou protegida). Mas isso não se traduz em comprar mais barato do que o B+: a mediana é 0,01%, e a rotação cega, que não olha para o preço, dá 0,10%. Com três voláteis, «a perna que desceu neste ciclo» não é «a perna que está barata para o resto da posição»: a variação de um ciclo não prevê a seguinte. É ruído, como na §2.12.


### Drawdown máximo da posição, contra o cesto com stable (histórico)

*A+ nos dois cestos, mesma janela, divisão e cadência · drawdown = maior queda do valor da posição (comprado + por investir) face ao máximo anterior*

| Cesto | Janelas | Pares | Drawdown 3 voláteis (mediana / máx.) | Drawdown com stable (mediana / máx.) | Mais fundo com 3 voláteis | Diferença mediana |
|---|---|---|---|---|---|---|
| ETH + cbBTC + VIRTUAL | S1–S7 (stress) | 32 | 14,4% / 23,1% | 7,7% / 15,7% | 88% | 5,6 pp (P95 10,6) |
| ETH + cbBTC + VIRTUAL | âncora de Julho (meses voláteis) | 84 | 3,1% / 12,3% | 1,7% / 6,8% | 86% | 1,8 pp (P95 6,5) |
| ETH + cbBTC + VIRTUAL | Jul–Out 2026 | 1 680 | 6,8% / 20,7% | 2,4% / 9,8% | 99% | 4,2 pp (P95 8,9) |
| ETH + cbBTC + VIRTUAL | amostra de 5 anos | 7 036 | 12,2% / 37,7% | 5,8% / 30,4% | 100% | 5,9 pp (P95 14,4) |
| ETH + cbBTC + VIRTUAL | episódios horários | 564 | 12,5% / 27,8% | 5,4% / 13,5% | 100% | 6,7 pp (P95 13,7) |
| ETH + cbBTC + COMP | S1–S7 (stress) | 112 | 8,9% / 28,3% | 5,3% / 20,6% | 87% | 2,5 pp (P95 11,4) |
| ETH + cbBTC + COMP | âncora de Julho (meses voláteis) | 336 | 1,9% / 20,6% | 1,1% / 20,2% | 80% | 0,8 pp (P95 4,3) |
| ETH + cbBTC + COMP | Jul–Out 2026 | 1 680 | 4,5% / 15,4% | 2,4% / 9,8% | 96% | 2,0 pp (P95 5,8) |
| ETH + cbBTC + COMP | amostra de 5 anos | 18 888 | 10,7% / 38,3% | 5,7% / 30,4% | 99% | 4,5 pp (P95 12,3) |
| ETH + cbBTC + COMP | episódios horários | 1 924 | 9,7% / 37,2% | 6,0% / 44,9% | 92% | 3,2 pp (P95 9,7) |
| ETH + cbBTC + AERO | S1–S7 (stress) | 48 | 10,6% / 23,6% | 6,2% / 15,7% | 92% | 3,6 pp (P95 10,6) |
| ETH + cbBTC + AERO | âncora de Julho (meses voláteis) | 168 | 2,2% / 14,1% | 1,1% / 8,0% | 85% | 1,2 pp (P95 6,0) |
| ETH + cbBTC + AERO | Jul–Out 2026 | 1 680 | 5,3% / 23,3% | 2,4% / 9,8% | 90% | 2,7 pp (P95 9,0) |
| ETH + cbBTC + AERO | amostra de 5 anos | 10 480 | 12,3% / 37,4% | 6,1% / 30,4% | 98% | 5,9 pp (P95 13,9) |
| ETH + cbBTC + AERO | episódios horários | 888 | 11,5% / 28,6% | 6,1% / 19,1% | 100% | 5,2 pp (P95 10,8) |

Sem surpresa: trocar a perna stable por um volátil aprofunda o drawdown em quase todas as posições (mediana de 11–12% contra 6% na amostra de 5 anos). É o custo de ter três voláteis, não um defeito do mecanismo; convém dizê-lo no produto.


### O X sem feed (fase 2): quórum contra referência

*AERO como a keeper o leria na fase 2 (sem perna Chainlink): quórum aproximado pelo DefiLlama · referência = Coinbase AERO-USD, abertura da hora*

| Leitura | Desde | Leituras | Sem quórum (sem ponto DefiLlama a ≤ 1 h) | Diferença absoluta quórum–Coinbase, mediana / P95 / máx. (bps) | > 300 bps (falharia a tolerância do ADR-024) |
|---|---|---|---|---|---|
| diário 00:00 | 2024-04-01 | 950 | 0 (0,00%) | 18 / 85 / 252 | 0 (0,00%) |
| horário | 2024-04-01 | 22 777 | 5 (0,02%) | 19 / 82 / 940 | 10 (0,04%) |

*Cesto ETH + cbBTC + AERO · comparar com a v2 (§2.7, cesto com stable): AERO pelo feed Chainlink 12,4%, pelo DefiLlama 0,04%*

| Posições | n | Decisões da regra 4 que mudam face à referência, % (mediana / total / máx.) | Ciclos em que AERO saltou por falta de quórum | Desvio máx. (pp) |
|---|---|---|---|---|
| S1–S7 (diária/semanal) | 48 | 0,0 / 2,2 / 28 | 0 | 0,00 |
| Jul–Out 2026 (diária/semanal) | 1 680 | 0,0 / 2,0 / 34 | 0 | 0,00 |
| amostra desde Abr 2024 (diária/semanal) | 10 480 | 0,0 / 8,0 / 76 | 0 | 0,00 |
| horário, 72 ciclos · só AERO pelo quórum | 1 000 | 18,3 / 20,6 / 70 | 0 | 0,00 |
| horário, 72 ciclos · como a keeper (feeds Base + quórum AERO) | 1 000 | 29,6 / 31,1 / 73 | 0 | 0,00 |

**Leitura.** O quórum para AERO está quase sempre disponível (5 horas sem ponto em 22 777) e concorda com a bolsa (mediana 19 bps). Em cadência diária muda poucas decisões; com três voláteis muda mais do que com stable (8,0% contra 0,04% na v2), porque as três pernas variam por quantidades parecidas e um desvio de 20 bps chega para trocar a ordem. Em cadência horária muda 21% das decisões: o mesmo problema dos feeds da Base em T4. Mais um argumento para a cadência mínima diária.


### As regras, uma a uma: três voláteis contra o cesto com stable

*A+ completo (P + M + E k = 10 + regra 9 a 25%, suave) em todas as janelas*

| Cesto | Posições (≥ 6 ciclos) | Regra 5: ciclos com cooldown activo | Regra 6: pernas fechadas antes do fim (média) | Regra 9: posições com protecção | Regra 9: as três protegidas | Regra 9: ciclos seguidos sem perna elegível (máx.) | Último ciclo, % do capital (mediana / P95 / máx.) | Maior compra única |
|---|---|---|---|---|---|---|---|---|
| 3 voláteis (os três X juntos) | 43 816 | 52% | 1,50 | 47% | 9,6% | 48 | 4,4 / 14,6 / 28,1 | 22,5% |
| ETH + cbBTC + VIRTUAL | 8 912 | 52% | 1,52 | 54% | 10,9% | 39 | 4,8 / 14,2 / 24,1 | 19,5% |
| ETH + cbBTC + COMP | 22 204 | 52% | 1,48 | 42% | 10,0% | 40 | 4,2 / 13,5 / 28,1 | 22,5% |
| ETH + cbBTC + AERO | 12 700 | 51% | 1,51 | 50% | 7,9% | 48 | 4,8 / 15,9 / 24,3 | 19,6% |
| ETH + cbBTC + USDC (com stable) | 22 352 | 54% | 1,55 | 26% | 0,4% | 9 | 3,3 / 11,1 / 26,7 | 26,7% |

**O que muda.** As regras 5 e 6 comportam-se igual nos dois cestos. **A regra 9 é a que piora**: com uma stable, a perna stable nunca é protegida e o ciclo tem sempre onde comprar; com três voláteis, uma queda geral protege tudo e o dinheiro acumula (9,6% das posições, até 48 ciclos seguidos). O E absorve a maior parte do efeito — a maior compra única ficou em 22,5% no pior caso (uma posição COMP semanal de 13 ciclos, Abr–Jul 2022) e o último ciclo no P95 em 14,6% do capital. **Recomendação:** manter a regra 9 a 25% com E k = 10 no cesto de três voláteis. Se o dono quiser menos concentração, o parâmetro que mexe é o limiar: a 30% as posições com as três protegidas caem de 300 para 180 (em 3 568).


## T1 — Preço único (interruptor P)

**Como foi medido.** Por perna e por tick: Chainlink se a ronda lida tiver ≤ 600 s; senão o ponto DefiLlama mais próximo do tick (até 1 hora) — aproximação declarada do quórum, porque a CoinGecko não tem histórico sem chave; senão a perna fica fora do ciclo. Execução e valor continuam ao preço do feed, como na v2: P só muda decisões. As tabelas de T1 são do cesto com stable (o pedido); a linha do cesto de três voláteis está no fim.

*Cesto com stable · A+P contra o A da v2 (feed lido sem limite de idade), mesmas posições*

| Conjunto | Posições | Decisões que mudam, % dos ciclos (mediana / média / máx.) | Máx. por posição | Ciclos saltados (nenhuma perna com preço) | Posições com desvio (sem nenhuma espera no último ciclo) | Desvio máx. (pp) |
|---|---|---|---|---|---|---|
| 2.1 | 112 | 0,0 / 5,5 / 72,7 | 15 | 0 | 0 | 0,00 |
| 2.3 | 1680 | 0,0 / 2,4 / 46,1 | 41 | 0 | 0 | 0,00 |
| 2.11 | 18888 | 0,0 / 5,7 / 91,7 | 59 | 512 | 20 | 13,85 |

*De onde veio o preço de decisão, em todos os ticks de T1*

| Perna | Leituras | Chainlink fresco (≤ 600 s) | DefiLlama | Sem preço |
|---|---|---|---|---|
| ETH (Chainlink · Arbitrum) | 883 720 | 92,5% | 7,4% | 0,06% |
| BTC (cbBTC · Base / WBTC · Arbitrum / WBTC·BTC × BTC · Ethereum) | 883 720 | 56,8% | 43,0% | 0,22% |
| USDC (Chainlink · Arbitrum) | 883 720 | 15,2% | 84,7% | 0,10% |

*§2.11 refeita com o preço único · B = DCA fixo, mesma divisão*

| Posições | Regime | n | A > B (v2) | A+P > B | Mediana A − B (v2) | Mediana A+P − B |
|---|---|---|---|---|---|---|
| 30 dias · diária | alta volatilidade | 1652 | 47,5% | 45,8% | −0,040% | −0,067% |
| 30 dias · diária | normal | 4952 | 59,2% | 57,3% | 0,117% | 0,094% |
| 90 dias · diária | alta volatilidade | 1540 | 51,0% | 51,0% | 0,048% | 0,037% |
| 90 dias · diária | normal | 4616 | 55,2% | 53,4% | 0,138% | 0,089% |
| 90 dias · semanal | alta volatilidade | 1532 | 50,5% | 47,7% | 0,051% | −0,138% |
| 90 dias · semanal | normal | 4596 | 55,1% | 54,9% | 0,202% | 0,196% |

*O mesmo efeito com todos os interruptores ligados, nos dois cestos (A+ contra A+ sem P)*

| Cesto | Janelas | Posições | Decisões que mudam com P, % (mediana / média / máx.) | Perna 3: Chainlink / DefiLlama / sem preço | Ciclos saltados |
|---|---|---|---|---|---|
| ETH + cbBTC + VIRTUAL | S1–S7 (stress) | 32 | 0,0 / 1,2 / 17 | 39% / 61% / 0,00% | 0 |
| ETH + cbBTC + VIRTUAL | Jul–Out 2026 | 1 680 | 0,0 / 5,0 / 100 | 17% / 83% / 0,00% | 0 |
| ETH + cbBTC + VIRTUAL | amostra de 5 anos | 7 036 | 0,0 / 3,9 / 97 | 29% / 71% / 0,00% | 0 |
| ETH + cbBTC + VIRTUAL | episódios horários | 564 | 0,0 / 6,8 / 76 | 65% / 35% / 0,00% | 0 |
| ETH + cbBTC + COMP | S1–S7 (stress) | 112 | 0,0 / 6,9 / 59 | 25% / 74% / 0,76% | 0 |
| ETH + cbBTC + COMP | Jul–Out 2026 | 1 680 | 0,0 / 6,5 / 100 | 19% / 81% / 0,00% | 0 |
| ETH + cbBTC + COMP | amostra de 5 anos | 18 888 | 2,2 / 6,8 / 92 | 19% / 80% / 0,36% | 512 |
| ETH + cbBTC + COMP | episódios horários | 1 924 | 13,8 / 17,7 / 100 | 36% / 63% / 0,65% | 0 |
| ETH + cbBTC + AERO | S1–S7 (stress) | 48 | 0,0 / 2,3 / 35 | 0% / 100% / 0,00% | 0 |
| ETH + cbBTC + AERO | Jul–Out 2026 | 1 680 | 0,0 / 6,0 / 75 | 0% / 100% / 0,00% | 0 |
| ETH + cbBTC + AERO | amostra de 5 anos | 10 480 | 0,0 / 4,0 / 86 | 0% / 100% / 0,00% | 0 |
| ETH + cbBTC + AERO | episódios horários | 888 | 8,5 / 10,4 / 70 | 0% / 100% / 0,00% | 0 |
| ETH + cbBTC + USDC (com stable) | S1–S7 (stress) | 112 | 0,0 / 3,4 / 45 | 3% / 97% / 0,19% | 0 |
| ETH + cbBTC + USDC (com stable) | Jul–Out 2026 | 1 680 | 0,0 / 2,3 / 41 | 100% / 0% / 0,00% | 0 |
| ETH + cbBTC + USDC (com stable) | amostra de 5 anos | 18 888 | 0,0 / 4,4 / 92 | 10% / 90% / 0,10% | 512 |
| ETH + cbBTC + USDC (com stable) | episódios horários | 2 072 | 4,2 / 10,0 / 87 | 13% / 86% / 0,16% | 0 |

**Leitura.** O preço único não muda o sentido da (viii): o Basket continua sem vantagem sistemática sobre o DCA fixo. Sem espera, um último ciclo sem preço parte a garantia (20 posições em 20 680 no cesto com stable). Com a regra do dono (até 3 ciclos, já simulada em T6–T8) fica resolvido, ou fica a perna por comprar e explicada — ver «Decisões do dono». As lacunas vêm do histórico do DefiLlama; ao vivo podem não existir.


## T2 — Mínimo por compra (interruptor M)

*Janelas 2.1 e 2.3, cesto com stable · mínimo = 3 USD (canónica) ou 16 USD (agregador) · o último ciclo compra tudo o que for ≥ 0,01 USD*

| Capital | Rota (mínimo) | Cadência | Posições | Compras (mediana) sem → com M | Poupadas (mediana / máx.) | Menor compra fora do último ciclo | Menor compra no último ciclo (isento) | Desvio máx. por perna |
|---|---|---|---|---|---|---|---|---|
| 100 USD | agregador | diária | 896 | 40 → 7 | 32 / 85 | 16,09 USD | 0,90 USD | 0,0000 USD |
| 100 USD | agregador | semanal | 896 | 8 → 6 | 2 / 10 | 16,67 USD | 1,43 USD | 0,0000 USD |
| 100 USD | canónica | diária | 896 | 40 → 30 | 12 / 61 | 3,23 USD | 0,21 USD | 0,0000 USD |
| 100 USD | canónica | semanal | 896 | 8 → 8 | 0 / 1 | 3,03 USD | 0,77 USD | 0,0000 USD |
| 250 USD | agregador | diária | 896 | 40 → 15 | 26 / 76 | 16,13 USD | 1,61 USD | 0,0000 USD |
| 250 USD | agregador | semanal | 896 | 8 → 8 | 0 / 2 | 16,67 USD | 1,92 USD | 0,0000 USD |
| 250 USD | canónica | diária | 896 | 40 → 39 | 0 / 45 | 3,23 USD | 0,53 USD | 0,0000 USD |
| 250 USD | canónica | semanal | 896 | 8 → 8 | 0 / 1 | 3,85 USD | 1,92 USD | 0,0000 USD |
| 1000 USD | agregador | diária | 896 | 40 → 36 | 0 / 45 | 16,67 USD | 2,13 USD | 0,0000 USD |
| 1000 USD | agregador | semanal | 896 | 8 → 8 | 0 / 1 | 19,23 USD | 7,69 USD | 0,0000 USD |
| 1000 USD | canónica | diária | 896 | 40 → 40 | 0 / 1 | 4,50 USD | 2,13 USD | 0,0000 USD |
| 1000 USD | canónica | semanal | 896 | 8 → 8 | 0 / 0 | 7,69 USD | 7,69 USD | 0,0000 USD |

**Leitura.** O M elimina as compras que não pagam o próprio gas e não toca na garantia. O efeito concentra-se nas posições pequenas com muitos ciclos; numa posição de 1 000 USD quase nunca actua. O teste do motor confirma o limite de 0,01 USD por perna nos dois cestos.


## T3 — Liquidação escalonada (interruptor E)

**Como foi medido.** Modo suave, só E ligado (P, M e B desligados, para isolar o efeito). Nos últimos k ciclos, o capital adiado pela regra 9 é comprado em parcelas iguais do que falta (repartidas pelo que falta a cada perna), em vez de todo no último ciclo; o ciclo normal continua. k = 1 é exactamente a v2. O tecto limita cada compra a uma % do capital; o que o tecto impedir no último ciclo fica por investir e é contado. Janelas: S1–S7 (4 repartições × diária/semanal × 2 durações) e os 7 episódios horários, **primeiro no cesto de três voláteis** (os três X juntos, 3 568 posições), depois no cesto com stable (2 184).

![Gráfico G1 · Maior compra única por k × tecto, regra 9 a 25%, posições com 6 ou mais ciclos — três voláteis em cima, com stable em baixo](charts/G1-maior-compra-k-tecto.svg)

*Gráfico G1 · Maior compra única por k × tecto, regra 9 a 25%, posições com 6 ou mais ciclos — três voláteis em cima, com stable em baixo* — dados: [`charts/G1-maior-compra-k-tecto.csv`](charts/G1-maior-compra-k-tecto.csv)

*3 voláteis (os três X juntos)*

| Limiar | k | Tecto | Maior compra (≥ 6 ciclos) | Maior compra (≥ 8 ciclos) | Desvio máx. (pp) | Por investir máx. (%) |
|---|---|---|---|---|---|---|
| 20% | 1 | sem | 50,0% | 50,0% | 0,0 | 0,0 |
| 20% | 1 | 10% | 10,0% | 10,0% | 40,0 | 57,2 |
| 20% | 1 | 20% | 20,0% | 20,0% | 30,0 | 40,0 |
| 20% | 1 | 33% | 33,0% | 33,0% | 17,0 | 17,0 |
| 20% | 3 | sem | 22,4% | 22,4% | 0,0 | 0,0 |
| 20% | 3 | 10% | 10,0% | 10,0% | 20,0 | 20,0 |
| 20% | 3 | 20% | 20,0% | 20,0% | 2,4 | 2,4 |
| 20% | 3 | 33% | 22,4% | 22,4% | 0,0 | 0,0 |
| 20% | 5 | sem | 18,9% | 18,9% | 0,0 | 0,0 |
| 20% | 5 | 10% | 10,0% | 10,0% | 10,8 | 11,3 |
| 20% | 5 | 20% | 18,9% | 18,9% | 0,0 | 0,0 |
| 20% | 5 | 33% | 18,9% | 18,9% | 0,0 | 0,0 |
| 20% | 10 | sem | 18,1% | 18,1% | 0,0 | 0,0 |
| 20% | 10 | 10% | 10,0% | 10,0% | 9,3 | 10,9 |
| 20% | 10 | 20% | 18,1% | 18,1% | 0,0 | 0,0 |
| 20% | 10 | 33% | 18,1% | 18,1% | 0,0 | 0,0 |
| 25% | 1 | sem | 50,0% | 50,0% | 0,0 | 0,0 |
| 25% | 1 | 10% | 10,0% | 10,0% | 40,0 | 50,0 |
| 25% | 1 | 20% | 20,0% | 20,0% | 30,0 | 30,0 |
| 25% | 1 | 33% | 33,0% | 33,0% | 17,0 | 17,0 |
| 25% | 3 | sem | 23,3% | 23,3% | 0,0 | 0,0 |
| 25% | 3 | 10% | 10,0% | 10,0% | 20,0 | 20,0 |
| 25% | 3 | 20% | 20,0% | 20,0% | 3,3 | 3,3 |
| 25% | 3 | 33% | 23,3% | 23,3% | 0,0 | 0,0 |
| 25% | 5 | sem | 20,3% | 20,3% | 0,0 | 0,0 |
| 25% | 5 | 10% | 10,0% | 10,0% | 12,5 | 12,5 |
| 25% | 5 | 20% | 20,0% | 20,0% | 0,3 | 0,3 |
| 25% | 5 | 33% | 20,3% | 20,3% | 0,0 | 0,0 |
| 25% | 10 | sem | 19,9% | 19,9% | 0,0 | 0,0 |
| 25% | 10 | 10% | 10,0% | 10,0% | 11,8 | 11,9 |
| 25% | 10 | 20% | 19,9% | 19,9% | 0,0 | 0,0 |
| 25% | 10 | 33% | 19,9% | 19,9% | 0,0 | 0,0 |
| 30% | 1 | sem | 46,7% | 46,7% | 0,0 | 0,0 |
| 30% | 1 | 10% | 10,0% | 10,0% | 36,7 | 43,3 |
| 30% | 1 | 20% | 20,0% | 20,0% | 26,7 | 26,7 |
| 30% | 1 | 33% | 33,0% | 33,0% | 13,7 | 13,7 |
| 30% | 3 | sem | 21,1% | 20,1% | 0,0 | 0,0 |
| 30% | 3 | 10% | 10,0% | 10,0% | 16,7 | 16,7 |
| 30% | 3 | 20% | 20,0% | 20,0% | 1,1 | 1,1 |
| 30% | 3 | 33% | 21,1% | 20,1% | 0,0 | 0,0 |
| 30% | 5 | sem | 20,8% | 18,2% | 0,0 | 0,0 |
| 30% | 5 | 10% | 10,0% | 10,0% | 12,1 | 12,1 |
| 30% | 5 | 20% | 20,0% | 18,2% | 0,8 | 0,8 |
| 30% | 5 | 33% | 20,8% | 18,2% | 0,0 | 0,0 |
| 30% | 10 | sem | 20,8% | 18,1% | 0,0 | 0,0 |
| 30% | 10 | 10% | 10,0% | 10,0% | 12,1 | 12,1 |
| 30% | 10 | 20% | 20,0% | 18,1% | 0,8 | 0,8 |
| 30% | 10 | 33% | 20,8% | 18,1% | 0,0 | 0,0 |

*ETH + cbBTC + USDC (com stable)*

| Limiar | k | Tecto | Maior compra (≥ 6 ciclos) | Maior compra (≥ 8 ciclos) | Desvio máx. (pp) | Por investir máx. (%) |
|---|---|---|---|---|---|---|
| 20% | 1 | sem | 48,3% | 48,3% | 0,0 | 0,0 |
| 20% | 1 | 10% | 10,0% | 10,0% | 38,3 | 55,7 |
| 20% | 1 | 20% | 20,0% | 20,0% | 28,3 | 40,0 |
| 20% | 1 | 33% | 33,0% | 33,0% | 15,3 | 15,3 |
| 20% | 3 | sem | 20,0% | 20,0% | 0,0 | 0,0 |
| 20% | 3 | 10% | 10,0% | 10,0% | 18,3 | 20,0 |
| 20% | 3 | 20% | 20,0% | 20,0% | 0,0 | 0,0 |
| 20% | 3 | 33% | 20,0% | 20,0% | 0,0 | 0,0 |
| 20% | 5 | sem | 17,3% | 17,3% | 0,0 | 0,0 |
| 20% | 5 | 10% | 10,0% | 10,0% | 7,8 | 13,6 |
| 20% | 5 | 20% | 17,3% | 17,3% | 0,0 | 0,0 |
| 20% | 5 | 33% | 17,3% | 17,3% | 0,0 | 0,0 |
| 20% | 10 | sem | 17,3% | 17,3% | 0,0 | 0,0 |
| 20% | 10 | 10% | 10,0% | 10,0% | 7,7 | 13,4 |
| 20% | 10 | 20% | 17,3% | 17,3% | 0,0 | 0,0 |
| 20% | 10 | 33% | 17,3% | 17,3% | 0,0 | 0,0 |
| 25% | 1 | sem | 46,7% | 46,7% | 0,0 | 0,0 |
| 25% | 1 | 10% | 10,0% | 10,0% | 36,7 | 46,7 |
| 25% | 1 | 20% | 20,0% | 20,0% | 26,7 | 26,7 |
| 25% | 1 | 33% | 33,0% | 33,0% | 13,7 | 13,7 |
| 25% | 3 | sem | 22,2% | 20,0% | 0,0 | 0,0 |
| 25% | 3 | 10% | 10,0% | 10,0% | 16,7 | 20,1 |
| 25% | 3 | 20% | 20,0% | 20,0% | 2,2 | 2,2 |
| 25% | 3 | 33% | 22,2% | 20,0% | 0,0 | 0,0 |
| 25% | 5 | sem | 20,9% | 17,2% | 0,0 | 0,0 |
| 25% | 5 | 10% | 10,0% | 10,0% | 13,3 | 13,8 |
| 25% | 5 | 20% | 20,0% | 17,2% | 0,9 | 0,9 |
| 25% | 5 | 33% | 20,9% | 17,2% | 0,0 | 0,0 |
| 25% | 10 | sem | 20,8% | 16,8% | 0,0 | 0,0 |
| 25% | 10 | 10% | 10,0% | 10,0% | 13,2 | 13,5 |
| 25% | 10 | 20% | 20,0% | 16,8% | 0,8 | 0,8 |
| 25% | 10 | 33% | 20,8% | 16,8% | 0,0 | 0,0 |
| 30% | 1 | sem | 46,7% | 46,7% | 0,0 | 0,0 |
| 30% | 1 | 10% | 10,0% | 10,0% | 36,7 | 36,7 |
| 30% | 1 | 20% | 20,0% | 20,0% | 26,7 | 26,7 |
| 30% | 1 | 33% | 33,0% | 33,0% | 13,7 | 13,7 |
| 30% | 3 | sem | 20,0% | 20,0% | 0,0 | 0,0 |
| 30% | 3 | 10% | 10,0% | 10,0% | 16,7 | 16,7 |
| 30% | 3 | 20% | 20,0% | 20,0% | 0,0 | 0,0 |
| 30% | 3 | 33% | 20,0% | 20,0% | 0,0 | 0,0 |
| 30% | 5 | sem | 18,7% | 17,2% | 0,0 | 0,0 |
| 30% | 5 | 10% | 10,0% | 10,0% | 14,8 | 14,8 |
| 30% | 5 | 20% | 18,7% | 17,2% | 0,0 | 0,0 |
| 30% | 5 | 33% | 18,7% | 17,2% | 0,0 | 0,0 |
| 30% | 10 | sem | 18,7% | 16,8% | 0,0 | 0,0 |
| 30% | 10 | 10% | 10,0% | 10,0% | 14,8 | 14,8 |
| 30% | 10 | 20% | 18,7% | 16,8% | 0,0 | 0,0 |
| 30% | 10 | 33% | 18,7% | 16,8% | 0,0 | 0,0 |

*Quantas vezes a regra 9 protege as três pernas ao mesmo tempo, e por quanto tempo (k = 1, sem tecto: a protecção não depende de k)*

| Cesto | Limiar | Posições | Com alguma perna protegida | Com as três protegidas ao mesmo tempo | Ciclos com as três protegidas (máx.) | Seguidos (máx.) | Último ciclo com k = 1, % do capital (mediana / máx.) |
|---|---|---|---|---|---|---|---|
| ETH + cbBTC + VIRTUAL | 20% | 596 | 93% | 16 (2,7%) | 12 | 11 | 13,1 / 60,1 |
| ETH + cbBTC + VIRTUAL | 25% | 596 | 90% | 12 (2,0%) | 9 | 9 | 7,8 / 56,1 |
| ETH + cbBTC + VIRTUAL | 30% | 596 | 83% | 8 (1,3%) | 3 | 2 | 6,7 / 54,7 |
| ETH + cbBTC + COMP | 20% | 2 036 | 76% | 372 (18,3%) | 45 | 44 | 6,7 / 87,2 |
| ETH + cbBTC + COMP | 25% | 2 036 | 61% | 272 (13,4%) | 34 | 33 | 4,2 / 70,0 |
| ETH + cbBTC + COMP | 30% | 2 036 | 41% | 164 (8,1%) | 20 | 15 | 4,2 / 63,3 |
| ETH + cbBTC + AERO | 20% | 936 | 91% | 60 (6,4%) | 12 | 11 | 6,7 / 65,9 |
| ETH + cbBTC + AERO | 25% | 936 | 69% | 16 (1,7%) | 9 | 9 | 4,2 / 56,8 |
| ETH + cbBTC + AERO | 30% | 936 | 38% | 8 (0,9%) | 3 | 2 | 3,3 / 56,8 |
| ETH + cbBTC + USDC (com stable) | 20% | 2 184 | 51% | 128 (5,9%) | 25 | 23 | 4,2 / 80,0 |
| ETH + cbBTC + USDC (com stable) | 25% | 2 184 | 34% | 92 (4,2%) | 14 | 14 | 4,2 / 66,7 |
| ETH + cbBTC + USDC (com stable) | 30% | 2 184 | 25% | 20 (0,9%) | 1 | 1 | 3,3 / 56,7 |

**Recomendação: k = 10, sem tecto.** É a combinação mais simples (um parâmetro) que mantém a maior compra ≤ 20% com desvio 0 em todas as janelas do cesto de três voláteis com 6 ou mais ciclos, aos três limiares. Abaixo de 6 ciclos o limite é impossível por construção (um ciclo normal já é C/N). No cesto com stable, k = 10 cumpre a partir de 8 ciclos; com 6–7 ciclos o melhor medido é 20,8% (USDC · S1 janela semanal · 7 ciclos · 40-40-20). Se a spec exigir ≤ 20% também aí, a forma limpa é um mínimo de 8 ciclos quando a regra 9 está activa — não um tecto. O custo de k = 10: nos últimos 10 ciclos a protecção da regra 9 deixa de travar a compra adiada. **Histórico (b):** repartir a compra adiada mudou o preço médio das pernas adiadas face a k = 1 em mediana 0,00% (de −5,5% a 16,0%): o objectivo do E é limitar o tamanho da compra, não o preço.

![Gráfico G2 · S1, três voláteis, modo suave a 25%: com k = 1 a maior compra é 29,1% do capital; com k = 10, 5,0% — mesma divisão final](charts/G2-liquidacao-k1-vs-kN-S1.svg)

*Gráfico G2 · S1, três voláteis, modo suave a 25%: com k = 1 a maior compra é 29,1% do capital; com k = 10, 5,0% — mesma divisão final* — dados: [`charts/G2-liquidacao-k1-vs-kN-S1.csv`](charts/G2-liquidacao-k1-vs-kN-S1.csv)


## T4 — Feeds da Base

*OrderExecutorV3 da Base `0x686b4f812291F4De238E59ED00BA6dD6129e60a0` (de docs/DEPLOYMENTS.md; 18 247 bytes de código; domainSeparator() e ORDER_TYPEHASH() respondem) · tokenUsdFeeds lido a 7 Nov 2026*

| Token | Endereço (catálogo) | Feed no executor | Registado on-chain | Igual ao repo | enabled no repo | maxStaleness (s) |
|---|---|---|---|---|---|---|
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | `0x7e860098f58bbfc8648a4311b374b1d669a2bc6b` | sim | sim | sim | 90 000 |
| WETH | `0x4200000000000000000000000000000000000006` | `0x71041dddad3595f9ced3dccfbe3d1f4b0a16bb70` | sim | sim | sim | 3 600 |
| cbBTC | `0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf` | `0x07da0e54543a844a80abe69c8a12f22b3aa59f9d` | sim | sim | sim | 4 800 |

**Sobre «commit actual»**: a cópia local do repo foi actualizada pela última vez a 11 Out (origin/main 50c142d) e não tenho acesso ao GitHub a partir daqui. Confirmei no sítio que manda: o registo on-chain do próprio executor da Base. Os três feeds estão registados e são os mesmos do repo (igualdade calculada) e do directório da Chainlink; os três confirmaram description() e decimals().

*Parâmetros. O ETH/USD canónico da Base já não aparece no directório: o limiar vem do menor passo medido em rondas consecutivas*

| Feed | Limiar de desvio (directório) | Heartbeat (s) | Intervalo mediano entre rondas (s) | Rondas por heartbeat | Menor passo medido entre rondas (P5) |
|---|---|---|---|---|---|
| ETH/USD · Base | — | 1 200 | 360 | 21% | 0,15% |
| cbBTC/USD · Base | 0,30% | 1 200 | 1 230 | 79% | 0,30% |
| USDC/USD · Base | 0,30% | 86 400 | 86 418 | 97% | 0,00% |

*Frescura do USDC/USD da Base no momento do tick (todas as rondas desde Ago 2023)*

| Feed | Leitura | Desde | Leituras | Idade mediana | P90 | Máx. | > 600 s |
|---|---|---|---|---|---|---|---|
| USDC/USD · Base | diário 00:00 | 2023-08-04 | 1 192 | 10,2 h | 15,9 h | 22,0 h | 100,0% |
| USDC/USD · Base | horário | 2023-08-04 | 28 585 | 12,0 h | 21,6 h | 24,0 h | 99,3% |

*Calibração da banda com o USDC/USD da Base, Ago 2023 – Nov 2026*

| Leitura | Leituras | Banda | Fora da banda | Preço mínimo lido |
|---|---|---|---|---|
| diário 00:00 | 1 192 | 0,5% | 0 | 0,99936 |
| diário 00:00 | 1 192 | 1,0% | 0 | 0,99936 |
| diário 00:00 | 1 192 | 2,0% | 0 | 0,99936 |
| horário | 28 585 | 0,5% | 0 | 0,99936 |
| horário | 28 585 | 1,0% | 0 | 0,99936 |
| horário | 28 585 | 2,0% | 0 | 0,99936 |

*Feed da Base vs bolsa, hora a hora, Jul–Nov 2026 · referências: Coinbase ETH-USD, Coinbase BTC-USD (para o cbBTC), Bitstamp USDC/USD*

| Perna | Horas | Diferença absoluta feed–bolsa, mediana (bps) | P95 | Máx. | Horas em que o feed não mudou |
|---|---|---|---|---|---|
| ETH | 3 096 | 4,35 | 13,44 | 59,8 | 0% |
| cbBTC | 3 096 | 4,92 | 21,14 | 58,6 | 0% |
| USDC | 3 120 | 0,37 | 1,31 | 6,4 | 95% |

*Posições a começar em cada dia de 1 Jul a 15 Out 2026 (30/60/90 d) e, na cadência horária, a cada 12 h até 3 Nov · comparar com 12% do feed AERO na v2*

| Cadência | O que vem do feed (o resto da bolsa) | Posições | Decisões da regra 4 que mudam face à bolsa, % (mediana / média / máx.) | Desvio máx. (pp) |
|---|---|---|---|---|
| diário 00:00 | só ETH do feed | 828 | 4,5 / 4,7 / 55,2 | 0,00 |
| diário 00:00 | só cbBTC do feed | 828 | 2,2 / 3,7 / 51,7 | 0,00 |
| diário 00:00 | só USDC do feed | 828 | 0,0 / 0,0 / 0,0 | 0,00 |
| diário 00:00 | as três do feed | 828 | 0,0 / 2,7 / 48,3 | 0,00 |
| semanal 00:00 | só ETH do feed | 756 | 0,0 / 1,5 / 75,0 | 0,00 |
| semanal 00:00 | só cbBTC do feed | 756 | 0,0 / 0,0 / 0,0 | 0,00 |
| semanal 00:00 | só USDC do feed | 756 | 0,0 / 0,0 / 0,0 | 0,00 |
| semanal 00:00 | as três do feed | 756 | 0,0 / 1,5 / 75,0 | 0,00 |
| horário (72 ciclos) | só ETH do feed | 1000 | 22,5 / 24,1 / 70,4 | 0,00 |
| horário (72 ciclos) | só cbBTC do feed | 1000 | 22,5 / 25,6 / 67,6 | 0,00 |
| horário (72 ciclos) | só USDC do feed | 1000 | 0,0 / 1,9 / 54,9 | 0,00 |
| horário (72 ciclos) | as três do feed | 1000 | 31,0 / 33,2 / 85,9 | 0,00 |

**Leitura e decisão que é tua.** Em cadência diária ou semanal os três feeds servem. Em cadência horária ETH e cbBTC não servem como sinal: a variação de uma hora é do tamanho do limiar de desvio do feed. **O ponto que precisa da tua decisão:** com a regra dos 600 s, a perna USDC e a banda de peg na Base nunca usam o feed (está sempre «velho» pela regra, apesar de estar dentro do seu limiar de 0,3%). As alternativas são aceitar o DefiLlama (o quórum continua a apanhar um depeg) ou, só para stables, aceitar o feed até ao maxStaleness que o executor já usa on-chain (90 000 s).


## T5 — Capital mínimo face ao cap de 250 USD

*Posição de 250 USD → fee de 0,25 USD · entre parêntesis: gas da posição no pior caso · com M, só para os ciclos medidos em T2*

| Cadência | Ciclos | Compras (máx., sem M) | Canónica 0,003 USD: cobre? | Canónica com M (3 USD) | Agregador 0,016 USD: cobre? | Agregador com M (16 USD) |
|---|---|---|---|---|---|---|
| diária | 5 | 7 | sim (0,021) | — | sim (0,112) | — |
| diária | 6 | 6 | sim (0,018) | — | sim (0,096) | — |
| diária | 12 | 14 | sim (0,042) | sim (0,042, 14 compras) | sim (0,224) | sim (0,208, 13 compras) |
| diária | 18 | 20 | sim (0,060) | sim (0,060, 20 compras) | não (0,320) | sim (0,176, 11 compras) |
| diária | 26 | 28 | sim (0,084) | — | não (0,448) | — |
| diária | 29 | 30 | sim (0,090) | sim (0,093, 31 compras) | não (0,480) | não (0,256, 16 compras) |
| diária | 30 | 32 | sim (0,096) | sim (0,096, 32 compras) | não (0,512) | não (0,256, 16 compras) |
| diária | 31 | 33 | sim (0,099) | sim (0,099, 33 compras) | não (0,528) | não (0,288, 18 compras) |
| diária | 47 | 49 | sim (0,147) | sim (0,147, 49 compras) | não (0,784) | sim (0,208, 13 compras) |
| diária | 52 | 54 | sim (0,162) | — | não (0,864) | — |
| diária | 60 | 60 | sim (0,180) | sim (0,180, 60 compras) | não (0,960) | não (0,256, 16 compras) |
| diária | 74 | 75 | sim (0,225) | sim (0,228, 76 compras) | não (1,200) | não (0,256, 16 compras) |
| diária | 90 | 92 | não (0,276) | sim (0,141, 47 compras) | não (1,472) | não (0,256, 16 compras) |
| semanal | 2 | 4 | sim (0,012) | sim (0,012, 4 compras) | sim (0,064) | sim (0,064, 4 compras) |
| semanal | 3 | 5 | sim (0,015) | sim (0,015, 5 compras) | sim (0,080) | sim (0,080, 5 compras) |
| semanal | 5 | 7 | sim (0,021) | sim (0,021, 7 compras) | sim (0,112) | sim (0,112, 7 compras) |
| semanal | 6 | 6 | sim (0,018) | — | sim (0,096) | — |
| semanal | 7 | 9 | sim (0,027) | sim (0,027, 9 compras) | sim (0,144) | sim (0,144, 9 compras) |
| semanal | 9 | 11 | sim (0,033) | sim (0,033, 11 compras) | sim (0,176) | sim (0,176, 11 compras) |
| semanal | 11 | 13 | sim (0,039) | sim (0,039, 13 compras) | sim (0,208) | sim (0,208, 13 compras) |
| semanal | 12 | 12 | sim (0,036) | — | sim (0,192) | — |
| semanal | 13 | 15 | sim (0,045) | sim (0,045, 15 compras) | sim (0,240) | sim (0,240, 15 compras) |
| semanal | 26 | 28 | sim (0,084) | — | não (0,448) | — |
| semanal | 52 | 54 | sim (0,162) | — | não (0,864) | — |

As colunas «tier do keeper» da §2.9 descreviam o estado anterior a 627bb60 e foram retiradas. **O custo real de um fill pós-correcção não foi medido**: os RPCs públicos da Base não servem logs antigos sem token.


## T6 — A+ contra B+

**A+** = A com P, M (16 USD), E (k = 10, sem tecto), regra 9 a 25% em modo suave (+ B, banda 1%, no cesto com stable). **B+** = DCA fixo de 3 pernas (cada ciclo compra a proporção de cada perna elegível; sem regras 4, 5 e 6) com exactamente as mesmas protecções. Mesmo capital (1 000 USD), mesmas janelas, mesmas cadências. **Três voláteis primeiro.**

*3 voláteis (os três X juntos)*

| Amostra | Posições | Desvio máx. A+ / B+ (pp) | Por investir mediano A+ / B+ (%) | Maior compra A+ / B+ (%) | Compras (mediana) A+ / B+ | Gas mediano A+ / B+ (USD, agregador) | A+ à frente | A+ − B+ mediana |
|---|---|---|---|---|---|---|---|---|
| S1–S7 (stress) | 192 | 0,0 / 0,0 | 0,0 / 0,0 | 50,0 / 27,8 | 14 / 30 | 0,23 / 0,48 | 39% | −0,41% |
| Jul–Out 2026 | 5 040 | 0,0 / 0,0 | 0,0 / 0,0 | 25,0 / 16,7 | 22 / 39 | 0,35 / 0,62 | 63% | 0,40% |
| amostra de 5 anos | 36 404 | 0,0 / 0,0 | 0,0 / 0,0 | 22,5 / 20,3 | 30 / 45 | 0,48 / 0,72 | 49% | −0,02% |
| episódios horários | 3 376 | 0,0 / 0,0 | 0,0 / 0,0 | 16,9 / 15,0 | 30 / 45 | 0,48 / 0,72 | 39% | −0,20% |

*ETH + cbBTC + USDC (com stable) · os desvios vêm da banda de peg (UST, USDC), iguais em natureza nos dois*

| Amostra | Posições | Desvio máx. A+ / B+ (pp) | Por investir mediano A+ / B+ (%) | Maior compra A+ / B+ (%) | Compras (mediana) A+ / B+ | Gas mediano A+ / B+ (USD, agregador) | A+ à frente | A+ − B+ mediana |
|---|---|---|---|---|---|---|---|---|
| S1–S7 (stress) | 112 | 0,0 / 0,0 | 0,0 / 0,0 | 50,0 / 25,0 | 12 / 32 | 0,20 / 0,52 | 60% | 0,29% |
| Jul–Out 2026 | 1 680 | 0,0 / 0,0 | 0,0 / 0,0 | 25,0 / 10,0 | 22 / 40 | 0,36 / 0,63 | 53% | 0,07% |
| amostra de 5 anos | 18 888 | 5,0 / 4,3 | 0,0 / 0,0 | 19,2 / 13,2 | 30 / 45 | 0,48 / 0,72 | 52% | 0,06% |
| episódios horários | 2 072 | 50,0 / 50,0 | 0,0 / 0,0 | 26,7 / 33,3 | 30 / 45 | 0,48 / 0,72 | 43% | −0,13% |

*Amostra de 5 anos por regime de volatilidade*

| Cesto | Posições | Regime | n | A+ à frente de B+ | Mediana A+ − B+ | P5 / P95 (%) |
|---|---|---|---|---|---|---|
| 3 voláteis (os três X juntos) | 30 dias · diária | alta volatilidade | 3 196 | 46,6% | −0,10% | −2,4 / 2,6 |
| 3 voláteis (os três X juntos) | 30 dias · diária | normal | 9 572 | 51,4% | 0,04% | −2,1 / 1,8 |
| 3 voláteis (os três X juntos) | 90 dias · diária | alta volatilidade | 2 968 | 39,3% | −0,68% | −5,7 / 7,0 |
| 3 voláteis (os três X juntos) | 90 dias · diária | normal | 8 888 | 48,4% | −0,07% | −4,3 / 4,7 |
| 3 voláteis (os três X juntos) | 90 dias · semanal | alta volatilidade | 2 948 | 37,8% | −0,64% | −5,8 / 4,0 |
| 3 voláteis (os três X juntos) | 90 dias · semanal | normal | 8 832 | 54,8% | 0,22% | −4,0 / 4,1 |
| ETH + cbBTC + USDC (com stable) | 30 dias · diária | alta volatilidade | 1 652 | 41,9% | −0,17% | −2,7 / 1,9 |
| ETH + cbBTC + USDC (com stable) | 30 dias · diária | normal | 4 952 | 57,5% | 0,11% | −1,2 / 1,5 |
| ETH + cbBTC + USDC (com stable) | 90 dias · diária | alta volatilidade | 1 540 | 57,5% | 0,39% | −3,2 / 3,1 |
| ETH + cbBTC + USDC (com stable) | 90 dias · diária | normal | 4 616 | 47,3% | −0,08% | −3,3 / 2,6 |
| ETH + cbBTC + USDC (com stable) | 90 dias · semanal | alta volatilidade | 1 532 | 44,1% | −0,20% | −5,3 / 2,6 |
| ETH + cbBTC + USDC (com stable) | 90 dias · semanal | normal | 4 596 | 54,9% | 0,19% | −3,1 / 3,0 |

![Gráfico G3 · A+ face a B+: dispersão da diferença de valor por amostra e regime — três voláteis em cima, com stable em baixo](charts/G3-aplus-vs-bplus.svg)

*Gráfico G3 · A+ face a B+: dispersão da diferença de valor por amostra e regime — três voláteis em cima, com stable em baixo* — dados: [`charts/G3-aplus-vs-bplus.csv`](charts/G3-aplus-vs-bplus.csv)

**A resposta em uma frase:** Nas mesmas janelas e com as mesmas protecções, o A+ fez 30 compras por posição de 30 dias contra 45 do B+ (0,24 USD de gas a menos, rota agregador) e acabou com mais valor em 50% das 45 012 posições de três voláteis (51% das 22 752 com stable), com diferença mediana de 0,00% do capital; a garantia da divisão é a mesma nos dois.

**Leitura para o dono.** Com as melhorias do Arquitecto, o A+ e o B+ ficam com a mesma garantia e as mesmas protecções. O que os separa, medido, é o número de compras (um terço menos no A+, cêntimos de gas por posição ao preço actual da Base) e uma diferença de valor sem sinal fixo, nos dois cestos. O B+ faz compras mais pequenas e mais regulares. A garantia e as protecções valem igualmente num DCA fixo de 3 pernas; a regra 4 não acrescenta valor mensurável.


## T7 — Banda de peg escolhida pelo utilizador, com tecto derivado da história


### Primeiro, a stable de entrada

**Como foi medido.** Nos eventos reais (USDC e DAI no SVB, USDT em Mai 2022) e no contra-caso que não recuperou (UST), com as posições horárias, de 4 h e diárias da §2.10. A posição é em stable: cada compra vende stable ao seu preço em USD, por isso um USDC a 0,88 compra 12% menos ETH. «Pausa» = o ciclo espera enquanto a stable de entrada está fora da banda (ADR-024); um último ciclo apanhado na pausa espera pela primeira hora de volta à banda. Valor em USD no fim da posição. Dois produtos: o DCA de um token (ETH) e o Basket ETH + BTC + COMP (A+).

*Custo directo = Σ stable vendida × (1 − preço) · «melhor que continuar» compara o valor final em USD com o da mesma posição sem pausa (histórico)*

| Evento | Produto | Pausa | Posições | Vendido abaixo de 0,99, % do capital (mediana / máx.) | Custo directo do desconto, % do capital (mediana / máx.) | Último ciclo esperou (máx.) | Pausa melhor que continuar: % das posições · mediana (mín. / máx.) |
|---|---|---|---|---|---|---|---|
| USDC · SVB (Mar 2023) | DCA de um token (ETH) | sem pausa | 74 | 17,5 / 100 | 1,02 / 6,19 | 0 h | — |
| USDC · SVB (Mar 2023) | DCA de um token (ETH) | 0,5% | 74 | 0,0 / 0 | 0,06 / 0,43 | 56 h | 38% · −1,03% (−6,3 / 11,2) |
| USDC · SVB (Mar 2023) | DCA de um token (ETH) | 1% | 74 | 0,0 / 0 | 0,12 / 0,92 | 42 h | 38% · −0,75% (−5,5 / 10,6) |
| USDC · SVB (Mar 2023) | DCA de um token (ETH) | 2% | 74 | 3,3 / 100 | 0,13 / 1,98 | 22 h | 38% · −0,75% (−4,8 / 6,5) |
| USDC · SVB (Mar 2023) | DCA de um token (ETH) | 5% | 74 | 14,4 / 100 | 0,57 / 3,43 | 13 h | 32% · −0,27% (−1,6 / 3,0) |
| USDC · SVB (Mar 2023) | DCA de um token (ETH) | 1% · pausa máx. 72 h | 74 | 0,0 / 0 | 0,12 / 0,92 | 42 h | 38% · −0,75% (−5,5 / 10,6) |
| USDC · SVB (Mar 2023) | Basket ETH+BTC+COMP (A+) | sem pausa | 296 | 17,5 / 100 | 1,02 / 6,19 | 0 h | — |
| USDC · SVB (Mar 2023) | Basket ETH+BTC+COMP (A+) | 0,5% | 296 | 0,0 / 0 | 0,06 / 0,43 | 56 h | 38% · −1,50% (−8,0 / 11,4) |
| USDC · SVB (Mar 2023) | Basket ETH+BTC+COMP (A+) | 1% | 296 | 0,0 / 0 | 0,13 / 0,92 | 42 h | 38% · −0,68% (−7,4 / 11,5) |
| USDC · SVB (Mar 2023) | Basket ETH+BTC+COMP (A+) | 2% | 296 | 5,1 / 100 | 0,14 / 1,98 | 22 h | 38% · −0,67% (−6,6 / 6,4) |
| USDC · SVB (Mar 2023) | Basket ETH+BTC+COMP (A+) | 5% | 296 | 15,0 / 100 | 0,57 / 3,51 | 13 h | 33% · −0,52% (−2,7 / 3,4) |
| USDC · SVB (Mar 2023) | Basket ETH+BTC+COMP (A+) | 1% · pausa máx. 72 h | 296 | 0,0 / 0 | 0,13 / 0,92 | 42 h | 38% · −0,68% (−7,4 / 11,5) |
| DAI · SVB (Mar 2023) | DCA de um token (ETH) | sem pausa | 68 | 20,0 / 100 | 0,88 / 5,00 | 0 h | — |
| DAI · SVB (Mar 2023) | DCA de um token (ETH) | 0,5% | 68 | 0,0 / 0 | 0,06 / 0,48 | 56 h | 41% · −1,03% (−6,8 / 10,9) |
| DAI · SVB (Mar 2023) | DCA de um token (ETH) | 1% | 68 | 0,0 / 0 | 0,11 / 0,72 | 42 h | 41% · −0,80% (−5,9 / 10,8) |
| DAI · SVB (Mar 2023) | DCA de um token (ETH) | 2% | 68 | 3,3 / 100 | 0,18 / 1,24 | 25 h | 41% · −0,80% (−5,4 / 6,4) |
| DAI · SVB (Mar 2023) | DCA de um token (ETH) | 5% | 68 | 15,0 / 100 | 0,52 / 2,78 | 12 h | 31% · −0,32% (−1,5 / 2,8) |
| DAI · SVB (Mar 2023) | DCA de um token (ETH) | 1% · pausa máx. 72 h | 68 | 0,0 / 0 | 0,11 / 0,72 | 42 h | 41% · −0,80% (−5,9 / 10,8) |
| DAI · SVB (Mar 2023) | Basket ETH+BTC+COMP (A+) | sem pausa | 272 | 20,0 / 100 | 0,89 / 5,00 | 0 h | — |
| DAI · SVB (Mar 2023) | Basket ETH+BTC+COMP (A+) | 0,5% | 272 | 0,0 / 0 | 0,07 / 0,48 | 56 h | 41% · −1,54% (−8,5 / 10,9) |
| DAI · SVB (Mar 2023) | Basket ETH+BTC+COMP (A+) | 1% | 272 | 0,0 / 0 | 0,14 / 0,72 | 42 h | 41% · −0,76% (−7,5 / 11,5) |
| DAI · SVB (Mar 2023) | Basket ETH+BTC+COMP (A+) | 2% | 272 | 6,7 / 100 | 0,19 / 1,23 | 25 h | 39% · −0,75% (−7,1 / 7,3) |
| DAI · SVB (Mar 2023) | Basket ETH+BTC+COMP (A+) | 5% | 272 | 15,0 / 100 | 0,53 / 2,99 | 12 h | 35% · −0,54% (−2,6 / 2,8) |
| DAI · SVB (Mar 2023) | Basket ETH+BTC+COMP (A+) | 1% · pausa máx. 72 h | 272 | 0,0 / 0 | 0,14 / 0,72 | 42 h | 41% · −0,76% (−7,5 / 11,5) |
| USDT · Mai 2022 | DCA de um token (ETH) | sem pausa | 74 | 3,3 / 8 | 0,09 / 0,27 | 0 h | — |
| USDT · Mai 2022 | DCA de um token (ETH) | 0,5% | 74 | 0,0 / 0 | 0,05 / 0,13 | 11 h | 18% · −0,10% (−1,5 / 6,6) |
| USDT · Mai 2022 | DCA de um token (ETH) | 1% | 74 | 0,0 / 0 | 0,05 / 0,15 | 6 h | 15% · −0,10% (−0,8 / 6,0) |
| USDT · Mai 2022 | DCA de um token (ETH) | 2% | 74 | 3,3 / 7 | 0,09 / 0,23 | 1 h | 1% · 0,00% (−0,2 / 3,6) |
| USDT · Mai 2022 | DCA de um token (ETH) | 5% | 74 | 3,3 / 8 | 0,09 / 0,27 | 0 h | 0% · 0,00% (0,0 / 0,0) |
| USDT · Mai 2022 | DCA de um token (ETH) | 1% · pausa máx. 72 h | 74 | 0,0 / 0 | 0,05 / 0,15 | 6 h | 15% · −0,10% (−0,8 / 6,0) |
| USDT · Mai 2022 | Basket ETH+BTC+COMP (A+) | sem pausa | 296 | 0,0 / 11 | 0,06 / 0,30 | 0 h | — |
| USDT · Mai 2022 | Basket ETH+BTC+COMP (A+) | 0,5% | 296 | 0,0 / 0 | 0,05 / 0,14 | 11 h | 11% · 0,00% (−1,5 / 8,0) |
| USDT · Mai 2022 | Basket ETH+BTC+COMP (A+) | 1% | 296 | 0,0 / 0 | 0,06 / 0,15 | 6 h | 8% · 0,00% (−1,0 / 5,8) |
| USDT · Mai 2022 | Basket ETH+BTC+COMP (A+) | 2% | 296 | 0,0 / 11 | 0,06 / 0,23 | 1 h | 1% · 0,00% (−0,4 / 3,8) |
| USDT · Mai 2022 | Basket ETH+BTC+COMP (A+) | 5% | 296 | 0,0 / 11 | 0,06 / 0,30 | 0 h | 0% · 0,00% (0,0 / 0,0) |
| USDT · Mai 2022 | Basket ETH+BTC+COMP (A+) | 1% · pausa máx. 72 h | 296 | 0,0 / 0 | 0,06 / 0,15 | 6 h | 8% · 0,00% (−1,0 / 5,8) |
| UST · Mai 2022 (contra-caso: nunca recuperou) | DCA de um token (ETH) | sem pausa | 74 | 88,3 / 100 | 36,10 / 88,01 | 0 h | — |
| UST · Mai 2022 (contra-caso: nunca recuperou) | DCA de um token (ETH) | 0,5% | 74 | 0,0 / 0 | 0,01 / 0,10 | nunca voltou | 11% · −23,89% (−46,0 / 20,7) |
| UST · Mai 2022 (contra-caso: nunca recuperou) | DCA de um token (ETH) | 1% | 74 | 0,0 / 0 | 0,00 / 0,12 | nunca voltou | 11% · −20,83% (−44,0 / 20,7) |
| UST · Mai 2022 (contra-caso: nunca recuperou) | DCA de um token (ETH) | 2% | 74 | 6,7 / 20 | 0,00 / 0,31 | nunca voltou | 12% · −10,11% (−44,0 / 20,7) |
| UST · Mai 2022 (contra-caso: nunca recuperou) | DCA de um token (ETH) | 5% | 74 | 6,7 / 24 | 0,00 / 0,50 | nunca voltou | 12% · −10,11% (−44,0 / 20,7) |
| UST · Mai 2022 (contra-caso: nunca recuperou) | DCA de um token (ETH) | 1% · pausa máx. 72 h | 74 | 90,0 / 100 | 63,16 / 94,01 | 36 h | 0% · −22,16% (−45,5 / −4,9) |
| UST · Mai 2022 (contra-caso: nunca recuperou) | Basket ETH+BTC+COMP (A+) | sem pausa | 296 | 89,4 / 100 | 36,14 / 88,59 | 0 h | — |
| UST · Mai 2022 (contra-caso: nunca recuperou) | Basket ETH+BTC+COMP (A+) | 0,5% | 296 | 0,0 / 0 | 0,01 / 0,17 | nunca voltou | 12% · −23,20% (−46,6 / 21,4) |
| UST · Mai 2022 (contra-caso: nunca recuperou) | Basket ETH+BTC+COMP (A+) | 1% | 296 | 0,0 / 0 | 0,00 / 0,12 | nunca voltou | 11% · −20,52% (−44,5 / 21,4) |
| UST · Mai 2022 (contra-caso: nunca recuperou) | Basket ETH+BTC+COMP (A+) | 2% | 296 | 6,7 / 20 | 0,00 / 0,30 | nunca voltou | 12% · −10,64% (−44,5 / 21,4) |
| UST · Mai 2022 (contra-caso: nunca recuperou) | Basket ETH+BTC+COMP (A+) | 5% | 296 | 6,7 / 25 | 0,00 / 0,55 | nunca voltou | 12% · −10,64% (−44,5 / 21,4) |
| UST · Mai 2022 (contra-caso: nunca recuperou) | Basket ETH+BTC+COMP (A+) | 1% · pausa máx. 72 h | 296 | 90,0 / 100 | 63,16 / 94,00 | 36 h | 0% · −20,61% (−44,9 / −1,5) |

**Leitura.** Pausar é apostar que a stable recupera. Quando recupera (SVB), a pausa a 1% poupa o desconto: custo directo de 1,01% para 0,13% em mediana, e de 6,2% para 0,9% no pior caso. Mas o valor final ficou pior em 61% das posições, porque nos 1–2 dias de espera o ETH subiu mais do que o desconto (isto é histórico do SVB, não uma regra). Quando não recupera (UST), a pausa guarda o capital numa stable que vai a zero: −20,6% do capital em mediana face a continuar, pior −44,5%; limitar a pausa a 72 h não resolve (−20,9%), porque a UST perdeu mais de metade do valor nas primeiras 72 h. No USDT de Mai 2022 o feed nunca passou de 2,4% de desconto e a pausa quase não actua. **Recomendação, para os dois produtos: não pausar (aceite pelo dono).** Se o dono quiser uma protecção, a que os dados suportam é avisar (ou não deixar criar) uma ordem quando a stable de entrada já está fora da banda no momento da criação.


### Passo 1 — Inventário de descolamentos reais

**Universo.** Todas as stablecoins em USD do registo de stablecoins do DefiLlama (453 activos, curados ou não) com pelo menos 50 M USD em circulação no início do evento, Jan 2020 – Nov 2026. **Detecção:** preço DefiLlama abaixo de 0,98 durante 3 leituras horárias seguidas (ou 2 diárias, para as moedas sem histórico horário completo, confirmadas depois na série horária). **Recuperou** = voltou a ≥ 0,99 e não desceu abaixo de 0,99 durante 30 dias seguidos — proponho só o lado de baixo, porque excursões acima do peg (LUSD a 1,02–1,05) não são o risco que o consentimento cobre. **Série do keeper:** Chainlink hora a hora onde existe feed; senão o DefiLlama (que é o quórum que a keeper leria para uma moeda sem feed — em vez da bolsa de maior volume, que não está acessível para a maioria destas moedas), com o mínimo sustentado (mediana de 3 leituras) para um print isolado não contar. **Confirmado** = uma segunda série independente (Chainlink ou vela de bolsa) também viu o descolamento. Fins de vida declarados (BUSD depois de Fev 2023, FEI depois de Ago 2022) ficam fora.

*56 descolamentos, ordenados pela queda · a v2 já mostrava que vela, série do keeper e tick diário dão números muito diferentes (USDC: 0,805 / 0,883 / 0,968)*

| Stable | Início | Em circulação (M USD) | Série do keeper | Mínimo na série do keeper | Mínimo da vela (fonte) | Mínimo no tick diário | Queda máx. (%) | Recuperou | Dias até recuperar | Confirmado |
|---|---|---|---|---|---|---|---|---|---|---|
| DEUSD | 6 Nov 2025 | 96 | DefiLlama (quórum, sem feed Chainlink) | 0,0000 | — | 0,0000 | 100,0 | não | último 0,0000 | só agregador |
| UST | 9 Mai 2022 | 18 635 | Chainlink USTC/ETH × ETH/USD (diário; horário em Mai 2022) | 0,0066 | — | 0,0066 | 99,3 | não | último 0,0000 | sim |
| USDX | 6 Nov 2025 | 683 | DefiLlama (quórum, sem feed Chainlink) | 0,0074 | — | 0,0074 | 99,3 | não | último 0,0074 | só agregador |
| YU | 16 Nov 2025 | 91 | DefiLlama (quórum, sem feed Chainlink) | 0,0082 | — | 0,0080 | 99,2 | não | último 0,3837 | só agregador |
| PUSD | 20 Mar 2026 | 120 | DefiLlama (quórum, sem feed Chainlink) | 0,0084 | — | 0,0084 | 99,2 | não | último 0,0323 | só agregador |
| USDN | 28 Set 2021 | 528 | DefiLlama (quórum, sem feed Chainlink) | 0,0152 | — | 0,0022 | 98,5 | não | último 0,0157 | só agregador |
| HUSD | 11 Out 2022 | 223 | DefiLlama (quórum, sem feed Chainlink) | 0,0237 | — | 0,0185 | 97,6 | não | último 0,0341 | só agregador |
| USR | 22 Mar 2026 | 103 | DefiLlama (quórum, sem feed Chainlink) | 0,0403 | — | 0,0397 | 96,0 | não | último 0,0408 | só agregador |
| USDX | 29 Set 2021 | 123 | DefiLlama (quórum, sem feed Chainlink) | 0,1002 | — | 0,1002 | 90,0 | não | último 0,6583 | só agregador |
| MSUSD | 20 Jun 2026 | 76 | DefiLlama (quórum, sem feed Chainlink) | 0,1306 | — | 0,2250 | 86,9 | não | último 0,5268 | só agregador |
| sUSD | 30 Dez 2024 | 53 | DefiLlama (quórum, sem feed Chainlink) | 0,2283 | — | 0,2319 | 77,2 | não | último 0,2319 | só agregador |
| MIM | 30 Jan 2024 | 69 | DefiLlama (quórum, sem feed Chainlink) | 0,2499 | — | 0,1412 | 75,0 | sim | 369,7 | só agregador |
| pmUSD | 3 Mai 2026 | 100 | DefiLlama (quórum, sem feed Chainlink) | 0,3965 | — | 0,3135 | 60,3 | não | último 0,5627 | só agregador |
| FEI | 3 Abr 2021 | 2 264 | DefiLlama (quórum, sem feed Chainlink) | 0,7008 | — | 0,7149 | 29,9 | sim | 81,0 | só agregador |
| apxUSD | 3 Jun 2026 | 499 | DefiLlama (quórum, sem feed Chainlink) | 0,7483 | — | 0,7459 | 25,2 | não | último 0,9925 | só agregador |
| VAI | 4 Fev 2021 | 56 | DefiLlama (quórum, sem feed Chainlink) | 0,7489 | — | 0,7465 | 25,1 | sim | 972,0 | só agregador |
| USDA | 6 Jul 2026 | 87 | DefiLlama (quórum, sem feed Chainlink) | 0,8078 | — | 0,8129 | 19,2 | não | último 0,9080 | só agregador |
| FRAX | 11 Mar 2023 | 1 045 | Chainlink (Ethereum), hora a hora | 0,8812 | — | 0,9650 | 11,9 | sim | 2,3 | sim |
| sUSD | 19 Set 2021 | 314 | DefiLlama (quórum, sem feed Chainlink) | 0,8818 | — | 0,8876 | 11,8 | sim | 4,5 | só agregador |
| USDC | 11 Mar 2023 | 42 200 | Chainlink (Ethereum), hora a hora | 0,8833 | 0,8053 (Bitstamp USDC/USD) | 0,9684 | 11,7 | sim | 2,3 | sim |
| DAI | 11 Mar 2023 | 5 100 | Chainlink (Ethereum), hora a hora | 0,8946 | 0,8582 (Coinbase DAI-USD) | 0,9703 | 10,5 | sim | 2,3 | sim |
| sUSD | 26 Abr 2022 | 223 | DefiLlama (quórum, sem feed Chainlink) | 0,9017 | — | 0,9683 | 9,8 | sim | 16,2 | só agregador |
| MIM | 11 Mar 2023 | 132 | DefiLlama (quórum, sem feed Chainlink) | 0,9028 | — | 0,9626 | 9,7 | sim | 2,3 | só agregador |
| USDz | 12 Dez 2024 | 97 | DefiLlama (quórum, sem feed Chainlink) | 0,9048 | — | 0,8890 | 9,5 | sim | 421,0 | só agregador |
| DOLA | 11 Mar 2023 | 66 | DefiLlama (quórum, sem feed Chainlink) | 0,9148 | — | — | 8,5 | sim | 106,5 | só agregador |
| GUSD | 11 Mar 2023 | 555 | DefiLlama (quórum, sem feed Chainlink) | 0,9311 | 0,9600 (Coinbase GUSD-USD) | 0,9729 | 6,9 | sim | 3,5 | sim |
| sUSD | 13 Mai 2024 | 80 | DefiLlama (quórum, sem feed Chainlink) | 0,9314 | — | 0,9563 | 6,9 | sim | 7,0 | só agregador |
| MIM | 18 Jun 2022 | 219 | DefiLlama (quórum, sem feed Chainlink) | 0,9415 | — | 0,9882 | 5,8 | sim | 143,8 | só agregador |
| satUSD | 4 Mar 2026 | 159 | DefiLlama (quórum, sem feed Chainlink) | 0,9420 | — | 0,9667 | 5,8 | sim | 48,0 | só agregador |
| USDD | 10 Nov 2022 | 725 | DefiLlama (quórum, sem feed Chainlink) | 0,9431 | — | 0,9688 | 5,7 | sim | 171,8 | só agregador |
| USDD | 14 Jun 2022 | 723 | DefiLlama (quórum, sem feed Chainlink) | 0,9433 | — | 0,9585 | 5,7 | sim | 33,2 | só agregador |
| USDN | 20 Mai 2021 | 430 | DefiLlama (quórum, sem feed Chainlink) | 0,9464 | — | 0,9485 | 5,4 | sim | 12,0 | só agregador |
| LISUSD | 4 Mar 2024 | 64 | DefiLlama (quórum, sem feed Chainlink) | 0,9488 | — | 0,9646 | 5,1 | sim | 72,0 | só agregador |
| DOLA | 3 Set 2023 | 67 | DefiLlama (quórum, sem feed Chainlink) | 0,9514 | — | — | 4,9 | sim | 223,1 | só agregador |
| TUSD | 18 Jan 2024 | 1 881 | Chainlink (Ethereum), hora a hora | 0,9538 | — | 0,9596 | 4,6 | sim | 86,8 | sim |
| MIM | 14 Jul 2023 | 191 | DefiLlama (quórum, sem feed Chainlink) | 0,9550 | — | 0,9656 | 4,5 | sim | 63,9 | só agregador |
| USDP | 11 Mar 2023 | 827 | Chainlink (Ethereum), hora a hora | 0,9577 | 0,9800 (Coinbase PAX-USD) | 0,9905 | 4,2 | sim | 3,6 | sim |
| DAI | 1 Jan 2020 | 71 | DefiLlama (quórum, sem feed Chainlink) | 0,9605 | — | — | 3,9 | sim | 72,4 | só agregador |
| CUSD | 10 Fev 2026 | 218 | DefiLlama (quórum, sem feed Chainlink) | 0,9607 | — | 0,9654 | 3,9 | sim | 42,0 | só agregador |
| sUSD | 8 Jan 2022 | 208 | DefiLlama (quórum, sem feed Chainlink) | 0,9632 | — | 0,9833 | 3,7 | sim | 20,5 | só agregador |
| ALUSD | 8 Jan 2023 | 58 | DefiLlama (quórum, sem feed Chainlink) | 0,9638 | — | 0,9717 | 3,6 | sim | 27,0 | só agregador |
| sUSD | 11 Mar 2023 | 118 | DefiLlama (quórum, sem feed Chainlink) | 0,9664 | — | 0,9828 | 3,4 | sim | 2,0 | só agregador |
| UST | 21 Mai 2021 | 2 076 | DefiLlama (quórum, sem feed Chainlink) | 0,9671 | — | — | 3,3 | sim | 76,3 | só agregador |
| MIM | 4 Ago 2021 | 84 | DefiLlama (quórum, sem feed Chainlink) | 0,9687 | — | 0,9754 | 3,1 | sim | 55,8 | só agregador |
| USDD | 16 Abr 2024 | 725 | DefiLlama (quórum, sem feed Chainlink) | 0,9702 | — | 0,9699 | 3,0 | sim | 14,7 | só agregador |
| GUSD | 14 Jul 2023 | 565 | DefiLlama (quórum, sem feed Chainlink) | 0,9718 | 0,9870 (Coinbase GUSD-USD) | 0,9927 | 2,8 | sim | 64,8 | sim |
| DOLA | 18 Jan 2025 | 205 | DefiLlama (quórum, sem feed Chainlink) | 0,9743 | — | — | 2,6 | sim | 19,7 | só agregador |
| USDD | 11 Dez 2023 | 725 | DefiLlama (quórum, sem feed Chainlink) | 0,9743 | — | 0,9799 | 2,6 | sim | 36,2 | só agregador |
| FRAX | 12 Mai 2021 | 140 | DefiLlama (quórum, sem feed Chainlink) | 0,9754 | — | — | 2,5 | sim | 41,4 | só agregador |
| USDT | 11 Mai 2022 | 82 691 | Chainlink (Ethereum), hora a hora | 0,9756 | 0,9410 (Coinbase USDT-USD) | 0,9960 | 2,4 | sim | 0,2 | sim |
| LUSD | 11 Mar 2023 | 231 | Chainlink (Ethereum), hora a hora | 0,9794 | — | 1,0135 | 2,1 | sim | 0,5 | sim |
| USDS | 1 Out 2024 | 620 | Chainlink (Ethereum), hora a hora | 0,9900 | — | 0,9938 | 1,0 | sim | 52,3 | sim |
| FRAX | 29 Mar 2026 | 199 | Chainlink (Ethereum), hora a hora | 0,9904 | — | 0,9908 | 1,0 | não | último 0,9899 | não |
| USDT | 5 Jan 2021 | 21 338 | Chainlink (Ethereum), hora a hora | 0,9971 | — | — | 0,3 | sim | 49,5 | não |
| FRAX | 11 Abr 2022 | 2 684 | Chainlink (Ethereum), hora a hora | 0,9984 | — | 0,9990 | 0,2 | sim | 0,1 | não |
| LUSD | 26 Jan 2022 | 521 | Chainlink (Ethereum), hora a hora | 1,0100 | — | 1,0100 | 0 (feed ≥ 1) | sim | 0,9 | não |


### Passo 2 — O tecto

*As maiores quedas que recuperaram, confirmadas por duas séries*

| Stable | Início | Queda (%) | Série | Confirmado | Dias até recuperar |
|---|---|---|---|---|---|
| FRAX | 11 Mar 2023 | 11,9 | Chainlink (Ethereum), hora a hora | sim | 2,3 |
| USDC | 11 Mar 2023 | 11,7 | Chainlink (Ethereum), hora a hora | sim | 2,3 |
| DAI | 11 Mar 2023 | 10,5 | Chainlink (Ethereum), hora a hora | sim | 2,3 |
| GUSD | 11 Mar 2023 | 6,9 | DefiLlama (quórum, sem feed Chainlink) | sim | 3,5 |
| TUSD | 18 Jan 2024 | 4,6 | Chainlink (Ethereum), hora a hora | sim | 86,8 |
| USDP | 11 Mar 2023 | 4,2 | Chainlink (Ethereum), hora a hora | sim | 3,6 |

*Quedas maiores que «recuperaram» mas que só o agregador viu (caso de sensibilidade)*

| Stable | Início | Queda (%) | Série | Dias até recuperar |
|---|---|---|---|---|
| MIM | 30 Jan 2024 | 75,0 | DefiLlama (quórum, sem feed Chainlink) | 370 |
| FEI | 3 Abr 2021 | 29,9 | DefiLlama (quórum, sem feed Chainlink) | 81 |
| VAI | 4 Fev 2021 | 25,1 | DefiLlama (quórum, sem feed Chainlink) | 972 |
| sUSD | 19 Set 2021 | 11,8 | DefiLlama (quórum, sem feed Chainlink) | 4 |

*As stables que não recuperaram, o nível a que passaram e o que aconteceu depois*

| Stable | Início | Em circulação (M USD) | Confirmado | Queda máx. (%) | Passou o tecto (−6,9%) | Passou D_rec (−11,9%) | Do tecto a D_rec | Do tecto a 0,50 | Último preço | Estado |
|---|---|---|---|---|---|---|---|---|---|---|
| DEUSD | 6 Nov 2025 | 96 | só agregador | 100,0 | 2025-11-06 15:58 | 2025-11-06 15:58 | 0 h | 0,0 d | 0,0000 | colapsou |
| UST | 9 Mai 2022 | 18 635 | sim | 99,3 | 2022-05-09 22:00 | 2022-05-10 00:00 | 2 h | 1,4 d | 0,0000 | colapsou |
| USDX | 6 Nov 2025 | 683 | só agregador | 99,3 | 2025-11-06 12:59 | 2025-11-06 12:59 | 0 h | 0,6 d | 0,0074 | colapsou |
| YU | 16 Nov 2025 | 91 | só agregador | 99,2 | 2025-11-16 21:59 | 2025-11-17 19:58 | 22 h | 0,9 d | 0,3837 | colapsou |
| PUSD | 20 Mar 2026 | 120 | só agregador | 99,2 | 2026-04-23 13:58 | 2026-04-23 13:58 | 0 h | 0,0 d | 0,0323 | colapsou |
| USDN | 28 Set 2021 | 528 | só agregador | 98,5 | 2022-04-05 00:00 | 2022-04-05 00:00 | 0 h | 265,0 d | 0,0157 | colapsou |
| HUSD | 11 Out 2022 | 223 | só agregador | 97,6 | 2022-10-10 14:57 | 2022-10-28 14:58 | 432 h | 20,7 d | 0,0341 | colapsou |
| USR | 22 Mar 2026 | 103 | só agregador | 96,0 | 2026-03-22 02:59 | 2026-03-22 03:59 | 1 h | 0,3 d | 0,0408 | colapsou |
| USDX | 29 Set 2021 | 123 | só agregador | 90,0 | 2021-10-12 02:04 | 2022-05-11 00:00 | 5 062 h | 545,9 d | 0,6583 | não recuperou |
| MSUSD | 20 Jun 2026 | 76 | só agregador | 86,9 | 2026-06-20 15:00 | 2026-06-20 15:59 | 1 h | 0,1 d | 0,5268 | em curso |
| sUSD | 30 Dez 2024 | 53 | só agregador | 77,2 | 2025-03-31 04:59 | 2025-04-10 02:59 | 238 h | 438,4 d | 0,2319 | colapsou |
| pmUSD | 3 Mai 2026 | 100 | só agregador | 60,3 | 2026-05-04 15:58 | 2026-05-04 15:58 | 0 h | 0,8 d | 0,5627 | não recuperou |
| apxUSD | 3 Jun 2026 | 499 | só agregador | 25,2 | 2026-06-04 05:00 | 2026-06-23 00:00 | 451 h | — | 0,9925 | em curso |
| USDA | 6 Jul 2026 | 87 | só agregador | 19,2 | 2026-07-26 09:58 | 2026-08-01 14:52 | 149 h | — | 0,9080 | em curso |

*O que a história diz em cada nível de queda (todos os descolamentos confirmados na série horária)*

| Queda | Descolamentos que chegaram lá | Recuperaram | Não recuperaram | % que não recuperou | Confirmados / dos quais não recuperaram |
|---|---|---|---|---|---|
| ≥ 2,0% | 51 | 37 | 14 | 27% | 10 / 1 |
| ≥ 3,0% | 44 | 30 | 14 | 32% | 7 / 1 |
| ≥ 5,0% | 33 | 19 | 14 | 42% | 5 / 1 |
| ≥ 7,5% | 25 | 11 | 14 | 56% | 4 / 1 |
| ≥ 10,0% | 21 | 7 | 14 | 67% | 4 / 1 |
| ≥ 12,5% | 17 | 3 | 14 | 82% | 1 / 1 |
| ≥ 15,0% | 17 | 3 | 14 | 82% | 1 / 1 |
| ≥ 20,0% | 16 | 3 | 13 | 81% | 1 / 1 |
| ≥ 25,0% | 16 | 3 | 13 | 81% | 1 / 1 |
| ≥ 30,0% | 13 | 1 | 12 | 92% | 1 / 1 |
| ≥ 40,0% | 13 | 1 | 12 | 92% | 1 / 1 |
| ≥ 50,0% | 13 | 1 | 12 | 92% | 1 / 1 |
| ≥ 75,0% | 12 | 1 | 11 | 92% | 1 / 1 |
| ≥ 80,0% | 10 | 0 | 10 | 100% | 1 / 1 |
| ≥ 90,0% | 8 | 0 | 8 | 100% | 1 / 1 |

**A conta.** D_rec = 11,88% (FRAX, 11 Mar 2023, mínimo 0,8812 no feed Chainlink FRAX/USD; USDC no mesmo dia 11,67%). Há stables que caíram até D_rec e não recuperaram (a UST, confirmada no feed, passou por −11,9% às 2022-05-10 00:00 UTC), logo **tecto = 11,88 − 5 = 6,88%**. **Os 5 pp não chegam:** das 14 stables que não recuperaram, 14 passaram pelo tecto (todas as que caíram mais do que ele); para quem as compra, o tecto não é uma margem, é só o ponto onde se deixa de comprar. A partir de 7,5% de queda, 56% dos descolamentos não recuperaram; a partir de 12,5%, 82% (e os três que recuperaram só se vêem no agregador). **Sensibilidade:** se contar quedas vistas só no agregador, D_rec passaria a 75% (MIM, 30 Jan 2024, recuperou ao fim de 370 dias) e o tecto a 70%: um número que vem de pools finos e que não se pode pôr à frente de um utilizador. **Recomendei a versão confirmada; o dono decidiu outra forma: banda até 10% sem aviso e, acima, um aviso que cita 80%** — ver «Decisões do dono».


### Passo 3 — Simulação

*Cesto ETH + BTC + stable · posições horárias, de 4 h e diárias da §2.10 que contêm o evento · modo suave e rígido só diferem com a regra 9 ligada (e deram o mesmo nas compras da stable) · 1 000 USD*

| Evento | Banda | Posições | USD comprados da stable abaixo de 0,99 (mediana / máx.) | Preço médio pago | Valor dessa parte 7 / 30 dias depois | Perda máx. atribuível à stable, % do capital | Desvio / por investir máx. (regra 9 desligada) | O mesmo com regra 9 a 25%, rígido |
|---|---|---|---|---|---|---|---|---|
| USDC · SVB (Mar 2023) | 1% (defeito) | 296 | 0 / 0 | — | — | 4,5 (peso 50) | 50,0 / 50,0 | 50,0 / 50,0 |
| USDC · SVB (Mar 2023) | 5% | 296 | 33 / 500 | 0,964 | 104% / 104% | 4,5 (peso 50) | 33,3 / 33,3 | 33,3 / 33,3 |
| USDC · SVB (Mar 2023) | 10% (máx. sem aviso) | 296 | 67 / 500 | 0,932 | 107% / 107% | 4,3 (peso 50) | 4,2 / 4,2 | 4,2 / 4,2 |
| USDC · SVB (Mar 2023) | 20% (com aviso) | 296 | 67 / 500 | 0,928 | 108% / 108% | 4,3 (peso 50) | 0,0 / 0,0 | 0,0 / 0,0 |
| USDC · SVB (Mar 2023) | 80% (com aviso) | 296 | 67 / 500 | 0,928 | 108% / 108% | 4,3 (peso 50) | 0,0 / 0,0 | 0,0 / 0,0 |
| DAI · SVB (Mar 2023) | 1% (defeito) | 272 | 0 / 0 | — | — | 3,5 (peso 50) | 50,0 / 50,0 | 50,0 / 50,0 |
| DAI · SVB (Mar 2023) | 5% | 272 | 46 / 500 | 0,963 | 104% / 104% | 3,5 (peso 50) | 29,2 / 29,2 | 29,2 / 29,2 |
| DAI · SVB (Mar 2023) | 10% (máx. sem aviso) | 272 | 83 / 500 | 0,942 | 106% / 106% | 3,4 (peso 50) | 4,2 / 4,2 | 4,2 / 4,2 |
| DAI · SVB (Mar 2023) | 20% (com aviso) | 272 | 83 / 500 | 0,937 | 107% / 107% | 3,4 (peso 50) | 0,0 / 0,0 | 0,0 / 0,0 |
| DAI · SVB (Mar 2023) | 80% (com aviso) | 272 | 83 / 500 | 0,937 | 107% / 107% | 3,4 (peso 50) | 0,0 / 0,0 | 0,0 / 0,0 |
| USDT · Mai 2022 | 1% (defeito) | 220 | 0 / 0 | — | — | 0,6 (peso 50) | 8,3 / 8,3 | 30,0 / 40,0 |
| USDT · Mai 2022 | 5% | 220 | 17 / 83 | 0,988 | 101% / 101% | 0,6 (peso 50) | 0,0 / 0,0 | 30,0 / 40,0 |
| USDT · Mai 2022 | 10% (máx. sem aviso) | 220 | 17 / 83 | 0,988 | 101% / 101% | 0,6 (peso 50) | 0,0 / 0,0 | 30,0 / 40,0 |
| USDT · Mai 2022 | 20% (com aviso) | 220 | 17 / 83 | 0,988 | 101% / 101% | 0,6 (peso 50) | 0,0 / 0,0 | 30,0 / 40,0 |
| USDT · Mai 2022 | 80% (com aviso) | 220 | 17 / 83 | 0,988 | 101% / 101% | 0,6 (peso 50) | 0,0 / 0,0 | 30,0 / 40,0 |
| UST · Terra (Mai 2022), nunca recuperou | 1% (defeito) | 296 | 0 / 0 | — | — | 36,1 (peso 50) | 50,0 / 50,0 | 50,0 / 58,3 |
| UST · Terra (Mai 2022), nunca recuperou | 5% | 296 | 0 / 100 | 0,987 | 9% / 2% | 42,6 (peso 50) | 50,0 / 50,0 | 50,0 / 58,3 |
| UST · Terra (Mai 2022), nunca recuperou | 10% (máx. sem aviso) | 296 | 17 / 250 | 0,948 | 9% / 2% | 42,6 (peso 50) | 50,0 / 50,0 | 50,0 / 58,3 |
| UST · Terra (Mai 2022), nunca recuperou | 20% (com aviso) | 296 | 67 / 500 | 0,886 | 10% / 2% | 49,0 (peso 50) | 50,0 / 50,0 | 50,0 / 58,3 |
| UST · Terra (Mai 2022), nunca recuperou | 80% (com aviso) | 296 | 150 / 500 | 0,695 | 13% / 3% | 49,1 (peso 50) | 46,7 / 46,7 | 46,7 / 58,3 |

**Leitura.** A perda atribuível à stable nunca passou do peso que o utilizador lhe deu (o lock da regra 6 trava a perna no seu alvo), mesmo com a regra 9 a empurrar orçamento para ela. Mas atenção ao que isto quer dizer: **a banda só protege o que se compraria depois do descolamento.** No caso da UST, a maior parte da perda veio da stable comprada antes, a 1 USD — com banda de 1% a perda chegou a —% do capital numa posição 25-25-50. O «por investir» igual ao peso da stable (até 50%) é a banda a fazer o que deve: uma stable que acaba a posição fora da banda não é comprada no último ciclo, e esse dinheiro fica com o utilizador.


### As cinco perguntas

1. **Os dados dão D_rec = 11,9%** (FRAX, SVB, 11 Mar 2023, feed Chainlink hora a hora; USDC 11,7% no mesmo evento) e tecto 6,9%. **Decisão do dono:** até 10% sem aviso; acima de 10%, um aviso único que cita 80% (10 stables caíram 80% ou mais desde 2020; 0 recuperaram).
2. **O aviso (decisão do dono):** «Nenhuma stable, nos últimos 2 501 dias, recuperou de uma queda de 80%. Ainda assim, quer avançar?» **Proposta da Analista, para a banda escolhida:** «A banda que escolheste deixa o Basket continuar a comprar esta stable até X% abaixo de 1 USD. Nos últimos 2 501 dias, das N stables que caíram mais de X%, só R recuperaram, e nenhuma recuperou de uma queda de 80%. Se a stable não recuperar, podes perder até P% desta posição (o peso que lhe deste). Ainda assim, quer avançar?»
3. Na UST com a banda no máximo sem aviso (10%), a posição comprou UST abaixo de 0,99 em 53% das posições, até 250 USD (preço médio 0,948), que valiam 9% 7 dias depois e 1,9% 30 dias depois. A perda máxima atribuível à UST foi 42,6% do capital (posição 25-25-50, perna de 50%; quase toda de UST comprada antes do descolamento). A perna deixou de ser comprada no primeiro tick com a UST abaixo de 0,90: 2022-05-09 23:00 UTC na cadência horária (o feed passou −10% às 2022-05-09 23:00). Com a banda a 80% (com aviso), até 500 USD e perda até 49,1%. Para comparação, com o tecto derivado dos dados (6,9%) a perna parava às 2022-05-09 22:00.
4. **Sim, mas o que se recalcula muda.** Com os 10% e os 80% fixados pelo dono, o script passa a recalcular os números que o aviso cita (X dias, a tabela de níveis, se alguma stable recuperou de 80%). Proposta: (i) o `run_all.py` refaz o inventário a partir do registo do DefiLlama e dos feeds; (ii) qualquer stable com ≥ 50 M USD que caia mais de 5% abre uma revisão; (iii) os números só mudam quando a janela de 30 dias desse evento fecha; (iv) a revisão vai ao dono se um evento novo contradisser a escolha (uma stable que recupere de 80% ou mais — a frase do aviso deixaria de ser verdade —, ou uma que morra com uma queda abaixo de 10%), e nunca se aplica a ordens já criadas.
5. **Decidido pelo dono: sem pausa**, no Basket e no DCA de um token. Os números ficam na tabela da stable de entrada acima.


## Testes do motor

- `test_switches_off_reproduce_v2_exactly` — A+ com tudo desligado = A da v2, compra a compra, em S1–S7 (112 posições, com e sem regra 9).
- `test_P_keeps_the_split_and_changes_only_decisions` — P em S1–S7, cesto com stable e ETH + cbBTC + COMP: desvio 0, execução sempre ao preço do feed, e P muda decisões (o interruptor está vivo).
- `test_P_leg_without_price_is_not_bought_and_last_cycle_waits` — uma perna sem preço utilizável não é comprada; sem espera a garantia parte-se (o teste exige que parta); com a regra do dono, se o preço volta no 2.º ciclo seguinte compra lá e o desvio é 0; se não volta em 3, a perna fica por comprar, o dinheiro fica com o utilizador e a razão vem no resultado.
- `test_M_min_fill_respected_and_split_exact` — 100/250/1 000 USD × 3/16 USD × A+ e B+: nenhuma compra abaixo do mínimo fora do último ciclo; desvio ≤ 0,01 USD por perna.
- `test_E_staged_catchup_bounds_the_largest_fill_without_breaking_the_split` — k = 10 sem tecto em S1–S7, nos dois cestos: desvio 0 e maior compra ≤ 20% a partir de 8 ciclos; com tecto que trava, o capital por investir aparece e é contado.
- `test_B_band_never_buys_a_depegged_stable_also_on_the_last_cycle` — USDC no SVB e UST em Mai 2022, horário: nenhuma compra da stable fora da banda (1% e 5%), incluindo o último ciclo e o último ciclo que esperou por preço; a perna nunca passa do seu peso.
- `test_three_volatile_basket_keeps_the_split_with_every_switch_on` — os três X, A+ e B+ com P + M + E + regra 9: desvio ≤ 0,01 USD por perna.
- Os 7 testes da v2 continuam a passar sem alterações.


## O que não foi medido, e porquê

- **X com menos histórico**: VIRTUAL só desde 17 Jan 2025 e AERO desde 5 Abr 2024 — S1, S2, S3, S7, a âncora de 2022–23 e os episódios E1–E4 só têm COMP. Parte de E1 (as posições diárias que começam antes de 1 Dez 2021) fica sem COMP.
- **Os outros X de fase 1 do catálogo**: feeds com menos de um ano; não acrescentavam janelas reais.
- **O quórum real do ADR-024** (Chainlink + DefiLlama + CoinGecko): a CoinGecko não tem histórico sem chave. P e a fase 2 usam o DefiLlama — declarado.
- **A disponibilidade ao vivo do DefiLlama** nas datas passadas: as lacunas do histórico contam como «sem preço» e são a origem de todos os «último ciclo sem preço».
- **Bolsa de maior volume para as stables sem feed**: Binance e afins não estão acessíveis daqui; usei o DefiLlama (o quórum da keeper) com mínimo sustentado. Velas só onde a Coinbase/Bitstamp listam o par (USDC, USDT, DAI, USDP, GUSD, PYUSD).
- **Descolamentos antes de 2020** (USDT 2018, por exemplo): fora do histórico do DefiLlama.
- **Stables abaixo de 50 M USD em circulação no início do evento** (o MIM de 2026, por exemplo, já tinha encolhido): fora do universo por desenho.
- **O custo real de um fill na Base depois de 627bb60**: os RPCs públicos não servem logs antigos sem token.
- **O repo no commit actual do GitHub**: sem acesso desta sessão; confirmação feita on-chain no executor da Base.
- **Execução real** (rota, slippage, impacto da maior compra): o motor compra ao preço do feed.
- **Se a keeper e o contrato conseguem repetir o último ciclo até 3 vezes e depois fechar a ordem com uma perna por comprar**, e guardar o motivo para o relatório no site: é capacidade da keeper — pergunta para o Arquitecto. Simulado: os 3 ciclos seguintes à cadência da ordem.


## O que isto muda na spec (proposta)

1. **Cesto principal com três voláteis: entra.** A garantia aguenta com todos os interruptores.
2. **P** entra, com a regra do dono para o último ciclo: sem preço utilizável, tenta nos 3 ciclos seguintes (a banda de peg continua a valer); se não houver, a ordem fecha com a perna por comprar, o dinheiro fica com o utilizador e o motivo vai para o relatório.
3. **M** entra com a tua fórmula; o último ciclo isento a partir de 0,01 USD.
4. **E**: k = 10, sem tecto. No cesto com stable, se for preciso ≤ 20% com 6–7 ciclos, mínimo de 8 ciclos quando a regra 9 está activa. Tecto não.
5. **Regra 9** mantém-se a 25% no cesto de três voláteis; é a regra que mais concentra, e o E é o que a segura. Se o dono quiser menos concentração, o parâmetro é o limiar (30%), não o k.
6. **B** (decisão do dono): banda escolhida pelo utilizador, 1% por defeito; até 10% sem aviso; acima, um aviso único («Nenhuma stable, nos últimos 2 501 dias, recuperou de uma queda de 80%. Ainda assim, quer avançar?»); se recusar, a ordem não é criada. O número de dias e o facto dos 80% saem do script e actualizam-se a cada descolamento novo. Proposta da Analista: o aviso dizer também o número da banda escolhida.
7. **Stable de entrada: sem pausa**, no Basket e no DCA de um token (decisão do dono). No máximo, um aviso na criação da ordem se a stable de entrada já estiver fora da banda.
8. **Cadência mínima diária** enquanto a regra 4 usar os feeds da Base e o quórum: em cadência horária decide sobre ruído (T4, T8).
9. **Relatório de fecho da ordem no site** (ideia do dono): divisão pedida contra cumprida, compras, ciclos sem compra e porquê, e qualquer perna por comprar com o motivo e onde está o dinheiro. Conteúdo proposto em «Decisões do dono».
