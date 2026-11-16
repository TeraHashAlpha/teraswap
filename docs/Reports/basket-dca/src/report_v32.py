"""RESULTS-2026-11-v3.2.md (+ HTML): A — the soft-mode window k_soft as a function of N; B — the stable leg of
phase 1 on Base (USDT or DAI). v2, v3 and v3.1 files are not touched."""
import os, sys, json, math, hashlib, numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import experiments_v32 as E
from engine_discrete import choose_n
from docmodel import Doc, to_md
from report import f, pct, dmy
from scenarios import SPLITS
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
R32 = E.R32
KEY = ['basket', 'family', 'window', 'start', 'cadence_d', 'N', 'split']
CADL = {1: 'diária', 3: '3 dias', 7: 'semanal'}
GRPL = {'vol3': '3 voláteis (VIRTUAL, COMP, AERO)', 'stable': 'com stable (USDT, DAI)'}

def compute():
    E.run_all(); E.run_bands(); E.run_b()

# ------------------------------------------------------------------ loading
NEED = ['grp', 'basket', 'cadence_d', 'N', 'split', 'protected', 'k', 'pending_chunks', 'unbought_pct', 'max_cycle_pct', 'n_prot_fills',
        'prot_spent_pct', 'prot_mean_drop_pct', 'r9_block_cycles', 'value_end']
def load_k():
    out = []
    for b in E.BASKETS:
        q = pd.read_csv(os.path.join(R32, f'ksoft_{b}.csv.gz'), low_memory=False)
        q['pid'] = q.groupby(['family', 'window', 'start', 'cadence_d', 'N', 'split'], sort=False).ngroup().astype('int64') + len(out) * 10 ** 7
        out.append(q)
    d = pd.concat(out, ignore_index=True)
    d['grp'] = np.where(d.basket.isin(E.STABLE_B), 'stable', 'vol3')
    for c in ('grp', 'basket', 'split', 'run', 'cands'): d[c] = d[c].astype('category')
    return d

def by_cand(d):
    """One frame per candidate: the unprotected positions (identical for every k) + the soft run that candidate gave."""
    cols = NEED + ['pid']
    base = d.loc[d.run == 'todas', cols]; s = d[d.run == 'suave']; tag = '|' + s.cands.astype(str) + '|'
    out = [pd.concat([base, s.loc[tag.str.contains('|' + cn + '|', regex=False), cols]]).assign(cand=cn) for cn in E.CAND_ORDER]
    for run in ('rígido', 'sem regra 9'):
        out.append(pd.concat([base, d.loc[d.run == run, cols]]).assign(cand=run))
    x = pd.concat(out, ignore_index=True); x['cand'] = x.cand.astype('category')
    nr9 = x.loc[x.cand == 'sem regra 9', ['pid', 'pending_chunks', 'value_end']].rename(columns={'pending_chunks': 'pend_nr9', 'value_end': 'val_nr9'})
    return x.merge(nr9, on='pid', how='left')

def stats(x):
    p = x[x.pending_chunks > 0]; p9 = p[p.pend_nr9 == 0]; pf = x[x.n_prot_fills > 0]; b9 = x[x.r9_block_cycles > 0]
    w = pf.n_prot_fills.sum()
    return dict(n=len(x), prot=int(x.protected.sum()), r9=len(b9), r9_share=100 * len(b9) / max(1, len(x)),
                r9_cyc_med=float(b9.r9_block_cycles.median()) if len(b9) else 0.0,
                inc=len(p), inc_share=100 * len(p) / max(1, len(x)), inc_r9=len(p9),
                inc_chunks_max=int(p.pending_chunks.max()) if len(p) else 0, inc_unb_max=float(p.unbought_pct.max()) if len(p) else 0.0,
                inc9_chunks_max=int(p9.pending_chunks.max()) if len(p9) else 0, inc9_unb_max=float(p9.unbought_pct.max()) if len(p9) else 0.0,
                pf=len(pf), pf_share=100 * len(pf) / max(1, len(x)), pf_spent_mean=float(pf.prot_spent_pct.mean()) if len(pf) else 0.0,
                pf_spent_max=float(pf.prot_spent_pct.max()) if len(pf) else 0.0, pf_chunks=int(w),
                pf_drop=float((pf.prot_mean_drop_pct * pf.n_prot_fills).sum() / w) if w else np.nan,
                mc_med=float(x.max_cycle_pct.median()), mc_p95=float(x.max_cycle_pct.quantile(.95)), mc_max=float(x.max_cycle_pct.max()),
                mcp_med=float(x[x.protected].max_cycle_pct.median()) if x.protected.any() else np.nan,
                mcp_max=float(x[x.protected].max_cycle_pct.max()) if x.protected.any() else np.nan)

def table_stats(x, by):
    rows = []
    for k, g in x.groupby(by, sort=True):
        rows.append(dict(zip(by, k if isinstance(k, tuple) else (k,)), **stats(g)))
    return pd.DataFrame(rows)

def k_table():
    """N -> k for each candidate (the largest n_i at 1 000 USD over the four splits, for «garantia»)."""
    rows = []
    for N in E.NS:
        r = dict(N=N, cads=', '.join(CADL[c] for c in E.CADS if E.fits(N, c)))
        for cn in E.CAND_ORDER:
            ks = sorted({E.CANDS[cn](N, choose_n(np.asarray(SPLITS[sp]), E.C, N, E.MINFILL)) for sp in SPLITS})
            r[cn] = ks[0] if len(ks) == 1 else f'{ks[0]}–{ks[-1]}'
        nmax = max(int(choose_n(np.asarray(SPLITS[sp]), E.C, N, E.MINFILL).max()) for sp in SPLITS)
        r['n_max'] = nmax; r['cap10_ok'] = E.L * (10 + E.G) >= nmax
        rows.append(r)
    return pd.DataFrame(rows)

