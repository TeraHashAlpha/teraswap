"""RESULTS-2026-11-v3.3.md (+ HTML): Coinbase tokenized stocks (Base) as Split DCA legs. v2–v3.2 are not touched."""
import os, sys, json, hashlib, numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import experiments_v33 as X
from docmodel import Doc, to_md
from report import f, pct, dmy
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
R33 = X.R33
CADL = {1: 'diária', 3: '3 dias', 7: 'semanal'}
OPTL = {'A': 'A · a acção fica sem preço com o mercado fechado', 'B': 'B · ciclos só em dias de mercado',
        'C90': 'C · compra ao preço do DEX; piso on-chain até 90 000 s', 'C3d': 'C · compra ao preço do DEX; piso on-chain até 100 h',
        'Cfz': 'C com decisão no feed parado (só para medir o viés)'}

def compute(): X.compute()

def load():
    r = pd.read_csv(os.path.join(R33, 'real_window.csv.gz'), low_memory=False)
    l = pd.read_csv(os.path.join(R33, 'long_window.csv.gz'), low_memory=False)
    return r, l

def summ(q):
    p = q[q.pending_chunks > 0]; gn = q.gap_n.sum() if 'gap_n' in q else 0
    out = dict(n=len(q), inc=len(p), inc_pct=100 * len(p) / max(1, len(q)), inc_chunks_max=int(p.pending_chunks.max()) if len(p) else 0,
               unb_max=float(p.unbought_pct.max()) if len(p) else 0.0, mc_p95=float(q.max_cycle_pct.quantile(.95)), mc_max=float(q.max_cycle_pct.max()),
               grace_mean=float(q.fills_in_grace.mean()))
    if 'stock_usd_closed' in q:
        out.update(closed_cap=float(q.stock_usd_closed.mean() / 10), closed_pos=100 * float((q.stock_fills_closed > 0).mean()),
                   gap_mean=100 * float(q.gap_sum.sum() / gn) if gn else np.nan,
                   gap_pos_p5=100 * float((q.gap_sum / q.gap_n.replace(0, np.nan)).quantile(.05)),
                   gap_pos_p95=100 * float((q.gap_sum / q.gap_n.replace(0, np.nan)).quantile(.95)), gap_max=100 * float(q.gap_max.max()))
    return out

def b_max_n():
    """Under B (cycles only on market days), the largest N whose last extra cycle stays inside 90 days, over every
    market-day start of the NYSE calendar seen on-chain (Sep 2023 – Nov 2026): worst start and median start."""
    days = sorted(X.long_calendar()); dset = set(days); rows = []
    for c in (1, 3, 7):
        best = []
        for k0 in range(1, len(days) - 200):
            start = pd.Timestamp(days[k0]); prev = pd.Timestamp(days[k0 - 1]) if c == 1 else None
            seq = []
            if c == 7:
                for k in range(0, 120):
                    d = start + pd.Timedelta(days=7 * k)
                    while d.date() not in dset and d < pd.Timestamp(days[-1]): d += pd.Timedelta(days=1)
                    seq.append(d)
                prev = start - pd.Timedelta(days=7)
            else:
                seq = [pd.Timestamp(days[j]) for j in range(k0, min(len(days), k0 + 400), c)]
                prev = pd.Timestamp(days[k0 - c]) if k0 - c >= 0 else start - pd.Timedelta(days=c)
            n_ok = 0
            for N in range(1, len(seq) - X.G):
                if (seq[N + X.G - 1] - prev).days + c < 90: n_ok = N        # as (N + 4) x T: one more cycle after the last extra one
                else: break
            best.append(n_ok)
        cal = max(N for N in range(6, 90) if X.fits(N, c))
        rows.append(dict(cadence=CADL[c], calendar_max=cal, b_max_worst=int(min(best)), b_max_median=int(np.median(best))))
    return pd.DataFrame(rows)

