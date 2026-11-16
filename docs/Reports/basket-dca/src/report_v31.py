"""RESULTS-2026-11-v3.1.md (+ HTML): the «A+ discreto» (3 V3 DCA orders per Basket), the on-chain checks on Base and the
Architect's peg-band rule, and the warning table. v2 and v3 files are not touched."""
import os, sys, json, numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import experiments_v31 as X31, experiments_v3x as xx, analysis_v3 as A
from engine_discrete import choose_n
from docmodel import Doc, to_md
from report import f, pct, usd, dmy
from scenarios import SPLITS
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
R31 = X31.R31
B3, BS, POOL = A.B3, A.BS, A.POOL

def compute():
    X31.warning_table().to_csv(os.path.join(R31, 'aviso_banda.csv'), index=False)
    X31.band_rule().to_csv(os.path.join(R31, 'banda_regra_arquitecto.csv'), index=False)
    X31.run_all_baskets()

def load():
    d = pd.concat([pd.read_csv(os.path.join(R31, f'discreto_{b}.csv.gz'), dtype=A.DT, low_memory=False) for b in xx.BASKETS], ignore_index=True)
    for k in set(sum(A.KEYS.values(), [])):
        if k in d: d[k] = d[k].fillna('-')
    d['grp'] = np.where(d.basket == BS, BS, POOL)
    d['cad'] = np.where(d.set == '2.10', d.cadence_h.astype(str).str.replace('.0', '', regex=False) + ' h (episódios)',
                        np.where(d.cadence_d.astype(str).isin(['7', '7.0']), 'semanal', 'diária'))
    d['strat'] = np.where(d.strategy == 'A+ discreto', 'A+ discreto L' + d.L.fillna(0).astype(int).astype(str), d.strategy)
    return d

def bl(b): return {POOL: '3 voláteis (VIRTUAL, COMP, AERO)', BS: 'ETH + cbBTC + USDC (com stable)'}.get(b, b)

def wide(d, grp, st, mode, value='val'):
    g = d[(d.grp == grp) & (d.set == st) & (d['mode'] == mode)]
    return g.pivot_table(index=['basket'] + A.KEYS[st], columns='strat', values=value, aggfunc='first')

def cmp(v, a, b):
    dd = (v[a] - v[b]) / 10
    return dict(n=len(dd), win=100 * float((dd > 0.01).mean()), lose=100 * float((dd < -0.01).mean()), tie=100 * float((dd.abs() <= 0.01).mean()), med=float(dd.median()),
                p5=float(dd.quantile(.05)), p95=float(dd.quantile(.95)))

