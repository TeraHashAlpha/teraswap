# Basket DCA — modelação v3.2: a janela do modo suave e a perna stable da fase 1

**Pedido:** `claude/basket-dca-pedido-modelacao-v3.2-2026-11-13.md` (Arquitecto, 13 Nov 2026). **Pacote:** o mesmo; `python3 run_all.py --v32-only` refaz só esta parte; v2, v3 e v3.1 não mudam (md5 dos relatórios: `bee70ee6`, `b2d00edb`, `dcf5387d`). Tabelas em `results/v32/`.

> Separação de sempre: **(a)** a garantia — o que foi comprado cumpre a divisão? quanto ficou por comprar? — e **(b)** o que aconteceu ao valor e ao preço: histórico, nunca promessa.

**A — Que fórmula para k_soft, e a tabela N → k?**

**`k_soft = ⌈N ÷ 4⌉`, com mínimo 1 e sem tecto.** No modo suave, a protecção pausa o token até aos últimos ⌈N ÷ 4⌉ ciclos (o último quarto da ordem); nesses ciclos e nos 3 de tolerância, compra o que ficou para trás. **Tabela N → k:** 6 → 2 · 7 → 2 · 8 → 2 · 9 → 3 · 10 → 3 · 12 → 3 · 15 → 4 · 20 → 5 · 26 → 7 · 30 → 8 · 60 → 15 · 86 → 22. **Porquê esta:** é a candidata que mais protege entre as que nunca deixaram chunks por comprar por causa da protecção: 0 em 855 428 posições (5 cestos × 4 divisões × 25 combinações N × cadência). Tem uma razão aritmética: com L = 2, uma perna de até 50% protegida até ao início da janela ainda compra tudo, com 3 ciclos de folga, porque 2 × (⌈N ÷ 4⌉ + 3) ≥ ⌈N ÷ 2⌉ + 6. **O tecto de 10 tem de sair.** Em N = 60 e 86 todas as candidatas limitadas dão k = 10 e deixaram 279 posições com chunks por comprar (até 4 chunks, 6,7% do capital). A janela mínima sem folga («garantia») falhou 24 vezes, todas por faltar um preço num dos ciclos finais. A folga de 3 ciclos é precisamente para isso.

**A — O caso N = 6**

**A protecção faz sentido em N = 6 e não é preciso retirar o modo suave abaixo de nenhum N:** em nenhum N o suave com ⌈N ÷ 4⌉ deixou chunks por comprar. Em N = 6, k = 2, por isso a protecção pode pausar até 4 dos 6 ciclos. O que a cadência decide é se a protecção chega a actuar. Na diária, um token cair 25% em 6 dias é raro: a regra 9 bloqueou em 0,6% das posições. Na de 3 dias bloqueou em 4,5% e na semanal (6 semanas) em 13,4%. Com k = 10, em 0%. **O custo é concentrar o fim.** O maior gasto num só ciclo sobe de 41,7% para 66,7% do capital na semanal e de 41,7% para 54,2% na de 3 dias; na diária não muda (40,0%). A mediana não muda (20,0%): só as posições em que a protecção actua compram mais no fim.

**A — As frases para a interface**

**Modo suave:** «No modo suave, a protecção pausa o token até aos últimos K ciclos da ordem (o último quarto). Nesses ciclos, e nos 3 de tolerância, compra o que ficou para trás, mesmo que o preço continue baixo.» K = ⌈N ÷ 4⌉ calculado para a ordem do utilizador (6 ciclos → 2; 9 → 3; 26 → 7; 86 → 22). Nesta corrida, a protecção nunca deixou chunks por comprar no modo suave. **Modo rígido (aviso):** «No modo rígido, a protecção nunca deixa de pausar: se o token não recuperar até ao fim da ordem, essa parte não é comprada e fica na sua carteira. No histórico que medimos (2022–2026), isso aconteceu em 10% das ordens simuladas e chegou a deixar 71% do valor por comprar.» Por N: N = 6: 4,6%; N = 9: 8,0%; N = 15: 10,4%; N = 26: 18,5%; N = 60: 25,3%; N = 86: 29,4%. É histórico, não promessa; se a UI mostrar os números, deve dizê-lo.

**B — A perna stable da fase 1: USDT ou DAI**

**USDT e DAI estão registados no executor da Base**, com os feeds padrão do directório (`usdt-usd`, `dai-usd`, não os SVR); a description() on-chain confere. Os dois têm limiar de 0,3%, heartbeat de 86 400 s e maxStaleness de 90 000 s, como o USDC. Rondas por heartbeat: USDT 96%, DAI 96% (USDC 97%). **Regra da banda a 1%:** na Base (Ago 2023 – Nov 2026), face ao quórum sozinho, muda 5 decisões horárias no USDT e 13 no DAI. Elimina 1 + 1 horas de falso «fora da banda» confirmadas pela segunda série e cria 0 + 0; quase todas as outras são horas em que o quórum não tinha preço e o feed decide (4 + 11). Nos feeds de Ethereum desde Jan 2021, que incluem os descolamentos reais (USDT em Mai 2022, DAI e USDT no SVB), a regra é melhor nos dois sentidos. No USDT, o quórum marca 209 horas «fora da banda», 160 delas falsas pela segunda série, e perde 22 das 26 horas realmente fora. A regra marca 54, 17 falsas, e perde 2. Em Mai 2022 o quórum não viu o USDT sair da banda de 1% (0 horas); a regra viu 7. **O aviso acima de 10% aplica-se sem alterações**, porque N, R e D vêm do universo das stables e não da perna. O DAI (SVB, −10,5%, recuperou em 2,3 dias) já está entre as que recuperaram na linha dos 10%; o USDT nunca caiu mais de 10%. **Cesto WETH + cbBTC + stable** (suave, L = 2, k = ⌈N ÷ 4⌉): 0 posições incompletas em 215 192 por stable, em todas as bandas (1%, 2%, 5%, 10%). A stable só saiu da banda num tick diário, 12 Mar 2023 (SVB): DAI a 0,971 e USDT a 1,009. Nesse ciclo não compra a stable e recupera nos seguintes. **EURC:** sim, a banda pode definir-se mais tarde contra o feed EUR/USD da Base (0,1% / 3 600 s): |EURC/USD ÷ EUR/USD − 1|, somando os dois limiares (0,4 pp). Não foi modelado.


## A. A janela do modo suave: k_soft em função de N