def split_case(l):
    """Positions of ETH+BTC+NVDA (option A) whose span covers the 10:1 split of 10 Jun 2024: raw per-share price
    against the split-adjusted (total-return-like) price, same positions."""
    q = l[(l.basket == 'ETH+BTC+NVDA') & (l.option == 'A') & (l.cadence_d.isin([1, 3]))].copy()   # weekly A fails for another reason (§3)
    st = pd.to_datetime(q.start); q = q[(st <= '2024-06-10') & (st + pd.to_timedelta(q.span_days, unit='D') >= '2024-06-11')]
    rows = []
    for mode in ('soft', 'rigid'):
        a = q[(q.variant == 'adj') & (q['mode'] == mode)].set_index(['start', 'cadence_d', 'N', 'split'])
        r = q[(q.variant == 'raw') & (q['mode'] == mode)].set_index(['start', 'cadence_d', 'N', 'split'])
        j = a.join(r, lsuffix='_adj', rsuffix='_raw', how='inner')
        rows.append(dict(mode=mode, n=len(j), r9_adj=100 * float((j.r9_cycles_adj > 0).mean()), r9_raw=100 * float((j.r9_cycles_raw > 0).mean()),
                         prot_adj=float(j.prot_stock_adj.mean()), prot_raw=float(j.prot_stock_raw.mean()),
                         inc_adj=int((j.pending_chunks_adj > 0).sum()), inc_raw=int((j.pending_chunks_raw > 0).sum()),
                         unb_raw_max=float(j.unbought_pct_raw.max()), mc_adj_max=float(j.max_cycle_pct_adj.max()), mc_raw_max=float(j.max_cycle_pct_raw.max())))
    return pd.DataFrame(rows)