def ngrp(N): return np.select([N <= 9, N <= 15, N <= 30], ['6–9', '10–15', '20–30'], '60–86')
NG = ['6–9', '10–15', '20–30', '60–86']

def value_vs_nr9(x):
    """History, never a promise: value at the end of the position against the same position without rule 9."""
    p = x[x.protected & ~x.cand.isin(['sem regra 9'])].copy()
    p['dv'] = (p.value_end - p.val_nr9) / 10                                  # % of the 1 000 USD
    p['Ng'] = ngrp(p.N)
    rows = []
    for (g, cn, ng), q in p.groupby(['grp', 'cand', 'Ng']):
        rows.append(dict(grp=g, cand=cn, Ng=ng, n=len(q), better=100 * (q.dv > 0.01).mean(), worse=100 * (q.dv < -0.01).mean(),
                         med=float(q.dv.median()), mean=float(q.dv.mean()), p5=float(q.dv.quantile(.05)), p95=float(q.dv.quantile(.95))))
    return pd.DataFrame(rows)

def load_bands():
    return pd.read_csv(os.path.join(R32, 'banda_cesto_stable.csv.gz'), low_memory=False)

def save_summaries(x):
    t = table_stats(x, ['grp', 'cand', 'cadence_d', 'N']); t.to_csv(os.path.join(R32, 'ksoft_resumo.csv'), index=False)
    v = value_vs_nr9(x); v.to_csv(os.path.join(R32, 'ksoft_valor_vs_sem_regra9.csv'), index=False)
    k_table().to_csv(os.path.join(R32, 'ksoft_tabela_N_k.csv'), index=False)
    return t, v


# ------------------------------------------------------------------ the document
CL = {'k = 10': 'k = 10 (hoje)', '⌈N/2⌉': '⌈N ÷ 2⌉ (tecto 10)', '⌈N/3⌉': '⌈N ÷ 3⌉ (tecto 10)', '⌈N/4⌉': '⌈N ÷ 4⌉ (tecto 10)',
      '⌈N/4⌉ sem tecto': '**⌈N ÷ 4⌉ sem tecto (recomendada)**', 'garantia': '«garantia»: ⌈n_max ÷ 2⌉ − 3', 'rígido': 'rígido (referência)', 'sem regra 9': 'sem regra 9 (referência)'}

def facts(x, t, v, bd, br, fp):
    """Every number the text quotes, in one place."""
    REC = E.K_REC_NAME; F = {}
    def S(q): return stats(q)
    F['n_pos'] = int((x.cand == REC).sum()); F['n_vol'] = int(((x.cand == REC) & (x.grp == 'vol3')).sum()); F['n_st'] = int(((x.cand == REC) & (x.grp == 'stable')).sum())
    for cn, xc in x.groupby('cand'):
        F[cn] = S(xc)
        for g, xg in xc.groupby('grp'): F[cn, g] = S(xg)
        F[cn, 'short'] = S(xc[xc.N <= 10]); F[cn, 'long'] = S(xc[xc.N >= 60])
        for N, xn in xc.groupby('N'):
            F[cn, N] = S(xn)
            if N <= 9:
                for c, xcn in xn.groupby('cadence_d'): F[cn, N, c] = S(xcn)
    assert F[REC]['inc_r9'] == 0 and F['k = 10', 'short']['r9'] == 0
    F['capped_long_inc'] = {cn: F[cn, 'long']['inc_r9'] for cn in ('k = 10', '⌈N/2⌉', '⌈N/3⌉', '⌈N/4⌉')}
    assert len(set(F['capped_long_inc'].values())) == 1                     # all capped candidates are k = 10 at N >= 40
    return F