**O que foi medido.** A+ discreto como na v3.1 (uma ordem DCA por perna, chunk fixo, L = 2, Hamilton, minFill 16 USD, 1 000 USD), regra 9 a 25%. No modo suave a protecção deixa de bloquear quando `t ≥ N − k_soft` e nos 3 ciclos de tolerância; no rígido bloqueia sempre. **Posições:** N ciclos a uma cadência do produto (diária, 3 dias, semanal), com N na lista do pedido e só onde cabe no prazo de 90 dias: `(N + 3) × cadência + margem ≤ 90 dias` dá até 86 ciclos na diária, 26 na de 3 dias e 9 na semanal (25 combinações). Janelas da v3.1: S1–S7 (uma posição a começar em cada dia da janela), Jul–Out 2026 (uma por dia), os 7 episódios (posições diárias às 00:00 cujo intervalo contém o movimento; as cadências horárias da v3.1 não são do produto) e a amostra de 5 anos (uma por dia desde 31 Mar 2022). Cestos: os três voláteis (VIRTUAL, COMP, AERO) e o cesto com stable, agora com USDT e com DAI (a moeda de pagamento é USDC). Cada posição corre uma vez por cada k diferente das candidatas, mais o rígido e a mesma posição sem regra 9. Quando nenhuma perna chega a cair 25% face à entrada, todas as candidatas dão o mesmo resultado e corre uma só vez.

**Porque é que k = 10 não protege.** Com N ≤ 10, `N − 10 ≤ 0`, por isso a protecção nunca bloqueia no modo suave: na v3.1 os cestos semanais tinham 0 posições incompletas por isso mesmo. Nesta corrida, com k = 10 e N ≤ 10, a regra 9 bloqueou em 0 de 475 136 posições, apesar de 112 796 delas terem uma perna a cair 25% ou mais face à entrada.


### As candidatas: N → k

*Mínimo 1 em todas; tecto 10 nas quatro do pedido · as duas últimas são minhas: «⌈N ÷ 4⌉ sem tecto» porque o tecto parte a garantia em ordens longas, «garantia» = a janela mínima com que uma perna protegida até ao início ainda compra todos os chunks (⌈n_max ÷ L⌉ − 3), sem folga · varia com a divisão*

| N | Cadências em que cabe | k = 10 | ⌈N ÷ 2⌉ | ⌈N ÷ 3⌉ | ⌈N ÷ 4⌉ | ⌈N ÷ 4⌉ sem tecto | «garantia» | Maior n_i (1 000 USD) | 2 × (10 + 3) ≥ maior n_i? |
|---|---|---|---|---|---|---|---|---|---|
| 6 | diária, 3 dias, semanal | 10 | 3 | 2 | 2 | 2 | 1 | 3 | sim |
| 7 | diária, 3 dias, semanal | 10 | 4 | 3 | 2 | 2 | 1 | 3 | sim |
| 8 | diária, 3 dias, semanal | 10 | 4 | 3 | 2 | 2 | 1 | 4 | sim |
| 9 | diária, 3 dias, semanal | 10 | 5 | 3 | 3 | 3 | 1 | 5 | sim |
| 10 | diária, 3 dias | 10 | 5 | 4 | 3 | 3 | 1 | 5 | sim |
| 12 | diária, 3 dias | 10 | 6 | 4 | 3 | 3 | 1 | 6 | sim |
| 15 | diária, 3 dias | 10 | 8 | 5 | 4 | 4 | 1 | 7 | sim |
| 20 | diária, 3 dias | 10 | 10 | 7 | 5 | 5 | 1–2 | 10 | sim |
| 26 | diária, 3 dias | 10 | 10 | 9 | 7 | 7 | 2–4 | 13 | sim |
| 30 | diária | 10 | 10 | 10 | 8 | 8 | 2–5 | 15 | sim |
| 60 | diária | 10 | 10 | 10 | 10 | 15 | 7–12 | 30 | **não** |
| 86 | diária | 10 | 10 | 10 | 10 | 22 | 7–13 | 31 | **não** |


### As candidatas lado a lado

*«Bloqueou» = num ciclo com compras devidas, a regra 9 tirou uma perna com chunks por comprar · «incompletas por causa da protecção» = ficaram chunks por comprar e a mesma posição sem regra 9 completou · valor no fim da posição, em % de 1 000 USD, só nas posições onde uma perna caiu 25%; empate < 0,01%*

