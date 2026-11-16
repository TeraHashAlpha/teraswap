"""v3 engine tests (A+ switches P, M, E, B and the last-cycle retry), on REAL windows only.
Each switch has at least one test that fails if the guarantee (the split, deviation 0) breaks."""
import sys, os, itertools, numpy as np, pandas as pd
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))
import experiments as ex, experiments_v3 as e3, experiments_v3x as X
from scenarios import SPLITS, ticks, run_position
from engine import run_basket
from engine_plus import run_plus

WS = ex.stress_windows()

def _m(legs, win, cad=1):
    a, b, _ = WS[win]; return X.mats(legs, ticks(a, cad, end=b), cad)

def test_switches_off_reproduce_v2_exactly():
    """A+ with every switch off must be the v2 Basket (rules 1-9, rule 3 corrected), fill by fill."""
    n = 0
    for w, sp, cad in itertools.product(WS, SPLITS, (1, 7)):
        m = _m(('ETH', 'BTC', 'USDC'), w, cad)
        for kw2, kwp in ((dict(), dict()), (dict(dd_threshold=0.25, dd_mode='soft'), dict(dd=0.25, mode='soft'))):
            r2 = run_basket(m['Pe'], m['p0'], SPLITS[sp], 1000.0, True, **kw2)
            rp = run_plus(m['Pe'], SPLITS[sp], p0=m['p0'], **kwp)
            assert np.allclose(r2.spent, rp.spent) and np.allclose(r2.qty, rp.qty), (w, sp, cad, kwp)
            assert sorted((t, i, round(u, 9)) for t, i, u, k in r2.fills) == sorted((t, i, round(u, 9)) for t, i, u, k in rp.fills)
            n += 1
    assert n == 112

def test_P_keeps_the_split_and_changes_only_decisions():
    """P: decisions with the ADR-024 price. The split must stay exact; fills still execute at the feed."""
    changed = 0
    for legs in (('ETH', 'BTC', 'USDC'), ('ETH', 'BTC', 'COMP')):
        for w, sp, cad in itertools.product(WS, SPLITS, (1, 7)):
            m = _m(legs, w, cad)
            if m is None: continue
            a = run_plus(m['Pe'], SPLITS[sp], p0=m['p0'])
            p = run_plus(m['Pe'], SPLITS[sp], Pd=m['Pd'], pd0=m['pd0'], final_retry=True, retry_Pe=m['rPe'], retry_Pd=m['rPd'])
            assert p.deviation_pp < 1e-9, (legs, w, sp, cad)
            for t, i, u, k in p.fills: assert np.isfinite(m['Pe'][t, i])
            changed += sum(1 for t in range(len(m['dates']) - 1) if a.primary.get(t) != p.primary.get(t))
    assert changed > 0     # the switch is live on real data

def test_P_leg_without_price_is_not_bought_and_last_cycle_waits():
    """A leg with no usable price is out of that cycle. Owner's rule (7 Nov 2026): the last cycle waits up to
    3 more cycles for a price; if one comes it buys there (split exact), if none comes the order closes with
    that leg unbought, the money stays with the user and the reason is reported. Without any retry the
    guarantee breaks — the test requires that it does."""
    m = _m(('ETH', 'BTC', 'USDC'), 'S5', 1); w = SPLITS['33-33-33']
    Pd = m['Pd'].copy(); Pd[:, 2] = np.nan                                   # USDC never priced during the position
    r = run_plus(m['Pe'], w, Pd=Pd, pd0=m['pd0'])
    assert all(i != 2 for t, i, u, k in r.fills) and r.deviation_pp > 30
    rPd = m['rPd'].copy(); rPd[0, 2] = np.nan; rPe = m['rPe']                # price comes back on the 2nd retry cycle
    r2 = run_plus(m['Pe'], w, Pd=Pd, pd0=m['pd0'], final_retry=True, retry_Pe=rPe, retry_Pd=rPd)
    assert r2.deviation_pp < 1e-9 and r2.retry_waited == {2: 2} and r2.unbought_usd == 0
    assert any(k == 'final-retry' and i == 2 for t, i, u, k in r2.fills)
    rPd3 = m['rPd'].copy(); rPd3[:, 2] = np.nan                              # no price in the 3 cycles after the end
    r3 = run_plus(m['Pe'], w, Pd=Pd, pd0=m['pd0'], final_retry=True, retry_Pe=rPe, retry_Pd=rPd3)
    assert set(r3.unbought) == {2} and abs(r3.unbought_usd - w[2] * 1000) < 1e-6
    assert abs(r3.cash_left - r3.unbought_usd) < 1e-6 and r3.spent[2] == 0       # nothing hidden: it is the user's cash