def write():
    d = load_k(); x = by_cand(d); t, v = save_summaries(x)
    kt = k_table(); bd = load_bands()
    fp = pd.read_csv(os.path.join(R32, 'feeds_usdt_dai_base.csv')); br = pd.read_csv(os.path.join(R32, 'banda_regra_usdt_dai.csv'))
    aw = pd.read_csv(os.path.join(R32, 'aviso_usdt_dai.csv')); aev = pd.read_csv(os.path.join(R32, 'aviso_eventos_usdt_dai.csv'))
    reg = json.load(open(os.path.join(E.V32, 'executor_registry_base_v32.json')))
    md5 = {v_: hashlib.md5(open(os.path.join(ROOT, f'RESULTS-2026-11{v_}.md'), 'rb').read()).hexdigest() for v_ in ('', '-v3', '-v3.1')}
    REC = E.K_REC_NAME; F = facts(x, t, v, bd, br, fp); vv = v.set_index(['grp', 'cand', 'Ng'])
    kN = {r.N: r[REC] for _, r in kt.iterrows()}
    tok = {r['symbol']: r for r in reg['tokens']}; fpi = fp.set_index('token')
    def B(scope, band, col): return br[(br.scope.str.startswith(scope)) & (br.band_pct == band)][col].iloc[0]
    bd1 = bd[bd.band_pct == 1]
    doc = Doc()
    doc.h1('Basket DCA — modelação v3.2: a janela do modo suave e a perna stable da fase 1')
    doc.p('**Pedido:** `claude/basket-dca-pedido-modelacao-v3.2-2026-11-13.md` (Arquitecto, 13 Nov 2026). **Pacote:** o mesmo; `python3 run_all.py --v32-only` refaz só esta parte; '
          f'v2, v3 e v3.1 não mudam (md5 dos relatórios: `{md5[""][:8]}`, `{md5["-v3"][:8]}`, `{md5["-v3.1"][:8]}`). Tabelas em `results/v32/`.')
    doc.callout('Separação de sempre: **(a)** a garantia — o que foi comprado cumpre a divisão? quanto ficou por comprar? — e **(b)** o que aconteceu ao valor e ao preço: histórico, nunca promessa.')

    # ================================================================== answers
    r6 = {c: F[REC, 6, c] for c in E.CADS}; k6 = {c: F['k = 10', 6, c] for c in E.CADS}
    q1 = (f'**`k_soft = ⌈N ÷ 4⌉`, com mínimo 1 e sem tecto.** No modo suave, a protecção pausa o token até aos últimos ⌈N ÷ 4⌉ ciclos (o último quarto da ordem); nesses ciclos e nos 3 de tolerância, compra o que ficou para trás. '
          f'**Tabela N → k:** ' + ' · '.join(f'{N} → {kN[N]}' for N in E.NS) + '. '
          f'**Porquê esta:** é a candidata que mais protege entre as que nunca deixaram chunks por comprar por causa da protecção: 0 em {f(F["n_pos"],0)} posições (5 cestos × 4 divisões × 25 combinações N × cadência). '
          f'Tem uma razão aritmética: com L = 2, uma perna de até 50% protegida até ao início da janela ainda compra tudo, com 3 ciclos de folga, porque 2 × (⌈N ÷ 4⌉ + 3) ≥ ⌈N ÷ 2⌉ + 6. '
          f'**O tecto de 10 tem de sair.** Em N = 60 e 86 todas as candidatas limitadas dão k = 10 e deixaram {f(F["k = 10","long"]["inc_r9"],0)} posições com chunks por comprar (até {F["k = 10","long"]["inc_chunks_max"]} chunks, {pct(F["k = 10","long"]["inc_unb_max"],1)} do capital). '
          f'A janela mínima sem folga («garantia») falhou {f(F["garantia"]["inc_r9"],0)} vezes, todas por faltar um preço num dos ciclos finais. A folga de 3 ciclos é precisamente para isso.')
    q2 = (f'**A protecção faz sentido em N = 6 e não é preciso retirar o modo suave abaixo de nenhum N:** em nenhum N o suave com ⌈N ÷ 4⌉ deixou chunks por comprar. Em N = 6, k = 2, por isso a protecção pode pausar até 4 dos 6 ciclos. '
          f'O que a cadência decide é se a protecção chega a actuar. Na diária, um token cair 25% em 6 dias é raro: a regra 9 bloqueou em {pct(100*r6[1]["r9"]/r6[1]["n"],1)} das posições. Na de 3 dias bloqueou em {pct(100*r6[3]["r9"]/r6[3]["n"],1)} e na semanal (6 semanas) em {pct(100*r6[7]["r9"]/r6[7]["n"],1)}. Com k = 10, em 0%. '
          f'**O custo é concentrar o fim.** O maior gasto num só ciclo sobe de {pct(k6[7]["mc_max"],1)} para {pct(r6[7]["mc_max"],1)} do capital na semanal e de {pct(k6[3]["mc_max"],1)} para {pct(r6[3]["mc_max"],1)} na de 3 dias; '
          + (f'na diária não muda ({pct(r6[1]["mc_max"],1)}). ' if abs(k6[1]["mc_max"] - r6[1]["mc_max"]) < 1e-9 else f'na diária, de {pct(k6[1]["mc_max"],1)} para {pct(r6[1]["mc_max"],1)}. ') +
          f'A mediana não muda ({pct(r6[7]["mc_med"],1)}): só as posições em que a protecção actua compram mais no fim.')
    rg = F['rígido']
    q3 = (f'**Modo suave:** «No modo suave, a protecção pausa o token até aos últimos K ciclos da ordem (o último quarto). Nesses ciclos, e nos 3 de tolerância, compra o que ficou para trás, mesmo que o preço continue baixo.» '
          f'K = ⌈N ÷ 4⌉ calculado para a ordem do utilizador (6 ciclos → 2; 9 → 3; 26 → 7; 86 → 22). Nesta corrida, a protecção nunca deixou chunks por comprar no modo suave. '
          f'**Modo rígido (aviso):** «No modo rígido, a protecção nunca deixa de pausar: se o token não recuperar até ao fim da ordem, essa parte não é comprada e fica na sua carteira. '
          f'No histórico que medimos (2022–2026), isso aconteceu em {pct(rg["inc_share"],0)} das ordens simuladas e chegou a deixar {pct(rg["inc_unb_max"],0)} do valor por comprar.» '
          f'Por N: ' + '; '.join(f'N = {N}: {pct(F["rígido",N]["inc_share"],1)}' for N in (6, 9, 15, 26, 60, 86)) + '. '
          f'É histórico, não promessa; se a UI mostrar os números, deve dizê-lo.')
    q4 = (f'**USDT e DAI estão registados no executor da Base**, com os feeds padrão do directório (`usdt-usd`, `dai-usd`, não os SVR); a description() on-chain confere. Os dois têm limiar de {f(fpi.loc["USDT","directory_threshold_pct"],1)}%, heartbeat de {f(fpi.loc["USDT","directory_heartbeat_s"],0)} s e maxStaleness de {f(tok["USDT"]["maxStaleness"],0)} s, como o USDC. '
          f'Rondas por heartbeat: USDT {pct(fpi.loc["USDT","heartbeat_rounds_pct"],0)}, DAI {pct(fpi.loc["DAI","heartbeat_rounds_pct"],0)} (USDC {pct(fpi.loc["USDC","heartbeat_rounds_pct"],0)}). '
          f'**Regra da banda a 1%:** na Base (Ago 2023 – Nov 2026), face ao quórum sozinho, muda {B("USDT · Base",1,"changed_vs_quorum")} decisões horárias no USDT e {B("DAI · Base",1,"changed_vs_quorum")} no DAI. '
          f'Elimina {B("USDT · Base",1,"eliminated_vs_quorum")} + {B("DAI · Base",1,"eliminated_vs_quorum")} horas de falso «fora da banda» confirmadas pela segunda série e cria {B("USDT · Base",1,"created_vs_quorum")} + {B("DAI · Base",1,"created_vs_quorum")}; quase todas as outras são horas em que o quórum não tinha preço e o feed decide ({B("USDT · Base",1,"skip_quorum")} + {B("DAI · Base",1,"skip_quorum")}). '
          f'Nos feeds de Ethereum desde Jan 2021, que incluem os descolamentos reais (USDT em Mai 2022, DAI e USDT no SVB), a regra é melhor nos dois sentidos. No USDT, o quórum marca {B("USDT · Ethereum",1,"out_quorum")} horas «fora da banda», {B("USDT · Ethereum",1,"false_out_quorum")} delas falsas pela segunda série, e perde {B("USDT · Ethereum",1,"missed_out_quorum")} das {B("USDT · Ethereum",1,"true_out")} horas realmente fora. A regra marca {B("USDT · Ethereum",1,"out_arch")}, {B("USDT · Ethereum",1,"false_out_arch")} falsas, e perde {B("USDT · Ethereum",1,"missed_out_arch")}. '
          f'Em Mai 2022 o quórum não viu o USDT sair da banda de 1% (0 horas); a regra viu {B("USDT · Mai 2022",1,"out_arch")}. '
          f'**O aviso acima de 10% aplica-se sem alterações**, porque N, R e D vêm do universo das stables e não da perna. O DAI (SVB, −10,5%, recuperou em 2,3 dias) já está entre as que recuperaram na linha dos 10%; o USDT nunca caiu mais de 10%. '
          f'**Cesto WETH + cbBTC + stable** (suave, L = 2, k = ⌈N ÷ 4⌉): 0 posições incompletas em {f((bd.basket==E.STABLE_B[0]).sum()//len(E.BANDS),0)} por stable, em todas as bandas (1%, 2%, 5%, 10%). '
          f'A stable só saiu da banda num tick diário, 12 Mar 2023 (SVB): DAI a 0,971 e USDT a 1,009. Nesse ciclo não compra a stable e recupera nos seguintes. '
          f'**EURC:** sim, a banda pode definir-se mais tarde contra o feed EUR/USD da Base (0,1% / 3 600 s): |EURC/USD ÷ EUR/USD − 1|, somando os dois limiares (0,4 pp). Não foi modelado.')
    doc.answers([('A', 'Que fórmula para k_soft, e a tabela N → k?', q1), ('A', 'O caso N = 6', q2), ('A', 'As frases para a interface', q3),
                 ('B', 'A perna stable da fase 1: USDT ou DAI', q4)])
    sec_a(doc, x, v, kt, F); sec_b(doc, bd, fp, br, aw, aev, reg, F); sec_end(doc, F)
    md = to_md(doc); open(os.path.join(ROOT, 'RESULTS-2026-11-v3.2.md'), 'w').write(md)
    import report_html
    report_html.write(doc, {}, os.path.join(ROOT, 'RESULTS-2026-11-v3.2.html'), f(len(d) + len(bd), 0), title='Basket DCA Modelação v3.2',
                      eyebrow='TeraSwap · Analista → Arquitecto · RESULTS-2026-11-v3.2', h1='Basket DCA — v3.2: a janela do modo suave e a perna stable',
                      extra_meta='k_soft por N · USDT e DAI na Base', feeds_txt='feeds Chainlink da v3.1 + USDT/DAI (Base e Ethereum)',
                      period_txt='Mar 2022 – Nov 2026 · diário, 3 dias, semanal', date_txt='13 Nov 2026')
    return doc