| Cesto | Candidata | N | Posições | A regra 9 bloqueou (posições) | Incompletas por causa da protecção: n · máx. chunks · máx. % do capital | Compras com a perna protegida: % das posições · % do capital (média) · queda média face à entrada | Maior gasto num ciclo, % do capital: P95 / máx. | Valor face a sem regra 9 (histórico): melhor / pior · mediana (P5 / P95) |
|---|---|---|---|---|---|---|---|---|
| 3 voláteis (VIRTUAL, COMP, AERO) | k = 10 (hoje) | 6–9 | 202 816 | 0,0% | 0 | 15,8% · 26,0% · −33,3% | 25,0% / 41,7% | 0% / 0% · 0,00% (0,0 / 0,0) |
|  |  | 10–15 | 101 724 | 2,6% | 0 | 18,2% · 21,4% · −33,5% | 12,5% / 27,7% | 3% / 3% · 0,00% (0,0 / 0,0) |
|  |  | 20–30 | 85 700 | 26,4% | 0 | 30,7% · 20,8% · −37,4% | 7,7% / 30,2% | 23% / 29% · 0,00% (−3,5 / 2,2) |
|  |  | 60–86 | 34 804 | 54,5% | 279 · 4 · 6,7% | 41,9% · 20,5% · −43,7% | 6,7% / 10,0% | 33% / 54% · −0,09% (−9,8 / 5,6) |
|  | ⌈N ÷ 2⌉ (tecto 10) | 6–9 | 202 816 | 7,6% | 0 | 14,8% · 25,2% · −34,3% | 25,0% / 58,3% | 8% / 9% · 0,00% (−1,5 / 0,7) |
|  |  | 10–15 | 101 724 | 9,6% | 0 | 17,2% · 21,0% · −34,2% | 12,5% / 43,5% | 11% / 12% · 0,00% (−1,5 / 0,8) |
|  |  | 20–30 | 85 700 | 26,4% | 0 | 30,7% · 20,8% · −37,4% | 7,7% / 30,2% | 23% / 29% · 0,00% (−3,5 / 2,2) |
|  |  | 60–86 | 34 804 | 54,5% | 279 · 4 · 6,7% | 41,9% · 20,5% · −43,7% | 6,7% / 10,0% | 33% / 54% · −0,09% (−9,8 / 5,6) |
|  | ⌈N ÷ 3⌉ (tecto 10) | 6–9 | 202 816 | 11,8% | 0 | 13,9% · 24,2% · −35,5% | 25,0% / 66,7% | 14% / 16% · 0,00% (−2,8 / 1,8) |
|  |  | 10–15 | 101 724 | 14,1% | 0 | 15,8% · 20,7% · −35,2% | 12,5% / 53,3% | 17% / 21% · 0,00% (−2,7 / 1,4) |
|  |  | 20–30 | 85 700 | 29,1% | 0 | 29,8% · 20,4% · −38,0% | 10,0% / 30,2% | 25% / 33% · 0,00% (−4,2 / 2,6) |
|  |  | 60–86 | 34 804 | 54,5% | 279 · 4 · 6,7% | 41,9% · 20,5% · −43,7% | 6,7% / 10,0% | 33% / 54% · −0,09% (−9,8 / 5,6) |
|  | ⌈N ÷ 4⌉ (tecto 10) | 6–9 | 202 816 | 13,3% | 0 | 13,5% · 23,9% · −36,1% | 25,0% / 66,7% | 16% / 19% · 0,00% (−3,3 / 2,1) |
|  |  | 10–15 | 101 724 | 16,1% | 0 | 15,1% · 20,4% · −35,8% | 12,5% / 50,0% | 19% / 24% · 0,00% (−3,2 / 1,6) |
|  |  | 20–30 | 85 700 | 31,7% | 0 | 28,5% · 20,1% · −38,7% | 11,8% / 30,2% | 27% / 37% · 0,00% (−5,1 / 3,1) |
|  |  | 60–86 | 34 804 | 54,5% | 279 · 4 · 6,7% | 41,9% · 20,5% · −43,7% | 6,7% / 10,0% | 33% / 54% · −0,09% (−9,8 / 5,6) |
|  | **⌈N ÷ 4⌉ sem tecto (recomendada)** | 6–9 | 202 816 | 13,3% | 0 | 13,5% · 23,9% · −36,1% | 25,0% / 66,7% | 16% / 19% · 0,00% (−3,3 / 2,1) |
|  |  | 10–15 | 101 724 | 16,1% | 0 | 15,1% · 20,4% · −35,8% | 12,5% / 50,0% | 19% / 24% · 0,00% (−3,2 / 1,6) |
|  |  | 20–30 | 85 700 | 31,7% | 0 | 28,5% · 20,1% · −38,7% | 11,8% / 30,2% | 27% / 37% · 0,00% (−5,1 / 3,1) |
|  |  | 60–86 | 34 804 | 52,2% | 0 | 46,0% · 20,9% · −42,2% | 6,7% / 10,0% | 33% / 49% · 0,00% (−6,7 / 4,5) |
|  | «garantia»: ⌈n_max ÷ 2⌉ − 3 | 6–9 | 202 816 | 15,9% | 6 · 1 · 12,5% | 11,7% · 24,0% · −38,0% | 25,0% / 76,7% | 19% / 25% · 0,00% (−4,8 / 3,2) |
|  |  | 10–15 | 101 724 | 19,3% | 2 · 1 · 8,3% | 12,8% · 20,7% · −38,3% | 16,7% / 51,0% | 23% / 33% · 0,00% (−4,3 / 2,8) |
|  |  | 20–30 | 85 700 | 35,2% | 16 · 1 · 5,0% | 24,7% · 19,9% · −40,8% | 15,0% / 30,2% | 28% / 45% · 0,00% (−7,5 / 4,6) |
|  |  | 60–86 | 34 804 | 54,6% | 0 | 41,7% · 20,6% · −43,8% | 6,7% / 10,0% | 33% / 54% · −0,08% (−10,0 / 5,5) |
|  | rígido (referência) | 6–9 | 202 816 | 17,3% | 16 944 · 6 · 70,0% | — | 25,0% / 66,7% | 15% / 32% · 0,00% (−7,0 / 2,6) |
|  |  | 10–15 | 101 724 | 20,1% | 10 498 · 10 · 70,0% | — | 13,3% / 40,0% | 20% / 38% · 0,00% (−5,3 / 2,5) |
|  |  | 20–30 | 85 700 | 36,7% | 17 484 · 20 · 71,2% | — | 10,0% / 30,0% | 26% / 51% · −0,03% (−8,6 / 4,7) |
|  |  | 60–86 | 34 804 | 56,5% | 11 997 · 43 · 70,1% | — | 3,3% / 10,0% | 32% / 58% · −0,25% (−12,1 / 6,8) |
| com stable (USDT, DAI) | k = 10 (hoje) | 6–9 | 204 576 | 0,0% | 0 | 7,9% · 22,8% · −32,3% | 25,0% / 40,0% | 0% / 0% · 0,00% (0,0 / 0,0) |
|  |  | 10–15 | 102 640 | 1,0% | 0 | 8,7% · 18,7% · −32,0% | 12,5% / 22,2% | 2% / 3% · 0,00% (0,0 / 0,0) |
|  |  | 20–30 | 87 256 | 13,0% | 0 | 16,5% · 17,7% · −35,8% | 5,6% / 20,0% | 21% / 26% · 0,00% (−2,0 / 1,6) |
|  |  | 60–86 | 35 912 | 32,1% | 0 | 25,1% · 15,7% · −42,0% | 6,7% / 6,7% | 34% / 44% · 0,00% (−8,6 / 5,4) |
|  | ⌈N ÷ 2⌉ (tecto 10) | 6–9 | 204 576 | 3,6% | 0 | 7,6% · 22,0% · −33,1% | 25,0% / 46,7% | 7% / 8% · 0,00% (−0,7 / 0,5) |
|  |  | 10–15 | 102 640 | 4,3% | 0 | 8,2% · 18,6% · −32,5% | 12,5% / 32,0% | 9% / 12% · 0,00% (−1,0 / 0,6) |
|  |  | 20–30 | 87 256 | 13,0% | 0 | 16,5% · 17,7% · −35,8% | 5,6% / 20,0% | 21% / 26% · 0,00% (−2,0 / 1,6) |
|  |  | 60–86 | 35 912 | 32,1% | 0 | 25,1% · 15,7% · −42,0% | 6,7% / 6,7% | 34% / 44% · 0,00% (−8,6 / 5,4) |
|  | ⌈N ÷ 3⌉ (tecto 10) | 6–9 | 204 576 | 5,9% | 0 | 7,1% · 21,3% · −34,0% | 25,0% / 66,7% | 13% / 15% · 0,00% (−1,5 / 1,1) |
|  |  | 10–15 | 102 640 | 6,6% | 0 | 7,6% · 18,7% · −33,3% | 12,5% / 40,0% | 16% / 20% · 0,00% (−1,3 / 1,0) |
|  |  | 20–30 | 87 256 | 15,0% | 0 | 16,0% · 17,3% · −36,4% | 5,6% / 20,0% | 25% / 30% · 0,00% (−2,5 / 2,1) |
|  |  | 60–86 | 35 912 | 32,1% | 0 | 25,1% · 15,7% · −42,0% | 6,7% / 6,7% | 34% / 44% · 0,00% (−8,6 / 5,4) |
|  | ⌈N ÷ 4⌉ (tecto 10) | 6–9 | 204 576 | 6,7% | 0 | 6,9% · 21,1% · −34,5% | 25,0% / 66,7% | 15% / 17% · 0,00% (−1,7 / 1,3) |
|  |  | 10–15 | 102 640 | 7,5% | 0 | 7,3% · 18,7% · −33,8% | 12,5% / 40,0% | 19% / 23% · 0,00% (−1,4 / 1,1) |
|  |  | 20–30 | 87 256 | 16,6% | 0 | 15,2% · 17,0% · −37,2% | 5,6% / 20,0% | 27% / 34% · 0,00% (−3,2 / 2,5) |
|  |  | 60–86 | 35 912 | 32,1% | 0 | 25,1% · 15,7% · −42,0% | 6,7% / 6,7% | 34% / 44% · 0,00% (−8,6 / 5,4) |
|  | **⌈N ÷ 4⌉ sem tecto (recomendada)** | 6–9 | 204 576 | 6,7% | 0 | 6,9% · 21,1% · −34,5% | 25,0% / 66,7% | 15% / 17% · 0,00% (−1,7 / 1,3) |
|  |  | 10–15 | 102 640 | 7,5% | 0 | 7,3% · 18,7% · −33,8% | 12,5% / 40,0% | 19% / 23% · 0,00% (−1,4 / 1,1) |
|  |  | 20–30 | 87 256 | 16,6% | 0 | 15,2% · 17,0% · −37,2% | 5,6% / 20,0% | 27% / 34% · 0,00% (−3,2 / 2,5) |
|  |  | 60–86 | 35 912 | 30,0% | 0 | 28,5% · 15,5% · −40,4% | 6,4% / 6,7% | 35% / 38% · 0,00% (−7,2 / 4,5) |
|  | «garantia»: ⌈n_max ÷ 2⌉ − 3 | 6–9 | 204 576 | 8,0% | 0 | 6,1% · 20,7% · −36,2% | 25,0% / 66,7% | 19% / 22% · 0,00% (−2,4 / 2,0) |
|  |  | 10–15 | 102 640 | 9,1% | 0 | 6,3% · 18,8% · −35,3% | 12,5% / 41,7% | 23% / 30% · 0,00% (−1,8 / 1,6) |
|  |  | 20–30 | 87 256 | 18,4% | 0 | 12,9% · 16,9% · −39,1% | 10,0% / 20,0% | 28% / 41% · 0,00% (−7,0 / 3,5) |
|  |  | 60–86 | 35 912 | 32,3% | 0 | 24,9% · 15,5% · −42,1% | 6,7% / 6,7% | 34% / 45% · 0,00% (−8,7 / 5,5) |
|  | rígido (referência) | 6–9 | 204 576 | 8,4% | 9 153 · 6 · 70,0% | — | 25,0% / 66,7% | 15% / 27% · 0,00% (−5,1 / 1,8) |
|  |  | 10–15 | 102 640 | 9,3% | 5 578 · 7 · 70,0% | — | 12,5% / 38,9% | 21% / 33% · 0,00% (−2,5 / 1,5) |
|  |  | 20–30 | 87 256 | 18,8% | 9 662 · 19 · 63,3% | — | 7,1% / 20,0% | 26% / 45% · 0,00% (−7,4 / 3,6) |
|  |  | 60–86 | 35 912 | 33,1% | 7 372 · 36 · 57,6% | — | 3,3% / 6,7% | 31% / 50% · −0,02% (−9,2 / 6,0) |

