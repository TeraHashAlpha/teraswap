"""v3.3 · Coinbase tokenized stocks as Split DCA legs, on real data (Base feeds Aug–Nov 2026, Arbitrum NYSE feeds).
These tests fail if the market calendar, the weekend options or the on-chain floor model stop meaning what the
report says they mean."""
import sys, os, numpy as np, pandas as pd
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))
import experiments_v33 as X, experiments_v32 as E
from scenarios import SPLITS
from engine_discrete import run_discrete

def _segments(cl):
    out, i = [], 0
    while i < len(cl):
        if cl[i]:
            j = i
            while j + 1 < len(cl) and cl[j + 1]: j += 1
            out.append((i, j)); i = j + 1
        else: i += 1
    return out

def test_closures_are_weekends_and_one_holiday():
    cl = X.closure_calendar(X.H); seg = _segments(cl)
    assert len(seg) >= 12
    for i, j in seg:
        assert X.H[i].day_name() in ('Friday', 'Saturday') and 40 <= j - i + 1 <= 80, (X.H[i], j - i + 1)
    assert sum(1 for i, j in seg if j - i + 1 > 60) == 1                               # Labor Day, 7 Sep 2026

def _positions(opt, legs=('ETH', 'BTC', 'NVDAc'), cads=(1, 7), Ns=(6, 12)):
    cl = X.closure_calendar(X.H)
    for c in cads:
        for N in Ns:
            for day in pd.date_range('2026-09-01', '2026-10-20', freq='3D'):
                for hour in (0, 12):
                    i0 = int(np.searchsorted(X.H, day + pd.Timedelta(hours=hour)))
                    if opt == 'B':
                        if cl[i0]: continue
                        seq = X.ticks_market(i0, c, N + X.G, cl)
                        if len(seq) < N + X.G or seq[-1] >= len(X.H): continue
                        idx = [seq[0] - 24 * c] + seq
                    else:
                        idx = [i0 - 24 * c] + X.ticks_calendar(i0, c, N + X.G)
                    if idx[-1] >= len(X.H): continue
                    m = X.build(legs, idx, opt, cl)
                    if m is not None: yield c, N, np.asarray(idx), m, cl

def test_option_A_never_buys_a_stock_leg_while_the_market_is_closed():
    seen = 0
    for c, N, idx, m, cl in _positions('A'):
        r = run_discrete(m['Pe'], SPLITS['25-25-50'], L=2, Pd=m['Pd'], pd0=m['pd0'], rPe=m['rPe'], rPd=m['rPd'], dd=0.25, mode='soft', k_soft=E.k_rec)
        assert not [t for t, i, x, k in r.fills if i == 2 and cl[idx[1:]][t]]
        seen += 1
    assert seen > 50

def test_option_B_ticks_only_on_open_hours():
    seen = 0
    for c, N, idx, m, cl in _positions('B'):
        assert not cl[idx[1:]].any()
        seen += 1
    assert seen > 50

def test_the_floor_is_respected_whenever_the_feed_is_fresh():
    for opt in ('C90', 'C3d'):
        for c, N, idx, m, cl in _positions(opt):
            r = run_discrete(m['Pe'], SPLITS['25-25-50'], L=2, Pd=m['Pd'], pd0=m['pd0'], rPe=m['rPe'], rPd=m['rPd'], dd=0.25, mode='soft', k_soft=E.k_rec)
            a = X.leg_arrays('NVDAc'); ti = idx[1:]
            for t, i, x, k in r.fills:
                if i == 2 and a['age'][ti[t]] <= X.MAXS[opt]:
                    assert a['exec'][ti[t]] <= a['feed'][ti[t]] / (1 - X.SLIP) + 1e-9

def test_total_return_feeds_have_no_split_jump_and_the_raw_feed_shows_the_nvda_split():
    f = pd.read_csv(os.path.join(X.R33, 'feeds.csv'))
    assert (f[f.key.str.startswith('cb_')].max_step_pct < 10).all()
    _, _, splits, _ = X.arb_series('NVDA')
    assert [(pd.Timestamp(ts, unit='s').strftime('%Y-%m'), m) for ts, m in splits] == [('2024-06', 10)]
