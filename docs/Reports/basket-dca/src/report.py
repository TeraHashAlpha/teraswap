"""Build RESULTS-2026-11.md (repo) and the HTML report from the computed results."""
import os, sys, json, datetime as dt, numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import experiments as ex, series as S, scenarios as sc
from docmodel import Doc, to_md, to_html_body
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

PT_M = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez']
def f(x, d=1):
    if x is None or (isinstance(x, float) and np.isnan(x)): return '—'
    if abs(x) < 0.5 * 10 ** (-d): x = 0.0
    s = f'{x:,.{d}f}'.replace(',', ' ').replace('.', ',')
    return s.replace('-', '−')
def pct(x, d=1): return f(x, d) + '%'
def pp(x, d=1): return ('0' if abs(x) < 1e-9 else f(x, d)) + ' pp'
def usd(x, d=0): return f(x, d) + ' USD'
def dev_str(x): return '0' if x < 1e-9 else f(x, 2)
def dmy(d): t = pd.Timestamp(d); return f'{t.day} {PT_M[t.month-1]} {t.year}'
def mmm(s): return f'mín {f(s.min(),1)} · med {f(s.median(),1)} · máx {f(s.max(),1)}'

def build(out):
    d = Doc(); now = dt.date(2026, 11, 7)
    d21, d22, d23, d24, d25 = out['2.1'], out['2.2'], out['2.3'], out['2.4'], out['2.5']
    d26, d27, q27, d28, d29 = out['2.6'], out['2.7'], out['2.7_quality'], out['2.8'], out['2.9']
    ws = ex.stress_windows(); months = out['months']
    band = ex.stable_band_calibration(); stale = ex.feed_staleness()
    ver = pd.read_csv(os.path.join(S.SER, 'feed_verification.csv'))
    feeds = json.load(open(os.path.join(ROOT, 'config', 'feeds.json')))
    commit = open(os.path.join(ROOT, '_inputs', 'SOURCE_COMMIT.txt')).read().strip()

    allA = pd.concat([d21, d22, d23], ignore_index=True)
    A_all = allA[allA.strategy == 'A']; A0_all = allA[allA.strategy == 'A0']; B_all = allA[allA.strategy == 'B']
    d210 = out.get('2.10'); d211r = out.get('2.11_rolling'); d211 = out.get('2.11'); d211o = out.get('2.11_other')
    n_runs = sum(len(x) for x in (d21, d22, d23, d24, d25, d26, d27, d28, d210, d211r, out.get('2.12_raw')) if x is not None)
    a_max = float(pd.concat([A_all.deviation_pp, d24[d24.strategy == 'A'].deviation_pp,
                             d25[d25.dd_mode == 'soft'].deviation_pp]).max())
    a0_share = float((A0_all.deviation_pp > 0.01).mean() * 100); a0_max = float(A0_all.deviation_pp.max())
    a0_22 = d22[(d22.strategy == 'A0') & (d22.variant == 'base')]
    a0_22_share = float((a0_22.deviation_pp > 0.01).mean() * 100); a0_22_max = float(a0_22.deviation_pp.max())

    # 2.4
    c24 = d24[d24.strategy == 'A'].groupby(['n_cycles']).chosen_capital_pct.agg(['median', 'min', 'max'])
    c24c = d24[d24.strategy == 'A'].groupby(['n_cycles', 'range', 'cadence_d']).chosen_capital_pct.median().groupby(level=0).agg(['min', 'max'])
    c24c = c24c.rename(columns={'min': 0, 'max': 1}).apply(lambda r: pd.Series([r[0], r[1]]), axis=1)
    fin24 = d24[d24.strategy == 'A'].assign(excess=lambda x: x.final_tick_share_pct - 100 / x.n_ticks).excess.max()
    # 2.5
    d25 = d25.copy()
    d25['prot_events'] = d25[[f'protect_events_leg{j}' for j in range(3)]].sum(axis=1)
    d25['prot_ticks'] = d25[[f'protect_ticks_leg{j}' for j in range(3)]].sum(axis=1)
    d25['excess_final'] = d25.final_tick_share_pct - 100 / d25.n_ticks
    g25 = d25.groupby(['dd_threshold', 'dd_mode']).agg(
        trig=('prot_events', lambda s: (s > 0).mean() * 100), pt_med=('prot_ticks', lambda s: s[s > 0].median() if (s > 0).any() else 0),
        unin_med=('uninvested_pct', 'median'), unin_max=('uninvested_pct', 'max'),
        dev_max=('deviation_pp', 'max'), exc_med=('excess_final', 'median'), exc_max=('excess_final', 'max')).reset_index()
    def g(thr, mode, col): return float(g25[(g25.dd_threshold == thr) & (g25.dd_mode == mode)][col].iloc[0])
    REC_THR = 0.25
    def trig_w(thr):
        x = d25[(d25.dd_threshold == thr) & (d25.dd_mode == 'rigid')]
        return [w for w in ws if (x[x.window == w].prot_events > 0).any()]

    # 2.6
    A26 = d26[d26.strategy == 'A']
    def ev(e, var, rule, dd=None, split='33-33-33'):
        s = A26[(A26.event == e) & (A26.variant == var) & (A26.stable_rule == rule) & (A26.split == split)]
        s = s[s.dd_threshold.isna()] if dd is None else s[s.dd_threshold == dd]
        return s.iloc[0] if len(s) else None
    ust = S.raw('UST')

    # 2.7
    d27v = d27[~d27.get('missing', pd.Series(False, index=d27.index)).fillna(False).astype(bool)] if 'missing' in d27 else d27
    d27v = d27v[d27v.source != d27v.reference]
    d27v = d27v.assign(changed_pct=lambda x: 100 * x.decisions_changed / x.decision_ticks.clip(lower=1))

    def qa(tok, a, b, col):
        x = q27[(q27.token == tok) & q27.a.str.startswith(a) & (q27.b == b)]
        return float(x[col].iloc[0])
    def chg_rate(tok, src):
        x = d27v[(d27v.token == tok) & d27v.source.str.startswith(src)]
        return float(100 * x.decisions_changed.sum() / x.decision_ticks.sum())
    g9a = d29[(d29['mode'] == 'sem regra 9') & (d29.strategy == 'A')]
    fpc = float((g9a['max'] / g9a.n_ticks).max()); fpc_long = float((g9a[g9a.n_ticks >= 26]['max'] / g9a[g9a.n_ticks >= 26].n_ticks).max())
    def cmin(n, cad, col):
        x = g9a[(g9a.n_ticks == n) & (g9a.cadence_d == cad)]
        return float(x[col].iloc[0]) if len(x) else np.nan
    CA, CB = 'Cmin_max · rota canónica · gas de mercado', 'Cmin_max · rota agregador · gas de mercado'
    CC, CD = 'Cmin_max · rota canónica · tier actual do keeper (1,5 gwei)', 'Cmin_max · rota agregador · tier actual do keeper (1,5 gwei)'

    if d210 is not None:
        scan = out['2.10_scan']; fvw = out['2.10_feed']
        def sc_max(asset):
            x = scan[scan.asset == asset]; x = x[x.max_c2c_pct.abs() < 100]   # drop bad prints
            return float(x.loc[x.max_c2c_pct.abs().idxmax(), 'max_c2c_pct'])
        def fv_rng(ep): return float(fvw[fvw.episode == ep].feed_range_pct.iloc[0])
        n210 = int((d210.strategy == 'A').sum())
        def wr_(dur, cad, reg, col):
            x = d211[(d211.duration == dur) & (d211.cadence_d == cad) & d211.regime.str.startswith(reg)]
            return float(x[col].iloc[0])

    L_has_new = d210 is not None
    # ============================================================ header
    d.h1('Basket DCA — modelação v2 (RESULTS-2026-11)')
    d.p(f'**Da Analista para o Arquitecto, o Auditor e o dono.** Gerado a {dmy(now)} por `python3 run_all.py`. '
        f'Responde ao pedido `ANALISTA-basket-dca-modelacao-v2-2026-11-07.md` (rev. 2) sobre a definição em '
        f'`claude/basket-dca-definicao-mecanismo.md` (regras 1–9, regra 3 corrigida). '
        f'**Só cenários reais**: cada número vem de uma janela histórica concreta, com os preços que os feeds Chainlink '
        f'publicaram de facto, lidos às 00:00 UTC — e, na §2.10, hora a hora nos movimentos bruscos dos últimos 5 anos. Nenhuma série sintética, nenhum choque inventado. '
        f'{f(n_runs,0)} simulações; o script, as séries e todos os CSV estão neste directório.')
    d.callout('Como ler este relatório. Há duas coisas que nunca se misturam:\n'
              '**(a) O que o mecanismo garante** — que o capital é repartido exactamente como o utilizador pediu. É uma propriedade das regras, medida aqui em pontos percentuais de desvio.\n'
              '**(b) O que aconteceu ao valor da posição** — histórico, para documentar comportamento. Nunca é promessa, nunca é argumento de venda, e aparece sempre separado de (a).')

    # ============================================================ the 6 answers
    d.h2('As oito respostas e a conclusão' if L_has_new else 'As seis respostas', 'respostas')
    d.answers([
        ('0% de desvio confirmado em todas as janelas, incluindo as de stress?',
         f'**Sim.** Em {f(len(A_all) + len(d24[d24.strategy=="A"]) + len(d25[d25.dd_mode=="soft"]),0)} posições do Basket DCA (2.1–2.5, sem regra 9 ou com regra 9 em modo suave) o desvio máximo foi '
         f'{"menor que 10⁻¹² pp" if a_max < 1e-12 else f"{a_max:.1e} pp"} — erro de vírgula flutuante, zero na prática. Inclui as 7 janelas de stress (Terra/Luna, FTX, SVB, yen carry, Q1 2025, a pior queda de 2025-26 e a subida violenta de Jul 2022). '
         f'Com a regra 3 original o defeito de Julho reaparece com dados novos: desvio em {pct(a0_share,0)} das posições, até {pp(a0_max)} '
         f'(nas 48 posições-âncora: {pct(a0_22_share,0)}, até {pp(a0_22_max)}; Julho tinha medido 77% e 23,3 pp). '
         f'**Excepção legítima**: em modo rígido o desvio existe por desenho, porque há capital que fica por investir (§2.5).'),
        ('Mínimo de ciclos',
         f'**6 ciclos como mínimo; 12 ou mais para a selecção pesar.** A premissa do §7.4 não se confirma: com a regra 3 corrigida a liquidação final nunca domina sem regra 9 — o último ciclo gasta ≈ 1/N do capital, como qualquer outro (excesso máximo {pp(fin24,1)}). '
         f'O que se perde com poucos ciclos é escolha. A parte do capital decidida com ≥ 2 pernas elegíveis (mediana por cadência) vai de {pct(c24c.loc[6].min(),0)}–{pct(c24c.loc[6].max(),0)} com 6 ciclos a {pct(c24c.loc[12].min(),0)}–{pct(c24c.loc[12].max(),0)} com 12, '
         f'{pct(c24c.loc[26].min(),0)}–{pct(c24c.loc[26].max(),0)} com 26 e {pct(c24c.loc[52].min(),0)}–{pct(c24c.loc[52].max(),0)} com 52. A curva é suave, sem degrau; a partir de 12 ciclos pelo menos três quartos do capital passam por uma decisão real em todas as cadências testadas. '
         f'**A liquidação final domina, sim, mas por outra causa: a regra 9 em modo suave** (§2.5) — e aí o número de ciclos não ajuda.'),
        ('Limiar inicial recomendado e modo a sugerir no texto',
         f'**Limiar inicial: 25%.** Nas janelas de stress disparou em {pct(g(REC_THR,"rigid","trig"),0)} das posições — em {", ".join(trig_w(REC_THR))} e nunca em {" nem ".join(w for w in ws if w not in trig_w(REC_THR))}. '
         f'Com 10–15% dispara em metade das posições, incluindo correcções normais, e no modo rígido chega a deixar {pct(g(0.10,"rigid","unin_max"),0)} do capital parado. '
         f'**Modo: nenhum por defeito** (decisão do dono), mas o texto tem de dizer o que cada um custa, com números: o rígido deixou por investir até {pct(g(REC_THR,"rigid","unin_max"),0)} (mediana {pct(g(REC_THR,"rigid","unin_med"),0)}); '
         f'o suave cumpre sempre a divisão mas **adia e concentra**: chegou a comprar {pct(g(REC_THR,"soft","exc_max") ,0)} do capital acima do normal num único último ciclo. Texto proposto no §2.5.'),
        ('Regra para o depeg',
         f'**Perna stable inelegível sempre que o feed se afaste mais de 1% do peg (|preço − 1| > 0,01), independentemente do limiar do utilizador — e também na liquidação final, mesmo em modo suave.** '
         f'Nos 1 803 ticks diários de 2021-12 a 2026-11 a banda de 1% só disparou no depeg real do USDC (12 Mar 2023) e nunca na USDT: zero falsos positivos. '
         f'A regra 9 sozinha não chega (limiar ≥ 10% contra um feed que no tick diário marcou 0,968). E há um efeito pior que o depeg em si: a regra 9 nas pernas voláteis **empurra o orçamento para a stable**. '
         f'O caso que fecha a questão é real: no colapso da UST, sem regra, a perna de 33% encheu-se de UST a {f(ev("UST-2022","±30 d","sem regra")["stable_avg_price"],3)} USD de média; com a banda, a UST deixou de ser comprada no tick em que saiu da banda.'),
        ('A fase 2 pode abrir?',
         f'**Pode abrir para tokens com o perfil do AERO, com quatro condições; não como regra geral para qualquer token sem feed.** A garantia não depende do preço: 0% de desvio com qualquer fonte. '
         f'No AERO o DefiLlama (o que a fase 2 leria) seguiu a Coinbase de perto — mediana {f(qa("AERO","DefiLlama","Coinbase","median_bps"),1)} bps, máximo {f(qa("AERO","DefiLlama","Coinbase","max_bps"),0)} bps, nenhuma hora acima da tolerância de 300 bps — e a regra 4 tomou a mesma decisão em {f(100 - chg_rate("AERO","DefiLlama"),2)}% dos ciclos. '
         f'Dois avisos reais: o DefiLlama marcou o WETH da Base com +{f(qa("ETH","DefiLlama","Coinbase","max_bps"),0)} bps (+21%) a 29 Out 2026 21:00 UTC, que só o quórum apanha; e o feed AERO/USD da Chainlink (24 h, desvio de 0,5%) é **pior** para a regra 4 do que o DefiLlama — mudou {f(chg_rate("AERO","Chainlink"),0)}% das decisões face à bolsa. '
         'A CoinGecko, o segundo membro do quórum, não tem histórico sem chave, por isso o quórum completo ficou por medir. Condições no §2.7.'),
        ('Capital mínimo por posição',
         f'**Depende do número de ciclos, não da cadência: Cmín ≈ nº de fills × gas por fill ÷ 0,1%.** O Basket faz cerca de 1 fill por ciclo (máximo {f(fpc_long,2)} por ciclo em posições de 26+ ciclos; {f(fpc,2)} nas muito curtas), contra 3 do DCA fixo. '
         f'Ao gas de mercado na Base, pior caso observado: 30 ciclos diários → {usd(cmin(30,1,CA))} (rota canónica, 0,003 USD/fill) ou {usd(cmin(30,1,CB))} (rota agregador, 0,016 USD/fill); 90 ciclos diários → {usd(cmin(90,1,CA))} ou {usd(cmin(90,1,CB))}; 12 ciclos semanais → {usd(cmin(12,7,CA))} ou {usd(cmin(12,7,CB))}. '
         f'**Com o tier actual do keeper (1,5 gwei) nada disto fecha**: 30 ciclos diários pedem {usd(cmin(30,1,CC))} a {usd(cmin(30,1,CD))}. Corrigir o tier de gas por chain é pré-requisito do Basket, não um detalhe. Tabela no §2.9.'),
    ]+ ([] if d210 is None else [
        ('Ticks horários em movimentos bruscos (> 15% numa hora)',
         f'**Em 5 anos nunca houve uma hora em que o fecho do ETH, do BTC ou de uma stable curada mudasse mais de 15%** (máximos: ETH {f(sc_max("ETH"),1)}% a 3 Fev 2025 01:00 UTC, BTC {f(sc_max("BTC"),1)}%, USDC {f(sc_max("USDC"),1)}%). '
         f'Só dentro da hora (mínimo vs máximo da vela, confirmado em duas bolsas) houve 5 episódios em ETH/BTC; a UST também passou os 15% (stable não curada) e o USDC ficou nos 14,6%. '
         f'Corri **{f(n210,0)} posições com ticks horários, de 4 em 4 h e diários à hora do evento** à volta desses 7 episódios: o desvio do Basket continuou a ser zero em todas. '
         f'Um achado: **o feed Chainlink, que é o que o keeper lê, mostrou movimentos bem menores do que as bolsas** — no flash crash do BTC, {f(fv_rng("E1"),1)}% no feed contra ~20% na bolsa.'),
        ('Quantas vezes o Basket venceu os outros dois DCAs',
         f'**Contra o DCA fixo (mesma divisão) é quase moeda ao ar.** Em posições de 30 dias a começar em cada dia de Mar 2022 a Out 2026: em alta volatilidade o Basket acabou à frente em {pct(wr_("30d",1,"alta","A_beats_B"),0)} das vezes, em períodos normais em {pct(wr_("30d",1,"normal","A_beats_B"),0)}, com diferença mediana de {f(wr_("30d",1,"normal","median_A_minus_B_pct"),1)}% do capital. '
         f'**Contra o DCA só em ETH depende de o ETH subir ou cair**: venceu em {pct(wr_("30d",1,"ETH caiu","A_beats_C"),0)} das posições em que o ETH caiu e em {pct(wr_("30d",1,"ETH subiu","A_beats_C"),0)} das que subiu — é a stable a amortecer, não o mecanismo. '
         f'Ficou à frente dos dois ao mesmo tempo em {pct(wr_("30d",1,"alta","A_beats_both"),0)} (alta volatilidade) e {pct(wr_("30d",1,"normal","A_beats_both"),0)} (normal) das posições. Isto confirma o §11: vende-se o cumprimento da divisão, nunca desempenho.'),
    ]))
    if out.get('2.12') is not None:
        g12 = out['2.12']
        def s12(dur, sig, reg, col):
            x = g12[(g12.dur == dur) & (g12.sig == sig) & (g12.regime == reg)]; return float(x[col].iloc[0])
        d.callout('**Conclusão honesta.** O objectivo do Basket não é bater um DCA de um token: é comprar vários activos melhor do que comprá-los todos por igual em cada ciclo. Medido assim — contra o DCA fixo de 3 pernas, com a mesma divisão — o resultado é este:\n'
                  f'**1. A garantia é sólida.** A divisão pedida é cumprida em todas as janelas, horas e cadências testadas, com dados reais.\n'
                  f'**2. A melhoria de preço existe, mas é pequena e só em mercado normal.** Em períodos normais o Basket comprou o ETH e o BTC mais barato do que o DCA fixo em {pct(s12(30,"tick","normal","eth_cheaper"),0)} e {pct(s12(30,"tick","normal","btc_cheaper"),0)} das posições, e acabou com mais valor em {pct(s12(30,"tick","normal","win"),0)}. A diferença mediana é de {f(s12(30,"tick","normal","med"),2)}% do capital — da ordem da própria fee de 0,1%.\n'
                  f'**3. Em alta volatilidade, quando o utilizador mais espera que «comprar na queda» ajude, a vantagem desaparece**: {pct(s12(30,"tick","alta vol.","win"),0)} das posições à frente, mediana {f(s12(30,"tick","alta vol.","med"),2)}%. Numa queda contínua, o activo que mais caiu tende a continuar a cair.\n'
                  f'**4. Medir «o mais desvalorizado face aos outros» de forma mais directa não ajuda** (§2.12): comparar cada perna com a sua média ou com o preço de entrada melhora pouco em mercado normal e piora em alta volatilidade, com perdas maiores nas caudas.\n'
                  '**5. O que o Basket tem de real e mensurável**: cumpre a divisão, faz cerca de 1 compra por ciclo em vez de 3 (um terço do gas), e tem protecções (regra 9, banda de peg) que um DCA fixo não tem. Isto pode ser dito ao utilizador. Que compra «na melhor altura» ou «mais barato», não.')
    return d, locals()

