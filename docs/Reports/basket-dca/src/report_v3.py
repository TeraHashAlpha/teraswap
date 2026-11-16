"""RESULTS-2026-11-v3.md (+ HTML) — measuring A+ (the Architect's improvements), three-volatile basket first.
v2 files are not touched. compute() runs every v3 experiment; write() builds the document from results/v3."""
import os, sys, glob, json, pickle, numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import experiments_v3 as x3, experiments_v3x as xx, analysis_v3 as A, charts_v3 as ch3, experiments as ex
import t7_stables as T7, t7_sim as S7
from docmodel import Doc, to_md
from report import f, pct, pp, usd, dmy
from scenarios import SPLITS, ticks
from engine_plus import run_plus
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
R3 = os.path.join(ROOT, 'results', 'v3'); os.makedirs(R3, exist_ok=True)
GZ = {'method': 'gzip', 'mtime': 0}                 # large run files ship compressed (deterministic bytes)
RD = lambda n: pd.read_csv(os.path.join(R3, n), dtype=A.DT, low_memory=False)
THR = 0.25
DREC_OWNER = 80.0       # owner, 7 Nov 2026: the fact the warning cites — no stable recovered from a drop of 80% or more
FREE_BAND = 10.0        # owner, 7 Nov 2026: a peg band up to 10% needs no warning; above it, one warning
RETRY_N = xx.RETRY      # owner, 7 Nov 2026: the last cycle waits up to 3 cycles for a usable price, then closes

# ====================================================================== compute
def compute():
    x3.t1().to_csv(os.path.join(R3, 't1_single_price.csv'), index=False)
    x3.t2().to_csv(os.path.join(R3, 't2_min_fill.csv'), index=False)
    t4 = x3.t4()
    for k in ('usdc_fresh', 'usdc_band', 'params', 'quality', 'decisions', 'verification'):
        t4[k].to_csv(os.path.join(R3, f't4_{k}.csv'), index=False)
    json.dump(t4['registry'], open(os.path.join(R3, 't4_registry.json'), 'w'), indent=2)
    d3 = xx.t3x(); d3.to_csv(os.path.join(R3, 't3x_staged.csv.gz'), index=False, compression=GZ)
    rec = pd.concat([xx.t3_recommend_x(d3, 6), xx.t3_recommend_x(d3, 8)]); rec.to_csv(os.path.join(R3, 't3_recommendation.csv'), index=False)
    r = rec[(rec.threshold == THR) & (rec.min_ticks == 8)].iloc[0]
    REC = dict(k=int(r.k), cap=(float(r.cap) or None))
    json.dump(REC, open(os.path.join(R3, 'rec.json'), 'w'))
    for b in xx.BASKETS:
        xx.t68x(REC, baskets=[b]).to_csv(os.path.join(R3, f't68x_{b}.csv.gz'), index=False, compression=GZ)
    p2 = xx.t8_phase2()
    p2['availability'].reset_index(drop=True).to_csv(os.path.join(R3, 't8_phase2_availability.csv'), index=False)
    p2['decisions'].to_csv(os.path.join(R3, 't8_phase2_decisions.csv'), index=False)
    compute_t7()

def compute_t7():
    ev = T7.detect(); m = T7.measure(ev); m.to_csv(os.path.join(R3, 't7_events.csv'), index=False)
    c = T7.ceiling(m, d_rec_owner=DREC_OWNER, owner_free=FREE_BAND); save_t7(c)
    S7.input_stable().to_csv(os.path.join(R3, 't7_input_stable.csv'), index=False)
    S7.leg3().to_csv(os.path.join(R3, 't7_leg3.csv'), index=False)

# plain CSV/JSON only (no pickles): the package must read the same under pandas 2.x and 3.x
T7TAGS = {'confirmado': 'confirmed', 'qualquer série': 'any', 'dono': 'owner'}
def save_t7(c):
    c['levels'].to_csv(os.path.join(R3, 't7_levels.csv'), index=False)
    meta = {}
    for tag, k in T7TAGS.items():
        o = c[tag]
        o['top5'].to_csv(os.path.join(R3, f't7_top_recovered_{k}.csv'), index=False)
        o['non_recovered'].to_csv(os.path.join(R3, f't7_non_recovered_{k}.csv'), index=False)
        meta[tag] = dict(d_rec=o['d_rec'], ceiling=o['ceiling'], rule_applies=o['rule_applies'],
                         event={kk: (str(v) if isinstance(v, pd.Timestamp) else (None if (isinstance(v, float) and v != v) else v))
                                for kk, v in o['event'].items() if kk in ('symbol', 'start', 'max_drop_pct', 'keeper_min', 'days_to_recover', 'keeper_series')})
    json.dump(meta, open(os.path.join(R3, 't7_ceiling.json'), 'w'), indent=2, ensure_ascii=False, default=str)

def load_t7():
    meta = json.load(open(os.path.join(R3, 't7_ceiling.json')))
    c = {'levels': pd.read_csv(os.path.join(R3, 't7_levels.csv'))}
    for tag, k in T7TAGS.items():
        m = meta[tag]; nr = pd.read_csv(os.path.join(R3, f't7_non_recovered_{k}.csv'))
        c[tag] = dict(d_rec=m['d_rec'], ceiling=m['ceiling'], rule_applies=m['rule_applies'], event=pd.Series(m['event']),
                      top5=pd.read_csv(os.path.join(R3, f't7_top_recovered_{k}.csv')), non_recovered=nr,
                      dead_through_ceiling=nr[nr.max_drop_pct >= m['ceiling']])
    return c

def load_p2():
    return {'availability': pd.read_csv(os.path.join(R3, 't8_phase2_availability.csv')).set_index('scope', drop=False),
            'decisions': pd.read_csv(os.path.join(R3, 't8_phase2_decisions.csv'), dtype=A.DT, low_memory=False)}

# ====================================================================== helpers
def cadlab(cad): return 'diária' if cad in (1, 1.0) else 'semanal'
def durlab(dur, cad): return f'{dur.replace("d", " dias")} · {cadlab(cad)}'
def bshort(b): return {'ETH+cbBTC+VIRTUAL': 'ETH + cbBTC + VIRTUAL', 'ETH+cbBTC+COMP': 'ETH + cbBTC + COMP', 'ETH+cbBTC+AERO': 'ETH + cbBTC + AERO',
                       'ETH+cbBTC+USDC': 'ETH + cbBTC + USDC (com stable)', A.POOL: '3 voláteis (os três X juntos)'}.get(b, b)
def rng3(s, d=1, unit=''): return f'{f(s.min(), d)}{unit} / {f(s.median(), d)}{unit} / {f(s.max(), d)}{unit}'

def regimes_old(df, va, vb, volcol):
    rows = []
    for (dur, cad), g in df.groupby(['duration', 'cadence_d']):
        p75 = g[volcol].quantile(.75)
        for lab, m in (('alta volatilidade', g[volcol] >= p75), ('normal', g[volcol] < p75)):
            dd = (g[m][va] - g[m][vb]) / 10
            rows.append(dict(duration=dur, cadence_d=cad, regime=lab, n=int(m.sum()), win=float((dd > 0.01).mean() * 100), med=float(dd.median())))
    return pd.DataFrame(rows)