**Leitura.** (1) Protecção a actuar: com k = 10 a regra 9 nunca bloqueia em N ≤ 10. As candidatas proporcionais fazem-na actuar em todos os N, e mais quanto menor o k. (2) Garantia: só deixaram chunks por comprar as candidatas com tecto, em N = 60 e 86 (porque aí k = 10), e a «garantia», que não tem folga. ⌈N ÷ 4⌉ sem tecto: 0. (3) O modo suave não evita a compra, adia-a. As compras com a perna ainda protegida acontecem na janela final, com o token em média ~39% abaixo da entrada. É o preço de completar a ordem, e a frase da UI tem de o dizer. (4) Concentração: um k menor empurra mais compras para a janela final; com N pequeno, um chunk é ~1/N do capital, por isso o máximo num ciclo sobe (tabela por N abaixo). (5) Valor (histórico, nunca promessa): nas posições em que uma perna caiu 25%, pausar e comprar depois deu, em mediana, o mesmo valor que comprar sempre. Mas foi pior mais vezes do que melhor, e a média é ligeiramente negativa (3 voláteis, 6 a 9 ciclos: 19% pior, 16% melhor, média −0,23%). A protecção existe para não comprar durante a queda, não para prometer melhor preço.


### A recomendada (⌈N ÷ 4⌉ sem tecto), por N

*Todas as cadências em que o N cabe · «uma perna caiu 25%» = a protecção pode disparar (decisão ≤ 75% da entrada em algum ciclo)*

| Cesto | N | k | Posições | Uma perna caiu 25% | A regra 9 bloqueou (ciclos, mediana) | Incompletas por causa da protecção | Compras com a perna protegida: % posições · % capital · queda | Maior gasto num ciclo: k = 10 → ⌈N ÷ 4⌉ | Rígido: incompletas · máx. por comprar |
|---|---|---|---|---|---|---|---|---|---|
| 3 voláteis (VIRTUAL, COMP, AERO) | 6 | 2 | 50 548 | 27,5% | 8,3% (1) | 0 | 9,8% · 24,7% · −33,9% | 41,7% → 66,7% | 6,1% · 66,7% |
|  | 7 | 2 | 50 660 | 29,9% | 11,6% (2) | 0 | 12,0% · 24,2% · −35,1% | 33,3% → 61,1% | 7,5% · 66,7% |
|  | 8 | 2 | 50 756 | 32,6% | 16,0% (2) | 0 | 14,4% · 23,7% · −36,8% | 28,3% → 63,3% | 9,2% · 66,7% |
|  | 9 | 3 | 50 852 | 35,0% | 17,2% (2) | 0 | 17,8% · 23,5% · −36,9% | 26,7% → 57,5% | 10,7% · 70,0% |
|  | 10 | 3 | 33 776 | 26,7% | 11,3% (2) | 0 | 11,6% · 20,6% · −34,0% | 22,5% → 50,0% | 7,5% · 70,0% |
|  | 12 | 3 | 33 912 | 30,5% | 15,9% (2) | 0 | 14,5% · 20,2% · −35,5% | 18,0% → 43,5% | 10,0% · 66,7% |
|  | 15 | 4 | 34 036 | 35,5% | 21,0% (3) | 0 | 19,3% · 20,4% · −36,8% | 27,7% → 40,3% | 13,4% · 67,9% |
|  | 20 | 5 | 34 188 | 42,7% | 29,3% (5) | 0 | 25,9% · 20,5% · −39,0% | 30,2% → 30,2% | 18,2% · 70,0% |
|  | 26 | 7 | 34 416 | 48,9% | 36,5% (6) | 0 | 33,0% · 20,8% · −39,9% | 23,3% → 23,3% | 23,8% · 71,2% |
|  | 30 | 8 | 17 096 | 39,7% | 26,6% (5) | 0 | 24,7% · 17,4% · −35,0% | 20,1% → 20,1% | 18,1% · 66,7% |
|  | 60 | 15 | 17 316 | 56,8% | 48,3% (15) | 0 | 42,7% · 20,1% · −41,1% | 10,0% → 10,0% | 32,0% · 66,7% |
|  | 86 | 22 | 17 488 | 64,5% | 56,0% (19) | 0 | 49,3% · 21,5% · −43,0% | 10,0% → 10,0% | 36,9% · 70,1% |
| com stable (USDT, DAI) | 6 | 2 | 50 856 | 14,6% | 4,2% (1) | 0 | 4,7% · 23,1% · −32,8% | 40,0% → 66,7% | 3,1% · 66,7% |
|  | 7 | 2 | 51 056 | 16,5% | 5,8% (2) | 0 | 6,4% · 21,6% · −33,5% | 33,3% → 53,3% | 4,2% · 66,7% |
|  | 8 | 2 | 51 240 | 18,4% | 8,4% (2) | 0 | 7,7% · 20,3% · −35,1% | 33,3% → 53,3% | 5,1% · 66,7% |
|  | 9 | 3 | 51 424 | 20,6% | 8,5% (2) | 0 | 8,9% · 20,5% · −35,2% | 26,7% → 46,7% | 5,4% · 70,0% |
|  | 10 | 3 | 33 968 | 13,3% | 5,3% (2) | 0 | 5,2% · 18,8% · −33,1% | 22,2% → 40,0% | 4,0% · 70,0% |
|  | 12 | 3 | 34 224 | 15,7% | 7,2% (3) | 0 | 6,5% · 19,2% · −33,3% | 16,7% → 35,0% | 4,8% · 56,0% |
|  | 15 | 4 | 34 448 | 19,0% | 10,2% (3) | 0 | 10,1% · 18,4% · −34,3% | 15,0% → 27,0% | 7,4% · 46,7% |
|  | 20 | 5 | 34 728 | 24,3% | 15,3% (5) | 0 | 14,0% · 17,3% · −36,9% | 20,0% → 20,0% | 10,1% · 55,0% |
|  | 26 | 7 | 35 184 | 29,2% | 20,1% (7) | 0 | 19,0% · 16,7% · −38,5% | 15,3% → 15,3% | 13,4% · 60,7% |
|  | 30 | 8 | 17 344 | 20,3% | 12,1% (5) | 0 | 10,2% · 17,3% · −33,2% | 13,3% → 13,3% | 8,3% · 63,3% |
|  | 60 | 15 | 17 784 | 35,5% | 26,1% (14) | 0 | 25,7% · 15,5% · −38,4% | 6,7% → 6,7% | 18,8% · 50,0% |
|  | 86 | 22 | 18 128 | 43,2% | 33,9% (20) | 0 | 31,2% · 15,5% · −42,0% | 6,7% → 6,7% | 22,3% · 57,6% |