def body(d, L):
    globals().update({k: v for k, v in L.items() if k not in ('d',)})
    out = L['out']
    # ============================================================ 0. data
    d.h2('0. Dados e método', 'dados')
    d.p('**Tick.** Cada ciclo lê o preço às 00:00 UTC do dia. O valor é a resposta da última ronda com `updatedAt ≤ T` — exactamente o que `latestRoundData()` devolveria a um keeper que lesse o proxy nesse instante. As rondas são lidas com `getRoundData((phaseId << 64) | roundId)` sobre o estado actual (os agregadores guardam todas as rondas), sem nó de arquivo.')
    d.p(f'**Endereços.** Nenhum foi escrito à mão. Cada feed é escolhido por código no directório oficial da Chainlink (entrada canónica com nome ENS, não escondida), cruzado por igualdade calculada com o repo (`dca-feed-registrations.json`, `chainlink-feeds.ts`, `constants.ts` no commit `{commit[:12]}`) e verificado on-chain por `description()` e `decimals()` antes de qualquer leitura (regra do ADR-018). **{int(ver.descriptionMatches.sum())}/{len(ver)} feeds confirmaram a identidade.**')
    rows = []
    for _, r in ver.iterrows():
        fd = feeds.get(r.key, {})
        rows.append([r.key, r.network, f'`{r.proxy}`', r.description, r.decimals, fd.get('heartbeat', '—'),
                     'sim' if fd.get('inRepo') else 'só directório'])
    d.table(['Série', 'Rede', 'Proxy', 'description()', 'dec.', 'heartbeat (s)', 'no repo'], rows,
            'Feeds usados — verificação on-chain (data/series/feed_verification.csv)')
    d.p('**Uma fonte por perna e por posição, nunca misturada dentro da posição.** Prioridade, primeira que cobre a posição inteira:')
    d.ul(['**Perna BTC**: cbBTC/USD (Base, existe desde 13 Set 2024) → WBTC/USD (Arbitrum, desde 25 Nov 2022) → WBTC/BTC × BTC/USD (Ethereum, a composição que o próprio repo usa em mainnet). **Nunca BTC spot em silêncio**: a coluna «fontes» de cada CSV diz qual foi usada.',
          '**SOL, CRV**: feed Arbitrum (desde 15 Fev 2022) → feed Ethereum. **XRP**: feed Arbitrum (desde 25 Ago 2022) → vela diária da Bitstamp (abertura 00:00 UTC), declarada como fonte de exchange — a Coinbase teve o XRP suspenso de Jan 2021 a Jul 2023.',
          '**ETH, USDC, USDT, DAI**: feeds Arbitrum. **UST** (caso extra do §2.6): USTC/ETH × ETH/USD na Ethereum.',
          '**Fase 2 (§2.7)**: DefiLlama `coins.llama.fi/chart` (a perna DefiLlama do quórum do keeper, historicamente), Coinbase Exchange (velas horárias) e o feed AERO/USD da Chainlink na Base, que existe mas o TeraSwap não regista.'])
    d.p('**Escolhas de modelação** (iguais em todas as estratégias): capital de 1 000 USD por posição (o desvio é independente da escala); orçamento por ciclo = C/N; um ciclo sem pernas elegíveis é saltado e o dinheiro espera (ADR-024: «skip the cycle, never the order»); variação da regra 4 = preço(t)/preço(t−1 cadência) − 1, e no tick 0 contra o preço de uma cadência antes; cooldown da regra 5 só na perna vencedora primária; compras ao preço do feed no tick, sem slippage nem fee (a garantia testada é a divisão em USD, que não depende do preço de execução).')

    # ============================================================ 1
    d.h2('1. Base de comparação', 'base')
    d.p('Cada cenário corre quatro estratégias no mesmo capital, na mesma janela e na mesma cadência:')
    d.ul(['**A — Basket DCA**: regras 1–9 com a regra 3 corrigida.',
          '**A0 — regra 3 original** (Julho): o ciclo inteiro vai para a vencedora, sem rolar o remanescente; a liquidação final ainda respeita o cooldown. Só existe para mostrar o defeito com dados novos.',
          '**B — DCA fixo por 3 pernas**: cada ciclo compra as três na proporção, sem selecção. É o «outro produto» do §8 fase 3.',
          '**C — DCA simples em ETH**, como referência. O desvio de C face à repartição não se aplica (é 100 − w(ETH) por construção).'])

    # ============================================================ 2.1
    d.h2('2.1 Janelas de stress', 'stress')
    e = S.raw('ETH'); v = sc.rolling_vol30()
    rows = []
    for k, (a, b, lab) in ws.items():
        sub = d21[d21.window == k]; A = sub[sub.strategy == 'A']; A0 = sub[sub.strategy == 'A0']
        w = e.loc[a:b]; lr_ = np.log(e / e.shift(1)).loc[a + pd.Timedelta(days=1):b]; vv = lr_.std() * np.sqrt(365) * 100
        src = sorted(set(A.sources.str.split(' \\| ').str[1]))
        rows.append([k, lab, f'{dmy(a)} – {dmy(b)}', pct((w.min() / w.iloc[0] - 1) * 100, 0), pct(vv, 0),
                     '; '.join(s.replace('Chainlink ', '') for s in src), len(A), dev_str(A.deviation_pp.max()),
                     f'{(A0.deviation_pp > .01).mean()*100:.0f}% · {f(A0.deviation_pp.max(),1)}'])
    d.table(['#', 'Janela', 'Datas (UTC)', 'ETH mín. vs início', 'Vol. realizada (anual.)', 'Perna BTC', 'Posições', 'Desvio A máx. (pp)', 'A0: % com desvio · máx. pp'],
            rows, 'Cada janela × 4 repartições × cadência diária e semanal × (janela inteira, 30 dias a partir do pior dia de ETH)', num_cols=[3, 4, 6, 7])
    s6 = ws['S6']; s7 = ws['S7']
    d.p(f'**S6** escolhida por código: maior queda de ETH com o fundo até 30 dias depois do pico, picos entre 1 Mai 2025 e 6 Nov 2026 — {s6[2]}. Janela = do pico a 30 dias depois. '
        f'**S7** acrescentada pelo critério do pedido: é a janela de 30 dias com a maior volatilidade realizada fora de S1–S6 ({pct(v.loc["2022-07-28"],0)} anualizada, 29 Jun – 28 Jul 2022), acima de S3, S4, S5 e S6. '
        'Nenhuma janela fora de S1–S6 supera S1 e S2. S7 tem uma vantagem: é volatilidade **a subir** (ETH +50% no mês), um regime que as outras não testam. '
        'A volatilidade da tabela é a das rentabilidades diárias dentro de cada janela.')
    d.chart('T1-divisao-cumprida', 'Gráfico T1 · A divisão pedida é a divisão obtida, nas 112 posições de stress; a regra 3 original espalha-se à volta do alvo')
    d.chart('T2-para-onde-foi-cada-ciclo', 'Gráfico T2 · Para onde foi cada ciclo em S1 (Terra/Luna + Celsius): uma compra por ciclo, dividida só quando a vencedora atinge o alvo')
    # value table (b)
    d.h3('O que aconteceu ao valor (histórico, não é promessa)')
    rows = []
    for k in ws:
        sub = d21[(d21.window == k) & (d21.duration == 'janela') & (d21.cadence_d == 1)]
        r = [k]
        for st in ('A', 'B', 'C'):
            x = sub[sub.strategy == st].final_value / 10 - 100
            r.append(f'{f(x.min(),1)} / {f(x.median(),1)} / {f(x.max(),1)}')
        dd_ = sub[sub.strategy == 'A'].max_drawdown_pct
        r.append(f(dd_.median(), 1)); rows.append(r)
    d.table(['#', 'A — Basket (%)', 'B — DCA fixo (%)', 'C — só ETH (%)', 'A: drawdown máx. mediano (%)'], rows,
            'Variação do valor da posição no fim da janela inteira, cadência diária · mín / mediana / máx sobre as 4 repartições', num_cols=[4])
    d.p('A e B ficam sempre perto um do outro, porque as duas compram a mesma divisão; a diferença está em **quando** cada perna é comprada. O gráfico T4 mostra que essa diferença não tem sinal fixo: o Basket pagou em mediana um pouco mais pelo ETH e um pouco menos pelo BTC do que o DCA fixo. **Isto confirma a nota de linguagem do §11: o mecanismo garante a repartição, não um preço melhor.**')
    d.chart('T4-preco-medio-A-vs-B', 'Gráfico T4 · Preço médio pago pelo Basket face ao DCA fixo, posição a posição — histórico, sem sinal fixo')

    # ============================================================ 2.2
    d.h2('2.2 Reprodução de Julho com dados actuais (âncora)', 'ancora')
    d.p('Os três meses de maior volatilidade realizada de ETH em cada ano, recalculados com as séries novas:')
    d.table(['Ano', 'Meses (vol. anualizada)'], [[y, ', '.join(f'{PT_M[m-1]} ({vol:.0f}%)' for (yy, m, vol) in months if yy == y)] for y in (2022, 2023, 2024, 2025)])
    rows = []
    for var, lab in [('base', 'ETH + BTC + USDC (48 posições-âncora)'), ('USDT', 'ETH + BTC + USDT'), ('ciclos-curtos-5', 'Ciclos curtos: posições de 5 ticks diários'),
                     ('SOL', 'ETH + SOL + USDC'), ('XRP', 'ETH + XRP + USDC'), ('CRV', 'ETH + CRV + USDC')]:
        sub = d22[d22.variant == var]
        miss = int(sub.get('missing', pd.Series(dtype=bool)).fillna(False).sum()) if 'missing' in sub else 0
        A = sub[sub.strategy == 'A']; A0 = sub[sub.strategy == 'A0']
        if A.empty: rows.append([lab, 0, '—', '—', '—', f'{miss} sem dados']); continue
        rows.append([lab, len(A), dev_str(A.deviation_pp.max()), pct((A0.deviation_pp > .01).mean() * 100, 0), f(A0.deviation_pp.max(), 1),
                     '; '.join(sorted({s for x in A.sources for s in x.split(' | ')} - {'Chainlink ETH/USD · Arbitrum', 'Chainlink USDC/USD · Arbitrum'})).replace('Chainlink ', '') + (f' · {miss} sem dados' if miss else '')])
    d.table(['Variante', 'Posições A', 'Desvio A máx. (pp)', 'A0 com desvio', 'A0 desvio máx. (pp)', 'Fontes da 2.ª/3.ª perna'], rows, num_cols=[1, 2, 3, 4])
    a0p = d22[(d22.strategy == 'A0') & d22.variant.isin(['base', 'USDT', 'SOL', 'CRV', 'XRP'])].pivot_table(index=['month', 'split'], columns='variant', values='deviation_pp')
    spread = (a0p.max(axis=1) - a0p.min(axis=1))
    d.p(f'**Confirmado**: 0% de desvio em todas as variantes com a regra 3 corrigida. **O defeito de Julho reproduz-se**: nas 48 posições-âncora a regra original desvia em {pct(a0_22_share,0)} delas, até {pp(a0_22_max)} (Julho: 77%, 23,3 pp). '
        f'**O defeito é sobretudo aritmético, não de mercado**: o excesso nasce de o último pagamento de cada perna valer um orçamento inteiro, e depende de w × N. Trocar as pernas quase não o muda (diferença entre variantes na mesma posição: mediana {pp(spread.median(),1)}, máximo {pp(spread.max(),1)}). '
        'O máximo de 23,3 pp de Julho não se reproduz com posições mensais diárias; aparece, e é ultrapassado, nas posições curtas (até ' + pp(d22[(d22.strategy=="A0")&(d22.variant=="ciclos-curtos-5")].deviation_pp.max(),1) + ') e semanais (§2.3). A definição exacta das posições de Julho perdeu-se com os ficheiros originais.')

    # ============================================================ 2.3
    d.h2('2.3 Janela recente (Jul–Out 2026)', 'recente')
    rows = []
    for dur in ('30d', '60d', '90d'):
        for cad in (1, 7):
            sub = d23[(d23.duration == dur) & (d23.cadence_d == cad)]; A = sub[sub.strategy == 'A']; A0 = sub[sub.strategy == 'A0']
            rows.append([dur.replace('d', ' dias'), 'diária' if cad == 1 else 'semanal', len(A), dev_str(A.deviation_pp.max()),
                         pct((A0.deviation_pp > .01).mean() * 100, 0), f(A0.deviation_pp.max(), 1), f(A.n_fills.median(), 0)])
    d.table(['Duração', 'Cadência', 'Posições A', 'Desvio A máx. (pp)', 'A0 com desvio', 'A0 máx. (pp)', 'Fills A (mediana)'], rows,
            'Uma posição a começar em cada dia de 1 Jul a 15 Out 2026, terminando até 6 Nov 2026 · ETH + cbBTC + USDC · 4 repartições', num_cols=[2, 3, 4, 5, 6])
    d.p('Com o mercado de agora o comportamento é o mesmo: 0% de desvio. A regra original falha sobretudo em cadência semanal, onde cada ciclo pesa mais.')
    d.chart('N2-desvio-por-estrategia', 'Gráfico N2 · Dispersão do desvio final por estratégia, em todas as posições de 2.1, 2.2 e 2.3')
    return d