def _cell_inc(s):
    return '0' if s['inc_r9'] == 0 else f'{f(s["inc_r9"],0)} · {s["inc9_chunks_max"]} · {pct(s["inc9_unb_max"],1)}'

def sec_a(doc, x, v, kt, F):
    REC = E.K_REC_NAME
    doc.h2('A. A janela do modo suave: k_soft em função de N', 'ksoft')
    doc.p('**O que foi medido.** A+ discreto como na v3.1 (uma ordem DCA por perna, chunk fixo, L = 2, Hamilton, minFill 16 USD, 1 000 USD), regra 9 a 25%. No modo suave a protecção deixa de bloquear quando `t ≥ N − k_soft` e nos 3 ciclos de tolerância; no rígido bloqueia sempre. '
          '**Posições:** N ciclos a uma cadência do produto (diária, 3 dias, semanal), com N na lista do pedido e só onde cabe no prazo de 90 dias: `(N + 3) × cadência + margem ≤ 90 dias` dá até 86 ciclos na diária, 26 na de 3 dias e 9 na semanal (25 combinações). '
          'Janelas da v3.1: S1–S7 (uma posição a começar em cada dia da janela), Jul–Out 2026 (uma por dia), os 7 episódios (posições diárias às 00:00 cujo intervalo contém o movimento; as cadências horárias da v3.1 não são do produto) e a amostra de 5 anos (uma por dia desde 31 Mar 2022). '
          'Cestos: os três voláteis (VIRTUAL, COMP, AERO) e o cesto com stable, agora com USDT e com DAI (a moeda de pagamento é USDC). Cada posição corre uma vez por cada k diferente das candidatas, mais o rígido e a mesma posição sem regra 9. '
          'Quando nenhuma perna chega a cair 25% face à entrada, todas as candidatas dão o mesmo resultado e corre uma só vez.')
    doc.p('**Porque é que k = 10 não protege.** Com N ≤ 10, `N − 10 ≤ 0`, por isso a protecção nunca bloqueia no modo suave: na v3.1 os cestos semanais tinham 0 posições incompletas por isso mesmo. '
          f'Nesta corrida, com k = 10 e N ≤ 10, a regra 9 bloqueou em 0 de {f(F["k = 10","short"]["n"],0)} posições, apesar de {f(F["k = 10","short"]["prot"],0)} delas terem uma perna a cair 25% ou mais face à entrada.')
    doc.h3('As candidatas: N → k')
    rows = []
    for _, r in kt.iterrows():
        rows.append([r.N, r.cads] + [str(r[cn]) for cn in E.CAND_ORDER] + [r.n_max, 'sim' if r.cap10_ok else '**não**'])
    doc.table(['N', 'Cadências em que cabe', 'k = 10', '⌈N ÷ 2⌉', '⌈N ÷ 3⌉', '⌈N ÷ 4⌉', '⌈N ÷ 4⌉ sem tecto', '«garantia»', 'Maior n_i (1 000 USD)', '2 × (10 + 3) ≥ maior n_i?'], rows,
              'Mínimo 1 em todas; tecto 10 nas quatro do pedido · as duas últimas são minhas: «⌈N ÷ 4⌉ sem tecto» porque o tecto parte a garantia em ordens longas, '
              '«garantia» = a janela mínima com que uma perna protegida até ao início ainda compra todos os chunks (⌈n_max ÷ L⌉ − 3), sem folga · varia com a divisão', num_cols=[0, 8])
    doc.h3('As candidatas lado a lado')
    rows = []
    XG = {k_: q_ for k_, q_ in x.assign(Ng=ngrp(x.N)).groupby(['grp', 'cand', 'Ng'])}
    for g in ('vol3', 'stable'):
        for cn in E.CAND_ORDER + ['rígido']:
            for ng in NG:
                s = stats(XG[(g, cn, ng)]); w = v[(v.grp == g) & (v.cand == cn) & (v.Ng == ng)]
                w = w.iloc[0] if len(w) else None
                rows.append([GRPL[g] if cn == E.CAND_ORDER[0] and ng == NG[0] else '', CL[cn] if ng == NG[0] else '', ng, f(s['n'], 0), pct(100 * s['r9'] / s['n'], 1),
                             _cell_inc(s),
                             '—' if cn == 'rígido' else f'{pct(s["pf_share"],1)} · {pct(s["pf_spent_mean"],1)} · {pct(s["pf_drop"],1)}',
                             f'{pct(s["mc_p95"],1)} / {pct(s["mc_max"],1)}',
                             '—' if w is None else f'{pct(w.better,0)} / {pct(w.worse,0)} · {f(w.med,2)}% ({f(w.p5,1)} / {f(w.p95,1)})'])
    doc.table(['Cesto', 'Candidata', 'N', 'Posições', 'A regra 9 bloqueou (posições)', 'Incompletas por causa da protecção: n · máx. chunks · máx. % do capital',
               'Compras com a perna protegida: % das posições · % do capital (média) · queda média face à entrada', 'Maior gasto num ciclo, % do capital: P95 / máx.',
               'Valor face a sem regra 9 (histórico): melhor / pior · mediana (P5 / P95)'], rows,
              '«Bloqueou» = num ciclo com compras devidas, a regra 9 tirou uma perna com chunks por comprar · «incompletas por causa da protecção» = ficaram chunks por comprar e a mesma posição sem regra 9 completou · '
              'valor no fim da posição, em % de 1 000 USD, só nas posições onde uma perna caiu 25%; empate < 0,01%', num_cols=[3])
    doc.p(f'**Leitura.** (1) Protecção a actuar: com k = 10 a regra 9 nunca bloqueia em N ≤ 10. As candidatas proporcionais fazem-na actuar em todos os N, e mais quanto menor o k. '
          f'(2) Garantia: só deixaram chunks por comprar as candidatas com tecto, em N = 60 e 86 (porque aí k = 10), e a «garantia», que não tem folga. ⌈N ÷ 4⌉ sem tecto: 0. '
          f'(3) O modo suave não evita a compra, adia-a. As compras com a perna ainda protegida acontecem na janela final, com o token em média ~{f(-F[REC]["pf_drop"],0)}% abaixo da entrada. É o preço de completar a ordem, e a frase da UI tem de o dizer. '
          f'(4) Concentração: um k menor empurra mais compras para a janela final; com N pequeno, um chunk é ~1/N do capital, por isso o máximo num ciclo sobe (tabela por N abaixo). '
          f'(5) Valor (histórico, nunca promessa): nas posições em que uma perna caiu 25%, pausar e comprar depois deu, em mediana, o mesmo valor que comprar sempre. Mas foi pior mais vezes do que melhor, '
          f'e a média é ligeiramente negativa (3 voláteis, 6 a 9 ciclos: {pct(v[(v.grp=="vol3")&(v.cand==REC)&(v.Ng=="6–9")].worse.iloc[0],0)} pior, {pct(v[(v.grp=="vol3")&(v.cand==REC)&(v.Ng=="6–9")].better.iloc[0],0)} melhor, média {f(v[(v.grp=="vol3")&(v.cand==REC)&(v.Ng=="6–9")]["mean"].iloc[0],2)}%). '
          f'A protecção existe para não comprar durante a queda, não para prometer melhor preço.')
    doc.h3(f'A recomendada (⌈N ÷ 4⌉ sem tecto), por N')
    rows = []
    XN = {k_: q_ for k_, q_ in x[x.cand.isin([REC, 'k = 10', 'rígido'])].groupby(['grp', 'cand', 'N'])}
    for g in ('vol3', 'stable'):
        for N in E.NS:
            s = stats(XN[(g, REC, N)]); s10 = stats(XN[(g, 'k = 10', N)]); sr = stats(XN[(g, 'rígido', N)])
            rows.append([GRPL[g] if N == E.NS[0] else '', N, int(kt.set_index('N').loc[N, REC]), f(s['n'], 0), pct(100 * s['prot'] / s['n'], 1),
                         f'{pct(100*s["r9"]/s["n"],1)} ({f(s["r9_cyc_med"],0)})', _cell_inc(s),
                         f'{pct(s["pf_share"],1)} · {pct(s["pf_spent_mean"],1)} · {pct(s["pf_drop"],1)}',
                         f'{pct(s10["mc_max"],1)} → {pct(s["mc_max"],1)}', f'{pct(sr["inc_share"],1)} · {pct(sr["inc_unb_max"],1)}'])
    doc.table(['Cesto', 'N', 'k', 'Posições', 'Uma perna caiu 25%', 'A regra 9 bloqueou (ciclos, mediana)', 'Incompletas por causa da protecção', 'Compras com a perna protegida: % posições · % capital · queda',
               'Maior gasto num ciclo: k = 10 → ⌈N ÷ 4⌉', 'Rígido: incompletas · máx. por comprar'], rows,
              'Todas as cadências em que o N cabe · «uma perna caiu 25%» = a protecção pode disparar (decisão ≤ 75% da entrada em algum ciclo)', num_cols=[1, 2, 3])
    doc.h3('Ordens curtas, por cadência (N = 6 a 9)')
    rows = []
    for N in (6, 7, 8, 9):
        for c in E.CADS:
            s = F[REC, N, c]; s10 = F['k = 10', N, c]; sr = F['rígido', N, c]
            rows.append([N if c == 1 else '', CADL[c], f(s['n'], 0), pct(100 * s['prot'] / s['n'], 1), pct(100 * s['r9'] / s['n'], 1),
                         f'{pct(s["pf_share"],1)} · {pct(s["pf_spent_mean"],1)}', f'{pct(s10["mc_max"],1)} → {pct(s["mc_max"],1)} (mediana {pct(s["mc_med"],1)})',
                         f'{pct(sr["inc_share"],1)} · {pct(sr["inc_unb_max"],1)}'])
    doc.table(['N', 'Cadência', 'Posições', 'Uma perna caiu 25%', 'A regra 9 bloqueou', 'Compras com a perna protegida: % posições · % capital', 'Maior gasto num ciclo: k = 10 → ⌈N ÷ 4⌉', 'Rígido: incompletas · máx. por comprar'], rows,
              'Os cinco cestos · com k = 10 a regra 9 nunca bloqueia nestes N', num_cols=[0, 2])

