# Basket DCA — modelação v2, v3, v3.1, v3.2 e v3.3 (pacote reprodutível)

Destino no repo: `docs/Reports/basket-dca/`. Relatórios: [`RESULTS-2026-11.md`](RESULTS-2026-11.md) (v2, não muda),
[`RESULTS-2026-11-v3.md`](RESULTS-2026-11-v3.md) (v3: o A+ e o cesto de três voláteis) e
[`RESULTS-2026-11-v3.1.md`](RESULTS-2026-11-v3.1.md) (v3.1: o A+ discreto sobre o contrato V3, verificação on-chain na Base, tabela do aviso) e
[`RESULTS-2026-11-v3.2.md`](RESULTS-2026-11-v3.2.md) (v3.2: a janela do modo suave em função de N; USDT e DAI como perna stable na Base) e
[`RESULTS-2026-11-v3.3.md`](RESULTS-2026-11-v3.3.md) (v3.3: acções tokenizadas da Coinbase como pernas do Split DCA: fins-de-semana, maxStaleness, splits).

```
pip install -r requirements.txt
python3 run_all.py --no-fetch            # refaz v2, v3 e v3.1 a partir de data/series/ (v2 ~2 min, v3 ~20 min, v3.1 ~10 min)
python3 run_all.py --no-fetch --v3-only  # só a v3
python3 run_all.py --no-fetch --v31-only # só a v3.1 (~10 min; lê o inventário da v3)
python3 run_all.py --no-fetch --v32-only # só a v3.2 (~25 min com 2 núcleos; lê a tabela do aviso da v3.1)
python3 run_all.py --no-fetch --v33-only # só a v3.3 (~6 min com 2 núcleos)
python3 src/experiments_v31.py           # só a tabela do aviso X -> (N, R) (results/v31/aviso_banda.csv)
python3 src/report_v3.py --no-compute    # só reconstrói o RESULTS v3 a partir de results/v3/
python3 run_all.py                       # também volta a ler feeds e APIs (rondas em cache em data/raw/)
python3 -m pytest tests/                 # testes do motor sobre janelas reais (v2 a v3.3)
```

Só dados reais: rondas Chainlink lidas on-chain (Arbitrum, Base, Ethereum), DefiLlama (preços horários e o registo
de stablecoins), Coinbase e Bitstamp. Os endereços vêm do directório oficial da Chainlink e do registo de feeds do
repo, cruzados e verificados on-chain (`description()`/`decimals()`), nunca escritos à mão — ver
`src/feeds_config.py`, `src/fetch_v3_x.py`, `src/fetch_v3_stables.py`, `src/fetch_v32.py`, `src/fetch_v33.py` e os `*_verification.csv` em `data/series/`.

| Pasta | Conteúdo |
|---|---|
| `src/` | dados, motor v2 (`engine.py`), motor A+ (`engine_plus.py`, interruptores P/M/E/B), cenários, gráficos, relatórios |
| `src/experiments_v3.py`, `src/experiments_v3x.py` | v3: T1, T2, T4 (cesto com stable) e T3, T6, T8 (três voláteis primeiro) |
| `src/engine_discrete.py`, `src/experiments_v31.py`, `src/report_v31.py` | v3.1: A+ discreto (3 ordens DCA por cesto), regra da banda do Arquitecto, tabela do aviso |
| `src/experiments_v32.py`, `src/report_v32.py`, `src/fetch_v32.py` | v3.2: candidatas de k_soft por N × cadência; USDT e DAI na Base (registo, rondas, regra da banda, cesto por banda) |
| `src/experiments_v33.py`, `src/report_v33.py`, `src/fetch_v33.py` | v3.3: acções tokenizadas da Coinbase como pernas (opções A/B/C ao fim-de-semana, maxStaleness, split da NVDA, combinações) |
| `src/t7_stables.py`, `src/t7_sim.py` | v3 · T7: inventário de descolamentos, D_rec e tecto; stable de entrada e stable como perna 3 |
| `config/feeds.json` | feeds escolhidos (gerado por `src/feeds_config.py`) |
| `data/series/` | séries usadas, com a idade da ronda lida em cada tick |
| `data/series/hourly_exchange/`, `hourly_feeds/` | velas horárias e feeds hora a hora à volta dos 7 episódios (§2.10) |
| `data/series/v3/` | v3: feeds da Base, registo on-chain do executor, X (VIRTUAL, COMP, AERO), DefiLlama horário |
| `data/series/v3/stables/` | v3 · T7: registo e preços diários de todas as stablecoins em USD (DefiLlama), rondas Chainlink, velas |
| `data/series/v31/` | v3.1: registo `tokenUsdFeeds` do executor da Base para todas as pernas |
| `data/series/v33/` | v3.3: lista oficial da Coinbase, rondas dos 13 feeds «Coinbase X» (Base) e de 9 feeds NYSE (Arbitrum), DefiLlama horário, sessões da NYSE |
| `data/series/v32/` | v3.2: registo `tokenUsdFeeds` para as stables (USDT, DAI, EURC e as não registadas), rondas USDT/USD e DAI/USD da Base e DAI/USD de Ethereum |
| `results/`, `results/v3/`, `results/v31/`, `results/v32/`, `results/v33/` | uma linha por posição × estratégia, com o cenário completo (os ficheiros grandes da v3 em `.csv.gz`) |
| `charts/` | SVG + CSV do que cada gráfico desenha; G1–G3 são da v3 |
| `_inputs/`, `_inputs_v3/` | ficheiros do repo usados para cruzar endereços (commit em `SOURCE_COMMIT.txt`) |