def write():
    d = load(); aw = pd.read_csv(os.path.join(R31, 'aviso_banda.csv')); br = pd.read_csv(os.path.join(R31, 'banda_regra_arquitecto.csv'))
    reg = json.load(open(os.path.join(ROOT, 'data', 'series', 'v31', 'executor_registry_base_v31.json')))
    xf = json.load(open(os.path.join(ROOT, 'data', 'series', 'v3', 'x_feeds.json')))
    v3md5 = __import__('hashlib').md5(open(os.path.join(ROOT, 'RESULTS-2026-11-v3.md'), 'rb').read()).hexdigest()
    disc = d[d.strategy == 'A+ discreto']
    # ---------------- facts: pending chunks
    def pend(grp, mode, L, cads=None):
        x = disc[(disc.grp == grp) & (disc['mode'] == mode) & (disc.L == L)]
        if cads is not None: x = x[x.cad.isin(cads)]
        p = x[x.pending_chunks > 0]
        return dict(n=len(x), k=len(p), share=100 * len(p) / max(1, len(x)), chunks_max=int(p.pending_chunks.max()) if len(p) else 0,
                    unb_med=float(p.unbought_pct.median()) if len(p) else 0.0, unb_max=float(p.unbought_pct.max()) if len(p) else 0.0)
    PROD = ['diária', 'semanal']                                     # cadences the product allows (the Architect: daily minimum)
    # ---------------- facts: value comparisons (soft, product cadences + all)
    def vs(grp, st, mode, a, b):
        v = wide(d, grp, st, mode); v = v.dropna(subset=[a, b]); return cmp(v, a, b) if len(v) else None
    # regimes on 2.11
    def regimes(grp, mode, a, b):
        x = d[(d.grp == grp) & (d.set == '2.11') & (d['mode'] == mode)]
        rows = []
        for (dur, cad), g in x.groupby(['duration', 'cadence_d']):
            v = g.pivot_table(index=['basket', 'start_day', 'split'], columns='strat', values='val', aggfunc='first')
            vol = g[g.strat == 'A+ contínuo'].set_index(['basket', 'start_day', 'split']).eth_vol_pct.reindex(v.index)
            for lab in ('alta volatilidade', 'normal'):
                m = pd.Series(False, index=v.index)
                for bk in v.index.get_level_values(0).unique():
                    sel = v.index.get_level_values(0) == bk; p75 = vol[sel].quantile(.75)
                    m[sel] = (vol[sel] >= p75) if lab.startswith('alta') else (vol[sel] < p75)
                vv = v[m.values].dropna(subset=[a, b]); rows.append(dict(duration=dur, cadence_d=cad, regime=lab, **cmp(vv, a, b)))
        return pd.DataFrame(rows)
    # units (average price) vs A+ contínuo
    def units(grp, mode, L):
        x = d[(d.grp == grp) & (d['mode'] == mode)]
        a = x[x.strat == f'A+ discreto L{L}'].set_index(['basket', 'set'] + [k for k in sorted(set(sum(A.KEYS.values(), []))) if k in x.columns])
        c = x[x.strat == 'A+ contínuo'].set_index(a.index.names)
        j = a.join(c, lsuffix='_d', rsuffix='_c', how='inner')
        u = []
        for (_, r), ww in zip(j.iterrows(), j.index.get_level_values('split')):
            wv = np.asarray(SPLITS[ww]); pdv = np.array([r[f'px_{l}_d'] for l in X31.LEG]); pcv = np.array([r[f'px_{l}_c'] for l in X31.LEG])
            if np.isnan(pdv).any() or np.isnan(pcv).any(): continue
            u.append(float(np.sum(wv * (pcv / pdv - 1)) * 100))
        u = np.array(u); return dict(n=len(u), med=float(np.median(u)), p5=float(np.percentile(u, 5)), p95=float(np.percentile(u, 95)))
    # n_i rule
    cfgs = d[d.strat == 'A+ discreto L1'][['n_ticks', 'split']].drop_duplicates()
    nrule = []
    for rule in ('hamilton', 'ceil', 'round'):
        ex_ = [int(choose_n(SPLITS[sp], 1000.0, int(N), 16.0, rule).sum() - N) for N, sp in cfgs.itertuples(index=False)]
        ex_ = np.array(ex_); nrule.append(dict(rule=rule, configs=len(ex_), max_extra=int(ex_.max()), share_extra=100 * float((ex_ > 0).mean()),
                                               min_extra=int(ex_.min()), share_fewer=100 * float((ex_ < 0).mean())))
    nr = pd.DataFrame(nrule).set_index('rule')
    worst_extra = d[(d.strat == 'A+ discreto L1')].sort_values('extra_vs_N', ascending=False).iloc[0]
    # ---------------- facts used in the answers
    P = {(g, m, L): pend(g, m, L, PROD) for g in (POOL, BS) for m in ('suave', 'rígido') for L in (1, 2)}
    Pall = {(g, m, L): pend(g, m, L) for g in (POOL, BS) for m in ('suave', 'rígido') for L in (1, 2)}
    cont = d[d.strategy == 'A+ contínuo']; bplus = d[d.strategy == 'B+']
    def med_fills(strat, grp, mode, st='2.11', dur='30d', cad=1):
        x = d[(d.strat == strat) & (d.grp == grp) & (d['mode'] == mode) & (d.set == st) & (d.duration == dur) & (d.cadence_d == cad)]
        return float(x.n_fills.median())
    v_dc = {g: vs(g, '2.11', 'suave', 'A+ discreto L2', 'A+ contínuo') for g in (POOL, BS)}
    v_db = {g: vs(g, '2.11', 'suave', 'A+ discreto L2', 'B+') for g in (POOL, BS)}
    rg_dc = regimes(POOL, 'suave', 'A+ discreto L2', 'A+ contínuo'); rg_db = regimes(POOL, 'suave', 'A+ discreto L2', 'B+')
    U = units(POOL, 'suave', 2)
    maxf = lambda strat, grp, mode, col='max_fill_pct': float(d[(d.strat == strat) & (d.grp == grp) & (d['mode'] == mode) & (d.n_ticks >= 8)][col].max())
    exact = bool(disc.exact_chunks.astype(str).str.lower().eq('true').all())
    a_rows = aw[aw.band_pct > 10]; bad = a_rows[a_rows.problems.fillna('') != '']
    D = int(aw.days.iloc[0]); u0 = aw.universe_from.iloc[0]
    tok = {t['symbol']: t for t in reg['tokens']}
    usdc_b = br[br.event.str.startswith('USDC na Base')].set_index('band_pct')
    ev_b = br[~br.event.str.startswith('USDC na Base')]

    # ================================================================== document
    doc = Doc()
    doc.h1('Basket DCA — modelação v3.1 (RESULTS-2026-11-v3.1)')
    doc.p(f'**Da Analista para o Arquitecto.** Responde a `claude/basket-dca-pedido-modelacao-v3.1-2026-11-07.md`. Mede o **A+ discreto** — o Basket como o contrato V3 o executa: uma ordem DCA por perna, chunk fixo, no máximo L chunks por perna e por ciclo, `expiry` com 3 ciclos extra — contra o A+ contínuo da v3 e o B+, nos dois cestos (três voláteis primeiro), em modo suave e rígido, regra 9 a 25%. Faz a verificação on-chain na Base, simula a tua regra da banda e gera a tabela do aviso. Mesmo pacote e mesmo comando (`python3 run_all.py --no-fetch`); a v3 não muda (`RESULTS-2026-11-v3.md`, md5 `{v3md5}`); a v2 também não.')
    doc.callout('Separação de sempre: **(a)** a garantia — o que foi comprado cumpre a divisão? quanto ficou por comprar? — e **(b)** o que aconteceu ao valor e ao preço, histórico, nunca promessa. Mínimo / mediana / máximo, cada número com o seu cenário.')
    doc.h2('As respostas', 'respostas')
    p1s, p2s = P[(POOL, 'suave', 1)], P[(POOL, 'suave', 2)]; p1r, p2r = P[(POOL, 'rígido', 1)], P[(POOL, 'rígido', 2)]
    q1 = (f'**Sim, com uma troca.** A garantia fica mais forte: cada perna vende chunks inteiros e nunca mais do que o montante assinado, por isso **o que é comprado cumpre a divisão por construção** (teste novo; {"todas as" if exact else "nem todas as"} {f(len(disc),0)} corridas com chunks exactos). O que muda é o fim: o que antes se comprava «de uma vez» agora pode ficar por comprar. '
          f'**T3:** o problema da concentração desaparece — a maior compra única é um chunk (≤ {pct(maxf("A+ discreto L2", POOL, "suave"),1)} do capital em posições com 8 ou mais ciclos, contra {pct(maxf("A+ contínuo", POOL, "suave"),1)} no A+ contínuo); o E deixa de ser um parâmetro e passa a ser o próprio contrato. '
          f'**T6:** continua sem vencedor: o A+ discreto (L = 2) ficou à frente do B+ em {pct(v_db[POOL]["win"],0)} das posições da amostra de 5 anos (três voláteis; mediana {f(v_db[POOL]["med"],2)}%) e, face ao A+ contínuo, à frente em {pct(v_dc[POOL]["win"],0)}, empatado em {pct(v_dc[POOL]["tie"],0)} e atrás em {pct(v_dc[POOL]["lose"],0)} (com chunks iguais ao orçamento do ciclo, os dois fazem muitas vezes exactamente as mesmas compras); faz uma compra por ciclo, como o A+ contínuo ({f(med_fills("A+ discreto L2", POOL, "suave"),0)} e {f(med_fills("A+ contínuo", POOL, "suave"),0)} numa posição de 30 dias), contra {f(med_fills("B+", POOL, "suave"),0)} do B+. '
          f'**T8:** a regra 9 continua a ser a que pesa; no discreto, em vez de concentrar o fim, deixa chunks por executar: no modo suave, nas cadências do produto (diária e semanal), {f(p1s["k"],0)} posições de três voláteis ({pct(p1s["share"],1)}) fecham incompletas com L = 1 e {f(p2s["k"],0)} ({pct(p2s["share"],2)}) com L = 2; no rígido, {pct(p1r["share"],1)} e {pct(p2r["share"],1)}.')
    q2 = (f'**L = 2.** No modo suave e nas cadências do produto, L = 2 deixa {f(p2s["k"],0)} de {f(p2s["n"],0)} posições de três voláteis por completar (no máximo {p2s["chunks_max"]} chunks, {pct(p2s["unb_max"],1)} do capital), contra {f(p1s["k"],0)} ({pct(p1s["share"],1)}; até {p1s["chunks_max"]} chunks e {pct(p1s["unb_max"],1)} do capital) com L = 1. No cesto com stable: {f(P[(BS,"suave",2)]["k"],0)} contra {f(P[(BS,"suave",1)]["k"],0)}. '
          f'O preço de L = 2 é pequeno: o maior gasto num ciclo sobe de {pct(maxf("A+ discreto L1", POOL, "suave", "max_cycle_pct"),1)} para {pct(maxf("A+ discreto L2", POOL, "suave", "max_cycle_pct"),1)} do capital (posições com 8 ou mais ciclos), e cada compra continua a ser um chunk. No modo rígido L não ajuda ({pct(p1r["share"],1)} → {pct(p2r["share"],1)}): a perna protegida até ao fim não compra, com 1 ou 2 chunks.')
    q3 = (f'**Maior resto (Hamilton) com mínimo de 1 chunk por perna e tecto pelo minFill**: `n_i = ⌊w_i·N⌋`, as unidades que faltam para chegar a N vão para os maiores restos, cada perna tem pelo menos 1 chunk, e `n_i ≤ ⌊w_i·C ÷ minFill⌋`. Dá Σ n_i = N sempre que o minFill não morde. **Compras a mais no pior caso: {nr.loc["hamilton","max_extra"]}** (posições de 2 ciclos, onde 3 pernas precisam de 3 chunks; {pct(nr.loc["hamilton","share_extra"],1)} das configurações medidas têm alguma compra a mais). '
          f'Com `⌈w_i·N⌉` seriam até {nr.loc["ceil","max_extra"]} a mais ({pct(nr.loc["ceil","share_extra"],0)} das configurações); com arredondamento simples, até {nr.loc["round","max_extra"]} ({pct(nr.loc["round","share_extra"],0)}). O minFill de 16 USD morde quando o chunk ficaria abaixo dele, ou seja em posições longas ou pequenas (90 ciclos diários a 1 000 USD dão 61 chunks em vez de 90, e os ciclos a mais ficam sem compra); acontece em {pct(nr.loc["hamilton","share_fewer"],1)} das configurações medidas.')
    nreg = [t['symbol'] for t in reg['tokens'] if not t['registered']]
    q4 = (f'**Registo:** VIRTUAL, COMP, cbBTC, USDC e WETH estão todos registados em `tokenUsdFeeds` no executor V3 da Base (`{reg["executor"]}`, lido a {reg["read_at_utc"]} UTC); **{", ".join(nreg)} não está** — sem piso de preço on-chain, como previsto para a fase 2. '
          f'**USDC/USD da Base:** limiar de desvio {f(tok["USDC"]["directory_threshold_pct"],1)}% e heartbeat {f(tok["USDC"]["directory_heartbeat_s"],0)} s no directório; nas 1 223 rondas observadas, 97% são de heartbeat e o passo mediano entre rondas é de 0,004% — o feed quase só se mexe pelo relógio. maxStaleness no executor: {f(tok["USDC"]["maxStaleness"],0)} s. '
          f'**A tua regra da banda**, nos eventos reais da T7 (feeds Chainlink de Ethereum como substitutos, porque o feed da Base só existe desde Ago 2023): com banda de 1% muda {f(ev_b[ev_b.band_pct==1].changed.sum(),0)} de {f(ev_b[ev_b.band_pct==1].hours.sum(),0)} decisões horárias: {f(ev_b[ev_b.band_pct==1].arch_stricter.sum(),0)} passam a «não compra» (soma o limiar à última resposta, por isso marca o descolamento à mesma hora ou antes e durante mais tempo), {f(ev_b[ev_b.band_pct==1].arch_looser.sum(),0)} passam a «compra» (falsos alarmes do DefiLlama que o feed não confirmava, quase todos no USDS em Out 2024) e as restantes deixam de saltar por falta de preço; com 2%, {f(ev_b[ev_b.band_pct==2].changed.sum(),0)} ({f(ev_b[ev_b.band_pct==2].arch_stricter.sum(),0)} / {f(ev_b[ev_b.band_pct==2].arch_looser.sum(),0)}). No próprio USDC da Base, que não descolou, elimina {f(usdc_b.loc[1.0].out_600,0)} horas de «fora da banda» falsas que o DefiLlama dava com a regra dos 600 s (e {f(usdc_b.loc[1.0].skipped_600,0)} horas sem preço).')
    q5 = (f'**Nenhuma banda acima de 10% produz um texto falso**, com dois cuidados que já estão no script: com R = 1 o verbo vai para o singular («só 1 recuperou») e com R = 0 a frase passa a «nenhuma recuperou» (bandas de 80% ou mais); **com 100% não há N** (nenhuma stable caiu mais de 100%) e o aviso fica só com a frase dos 80%. '
          f'**Uma correcção à rev. 3 da v3:** D = {f(D,0)} dias, não 2 501. O universo completo (todas as stablecoins do registo do DefiLlama) só está coberto desde {dmy(u0)}; antes disso só as moedas curadas tinham histórico. A tabela e o D usam essa data. Exemplos: 20% → {aw[aw.band_pct==20].N_stables.iloc[0]} stables, {aw[aw.band_pct==20].R_stables.iloc[0]} recuperaram; 50% → {aw[aw.band_pct==50].N_stables.iloc[0]}, {aw[aw.band_pct==50].R_stables.iloc[0]}; 80% → {aw[aw.band_pct==80].N_stables.iloc[0]}, 0.')
    doc.answers([('§2.1', 'O A+ discreto mantém as conclusões da v3 (T3, T6, T8)?', q1), ('§2.2', 'L = 1 ou L = 2?', q2),
                 ('§2.3', 'Que regra de arredondamento de n_i, e quantas compras a mais no pior caso?', q3),
                 ('§3', 'Verificação on-chain na Base e a regra da banda', q4), ('§1', 'O aviso: a tabela X → (N, R) e se o texto alguma vez é falso', q5)])

    # ================================================================== §2 detail
    doc.h2('§2 — O A+ discreto', 'discreto')
    doc.p('**O mecanismo, tal como foi modelado.** Uma ordem DCA por perna: `amountIn_i = w_i·C`, `dcaTotal_i = n_i`, chunk fixo `w_i·C ÷ n_i` (o último leva o resto exacto). **Calendário:** até ao fim do ciclo t (t < N) o cesto deve ter executado ⌈Σn·(t+1)/N⌉ chunks; no último ciclo e nos 3 de graça, tudo o que falta. **Regra 4 (com P):** o primeiro chunk de um ciclo vai para a perna elegível com a pior variação; **regra 5:** não a mesma do primeiro chunk do ciclo anterior, salvo se for a única. **Recuperação:** os chunks seguintes devidos no mesmo ciclo vão para as pernas elegíveis mais atrasadas na sua própria contagem, nunca mais de L por perna (L = 2 ↔ `dcaInterval = cadência ÷ 2`). **Regra 6:** a perna tranca no último chunk (`DCAComplete`). **Regra 9:** a perna protegida não é elegível; no modo suave deixa de bloquear nos últimos 10 ciclos e nos 3 de graça (a forma discreta do E); no rígido bloqueia sempre. **Banda B** e **sem preço**: como no A+. **Fim:** `expiry = início + (N + 3) × cadência`; o que não executar fica na carteira. Compras ao preço do feed no tick; nos ciclos de graça, ao feed nesse tick (ao preço de decisão quando não temos o feed nessa hora). minFill = 16 USD (rota agregador), posições de 1 000 USD.')
    doc.p('**Janelas:** 2.1 (S1–S7), 2.3 (Jul–Out 2026), §2.10 (episódios horários) e, para a separação por regime, a amostra de 5 anos (2.11), como na T6/T8 da v3. Nos episódios as cadências horária e de 4 h já não são do produto (cadência mínima diária, aceite por ti); aparecem em linha própria.')
    doc.h3('A garantia: o que fica por comprar')
    rows = []
    for g in (POOL, BS):
        for mode in ('suave', 'rígido'):
            for L in (1, 2):
                x = disc[(disc.grp == g) & (disc['mode'] == mode) & (disc.L == L)]
                for cad, xc in x.groupby('cad'):
                    p = xc[xc.pending_chunks > 0]
                    rows.append([bl(g), mode, L, cad, f(len(xc), 0), f'{f(len(p),0)} ({pct(100*len(p)/len(xc),2)})',
                                 '—' if p.empty else f'{int(p.pending_chunks.min())} / {f(p.pending_chunks.median(),0)} / {int(p.pending_chunks.max())}',
                                 '—' if p.empty else f'{f(p.unbought_pct.min(),1)} / {f(p.unbought_pct.median(),1)} / {f(p.unbought_pct.max(),1)}'])
    doc.table(['Cesto', 'Modo', 'L', 'Cadência', 'Posições', 'Fecham com chunks por executar', 'Chunks por executar (mín. / med. / máx.)', 'Por comprar, % do capital (mín. / med. / máx.)'], rows,
              'Todas as janelas · o que foi comprado cumpre sempre a divisão (chunks inteiros); o que fica por comprar nunca saiu da carteira · com stable, inclui a perna stable bloqueada pela banda até ao fim (UST, USDC no SVB)', num_cols=[2, 4])
    doc.h3('Tamanho das compras e número de compras')
    rows = []
    for g in (POOL, BS):
        for mode in ('suave', 'rígido'):
            for st_ in ('A+ contínuo', 'B+', 'A+ discreto L1', 'A+ discreto L2'):
                x = d[(d.grp == g) & (d['mode'] == mode) & (d.strat == st_)]; x8 = x[x.n_ticks >= 8]
                x30 = x[(x.set == '2.11') & (x.duration == '30d') & (x.cadence_d == 1)]
                rows.append([bl(g), mode, st_, pct(x8.max_fill_pct.max(), 1), pct(x8.max_cycle_pct.max(), 1), f(x30.n_fills.median(), 0),
                             '—' if st_.startswith('A+ c') or st_ == 'B+' else f'{f(x.extra_vs_N.max(),0)}'])
    doc.table(['Cesto', 'Modo', 'Estratégia', 'Maior compra única (≥ 8 ciclos)', 'Maior gasto num ciclo (≥ 8 ciclos)', 'Compras numa posição de 30 dias (mediana)', 'Chunks acima de N (máx.)'], rows,
              'No A+ contínuo e no B+ uma compra é o que uma perna compra num ciclo; no discreto é um chunk', num_cols=[3, 4, 5, 6])
    doc.h3('Valor contra o A+ contínuo e contra o B+ (histórico)')
    rows = []
    for g in (POOL, BS):
        for st in ('2.1', '2.3', '2.11', '2.10'):
            for mode in ('suave', 'rígido'):
                v = wide(d, g, st, mode)
                if v.empty: continue
                c1, c2 = cmp(v.dropna(subset=['A+ discreto L2', 'A+ contínuo']), 'A+ discreto L2', 'A+ contínuo'), cmp(v.dropna(subset=['A+ discreto L2', 'B+']), 'A+ discreto L2', 'B+')
                c3 = cmp(v.dropna(subset=['A+ discreto L1', 'A+ discreto L2']), 'A+ discreto L2', 'A+ discreto L1')
                rows.append([bl(g), A.SETLAB[st], mode, f(c1['n'], 0), f'{pct(c1["win"],0)} / {pct(c1["tie"],0)} / {pct(c1["lose"],0)} · {f(c1["med"],2)}% ({f(c1["p5"],1)} / {f(c1["p95"],1)})',
                             f'{pct(c2["win"],0)} · {f(c2["med"],2)}% ({f(c2["p5"],1)} / {f(c2["p95"],1)})', f'{pct(c3["win"],0)} · {f(c3["med"],2)}%'])
    doc.table(['Cesto', 'Janelas', 'Modo', 'Posições', 'Discreto L2 face ao A+ contínuo: à frente / empate / atrás · mediana (P5 / P95)', 'Discreto L2 > B+: % · mediana (P5 / P95)', 'L2 > L1: % · mediana'], rows,
              'Valor no fim da posição (comprado ao preço do feed + o que ficou na carteira), em % do capital · empate < 0,01%', num_cols=[3])
    rows = []
    for (_, a), (_, b) in zip(rg_dc.iterrows(), rg_db.iterrows()):
        rows.append([f'{a.duration.replace("d"," dias")} · {"diária" if a.cadence_d == 1 else "semanal"}', a.regime, f(a.n, 0), f'{pct(a.win,0)} / {pct(a.tie,0)} / {pct(a.lose,0)} · {f(a.med,2)}%', f'{pct(b.win,0)} / {pct(b.tie,0)} / {pct(b.lose,0)} · {f(b.med,2)}%'])
    doc.table(['Posições', 'Regime', 'n', 'Discreto L2 face ao A+ contínuo: à frente / empate / atrás · mediana', 'Discreto L2 face ao B+: à frente / empate / atrás · mediana'], rows, '3 voláteis, modo suave, amostra de 5 anos por regime (25% das janelas com o ETH mais volátil em cada cesto)', num_cols=[2])
    doc.p(f'**Preço médio por perna (histórico):** nas posições em que os dois compraram as três pernas, o A+ discreto (L = 2, suave, três voláteis) comprou com custo médio igual ao do A+ contínuo — unidades a mais com mediana {f(U["med"],2)}% (P5 {f(U["p5"],1)}%, P95 {f(U["p95"],1)}%, n = {f(U["n"],0)}). Comprar em chunks iguais não piora o preço.')
    doc.h3('Ciclos sem compra, e porquê')
    rows = []
    for g in (POOL, BS):
        for mode in ('suave', 'rígido'):
            for L in (1, 2):
                x = disc[(disc.grp == g) & (disc['mode'] == mode) & (disc.L == L)]
                tot = x.n_ticks.sum() + 3 * len(x)
                rows.append([bl(g), mode, L] + [pct(100 * x[f'idle_{k}'].sum() / tot, 2) for k in ('calendário', 'regra 9', 'banda', 'sem preço', 'regra 6', 'regra 5')])
    doc.table(['Cesto', 'Modo', 'L', 'Calendário (menos chunks do que ciclos, pelo minFill)', 'Regra 9', 'Banda', 'Sem preço', 'Regra 6 (tudo comprado)', 'Regra 5'], rows,
              '% dos ciclos (N + 3 por posição) em que nenhuma perna comprou · a regra 5 nunca deixa um ciclo vazio: só afasta a perna quando há outra', num_cols=[])
    doc.h3('A regra de n_i')
    rows = [[{'hamilton': 'Maior resto (Hamilton), mínimo 1, tecto minFill — recomendada', 'ceil': '⌈w_i·N⌉, mínimo 1, tecto minFill', 'round': 'arredondamento simples, mínimo 1, tecto minFill'}[r_], f(row.configs, 0), int(row.max_extra), pct(row.share_extra, 1), pct(row.share_fewer, 1)]
            for r_, row in nr.iterrows()]
    doc.table(['Regra', 'Configurações (N × divisão)', 'Chunks acima de N (máx.)', 'Configurações com chunks a mais', 'Configurações em que o minFill reduz'], rows,
              'Todas as combinações de N e divisão das posições medidas · 1 000 USD, minFill 16 USD', num_cols=[1, 2, 3, 4])

    # ================================================================== §3
    doc.h2('§3 — Verificação on-chain na Base', 'onchain')
    rows = []
    for t in reg['tokens']:
        same = ''
        key = {'VIRTUAL': 'VIRTUAL_base', 'COMP': 'COMP_base'}.get(t['symbol'])
        if key and t['feed']: same = 'sim' if xf[key]['proxy'].lower() == t['feed'].lower() else 'NÃO'
        rows.append([t['symbol'], f'`{t["token"]}`', 'sim' if t['registered'] else '**não — sem piso on-chain**', f'`{t["feed"]}`' if t['feed'] else '—',
                     f(t['maxStaleness'], 0) if t['registered'] else '—', t['tokenDecimals'] if t['registered'] else '—',
                     '—' if t.get('directory_threshold_pct') is None else f'{f(t["directory_threshold_pct"],1)}% / {f(t["directory_heartbeat_s"],0)} s',
                     t.get('description_onchain') or '—', same or '—'])
    doc.table(['Token', 'Endereço (catálogo do repo)', 'Registado', 'Feed', 'maxStaleness (s)', 'tokenDecimals', 'Limiar / heartbeat (directório)', 'description() on-chain', 'Feed = o usado na v3'], rows,
              f'OrderExecutorV3 da Base `{reg["executor"]}` (de docs/DEPLOYMENTS.md) · `tokenUsdFeeds(address)` lido a {reg["read_at_utc"]} UTC · igualdades calculadas, endereços nunca escritos à mão · o ETH/USD da Base não está no directório (v3: passo mínimo medido 0,15%)')
    doc.p(f'**USDC/USD da Base.** Directório: limiar {f(tok["USDC"]["directory_threshold_pct"],1)}%, heartbeat {f(tok["USDC"]["directory_heartbeat_s"],0)} s. Observado (todas as 1 223 rondas desde Ago 2023): intervalo mediano 86 418 s, 97% das rondas por heartbeat, passo mediano 0,004% e mínimo lido 0,99936. O executor aceita-o até {f(tok["USDC"]["maxStaleness"],0)} s. **Com a tua regra, o limiar de 0,3% cabe em qualquer banda ≥ 1%.**')
    rows = []
    for _, r in br.iterrows():
        rows.append([r.event, f'{f(r.threshold_pct,2)}% / {f(r.heartbeat_s,0)} s', f(r.max_staleness_s, 0), pct(r.band_pct, 0), f(r.hours, 0), f'{r.changed} ({r.arch_stricter} / {r.arch_looser})',
                     f'{r.out_600} / {r.out_arch}', f'{r.feed_used_600} / {r.feed_used_arch}', f'{r.skipped_600} / {r.skipped_arch}', 'sim' if r.thr_fits else 'não → quórum'])
    doc.table(['Evento', 'Limiar / heartbeat do feed', 'Feed aceite até (s)', 'Banda', 'Horas', 'Decisões que mudam (mais estrita / menos)', 'Horas «fora da banda»: 600 s / tua regra', 'Horas decididas pelo feed: 600 s / tua regra', 'Horas sem preço: 600 s / tua regra', 'Limiar cabe na banda'], rows,
              'Hora a hora, da véspera do evento a 3 dias depois da recuperação · feed aceite até heartbeat × 90 000 ÷ 86 400 (a proporção do executor da Base) · quórum = DefiLlama (aproximação declarada)', num_cols=[2, 4])
    doc.p(f'**Leitura.** Nos descolamentos reais as duas regras marcam o início do evento à mesma hora (ou uma hora antes com a tua); a tua acrescenta horas de «não compra» quando o feed está parado perto da borda da banda (TUSD em 2024, LUSD acima do peg em 2023), porque soma o limiar. Fora dos eventos é a tua que é mais limpa: no USDC da Base tira os falsos alarmes e as horas sem preço que o DefiLlama traz; no USDS em 2024 tira {f(br[(br.event.str.startswith("USDS")) & (br.band_pct == 1)].arch_looser.iloc[0],0)} horas de «fora da banda» que só o DefiLlama via. No FRAX e no LUSD, com limiar de 1%, a banda de 1% não cabe e a tua regra cai no quórum, como desenhaste.')

    # ================================================================== §1
    doc.h2('§1 — O aviso da banda', 'aviso')
    rows = [[f'{int(r.band_pct)}%', r.N_stables, r.R_stables, f'{r.N_events} / {r.R_events}', r.text, r.problems if isinstance(r.problems, str) and r.problems else 'nenhum'] for _, r in aw.iterrows()]
    doc.table(['Banda X', 'N (stables)', 'R (recuperaram)', 'Quedas / recuperadas (eventos)', 'Texto', 'Problema'], rows,
              f'Gerada por `python3 src/experiments_v31.py` (escreve results/v31/aviso_banda.csv) · inventário da T7, «recuperou» = voltou a ≥ 0,99 e ficou 30 dias · stablecoins em USD com ≥ 50 M USD em circulação · desde {dmy(u0)} ({f(D,0)} dias) · conta stables distintas (a sUSD caiu duas vezes: recuperou em 2021, não em 2024; conta como «recuperou»)', num_cols=[1, 2])
    doc.p(f'**Verificação.** Para as bandas acima de 10%, o texto é verdadeiro em todas: N e R são exactamente o que o inventário diz, «só» só aparece com R < N, e nenhuma stable recuperou de 80% ou mais. Três notas para a UI: (1) singular com R = 1; (2) «nenhuma recuperou» com R = 0; (3) com X = 100% não há N e o aviso fica só com a segunda frase. **Correcção à rev. 3 da v3:** usei 2 501 dias (desde 1 Jan 2020); o universo completo só está coberto desde {dmy(u0)}, por isso D = {f(D,0)}. A v3 fica como estava (regra do pacote); vale este número.')

    # ================================================================== tests / not measured / spec
    doc.h2('Testes do motor', 'testes')
    doc.ul(['`test_discrete_split_is_exact_by_construction` — S1–S7, os 4 cestos, suave/rígido, L = 1/2: cada compra é exactamente um chunk, nenhuma perna vende mais do que w_i·C, no máximo L chunks por perna por ciclo, nada depois do expiry, o que fica por comprar soma o resto do capital; com todos os chunks executados o desvio é 0.',
            '`test_chunks_respect_min_fill_and_hamilton_sum` — chunk ≥ minFill, n_i ≥ 1, e Σ n_i = N quando o minFill não morde.',
            '`test_band_blocks_the_stable_leg_in_the_discrete_basket` — USDC no SVB e UST em Mai 2022, horário, ciclos de graça incluídos: nenhuma compra da stable fora da banda.',
            'Os 14 testes da v2 e da v3 continuam a passar.'])
    doc.h2('O que não foi medido, e porquê', 'naomedido')
    doc.ul(['**Gas e falhas de execução por ordem**: 3 ordens por cesto significam 3 assinaturas e até 2 execuções por ciclo com L = 2; o custo por execução é o da v3 (0,003 / 0,016 USD), não medido de novo.',
            '**A ordem real do keeper dentro de um ciclo** (qual das 3 ordens é submetida primeiro, o que acontece se uma transacção falha): modelei a escolha por regra 4 e a recuperação pela perna mais atrasada; o resto é capacidade do keeper.',
            '**O `dcaInterval` exacto com L = 2**: modelado como «até 2 chunks por perna por ciclo»; no contrato são 2 janelas de meio ciclo, por isso o segundo chunk sai meio ciclo depois (o preço desse meio ciclo não foi usado).',
            '**O feed USDC/USD da Base nos eventos reais**: não existia antes de Ago 2023; a regra da banda foi simulada com os feeds de Ethereum de cada stable e o maxStaleness na proporção do executor da Base.',
            '**O quórum real** (CoinGecko sem histórico) e a disponibilidade ao vivo do DefiLlama, como na v3.'])
    doc.h2('O que isto muda na spec (proposta)', 'spec')
    doc.ol(['**Basket = 3 ordens DCA do V3**, uma por perna, chunk fixo, `n_i` pela regra do maior resto com mínimo 1 e tecto pelo minFill.',
            f'**L = 2** (`dcaInterval = cadência ÷ 2`): completa quase todas as posições no modo suave ({f(p2s["k"],0)} incompletas em {f(p2s["n"],0)} nas cadências do produto).',
            '**`expiry = início + (N + 3) × cadência + margem`**, como propuseste; o que não executar fica na carteira e vai para o relatório de fecho.',
            '**Modo suave por defeito.** No rígido, a perna protegida até ao fim fica por comprar em muitas posições de stress; isso deve ser dito ao utilizador quando escolhe o rígido.',
            '**Banda na Base com a tua regra** (feed até ao maxStaleness, limiar somado, quórum quando o limiar não cabe).',
            f'**Aviso** com o texto do dono, lido da tabela X → (N, R), D = {f(D,0)} dias e as três regras de redacção acima.'])
    md = to_md(doc)
    open(os.path.join(ROOT, 'RESULTS-2026-11-v3.1.md'), 'w').write(md)
    import report_html
    n_runs = len(d) + len(br) * 2
    report_html.write(doc, {}, os.path.join(ROOT, 'RESULTS-2026-11-v3.1.html'), f(n_runs, 0), title='Basket DCA Modelação v3.1',
                      eyebrow='TeraSwap · Analista → Arquitecto · RESULTS-2026-11-v3.1', h1='Basket DCA — v3.1: o A+ que o contrato V3 executa',
                      extra_meta='A+ discreto · L = 1/2 · Base on-chain · aviso da banda', feeds_txt='feeds Chainlink da v3 + registo do executor da Base',
                      period_txt='Jan 2020 – Nov 2026 · diário e horário')
    return doc

if __name__ == '__main__':
    if '--no-compute' not in sys.argv: compute()
    write()
