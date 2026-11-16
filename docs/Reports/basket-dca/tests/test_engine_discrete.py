"""v3.1 · «A+ discreto» (one DCA order per leg, fixed chunk), on REAL windows only.
The split of what is bought is exact by construction: every fill is exactly one chunk of its leg, a leg never sells more
than w_i·C, and when every chunk executes the deviation is 0. These tests fail if any of that breaks."""
import sys, os, itertools, numpy as np
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))
import experiments as ex, experiments_v3 as e3, experiments_v3x as X
from scenarios import SPLITS, ticks
from engine_discrete import run_discrete, choose_n

def _all_21(legs):
    for meta, m in X.daily_positions(legs, [e3.set_21()]): yield meta, m

def test_discrete_split_is_exact_by_construction():
    seen = complete = 0
    for legs in (('ETH', 'BTC', 'COMP'), ('ETH', 'BTC', 'VIRTUAL'), ('ETH', 'BTC', 'AERO'), ('ETH', 'BTC', 'USDC')):
        sb = dict(stable_idx=2, band=0.01) if legs[2] == 'USDC' else {}
        for meta, m in _all_21(legs):
            w = np.asarray(SPLITS[meta['split']]); N = len(m['dates'])
            for mode, L in itertools.product(('soft', 'rigid'), (1, 2)):
                r = run_discrete(m['Pe'], w, L=L, Pd=m['Pd'], pd0=m['pd0'], rPe=m['rPe'], rPd=m['rPd'], dd=0.25, mode=mode, **sb)
                for i in range(3):
                    assert abs(r.spent[i] - r.done[i] * r.chunk[i]) < 1e-6, (legs, meta, mode, L, i)      # whole chunks only
                    assert r.spent[i] <= w[i] * 1000 + 1e-6                                              # never above the signed amount
                for t, i, x, k in r.fills:
                    assert abs(x - r.chunk[i]) < 1e-6 and t < N + 3                                      # fixed chunk; nothing after expiry
                per = {}
                for t, i, x, k in r.fills: per[(t, i)] = per.get((t, i), 0) + 1
                assert max(per.values(), default=0) <= L                                                 # at most L chunks per leg per cycle
                assert abs(r.spent.sum() + r.unbought_usd - 1000) < 1e-6                                 # the rest never left the wallet
                if r.pending_chunks == 0:
                    assert r.deviation_pp < 1e-9; complete += 1
                seen += 1
    assert seen == 4 * (112 + 112 + 32 + 48) and complete > 0           # 4 mode × L combinations over the S1–S7 positions of the 4 baskets

def test_chunks_respect_min_fill_and_hamilton_sum():
    for N, C, sp in itertools.product((5, 7, 13, 30, 60, 90), (250, 1000), SPLITS):
        w = np.asarray(SPLITS[sp]); n = choose_n(w, C, N, 16.0)
        assert (n >= 1).all() and (w * C / n >= 16.0 - 1e-9).all()
        if (w * C / np.maximum(np.round(w * N), 1) >= 16.0).all():
            assert n.sum() == N, (N, C, sp, n)

def test_band_blocks_the_stable_leg_in_the_discrete_basket():
    seen = 0
    for meta, m in X.set_210x(('ETH', 'BTC', 'USDC')):
        if meta['episode'] not in ('E2', 'E4'): continue
        r = run_discrete(m['Pe'], SPLITS[meta['split']], L=2, Pd=m['Pd'], pd0=m['pd0'], rPe=m['rPe'], rPd=m['rPd'],
                         dd=0.25, mode='soft', stable_idx=2, band=0.01)
        PdA = np.vstack([m['Pd'], m['rPd']])
        assert not [x for t, i, x, k in r.fills if i == 2 and abs(PdA[t, 2] - 1) > 0.01], meta
        seen += 1
    assert seen > 500