### Ordens curtas, por cadência (N = 6 a 9)

*Os cinco cestos · com k = 10 a regra 9 nunca bloqueia nestes N*

| N | Cadência | Posições | Uma perna caiu 25% | A regra 9 bloqueou | Compras com a perna protegida: % posições · % capital | Maior gasto num ciclo: k = 10 → ⌈N ÷ 4⌉ | Rígido: incompletas · máx. por comprar |
|---|---|---|---|---|---|---|---|
| 6 | diária | 33 220 | 5,6% | 0,6% | 0,8% · 17,9% | 40,0% → 40,0% (mediana 20,0%) | 0,3% · 35,0% |
|  | 3 dias | 33 720 | 19,2% | 4,5% | 5,4% · 22,3% | 41,7% → 54,2% (mediana 20,0%) | 3,9% · 66,7% |
|  | semanal | 34 464 | 37,7% | 13,4% | 15,3% · 25,1% | 41,7% → 66,7% (mediana 20,0%) | 9,4% · 62,5% |
| 7 | diária | 33 292 | 6,6% | 1,1% | 1,3% · 17,8% | 33,3% → 33,3% (mediana 16,7%) | 0,5% · 45,8% |
|  | 3 dias | 33 864 | 22,0% | 6,6% | 7,4% · 21,6% | 33,3% → 61,1% (mediana 16,7%) | 5,3% · 66,7% |
|  | semanal | 34 560 | 40,4% | 18,1% | 18,7% · 24,3% | 33,3% → 61,1% (mediana 16,7%) | 11,5% · 62,5% |
| 8 | diária | 33 344 | 7,4% | 1,9% | 1,7% · 17,1% | 33,3% → 38,9% (mediana 15,0%) | 0,8% · 50,0% |
|  | 3 dias | 34 008 | 24,8% | 9,6% | 9,3% · 21,1% | 28,3% → 63,3% (mediana 15,0%) | 6,8% · 66,7% |
|  | semanal | 34 644 | 43,4% | 24,6% | 21,7% · 23,5% | 28,3% → 63,3% (mediana 15,0%) | 13,6% · 66,7% |
| 9 | diária | 33 396 | 8,4% | 2,1% | 2,6% · 16,4% | 26,7% → 36,7% (mediana 13,3%) | 1,1% · 52,5% |
|  | 3 dias | 34 152 | 28,0% | 10,2% | 11,5% · 21,3% | 26,7% → 57,5% (mediana 13,3%) | 8,1% · 70,0% |
|  | semanal | 34 728 | 46,2% | 25,7% | 25,4% · 23,6% | 26,7% → 57,5% (mediana 13,3%) | 14,6% · 70,0% |


## B. A perna stable da fase 1 na Base: USDT ou DAI


### B1. O registo e os feeds

*OrderExecutorV3 da Base (de docs/DEPLOYMENTS.md), lido a 2026-11-13 19:28 UTC · tokens do catálogo da Base do repo · o feed registado é comparado com o directório da Chainlink por igualdade de endereço, nunca escrito à mão*

| Token | Registado em `tokenUsdFeeds` | Feed (directório, igual ao registado) | maxStaleness (s) | Limiar / heartbeat (directório) | description() on-chain |
|---|---|---|---|---|---|
| USDT | sim | usdt-usd | 90 000 | 0,3% / 86 400 s | USDT / USD |
| DAI | sim | dai-usd | 90 000 | 0,3% / 86 400 s | DAI / USD |
| EURC | sim | eurc-usd | 90 000 | 0,3% / 86 400 s | EURC / USD |
| USDS | não | — | — | — | — |
| USDe | não | — | — | — | — |
| sUSDe | não | — | — | — | — |
| USDbC | não | — | — | — | — |
| cbETH | não | — | — | — | — |
| wstETH | não | — | — | — | — |
| AAVE | não | — | — | — | — |
| LINK | não está no catálogo da Base do repo | — | — | — | — |
| GHO | não está no catálogo da Base do repo | — | — | — | — |

*Todas as rondas on-chain desde o lançamento · «por heartbeat» = intervalo ≥ 90% do heartbeat (o mesmo critério da v3 para o USDC) · USDC na última linha, para comparar*

| Feed | Limiar / heartbeat | maxStaleness (s) | Rondas | Primeira ronda | Intervalo mediano | Rondas por heartbeat | Rondas por desvio (passo mediano) | Idade da ronda, hora a hora: mediana / máx. | Horas acima do maxStaleness | Preço lido: mín. – máx. |
|---|---|---|---|---|---|---|---|---|---|---|
| USDT/USD · Base | 0,3% / 86 400 s | 90 000 | 1 236 | 3 Ago 2023 | 24,00 h | 96,4% | 45 (0,00%) | 12,0 h / 24,0 h | 0 | 0,9977 – 1,0041 |
| DAI/USD · Base | 0,3% / 86 400 s | 90 000 | 1 235 | 3 Ago 2023 | 24,00 h | 96,4% | 44 (0,33%) | 12,0 h / 24,0 h | 0 | 0,9979 – 1,0021 |
| USDC/USD · Base | 0,3% / 86 400 s | 90 000 | 1 223 | 3 Ago 2023 | 24,00 h | 97,1% | 35 (0,00%) | 11,9 h / 24,0 h | 0 | 0,9994 – 1,0013 |