def test_M_min_fill_respected_and_split_exact():
    """M: no fill below the minimum except on the last cycle (>= 0.01 USD); deviation bounded by 0.01 USD per leg."""
    for C, (route, mf) in itertools.product((100, 250, 1000), e3.MINFILL.items()):
        for w, sp, cad in itertools.product(WS, SPLITS, (1, 7)):
            m = _m(('ETH', 'BTC', 'USDC'), w, cad); N = len(m['dates'])
            for sel in (True, False):
                r = run_plus(m['Pe'], SPLITS[sp], C, p0=m['p0'], min_fill=mf, select=sel)
                assert all(u >= mf - 1e-9 for t, i, u, k in r.fills if t < N - 1), (C, route, w, sp, cad, sel)
                assert np.max(np.abs(r.spent - r.weights * C)) <= 0.01 + 1e-9, (C, route, w, sp, cad, sel)

def test_E_staged_catchup_bounds_the_largest_fill_without_breaking_the_split():
    """E: with k = 10 and no cap, S1-S7 in the three-volatile basket stay at deviation 0 and, from 8 cycles up,
    no single purchase exceeds 20% of capital; a cap that bites leaves cash, which must be reported."""
    for legs in (('ETH', 'BTC', 'COMP'), ('ETH', 'BTC', 'USDC')):
        for w, sp, cad in itertools.product(WS, SPLITS, (1, 7)):
            m = _m(legs, w, cad)
            if m is None: continue
            r = run_plus(m['Pe'], SPLITS[sp], p0=m['p0'], dd=0.25, mode='soft', k=10)
            assert r.deviation_pp < 1e-9, (legs, w, sp, cad)
            if len(m['dates']) >= 8: assert r.max_fill_pct <= 20 + 1e-9, (legs, w, sp, cad, r.max_fill_pct)
    m = _m(('ETH', 'BTC', 'USDC'), 'S1', 1)
    r = run_plus(m['Pe'], SPLITS['33-33-33'], p0=m['p0'], dd=0.20, mode='soft', k=1, cap=0.10)
    assert r.max_fill_pct <= 10 + 1e-9 and r.cash_left > 0 and abs(r.spent.sum() + r.cash_left - 1000) < 1e-6

def test_B_band_never_buys_a_depegged_stable_also_on_the_last_cycle():
    """B: USDC in SVB (hourly, episode E4) and UST in May 2022 — no purchase of the stable while |p-1| > band,
    including the last cycle and in soft mode; whatever the band holds back stays as cash (never silently re-routed)."""
    seen = 0
    for meta, m in X.set_210x(('ETH', 'BTC', 'USDC')):
        if meta['episode'] not in ('E2', 'E4'): continue
        for band in (0.01, 0.05):
            r = run_plus(m['Pe'], SPLITS[meta['split']], Pd=m['Pd'], pd0=m['pd0'], dd=0.25, mode='soft', k=10,
                         stable_idx=2, band=band, final_retry=True, retry_Pe=m['rPe'], retry_Pd=m['rPd'])
            first_retry = next((q for q in m['rPd'][:, 2] if q == q), np.nan)
            seen_px = np.where(np.isfinite(m['Pd'][:, 2]), m['Pd'][:, 2], first_retry)      # retried last cycle: the price it waited for
            bad = [u for t, i, u, k in r.fills if i == 2 and abs(seen_px[t] - 1) > band]
            assert not bad, (meta, band)
            assert r.spent[2] <= r.weights[2] * r.capital + 1e-9          # the lock (rule 6) caps the stable at its weight
            assert abs(r.spent.sum() + r.cash_left - r.capital) < 1e-6
            seen += 1
    assert seen > 500

def test_three_volatile_basket_keeps_the_split_with_every_switch_on():
    """T8 guarantee: ETH + cbBTC + X with P + M + E (k=10) + rule 9 at 25% (soft) and the last-cycle retry."""
    for legs in (('ETH', 'BTC', 'VIRTUAL'), ('ETH', 'BTC', 'COMP'), ('ETH', 'BTC', 'AERO')):
        for meta, m in X.daily_positions(legs, [e3.set_21()]):
            for sel in (True, False):
                r = run_plus(m['Pe'], SPLITS[meta['split']], Pd=m['Pd'], pd0=m['pd0'], dd=0.25, mode='soft', k=10, min_fill=16.0,
                             final_retry=True, retry_Pe=m['rPe'], retry_Pd=m['rPd'], select=sel)
                gap = np.abs(r.spent - r.weights * 1000)
                assert np.max(gap) <= 0.01 + 1e-9 or abs(r.unbought_usd - gap.sum()) < 0.02, (legs, meta, sel)   # only a reported, unbought leg
