"""v3.2 · the soft-mode window as a function of N, the new metrics, and the Architect's band rule on the stable leg.
Real windows only (S1–S7 at the product cadences). These tests fail if the v3.1 behaviour moves, if the chosen
formula stops protecting short orders, or if it can leave chunks unbought because of rule 9 alone."""
import sys, os, math, itertools, numpy as np, pandas as pd
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))
import experiments_v32 as E, experiments_v3 as e3, experiments_v3x as X
from scenarios import SPLITS
from engine_discrete import run_discrete, choose_n

def _positions(bname, combos=None, fams=('S1–S7',)):
    legs = E.BASKETS[bname]
    for c, N in (combos or E.COMBOS):
        for fam in fams:
            for meta, s0 in E.starts(fam, c, N):
                m = E.build(legs, E.GIX[s0], c, N)
                if m is not None: yield c, N, s0, m

def test_int_and_function_k_are_the_same_engine():
    """k_soft = 10 (v3.1) and k_soft = (lambda N, n: 10) give identical runs; v3.1 defaults are untouched."""
    seen = 0
    for meta, m in X.daily_positions(('ETH', 'BTC', 'COMP'), [e3.set_21()]):
        w = np.asarray(SPLITS[meta['split']])
        a = run_discrete(m['Pe'], w, L=2, Pd=m['Pd'], pd0=m['pd0'], rPe=m['rPe'], rPd=m['rPd'], dd=0.25, mode='soft')
        b = run_discrete(m['Pe'], w, L=2, Pd=m['Pd'], pd0=m['pd0'], rPe=m['rPe'], rPd=m['rPd'], dd=0.25, mode='soft', k_soft=lambda N, n: 10)
        assert a.fills == b.fills and a.k_soft == b.k_soft == 10
        seen += 1
    assert seen == 112

def test_v31_results_are_reproduced():
    """The stored v3.1 runs (A+ discreto, S1–S7) come out identical from the v3.2 engine."""
    d = pd.read_csv(os.path.join(E.ROOT, 'results', 'v31', 'discreto_ETH+cbBTC+COMP.csv.gz'), dtype={'set': str, 'window': str, 'duration': str, 'split': str}, low_memory=False)
    d = d[(d.strategy == 'A+ discreto') & (d.set == '2.1')]
    got = {}
    for meta, m in X.daily_positions(('ETH', 'BTC', 'COMP'), [e3.set_21()]):
        w = np.asarray(SPLITS[meta['split']])
        for mode, L in itertools.product(('soft', 'rigid'), (1, 2)):
            r = run_discrete(m['Pe'], w, n=None, min_fill=16.0, L=L, Pd=m['Pd'], pd0=m['pd0'], rPe=m['rPe'], rPd=m['rPd'], dd=0.25, mode=mode, k_soft=10)
            got[(meta['window'], meta['duration'], meta['cadence_d'], meta['split'], 'suave' if mode == 'soft' else 'rígido', L)] = (r.value_end, r.pending_chunks)
    n = 0
    for _, row in d.iterrows():
        v, p = got[(row.window, row.duration, int(row.cadence_d), row.split, row['mode'], int(row.L))]
        assert abs(v - row.val) < 1e-6 and p == row.pending_chunks; n += 1
    assert n == 112 * 4

def test_chosen_k_always_leaves_rule9_room_and_fits_every_chunk():
    """Arithmetic: for every product N and split at 1 000 USD, the chosen k is < N (rule 9 can block at least one
    nominal cycle) and L·(k + 3) >= the largest n_i (a leg protected until the window still buys all its chunks)."""
    for (c, N), sp in itertools.product(E.COMBOS, SPLITS):
        n = choose_n(np.asarray(SPLITS[sp]), E.C, N, E.MINFILL); k = E.k_rec(N, n)
        assert 1 <= k < N, (N, k)
        assert E.L * (k + E.G) >= n.max(), (N, sp, k, n)

def test_chosen_k_protects_short_orders_on_real_windows():
    """With k = 10, rule 9 never blocks when N <= 10; with the chosen k it does, in S1–S7 weekly positions."""
    blocked10 = blocked = 0
    for c, N, s0, m in _positions('ETH+cbBTC+COMP', combos=[(7, N) for N in (6, 7, 8, 9)]):
        for sp in SPLITS:
            w = np.asarray(SPLITS[sp]); kw = dict(L=2, Pd=m['Pd'], pd0=m['pd0'], rPe=m['rPe'], rPd=m['rPd'], dd=0.25, mode='soft')
            blocked10 += run_discrete(m['Pe'], w, k_soft=10, **kw).r9_block_cycles
            blocked += run_discrete(m['Pe'], w, k_soft=E.k_rec, **kw).r9_block_cycles
    assert blocked10 == 0 and blocked > 0

def test_chosen_k_never_leaves_chunks_for_rule9_alone():
    """Soft mode with the chosen k: a position only ends with chunks unbought if it also does without rule 9 (no price,
    band) — never because of the protection. All baskets, S1–S7, every product N and cadence."""
    seen = 0
    for b in E.BASKETS:
        for c, N, s0, m in _positions(b):
            sb = dict(stable_idx=2, band=E.BAND, band_add=m['badd']) if b in E.STABLE_B else {}
            for sp in SPLITS:
                w = np.asarray(SPLITS[sp]); kw = dict(L=2, Pd=m['Pd'], pd0=m['pd0'], rPe=m['rPe'], rPd=m['rPd'], mode='soft', **sb)
                r = run_discrete(m['Pe'], w, dd=0.25, k_soft=E.k_rec, **kw)
                if r.pending_chunks:
                    assert run_discrete(m['Pe'], w, dd=None, **kw).pending_chunks > 0, (b, c, N, s0, sp)
                seen += 1
    assert seen > 20000

def test_protected_fill_metrics_and_band_rule():
    """n_prot_fills counts the chunks bought while the leg was protected; the stable leg never buys when
    |p − 1| + the feed's threshold > band (the Architect's rule, threshold added only when the feed decides)."""
    for c, N, s0, m in _positions('ETH+cbBTC+USDT'):
        PdA = np.vstack([m['Pd'], m['rPd']])
        r = run_discrete(m['Pe'], SPLITS['25-25-50'], L=2, Pd=m['Pd'], pd0=m['pd0'], rPe=m['rPe'], rPd=m['rPd'], dd=0.25, mode='soft',
                         k_soft=E.k_rec, stable_idx=2, band=0.01, band_add=m['badd'])
        assert not [t for t, i, x, k in r.fills if i == 2 and abs(PdA[t, 2] - 1) + m['badd'][t] > 0.01]
        assert r.n_prot_fills == len(r.prot_fills) and abs(r.prot_spent_pct - 100 * sum(f[2] for f in r.prot_fills) / 1000) < 1e-9
        assert all(f[3] <= -0.25 + 1e-12 for f in r.prot_fills)
