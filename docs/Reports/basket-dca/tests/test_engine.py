"""Engine tests on REAL windows only (Chainlink series in data/series). No synthetic prices."""
import sys, os, numpy as np, pandas as pd
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))
import experiments as ex
from scenarios import SPLITS, ticks, run_position

WS = ex.stress_windows()

def _run(win, split='33-33-33', cad=1, **kw):
    a, b, _ = WS[win]
    return run_position(('ETH', 'BTC', 'USDC'), SPLITS[split], ticks(a, cad, end=b), cad, **kw)

def test_corrected_rule3_exact_split_every_stress_window():
    for w in WS:
        for sp in SPLITS:
            for cad in (1, 7):
                out, _ = _run(w, sp, cad)
                assert out['A'].deviation_pp < 1e-9, (w, sp, cad)
                assert abs(out['A'].spent.sum() + out['A'].cash_left - 1000) < 1e-6

def test_original_rule3_reproduces_the_july_defect():
    devs = [_run(w, sp, cad)[0]['A0'].deviation_pp for w in WS for sp in SPLITS for cad in (1, 7)]
    assert max(devs) > 5 and np.mean([d > 0.01 for d in devs]) > 0.25

def test_soft_mode_exact_rigid_mode_leaves_cash_in_terra():
    soft, _ = _run('S1', dd_threshold=0.20, dd_mode='soft', strategies=('A',))
    rigid, _ = _run('S1', dd_threshold=0.20, dd_mode='rigid', strategies=('A',))
    assert soft['A'].deviation_pp < 1e-9
    assert rigid['A'].cash_left > 100   # S1: ETH and WBTC end far below entry

def test_cooldown_blocks_back_to_back_primary_wins_unless_sole_eligible():
    out, _ = _run('S5', cad=1)
    r = out['A']
    sel = {t: i for t, i, u, k in r.fills if k == 'select'}
    for t in sorted(sel):
        if t - 1 in sel and sel[t] == sel[t - 1]:
            unlocked_others = [j for j in range(3) if j != sel[t] and (r.lock_tick[j] is None or r.lock_tick[j] >= t)]
            assert not unlocked_others, f'leg {sel[t]} won ticks {t-1} and {t} with other legs still open'

def test_stable_band_stops_buying_ust():
    stable, a, b, _ = ex.DEPEG_EVENTS['UST-2022']
    s0 = pd.Timestamp(a) - pd.Timedelta(days=30); e0 = pd.Timestamp(b) + pd.Timedelta(days=30)
    out, meta = run_position(('ETH', 'BTC', 'UST'), SPLITS['33-33-33'], ticks(s0, 1, end=e0), 1,
                             strategies=('A',), stable_idx=2, stable_band=0.01, stable_final='rigid')
    P = meta['P']
    bought_out_of_band = [u for t, i, u, k in out['A'].fills if i == 2 and abs(P[t, 2] - 1) > 0.01]
    assert not bought_out_of_band

def test_fixed_dca_and_single_leg_baselines():
    out, _ = _run('S2')
    assert out['B'].deviation_pp < 1e-9 and abs(out['C'].spent[0] - 1000) < 1e-9

def test_hourly_episodes_keep_the_split():
    import hourly_events as he
    d = he.run_episodes()
    A = d[d.strategy.isin(['A', 'A · regra 9 25% suave'])]
    assert len(d[d.strategy == 'A']) >= 2000
    assert A.deviation_pp.max() < 1e-9