def body2(d, L):
    globals().update({k: v for k, v in L.items() if k not in ('d',)})
    # ============================================================ 2.4
    d.h2('2.4 Cadência e duração', 'ciclos')
    A = d24[d24.strategy == 'A']
    rows = []
    for rng in ('S5', '2.3'):
        for cad in (1, 3, 7):
            r = [('S5 (Fev–Abr 2025, stress)' if rng == 'S5' else 'Jul–Out 2026 (calma)'), f'{cad} d']
            for n in (6, 12, 26, 52):
                s = A[(A.range == rng) & (A.cadence_d == cad) & (A.n_cycles == n)]
                r.append('não cabe nos dados' if s.empty else f'{f(s.chosen_capital_pct.median(),0)}% ({f(s.chosen_capital_pct.min(),0)}–{f(s.chosen_capital_pct.max(),0)}) · n={len(s)}')
            rows.append(r)
    d.table(['Janela de início', 'Cadência', '6 ciclos', '12 ciclos', '26 ciclos', '52 ciclos'], rows,
            'Parte do capital decidida com ≥ 2 pernas elegíveis · mediana (mín–máx) · 33-33-33 · uma posição a começar em cada dia da janela')
    d.p(f'**A pergunta mudou de natureza.** O §7.4 dizia que abaixo de ~6 ciclos «a liquidação final domina». Com a regra 3 corrigida isso não acontece: cada ciclo gasta o orçamento inteiro (rolando o remanescente), por isso o último ciclo compra ≈ 1/N, como qualquer outro — o excesso máximo observado foi {pp(fin24,1)}. '
          'A liquidação final só domina quando há ciclos saltados, e isso é obra da regra 9 (§2.5), não do número de ciclos. '
          'O que o número de ciclos controla é a **margem de escolha**: nos últimos ciclos as pernas já trancaram e a compra é forçada. Daí a recomendação: 6 ciclos como mínimo, 12 ou mais para a selecção pesar.')
    d.chart('E1-escolha-vs-ciclos', 'Gráfico E1 · Capital decidido por escolha real, por nº de ciclos e cadência')

    # ============================================================ 2.5
    d.h2('2.5 Regra 9 — limiar e modo', 'regra9')
    rows = []
    for thr in (0.10, 0.15, 0.20, 0.25, 0.30):
        r = [f'{thr*100:.0f}%', pct(g(thr, 'rigid', 'trig'), 0), f(g(thr, 'rigid', 'pt_med'), 0)]
        r += [f'{f(g(thr,"rigid","unin_med"),1)} / {f(g(thr,"rigid","unin_max"),1)}', f(g(thr, 'rigid', 'dev_max'), 1)]
        r += [f'{f(g(thr,"soft","exc_med"),1)} / {f(g(thr,"soft","exc_max"),1)}', dev_str(g(thr, 'soft', 'dev_max'))]
        rows.append(r)
    d.table(['Limiar', 'Posições onde disparou', 'Ticks protegidos, quando dispara (mediana)', 'Rígido: por investir % (med/máx)', 'Rígido: desvio máx. pp',
             'Suave: compra extra no último ciclo % (med/máx)', 'Suave: desvio máx. pp'], rows,
            'S1–S7 × 4 repartições × diária/semanal × (janela, 30 d após o pior dia) = 112 posições por linha e por modo', num_cols=[1, 2, 3, 4, 5, 6])
    d.chart('N3-limiar-x-modo', 'Gráfico N3 · Mapa limiar × modo, uma linha por janela de stress')
    d.p('**O achado mais importante desta secção é sobre o modo suave.** «Suave» não quer dizer «protecção leve». Quer dizer: deixa de comprar enquanto a perna está protegida e **compra tudo de uma vez no último ciclo**. Em S1 com limiar de 20%, a posição comprou USDC nas primeiras semanas, ficou parada e no último dia comprou mais de metade do capital em ETH e WBTC, com o ETH 60% abaixo da entrada (gráfico N1). A divisão é cumprida ao cêntimo; o preço desse último dia é o que calhar.')
    d.chart('N1-caminho-da-reparticao-S1-suave', 'Gráfico N1 · Caminho da repartição em S1, modo suave, limiar 20%: preço face à entrada, compras por ciclo e convergência para o alvo, com cooldown (regra 5), lock (regra 6) e protecção (regra 9)')
    d.chart('T3-proteccao-S1-rigido', 'Gráfico T3 · A mesma posição em modo rígido: a protecção pára as compras e o capital fica por investir')
    d.p(f'**Recomendação: valor inicial 25%.** É o ponto onde a protecção dispara nas quedas grandes ({pct(g(0.25,"rigid","trig"),0)} das posições, todas em S1, S2, S5 ou S6) e fica calada nas correcções e no ruído; com 10–15% dispara em metade das posições. Abaixo de 25% o custo cresce depressa no modo rígido (máximo por investir: {pct(g(0.10,"rigid","unin_max"),0)} com 10%, {pct(g(0.25,"rigid","unin_max"),0)} com 25%, {pct(g(0.30,"rigid","unin_max"),0)} com 30%).')
    d.p('**Texto proposto para a escolha do modo** (o utilizador escolhe, sem default):')
    d.callout('**Rígido** — Se uma perna cair mais do que o limiar face ao preço de entrada, deixamos de a comprar até recuperar, até ao fim. Pode ficar capital por investir, que continua na tua carteira. Nas quedas de 2022–2026, com limiar de 25%, ficou por investir até ' + pct(g(0.25, 'rigid', 'unin_max'), 0) + ' do capital.\n'
              '**Suave** — Pausamos as compras dessa perna enquanto estiver abaixo do limiar, mas no último ciclo completamos sempre a divisão que pediste. Isso pode significar comprar de uma só vez, ao preço desse dia, a parte que ficou adiada: nas mesmas quedas, até ' + pct(g(0.25, 'soft', 'exc_max'), 0) + ' do capital acima de um ciclo normal.')

    # ============================================================ 2.6
    d.h2('2.6 Depeg da perna stable — só eventos reais', 'depeg')
    rows = []
    for evk, (stable, a, b, lab) in ex.DEPEG_EVENTS.items():
        r0 = ev(evk, '±30 d', 'sem regra'); 
        if r0 is None: rows.append([lab, '—', '—', '—', '—', 'sem dados']); continue
        bB = d26[(d26.strategy == 'B') & (d26.event == evk) & (d26.variant == '±30 d') & (d26.split == '33-33-33')].iloc[0]
        h = band[(band.stable == stable) & band.scope.str.startswith('horário')]
        hmin = h.dates_outside.iloc[0] if len(h) else '—'
        r10 = ev(evk, '±30 d', 'sem regra', 0.10)
        rows.append([lab, f(r0.stable_min_tick_price, 4), hmin.replace('mín ', ''),
                     f'{f(r0.stable_bought_in_event_usd,1)} vs {f(bB.stable_bought_in_event_usd,1)}',
                     f(r10.stable_bought_in_event_usd, 1) if r10 is not None else '—',
                     f(r0.stable_avg_price, 3)])
    d.table(['Evento', 'Mín. no tick diário', 'Mín. horário do feed', 'USD na stable durante o evento: A vs B', '… A com regra 9 a 10%', 'Preço médio pago pela stable (A)'], rows,
            '33-33-33 · diária · posição de 30 d antes a 30 d depois do evento · capital 1 000 USD', num_cols=[1, 3, 4, 5])
    d.p('**O que os dados mostram.**')
    u0 = ev('UST-2022', '±30 d', 'sem regra'); u1 = ev('UST-2022', '±30 d', 'banda 1% · fim rígido')
    ue = pd.Timestamp(u0.end); ua = float(ust.loc[ust.index >= ue + pd.Timedelta(days=30)].iloc[0]) if len(ust.loc[ust.index >= ue + pd.Timedelta(days=30)]) else np.nan
    d.ul([f'**A hora do tick decide o que se vê.** O feed USDC/USD marcou 0,885 às 08:00 UTC de 11 Mar 2023, mas o tick das 00:00 só viu 0,968 (12 Mar). Um keeper que leia à hora errada compra USDC a 0,89 ou nem nota o depeg.',
          f'**A regra 4 compra a stable quando ela cai** — é «quem mais caiu». No USDC e na USDT a aposta correu bem porque o peg voltou em dias. Na UST não voltou: sem regra, a perna de 33% foi preenchida a {f(u0.stable_avg_price,3)} USD de média, e 30 dias depois do fim da posição a UST valia {f(ua,3)}.',
          '**A regra 9 empurra dinheiro para a stable.** Quando ETH e BTC ficam protegidos, a stable é a única elegível e recebe o orçamento. Com limiar de 10%, a compra de UST durante o colapso subiu de ' + f(u0.stable_bought_in_event_usd, 1) + ' para ' + f(ev("UST-2022", "±30 d", "sem regra", 0.10).stable_bought_in_event_usd, 1) + ' USD. As duas protecções interagem e a pior combinação é exactamente a do depeg.',
          '**A regra 9 com entry ≈ 1 só trava a stable com limiar ≤ 10% e no tick certo**: o USDC só esteve abaixo de 0,90 numa hora de todo o evento.'])
    rows = []
    for evk in ex.DEPEG_EVENTS:
        for var in ('±30 d', 'termina no pior tick'):
            r_ = [evk, var]
            for rule in ('sem regra', 'banda 1% · fim suave', 'banda 1% · fim rígido'):
                x = ev(evk, var, rule)
                r_.append('—' if x is None else f'{f(x.stable_bought_in_event_usd,1)} USD · méd. {f(x.stable_avg_price,3)} · por investir {f(x.uninvested_pct,1)}%')
            rows.append(r_)
    d.table(['Evento', 'Posição', 'Sem regra', 'Banda 1% · fim suave', 'Banda 1% · fim rígido (proposta)'], rows,
            'Antes/depois · USD comprados da stable durante o evento · preço médio da stable · capital por investir no fim · 33-33-33 · diária')
    d.table(['Stable', 'Âmbito', 'Leituras', 'Banda', 'Fora da banda', 'Quando / mínimo'],
            [[r.stable, r.scope, r.n, pct(r.band_pct, 1), r.ticks_outside, r.dates_outside or '—'] for _, r in band.iterrows()],
            'Calibração da banda: quantas leituras do feed ficaram fora de ±banda em torno de 1 (diário: falsos positivos; horário: o que um fill a essa hora veria)', num_cols=[2, 4])
    d.p('**Recomendação concreta (iv):**')
    d.ol(['**Banda de peg de 1%**: a perna stable é inelegível sempre que |preço do feed − 1| > 0,01, nos dois sentidos, independentemente do limiar e do modo escolhidos pelo utilizador. Nos 1 803 ticks diários de 2021-12 a 2026-11 a banda disparou só no depeg real do USDC; na USDT, nunca (zero falsos positivos). No contágio de Mai 2022 a USDT saiu da banda de 1% durante cinco horas (mínimo 0,978 às 07:00 UTC de 12 Mai); com 2% teria saído uma hora só.',
          '**Também na liquidação final, mesmo em modo suave**: uma stable fora da banda no último ciclo não é comprada; o remanescente fica por investir e o utilizador é avisado. É o único caso em que o modo suave não completa a divisão, e o caso UST mostra porquê.',
          '**Avaliar a banda na hora do fill**, com o feed da stable (USDC/USD e USDT/USD na Arbitrum actualizam a cada ~255 s desde 2026-Q2), e não num preço guardado no início do ciclo.',
          '**Para o Arquitecto**: uma stable bloqueada pela banda deve contar como «sem preço utilizável» para efeitos do ADR-024 (saltar a compra dessa perna), nunca como preço válido.'])
    d.chart('E2-depeg-stable', 'Gráfico E2 · Depeg da perna stable: preço no tick e USD comprados por ciclo, sem regra (cinzento) e com a banda (cor)')
    return d