def write():
    r, l = load(); feeds = pd.read_csv(os.path.join(R33, 'feeds.csv')); clr = pd.read_csv(os.path.join(R33, 'closures_real.csv'))
    cll = pd.read_csv(os.path.join(R33, 'closures_long.csv')); wm = pd.read_csv(os.path.join(R33, 'weekend_moves_long.csv'))
    cll = cll[cll.last_open >= '2023-09-07']
    bmax = b_max_n(); sc = split_case(l); bmax.to_csv(os.path.join(R33, 'b_max_n.csv'), index=False); sc.to_csv(os.path.join(R33, 'split_case.csv'), index=False)
    md5 = {v: hashlib.md5(open(os.path.join(ROOT, f'RESULTS-2026-11{v}.md'), 'rb').read()).hexdigest()[:8] for v in ('', '-v3', '-v3.1', '-v3.2')}
    cfg = json.load(open(os.path.join(X.V33, 'feeds_v33.json'))); ver = pd.read_csv(os.path.join(X.V33, 'feed_verification_v33.csv'))
    toks = json.load(open(os.path.join(X.V33, 'coinbase_tokenized_stocks.json')))
    S = {}
    for (o, c), q in r.groupby(['option', 'cadence_d']): S[o, c] = summ(q)
    for o, q in r.groupby('option'): S[o] = summ(q)
    for (o, k), q in r.groupby(['option', 'kind']): S[o, k] = summ(q)
    bias = {o: 100 * q.sel_closed_stock.sum() / q.sel_closed.sum() for o, q in r[r.kind == '2 cripto + 1 acção'].groupby('option') if q.sel_closed.sum()}
    seven = feeds[feeds.symbol.isin(X.STOCKS) & feeds.key.str.startswith('cb_')]
    wk = clr[clr.hours < 60]; hol = clr[clr.hours >= 60]
    up3 = 100 * float((wm.move_pct > 100 * (1 / (1 - X.SLIP) - 1)).mean()); n_cl = len(cll); n3 = int((cll.closed_days == 3).sum())
    # facts the text states, asserted
    assert S['C3d']['inc'] == 0 and S['C90']['inc'] == 0 and S['B']['inc'] == 0 and S['A', 7]['inc_pct'] > 20
    assert (seven.max_step_pct < 10).all() and int(cll.closed_days.max()) == 3 and len(hol) == 1
    assert S['C3d']['closed_cap'] == S['C90']['closed_cap']
    assert int(r[(r.option == 'C3d') & r.basket.str.endswith('USDT')].idle_banda.sum()) == 0
    doc = Doc()
    doc.h1('Basket DCA — modelação v3.3: acções tokenizadas da Coinbase como pernas do Split DCA')
    doc.p(f'**Pedido:** o dono (16 Nov 2026), depois da avaliação `claude/accoes-tokenizadas-base-avaliacao-2026-11-16.md`: listar as acções no swap (com aviso e bloqueio) e resolver o Split DCA com acções. '
          f'**Pacote:** o mesmo; `python3 run_all.py --v33-only` refaz só esta parte; v2 a v3.2 não mudam (md5 dos relatórios: `{md5[""]}`, `{md5["-v3"]}`, `{md5["-v3.1"]}`, `{md5["-v3.2"]}`). Tabelas em `results/v33/`.')
    doc.callout('Separação de sempre: **(a)** a garantia — a ordem completa? quanto fica por comprar? quanto se concentra num ciclo? — e **(b)** o preço pago: histórico, nunca promessa.')
    # ---------------- answers
    q0 = ('**Uma correcção ao que disse ao dono a 16 Nov.** Escrevi que, com o maxStaleness de 90 000 s, «o executor recusa as acções ao fim-de-semana». Não é assim. '
          'No `TeraSwapOrderExecutorV3.sol`, um feed parado não reverte nada: `_readFeedUsd` devolve `ok = false` e o piso do oráculo desaparece; fica só o mínimo assinado pelo utilizador (`scaledMin`), como para um par sem feed. '
          'Com 90 000 s, isso acontece em todos os fins-de-semana, a partir de 25 h depois da última ronda. A compra não pára; perde o piso do oráculo.')
    c7 = S['A', 7]
    q1 = (f'**Recomendo a opção C: ao fim-de-semana e nos feriados, a perna da acção compra ao preço on-chain (DEX), e o keeper decide pelo preço do ADR-024, como em qualquer perna.** '
          f'Na janela real (25 Ago – 15 Nov 2026, {f(S["C3d"]["n"],0)} posições, 8 cestos, todas as cadências): 0 posições incompletas, maior gasto num ciclo {pct(S["C3d"]["mc_max"],0)}. '
          f'Na diária, {pct(S["C3d",1]["closed_cap"],0)} do capital das acções foi comprado com o mercado fechado. Face ao primeiro preço da reabertura, essas compras pagaram em média {f(S["C3d",1]["gap_mean"],2)}% '
          f'(por posição: P5 {f(S["C3d",1]["gap_pos_p5"],1)}%, P95 {f(S["C3d",1]["gap_pos_p95"],1)}%; pior compra +{f(S["C3d"]["gap_max"],1)}%; histórico). '
          f'**A opção A (a acção fica sem preço com o mercado fechado) tem de ser rejeitada.** Na semanal, um ciclo que caia ao sábado ou domingo cai sempre nesse dia, e a perna nunca compra: {pct(c7["inc_pct"],0)} das posições semanais ficaram incompletas (até {pct(c7["unb_max"],0)} do capital). Na amostra longa (Set 2023 – Nov 2026) foram 28%. '
          f'**A opção B (ciclos só em dias de mercado) também completa sempre** (0 incompletas, maior gasto num ciclo {pct(S["B"]["mc_max"],0)}). Mas atrasa as pernas cripto e reduz o N máximo da ordem: na diária, de {int(bmax.iloc[0].calendar_max)} para {int(bmax.iloc[0].b_max_worst)} no pior arranque; na de 3 dias, de {int(bmax.iloc[1].calendar_max)} para {int(bmax.iloc[1].b_max_worst)}. É a alternativa se o dono não quiser comprar acções fora do horário dos EUA.')
    q2 = (f'**Registar os feeds com maxStaleness de 360 000 s (100 h).** Os fechos do mercado 24/5 são de 48 h (fim-de-semana) e 72 h (fim-de-semana com feriado: {n3} em {n_cl} fechos desde Set 2023, pelo calendário da NYSE). '
          f'A última ronda pode chegar até um heartbeat (24 h) antes do fecho, por isso a idade pode chegar às 96 h. Nos feeds reais da Coinbase, o maior silêncio foi de {f(feeds[feeds.key.str.startswith("cb_")].max_gap_h.max(),1)} h (fim-de-semana do Labor Day). '
          f'Com 100 h, o último preço de fecho serve de piso em todos os fechos. Com 90 000 s, o piso desaparece a meio de cada fim-de-semana. '
          f'**Custo:** na janela real, nenhuma compra de fim-de-semana falhou o piso de 3% (os preços DEX ficaram a ±1% do fecho: P5/P95). Na amostra longa, em {pct(up3,1)} dos pares fecho × acção a reabertura ficou mais de 3,09% acima do fecho; só aí uma compra de fim-de-semana poderia ser recusada pelo piso, e só se o DEX já tivesse antecipado a subida. '
          f'**O registo tem de ser executado num dia de mercado:** `executeTokenUsdFeed` exige `block.timestamp − updatedAt < 86400` («Feed seems dead»). '
          f'**Isto vale também para o DCA simples** nestas acções: o registo dá-lhe o mesmo piso ao fim-de-semana.')
    q3 = (f'**O viés da regra 4 é desprezável e não pede regra nova.** O keeper decide pelo ADR-024 (feed só se a ronda tiver ≤ 600 s, senão DefiLlama). Nas acções isto quer dizer DefiLlama na maior parte das horas, mesmo com o mercado aberto: o feed decide em {f(seven.decided_by_feed_pct.min(),0)}–{f(seven.decided_by_feed_pct.max(),0)}% das horas, consoante a acção. '
          f'Ao fim-de-semana o preço DEX continua a mexer (pouco). Se o keeper decidisse pelo feed parado (0% de variação), a acção ganharia a primeira compra do ciclo em {pct(bias.get("Cfz",np.nan),1)} dos ciclos fechados, contra {pct(bias.get("C3d",np.nan),1)} com o ADR-024 (cestos 2 cripto + 1 acção).')
    s_soft = sc[sc['mode'] == 'soft'].iloc[0]; s_rig = sc[sc['mode'] == 'rigid'].iloc[0]
    q4 = (f'**Splits e eventos corporativos: os feeds da Coinbase são de retorno total e não têm salto.** Maior variação entre rondas consecutivas, nas 7 acções: {f(seven.max_step_pct.max(),1)}% (resultados de empresa, não splits). '
          f'Não houve nenhum congelamento em dia útil na janela (os {len(clr)} fechos foram fins-de-semana e um feriado). '
          f'**O perigo está num preço por acção.** O feed NVDA/USD da Arbitrum (per-share) mostra o split de 10:1 de 10 Jun 2024 como uma queda de 90%. Nas {f(s_soft.n,0)} posições ETH + BTC + NVDA que atravessam o split, esse preço disparou a regra 9 em {pct(s_soft.r9_raw,0)} das posições, contra {pct(s_soft.r9_adj,0)} com o preço ajustado. '
          f'No modo suave ficaram {int(s_soft.inc_raw)} posições incompletas contra {int(s_soft.inc_adj)}; no rígido, {int(s_rig.inc_raw)} contra {int(s_rig.inc_adj)} (até {pct(s_rig.unb_raw_max,0)} por comprar). Cadências diária e de 3 dias. '
          f'**Regras para o keeper:** (1) a perna de uma acção usa só preços do próprio token (o feed da Coinbase ou o DefiLlama/DEX do token), nunca um feed por acção; '
          f'(2) quando o registo de oráculos da Coinbase tem a pausa ligada (evento corporativo), a perna fica «sem preço» nesse ciclo (ADR-024: salta o ciclo, nunca a ordem). O endereço e a ABI do registo não estão na documentação lida; o goal do keeper tem de os ler on-chain.')
    tab = {k: S['C3d', k] for k in ('2 cripto + 1 acção', '1 cripto + 2 acções', '3 acções', 'cripto + acção + stable', '2 acções + stable')}
    q5 = ('**Todas as combinações completam com a opção C** (0 incompletas). Maior gasto num ciclo e capital das acções comprado com o mercado fechado: ' +
          '; '.join(f'{k}: {pct(v["mc_max"],0)} e {pct(v["closed_cap"],0)}' for k, v in tab.items()) + '. '
          'Com três acções, todas as posições compraram alguma coisa com o mercado fechado. Com uma stable, a banda de 1% não bloqueou a USDT nenhuma vez neste período. Proposta: permitir todas, com no máximo uma stable, como hoje.')
    doc.answers([('0', 'Correcção: o que o executor faz com um feed parado', q0), ('2', 'maxStaleness dos feeds das acções', q2), ('3', 'Ciclos ao fim-de-semana e nos feriados', q1),
                 ('4', 'A regra 4 com o preço parado', q3), ('5', 'Splits e eventos corporativos', q4), ('6', 'Que combinações de pernas', q5)])
    detail(doc, r, l, feeds, clr, cll, wm, bmax, sc, S, bias, cfg, ver, toks)
    md = to_md(doc); open(os.path.join(ROOT, 'RESULTS-2026-11-v3.3.md'), 'w').write(md)
    import report_html
    report_html.write(doc, {}, os.path.join(ROOT, 'RESULTS-2026-11-v3.3.html'), f(len(r) + len(l), 0), title='Basket DCA Modelação v3.3',
                      eyebrow='TeraSwap · Analista → Arquitecto · RESULTS-2026-11-v3.3', h1='Basket DCA — v3.3: acções tokenizadas no Split DCA',
                      extra_meta='Coinbase · Base · fins-de-semana, feeds, splits', feeds_txt='13 feeds Coinbase (Base) + 9 feeds NYSE (Arbitrum)',
                      period_txt='Set 2023 – Nov 2026 · hora a hora e diário', date_txt='16 Nov 2026')
    return doc