**Leitura.** Os três feeds de stables da Base comportam-se da mesma forma: actualizam quase só por heartbeat (uma ronda por dia) e nunca passaram do maxStaleness (90 000 s para 86 400 s de heartbeat: 1 hora de margem). O preço do DAI nunca saiu de 0,9979–1,0021 na Base, e o do USDT de 0,9977–1,0041. Não houve descolamento desde que os feeds existem. Com a tua regra, o limiar de 0,3% cabe em qualquer banda ≥ 1%, por isso o feed decide sempre, enquanto a ronda tiver menos de 90 000 s.


### B2. A regra da banda em USDT e DAI

*Hora a hora · quórum = DefiLlama (aproximação declarada) · 2.ª série = velas horárias da Coinbase (USDT-USD, DAI-USD; abertura da hora; a de DAI acaba em Mai 2026) · «v3.1 (600 s)» = o interruptor P (feed só se a ronda tiver ≤ 600 s) · tua regra = feed até ao maxStaleness, fora se |p − 1| + limiar > banda, senão quórum, sem preço salta · Ethereum: limiar 0,25%, feed aceite até heartbeat × 90 000 ÷ 86 400 (USDT 90 000 s; DAI 3 750 s)*

| Período e feed | Banda | Horas | Horas com 2.ª série | Decisões que mudam face ao quórum (mais estrita / menos) | Horas «fora da banda»: quórum / v3.1 (600 s) / tua regra | Falsas pela 2.ª série: quórum / v3.1 / tua regra | Falsos «fora» eliminados / criados pela tua regra | Horas fora pela 2.ª série: perdidas pelo quórum / pela tua regra | Horas sem preço: quórum / tua regra |
|---|---|---|---|---|---|---|---|---|---|
| USDT · Base · Ago 2023 – Nov 2026 | 1% | 28 601 | 28 590 | 5 (0 / 1) | 1 / 1 / 0 | 1 / 1 / 0 | 1 / 0 | 0: 0 / 0 | 4 / 0 |
| USDT · Base · Ago 2023 – Nov 2026 | 2% | 28 601 | 28 590 | 4 (0 / 0) | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 | 0: 0 / 0 | 4 / 0 |
| USDT · Base · Ago 2023 – Nov 2026 | 5% | 28 601 | 28 590 | 4 (0 / 0) | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 | 0: 0 / 0 | 4 / 0 |
| USDT · Base · Ago 2023 – Nov 2026 | 10% | 28 601 | 28 590 | 4 (0 / 0) | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 | 0: 0 / 0 | 4 / 0 |
| USDT · Ethereum · Jan 2021 – Nov 2026 | 1% | 51 264 | 48 296 | 594 (37 / 192) | 209 / 211 / 54 | 160 / 156 / 17 | 159 / 16 | 26: 22 / 2 | 466 / 100 |
| USDT · Ethereum · Jan 2021 – Nov 2026 | 2% | 51 264 | 48 296 | 405 (2 / 37) | 40 / 39 / 5 | 31 / 29 / 0 | 31 / 0 | 1: 1 / 0 | 466 / 100 |
| USDT · Ethereum · Jan 2021 – Nov 2026 | 5% | 51 264 | 48 296 | 369 (0 / 3) | 3 / 2 / 0 | 3 / 2 / 0 | 3 / 0 | 0: 0 / 0 | 466 / 100 |
| USDT · Ethereum · Jan 2021 – Nov 2026 | 10% | 51 264 | 48 296 | 366 (0 / 0) | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 | 0: 0 / 0 | 466 / 100 |
| USDT · Mai 2022 · descolamento de 2,4% (Ethereum) | 1% | 182 | 182 | 7 (7 / 0) | 0 / 4 / 7 | 0 / 0 / 1 | 0 / 1 | 7: 7 / 1 | 0 / 0 |
| USDT · Mai 2022 · descolamento de 2,4% (Ethereum) | 2% | 182 | 182 | 1 (1 / 0) | 0 / 1 / 1 | 0 / 0 / 0 | 0 / 0 | 1: 1 / 0 | 0 / 0 |
| USDT · Mai 2022 · descolamento de 2,4% (Ethereum) | 5% | 182 | 182 | 0 (0 / 0) | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 | 0: 0 / 0 | 0 / 0 |
| USDT · Mai 2022 · descolamento de 2,4% (Ethereum) | 10% | 182 | 182 | 0 (0 / 0) | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 | 0: 0 / 0 | 0 / 0 |
| DAI · Base · Ago 2023 – Nov 2026 | 1% | 28 601 | 24 066 | 13 (0 / 2) | 2 / 1 / 0 | 1 / 1 / 0 | 1 / 0 | 0: 0 / 0 | 11 / 0 |
| DAI · Base · Ago 2023 – Nov 2026 | 2% | 28 601 | 24 066 | 11 (0 / 0) | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 | 0: 0 / 0 | 11 / 0 |
| DAI · Base · Ago 2023 – Nov 2026 | 5% | 28 601 | 24 066 | 11 (0 / 0) | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 | 0: 0 / 0 | 11 / 0 |
| DAI · Base · Ago 2023 – Nov 2026 | 10% | 28 601 | 24 066 | 11 (0 / 0) | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 | 0: 0 / 0 | 11 / 0 |
| DAI · Ethereum · Jan 2021 – Nov 2026 | 1% | 51 264 | 46 722 | 773 (7 / 108) | 193 / 178 / 92 | 146 / 131 / 43 | 106 / 3 | 52: 5 / 3 | 1239 / 581 |
| DAI · Ethereum · Jan 2021 – Nov 2026 | 2% | 51 264 | 46 722 | 678 (1 / 19) | 64 / 64 / 46 | 22 / 22 / 4 | 19 / 1 | 45: 2 / 3 | 1239 / 581 |
| DAI · Ethereum · Jan 2021 – Nov 2026 | 5% | 51 264 | 46 722 | 660 (0 / 2) | 15 / 14 / 13 | 3 / 2 / 1 | 2 / 0 | 12: 0 / 0 | 1239 / 581 |
| DAI · Ethereum · Jan 2021 – Nov 2026 | 10% | 51 264 | 46 722 | 658 (0 / 0) | 1 / 1 / 1 | 0 / 0 / 0 | 0 / 0 | 1: 0 / 0 | 1239 / 581 |
| DAI · Mar 2023 · descolamento de 10,5% (Ethereum) | 1% | 200 | 200 | 4 (4 / 0) | 51 / 51 / 55 | 7 / 7 / 8 | 0 / 1 | 47: 3 / 0 | 0 / 0 |
| DAI · Mar 2023 · descolamento de 10,5% (Ethereum) | 2% | 200 | 200 | 0 (0 / 0) | 42 / 42 / 42 | 0 / 0 / 0 | 0 / 0 | 42: 0 / 0 | 0 / 0 |
| DAI · Mar 2023 · descolamento de 10,5% (Ethereum) | 5% | 200 | 200 | 1 (0 / 1) | 14 / 13 / 13 | 2 / 1 / 1 | 1 / 0 | 12: 0 / 0 | 0 / 0 |
| DAI · Mar 2023 · descolamento de 10,5% (Ethereum) | 10% | 200 | 200 | 0 (0 / 0) | 1 / 1 / 1 | 0 / 0 / 0 | 0 / 0 | 1: 0 / 0 | 0 / 0 |