def body3(d, L):
    globals().update({k: v for k, v in L.items() if k not in ('d',)})
    L = dict(L); L['d210'] = L['out'].get('2.10'); L['d211'] = L['out'].get('2.11'); L['d211o'] = L['out'].get('2.11_other'); L['d211r'] = L['out'].get('2.11_rolling')
    # ============================================================ 2.7
    d.h2('2.7 Qualidade do preço — feed vs quórum, com diferenças reais', 'fase2')
    d.p('**Token escolhido: AERO.** Entre os tokens do catálogo da Base sem feed registado no TeraSwap, o volume do catálogo é volume global da CoinGecko: AAVE, ZRO e CRV vêm à frente, mas o volume deles é quase todo noutras redes. O AERO é o de maior volume nativo da Base, e tem três séries reais independentes para triangular: DefiLlama (o que a fase 2 leria), Coinbase (bolsa) e um feed AERO/USD da Chainlink que existe na Base mas não está registado no executor. **ETH** serve de calibração, onde o feed é o que o keeper já usa.')
    rows = []
    for _, r in q27.iterrows():
        rows.append([r.token, f'{r.a} vs {r.b}', r.hours, f(r.median_bps, 1), f(r.p95_bps, 1), f(r.p99_bps, 1), f(r.max_bps, 0), r.worst_at[:16], r.n_over_100, r.n_over_300, f'{r.best_lag_h} h · ρ {f(r.corr_best,2)}'])
    d.table(['Token', 'Par de fontes', 'Horas', '|Δ| mediana (bps)', 'P95', 'P99', 'Máx.', 'Pior hora (UTC)', '> 100 bps', '> 300 bps', 'Desfasamento'], rows,
            'Hora a hora, 1 Jul – 6 Nov 2026 · DefiLlama alinhado à hora certa (±10 min) · Coinbase = abertura da vela horária · Chainlink = última ronda ≤ T', num_cols=[2, 3, 4, 5, 6, 8, 9])
    rows = []
    for tok in ('AERO', 'ETH'):
        for src in sorted(d27v[d27v.token == tok].source.unique()):
            s = d27v[(d27v.token == tok) & (d27v.source == src)]
            ref = s.reference.iloc[0]
            refp = d27[(d27.token == tok) & (d27.source == ref)][['start_day', 'duration', 'cadence_d', 'split', 'leg_avg_price_at_ref']]
            m = s.merge(refp, on=['start_day', 'duration', 'cadence_d', 'split'], suffixes=('', '_ref'))
            dp = (m.leg_avg_price_at_ref / m.leg_avg_price_at_ref_ref - 1) * 1e4
            rows.append([tok, f'{src} (referência: {ref})', len(s), f'{f(s.changed_pct.median(),0)}% / {f(s.changed_pct.max(),0)}%', dev_str(s.deviation_pp.max()), f'{f(dp.median(),1)} / {f(dp.abs().max(),0)}'])
    d.table(['Token', 'Fonte da decisão', 'Posições', 'Decisões da regra 4 que mudam (mediana / máx.)', 'Desvio máx. (pp)', 'Preço médio da perna vs referência, bps (mediana / máx. |Δ|)'], rows,
            'Posições da janela 2.3 (início diário 1 Jul–15 Out 2026; 30/60/90 d; diária/semanal; 4 repartições) · as compras são sempre valorizadas ao preço da referência', num_cols=[2, 4])
    d.p('**Leitura.**')
    d.ul(['**A garantia não depende da fonte**: 0% de desvio com qualquer das três séries. O que muda é **quando** cada perna é comprada.',
          f'**A fonte que muda decisões não é a que se esperava.** O DefiLlama e a Coinbase concordam o suficiente para a regra 4 escolher o mesmo em {f(100-chg_rate("AERO","DefiLlama"),2)}% dos ciclos do AERO. O feed AERO/USD da Chainlink, com heartbeat de 24 h e desvio de 0,5%, só actualiza quando o preço se move 0,5% — entre ticks parece parado — e por isso mudou {f(chg_rate("AERO","Chainlink"),0)}% das decisões face à bolsa. **Para a regra 4, «ter feed» não basta: conta a resolução do feed face à variação típica entre ticks.** Isto refina o critério de faseamento do §8.',
          f'No ETH, onde o feed tem desvio de 0,05%, o DefiLlama mudou {f(chg_rate("ETH","DefiLlama"),1)}% das decisões face ao feed e a Coinbase {f(chg_rate("ETH","Coinbase"),1)}%. O efeito no preço médio pago é pequeno e sem sinal fixo.',
          f'**A fonte da fase 2 teve um erro real**: às 21:00 UTC de 29 Out 2026 o DefiLlama marcou o WETH da Base a {f(L["out"]["al_eth"].loc["2026-10-29 21:00","DefiLlama (fase 2)"],2)} USD, com a Coinbase a {f(L["out"]["al_eth"].loc["2026-10-29 21:00","Coinbase"],2)} e o feed a {f(L["out"]["al_eth"].loc["2026-10-29 21:00","Chainlink"],2)} (+21%). Um keeper que decidisse com uma só fonte compraria a perna errada; o quórum de 300 bps do ADR-024 rejeitaria a leitura, se houver segunda fonte nesse instante.',
          '**O quórum real não pôde ser reconstruído**: a CoinGecko não serve histórico sem chave (HTTP 401). Medimos o membro DefiLlama contra referências independentes; o comportamento do par DefiLlama + CoinGecko fica por medir.'])
    d.p('**Resposta (v): pode abrir para tokens com o perfil do AERO, com quatro condições.** (1) A regra 4 da fase 2 decide com o preço de quórum do ADR-024 (≥ 2 fontes dentro de 300 bps), nunca com uma fonte só — é o quórum que apanha um erro como o de 29 Out. (2) Uma perna sem quórum num ciclo não entra na comparação desse ciclo: salta, em vez de usar o preço de uma fonte. (3) Validação por token antes de o abrir, com a mesma medição deste §: o AERO é líquido e tem referência de bolsa; um token sem bolsa de referência não ficou provado por este resultado. (4) Medir o quórum completo quando houver chave da CoinGecko. E uma nota para a fase 1: um feed Chainlink com desvio grosseiro (0,5%) não é automaticamente melhor input para a regra 4 do que um quórum off-chain.')
    d.chart('E3-quorum-vs-referencia', 'Gráfico E3 · DefiLlama face à Coinbase, hora a hora: AERO dentro da tolerância; ETH com um erro real de +21%')

    # ============================================================ 2.8
    d.h2('2.8 Três pernas voláteis, sem stable', 'tresvol')
    A8 = d28[d28.strategy == 'A']
    rows = []
    for bk in ('com stable', '3 voláteis'):
        s = A8[A8.basket == bk]
        if s.empty: rows.append([bk, 0, '—', '—', '—', '—']); continue
        wins = s[[f'wins_leg{j}' for j in range(3)]].sum(); tot = wins.sum()
        rows.append([('ETH + BTC + USDC' if bk == 'com stable' else 'ETH + BTC + SOL'), len(s),
                     ' / '.join(f'{w/tot*100:.0f}%' for w in wins), pct(s.leg2_bought_when_both_up_pct.median(), 0),
                     pct(s.winner_was_worst_mover_pct.median(), 0), f(s.max_drawdown_pct.median(), 1)])
    d.table(['Cesto (33-33-33)', 'Posições', 'Ciclos ganhos por perna (1/2/3)', 'Quando ETH e BTC sobem, a 3.ª perna é comprada em…', 'Vencedora = a que mais caiu', 'Drawdown máx. mediano (%)'], rows,
            'S2 (FTX, janela inteira e 30 d após o pior dia) e posições semanais de Jul–Out 2026 · diária e semanal', num_cols=[1, 3, 4, 5])
    d.p('Com uma stable, quando as duas voláteis sobem a stable ganha o ciclo: **o mecanismo compra liquidez quando o resto está caro**, um comportamento que se explica numa frase. Com três voláteis, nesse mesmo momento compra a volátil que subiu menos — passa a ser uma rotação de volatilidade, e o drawdown da posição cresce. A recomendação do §8 mantém-se: perna 3 restrita a stablecoins curadas.')

    # ============================================================ 2.9
    d.h2('2.9 Custo operacional', 'custo')
    g9 = d29[d29['mode'] == 'sem regra 9']
    rows = []
    for st in ('A', 'B'):
        for cad in (1, 7):
            for n in sorted(g9[(g9.strategy == st) & (g9.cadence_d == cad)].n_ticks.unique()):
                if n not in (5, 6, 12, 26, 30, 52, 60, 90): continue
                s = g9[(g9.strategy == st) & (g9.cadence_d == cad) & (g9.n_ticks == n)]
                if s.empty: continue
                s = s.iloc[0]
                rows.append([st, f'{cad} d', n, f'{f(s["median"],0)} / {f(s["max"],0)}', f(s['max'] / n, 2),
                             usd(s['Cmin_max · rota canónica · gas de mercado']), usd(s['Cmin_max · rota agregador · gas de mercado']),
                             usd(s['Cmin_max · rota canónica · tier actual do keeper (1,5 gwei)']), usd(s['Cmin_max · rota agregador · tier actual do keeper (1,5 gwei)'])])
    d.table(['Estr.', 'Cadência', 'Ciclos', 'Fills (med/máx)', 'Fills/ciclo (máx)', 'Cmín · canónica, gas mercado ($0,003)', 'Cmín · agregador, gas mercado ($0,016)', 'Cmín · canónica, tier keeper ($0,75)', 'Cmín · agregador, tier keeper ($3,93)'], rows,
            'Capital mínimo para a fee de 0,1% cobrir o gas da posição, no pior caso de fills observado · custos por fill do FILL-ECONOMICS-CALIBRATION (22 Jul 2026, Base)', num_cols=[2, 3, 4, 5, 6, 7, 8])
    fsz = pd.concat([L['out'][k] for k in ('2.1', '2.3')]); fsz = fsz[fsz.strategy == 'A']
    d.p(f'**Achado: fills pequenos.** A correcção da regra 3 cria compras parciais — o fecho do gap da vencedora e o remanescente rolado. Em capital de 1 000 USD a menor compra rolada observada foi {usd(fsz.min_roll_fill_usd.min(),2)}; numa posição de 100 USD seria dez vezes menor. O `DCA_MIN_CHUNK_USD` actual (1 USD por defeito) e o `MIN_ORDER_AMOUNT` (0,01 USDC) deixam passar fills que custam mais gas do que valem. **Proposta ao Arquitecto**: um mínimo por fill (p.ex. o maior entre o chunk mínimo e 10× o custo de gas da chain); um gap abaixo desse mínimo junta-se à compra seguinte dessa perna ou à liquidação final. O desvio continua garantido até esse resíduo.')
    d.p('**Nota de coerência**: a tabela (c) do FILL-ECONOMICS-CALIBRATION assume uma fee de 0,20%; o contrato V3 tem `FEE_BPS = 10` (0,1%) e o ADR-006 fechou 0,1% como invariante. Os números acima usam 0,1%.')
    d.chart('E4-capital-minimo', 'Gráfico E4 · Capital mínimo por posição ao gas de mercado, Basket vs DCA fixo')

    # ============================================================ 2.10
    if L.get('d210') is not None:
        d210 = L['d210']; scan = L['out']['2.10_scan']; hits = L['out']['2.10_hits']; fvw = L['out']['2.10_feed']
        import hourly_events as he
        d.h2('2.10 Movimentos bruscos numa hora — ticks horários', 'horario')
        d.p('**O pedido**: até aqui todos os ciclos liam o preço às 00:00 UTC. Esta secção acrescenta mais de 2 000 posições com ticks a outras horas, nos momentos dos últimos 5 anos em que ETH, BTC ou uma stable variaram mais de 15% numa hora.')
        d.p('**Primeiro, o que os dados dizem sobre esses momentos.** Li as velas horárias de 7 Nov 2021 a 7 Nov 2026 em duas bolsas por activo (Coinbase e Bitstamp; USDC só na Bitstamp, DAI só na Coinbase):')
        rows = []
        for _, r in scan.iterrows():
            bad = abs(r.max_c2c_pct) > 100
            rows.append([r.asset, r.venue.replace('_', ' '), f(r.hours, 0), (f(r.max_c2c_pct, 1) + '%' + (' (erro de cotação)' if bad else '')), r.at_c2c[:16],
                         (f(r.max_range_pct, 1) + '%' + (' (erro de cotação)' if r.max_range_pct > 100 else '')), r.at_range[:16], r.hours_c2c_over_15, r.hours_range_over_15])
        d.table(['Activo', 'Bolsa', 'Horas', 'Maior variação fecho→fecho', 'Quando (UTC)', 'Maior amplitude dentro da hora', 'Quando (UTC)', 'Horas > 15% fecho→fecho', 'Horas > 15% dentro da hora'], rows,
                'Velas horárias, Nov 2021 – Nov 2026 · amplitude = máximo ÷ mínimo da própria vela − 1', num_cols=[2, 3, 5, 7, 8])
        d.p('**Nunca, em 5 anos, o preço de fecho de ETH, BTC, USDC, USDT ou DAI mudou mais de 15% de uma hora para a outra.** O maior foi o ETH, −11,9% às 01:00 UTC de 3 Fev 2025. Os 15% só aparecem **dentro** da hora, entre o mínimo e o máximo da vela. Para contar como episódio exigi a amplitude acima de 15% numa bolsa e acima de 10% na outra; um pico numa bolsa só é tratado como erro de cotação (é o caso da USDT na Bitstamp, que chegou a «2 960 USD», e do BTC na Bitstamp a 24 Jan 2022). A UST não está nestas bolsas: usei o feed Chainlink USTC/ETH × ETH/USD hora a hora, que passou os 15% repetidamente a partir das 07:00 UTC de 11 Mai 2022. O USDC ficou nos 14,6% e entra assinalado, por ser o único caso numa stable curada.')
        rows = []
        for ep, (h, asset, lab, legs, strict) in he.EPISODES.items():
            fv_ = fvw[fvw.episode == ep].iloc[0]
            hx = hits[(hits.hour == pd.Timestamp(h)) & (hits.asset == asset)] if asset in ('ETH', 'BTC') else None
            ex_rng = f(hx.range_pct.max(), 1) + '%' if hx is not None and len(hx) else ('14,6% (Bitstamp)' if asset == 'USDC' else 'sem bolsa no conjunto')
            rows.append([ep, lab, h + ' UTC', ex_rng, f(fv_.feed_range_pct, 1) + '%', f(fv_.feed_hour_to_hour_pct, 1) + '%', fv_.feed.replace('Chainlink ', '')])
        d.table(['#', 'Episódio', 'Primeira hora acima do limiar', 'Amplitude na bolsa', 'Amplitude no feed (min. a min.)', 'Feed: hora seguinte vs esta', 'Feed lido'], rows,
                'O que a bolsa fez dentro da hora e o que o feed Chainlink — o preço que o keeper lê — mostrou na mesma hora', num_cols=[3, 4, 5])
        d.p('**O feed amortece os picos.** É a mediana de várias fontes e só actualiza quando o preço se afasta do limiar de desvio, por isso as mechas de uma bolsa quase não aparecem: no flash crash do BTC a bolsa fez ~20% e o feed ' + f(fvw[fvw.episode=="E1"].feed_range_pct.iloc[0],1) + '%. **Para o keeper, só a UST e o yen carry de Ago 2024 passaram os 15% dentro da hora.** Para o Basket isto é bom: a regra 4 compara o que o feed diz, não as mechas.')
        A = d210[d210.strategy == 'A']
        d.p(f'**As simulações.** À volta de cada episódio corri {f(len(A),0)} posições que contêm sempre a hora do evento como tick: cadência horária (24 e 72 ciclos), de 4 em 4 horas (30 e 60 ciclos) e diária (15 e 30 ciclos). Nas cadências de 4 h e diária o tick cai na primeira leitura depois do movimento. Cada posição corre nas 4 repartições e em 7 versões: A, A com regra 9 a 25% (suave e rígido), A com a banda de peg de 1%, A0, B e C — {f(len(d210),0)} simulações. Os preços são do feed Chainlink lido à hora certa.')
        rows = []
        for st in ['A', 'A · regra 9 25% suave', 'A · regra 9 25% rígido', 'A · banda peg 1%', 'A0', 'B']:
            x = d210[d210.strategy == st]
            rows.append([st, len(x), dev_str(x.deviation_pp.max()), pct((x.deviation_pp > .01).mean() * 100, 0), f(x.uninvested_pct.max(), 1),
                         f((x.final_tick_share_pct - 100 / x.n_ticks).max(), 1)])
        d.table(['Versão', 'Posições', 'Desvio máx. (pp)', 'Com desvio', 'Por investir máx. (%)', 'Compra a mais no último ciclo, máx. (%)'], rows,
                'Os 7 episódios juntos · capital 1 000 USD', num_cols=[1, 2, 3, 4, 5])
        e2a = d210[(d210.episode == 'E2') & (d210.strategy == 'A')].final_value.median(); e2b = d210[(d210.episode == 'E2') & (d210.strategy == 'A · banda peg 1%')].final_value.median()
        d.p(f'**A garantia aguenta com ticks a qualquer hora**: desvio zero no Basket e no modo suave, em todos os episódios e cadências. O modo rígido e a banda de peg deixam capital por investir, como devem. A banda volta a mostrar o seu valor na UST: valor mediano no fim de {f(e2b,0)} USD com a banda contra {f(e2a,0)} USD sem ela, por 1 000 investidos.')
        d.chart('E6-episodio-horario', 'Gráfico E6 · O episódio de 3 Fev 2025 visto hora a hora: o feed, as mechas da bolsa e o que uma posição horária comprou')

    # ============================================================ 2.11
    if L.get('d211') is not None:
        d211 = L['d211']; d211o = L['d211o']; d211r = L['d211r']
        d.h2('2.11 Quantas vezes o Basket acabou à frente dos outros dois DCAs', 'vitorias')
        d.p('**Definição.** «Venceu» = acabou a posição com mais valor (o que tem, ao preço do feed no último tick, mais o que ficou por investir), com o mesmo capital, a mesma janela e a mesma cadência. Diferenças abaixo de 0,01% do capital são empate. **É histórico, não é promessa** — e não é o que o mecanismo garante.')
        n_roll = int((d211r.strategy == 'A').sum())
        first = dmy(d211r.start_day.min())
        d.p(f'**Amostra para separar alta volatilidade de períodos normais**: uma posição a começar em cada dia de {first} a 6 Out 2026 (antes de {first} não há série WBTC legível para a perna BTC: o feed WBTC/BTC da Ethereum só tem rondas legíveis a partir de 30 Mar 2022), com 30 dias (diária) e 90 dias (diária e semanal), nas 4 repartições — {f(n_roll,0)} posições do Basket, cada uma contra B e C. Cada posição é classificada pela volatilidade realizada do ETH dentro dela: as 25% mais voláteis são «alta volatilidade», as restantes 75% «normal».')
        rows = []
        for _, r in d211.iterrows():
            dur = f'{r.duration.replace("d"," dias")} · {"diária" if r.cadence_d == 1 else "semanal"}'
            rows.append([dur, r.regime, int(r.n), pct(r.A_beats_B, 0), f(r.median_A_minus_B_pct, 2) + '%', f'{f(r.p5_A_minus_B_pct,1)} / {f(r.p95_A_minus_B_pct,1)}', pct(r.A_beats_C, 0), f(r.median_A_minus_C_pct, 1) + '%', pct(r.A_beats_both, 0)])
        d.table(['Posições', 'Regime', 'n', 'A > B', 'A − B mediana', 'A − B P5 / P95 (%)', 'A > C', 'A − C mediana', 'A > B e > C'], rows,
                'B = DCA fixo com a mesma divisão · C = DCA só em ETH · diferenças em % do capital · ETH+BTC+USDC', num_cols=[2, 3, 4, 5, 6, 7, 8])
        rows = [[r['sample'], int(r.n), pct(r.A_beats_B, 0), f(r.median_A_minus_B_pct, 2) + '%', pct(r.A_beats_C, 0), pct(r.A_beats_both, 0)] for _, r in d211o.iterrows()]
        d.table(['Amostra', 'n', 'A > B', 'A − B mediana', 'A > C', 'A > B e > C'], rows, 'As mesmas contas nas outras secções', num_cols=[1, 2, 3, 4, 5])
        d.chart('E5-quem-ficou-a-frente', 'Gráfico E5 · Em que parte das posições o Basket acabou à frente de B, de C e dos dois')
        d.p('**Leitura.**')
        d.ul(['**Basket vs DCA fixo (B) — é isto que mede o mecanismo**, porque as duas estratégias compram a mesma divisão. Em períodos normais o Basket ficou à frente um pouco mais de metade das vezes; em alta volatilidade, metade. A diferença mediana anda entre 0 e 0,3% do capital, e 90% das posições ficam entre cerca de −2,5% e +3%. **Não há vantagem sistemática.** Escolher «a que mais caiu» não compra mais barato de forma consistente.',
              '**Basket vs DCA só em ETH (C) — mede sobretudo a stable.** Quando o ETH cai, o Basket fica à frente na grande maioria das posições, porque tem parte do capital em USDC; quando o ETH sobe, o DCA só em ETH ganha quase sempre. É exposição, não habilidade.',
              f'**Nas outras amostras**: nas janelas de stress o Basket ficou à frente de B em {pct(float(d211o.iloc[0].A_beats_B),0)} das posições, mas são só {int(d211o.iloc[0].n)} e muito correlacionadas entre si; nos {f(int(d211o.iloc[1].n),0)} episódios horários, em {pct(float(d211o.iloc[1].A_beats_B),0)}; em Jul–Out 2026, em {pct(float(d211o.iloc[2].A_beats_B),0)}. Contra C, o resultado segue a direcção do ETH em cada episódio.',
              '**Consequência para o produto**: confirma a nota de linguagem do §11. O que se pode dizer ao utilizador é que a divisão pedida é cumprida e que nenhuma perna é comprada às cegas. Não se pode dizer que o Basket rende mais do que um DCA normal.'])

    # ============================================================ 2.12
    if L['out'].get('2.12') is not None:
        g12 = L['out']['2.12']; raw12 = L['out']['2.12_raw']
        d.h2('2.12 O sinal de selecção compra melhor? Quatro sinais comparados', 'sinal')
        d.p('**A pergunta certa** não é se o Basket bate um DCA só em ETH; é se, para quem quer vários activos, o mecanismo compra cada um numa altura melhor do que comprar os três por igual em cada ciclo. Para isolar o efeito do sinal, mantive a mecânica toda (regra 3 corrigida, cooldown, lock, liquidação final, sem regra 9) e só troquei o critério que escolhe a perna:')
        d.ul(['**tick** — a regra 4 actual: a que mais caiu desde o ciclo anterior.',
              '**média** — a que está mais abaixo da sua própria média desde o início da posição (a leitura mais directa de «mais desvalorizada face às outras»).',
              '**entrada** — a que está mais abaixo do seu preço de entrada.',
              '**rotação** — nenhum sinal: as pernas compram por turnos. Mostra o que é ruído.'])
        rows = []
        for dur in (30, 90):
            for sig in ('tick', 'media', 'entrada', 'rotacao'):
                for reg in ('normal', 'alta vol.'):
                    x = g12[(g12.dur == dur) & (g12.sig == sig) & (g12.regime == reg)].iloc[0]
                    rows.append([f'{dur} dias', {'tick': 'tick (actual)', 'media': 'média', 'entrada': 'entrada', 'rotacao': 'rotação'}[sig], reg, int(x.n),
                                 pct(x.win, 0), f(x.med, 2) + '%', f'{f(x.p5,1)} / {f(x.p95,1)}', f(x.eth_px, 2) + '% · ' + pct(x.eth_cheaper, 0), f(x.btc_px, 2) + '% · ' + pct(x.btc_cheaper, 0)])
        d.table(['Posição', 'Sinal', 'Regime', 'n', 'Acabou à frente de B', 'Diferença mediana (% capital)', 'P5 / P95', 'Preço médio ETH vs B · % posições mais barato', 'Preço médio BTC vs B · % posições mais barato'], rows,
                f'Uma posição por dia de {dmy(raw12.start.min())} a 6 Out 2026, cadência diária, ETH + BTC + USDC, 4 repartições · alta vol. = 25% mais voláteis · preço negativo = comprou mais barato do que o DCA fixo', num_cols=[3, 4, 5, 6, 7, 8])
        d.p('**Leitura.** A rotação fica nos 50% e perto de zero: é o ruído de base. O sinal actual (tick) acrescenta cerca de 5 a 8 pontos percentuais de vitórias e 0,1–0,2% no preço médio em mercado normal, e fica neutro em alta volatilidade. Os sinais de valorização relativa (média, entrada) são um pouco melhores em mercado normal e claramente piores em alta volatilidade, com caudas mais largas: são apostas mais fortes em que o preço volta para trás, e as quedas de 2022–2026 foram tendências. **Dos quatro, o sinal actual é o mais equilibrado e deve ficar.** A razão de fundo é estrutural: o mecanismo só escolhe quando cada perna é comprada dentro da janela, não quanto. ETH e BTC andam muito juntos, e qual deles caiu mais num dia pouco diz sobre o dia seguinte. O ganho possível é pequeno por construção.')

    # ============================================================ 3. charts
    d.h2('3. Os gráficos', 'graficos')
    d.p('**Os quatro gráficos de confiança de Julho não foram encontrados** (as páginas PT/EN de 30 Jul não estão em nenhuma pasta ligada). O registo só diz «4 gráficos de confiança». Refi-los com a função que esse nome descreve e com os dados novos:')
    d.ol(['**T1 · A divisão que pedes é a divisão que recebes** — por repartição e por perna, o alvo e o resultado de cada posição de stress; a regra original ao lado para mostrar o que a correcção resolve.',
          '**T2 · Para onde foi cada ciclo** — numa janela de stress, o que foi comprado em cada dia e em que perna. Mostra que não há «tudo de uma vez» sem regra 9.',
          '**T3 · A protecção a funcionar** — a mesma janela com a regra 9: o preço face à entrada, o limiar, os dias protegidos e as compras a parar.',
          '**T4 · O que pagaste** — o preço médio do Basket face ao DCA fixo, posição a posição, rotulado como histórico. Serve para não prometer o que o mecanismo não faz.'])
    d.p('Os três pedidos (**N1** caminho da repartição, **N2** dispersão do desvio, **N3** limiar × modo) estão nas secções respectivas. **Desvio ao pedido**: o N1 pedia o preço de ETH num eixo secundário; está num painel próprio por cima, com o mesmo eixo de tempo. Dois eixos verticais no mesmo gráfico inventam correlações (a escala de um é arbitrária face ao outro). Mais quatro: E1 (escolha vs ciclos), E2 (depeg), E3 (fase 2), E4 (capital mínimo). Cada SVG tem ao lado o CSV exacto do que desenha; passar o rato sobre uma marca mostra o valor.')

    # ============================================================ 4. not measured
    d.h2('4. O que não foi medido, e porquê', 'naomedido')
    d.ul(['**Quórum completo da fase 2 (DefiLlama + CoinGecko).** A CoinGecko devolve HTTP 401 a pedidos de histórico sem chave. Só o membro DefiLlama foi medido.',
          '**Preço de pool on-chain do AERO.** Exigiria um nó de arquivo (estado histórico das pools da Aerodrome); os RPCs públicos recusam (`missing trie node` / «archive requests require a token»). Substituído pela Coinbase e pelo feed AERO/USD da Chainlink.',
          '**Um depeg em que a stable curada nunca recupera.** Não existe janela real com USDC, USDT ou DAI. O caso da UST é real e mostra o mecanismo, mas a UST nunca seria uma stable curada.',
          '**Ticks intradiários com todas as pernas.** O horário só foi lido para as stables nas janelas de depeg e para AERO/ETH na janela 2.3. O efeito da hora do tick sobre ETH/BTC não foi medido.',
          '**Execução real** (slippage, rota, MEV, falhas do keeper, gas variável). As compras são ao preço do feed; o custo vem do relatório de calibração, não de execuções deste mecanismo.',
          '**Cadência e duração longas em 2.3**: 3 dias × 52 ciclos e 7 dias × 26/52 ciclos não cabem entre 1 Jul e 6 Nov 2026.',
          '**cbBTC antes de 13 Set 2024**: não existia. Antes disso a perna BTC é WBTC (Arbitrum desde 25 Nov 2022; antes, WBTC/BTC × BTC/USD na Ethereum), declarada posição a posição.',
          '**XRP antes de 25 Ago 2022**: sem feed nas redes usadas; vela diária da Bitstamp (exchange), declarada.',
          '**Horas com mais de 15% de fecho a fecho**: não existem nos 5 anos em ETH, BTC nem stables curadas. A §2.10 usa a amplitude dentro da hora, confirmada em duas bolsas.',
          '**WBTC em Dez 2021 (episódio E1)**: o feed WBTC/BTC da Ethereum não tem rondas legíveis antes de Mar 2022; a perna BTC desse episódio usa o feed BTC/USD, declarado na coluna de fontes.',
          '**O feed dentro da hora** foi lido minuto a minuto só na hora de cada evento e só no activo do evento.'])

    # ============================================================ 5. findings
    d.h2('5. Achados para o Arquitecto, fora do que foi pedido', 'achados')
    st = stale[stale.scope == 'desde 1 Jul 2026']
    d.ol(['**O modo suave concentra no último ciclo** (§2.5). Se o dono quiser manter o nome, o texto tem de dizer isto. Alternativa a avaliar: escalonar a liquidação da perna adiada pelos últimos k ciclos, em vez de a concentrar num.',
          '**A regra 9 nas voláteis empurra o orçamento para a stable** (§2.6). Em depeg é a pior combinação possível. A banda de 1% resolve.',
          '**Fills pequenos criados pela correcção da regra 3** (§2.9). Precisa de um mínimo por fill.',
          '**Frescura dos feeds vs ADR-024.** A regra 4 precisa de um preço para cada perna em cada ciclo. Com `MAX_PRICE_AGE_SEC = 600`, a leitura on-chain conta como ausente em muitos ticks: desde 1 Jul 2026, ' + '; '.join(f'{r.feed.replace("Chainlink ","")} {f(r.pct_over_600s,0)}%' for _, r in st.iterrows()) + '. Um feed que não actualizou está, por definição, dentro do seu limiar de desvio. Para a comparação da regra 4 o critério natural é o heartbeat do feed × 1,5 (a regra 9V da app), não os 600 s do piso. Decisão do Arquitecto.',
          '**USDC/USD e USDT/USD na Arbitrum só passaram a heartbeat de ~255 s em 2026-Q2.** Antes disso a ronda lida tinha horas (mediana de 2 h no USDC, de 9 h na USDT). Os comentários do repo e o ADR-024 descrevem o feed como sempre de 255 s; isso só é verdade desde 2026-Q2.',
          '**Erro real do DefiLlama** (+21% no WETH da Base, 29 Out 2026 21:00 UTC). Argumento a favor de nunca decidir com uma fonte só.',
          '**Fee no relatório de calibração** (0,20%) incoerente com o contrato (0,1%).',
          '**A hora do tick importa nos depegs**: às 00:00 o USDC parecia a 0,968; às 08:00 estava a 0,885. A banda deve ser verificada no momento do fill.'])
    return d