# ====================================================================== write
def write():
    REC = json.load(open(os.path.join(R3, 'rec.json'))); K = REC['k']; CAPR = REC['cap'] or 0.0
    t1 = RD('t1_single_price.csv'); t2 = RD('t2_min_fill.csv'); reg = json.load(open(os.path.join(R3, 't4_registry.json')))
    t4 = {k: pd.read_csv(os.path.join(R3, f't4_{k}.csv')) for k in ('usdc_fresh', 'usdc_band', 'params', 'quality', 'decisions', 'verification')}
    d68 = A.load_t68(); t3 = A.load_t3(); p2 = load_p2()
    ev7 = pd.read_csv(os.path.join(R3, 't7_events.csv'), parse_dates=['start', 'recovered_at', 'keeper_min_at', 'last_date'])
    c7 = load_t7(); lv7 = c7['levels']
    in7 = pd.read_csv(os.path.join(R3, 't7_input_stable.csv')); l37 = pd.read_csv(os.path.join(R3, 't7_leg3.csv'))
    rec = pd.read_csv(os.path.join(R3, 't3_recommendation.csv'))

    # ---------------- T8 facts
    G = A.guarantee(d68); V = A.versus(d68); RG, rg_groups = A.regimes(d68); ROT = A.rotation(d68); DDP = A.drawdown_pairs(d68)
    RU = A.rules(d68); PE = A.p_effect(d68)
    g3 = G[G.basket.isin(A.B3)]; n3 = int(g3.n.sum()); dev3 = float(max(g3.dev_A.max(), g3.dev_B.max())); retry3 = int(g3.retry_A.sum())
    vp = V.set_index(['basket', 'set']); rp = RG[RG.basket == A.POOL].set_index(['duration', 'cadence_d', 'regime'])
    rs = RG[RG.basket == A.BS].set_index(['duration', 'cadence_d', 'regime'])
    rot = ROT.set_index('basket'); ru = RU.set_index('basket')
    dd11 = DDP[DDP.set == '2.11']
    av = p2['availability'].set_index('scope'); dc = p2['decisions'].copy(); dc['variant'] = dc.get('variant', pd.Series(index=dc.index)).fillna('-')
    dc['pct'] = 100 * dc.changed / dc.decision_ticks
    def dcp(st, var='-'): s = dc[(dc.set == st) & (dc.variant == var)]; return 100 * s.changed.sum() / s.decision_ticks.sum(), s
    v27 = pd.read_csv(os.path.join(ROOT, 'results', 'sec_2_7.csv'))
    v27a = v27[(v27.token == 'AERO')]; v27_cl = 100 * v27a[v27a.source == 'Chainlink'].decisions_changed.sum() / v27a[v27a.source == 'Chainlink'].decision_ticks.sum()
    v27_dl = 100 * v27a[v27a.source == 'DefiLlama (fase 2)'].decisions_changed.sum() / v27a[v27a.source == 'DefiLlama (fase 2)'].decision_ticks.sum()
    # ---------------- T3 facts
    T3T, T3S = A.t3_tables(t3)
    def t3v(grp, thr, k, cap, col): return float(T3T[(T3T.group == grp) & (T3T.threshold == thr) & (T3T.k == k) & (T3T.cap == cap)][col].iloc[0])
    def t3w(grp, thr, k, cap): return T3T[(T3T.group == grp) & (T3T.threshold == thr) & (T3T.k == k) & (T3T.cap == cap)].arg6.iloc[0]
    sim = T3S.set_index(['basket', 'threshold'])
    s3 = T3S[T3S.basket.isin(A.B3) & (T3S.threshold == THR)]
    all3_pos3, n3pos, run3 = int(s3.all3_pos.sum()), int(s3.n.sum()), int(s3.run_max.max())
    ss = sim.loc[(A.BS, THR)]
    dp = t3[(t3.threshold == THR) & (t3.k == K) & (t3.cap == CAPR) & t3.basket.isin(A.B3)].deferred_px_vs_k1_pct.dropna()
    # ---------------- T6 facts (from the same runs as T8)
    def fills(b, st):
        x = d68[(d68.set == '2.11') & (d68.duration == '30d') & (d68.cadence_d == 1) & (d68.strategy == st) & (d68.basket.isin(A.B3 if b == A.POOL else (b,)))]
        return float(x.n_fills.median())
    fa3, fb3 = fills(A.POOL, 'A+'), fills(A.POOL, 'B+')
    allwin = {}
    for b in (A.POOL, A.BS):
        bs = A.B3 if b == A.POOL else (b,)
        vv = pd.concat([A.wide(d68, bb, st, strategies=('A+', 'B+')) for bb in bs for st in ('2.1', '2.3', '2.11', '2.10')])
        dd_ = (vv['A+'] - vv['B+']) / 10; allwin[b] = (len(vv), float((dd_ > 0.01).mean() * 100), float(dd_.median()))
    # ---------------- T1 facts (stable basket, as asked) + P in the three-volatile basket
    t1['chg_pct'] = 100 * t1.decisions_changed / t1.decision_ticks.clip(lower=1)
    r11 = t1[t1.set == '2.11']
    rg_v2 = regimes_old(r11, 'val_v2', 'val_B', 'eth_vol_pct'); rg_P = regimes_old(r11, 'val_P', 'val_B', 'eth_vol_pct')
    devP = t1[t1.dev_P > 1e-6]
    cells = {leg: t1[[f'cl_{leg}', f'dl_{leg}', f'none_{leg}']].sum() for leg in ('eth', 'btc', 'usdc')}
    share = {leg: (100 * v / v.sum()).values for leg, v in cells.items()}
    pe = PE.set_index(['basket', 'set'])
    t2['saved'] = t2.fills_base - t2.fills_M
    dec = t4['decisions']; dec['pct'] = 100 * dec.changed / dec.decision_ticks
    def dch(plan, var, stat='median'): s = dec[(dec.plan == plan) & (dec.variant == var)].pct; return float(getattr(s, stat)())
    q = t4['quality'].set_index('leg'); fr = t4['usdc_fresh'].set_index('scope')
    # ---------------- T7 facts
    cc = c7['confirmado']; ca = c7['qualquer série']; ceil_ = cc['ceiling']; drec = cc['d_rec']; e_rec = cc['event']
    nr = cc['non_recovered']; dead = cc['dead_through_ceiling']
    ok7 = ev7[ev7.hourly_confirmed != False]
    def lvl(L): r = lv7[lv7.level_pct == L].iloc[0]; return int(r.events), int(r.recovered), int(r.not_recovered)
    ust = nr[nr.symbol == 'UST'].iloc[0]
    usdc_ev = ok7[(ok7.symbol == 'USDC') & (ok7.start.dt.year == 2023)].iloc[0]
    # input stable
    kk = ['event', 'product', 'cadence_h', 'n_ticks', 'start', 'split']
    base = in7[in7.band == 'sem pausa'].set_index(kk).value_usd
    def inp(ev_prefix, band):
        g = in7[in7.event.str.startswith(ev_prefix) & (in7.band == band)]
        v = g.set_index(kk).value_usd; j = pd.concat([v, base], axis=1, join='inner'); dd_ = (j.iloc[:, 0] - j.iloc[:, 1]) / 10
        return g, dd_
    rec_ev = ('USDC', 'DAI', 'USDT')
    gS, dS = zip(*[inp(e, 'sem pausa') for e in rec_ev]); g1_, d1_ = zip(*[inp(e, '1%') for e in rec_ev])
    gS = pd.concat(gS); g1_ = pd.concat(g1_); d1_ = pd.concat(d1_)
    gU0, _ = inp('UST', 'sem pausa'); gU1, dU1 = inp('UST', '1%'); gU72, dU72 = inp('UST', '1% · pausa máx. 72 h')
    svb = in7[in7.event.str.startswith(('USDC', 'DAI'))]
    _, dsvb = zip(*[inp(e, '1%') for e in ('USDC', 'DAI')]); dsvb = pd.concat(dsvb)
    # leg 3 worst case at the ceiling
    lab_c = [b for b in l37.band.unique() if 'sem aviso' in b][0]
    lab_c10 = [b for b in l37.band.unique() if b.startswith('80%')][0]
    u3 = l37[(l37.stable == 'UST') & (l37.band == lab_c)]; u3o = l37[(l37.stable == 'UST') & (l37.band == lab_c10)]
    co = c7['dono']; ceil_o = co['ceiling']; drec_o = co['d_rec']; nro = co['non_recovered']; deado = co['dead_through_ceiling']
    ust_o = nro[nro.symbol == 'UST'].iloc[0]
    ust_days50 = (pd.Timestamp(ust.crossed_50c_at) - pd.Timestamp(ust.start)).total_seconds() / 86400
    n_pass_drec_o = int(nro.passed_d_rec.astype(str).str.lower().eq('true').sum())
    n5, r5, nr5 = lvl(5.0); n10, r10, nr10 = lvl(10.0); n20, r20, nr20 = lvl(20.0); n50, r50, nr50 = lvl(50.0); n80, r80, nr80 = lvl(80.0)
    ust_now = 'menos de 0,01 USD' if float(ust.last_price) < 0.01 else f'{f(float(ust.last_price),4)} USD'
    mim = ca['event']
    days_hist = int((T7.DATA_END.normalize() - pd.Timestamp('2020-01-01')).days)
    c10 = lv7[lv7.level_pct == 10.0].iloc[0]
    warn_owner = f'«Nenhuma stable, nos últimos {f(days_hist,0)} dias, recuperou de uma queda de {f(drec_o,0)}%. Ainda assim, quer avançar?»'
    warn_band = (f'«A banda que escolheste deixa o Basket continuar a comprar esta stable até X% abaixo de 1 USD. Nos últimos {f(days_hist,0)} dias, das N stables que caíram mais de X%, só R recuperaram, e nenhuma recuperou de uma queda de {f(drec_o,0)}%. '
                 f'Se a stable não recuperar, podes perder até P% desta posição (o peso que lhe deste). Ainda assim, quer avançar?»')
    # ---------------- owner's 3-cycle rule
    RT = A.retry_table(d68)
    def rt(b, col, st=None):
        x = RT[(RT.basket == b) & ((RT.strategy == st) if st else True)]; return int(x[col].sum())
    need3, res3, closed3 = rt(A.POOL, 'need', 'A+'), rt(A.POOL, 'w1', 'A+') + rt(A.POOL, 'w2', 'A+') + rt(A.POOL, 'w3', 'A+'), rt(A.POOL, 'closed', 'A+')
    needS, resS, closedS = rt(A.BS, 'need', 'A+'), rt(A.BS, 'w1', 'A+') + rt(A.BS, 'w2', 'A+') + rt(A.BS, 'w3', 'A+'), rt(A.BS, 'closed', 'A+')
    nall = int(RT[RT.strategy == 'A+'].n.sum()); maxunb = float(RT.max_unbought_pct.max())
    dev3_other = int(G[G.basket.isin(A.B3)].dev_other_A.sum())

    # ================================================================== document
    d = Doc()
    d.h1('Basket DCA — modelação v3 (RESULTS-2026-11-v3)')
    d.p(f'**Da Analista para o Arquitecto.** Responde ao pedido `ANALISTA-basket-dca-modelacao-v3-2026-11-07.md`. Mede o **A+** — o A da v2 com quatro interruptores (P preço único, M mínimo por compra, E liquidação escalonada, B banda de peg) — e, como pediu o dono, **com o cesto de três voláteis como produto principal**: ETH + cbBTC + X, com X = VIRTUAL, COMP ou AERO. O cesto com stable (ETH + cbBTC + USDC) corre em todos os testes e aparece sempre em segundo lugar. Só janelas reais: S1–S7, âncora de Julho, Jul–Out 2026, a amostra de 5 anos e os 7 episódios horários. O `RESULTS-2026-11.md` da v2 não muda; um comando (`python3 run_all.py --no-fetch`) refaz v2 e v3. Com todos os interruptores desligados, o A+ reproduz o A da v2 compra a compra (teste no pacote).')
    d.callout(f'**Rev. 3 (7 Nov 2026, decisões do dono).** (1) O último ciclo sem preço espera até {RETRY_N} ciclos; se o preço não voltar, a ordem fecha com essa perna por comprar e o utilizador vê porquê num relatório no site; a stable de entrada nunca pausa. (2) Banda de peg: até {f(ceil_o,0)}% sem aviso; acima disso, um aviso único com o facto de que nenhuma stable recuperou de uma queda de {f(drec_o,0)}%. Ambas medidas na secção «Decisões do dono»; os números derivados dos dados (D_rec, tecto) ficam em T7 para referência.')
    d.callout('Separação de sempre: **(a)** a garantia — desvio face à divisão pedida, em pp; **(b)** o que aconteceu ao valor e ao preço — histórico, nunca promessa. Cada número tem o seu cenário ao lado; intervalos em mínimo / mediana / máximo.')
    d.h2('As oito respostas', 'respostas')
    x11 = vp.loc[(A.POOL, '2.11')]; s11 = vp.loc[(A.BS, '2.11')]
    a_t8 = (f'**Sim, a repartição é cumprida nas {f(n3,0)} posições de três voláteis** (2.1, 2.2, 2.3, 2.11 e §2.10, A+ e B+), nas três escolhas de X{"" if dev3_other == 0 else f" (excepto {dev3_other})"}. Em {need3} delas o último ciclo não tinha preço utilizável; com a regra do dono (esperar até {RETRY_N} ciclos) {"todas compraram num dos ciclos seguintes" if closed3 == 0 else f"{res3} compraram num dos ciclos seguintes e {closed3} fecharam com uma perna por comprar, explicada no relatório"}. '
            f'**A regra que se comporta pior é a 9.** Sem stable, uma queda forte protege as pernas todas ao mesmo tempo: protecção em {pct(ru.loc[A.POOL].prot_pos,0)} das posições (cesto com stable: {pct(ru.loc[A.BS].prot_pos,0)}), as três pernas protegidas em simultâneo em {pct(ru.loc[A.POOL].all3_pos,1)} (com stable: {pct(ru.loc[A.BS].all3_pos,1)}, só no colapso da UST), até {int(ru.loc[A.POOL].all3_run_max)} ciclos seguidos sem nenhuma perna elegível. O E (k = {K}, sem tecto) segura a concentração: maior compra única {pct(ru.loc[A.POOL].maxfill_max,1)} no pior caso com todos os interruptores (uma posição COMP semanal de 13 ciclos; ≤ 20% em todas as outras com 8 ou mais ciclos), contra {pct(t3v(A.POOL, THR, 1, 0.0, "mf6"),0)} sem o E. As regras 5 e 6 comportam-se como no cesto com stable. '
            f'**Valor (histórico):** A+ à frente de B+ em {pct(x11.A_B,0)} das {f(x11.n,0)} posições da amostra de 5 anos (mediana {f(x11.med,2)}%), e à frente do DCA só em ETH em {pct(x11.A_C,0)}. A «rotação de volatilidade» existe — quando duas pernas sobem e uma desce, o ciclo compra a que desceu em {pct(rot.loc[A.POOL].down_pct_of_bought,0)} dos ciclos em que compra — mas não compra mais barato: unidades a mais face ao B+ com mediana {f(rot.loc[A.POOL].uA_med,2)}%, igual à de uma rotação cega ({f(rot.loc[A.POOL].uR_med,2)}%). É ruído. '
            f'**Recomendo:** E com k = {K} no cesto de três voláteis; cadência mínima diária; e a regra dos {RETRY_N} ciclos do dono. A regra 4 não precisa de mudar — não acrescenta nem tira.')
    a_t1 = (f'**A (viii) mantém-se, ligeiramente mais fraca.** No cesto com stable, a regra 4 decide de outra forma numa minoria de ciclos (mediana 0 por posição; média {f(t1.chg_pct.mean(),1)}%; máximo {f(t1.chg_pct.max(),0)}%), porque USDC e BTC passam a decidir quase sempre pelo DefiLlama (USDC em {f(share["usdc"][1],0)}% dos ticks, BTC em {f(share["btc"][1],0)}%). Contra o DCA fixo, em posições de 30 dias: alta volatilidade {pct(float(rg_v2.iloc[0].win),1)} → {pct(float(rg_P.iloc[0].win),1)} à frente; normal {pct(float(rg_v2.iloc[1].win),1)} → {pct(float(rg_P.iloc[1].win),1)}. '
            f'No cesto de três voláteis o efeito é o mesmo e mais forte em X: os feeds de X têm heartbeat de 24 h, por isso X decide pelo DefiLlama em {pct(pe.loc[("ETH+cbBTC+VIRTUAL","2.11")].dl3,0)} (VIRTUAL), {pct(pe.loc[("ETH+cbBTC+COMP","2.11")].dl3,0)} (COMP) e 100% (AERO) dos ticks diários. **Com P, a diferença entre um X de fase 1 e um de fase 2 quase desaparece na cadência diária.** Sem nenhuma espera, {len(devP)} de {f(len(t1),0)} posições partiam a divisão por falta de preço no último ciclo; com a regra do dono (até {RETRY_N} ciclos), no cesto com stable {resS} de {needS} compraram num dos ciclos seguintes e nas outras {closedS} (UST, Mai 2022) o preço voltou com a stable fora da banda, por isso a perna ficou por comprar, como manda a banda.')
    a_t2 = (f'**Sim.** Com 16 USD (rota agregador), uma posição de 100 USD a 30–90 ciclos diários passa de {f(t2[(t2.capital==100)&(t2.route=="agregador")&(t2.cadence_d==1)].fills_base.median(),0)} para {f(t2[(t2.capital==100)&(t2.route=="agregador")&(t2.cadence_d==1)].fills_M.median(),0)} compras (mediana); com 1 000 USD quase não muda. Nenhuma compra fora do último ciclo ficou abaixo do mínimo (menor: {usd(t2[t2.route=="agregador"].min_fill_nonfinal.min(),2)} agregador, {usd(t2[t2.route=="canónica"].min_fill_nonfinal.min(),2)} canónica); o último ciclo, isento, chegou a comprar {usd(t2.min_fill_final.min(),2)}. Desvio máximo observado: {usd(t2.dev_usd.max(),4)} por perna (limite: 0,01 USD). Com todos os interruptores, nos três voláteis, o desvio ficou dentro do mesmo limite.')
    a_t3 = (f'**k = {K}, sem tecto.** No cesto de três voláteis, com a regra 9 a 25%, a maior compra única desce de {pct(t3v(A.POOL,THR,1,0.0,"mf6"),1)} (k = 1, a v2) para {pct(t3v(A.POOL,THR,K,0.0,"mf6"),1)}, com desvio 0 em todas as janelas com 6 ou mais ciclos (o pior: {t3w(A.POOL,THR,K,0.0)}). k = 5 falha por pouco ({pct(t3v(A.POOL,THR,5,0.0,"mf6"),1)}, mesma posição). '
            f'No cesto com stable, k = {K} dá {pct(t3v(A.BS,THR,K,0.0,"mf6"),1)} em S1 semanal (7 ciclos) e {pct(t3v(A.BS,THR,K,0.0,"mf8"),1)} a partir de 8 ciclos: **com 6–7 ciclos nenhuma combinação cumpre ≤ 20% com desvio 0 no cesto com stable**. O tecto não serve: sempre que trava, parte a divisão (até {pp(t3v(A.POOL,THR,1,0.10,"dev"),0)} com 10%). '
            f'Sem stable, as três pernas ficaram protegidas ao mesmo tempo em {all3_pos3} de {f(n3pos,0)} posições (até {run3} ciclos seguidos); com stable, em {int(ss.all3_pos)} de {f(ss.n,0)} (todas no colapso da UST).')
    usdc_age = float(fr.loc['horário'].median_age_s) / 3600
    a_t4 = (f'**O USDC/USD da Base existe e está registado** — no repo (última versão local, 50c142d) e on-chain no próprio OrderExecutorV3 da Base (`tokenUsdFeeds` → registado, maxStaleness 90 000 s). Mas é um feed de 24 h com desvio de 0,3%: a ronda tem em mediana {f(usdc_age,0)} h no tick e está acima de 600 s em {pct(float(fr.loc["horário"].pct_over_600),0)} das horas, por isso **com o preço único a perna stable e a banda de peg na Base decidem quase sempre pelo DefiLlama**. '
            f'ETH e cbBTC são bons inputs em cadência diária (decisões que mudam face à bolsa: mediana {f(dch("diário 00:00","só ETH do feed"),1)}% e {f(dch("diário 00:00","só cbBTC do feed"),1)}%, contra {f(v27_cl,0)}% do AERO na v2) e maus em cadência horária ({f(dch("horário (72 ciclos)","só ETH do feed"),0)}% e {f(dch("horário (72 ciclos)","só cbBTC do feed"),0)}%). Nenhum tem o problema do AERO em cadência diária.')
    a_t5 = (f'**Confirmado: 15 compras na rota agregador e 83 na canónica** pagam o gas com a fee de uma posição de 250 USD (0,25 USD ÷ 0,016 e ÷ 0,003). **Com M, a fee cobre o gas de todas as compras excepto as do último ciclo, que é isento**: a 250 USD o pior caso medido foi {usd(t2[(t2.capital==250)&(t2.route=="agregador")].gas_M.max(),3)} de gas para 0,25 USD de fee.')
    a_t6 = (f'Nas mesmas janelas e com as mesmas protecções, o A+ fez {f(fa3,0)} compras por posição de 30 dias contra {f(fb3,0)} do B+ ({usd((fb3-fa3)*x3.GAS["agregador"],2)} de gas a menos, rota agregador) e acabou com mais valor em {pct(allwin[A.POOL][1],0)} das {f(allwin[A.POOL][0],0)} posições de três voláteis ({pct(allwin[A.BS][1],0)} das {f(allwin[A.BS][0],0)} com stable), com diferença mediana de {f(allwin[A.POOL][2],2)}% do capital; a garantia da divisão é a mesma nos dois.')
    a_t7 = (f'**Os dados dão D_rec = {f(drec,1)}%** (FRAX no SVB, 11 Mar 2023, feed Chainlink hora a hora; USDC {f(float(usdc_ev.max_drop_pct),1)}% no mesmo evento) e, pela regra dos 5 pp, tecto {f(ceil_,1)}%. **Decisão do dono: banda até {f(ceil_o,0)}% sem aviso; acima, um aviso único:** {warn_owner} O facto confirma-se: desde 1 Jan 2020, {n80} stables (com ≥ 50 M USD em circulação) caíram {f(drec_o,0)}% ou mais e {r80} recuperaram. '
            f'Os {f(ceil_o,0)}% sem aviso ficam abaixo das maiores recuperações confirmadas (FRAX {f(drec,1)}%, USDC {f(float(usdc_ev.max_drop_pct),1)}%). **Uma ressalva:** o aviso fala de {f(drec_o,0)}%, mas quem escolhe, por exemplo, 20% está noutro sítio da história — das {n20} stables que caíram mais de 20%, só {r20} recuperaram. Proponho que o aviso diga também o número da banda escolhida (texto abaixo). A perda continua limitada ao peso da perna. '
            f'**Stable de entrada: sem pausa** (decidido). No SVB a pausa a 1% poupava o desconto (mediana {f(svb[svb.band=="sem pausa"].depeg_cost_pct.median(),2)}% → {f(svb[svb.band=="1%"].depeg_cost_pct.median(),2)}%) mas o valor final ficou pior em {pct(float((dsvb < -0.01).mean()*100),0)} das posições; na UST custava {f(dU1.median(),1)}% em mediana.')
    d.answers([('T8', 'Três voláteis como produto principal: a repartição é cumprida? Alguma regra pior?', a_t8),
               ('T1', 'Preço único (P): a conclusão (viii) muda?', a_t1), ('T2', 'Mínimo por compra (M): cumpre sem estragar a garantia?', a_t2),
               ('T3', 'Liquidação escalonada (E): que k e que tecto?', a_t3), ('T4', 'Feeds da Base: bons inputs para a regra 4?', a_t4),
               ('T5', 'Capital mínimo face ao cap de 250 USD', a_t5), ('T6', 'O que o A+ dá que o B+ não dá, em números', a_t6),
               ('T7', 'Banda de peg: D_rec, tecto e a stable de entrada', a_t7)])

    # ================================================================== owner's decisions (rev. 2)
    d.h2('Decisões do dono depois da v3 (rev. 2)', 'dono')
    d.h3(f'1. Último ciclo sem preço: esperar até {RETRY_N} ciclos, depois fechar e explicar')
    d.p(f'**Regra.** Se no último ciclo uma perna não tem preço utilizável (Chainlink com mais de 600 s e sem quórum), a ordem não fecha logo: tenta de novo nos {RETRY_N} ciclos seguintes, à cadência da ordem. No primeiro em que houver preço, compra o que falta a essa perna (e a banda de peg continua a valer nesse momento). Se nos {RETRY_N} não houver, a ordem fecha com essa perna por comprar; esse dinheiro fica com o utilizador e o relatório no site explica porquê. A stable de entrada nunca pausa. **Como foi simulado:** os {RETRY_N} ciclos seguintes ao fim de cada posição, com o mesmo preço de decisão (P) e execução ao preço do feed nesse ciclo; nos episódios horários, quando não temos o feed nessa hora, ao preço de decisão.')
    rows = []
    for _, r in RT.sort_values(['basket', 'strategy', 'cadence'], key=lambda c: c.map({A.POOL: 0, A.BS: 1}) if c.name == 'basket' else c).iterrows():
        if r.need == 0 and r.cadence not in ('diária', 'semanal'): continue
        rows.append([bshort(r.basket), r.strategy, r.cadence, f(r.n, 0), r.need, f'{r.w1} / {r.w2} / {r.w3}', r.closed_noprice, r.closed_band])
    d.table(['Cesto', 'Estratégia', 'Cadência', 'Posições', 'Último ciclo sem preço', 'Comprou no 1.º / 2.º / 3.º ciclo seguinte', 'Fechou por falta de preço', 'Preço voltou com a stable fora da banda (não compra, por desenho)'], rows,
            'Todas as posições de T6/T8 (2.1, 2.2, 2.3, 2.11, §2.10) · linhas horárias só onde houve casos', num_cols=[3, 4, 6, 7])
    cnp = rt(A.POOL, 'closed_noprice', 'A+') + rt(A.BS, 'closed_noprice', 'A+'); cbd = rt(A.POOL, 'closed_band', 'A+') + rt(A.BS, 'closed_band', 'A+')
    d.p(f'**Leitura.** Em {f(nall,0)} posições A+ (os dois cestos), o último ciclo ficou sem preço em {need3 + needS}. {"Nenhuma fechou por falta de preço" if cnp == 0 else f"{cnp} fecharam por falta de preço"}: o preço voltou no ciclo seguinte em quase todas (nas três voláteis, {rt(A.POOL, "w1", "A+")} no 1.º e {rt(A.POOL, "w3", "A+")} no 3.º). As {cbd} que ficaram com uma perna por comprar são todas a UST em Mai 2022: o preço voltou, mas a stable estava fora da banda, e a banda não a deixa comprar — é a banda a fazer o que deve, e é o mesmo relatório que o explica. Os casos vêm das lacunas do histórico do DefiLlama com o feed acima de 600 s; ao vivo, o quórum lê o DefiLlama e a CoinGecko no momento, por isso estes números são um limite superior.')
    d.p('**O relatório no site (proposta de conteúdo).** Um relatório de fecho para todas as ordens, que só fica longo quando alguma coisa correu fora do normal:')
    d.ul(['**Divisão pedida contra divisão cumprida**, por perna, em USD e em %.',
          '**Compras feitas**: data, perna, valor e preço de cada uma.',
          '**Ciclos sem compra e porquê**: sem preço fiável (feed com mais de 10 minutos e quórum indisponível), perna protegida pela regra 9, stable fora da banda de peg, compra abaixo do mínimo adiada para a seguinte (M).',
          f'**Se uma perna ficou por comprar**: quanto (USD e % da ordem), a razão em linguagem simples (por exemplo, «não houve um preço fiável para AERO no último ciclo nem nos {RETRY_N} seguintes»), as horas das {RETRY_N + 1} tentativas e onde está esse dinheiro (na carteira do utilizador, nunca gasto noutra perna).',
          'O mesmo formato serve para a perna stable que acaba fora da banda e para o modo rígido da regra 9, que também podem deixar dinheiro por investir.'])
    d.h3(f'2. Banda de peg: até {f(ceil_o,0)}% sem aviso; acima, um aviso')
    d.p(f'**Regra.** O utilizador escolhe a banda (1% por defeito). Até {f(ceil_o,0)}% não há aviso. Acima de {f(ceil_o,0)}%, um aviso único antes de criar a ordem: {warn_owner} Se recusar, a ordem não é criada. **X** = dias de histórico do inventário (de 1 Jan 2020 a 6 Nov 2026 são {f(days_hist,0)}); o número sai do mesmo script que faz o inventário e actualiza-se sozinho.')
    d.p(f'**O facto, medido.** Das stables com pelo menos 50 M USD em circulação, {n80} caíram {f(drec_o,0)}% ou mais desde 2020 e nenhuma recuperou (voltar a ≥ 0,99 e lá ficar 30 dias). A maior queda que recuperou foi {f(ca["d_rec"],0)}% ({mim.symbol}, {dmy(mim.start)}, ao fim de {f(mim.days_to_recover,0)} dias, vista só no agregador); confirmada em duas fontes, {f(drec,1)}%. '
        f'**Os {f(ceil_o,0)}% sem aviso:** ficam abaixo das maiores recuperações confirmadas (FRAX {f(drec,1)}% e USDC {f(float(usdc_ev.max_drop_pct),1)}% no SVB, ambas em 2 dias). Contando também as quedas vistas só no agregador, das {n10} stables que caíram mais de {f(ceil_o,0)}%, {r10} recuperaram.')
    rows = [[f'≥ {f(L,0)}%', *lvl(L)[:1], lvl(L)[1], lvl(L)[2], pct(100 * lvl(L)[1] / lvl(L)[0], 0) if lvl(L)[0] else '—'] for L in (5.0, 10.0, 20.0, 30.0, 50.0, 75.0, 80.0, 90.0)]
    d.table(['Queda', 'Stables que chegaram lá', 'Recuperaram', 'Não recuperaram', 'Recuperaram (%)'], rows,
            f'Desde 1 Jan 2020 ({f(days_hist,0)} dias), stablecoins em USD com ≥ 50 M USD em circulação no início da queda · é a tabela que alimenta o aviso', num_cols=[1, 2, 3, 4])
    d.p(f'**A ressalva da Analista.** O aviso, tal como está, diz a verdade para quem escolhe 80% ou mais. Para quem escolhe 20% ou 30%, a mesma frase pode ler-se como «até 80% costuma recuperar», e os dados dizem o contrário: das {n20} que caíram mais de 20%, recuperaram {r20}; das {n50} que caíram mais de 50%, {r50}. **Proposta**, com a mesma estrutura de uma pergunta: {warn_band} Com X = 20%: N = {n20}, R = {r20}; com X = 50%: N = {n50}, R = {r50}. A decisão é tua.')
    rows = []
    for _, r in nro.sort_values('max_drop_pct', ascending=False).iterrows():
        rows.append([r.symbol, dmy(r.start), 'sim' if str(r.confirmed).lower() == 'true' else 'só agregador', f(r.max_drop_pct, 1),
                     '—' if pd.isna(r.crossed_ceiling_at) else str(pd.Timestamp(r.crossed_ceiling_at))[:16], '—' if pd.isna(r.crossed_d_rec_at) else str(pd.Timestamp(r.crossed_d_rec_at))[:16],
                     '—' if pd.isna(r.crossed_ceiling_at) or pd.isna(r.crossed_d_rec_at) else f((pd.Timestamp(r.crossed_d_rec_at) - pd.Timestamp(r.crossed_ceiling_at)).total_seconds() / 86400, 1) + ' d',
                     f(r.last_price, 4), r.status])
    d.table(['Stable', 'Início', 'Confirmado', 'Queda máx. (%)', f'Passou −{f(ceil_o,0)}% (fim da banda sem aviso)', f'Passou −{f(drec_o,0)}%', 'Entre os dois', 'Último preço', 'Estado'], rows,
            'As stables que não recuperaram: quanto tempo uma banda de 10% ainda compraria (até passar −10%) e quanto demoraram a chegar a −80% (agregador: mínimo sustentado)', num_cols=[3, 6, 7])
    d.h3('3. Stable de entrada: sem pausa')
    d.p('Aceite. O Basket e o DCA de um token continuam a comprar enquanto a stable de entrada estiver descolada; a análise que levou à recomendação está em T7.')

    # ================================================================== §0.1 choice of X
    d.h2('Os X escolhidos (§0.1)', 'x')
    cov = xx.coverage().set_index('basket')
    xr = json.load(open(os.path.join(ROOT, 'data', 'series', 'v3', 'x_feeds.json')))
    rows = [['VIRTUAL', 'fase 1 (registado, enabled)', f'`{xr["VIRTUAL_base"]["proxy"]}` · VIRTUAL / USD · Base', dmy(cov.loc["ETH+cbBTC+VIRTUAL"].from_), 'Nativo da Base, o X de fase 1 com mais volume no catálogo; o mais volátil dos três'],
            ['COMP', 'fase 1 (registado, enabled)', f'`{xr["COMP_base"]["proxy"]}` · COMP / USD · Base; antes de Ago 2023 `{xr["COMP_mainnet"]["proxy"]}` (Ethereum)', dmy(cov.loc["ETH+cbBTC+COMP"].from_), 'O único X com histórico Chainlink que cobre 2022 (S1, S2, S3, S7 e os episódios E1–E4)'],
            ['AERO', 'fase 2 (feed existe, não registado)', f'`{xr["AERO_base"]["proxy"]}` · AERO / USD · Base (só para executar; a decisão é pelo quórum)', dmy(cov.loc["ETH+cbBTC+AERO"].from_), 'O perfil que pediste: sem feed na keeper, decide pelo quórum (DefiLlama aqui)']]
    d.table(['X', 'Fase', 'Feed (do registo do repo / directório; description() verificada on-chain)', 'Desde', 'Porquê'], rows,
            'Três X (o pedido dizia 3 a 5): os outros X de fase 1 do catálogo têm feeds com menos de um ano de histórico e não acrescentavam janelas reais')
    d.p(f'Uma janela entra num cesto só se as três pernas tiverem série Chainlink para a posição inteira; o resto vai para «não medido». BTC = cbBTC na Base quando existe, como na v2 (WBTC antes). Os feeds dos X têm heartbeat de 24 h e desvio de 0,5%; os preços de execução são os do feed, como na v2.')

    # ================================================================== T8
    d.h2('T8 — O cesto de três voláteis como produto principal', 't8')
    d.p(f'**Mecânica.** A+ = P + M (16 USD, rota agregador) + E (k = {K}, sem tecto, de T3) + regra 9 a 25% em modo suave; no cesto com stable, também B (banda 1%). B+ = DCA fixo de 3 pernas com exactamente as mesmas regra 9, E, M, P (e B). C = DCA só em ETH, mesmo capital e cadência. Todos com a regra do dono para o último ciclo sem preço (até {RETRY_N} ciclos; ver «Decisões do dono»).')
    d.h3('A garantia: desvio final')
    rows = []
    for b in xx.BASKETS:
        for st in ('2.1', '2.2', '2.3', '2.11', '2.10'):
            r = G[(G.basket == b) & (G.set == st)].iloc[0]
            if r.n == 0: continue
            rows.append([bshort(b), A.SETLAB[st], f(r.n, 0), f(r.dev_A, 2) if r.dev_A > 1e-6 else '0', f(r.dev_B, 2) if r.dev_B > 1e-6 else '0',
                         f'{r.pos_dev_A} ({r.band_pos_A} pela banda, {r.unb_A} por falta de preço)' if r.pos_dev_A else '0', f'{r.retry_A} / {r.retry_B}', f'{r.unb_A} / {r.unb_B}'])
    d.table(['Cesto', 'Janelas', 'Posições', 'Desvio máx. A+ (pp)', 'Desvio máx. B+ (pp)', 'Posições A+ com desvio', 'Último ciclo sem preço, A+ / B+', f'Fechou com perna por comprar ({RETRY_N} ciclos), A+ / B+'], rows,
            'Desvio = max |gasto na perna ÷ capital − peso pedido| · M deixa no máximo 0,01 USD por perna · fora disso, só a banda de peg (UST em Mai 2022, USDC em Mar 2023, por desenho) e a regra dos 3 ciclos do dono (perna por comprar, reportada) deixam desvio', num_cols=[2, 3, 4, 6, 7])
    d.h3('A+ contra B+ e contra o DCA só em ETH, por regime (histórico)')
    rows = []
    for (dur, cad, regm) in [(a, b, c) for a, b in (('30d', 1.0), ('90d', 1.0), ('90d', 7.0)) for c in ('alta volatilidade', 'normal')]:
        p_ = rp.loc[(dur, cad, regm)]; s_ = rs.loc[(dur, cad, regm)]
        rows.append([durlab(dur, cad), regm, f(p_.n, 0), pct(p_.A_B, 1), pct(p_.A_C, 1), pct(p_.both, 1), f'{f(p_.med,2)}% ({f(p_.p5,1)} / {f(p_.p95,1)})',
                     pct(s_.A_B, 1), f'{f(s_.med,2)}%'])
    d.table(['Posições', 'Regime', 'n (3 voláteis)', 'A+ > B+', 'A+ > só ETH', 'A+ > ambos', 'A+ − B+ mediana (P5 / P95)', 'Com stable: A+ > B+', 'Com stable: mediana'], rows,
            f'Amostra de 5 anos (início diário desde 31 Mar 2022, ou desde que X tem feed) · «alta volatilidade» = 25% das janelas com o ETH mais volátil, em cada cesto e duração · empate (< 0,01%) não conta como vitória', num_cols=[2, 3, 4, 5, 7])
    rows = []
    for b in (A.POOL,) + A.B3 + (A.BS,):
        for st in ('2.1', '2.2', '2.3', '2.10'):
            if (b, st) not in vp.index: continue
            r = vp.loc[(b, st)]
            rows.append([bshort(b), A.SETLAB[st], f(r.n, 0), pct(r.A_B, 0), pct(r.A_C, 0), f'{f(r.med,2)}% ({f(r.mn,1)} / {f(r.mx,1)})'])
    d.table(['Cesto', 'Janelas', 'Posições', 'A+ > B+', 'A+ > só ETH', 'A+ − B+ mediana (mín. / máx.)'], rows, 'As outras janelas, por X', num_cols=[2, 3, 4])
    d.p(f'**Leitura.** Com três voláteis o A+ e o B+ continuam empatados no agregado ({pct(x11.A_B,0)} contra {pct(x11.B_A,0)} na amostra de 5 anos; com stable {pct(s11.A_B,0)} contra {pct(s11.B_A,0)}), com mais dispersão (P5/P95 de {f(x11.p5,1)}% / {f(x11.p95,1)}%, contra {f(s11.p5,1)}% / {f(s11.p95,1)}% com stable). Em alta volatilidade e 90 dias o A+ ficou atrás mais vezes ({pct(rp.loc[("90d",1.0,"alta volatilidade")].A_B,0)} diária, {pct(rp.loc[("90d",7.0,"alta volatilidade")].A_B,0)} semanal): é o regime em que a regra 9 protege as três pernas e empurra compras para o fim. Em Jul–Out 2026 o A+ ficou à frente em {pct(vp.loc[(A.POOL,"2.3")].A_B,0)}: um período, não uma tendência.')
    d.h3('A «rotação de volatilidade», medida')
    rows = []
    for b in (A.POOL,) + A.B3 + (A.BS,):
        r = rot.loc[b]
        rows.append([bshort(b), f(r.ticks, 0), pct(r.A_down_pct_ticks, 0), pct(r.down_pct_of_bought, 0), pct(r.rot_down_pct, 0),
                     f'{f(r.uA_med,2)}% ({f(r.uA_p5,1)} / {f(r.uA_p95,1)})', f'{f(r.uR_med,2)}% ({f(r.uR_p5,1)} / {f(r.uR_p95,1)})'])
    d.table(['Cesto', 'Ciclos com 2 a subir e 1 a descer', 'A+ comprou a que desceu (% desses ciclos)', '… dos ciclos em que comprou', 'Rotação cega comprou a que desceu', 'A+: unidades a mais face a B+, mediana (P5 / P95)', 'Rotação cega: o mesmo'], rows,
            'Todas as posições (2.1, 2.2, 2.3, 2.11, §2.10) · «unidades a mais» = Σ peso × (preço médio B+ ÷ preço médio A+ − 1): com a divisão cumprida, é exactamente quanto mais barato o A+ comprou · rotação cega = o sinal «rotação» da §2.12 (perna da vez, sem olhar ao preço)', num_cols=[1, 2, 3, 4])
    d.p(f'**Leitura.** O mecanismo faz o que diz: quando duas pernas sobem e uma desce, compra a que desceu em cerca de {pct(rot.loc[A.POOL].down_pct_of_bought,0)} dos ciclos em que compra (nos outros, a perna que desceu estava em cooldown, bloqueada pela regra 6 ou protegida). Mas isso não se traduz em comprar mais barato do que o B+: a mediana é {f(rot.loc[A.POOL].uA_med,2)}%, e a rotação cega, que não olha para o preço, dá {f(rot.loc[A.POOL].uR_med,2)}%. Com três voláteis, «a perna que desceu neste ciclo» não é «a perna que está barata para o resto da posição»: a variação de um ciclo não prevê a seguinte. É ruído, como na §2.12.')
    d.h3('Drawdown máximo da posição, contra o cesto com stable (histórico)')
    rows = []
    for _, r in DDP.iterrows():
        rows.append([bshort(r.basket), A.SETLAB[r.set], f(r.n, 0), f'{f(r.mdd_x_med,1)}% / {f(r.mdd_x_max,1)}%', f'{f(r.mdd_s_med,1)}% / {f(r.mdd_s_max,1)}%', pct(r.deeper_pct, 0), f'{f(r.diff_med,1)} pp (P95 {f(r.diff_p95,1)})'])
    d.table(['Cesto', 'Janelas', 'Pares', 'Drawdown 3 voláteis (mediana / máx.)', 'Drawdown com stable (mediana / máx.)', 'Mais fundo com 3 voláteis', 'Diferença mediana'], rows,
            'A+ nos dois cestos, mesma janela, divisão e cadência · drawdown = maior queda do valor da posição (comprado + por investir) face ao máximo anterior', num_cols=[2, 5])
    d.p(f'Sem surpresa: trocar a perna stable por um volátil aprofunda o drawdown em quase todas as posições (mediana de {f(dd11.mdd_x_med.min(),0)}–{f(dd11.mdd_x_med.max(),0)}% contra {f(dd11.mdd_s_med.median(),0)}% na amostra de 5 anos). É o custo de ter três voláteis, não um defeito do mecanismo; convém dizê-lo no produto.')
    d.h3('O X sem feed (fase 2): quórum contra referência')
    rows = [[sc_, r.from_, f(r.ticks, 0), f'{r.no_quorum} ({pct(r.no_quorum_pct,2)})', f'{f(r.median_bps,0)} / {f(r.p95_bps,0)} / {f(r.max_bps,0)}', f'{r.over_300bps} ({pct(r.over_300bps_pct,2)})'] for sc_, r in av.iterrows()]
    d.table(['Leitura', 'Desde', 'Leituras', 'Sem quórum (sem ponto DefiLlama a ≤ 1 h)', 'Diferença absoluta quórum–Coinbase, mediana / P95 / máx. (bps)', '> 300 bps (falharia a tolerância do ADR-024)'], rows,
            'AERO como a keeper o leria na fase 2 (sem perna Chainlink): quórum aproximado pelo DefiLlama · referência = Coinbase AERO-USD, abertura da hora', num_cols=[2, 3, 5])
    rows = []
    for st, lab in (('2.1', 'S1–S7 (diária/semanal)'), ('2.3', 'Jul–Out 2026 (diária/semanal)'), ('2.11', 'amostra desde Abr 2024 (diária/semanal)')):
        p_, s_ = dcp(st)
        rows.append([lab, f(len(s_),0), f'{f(s_.pct.median(),1)} / {f(p_,1)} / {f(s_.pct.max(),0)}', int(s_.skipped_leg.sum()), f(s_.dev_pp.max(), 2)])
    for var in ('só AERO pelo quórum', 'como a keeper (feeds Base + quórum AERO)'):
        p_, s_ = dcp('horário Jul–Out 2026', var)
        rows.append([f'horário, 72 ciclos · {var}', f(len(s_),0), f'{f(s_.pct.median(),1)} / {f(p_,1)} / {f(s_.pct.max(),0)}', int(s_.skipped_leg.sum()), f(s_.dev_pp.max(), 2)])
    d.table(['Posições', 'n', 'Decisões da regra 4 que mudam face à referência, % (mediana / total / máx.)', 'Ciclos em que AERO saltou por falta de quórum', 'Desvio máx. (pp)'], rows,
            f'Cesto ETH + cbBTC + AERO · comparar com a v2 (§2.7, cesto com stable): AERO pelo feed Chainlink {f(v27_cl,1)}%, pelo DefiLlama {f(v27_dl,2)}%', num_cols=[1, 3, 4])
    d.p(f'**Leitura.** O quórum para AERO está quase sempre disponível ({av.loc["horário"].no_quorum} horas sem ponto em {f(av.loc["horário"].ticks,0)}) e concorda com a bolsa (mediana {f(av.loc["horário"].median_bps,0)} bps). Em cadência diária muda poucas decisões; com três voláteis muda mais do que com stable ({f(dcp("2.11")[0],1)}% contra {f(v27_dl,2)}% na v2), porque as três pernas variam por quantidades parecidas e um desvio de 20 bps chega para trocar a ordem. Em cadência horária muda {f(dcp("horário Jul–Out 2026","só AERO pelo quórum")[0],0)}% das decisões: o mesmo problema dos feeds da Base em T4. Mais um argumento para a cadência mínima diária.')
    d.h3('As regras, uma a uma: três voláteis contra o cesto com stable')
    rows = []
    for b in (A.POOL,) + A.B3 + (A.BS,):
        r = ru.loc[b]
        rows.append([bshort(b), f(r.n, 0), pct(r.cooldown_per_cycle, 0), f(r.locks_early, 2), pct(r.prot_pos, 0), pct(r.all3_pos, 1), int(r.all3_run_max),
                     f'{f(r.final_med,1)} / {f(r.final_p95,1)} / {f(r.final_max,1)}', pct(r.maxfill_max, 1)])
    d.table(['Cesto', 'Posições (≥ 6 ciclos)', 'Regra 5: ciclos com cooldown activo', 'Regra 6: pernas fechadas antes do fim (média)', 'Regra 9: posições com protecção', 'Regra 9: as três protegidas', 'Regra 9: ciclos seguidos sem perna elegível (máx.)', 'Último ciclo, % do capital (mediana / P95 / máx.)', 'Maior compra única'], rows,
            f'A+ completo (P + M + E k = {K} + regra 9 a 25%, suave) em todas as janelas', num_cols=[1, 2, 3, 4, 5, 6, 8])
    d.p(f'**O que muda.** As regras 5 e 6 comportam-se igual nos dois cestos. **A regra 9 é a que piora**: com uma stable, a perna stable nunca é protegida e o ciclo tem sempre onde comprar; com três voláteis, uma queda geral protege tudo e o dinheiro acumula ({pct(ru.loc[A.POOL].all3_pos,1)} das posições, até {int(ru.loc[A.POOL].all3_run_max)} ciclos seguidos). O E absorve a maior parte do efeito — a maior compra única ficou em {pct(ru.loc[A.POOL].maxfill_max,1)} no pior caso (uma posição COMP semanal de 13 ciclos, Abr–Jul 2022) e o último ciclo no P95 em {pct(ru.loc[A.POOL].final_p95,1)} do capital. **Recomendação:** manter a regra 9 a 25% com E k = {K} no cesto de três voláteis. Se o dono quiser menos concentração, o parâmetro que mexe é o limiar: a 30% as posições com as três protegidas caem de {all3_pos3} para {int(T3S[T3S.basket.isin(A.B3) & (T3S.threshold == 0.30)].all3_pos.sum())} (em {f(n3pos,0)}).')

    # ================================================================== T1
    d.h2('T1 — Preço único (interruptor P)', 't1')
    d.p('**Como foi medido.** Por perna e por tick: Chainlink se a ronda lida tiver ≤ 600 s; senão o ponto DefiLlama mais próximo do tick (até 1 hora) — aproximação declarada do quórum, porque a CoinGecko não tem histórico sem chave; senão a perna fica fora do ciclo. Execução e valor continuam ao preço do feed, como na v2: P só muda decisões. As tabelas de T1 são do cesto com stable (o pedido); a linha do cesto de três voláteis está no fim.')
    rows = []
    for st in ('2.1', '2.3', '2.11'):
        s = t1[t1.set == st]
        rows.append([st, len(s), f'{f(s.chg_pct.median(),1)} / {f(s.chg_pct.mean(),1)} / {f(s.chg_pct.max(),1)}', int(s.decisions_changed.max()), int(s.skipped_all.sum()), int((s.dev_P > 1e-6).sum()), f(s.dev_P.max(), 2)])
    d.table(['Conjunto', 'Posições', 'Decisões que mudam, % dos ciclos (mediana / média / máx.)', 'Máx. por posição', 'Ciclos saltados (nenhuma perna com preço)', 'Posições com desvio (sem nenhuma espera no último ciclo)', 'Desvio máx. (pp)'], rows,
            'Cesto com stable · A+P contra o A da v2 (feed lido sem limite de idade), mesmas posições', num_cols=[1, 3, 4, 5, 6])
    rows = []
    lab = {'eth': 'ETH (Chainlink · Arbitrum)', 'btc': 'BTC (cbBTC · Base / WBTC · Arbitrum / WBTC·BTC × BTC · Ethereum)', 'usdc': 'USDC (Chainlink · Arbitrum)'}
    for leg in ('eth', 'btc', 'usdc'):
        v = cells[leg]; rows.append([lab[leg], f(v.sum(), 0), pct(share[leg][0], 1), pct(share[leg][1], 1), pct(share[leg][2], 2)])
    d.table(['Perna', 'Leituras', 'Chainlink fresco (≤ 600 s)', 'DefiLlama', 'Sem preço'], rows, 'De onde veio o preço de decisão, em todos os ticks de T1', num_cols=[1, 2, 3, 4])
    rows = [[durlab(r.duration, r.cadence_d), r.regime, r.n, pct(r.win, 1), pct(rq.win, 1), f(r.med, 3) + '%', f(rq.med, 3) + '%'] for (_, r), (_, rq) in zip(rg_v2.iterrows(), rg_P.iterrows())]
    d.table(['Posições', 'Regime', 'n', 'A > B (v2)', 'A+P > B', 'Mediana A − B (v2)', 'Mediana A+P − B'], rows, '§2.11 refeita com o preço único · B = DCA fixo, mesma divisão', num_cols=[2, 3, 4, 5, 6])
    rows = []
    for b in xx.BASKETS:
        for st in ('2.1', '2.3', '2.11', '2.10'):
            if (b, st) not in pe.index: continue
            r = pe.loc[(b, st)]
            rows.append([bshort(b), A.SETLAB[st], f(r.n, 0), f'{f(r.med,1)} / {f(r["mean"],1)} / {f(r.mx,0)}', f'{pct(r.cl3,0)} / {pct(r.dl3,0)} / {pct(r.none3,2)}', int(r.skipped_all)])
    d.table(['Cesto', 'Janelas', 'Posições', 'Decisões que mudam com P, % (mediana / média / máx.)', 'Perna 3: Chainlink / DefiLlama / sem preço', 'Ciclos saltados'], rows,
            'O mesmo efeito com todos os interruptores ligados, nos dois cestos (A+ contra A+ sem P)', num_cols=[2, 5])
    d.p(f'**Leitura.** O preço único não muda o sentido da (viii): o Basket continua sem vantagem sistemática sobre o DCA fixo. Sem espera, um último ciclo sem preço parte a garantia ({len(devP)} posições em {f(len(t1),0)} no cesto com stable). Com a regra do dono (até {RETRY_N} ciclos, já simulada em T6–T8) fica resolvido, ou fica a perna por comprar e explicada — ver «Decisões do dono». As lacunas vêm do histórico do DefiLlama; ao vivo podem não existir.')

    # ================================================================== T2
    d.h2('T2 — Mínimo por compra (interruptor M)', 't2')
    rows = []
    for (C, route, cad), s in t2.groupby(['capital', 'route', 'cadence_d']):
        rows.append([f'{C} USD', route, cadlab(cad), len(s), f'{f(s.fills_base.median(),0)} → {f(s.fills_M.median(),0)}', f'{f(s.saved.median(),0)} / {f(s.saved.max(),0)}',
                     usd(s.min_fill_nonfinal.min(), 2), usd(s.min_fill_final.min(), 2), usd(s.dev_usd.max(), 4)])
    d.table(['Capital', 'Rota (mínimo)', 'Cadência', 'Posições', 'Compras (mediana) sem → com M', 'Poupadas (mediana / máx.)', 'Menor compra fora do último ciclo', 'Menor compra no último ciclo (isento)', 'Desvio máx. por perna'], rows,
            'Janelas 2.1 e 2.3, cesto com stable · mínimo = 3 USD (canónica) ou 16 USD (agregador) · o último ciclo compra tudo o que for ≥ 0,01 USD', num_cols=[3, 4, 5, 6, 7, 8])
    d.p('**Leitura.** O M elimina as compras que não pagam o próprio gas e não toca na garantia. O efeito concentra-se nas posições pequenas com muitos ciclos; numa posição de 1 000 USD quase nunca actua. O teste do motor confirma o limite de 0,01 USD por perna nos dois cestos.')

    # ================================================================== T3
    d.h2('T3 — Liquidação escalonada (interruptor E)', 't3')
    d.p(f'**Como foi medido.** Modo suave, só E ligado (P, M e B desligados, para isolar o efeito). Nos últimos k ciclos, o capital adiado pela regra 9 é comprado em parcelas iguais do que falta (repartidas pelo que falta a cada perna), em vez de todo no último ciclo; o ciclo normal continua. k = 1 é exactamente a v2. O tecto limita cada compra a uma % do capital; o que o tecto impedir no último ciclo fica por investir e é contado. Janelas: S1–S7 (4 repartições × diária/semanal × 2 durações) e os 7 episódios horários, **primeiro no cesto de três voláteis** (os três X juntos, {f(n3pos,0)} posições), depois no cesto com stable ({f(ss.n,0)}).')
    d.chart('G1-maior-compra-k-tecto', f'Gráfico G1 · Maior compra única por k × tecto, regra 9 a 25%, posições com 6 ou mais ciclos — três voláteis em cima, com stable em baixo')
    for grp in (A.POOL, A.BS):
        rows = []
        for thr in (0.20, 0.25, 0.30):
            for k in (1, 3, 5, 10):
                for cap in (0.0, 0.10, 0.20, 0.33):
                    rows.append([pct(thr * 100, 0), k, 'sem' if cap == 0 else pct(cap * 100, 0), pct(t3v(grp, thr, k, cap, 'mf6'), 1), pct(t3v(grp, thr, k, cap, 'mf8'), 1),
                                 f(t3v(grp, thr, k, cap, 'dev'), 1), f(t3v(grp, thr, k, cap, 'unin'), 1)])
        d.table(['Limiar', 'k', 'Tecto', 'Maior compra (≥ 6 ciclos)', 'Maior compra (≥ 8 ciclos)', 'Desvio máx. (pp)', 'Por investir máx. (%)'], rows, bshort(grp), num_cols=[1, 3, 4, 5, 6])
    rows = []
    for b in xx.BASKETS:
        for thr in (0.20, 0.25, 0.30):
            r = sim.loc[(b, thr)]
            rows.append([bshort(b), pct(thr * 100, 0), f(r.n, 0), pct(r.prot * 100, 0), f'{int(r.all3_pos)} ({pct(100*r.all3_pos/r.n,1)})', int(r.all3_max), int(r.run_max), f'{f(r.final_med,1)} / {f(r.final_max,1)}'])
    d.table(['Cesto', 'Limiar', 'Posições', 'Com alguma perna protegida', 'Com as três protegidas ao mesmo tempo', 'Ciclos com as três protegidas (máx.)', 'Seguidos (máx.)', 'Último ciclo com k = 1, % do capital (mediana / máx.)'], rows,
            'Quantas vezes a regra 9 protege as três pernas ao mesmo tempo, e por quanto tempo (k = 1, sem tecto: a protecção não depende de k)', num_cols=[2, 3, 5, 6])
    d.p(f'**Recomendação: k = {K}, sem tecto.** É a combinação mais simples (um parâmetro) que mantém a maior compra ≤ 20% com desvio 0 em todas as janelas do cesto de três voláteis com 6 ou mais ciclos, aos três limiares. Abaixo de 6 ciclos o limite é impossível por construção (um ciclo normal já é C/N). No cesto com stable, k = {K} cumpre a partir de 8 ciclos; com 6–7 ciclos o melhor medido é {pct(t3v(A.BS,THR,K,0.0,"mf6"),1)} ({t3w(A.BS,THR,K,0.0)}). Se a spec exigir ≤ 20% também aí, a forma limpa é um mínimo de 8 ciclos quando a regra 9 está activa — não um tecto. O custo de k = {K}: nos últimos {K} ciclos a protecção da regra 9 deixa de travar a compra adiada. **Histórico (b):** repartir a compra adiada mudou o preço médio das pernas adiadas face a k = 1 em mediana {f(dp.median(),2)}% (de {f(dp.min(),1)}% a {f(dp.max(),1)}%): o objectivo do E é limitar o tamanho da compra, não o preço.')
    a_, b_, _ = ex.stress_windows()['S1']; td = ticks(a_, 1, end=b_)
    m = xx.mats(('ETH', 'BTC', 'COMP'), td, 1); w = SPLITS['33-33-33']
    r1 = run_plus(m['Pe'], w, p0=m['p0'], dd=THR, mode='soft', k=1); rK = run_plus(m['Pe'], w, p0=m['p0'], dd=THR, mode='soft', k=K)
    names = ['ETH', 'WBTC' if 'WBTC' in m['sources'][1] else 'cbBTC', 'COMP']
    ch3.g2_s1(m, r1, rK, THR, K, names, 'ETH + WBTC + COMP')
    d.chart('G2-liquidacao-k1-vs-kN-S1', f'Gráfico G2 · S1, três voláteis, modo suave a 25%: com k = 1 a maior compra é {f(r1.max_fill_pct,1)}% do capital; com k = {K}, {f(rK.max_fill_pct,1)}% — mesma divisão final')

    # ================================================================== T4
    d.h2('T4 — Feeds da Base', 't4')
    rows = [[t['symbol'], f'`{t["token"]}`', f'`{t["feed"]}`', 'sim' if t['registered'] else 'NÃO', 'sim' if t['repo_feed_equal'] else 'não', 'sim' if t['repo_enabled'] else 'não', f(t['maxStaleness'], 0)] for t in reg['tokens']]
    d.table(['Token', 'Endereço (catálogo)', 'Feed no executor', 'Registado on-chain', 'Igual ao repo', 'enabled no repo', 'maxStaleness (s)'], rows,
            f'OrderExecutorV3 da Base `{reg["executor"]}` (de docs/DEPLOYMENTS.md; {f(reg["code_bytes"],0)} bytes de código; domainSeparator() e ORDER_TYPEHASH() respondem) · tokenUsdFeeds lido a 7 Nov 2026')
    d.p('**Sobre «commit actual»**: a cópia local do repo foi actualizada pela última vez a 11 Out (origin/main 50c142d) e não tenho acesso ao GitHub a partir daqui. Confirmei no sítio que manda: o registo on-chain do próprio executor da Base. Os três feeds estão registados e são os mesmos do repo (igualdade calculada) e do directório da Chainlink; os três confirmaram description() e decimals().')
    rows = []
    for _, r in t4['params'].iterrows():
        rows.append([r.feed, '—' if pd.isna(r.directory_threshold_pct) else pct(r.directory_threshold_pct, 2), f(r.registry_heartbeat_s, 0), f(r.median_gap_s, 0), pct(r.share_heartbeat_updates_pct, 0), pct(r.empirical_min_step_pct, 2)])
    d.table(['Feed', 'Limiar de desvio (directório)', 'Heartbeat (s)', 'Intervalo mediano entre rondas (s)', 'Rondas por heartbeat', 'Menor passo medido entre rondas (P5)'], rows,
            'Parâmetros. O ETH/USD canónico da Base já não aparece no directório: o limiar vem do menor passo medido em rondas consecutivas', num_cols=[1, 2, 3, 4, 5])
    rows = [[r.feed, r.scope, r.from_, f(r.n, 0), f(r.median_age_s / 3600, 1) + ' h', f(r.p90_age_s / 3600, 1) + ' h', f(r.max_age_h, 1) + ' h', pct(r.pct_over_600, 1)] for _, r in t4['usdc_fresh'].iterrows()]
    d.table(['Feed', 'Leitura', 'Desde', 'Leituras', 'Idade mediana', 'P90', 'Máx.', '> 600 s'], rows, 'Frescura do USDC/USD da Base no momento do tick (todas as rondas desde Ago 2023)', num_cols=[3, 4, 5, 6, 7])
    rows = [[r.scope, f(r.n, 0), pct(r.band_pct, 1), r.outside, f(r.min_price, 5)] for _, r in t4['usdc_band'].iterrows()]
    d.table(['Leitura', 'Leituras', 'Banda', 'Fora da banda', 'Preço mínimo lido'], rows, 'Calibração da banda com o USDC/USD da Base, Ago 2023 – Nov 2026', num_cols=[1, 3, 4])
    rows = [[r.Index, f(r.hours, 0), f(r.median_abs_bps, 2), f(r.p95_abs_bps, 2), f(r.max_abs_bps, 1), pct(r.feed_unchanged_hour_pct, 0)] for r in q.itertuples()]
    d.table(['Perna', 'Horas', 'Diferença absoluta feed–bolsa, mediana (bps)', 'P95', 'Máx.', 'Horas em que o feed não mudou'], rows,
            'Feed da Base vs bolsa, hora a hora, Jul–Nov 2026 · referências: Coinbase ETH-USD, Coinbase BTC-USD (para o cbBTC), Bitstamp USDC/USD', num_cols=[1, 2, 3, 4, 5])
    rows = []
    for plan in ('diário 00:00', 'semanal 00:00', 'horário (72 ciclos)'):
        for var in ('só ETH do feed', 'só cbBTC do feed', 'só USDC do feed', 'as três do feed'):
            s = dec[(dec.plan == plan) & (dec.variant == var)]
            if len(s): rows.append([plan, var, len(s), f'{f(s.pct.median(),1)} / {f(s.pct.mean(),1)} / {f(s.pct.max(),1)}', f(s.dev_pp.max(), 2)])
    d.table(['Cadência', 'O que vem do feed (o resto da bolsa)', 'Posições', 'Decisões da regra 4 que mudam face à bolsa, % (mediana / média / máx.)', 'Desvio máx. (pp)'], rows,
            f'Posições a começar em cada dia de 1 Jul a 15 Out 2026 (30/60/90 d) e, na cadência horária, a cada 12 h até 3 Nov · comparar com {f(v27_cl,0)}% do feed AERO na v2', num_cols=[2, 3, 4])
    d.p('**Leitura e decisão que é tua.** Em cadência diária ou semanal os três feeds servem. Em cadência horária ETH e cbBTC não servem como sinal: a variação de uma hora é do tamanho do limiar de desvio do feed. **O ponto que precisa da tua decisão:** com a regra dos 600 s, a perna USDC e a banda de peg na Base nunca usam o feed (está sempre «velho» pela regra, apesar de estar dentro do seu limiar de 0,3%). As alternativas são aceitar o DefiLlama (o quórum continua a apanhar um depeg) ou, só para stables, aceitar o feed até ao maxStaleness que o executor já usa on-chain (90 000 s).')

    # ================================================================== T5
    d.h2('T5 — Capital mínimo face ao cap de 250 USD', 't5')
    g9 = pd.read_csv(os.path.join(ROOT, 'results', 'sec_2_9.csv')); g9 = g9[(g9['mode'] == 'sem regra 9') & (g9.strategy == 'A')]
    rows = []
    for cad in (1, 7):
        for n in sorted(g9[g9.cadence_d == cad].n_ticks.unique()):
            s = g9[(g9.cadence_d == cad) & (g9.n_ticks == n)].iloc[0]
            mm = t2[(t2.capital == 250) & (t2.cadence_d == cad) & (t2.n_ticks == n)]
            row = [cadlab(cad), int(n), int(s['max'])]
            for route, gas in x3.GAS.items():
                row.append(('sim' if s['max'] * gas <= 0.25 else 'não') + f' ({f(s["max"]*gas,3)})')
                mr = mm[mm.route == route]
                row.append(('—' if mr.empty else (('sim' if mr.gas_M.max() <= 0.25 else 'não') + f' ({f(mr.gas_M.max(),3)}, {int(mr.fills_M.max())} compras)')))
            rows.append(row)
    d.table(['Cadência', 'Ciclos', 'Compras (máx., sem M)', 'Canónica 0,003 USD: cobre?', 'Canónica com M (3 USD)', 'Agregador 0,016 USD: cobre?', 'Agregador com M (16 USD)'], rows,
            'Posição de 250 USD → fee de 0,25 USD · entre parêntesis: gas da posição no pior caso · com M, só para os ciclos medidos em T2', num_cols=[1, 2])
    d.p('As colunas «tier do keeper» da §2.9 descreviam o estado anterior a 627bb60 e foram retiradas. **O custo real de um fill pós-correcção não foi medido**: os RPCs públicos da Base não servem logs antigos sem token.')

    # ================================================================== T6
    d.h2('T6 — A+ contra B+', 't6')
    d.p(f'**A+** = A com P, M (16 USD), E (k = {K}, sem tecto), regra 9 a 25% em modo suave (+ B, banda 1%, no cesto com stable). **B+** = DCA fixo de 3 pernas (cada ciclo compra a proporção de cada perna elegível; sem regras 4, 5 e 6) com exactamente as mesmas protecções. Mesmo capital (1 000 USD), mesmas janelas, mesmas cadências. **Três voláteis primeiro.**')
    for b in (A.POOL, A.BS):
        bs = A.B3 if b == A.POOL else (b,)
        rows = []
        for st in ('2.1', '2.3', '2.11', '2.10'):
            x = d68[d68.basket.isin(bs) & (d68.set == st)]
            Ax, Bx = x[x.strategy == 'A+'], x[x.strategy == 'B+']
            r = vp.loc[(b, st)]
            rows.append([A.SETLAB[st], f(len(Ax), 0), f'{f(Ax.dev_pp.max(),1)} / {f(Bx.dev_pp.max(),1)}', f'{f(Ax.unin_pct.median(),1)} / {f(Bx.unin_pct.median(),1)}',
                         f'{f(Ax.max_fill_pct.max(),1)} / {f(Bx.max_fill_pct.max(),1)}', f'{f(Ax.n_fills.median(),0)} / {f(Bx.n_fills.median(),0)}',
                         f'{f(Ax.gas_agg.median(),2)} / {f(Bx.gas_agg.median(),2)}', pct(r.A_B, 0), f'{f(r.med,2)}%'])
        d.table(['Amostra', 'Posições', 'Desvio máx. A+ / B+ (pp)', 'Por investir mediano A+ / B+ (%)', 'Maior compra A+ / B+ (%)', 'Compras (mediana) A+ / B+', 'Gas mediano A+ / B+ (USD, agregador)', 'A+ à frente', 'A+ − B+ mediana'], rows,
                bshort(b) + (' · os desvios vêm da banda de peg (UST, USDC), iguais em natureza nos dois' if b == A.BS else ''), num_cols=[1, 7, 8])
    rows = []
    for b in (A.POOL, A.BS):
        rr = RG[RG.basket == b]
        for _, r in rr.iterrows():
            rows.append([bshort(b), durlab(r.duration, r.cadence_d), r.regime, f(r.n, 0), pct(r.A_B, 1), f(r.med, 2) + '%', f'{f(r.p5,1)} / {f(r.p95,1)}'])
    d.table(['Cesto', 'Posições', 'Regime', 'n', 'A+ à frente de B+', 'Mediana A+ − B+', 'P5 / P95 (%)'], rows, 'Amostra de 5 anos por regime de volatilidade', num_cols=[3, 4, 5])
    groups = [('Três voláteis (VIRTUAL, COMP, AERO juntos)', None)]
    for (dur, cad) in (('30d', 1.0), ('90d', 1.0), ('90d', 7.0)):
        for regm in ('alta volatilidade', 'normal'):
            vals = np.concatenate([g[4] for g in rg_groups if g[0] in A.B3 and g[1] == dur and g[2] == cad and g[3] == regm])
            groups.append((f'{dur.replace("d"," d")} {cadlab(cad)} · {"alta vol." if regm.startswith("alta") else "normal"}', vals))
    for st in ('2.1', '2.3', '2.10'):
        vv = pd.concat([A.wide(d68, bb, st, strategies=('A+', 'B+')) for bb in A.B3]); groups.append((A.SETLAB[st], ((vv['A+'] - vv['B+']) / 10).values))
    groups.append(('Com stable (ETH + cbBTC + USDC)', None))
    for (dur, cad) in (('30d', 1.0), ('90d', 1.0), ('90d', 7.0)):
        for regm in ('alta volatilidade', 'normal'):
            vals = [g[4] for g in rg_groups if g[0] == A.BS and g[1] == dur and g[2] == cad and g[3] == regm][0]
            groups.append((f'{dur.replace("d"," d")} {cadlab(cad)} · {"alta vol." if regm.startswith("alta") else "normal"}', vals))
    for st in ('2.1', '2.3', '2.10'):
        vv = A.wide(d68, A.BS, st, strategies=('A+', 'B+')); groups.append((A.SETLAB[st], ((vv['A+'] - vv['B+']) / 10).values))
    ch3.g3_aplus_bplus(groups, K)
    d.chart('G3-aplus-vs-bplus', 'Gráfico G3 · A+ face a B+: dispersão da diferença de valor por amostra e regime — três voláteis em cima, com stable em baixo')
    d.p(f'**A resposta em uma frase:** {a_t6}')
    d.p('**Leitura para o dono.** Com as melhorias do Arquitecto, o A+ e o B+ ficam com a mesma garantia e as mesmas protecções. O que os separa, medido, é o número de compras (um terço menos no A+, cêntimos de gas por posição ao preço actual da Base) e uma diferença de valor sem sinal fixo, nos dois cestos. O B+ faz compras mais pequenas e mais regulares. A garantia e as protecções valem igualmente num DCA fixo de 3 pernas; a regra 4 não acrescenta valor mensurável.')

    # ================================================================== T7
    d.h2('T7 — Banda de peg escolhida pelo utilizador, com tecto derivado da história', 't7')
    d.h3('Primeiro, a stable de entrada')
    d.p('**Como foi medido.** Nos eventos reais (USDC e DAI no SVB, USDT em Mai 2022) e no contra-caso que não recuperou (UST), com as posições horárias, de 4 h e diárias da §2.10. A posição é em stable: cada compra vende stable ao seu preço em USD, por isso um USDC a 0,88 compra 12% menos ETH. «Pausa» = o ciclo espera enquanto a stable de entrada está fora da banda (ADR-024); um último ciclo apanhado na pausa espera pela primeira hora de volta à banda. Valor em USD no fim da posição. Dois produtos: o DCA de um token (ETH) e o Basket ETH + BTC + COMP (A+).')
    rows = []
    for evn in in7.event.unique():
        for prod in in7['product'].unique():
            for blab in ('sem pausa', '0,5%', '1%', '2%', '5%', '1% · pausa máx. 72 h'):
                g, dd_ = inp(evn[:4].strip(), blab) if False else (None, None)
                gg = in7[(in7.event == evn) & (in7['product'] == prod) & (in7.band == blab)]
                if gg.empty: continue
                v = gg.set_index(kk).value_usd; j = pd.concat([v, base], axis=1, join='inner'); dd_ = (j.iloc[:, 0] - j.iloc[:, 1]) / 10
                rows.append([evn, prod, blab, f(len(gg), 0), f'{f(gg.sold_below_peg_pct.median(),1)} / {f(gg.sold_below_peg_pct.max(),0)}', f'{f(gg.depeg_cost_pct.median(),2)} / {f(gg.depeg_cost_pct.max(),2)}',
                             f(gg.last_cycle_waited_h.max(), 0) + ' h' if gg.last_executed.all() else 'nunca voltou', '—' if blab == 'sem pausa' else f'{pct(float((dd_ > 0.01).mean()*100),0)} · {f(dd_.median(),2)}% ({f(dd_.min(),1)} / {f(dd_.max(),1)})'])
    d.table(['Evento', 'Produto', 'Pausa', 'Posições', 'Vendido abaixo de 0,99, % do capital (mediana / máx.)', 'Custo directo do desconto, % do capital (mediana / máx.)', 'Último ciclo esperou (máx.)', 'Pausa melhor que continuar: % das posições · mediana (mín. / máx.)'], rows,
            'Custo directo = Σ stable vendida × (1 − preço) · «melhor que continuar» compara o valor final em USD com o da mesma posição sem pausa (histórico)', num_cols=[3])
    d.p(f'**Leitura.** Pausar é apostar que a stable recupera. Quando recupera (SVB), a pausa a 1% poupa o desconto: custo directo de {f(svb[svb.band=="sem pausa"].depeg_cost_pct.median(),2)}% para {f(svb[svb.band=="1%"].depeg_cost_pct.median(),2)}% em mediana, e de {f(svb[svb.band=="sem pausa"].depeg_cost_pct.max(),1)}% para {f(svb[svb.band=="1%"].depeg_cost_pct.max(),1)}% no pior caso. Mas o valor final ficou pior em {pct(float((dsvb < -0.01).mean()*100),0)} das posições, porque nos 1–2 dias de espera o ETH subiu mais do que o desconto (isto é histórico do SVB, não uma regra). Quando não recupera (UST), a pausa guarda o capital numa stable que vai a zero: {f(dU1.median(),1)}% do capital em mediana face a continuar, pior {f(dU1.min(),1)}%; limitar a pausa a 72 h não resolve ({f(dU72.median(),1)}%), porque a UST perdeu mais de metade do valor nas primeiras 72 h. No USDT de Mai 2022 o feed nunca passou de 2,4% de desconto e a pausa quase não actua. **Recomendação, para os dois produtos: não pausar (aceite pelo dono).** Se o dono quiser uma protecção, a que os dados suportam é avisar (ou não deixar criar) uma ordem quando a stable de entrada já está fora da banda no momento da criação.')
    d.h3('Passo 1 — Inventário de descolamentos reais')
    d.p(f'**Universo.** Todas as stablecoins em USD do registo de stablecoins do DefiLlama ({f(len(json.load(open(os.path.join(T7.ST, "raw", "stablecoins.json")))["peggedAssets"]),0)} activos, curados ou não) com pelo menos 50 M USD em circulação no início do evento, Jan 2020 – Nov 2026. **Detecção:** preço DefiLlama abaixo de 0,98 durante 3 leituras horárias seguidas (ou 2 diárias, para as moedas sem histórico horário completo, confirmadas depois na série horária). **Recuperou** = voltou a ≥ 0,99 e não desceu abaixo de 0,99 durante 30 dias seguidos — proponho só o lado de baixo, porque excursões acima do peg (LUSD a 1,02–1,05) não são o risco que o consentimento cobre. **Série do keeper:** Chainlink hora a hora onde existe feed; senão o DefiLlama (que é o quórum que a keeper leria para uma moeda sem feed — em vez da bolsa de maior volume, que não está acessível para a maioria destas moedas), com o mínimo sustentado (mediana de 3 leituras) para um print isolado não contar. **Confirmado** = uma segunda série independente (Chainlink ou vela de bolsa) também viu o descolamento. Fins de vida declarados (BUSD depois de Fev 2023, FEI depois de Ago 2022) ficam fora.')
    rows = []
    show = ok7.sort_values('max_drop_pct', ascending=False)
    for _, e in show.iterrows():
        rows.append([e.symbol, dmy(e.start), f(e.circ_at_start_musd, 0), e.keeper_series.replace(' · mínimo sustentado', ''), f(e.keeper_min, 4), '—' if pd.isna(e.candle_min) else f'{f(e.candle_min,4)} ({e.candle_src})',
                     '—' if pd.isna(e.daily_tick_min) else f(e.daily_tick_min, 4), f(e.max_drop_pct, 1) if e.max_drop_pct >= 0 else '0 (feed ≥ 1)', ('sim' if e.recovered else 'não'),
                     f(e.days_to_recover, 1) if e.recovered and pd.notna(e.days_to_recover) else ('—' if e.recovered else f'último {f(e.last_price,4)}'),
                     {True: 'sim', False: 'não', None: 'só agregador'}.get(e.confirmed if not pd.isna(e.confirmed) else None, 'só agregador')])
    d.table(['Stable', 'Início', 'Em circulação (M USD)', 'Série do keeper', 'Mínimo na série do keeper', 'Mínimo da vela (fonte)', 'Mínimo no tick diário', 'Queda máx. (%)', 'Recuperou', 'Dias até recuperar', 'Confirmado'], rows,
            f'{len(ok7)} descolamentos, ordenados pela queda · a v2 já mostrava que vela, série do keeper e tick diário dão números muito diferentes (USDC: {f(usdc_ev.candle_min,3)} / {f(usdc_ev.keeper_min,3)} / {f(usdc_ev.daily_tick_min,3)})', num_cols=[2, 4, 6, 7, 9])
    d.h3('Passo 2 — O tecto')
    rows = [[r.symbol, dmy(r.start), f(r.max_drop_pct, 1), r.keeper_series.replace(' · mínimo sustentado', ''), {True: 'sim', False: 'não'}.get(r.confirmed, 'só agregador') if not pd.isna(r.confirmed) else 'só agregador', f(r.days_to_recover, 1)] for _, r in cc['top5'].iterrows()]
    d.table(['Stable', 'Início', 'Queda (%)', 'Série', 'Confirmado', 'Dias até recuperar'], rows, 'As maiores quedas que recuperaram, confirmadas por duas séries', num_cols=[2, 5])
    rows = [[r.symbol, dmy(r.start), f(r.max_drop_pct, 1), r.keeper_series.replace(' · mínimo sustentado', ''), f(r.days_to_recover, 0)] for _, r in ca['top5'].iterrows() if r.confirmed != True]
    d.table(['Stable', 'Início', 'Queda (%)', 'Série', 'Dias até recuperar'], rows, 'Quedas maiores que «recuperaram» mas que só o agregador viu (caso de sensibilidade)', num_cols=[2, 4])
    rows = []
    for _, r in nr.sort_values('max_drop_pct', ascending=False).iterrows():
        rows.append([r.symbol, dmy(r.start), f(r.circ_at_start_musd, 0), 'sim' if r.confirmed == True else 'só agregador', f(r.max_drop_pct, 1),
                     '—' if pd.isna(r.crossed_ceiling_at) else str(pd.Timestamp(r.crossed_ceiling_at))[:16], '—' if pd.isna(r.crossed_d_rec_at) else str(pd.Timestamp(r.crossed_d_rec_at))[:16],
                     '—' if pd.isna(r.h_ceiling_to_d_rec) else f(r.h_ceiling_to_d_rec, 0) + ' h', '—' if pd.isna(r.d_ceiling_to_50c) else f(r.d_ceiling_to_50c, 1) + ' d', f(r.last_price, 4), r.status])
    d.table(['Stable', 'Início', 'Em circulação (M USD)', 'Confirmado', 'Queda máx. (%)', f'Passou o tecto (−{f(ceil_,1)}%)', f'Passou D_rec (−{f(drec,1)}%)', 'Do tecto a D_rec', 'Do tecto a 0,50', 'Último preço', 'Estado'], rows,
            'As stables que não recuperaram, o nível a que passaram e o que aconteceu depois', num_cols=[2, 4, 7, 8, 9])
    rows = [[f'≥ {f(r.level_pct,1)}%', int(r.events), int(r.recovered), int(r.not_recovered), pct(r.share_not_recovered_pct, 0), f'{int(r.confirmed_events)} / {int(r.confirmed_not_recovered)}'] for _, r in lv7.iterrows()]
    d.table(['Queda', 'Descolamentos que chegaram lá', 'Recuperaram', 'Não recuperaram', '% que não recuperou', 'Confirmados / dos quais não recuperaram'], rows,
            'O que a história diz em cada nível de queda (todos os descolamentos confirmados na série horária)', num_cols=[1, 2, 3, 4])
    d.p(f'**A conta.** D_rec = {f(drec,2)}% (FRAX, 11 Mar 2023, mínimo {f(e_rec.keeper_min,4)} no feed Chainlink FRAX/USD; USDC no mesmo dia {f(usdc_ev.max_drop_pct,2)}%). Há stables que caíram até D_rec e não recuperaram (a UST, confirmada no feed, passou por −{f(drec,1)}% às {str(pd.Timestamp(ust.crossed_d_rec_at))[:16]} UTC), logo **tecto = {f(drec,2)} − 5 = {f(ceil_,2)}%**. '
        f'**Os 5 pp não chegam:** das {len(nr)} stables que não recuperaram, {len(dead)} passaram pelo tecto (todas as que caíram mais do que ele); para quem as compra, o tecto não é uma margem, é só o ponto onde se deixa de comprar. A partir de 7,5% de queda, {pct(float(lv7[lv7.level_pct==7.5].share_not_recovered_pct.iloc[0]),0)} dos descolamentos não recuperaram; a partir de 12,5%, {pct(float(lv7[lv7.level_pct==12.5].share_not_recovered_pct.iloc[0]),0)} (e os três que recuperaram só se vêem no agregador). '
        f'**Sensibilidade:** se contar quedas vistas só no agregador, D_rec passaria a {f(ca["d_rec"],0)}% ({ca["event"].symbol}, {dmy(ca["event"].start)}, recuperou ao fim de {f(ca["event"].days_to_recover,0)} dias) e o tecto a {f(ca["ceiling"],0)}%: um número que vem de pools finos e que não se pode pôr à frente de um utilizador. **Recomendei a versão confirmada; o dono decidiu outra forma: banda até {f(ceil_o,0)}% sem aviso e, acima, um aviso que cita {f(drec_o,0)}%** — ver «Decisões do dono».')
    d.h3('Passo 3 — Simulação')
    rows = []
    for evn in l37.event.unique():
        for blab in [b for b in l37.band.unique()]:
            g = l37[(l37.event == evn) & (l37.band == blab) & (l37.rule9 == 'desligada')]
            g25 = l37[(l37.event == evn) & (l37.band == blab) & (l37.rule9 == '25%') & (l37['mode'] == 'rígido')]
            if g.empty: continue
            off = g[g.usd_bought_offpeg > 0]
            rows.append([evn, blab, f(len(g), 0), f'{f(g.usd_bought_offpeg.median(),0)} / {f(g.usd_bought_offpeg.max(),0)}', '—' if off.empty else f(off.avg_px_offpeg.median(), 3),
                         '—' if off.empty else f'{f((off.value_offpeg_7d / off.usd_bought_offpeg).median()*100,0)}% / {f((off.value_offpeg_30d / off.usd_bought_offpeg).median()*100,0)}%',
                         f'{f(g.max_loss_stable_pct.max(),1)} (peso {f(g.w3.max()*100,0)})', f'{f(g.dev_pp.max(),1)} / {f(g.unin_pct.max(),1)}', f'{f(g25.dev_pp.max(),1)} / {f(g25.unin_pct.max(),1)}'])
    d.table(['Evento', 'Banda', 'Posições', 'USD comprados da stable abaixo de 0,99 (mediana / máx.)', 'Preço médio pago', 'Valor dessa parte 7 / 30 dias depois', 'Perda máx. atribuível à stable, % do capital', 'Desvio / por investir máx. (regra 9 desligada)', 'O mesmo com regra 9 a 25%, rígido'], rows,
            'Cesto ETH + BTC + stable · posições horárias, de 4 h e diárias da §2.10 que contêm o evento · modo suave e rígido só diferem com a regra 9 ligada (e deram o mesmo nas compras da stable) · 1 000 USD', num_cols=[2, 3, 4])
    u3m = u3[u3.usd_bought_offpeg > 0]
    first_block = sorted(set(u3.first_blocked.dropna()) - {''})[0] if len(set(u3.first_blocked.dropna()) - {''}) else '—'
    d.p(f'**Leitura.** A perda atribuível à stable nunca passou do peso que o utilizador lhe deu (o lock da regra 6 trava a perna no seu alvo), mesmo com a regra 9 a empurrar orçamento para ela. Mas atenção ao que isto quer dizer: **a banda só protege o que se compraria depois do descolamento.** No caso da UST, a maior parte da perda veio da stable comprada antes, a 1 USD — com banda de 1% a perda chegou a {f(l37[(l37.stable=="UST")&(l37.band=="1%")].max_loss_stable_pct.max(),1)}% do capital numa posição 25-25-50. O «por investir» igual ao peso da stable (até 50%) é a banda a fazer o que deve: uma stable que acaba a posição fora da banda não é comprada no último ciclo, e esse dinheiro fica com o utilizador.')
    d.h3('As cinco perguntas')
    q3 = (f'Na UST com a banda no máximo sem aviso ({f(ceil_o,0)}%), a posição comprou UST abaixo de 0,99 em {pct(float((u3.usd_bought_offpeg>0).mean()*100),0)} das posições, até {usd(u3.usd_bought_offpeg.max(),0)} (preço médio {f(u3m.avg_px_offpeg.median(),3) if len(u3m) else "—"}), que valiam {f((u3m.value_offpeg_7d/u3m.usd_bought_offpeg).median()*100,0) if len(u3m) else "—"}% 7 dias depois e {f((u3m.value_offpeg_30d/u3m.usd_bought_offpeg).median()*100,1) if len(u3m) else "—"}% 30 dias depois. '
          f'A perda máxima atribuível à UST foi {f(u3.max_loss_stable_pct.max(),1)}% do capital (posição 25-25-50, perna de 50%; quase toda de UST comprada antes do descolamento). A perna deixou de ser comprada no primeiro tick com a UST abaixo de {f(1-ceil_o/100,2)}: {str(first_block)[:16]} UTC na cadência horária (o feed passou −{f(ceil_o,0)}% às {str(pd.Timestamp(ust_o.crossed_ceiling_at))[:16]}). Com a banda a {f(drec_o,0)}% (com aviso), até {usd(u3o.usd_bought_offpeg.max(),0)} e perda até {f(u3o.max_loss_stable_pct.max(),1)}%. '
          f'Para comparação, com o tecto derivado dos dados ({f(ceil_,1)}%) a perna parava às {str(pd.Timestamp(ust.crossed_ceiling_at))[:16]}.')
    d.ol([f'**Os dados dão D_rec = {f(drec,1)}%** (FRAX, SVB, 11 Mar 2023, feed Chainlink hora a hora; USDC {f(float(usdc_ev.max_drop_pct),1)}% no mesmo evento) e tecto {f(ceil_,1)}%. **Decisão do dono:** até {f(ceil_o,0)}% sem aviso; acima de {f(ceil_o,0)}%, um aviso único que cita {f(drec_o,0)}% ({n80} stables caíram {f(drec_o,0)}% ou mais desde 2020; {r80} recuperaram).',
          f'**O aviso (decisão do dono):** {warn_owner} **Proposta da Analista, para a banda escolhida:** {warn_band}',
          q3,
          f'**Sim, mas o que se recalcula muda.** Com os {f(ceil_o,0)}% e os {f(drec_o,0)}% fixados pelo dono, o script passa a recalcular os números que o aviso cita (X dias, a tabela de níveis, se alguma stable recuperou de {f(drec_o,0)}%). Proposta: (i) o `run_all.py` refaz o inventário a partir do registo do DefiLlama e dos feeds; (ii) qualquer stable com ≥ 50 M USD que caia mais de 5% abre uma revisão; (iii) os números só mudam quando a janela de 30 dias desse evento fecha; (iv) a revisão vai ao dono se um evento novo contradisser a escolha (uma stable que recupere de {f(drec_o,0)}% ou mais — a frase do aviso deixaria de ser verdade —, ou uma que morra com uma queda abaixo de {f(ceil_o,0)}%), e nunca se aplica a ordens já criadas.',
          '**Decidido pelo dono: sem pausa**, no Basket e no DCA de um token. Os números ficam na tabela da stable de entrada acima.'])

    # ================================================================== tests
    d.h2('Testes do motor', 'testes')
    d.ul(['`test_switches_off_reproduce_v2_exactly` — A+ com tudo desligado = A da v2, compra a compra, em S1–S7 (112 posições, com e sem regra 9).',
          '`test_P_keeps_the_split_and_changes_only_decisions` — P em S1–S7, cesto com stable e ETH + cbBTC + COMP: desvio 0, execução sempre ao preço do feed, e P muda decisões (o interruptor está vivo).',
          f'`test_P_leg_without_price_is_not_bought_and_last_cycle_waits` — uma perna sem preço utilizável não é comprada; sem espera a garantia parte-se (o teste exige que parta); com a regra do dono, se o preço volta no 2.º ciclo seguinte compra lá e o desvio é 0; se não volta em {RETRY_N}, a perna fica por comprar, o dinheiro fica com o utilizador e a razão vem no resultado.',
          '`test_M_min_fill_respected_and_split_exact` — 100/250/1 000 USD × 3/16 USD × A+ e B+: nenhuma compra abaixo do mínimo fora do último ciclo; desvio ≤ 0,01 USD por perna.',
          f'`test_E_staged_catchup_bounds_the_largest_fill_without_breaking_the_split` — k = {K} sem tecto em S1–S7, nos dois cestos: desvio 0 e maior compra ≤ 20% a partir de 8 ciclos; com tecto que trava, o capital por investir aparece e é contado.',
          '`test_B_band_never_buys_a_depegged_stable_also_on_the_last_cycle` — USDC no SVB e UST em Mai 2022, horário: nenhuma compra da stable fora da banda (1% e 5%), incluindo o último ciclo e o último ciclo que esperou por preço; a perna nunca passa do seu peso.',
          '`test_three_volatile_basket_keeps_the_split_with_every_switch_on` — os três X, A+ e B+ com P + M + E + regra 9: desvio ≤ 0,01 USD por perna.',
          'Os 7 testes da v2 continuam a passar sem alterações.'])

    # ================================================================== not measured
    d.h2('O que não foi medido, e porquê', 'naomedido')
    d.ul([f'**X com menos histórico**: VIRTUAL só desde {dmy(cov.loc["ETH+cbBTC+VIRTUAL"].from_)} e AERO desde {dmy(cov.loc["ETH+cbBTC+AERO"].from_)} — S1, S2, S3, S7, a âncora de 2022–23 e os episódios E1–E4 só têm COMP. Parte de E1 (as posições diárias que começam antes de 1 Dez 2021) fica sem COMP.',
          '**Os outros X de fase 1 do catálogo**: feeds com menos de um ano; não acrescentavam janelas reais.',
          '**O quórum real do ADR-024** (Chainlink + DefiLlama + CoinGecko): a CoinGecko não tem histórico sem chave. P e a fase 2 usam o DefiLlama — declarado.',
          '**A disponibilidade ao vivo do DefiLlama** nas datas passadas: as lacunas do histórico contam como «sem preço» e são a origem de todos os «último ciclo sem preço».',
          '**Bolsa de maior volume para as stables sem feed**: Binance e afins não estão acessíveis daqui; usei o DefiLlama (o quórum da keeper) com mínimo sustentado. Velas só onde a Coinbase/Bitstamp listam o par (USDC, USDT, DAI, USDP, GUSD, PYUSD).',
          '**Descolamentos antes de 2020** (USDT 2018, por exemplo): fora do histórico do DefiLlama.',
          '**Stables abaixo de 50 M USD em circulação no início do evento** (o MIM de 2026, por exemplo, já tinha encolhido): fora do universo por desenho.',
          '**O custo real de um fill na Base depois de 627bb60**: os RPCs públicos não servem logs antigos sem token.',
          '**O repo no commit actual do GitHub**: sem acesso desta sessão; confirmação feita on-chain no executor da Base.',
          '**Execução real** (rota, slippage, impacto da maior compra): o motor compra ao preço do feed.',
          f'**Se a keeper e o contrato conseguem repetir o último ciclo até {RETRY_N} vezes e depois fechar a ordem com uma perna por comprar**, e guardar o motivo para o relatório no site: é capacidade da keeper — pergunta para o Arquitecto. Simulado: os {RETRY_N} ciclos seguintes à cadência da ordem.'])

    # ================================================================== spec
    d.h2('O que isto muda na spec (proposta)', 'spec')
    d.ol(['**Cesto principal com três voláteis: entra.** A garantia aguenta com todos os interruptores.',
          f'**P** entra, com a regra do dono para o último ciclo: sem preço utilizável, tenta nos {RETRY_N} ciclos seguintes (a banda de peg continua a valer); se não houver, a ordem fecha com a perna por comprar, o dinheiro fica com o utilizador e o motivo vai para o relatório.',
          '**M** entra com a tua fórmula; o último ciclo isento a partir de 0,01 USD.',
          f'**E**: k = {K}, sem tecto. No cesto com stable, se for preciso ≤ 20% com 6–7 ciclos, mínimo de 8 ciclos quando a regra 9 está activa. Tecto não.',
          '**Regra 9** mantém-se a 25% no cesto de três voláteis; é a regra que mais concentra, e o E é o que a segura. Se o dono quiser menos concentração, o parâmetro é o limiar (30%), não o k.',
          f'**B** (decisão do dono): banda escolhida pelo utilizador, 1% por defeito; até {f(ceil_o,0)}% sem aviso; acima, um aviso único ({warn_owner}); se recusar, a ordem não é criada. O número de dias e o facto dos {f(drec_o,0)}% saem do script e actualizam-se a cada descolamento novo. Proposta da Analista: o aviso dizer também o número da banda escolhida.',
          '**Stable de entrada: sem pausa**, no Basket e no DCA de um token (decisão do dono). No máximo, um aviso na criação da ordem se a stable de entrada já estiver fora da banda.',
          '**Cadência mínima diária** enquanto a regra 4 usar os feeds da Base e o quórum: em cadência horária decide sobre ruído (T4, T8).',
          '**Relatório de fecho da ordem no site** (ideia do dono): divisão pedida contra cumprida, compras, ciclos sem compra e porquê, e qualquer perna por comprar com o motivo e onde está o dinheiro. Conteúdo proposto em «Decisões do dono».'])
    md = to_md(d)
    open(os.path.join(ROOT, 'RESULTS-2026-11-v3.md'), 'w').write(md)
    import report_html
    svgs = {os.path.basename(p)[:-4]: open(p).read().replace('style="max-width:100%;height:auto;background:var(--surface,#fcfcfb)"', 'style="max-width:100%;height:auto"') for p in glob.glob(os.path.join(ROOT, 'charts', '*.svg'))}
    n_runs = len(t1) * 3 + len(t2) * 3 + len(t3) + len(dec) + len(d68) + len(dc) * 2 + len(in7) + len(l37)
    prox = set()
    for vf in ('data/series/feed_verification.csv', 'data/series/v3/base_feed_verification.csv', 'data/series/v3/x_feed_verification.csv', 'data/series/v3/stables/stable_feed_verification.csv'):
        pth = os.path.join(ROOT, vf)
        if os.path.exists(pth):
            vv = pd.read_csv(pth); col = 'proxy' if 'proxy' in vv else [c for c in vv.columns if 'proxy' in c.lower() or 'address' in c.lower()][0]
            prox |= set(vv[col].astype(str).str.lower())
    report_html.write(d, svgs, os.path.join(ROOT, 'RESULTS-2026-11-v3.html'), f(n_runs, 0),
                      feeds_txt=f'{len(prox)} feeds Chainlink verificados on-chain', period_txt='Jan 2020 – Nov 2026 · diário e horário',
                      title='Basket DCA Modelação v3', eyebrow='TeraSwap · Analista → Arquitecto · RESULTS-2026-11-v3',
                      h1='Basket DCA — v3: três voláteis e o A+ antes da spec', extra_meta='3 voláteis · A+ vs B+ · Base · banda de peg')
    return d, n_runs

def g1_build():
    t3 = A.load_t3()
    ch3.g1_k_cap([(bshort(A.POOL), t3[t3.basket.isin(A.B3)]), (bshort(A.BS), t3[t3.basket == A.BS])])

if __name__ == '__main__':
    if '--no-compute' not in sys.argv: compute()
    g1_build(); write()