**Leitura.** Na Base não houve descolamento: as poucas decisões que mudam são horas em que o DefiLlama marcava fora ou não tinha preço e o feed (fresco) dizia dentro. Nos feeds de Ethereum desde 2021, a tua regra corta a maior parte dos falsos alarmes do quórum (USDT: 160 → 17; DAI: 146 → 43). E perde menos horas verdadeiramente fora da banda do que o quórum (USDT: 22 → 2 de 26; DAI: 5 → 3 de 52). Em Mai 2022 o DefiLlama nunca pôs o USDT abaixo de 0,99 nos pontos horários; o feed de Ethereum leu 0,9756. No SVB, o USDT também saiu da banda, mas para cima: 1,009 às 00:00 de 12 Mar 2023. A banda é simétrica, por isso bloqueia o prémio como bloqueia a queda.


### B3. O aviso acima de 10% com USDT ou DAI

*results/v31/aviso_banda.csv sem alterações · D = 2137 dias · as três regras de redacção da v3.1 (singular com R = 1; «nenhuma recuperou» com R = 0; com 100% só a frase dos 80%)*

| Banda X | N | R | USDT entre as N | DAI entre as N | Texto (igual ao da v3.1) |
|---|---|---|---|---|---|
| 10% | 20 | 7 | não | sim (recuperou) | Das 20 stables que caíram mais de 10%, só 7 recuperaram. Nenhuma stable, nos últimos 2137 dias, recuperou de uma queda de 80%. Ainda assim, quer avançar? |
| 15% | 17 | 3 | não | não | Das 17 stables que caíram mais de 15%, só 3 recuperaram. Nenhuma stable, nos últimos 2137 dias, recuperou de uma queda de 80%. Ainda assim, quer avançar? |
| 20% | 16 | 3 | não | não | Das 16 stables que caíram mais de 20%, só 3 recuperaram. Nenhuma stable, nos últimos 2137 dias, recuperou de uma queda de 80%. Ainda assim, quer avançar? |
| 25% | 16 | 3 | não | não | Das 16 stables que caíram mais de 25%, só 3 recuperaram. Nenhuma stable, nos últimos 2137 dias, recuperou de uma queda de 80%. Ainda assim, quer avançar? |
| 30% | 13 | 1 | não | não | Das 13 stables que caíram mais de 30%, só 1 recuperou. Nenhuma stable, nos últimos 2137 dias, recuperou de uma queda de 80%. Ainda assim, quer avançar? |
| 35% | 13 | 1 | não | não | Das 13 stables que caíram mais de 35%, só 1 recuperou. Nenhuma stable, nos últimos 2137 dias, recuperou de uma queda de 80%. Ainda assim, quer avançar? |
| 40% | 13 | 1 | não | não | Das 13 stables que caíram mais de 40%, só 1 recuperou. Nenhuma stable, nos últimos 2137 dias, recuperou de uma queda de 80%. Ainda assim, quer avançar? |
| 45% | 13 | 1 | não | não | Das 13 stables que caíram mais de 45%, só 1 recuperou. Nenhuma stable, nos últimos 2137 dias, recuperou de uma queda de 80%. Ainda assim, quer avançar? |
| 50% | 13 | 1 | não | não | Das 13 stables que caíram mais de 50%, só 1 recuperou. Nenhuma stable, nos últimos 2137 dias, recuperou de uma queda de 80%. Ainda assim, quer avançar? |
| 55% | 13 | 1 | não | não | Das 13 stables que caíram mais de 55%, só 1 recuperou. Nenhuma stable, nos últimos 2137 dias, recuperou de uma queda de 80%. Ainda assim, quer avançar? |
| 60% | 13 | 1 | não | não | Das 13 stables que caíram mais de 60%, só 1 recuperou. Nenhuma stable, nos últimos 2137 dias, recuperou de uma queda de 80%. Ainda assim, quer avançar? |
| 65% | 12 | 1 | não | não | Das 12 stables que caíram mais de 65%, só 1 recuperou. Nenhuma stable, nos últimos 2137 dias, recuperou de uma queda de 80%. Ainda assim, quer avançar? |
| 70% | 12 | 1 | não | não | Das 12 stables que caíram mais de 70%, só 1 recuperou. Nenhuma stable, nos últimos 2137 dias, recuperou de uma queda de 80%. Ainda assim, quer avançar? |
| 75% | 12 | 1 | não | não | Das 12 stables que caíram mais de 75%, só 1 recuperou. Nenhuma stable, nos últimos 2137 dias, recuperou de uma queda de 80%. Ainda assim, quer avançar? |
| 80% | 10 | 0 | não | não | Das 10 stables que caíram mais de 80%, nenhuma recuperou. Nenhuma stable, nos últimos 2137 dias, recuperou de uma queda de 80%. Ainda assim, quer avançar? |
| 85% | 10 | 0 | não | não | Das 10 stables que caíram mais de 85%, nenhuma recuperou. Nenhuma stable, nos últimos 2137 dias, recuperou de uma queda de 80%. Ainda assim, quer avançar? |
| 90% | 8 | 0 | não | não | Das 8 stables que caíram mais de 90%, nenhuma recuperou. Nenhuma stable, nos últimos 2137 dias, recuperou de uma queda de 80%. Ainda assim, quer avançar? |
| 95% | 8 | 0 | não | não | Das 8 stables que caíram mais de 95%, nenhuma recuperou. Nenhuma stable, nos últimos 2137 dias, recuperou de uma queda de 80%. Ainda assim, quer avançar? |
| 100% | 0 | 0 | não | não | Nenhuma stable, nos últimos 2137 dias, recuperou de uma queda de 80%. Ainda assim, quer avançar? |

**Confirmação.** O aviso não depende da perna: N, R e D vêm do inventário de todas as stables com ≥ 50 M USD (T7), não da stable escolhida. Por isso o texto é o mesmo com USDT ou DAI. Descolamentos de USDT e DAI no inventário desde 30 Dez 2020: DAI 11 Mar 2023: −10,5%, recuperou em 2,3 dias; USDT 11 Mai 2022: −2,4%, recuperou em 0,2 dias. O DAI conta como «caiu mais de 10% e recuperou» na linha dos 10%; acima de 10,5% nenhum dos dois conta. O feed também não muda o limiar efectivo: 0,3% na Base, como o USDC.


### B4. O cesto WETH + cbBTC + stable, por banda