def sec_b(doc, bd, fp, br, aw, aev, reg, F):
    doc.h2('B. A perna stable da fase 1 na Base: USDT ou DAI', 'stable')
    doc.h3('B1. O registo e os feeds')
    rows = []
    for t_ in reg['tokens']:
        rows.append([t_['symbol'], 'sim' if t_['registered'] else ('não' if t_.get('in_catalog') else 'não está no catálogo da Base do repo'),
                     t_.get('directory_path') or '—', f(t_['maxStaleness'], 0) if t_['registered'] else '—',
                     '—' if t_.get('directory_threshold_pct') is None else f'{f(t_["directory_threshold_pct"],1)}% / {f(t_["directory_heartbeat_s"],0)} s',
                     t_.get('description_onchain') or '—'])
    doc.table(['Token', 'Registado em `tokenUsdFeeds`', 'Feed (directório, igual ao registado)', 'maxStaleness (s)', 'Limiar / heartbeat (directório)', 'description() on-chain'], rows,
              f'OrderExecutorV3 da Base (de docs/DEPLOYMENTS.md), lido a {reg["read_at_utc"]} UTC · tokens do catálogo da Base do repo · o feed registado é comparado com o directório da Chainlink por igualdade de endereço, nunca escrito à mão', num_cols=[3])
    rows = []
    for _, r in fp.iterrows():
        rows.append([r.feed, f'{f(r.directory_threshold_pct,1)}% / {f(r.directory_heartbeat_s,0)} s', f(r.max_staleness_s, 0), f(r.rounds, 0), dmy(r.first_round),
                     f(r.median_gap_h, 2) + ' h', pct(r.heartbeat_rounds_pct, 1), f'{r.deviation_rounds} ({pct(r.dev_step_median_pct,2)})',
                     f'{f(r.median_age_h,1)} h / {f(r.max_age_h,1)} h', r.hours_over_max_staleness, f'{f(r.min_price,4)} – {f(r.max_price,4)}'])
    doc.table(['Feed', 'Limiar / heartbeat', 'maxStaleness (s)', 'Rondas', 'Primeira ronda', 'Intervalo mediano', 'Rondas por heartbeat', 'Rondas por desvio (passo mediano)',
               'Idade da ronda, hora a hora: mediana / máx.', 'Horas acima do maxStaleness', 'Preço lido: mín. – máx.'], rows,
              'Todas as rondas on-chain desde o lançamento · «por heartbeat» = intervalo ≥ 90% do heartbeat (o mesmo critério da v3 para o USDC) · USDC na última linha, para comparar', num_cols=[2, 3, 9])
    doc.p(f'**Leitura.** Os três feeds de stables da Base comportam-se da mesma forma: actualizam quase só por heartbeat (uma ronda por dia) e nunca passaram do maxStaleness (90 000 s para 86 400 s de heartbeat: 1 hora de margem). '
          f'O preço do DAI nunca saiu de {f(fp.set_index("token").loc["DAI","min_price"],4)}–{f(fp.set_index("token").loc["DAI","max_price"],4)} na Base, e o do USDT de {f(fp.set_index("token").loc["USDT","min_price"],4)}–{f(fp.set_index("token").loc["USDT","max_price"],4)}. Não houve descolamento desde que os feeds existem. '
          'Com a tua regra, o limiar de 0,3% cabe em qualquer banda ≥ 1%, por isso o feed decide sempre, enquanto a ronda tiver menos de 90 000 s.')
    doc.h3('B2. A regra da banda em USDT e DAI')
    rows = []
    for _, r in br.iterrows():
        rows.append([r.scope, pct(r.band_pct, 0), f(r.hours, 0), f(r.hours_with_2nd_series, 0), f'{r.changed_vs_quorum} ({r.stricter_vs_quorum} / {r.looser_vs_quorum})',
                     f'{r.out_quorum} / {r.out_v31} / {r.out_arch}', f'{r.false_out_quorum} / {r.false_out_v31} / {r.false_out_arch}', f'{r.eliminated_vs_quorum} / {r.created_vs_quorum}',
                     f'{r.true_out}: {r.missed_out_quorum} / {r.missed_out_arch}', f'{r.skip_quorum} / {r.skip_arch}'])
    doc.table(['Período e feed', 'Banda', 'Horas', 'Horas com 2.ª série', 'Decisões que mudam face ao quórum (mais estrita / menos)', 'Horas «fora da banda»: quórum / v3.1 (600 s) / tua regra',
               'Falsas pela 2.ª série: quórum / v3.1 / tua regra', 'Falsos «fora» eliminados / criados pela tua regra', 'Horas fora pela 2.ª série: perdidas pelo quórum / pela tua regra', 'Horas sem preço: quórum / tua regra'], rows,
              'Hora a hora · quórum = DefiLlama (aproximação declarada) · 2.ª série = velas horárias da Coinbase (USDT-USD, DAI-USD; abertura da hora; a de DAI acaba em Mai 2026) · '
              '«v3.1 (600 s)» = o interruptor P (feed só se a ronda tiver ≤ 600 s) · tua regra = feed até ao maxStaleness, fora se |p − 1| + limiar > banda, senão quórum, sem preço salta · '
              'Ethereum: limiar 0,25%, feed aceite até heartbeat × 90 000 ÷ 86 400 (USDT 90 000 s; DAI 3 750 s)', num_cols=[2, 3])
    e1 = br[(br.band_pct == 1)]
    def g(sc_, c): return int(e1[e1.scope.str.startswith(sc_)][c].iloc[0])
    doc.p(f'**Leitura.** Na Base não houve descolamento: as poucas decisões que mudam são horas em que o DefiLlama marcava fora ou não tinha preço e o feed (fresco) dizia dentro. '
          f'Nos feeds de Ethereum desde 2021, a tua regra corta a maior parte dos falsos alarmes do quórum (USDT: {g("USDT · Ethereum","false_out_quorum")} → {g("USDT · Ethereum","false_out_arch")}; DAI: {g("DAI · Ethereum","false_out_quorum")} → {g("DAI · Ethereum","false_out_arch")}). '
          f'E perde menos horas verdadeiramente fora da banda do que o quórum (USDT: {g("USDT · Ethereum","missed_out_quorum")} → {g("USDT · Ethereum","missed_out_arch")} de {g("USDT · Ethereum","true_out")}; DAI: {g("DAI · Ethereum","missed_out_quorum")} → {g("DAI · Ethereum","missed_out_arch")} de {g("DAI · Ethereum","true_out")}). Em Mai 2022 o DefiLlama nunca pôs o USDT abaixo de 0,99 nos pontos horários; o feed de Ethereum leu 0,9756. '
          'No SVB, o USDT também saiu da banda, mas para cima: 1,009 às 00:00 de 12 Mar 2023. A banda é simétrica, por isso bloqueia o prémio como bloqueia a queda.')
    doc.h3('B3. O aviso acima de 10% com USDT ou DAI')
    rows = [[f'{int(r.band_pct)}%', r.N_stables, r.R_stables, ('sim' if r.USDT_in_N else 'não') + (' (recuperou)' if r.USDT_in_R else ''), ('sim' if r.DAI_in_N else 'não') + (' (recuperou)' if r.DAI_in_R else ''), r.text]
            for _, r in aw.iterrows()]
    doc.table(['Banda X', 'N', 'R', 'USDT entre as N', 'DAI entre as N', 'Texto (igual ao da v3.1)'], rows,
              f'results/v31/aviso_banda.csv sem alterações · D = {int(aw.days.iloc[0])} dias · as três regras de redacção da v3.1 (singular com R = 1; «nenhuma recuperou» com R = 0; com 100% só a frase dos 80%)', num_cols=[1, 2])
    ev_txt = '; '.join(f'{r.symbol} {dmy(r.start)}: −{f(r.max_drop_pct,1)}%, recuperou em {f(r.days_to_recover,1)} dias' for _, r in aev.iterrows())
    doc.p(f'**Confirmação.** O aviso não depende da perna: N, R e D vêm do inventário de todas as stables com ≥ 50 M USD (T7), não da stable escolhida. Por isso o texto é o mesmo com USDT ou DAI. '
          f'Descolamentos de USDT e DAI no inventário desde 30 Dez 2020: {ev_txt}. O DAI conta como «caiu mais de 10% e recuperou» na linha dos 10%; acima de 10,5% nenhum dos dois conta. '
          'O feed também não muda o limiar efectivo: 0,3% na Base, como o USDC.')
    doc.h3('B4. O cesto WETH + cbBTC + stable, por banda')
    rows = []
    for b in E.STABLE_B:
        for band in E.BANDS:
            for c in E.CADS:
                q = bd[(bd.basket == b) & (bd.band_pct == band * 100) & (bd.cadence_d == c)]; p = q[q.pending_chunks > 0]
                rows.append([b.split('+')[-1] if band == E.BANDS[0] and c == 1 else '', pct(band * 100, 0) if c == 1 else '', CADL[c], f(len(q), 0),
                             f'{f(len(p),0)} ({pct(100*len(p)/max(1,len(q)),2)})',
                             '—' if p.empty else f'{int(p.pending_chunks.min())} / {f(p.pending_chunks.median(),0)} / {int(p.pending_chunks.max())}',
                             '—' if p.empty else f'{f(p.unbought_pct.min(),1)} / {f(p.unbought_pct.median(),1)} / {f(p.unbought_pct.max(),1)}',
                             f'{f((q.band_cycles>0).sum(),0)} · {f(q.idle_banda.sum(),0)}', f(q.idle_sem_preco.sum(), 0)])
    doc.table(['Stable', 'Banda', 'Cadência', 'Posições', 'Fecham com chunks por executar', 'Chunks por executar (mín. / med. / máx.)', 'Por comprar, % do capital (mín. / med. / máx.)',
               'Posições com a stable fora da banda · ciclos sem compra por banda', 'Ciclos sem compra por falta de preço'], rows,
              'Modo suave, L = 2, k = ⌈N ÷ 4⌉, regra da banda do Arquitecto · todas as janelas e todos os N do produto · a stable é a perna 3 (50% na divisão 25-25-50) · '
              'preço de execução = feed da Base desde Ago 2023, antes o mesmo feed em Ethereum', num_cols=[3])
    sb = bd[bd.band_pct == 1]
    assert (bd.pending_chunks > 0).sum() == 0 and set(bd[bd.band_cycles > 0].start.str[:7]) <= {'2022-12', '2023-01', '2023-02', '2023-03'}
    doc.p('**Leitura.** Nenhuma posição ficou incompleta, em nenhuma banda e com nenhuma das duas stables. Nos ticks diários às 00:00, a stable só saiu da banda uma vez: 12 Mar 2023 (SVB), com o DAI a 0,971 e o USDT a 1,009 (acima do peg). '
          'Isso afecta a banda de 1% nas duas e a de 2% no DAI. Nesse ciclo a stable não compra; os seus chunks passam para os ciclos seguintes, já dentro da banda. '
          'O USDT em Mai 2022 caiu durante o dia, mas às 00:00 estava dentro da banda; o cesto diário não o vê. É uma limitação da cadência diária, não da regra.')