def annex(d, L):
    globals().update({k: v for k, v in L.items() if k not in ('d',)})
    d.table(['Feed', 'Período', 'Ticks', 'Idade mediana (s)', 'P90 (s)', 'Máx. (h)', '> 600 s (ADR-024)'],
            [[r.feed, r.scope, r.ticks, f(r.median_age_s, 0), f(r.p90_age_s, 0), f(r.max_age_h, 1), pct(r.pct_over_600s, 0)] for _, r in stale.iterrows()],
            'Frescura dos feeds no momento do tick (achado 4 do §5)', num_cols=[2, 3, 4, 5, 6])
    d.h2('Anexo — reprodução e ficheiros', 'anexo')
    d.code('cd docs/Reports/basket-dca\npip install -r requirements.txt\npython3 run_all.py            # puxa as séries (com cache) e refaz tudo\npython3 run_all.py --no-fetch # usa os CSV em data/series tal como estão\npython3 -m pytest tests/      # testes do motor sobre janelas reais')
    d.ul(['`src/feeds_config.py` — escolhe os feeds no directório da Chainlink e cruza com o repo (sem endereços escritos à mão).',
          '`src/fetch_chainlink.py`, `src/fetch_all.py` — leitura das rondas (cache em `data/raw/chainlink_round_cache/`) e das séries off-chain.',
          '`src/engine.py` — o mecanismo (A, A0, B, C). `src/scenarios.py`, `src/experiments.py` — o catálogo do §2.',
          '`data/series/` — todas as séries usadas, com a idade da ronda lida em cada tick (`age_s`). `data/series/feed_verification.csv` — identidade on-chain dos feeds.',
          '`results/sec_2_*.csv` — uma linha por posição e estratégia, com o cenário completo ao lado de cada número (par, repartição, datas, cadência, limiar, modo, fontes).',
          '`charts/*.svg` + `charts/*.csv` — cada gráfico e os dados exactos que desenha.'])
    d.p(f'Séries lidas a {dmy(dt.date(2026,11,7))} (último tick: 00:00 UTC de 7 Nov 2026). Inputs do repo no commit `{commit}`.')
    return d

def write(out):
    d, L = build(out)
    L['out'] = out
    body(d, L); body2(d, L); body3(d, L); annex(d, L)
    md = to_md(d)
    open(os.path.join(ROOT, 'RESULTS-2026-11.md'), 'w').write(md)
    import report_html, glob
    svgs = {os.path.basename(x)[:-4]: open(x).read() for x in glob.glob(os.path.join(ROOT, 'charts', '*.svg'))}
    # strip the standalone background so the figure card colour shows through in both themes
    svgs = {k: v.replace('style="max-width:100%;height:auto;background:var(--surface,#fcfcfb)"', 'style="max-width:100%;height:auto"') for k, v in svgs.items()}
    n_runs = f(sum(len(L['out'][k]) for k in ('2.1', '2.2', '2.3', '2.4', '2.5', '2.6', '2.7', '2.8', '2.10', '2.11_rolling', '2.12_raw') if L['out'].get(k) is not None), 0)
    report_html.write(d, svgs, os.path.join(ROOT, 'RESULTS-2026-11.html'), n_runs)
    return d