*Modo suave, L = 2, k = ⌈N ÷ 4⌉, regra da banda do Arquitecto · todas as janelas e todos os N do produto · a stable é a perna 3 (50% na divisão 25-25-50) · preço de execução = feed da Base desde Ago 2023, antes o mesmo feed em Ethereum*

| Stable | Banda | Cadência | Posições | Fecham com chunks por executar | Chunks por executar (mín. / med. / máx.) | Por comprar, % do capital (mín. / med. / máx.) | Posições com a stable fora da banda · ciclos sem compra por banda | Ciclos sem compra por falta de preço |
|---|---|---|---|---|---|---|---|---|
| USDT | 1% | diária | 102 160 | 0 (0,00%) | — | — | 2 600 · 328 | 415 |
|  |  | 3 dias | 78 036 | 0 (0,00%) | — | — | 1 048 · 114 | 204 |
|  |  | semanal | 34 996 | 0 (0,00%) | — | — | 288 · 6 | 25 |
|  | 2% | diária | 102 160 | 0 (0,00%) | — | — | 0 · 0 | 415 |
|  |  | 3 dias | 78 036 | 0 (0,00%) | — | — | 0 · 0 | 204 |
|  |  | semanal | 34 996 | 0 (0,00%) | — | — | 0 · 0 | 25 |
|  | 5% | diária | 102 160 | 0 (0,00%) | — | — | 0 · 0 | 415 |
|  |  | 3 dias | 78 036 | 0 (0,00%) | — | — | 0 · 0 | 204 |
|  |  | semanal | 34 996 | 0 (0,00%) | — | — | 0 · 0 | 25 |
|  | 10% | diária | 102 160 | 0 (0,00%) | — | — | 0 · 0 | 415 |
|  |  | 3 dias | 78 036 | 0 (0,00%) | — | — | 0 · 0 | 204 |
|  |  | semanal | 34 996 | 0 (0,00%) | — | — | 0 · 0 | 25 |
| DAI | 1% | diária | 102 160 | 0 (0,00%) | — | — | 2 600 · 304 | 415 |
|  |  | 3 dias | 78 036 | 0 (0,00%) | — | — | 1 048 · 114 | 211 |
|  |  | semanal | 34 996 | 0 (0,00%) | — | — | 288 · 6 | 48 |
|  | 2% | diária | 102 160 | 0 (0,00%) | — | — | 2 600 · 304 | 415 |
|  |  | 3 dias | 78 036 | 0 (0,00%) | — | — | 1 048 · 114 | 211 |
|  |  | semanal | 34 996 | 0 (0,00%) | — | — | 288 · 6 | 48 |
|  | 5% | diária | 102 160 | 0 (0,00%) | — | — | 0 · 0 | 415 |
|  |  | 3 dias | 78 036 | 0 (0,00%) | — | — | 0 · 0 | 211 |
|  |  | semanal | 34 996 | 0 (0,00%) | — | — | 0 · 0 | 48 |
|  | 10% | diária | 102 160 | 0 (0,00%) | — | — | 0 · 0 | 415 |
|  |  | 3 dias | 78 036 | 0 (0,00%) | — | — | 0 · 0 | 211 |
|  |  | semanal | 34 996 | 0 (0,00%) | — | — | 0 · 0 | 48 |

**Leitura.** Nenhuma posição ficou incompleta, em nenhuma banda e com nenhuma das duas stables. Nos ticks diários às 00:00, a stable só saiu da banda uma vez: 12 Mar 2023 (SVB), com o DAI a 0,971 e o USDT a 1,009 (acima do peg). Isso afecta a banda de 1% nas duas e a de 2% no DAI. Nesse ciclo a stable não compra; os seus chunks passam para os ciclos seguintes, já dentro da banda. O USDT em Mai 2022 caiu durante o dia, mas às 00:00 estava dentro da banda; o cesto diário não o vê. É uma limitação da cadência diária, não da regra.


## Testes do motor

- `test_int_and_function_k_are_the_same_engine`: k = 10 e uma função que devolve 10 dão as mesmas compras (S1–S7).
- `test_v31_results_are_reproduced`: as corridas da v3.1 (A+ discreto, S1–S7, suave e rígido, L = 1 e 2) saem iguais do motor da v3.2.
- `test_chosen_k_always_leaves_rule9_room_and_fits_every_chunk`: para cada N do produto e cada divisão, a fórmula escolhida dá 1 ≤ k < N (a regra 9 pode bloquear) e 2 × (k + 3) ≥ maior n_i.
- `test_chosen_k_protects_short_orders_on_real_windows`: posições semanais N = 6 a 9 em S1–S7. Com k = 10 a regra 9 nunca bloqueia; com a fórmula escolhida bloqueia.
- `test_chosen_k_never_leaves_chunks_for_rule9_alone`: os 5 cestos, S1–S7, todas as combinações N × cadência. No suave, uma posição só fica incompleta se também ficar sem regra 9.
- `test_protected_fill_metrics_and_band_rule`: a métrica das compras com a perna protegida bate com as compras, e a stable nunca compra com |p − 1| + limiar > banda.
- Os 17 testes da v2, v3 e v3.1 continuam a passar.


## O que não foi medido, e porquê

- **Os feeds USDT e DAI da Base antes de Ago 2023**: não existiam. Antes disso, a perna stable usa o mesmo feed em Ethereum (limiar 0,25%; maxStaleness na proporção do executor da Base), como na v3.1.
- **O executor a recusar um feed acima do maxStaleness**: o preço de execução é o do feed no tick, como na v3.1. Na Base isto nunca aconteceu nas stables (0 horas acima de 90 000 s).
- **O quórum real** (CoinGecko sem histórico) e a disponibilidade ao vivo do DefiLlama: aproximados pelo DefiLlama horário, como na v3 e na v3.1.
- **Divisões com uma perna acima de 50%**: as quatro divisões medidas vão até 50%. Com uma perna maior, a folga de 3 ciclos de ⌈N ÷ 4⌉ encolhe (a 60% e N = 60, 36 chunks para 36 de capacidade: sem folga). Não medido.
- **O segundo chunk de L = 2 meio ciclo depois**: modelado no mesmo tick, como na v3.1.
- **Gas e a ordem real do keeper dentro do ciclo**: como na v3.1.
- **EURC**: fora do pedido.


## O que isto muda na spec (proposta)

1. **`k_soft = max(1, ⌈N ÷ 4⌉)`, sem tecto.** Substitui o k = 10 fixo. A UI mostra o K da ordem: «a protecção pausa o token até aos últimos K ciclos».
2. **Modo suave por defeito, sem excepção para ordens curtas.** Com N = 6 a protecção actua; o custo é concentrar o fim, e a frase da UI di-lo.
3. **Aviso no modo rígido** com a frase da resposta A e os números do histórico, marcados como histórico.
4. **Perna stable da fase 1: USDT ou DAI**, os dois registados na Base com 0,3% / 86 400 s / maxStaleness 90 000 s. A regra da banda e o aviso acima de 10% aplicam-se sem alterações.
5. **Se as divisões permitirem uma perna acima de 50%**, rever a folga (ou limitar a perna a 50%).