def sec_end(doc, F):
    doc.h2('Testes do motor', 'testes')
    doc.ul(['`test_int_and_function_k_are_the_same_engine`: k = 10 e uma função que devolve 10 dão as mesmas compras (S1–S7).',
            '`test_v31_results_are_reproduced`: as corridas da v3.1 (A+ discreto, S1–S7, suave e rígido, L = 1 e 2) saem iguais do motor da v3.2.',
            '`test_chosen_k_always_leaves_rule9_room_and_fits_every_chunk`: para cada N do produto e cada divisão, a fórmula escolhida dá 1 ≤ k < N (a regra 9 pode bloquear) e 2 × (k + 3) ≥ maior n_i.',
            '`test_chosen_k_protects_short_orders_on_real_windows`: posições semanais N = 6 a 9 em S1–S7. Com k = 10 a regra 9 nunca bloqueia; com a fórmula escolhida bloqueia.',
            '`test_chosen_k_never_leaves_chunks_for_rule9_alone`: os 5 cestos, S1–S7, todas as combinações N × cadência. No suave, uma posição só fica incompleta se também ficar sem regra 9.',
            '`test_protected_fill_metrics_and_band_rule`: a métrica das compras com a perna protegida bate com as compras, e a stable nunca compra com |p − 1| + limiar > banda.',
            'Os 17 testes da v2, v3 e v3.1 continuam a passar.'])
    doc.h2('O que não foi medido, e porquê', 'naomedido')
    doc.ul(['**Os feeds USDT e DAI da Base antes de Ago 2023**: não existiam. Antes disso, a perna stable usa o mesmo feed em Ethereum (limiar 0,25%; maxStaleness na proporção do executor da Base), como na v3.1.',
            '**O executor a recusar um feed acima do maxStaleness**: o preço de execução é o do feed no tick, como na v3.1. Na Base isto nunca aconteceu nas stables (0 horas acima de 90 000 s).',
            '**O quórum real** (CoinGecko sem histórico) e a disponibilidade ao vivo do DefiLlama: aproximados pelo DefiLlama horário, como na v3 e na v3.1.',
            '**Divisões com uma perna acima de 50%**: as quatro divisões medidas vão até 50%. Com uma perna maior, a folga de 3 ciclos de ⌈N ÷ 4⌉ encolhe (a 60% e N = 60, 36 chunks para 36 de capacidade: sem folga). Não medido.',
            '**O segundo chunk de L = 2 meio ciclo depois**: modelado no mesmo tick, como na v3.1.',
            '**Gas e a ordem real do keeper dentro do ciclo**: como na v3.1.',
            '**EURC**: fora do pedido.'])
    doc.h2('O que isto muda na spec (proposta)', 'spec')
    doc.ol(['**`k_soft = max(1, ⌈N ÷ 4⌉)`, sem tecto.** Substitui o k = 10 fixo. A UI mostra o K da ordem: «a protecção pausa o token até aos últimos K ciclos».',
            '**Modo suave por defeito, sem excepção para ordens curtas.** Com N = 6 a protecção actua; o custo é concentrar o fim, e a frase da UI di-lo.',
            '**Aviso no modo rígido** com a frase da resposta A e os números do histórico, marcados como histórico.',
            '**Perna stable da fase 1: USDT ou DAI**, os dois registados na Base com 0,3% / 86 400 s / maxStaleness 90 000 s. A regra da banda e o aviso acima de 10% aplicam-se sem alterações.',
            '**Se as divisões permitirem uma perna acima de 50%**, rever a folga (ou limitar a perna a 50%).'])