def detail(doc, r, l, feeds, clr, cll, wm, bmax, sc, S, bias, cfg, ver, toks):
    doc.h2('1. Os dados', 'dados')
    seven = feeds[feeds.key.str.startswith('cb_')]
    rows = []
    for _, x in seven.iterrows():
        c = cfg[x.key]
        rows.append([x.symbol, x.category, f(x.rounds, 0), x['first'][:10], f(x.max_gap_h, 1), int(x.in_session_gaps_20_26h), pct(x.max_step_pct, 2),
                     '—' if x.dex_vs_feed_open_med != x.dex_vs_feed_open_med else f'{pct(x.dex_vs_feed_open_med,2)} / {pct(x.dex_vs_feed_open_p95,2)}',
                     '—' if x.dex_vs_feed_closed_p5 != x.dex_vs_feed_closed_p5 else f'{pct(x.dex_vs_feed_closed_p5,1)} / {pct(x.dex_vs_feed_closed_p95,1)}',
                     '—' if x.decided_by_feed_pct != x.decided_by_feed_pct else pct(x.decided_by_feed_pct, 0)])
    vok = int(ver.descriptionMatches.sum())
    doc.table(['Feed «Coinbase X» (Base)', 'Tier Chainlink', 'Rondas', 'Desde', 'Maior silêncio (h)', 'Silêncios de 20–26 h com o mercado aberto', 'Maior passo entre rondas',
               'DEX face ao feed, aberto: mediana / P95', 'DEX face ao feed parado, fechado: P5 / P95', 'Horas abertas em que o ADR-024 decide pelo feed'], rows,
              f'Todas as rondas on-chain até 16 Nov 2026 · 0,5% / 86 400 s, 24/5, retorno total · endereços do directório da Chainlink, iguais à página da Base; description() on-chain confere em {vok} de {len(ver)} feeds · '
              'DEX = preço horário do token no DefiLlama (para INTCc e CRCLc é escasso e não serve: 100 e 118 pontos)', num_cols=[2, 4, 5])
    doc.p(f'**Lista oficial:** {len(toks["tokens"])} tokens (`api.coinbase.com/v1/tokenized-stocks`, lida a {toks["read_at_utc"]} UTC). Só 13 têm feed Chainlink na Base; os 7 com liquidez (NVDAc, GOOGLc, AMZNc, AAPLc, METAc, TSLAc, MSFTc) estão entre eles. '
          f'**Feeds por acção na Arbitrum (NYSE, Chainlink, preço por acção):** desde Set 2023 (NVDA desde Abr 2024). Servem para a amostra longa e para o caso do split. Publicam alguns preços em dias fechados; o calendário de fechos vem por isso da NYSE (biblioteca `exchange_calendars`, guardado em `data/series/v33/xnys_sessions.csv`).')
    rows = [[x.closed_from[:16], x.weekday_from, f(x.hours, 0)] for _, x in clr.iterrows()]
    doc.table(['Fecho começa (UTC)', 'Dia', 'Horas'], rows, 'Janela real · fechado = os 13 feeds da Coinbase calados ao mesmo tempo (cada um num silêncio de mais de 26 h)', num_cols=[2])
    doc.h2('2. maxStaleness', 'staleness')
    rows = [[int(k), f(len(g), 0), f(24 * k, 0)] for k, g in cll.groupby('closed_days')]
    doc.table(['Dias seguidos sem sessão', 'Fechos (Set 2023 – Nov 2026)', 'Horas de fecho no mercado 24/5'], rows, 'Calendário da NYSE (XNYS) · 1 dia = feriado a meio da semana · 3 dias = fim-de-semana com feriado', num_cols=[0, 1, 2])
    rows = []
    for k, g in wm.groupby('closed_days'):
        q = g.move_pct; rows.append([int(k), f(len(q), 0), pct(q.quantile(.01), 1), pct(q.quantile(.05), 1), pct(q.median(), 2), pct(q.quantile(.95), 1), pct(q.quantile(.99), 1), pct(q.min(), 1), pct(q.max(), 1)])
    doc.table(['Dias fechados', 'Fechos × acções', 'P1', 'P5', 'Mediana', 'P95', 'P99', 'Mín.', 'Máx.'], rows,
              'Reabertura face ao último fecho, por acção, ajustado a splits · 7 acções · fecho às 16:00 ET, reabertura às 09:30 ET (inclui a sessão da noite; no 24/5 o salto é menor) · é o que um piso parado tem de absorver', num_cols=[1])
    doc.p('**Leitura.** Um maxStaleness de 100 h cobre todos os fechos normais, incluindo uma última ronda até 24 h antes do fecho. Quem passa disto é só um congelamento por evento corporativo, que o keeper trata pela pausa do registo. '
          'O preço de fecho como piso de 3% recusaria uma compra de fim-de-semana só se o DEX já estivesse mais de 3,09% acima do fecho. Na janela real isso não aconteceu nas 7 acções. Na MSTR, que segue o bitcoin, aconteceu em 1,9% das horas fechadas.')
    doc.h2('3. Ciclos com o mercado fechado', 'fimdesemana')
    rows = []
    for o in ('A', 'B', 'C90', 'C3d'):
        for c in (1, 3, 7):
            x = S.get((o, c))
            if not x: continue
            rows.append([OPTL[o] if c == 1 else '', CADL[c], f(x['n'], 0), f'{f(x["inc"],0)} ({pct(x["inc_pct"],1)})', '—' if not x['inc'] else f'{x["inc_chunks_max"]} · {pct(x["unb_max"],0)}',
                         f'{pct(x["mc_p95"],0)} / {pct(x["mc_max"],0)}', f(x['grace_mean'], 2),
                         '—' if o in ('A', 'B') else f'{pct(x["closed_cap"],1)} · {pct(x["closed_pos"],0)}',
                         '—' if o in ('A', 'B') else f'{f(x["gap_mean"],2)}% ({f(x["gap_pos_p5"],1)} / {f(x["gap_pos_p95"],1)}) · máx. {f(x["gap_max"],1)}%'])
    doc.table(['Opção', 'Cadência', 'Posições', 'Incompletas', 'Máx. chunks · % por comprar', 'Maior gasto num ciclo: P95 / máx.', 'Compras nos ciclos extra (média)',
               'Capital das acções comprado com o mercado fechado · posições com essas compras', 'Preço dessas compras face à reabertura: média (P5 / P95 por posição) · pior compra'], rows,
              'Janela real, 25 Ago – 15 Nov 2026, hora a hora: arranques em todos os dias às 00, 06, 12 e 18 UTC · 8 cestos (secção 6) × 4 divisões · Split DCA da spec (L = 2, Hamilton, k_soft = ⌈N ÷ 4⌉, regra 9 a 25%, suave), 1 000 USD · '
              'N da grelha da v3.2 que cabe em (N + 4) × cadência < 90 dias e na janela · piso on-chain de 3% (o valor por defeito da app) · compra recusada pelo piso = sem compra nesse ciclo', num_cols=[2])
    rows = [[x.cadence, int(x.calendar_max), int(x.b_max_worst), int(x.b_max_median)] for _, x in bmax.iterrows()]
    doc.table(['Cadência', 'N máximo hoje (calendário)', 'N máximo com a opção B, pior arranque', 'Mediana dos arranques'], rows,
              'Opção B: a ordem conta só dias de mercado e tem de acabar (com os 3 ciclos extra) antes de 90 dias · todos os arranques possíveis do calendário XNYS, Set 2023 – Nov 2026', num_cols=[1, 2, 3])
    ll = l[(l.variant == 'adj') & (l['mode'] == 'soft')]; rows = []
    for (b, o, c), q in ll.groupby(['basket', 'option', 'cadence_d']):
        p = q[q.pending_chunks > 0]
        rows.append([b, o, CADL[c], f(len(q), 0), f'{f(len(p),0)} ({pct(100*len(p)/len(q),1)})', f'{pct(q.max_cycle_pct.quantile(.95),0)} / {pct(q.max_cycle_pct.max(),0)}'])
    doc.table(['Cesto', 'Opção', 'Cadência', 'Posições', 'Incompletas', 'Maior gasto num ciclo: P95 / máx.'], rows,
              'Amostra longa, Set 2023 – Nov 2026, um tick por dia às 12:00 UTC, arranque dia sim dia não · acções = feed por acção da Arbitrum ajustado a splits (sem sessão da noite nem dividendos: aproximação) · só as opções A e B: sem preço DEX das acções antes de Ago 2026', num_cols=[3])
    doc.p('**Leitura.** A opção A deixa a perna da acção sem compra sempre que o ciclo cai num fecho. Na diária recupera, mas concentra (até 73% num ciclo com três acções). Na semanal, um arranque ao sábado ou domingo nunca compra a acção. '
          'A B e a C completam sempre. A C não mexe no calendário nem no N máximo, e compra ao fim-de-semana a preços que ficaram, em média, a menos de 0,3% da reabertura. A B é mais conservadora, mas encurta as ordens e atrasa as pernas cripto.')
    doc.h2('4. A regra 4 com o preço parado', 'regra4')
    rows = [[OPTL[o], pct(v, 1)] for o, v in bias.items() if o in ('C3d', 'Cfz')]
    doc.table(['Decisão nos ciclos fechados', 'Primeira compra do ciclo que foi para a acção'], rows, 'Cestos 2 cripto + 1 acção, janela real, ciclos com o mercado fechado e alguma compra · 1/3 seria uma escolha ao acaso')
    doc.h2('5. Splits e eventos corporativos', 'splits')
    rows = [[{'soft': 'suave', 'rigid': 'rígido'}[x['mode']], f(x.n, 0), f'{pct(x.r9_adj,0)} → {pct(x.r9_raw,0)}', f'{f(x.prot_adj,1)} → {f(x.prot_raw,1)}', f'{int(x.inc_adj)} → {int(x.inc_raw)}', pct(x.unb_raw_max, 0), f'{pct(x.mc_adj_max,0)} → {pct(x.mc_raw_max,0)}'] for _, x in sc.iterrows()]
    doc.table(['Modo', 'Posições que atravessam o split', 'Regra 9 disparou: ajustado → por acção', 'Ciclos com a NVDA protegida (média)', 'Incompletas', 'Máx. por comprar (por acção)', 'Maior gasto num ciclo'], rows,
              'ETH + BTC + NVDA, opção A, cadências diária e de 3 dias, amostra longa · NVDA 10:1 a 10 Jun 2024, lido no próprio feed da Arbitrum (−90% numa ronda) · «ajustado» = dividido por 10 antes do split, como faz um feed de retorno total', num_cols=[1])
    doc.p('**Leitura.** Com um preço por acção, um split parece uma queda de 90%. A protecção pausa a perna até ao fim (no suave, compra tudo na janela final; no rígido, fica por comprar). '
          'Os feeds da Coinbase não têm este problema, porque o multiplicador compensa o preço. O risco está num keeper ou numa fonte de quórum que use o preço por acção.')
    doc.h2('6. Combinações de pernas', 'combinacoes')
    rows = []
    for k in ('2 cripto + 1 acção', '1 cripto + 2 acções', '3 acções', 'cripto + acção + stable', '2 acções + stable'):
        for o in ('A', 'B', 'C3d'):
            x = S.get((o, k))
            if not x: continue
            rows.append([k if o == 'A' else '', OPTL[o], f(x['n'], 0), f'{f(x["inc"],0)} ({pct(x["inc_pct"],1)})', f'{pct(x["mc_p95"],0)} / {pct(x["mc_max"],0)}',
                         '—' if o != 'C3d' else f'{pct(x["closed_cap"],1)} · {pct(x["closed_pos"],0)}'])
    doc.table(['Combinação', 'Opção', 'Posições', 'Incompletas', 'Maior gasto num ciclo: P95 / máx.', 'Capital das acções comprado fechado · posições'], rows,
              'Janela real · cestos: ETH + cbBTC + NVDAc / AAPLc / TSLAc; ETH + NVDAc + MSFTc; NVDAc + AAPLc + MSFTc; AMZNc + GOOGLc + METAc; ETH + NVDAc + USDT; NVDAc + AAPLc + USDT', num_cols=[2])
    doc.h2('Testes', 'testes')
    doc.ul(['`test_closures_are_weekends_and_one_holiday`: os fechos da janela real começam à sexta ou ao sábado, duram 40–80 h e só um passa de 60 h (Labor Day).',
            '`test_option_A_never_buys_a_stock_leg_while_the_market_is_closed`.',
            '`test_option_B_ticks_only_on_open_hours`.',
            '`test_the_floor_is_respected_whenever_the_feed_is_fresh`: nas opções C, nenhuma compra de acção acima de feed ÷ (1 − 3%) enquanto o feed está dentro do maxStaleness.',
            '`test_total_return_feeds_have_no_split_jump_and_the_raw_feed_shows_the_nvda_split`.',
            'Os 23 testes da v2 a v3.2 continuam a passar.'])
    doc.h2('O que não foi medido, e porquê', 'naomedido')
    doc.ul(['**O registo de oráculos da Coinbase** (pausa por evento corporativo): a documentação diz que existe e que o feed o lê, mas não dá o endereço nem a ABI. Não houve nenhuma pausa na janela. O keeper tem de o ler on-chain.',
            '**A profundidade do DEX ao fim-de-semana para chunks grandes:** usei o preço horário do DefiLlama, sem impacto de preço. Nas posições modeladas (1 000 USD), um chunk de acção vai de dezenas a poucas centenas de USD, face a 0,5–2,5 M USD de liquidez por token.',
            '**Só um feriado na janela real** (Labor Day) e nenhum split: a amostra longa cobre 21 fins-de-semana com feriado e o split da NVDA, mas com preços por acção e sem a sessão da noite.',
            '**Dividendos:** entram no multiplicador e no feed de retorno total; não os simulei à parte.',
            '**Pernas cripto pelo DefiLlama horário** (não pelo Chainlink) nesta versão: a pergunta é sobre a perna da acção, e as cripto ficam iguais em todas as opções.',
            '**O mínimo assinado** (`scaledMin`) quando o piso do oráculo cai: depende do preço na criação da ordem e não foi modelado.',
            '**Os feeds da Arbitrum** publicam alguns preços em dias fechados; não os usei para o calendário.'])
    doc.h2('O que isto muda na spec (proposta)', 'spec')
    doc.ol(['**Registar os feeds «Coinbase X» das 7 acções com liquidez** com maxStaleness de 360 000 s (100 h), executando o registo num dia de mercado. São do tier «custom» (a GOOGL é «low»): decisão do dono.',
            '**Split DCA com acções: opção C.** Ao fim-de-semana e nos feriados, a perna da acção compra ao preço on-chain; o keeper decide pelo ADR-024, sem regra nova.',
            '**Keeper:** pausa do registo da Coinbase ligada → perna «sem preço»; nunca usar preços por acção.',
            '**Todas as combinações de pernas**, com no máximo uma stable.',
            '**Texto:** além do aviso do dono quando se escolhe uma acção, o Split DCA diz que a acção pode ser comprada com o mercado americano fechado, ao preço on-chain, e que o preço de referência é o último fecho.',
            '**Se o dono preferir não comprar acções fora do horário dos EUA:** opção B, com o N máximo mais curto da secção 3.'])
