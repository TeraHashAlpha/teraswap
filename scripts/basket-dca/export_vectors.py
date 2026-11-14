#!/usr/bin/env python3
"""Export the Basket DCA selection test vectors from the analyst's reference engine.

What: JSON fixtures for contracts/order-engine/executor/basket-scheduler.js (SPEC-BASKET-DCA §4 and §4a, ADR-027).
A run vector holds the inputs (weights as integer fractions, capital C in USD, cycles N, minFill, mode, threshold,
stable leg, band, band_add per tick, decision prices per tick with null = no price, N nominal ticks + 3 grace ticks)
and what the engine did with them (n per leg, every fill as [tick, leg, kind], the idle reason of every tick without a
fill, done per leg, k_soft).

How: `engine_discrete.run_discrete` of the analyst package (v3.2) with L = 2, rule = 'hamilton',
k_soft = lambda N: max(1, ceil(N / 4)), pd0 = [nan, nan, nan] (tick 0 has no previous price) and Pe = the decision
prices (Pe only values the fills; no decision reads it). The engine file is read from the package, hashed, and executed
from exactly the bytes that were hashed. It is never edited and never copied into this repo; a sha256 other than
ENGINE_SHA256 stops the script.

Prices are written in this file, built from fixed seeds with random.Random.random() (a sequence Python keeps stable
across versions) and plain arithmetic only (no libm call), so the fixtures are byte-reproducible. No market data.
Every family asserts what it claims to cover (soft vectors complete, a band vector is out of band where it says, ...)
and the script stops when a claim does not hold.

Run it with Python 3 and numpy only, from a venv OUTSIDE the repo:
    python3 -m venv ~/venvs/basket-dca && ~/venvs/basket-dca/bin/pip install numpy
    ~/venvs/basket-dca/bin/python -I scripts/basket-dca/export_vectors.py           # (re)write the fixtures
    ~/venvs/basket-dca/bin/python -I scripts/basket-dca/export_vectors.py --check   # regenerate in memory, compare
Options: --engine-dir DIR (default: $BASKET_ENGINE_DIR, else DEFAULT_ENGINE_DIR below, the analyst package's src/).
"""
import argparse
import collections
import hashlib
import itertools
import json
import math
import os
import platform
import random
import sys
import types
from pathlib import Path

import numpy as np

ENGINE_SHA256 = '282581bab72abf16b19096ab0f1be15e50fe0f2b5cdd3a3a7e165d9f2f281685'
DEFAULT_ENGINE_DIR = '~/Desktop/Claude/dex-aggregator 2/Analista/basket-dca-v2/docs-Reports-basket-dca/src'
REPO = Path(__file__).resolve().parents[2]
OUT_DIR = REPO / 'contracts' / 'order-engine' / 'executor' / 'fixtures' / 'basket-dca'
GENERATOR = 'scripts/basket-dca/export_vectors.py'

L = 2                                         # chunks per leg per tick: dcaInterval = T / 2
GRACE = 3                                     # grace ticks after the N nominal ones
K_SOFT = lambda N: max(1, math.ceil(N / 4))   # noqa: E731 (the goal's exact form; the engine calls k_soft(N))
THRESHOLD = 0.25                              # rule 9 default (spec §2)

# The engine's idle reasons (Portuguese) and the codes basket-scheduler.js returns for them.
IDLE = {'calendário': 'calendar', 'regra 6': 'complete', 'sem preço': 'no_price', 'banda': 'band',
        'regra 9': 'rule9', 'regra 5': 'rule5'}

# The four product splits (spec §2) as integer fractions. num / den must equal, bit for bit, the floats every analyst
# run used (src/scenarios.py SPLITS); checked in main().
SPLITS = {
    '25-25-50': ((1, 4), (1, 4), (1, 2)),
    '40-40-20': ((2, 5), (2, 5), (1, 5)),
    '33-33-33': ((1, 3), (1, 3), (1, 3)),
    '30-30-40': ((3, 10), (3, 10), (2, 5)),
}
ANALYST_SPLITS = {'25-25-50': (.25, .25, .50), '40-40-20': (.40, .40, .20),
                  '33-33-33': (1 / 3, 1 / 3, 1 / 3), '30-30-40': (.30, .30, .40)}

VOLATILE = (3200.0, 95000.0, 1.25)            # three volatile legs; magnitudes only, no market data


# ------------------------------------------------------------------------------------------------- engine and seeds
def load_engine(engine_dir):
    path = Path(os.path.expanduser(engine_dir)) / 'engine_discrete.py'
    src = path.read_bytes()
    sha = hashlib.sha256(src).hexdigest()
    if sha != ENGINE_SHA256:
        sys.exit(f'export_vectors: {path.name} sha256 {sha} is not the pinned {ENGINE_SHA256}; '
                 'review the new engine, then update ENGINE_SHA256 and regenerate')
    mod = types.ModuleType('engine_discrete')
    mod.__file__ = str(path)
    exec(compile(src, str(path), 'exec'), mod.__dict__)   # the exact bytes hashed above, no bytecode cache written
    return mod, sha


def file_sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def rng_for(name):
    return random.Random(int.from_bytes(hashlib.sha256(name.encode()).digest()[:8], 'big'))


def jitter(rng, base, amp):
    """base x (1 +- amp), rounded to 6 decimals: plain arithmetic, so every platform builds the same price."""
    return round(base * (1 + amp * (2 * rng.random() - 1)), 6)


def calm_rows(rng, ticks, bases=VOLATILE, amp=0.04):
    return [[jitter(rng, b, amp) for b in bases] for _ in range(ticks)]


# ------------------------------------------------------------------------------------------------- vectors
def vector(vid, split, N, prices, *, notes, C=1000, mf=16, mode='soft', thr=THRESHOLD, stable=None, band=None,
           badd=None):
    assert len(prices) == N + GRACE and all(len(r) == 3 for r in prices), vid
    if stable is not None:
        assert band is not None and badd is not None and len(badd) == N + GRACE, vid
    return {
        'id': vid,
        'notes': notes,
        'input': {
            'weights': [list(p) for p in SPLITS[split]],
            'capitalUsd': C,
            'cycles': N,
            'minFillUsd': mf,
            'mode': mode,
            'threshold': thr,
            'stableLeg': stable,
            'band': band,
            'bandAdd': badd,
            'prices': prices,
        },
    }


def run(ed, v):
    i = v['input']
    N = i['cycles']
    w = [a / b for a, b in i['weights']]
    P = np.array([[np.nan if x is None else float(x) for x in row] for row in i['prices']], dtype=float)
    kw = {}
    if i['stableLeg'] is not None:
        kw = dict(stable_idx=i['stableLeg'], band=i['band'], band_add=np.array(i['bandAdd'], dtype=float))
    return ed.run_discrete(P[:N].copy(), w, i['capitalUsd'], n=None, min_fill=i['minFillUsd'], L=L, Pd=P[:N].copy(),
                           pd0=np.full(3, np.nan), rPe=P[N:].copy(), rPd=P[N:].copy(), dd=i['threshold'],
                           mode=i['mode'], k_soft=K_SOFT, rule='hamilton', **kw)


def expected_of(r):
    n = [int(x) for x in r.n]
    done = [int(x) for x in r.done]
    return {
        'n': n,
        'kSoft': None if r.k_soft is None else int(r.k_soft),
        'fills': [[int(t), int(i), str(kind)] for t, i, _x, kind in r.fills],
        'idle': [[int(t), IDLE[reason]] for t, reason in sorted(r.idle.items())],
        'done': done,
        'unbought': [a - b for a, b in zip(n, done)],
        'deviationPp': float(r.deviation_pp),
    }


def protected_ticks(v, leg):
    """Ticks where the leg's price is <= entry x (1 - threshold), entry = its first price (spec §4.3)."""
    entry, out = None, []
    for t, row in enumerate(v['input']['prices']):
        p = row[leg]
        if p is None:
            continue
        if entry is None:
            entry = p
        if p <= entry * (1 - v['input']['threshold']):
            out.append(t)
    return out


def out_of_band_ticks(v):
    i = v['input']
    s = i['stableLeg']
    return [t for t, row in enumerate(i['prices'])
            if row[s] is not None and abs(row[s] - 1) + i['bandAdd'][t] > i['band']]


# ------------------------------------------------------------------------------------------------- families
def family_calm():
    vs = []
    for split in SPLITS:
        for N in (6, 9, 12, 26, 86):
            rng = rng_for(f'calm/{split}/{N}')
            vs.append(vector(f'calm-{split}-n{N}', split, N, calm_rows(rng, N + GRACE),
                             notes='calm prices (each leg within 4% of its base), soft, C=1000, minFill 16'))
    return vs


def family_fall():
    vs = []
    for N, split, leg in ((9, '40-40-20', 1), (26, '25-25-50', 2)):
        for recover in (False, True):
            rng = rng_for(f'fall/{N}/{recover}')
            rows = calm_rows(rng, N + GRACE)
            entry = rows[0][leg]
            back = max(6, round(0.6 * N))
            for t in range(1, N + GRACE):
                if recover and t >= back:
                    rows[t][leg] = round(entry * (0.95 + 0.04 * rng.random()), 6)
                else:
                    rows[t][leg] = round(entry * 0.70 * (1 - 0.03 * rng.random()), 6)
            what = f'recovers to 0.95-0.99 x entry at tick {back}' if recover else 'never recovers'
            for mode in ('soft', 'rigid'):
                vs.append(vector(f'fall-n{N}-leg{leg}-{"recovers" if recover else "stays"}-{mode}', split, N,
                                 [list(r) for r in rows], mode=mode,
                                 notes=f'leg {leg} at 0.679-0.700 x entry from tick 1, {what}; {mode}'))
    # The rule 9 boundary: entry 4.0, threshold 0.25, so entry x 0.75 = 3.0 exactly; 3.0 is protected (<=),
    # 3.000001 is not.
    rng = rng_for('fall/boundary')
    rows = calm_rows(rng, 12 + GRACE)
    path = [4.0, 3.6, 3.0, 3.0, 3.000001, 3.0, 2.9, 3.2, 3.0, 3.000001, 3.0, 3.5, 3.0, 3.000001, 3.0]
    for t, p in enumerate(path):
        rows[t][0] = p
    vs.append(vector('fall-boundary-n12-leg0-rigid', '33-33-33', 12, rows, mode='rigid',
                     notes='leg 0 entry 4.0: exactly 3.0 (= entry x 0.75) is protected, 3.000001 is not; rigid'))
    return vs


def family_no_price():
    def holes(rows, leg, ticks):
        for t in ticks:
            rows[t][leg] = None
        return rows
    vs = []
    rng = rng_for('no-price/1')
    vs.append(vector('noprice-n12-leg1-soft', '30-30-40', 12, holes(calm_rows(rng, 15), 1, (3, 4, 5, 11, 13)),
                     notes='leg 1 has no price at ticks 3-5, 11 (last nominal) and 13 (grace); soft'))
    rng = rng_for('no-price/2')
    vs.append(vector('noprice-n9-leg0-start-soft', '33-33-33', 9, holes(calm_rows(rng, 12), 0, (0, 1, 8, 9)),
                     notes='leg 0 has no price at ticks 0-1 (its entry and first variation come later), '
                           '8 (last nominal) and 9 (grace); soft'))
    rng = rng_for('no-price/3')
    rows = calm_rows(rng, 29)
    for leg in range(3):
        holes(rows, leg, (10, 11))
    vs.append(vector('noprice-n26-all-soft', '40-40-20', 26, holes(rows, 2, (25, 27)),
                     notes='no leg has a price at ticks 10-11; leg 2 none at 25 (last nominal) and 27 (grace); soft'))
    rng = rng_for('no-price/4')
    vs.append(vector('noprice-n12-leg2-rigid', '25-25-50', 12, holes(calm_rows(rng, 15), 2, (0, 5, 6, 7, 11, 12, 14)),
                     mode='rigid', notes='leg 2 has no price at ticks 0, 5-7, 11 (last nominal), 12 and 14 (grace); '
                                         'rigid'))
    return vs


def family_band():
    vs = []
    # Stable leg 2 at band 1%. Out: 0.971 (alone); 0.992 only because band_add 0.003 is added (0.008 + 0.003);
    # 0.99 and 1.01, where the float |p - 1| is 0.010000000000000009 > 0.01; 0.98 on the last nominal tick; 0.97 on a
    # grace tick. In: 0.992 with band_add 0, 1.009, 0.995 + 0.003.
    # The volatile legs rise at ticks 4-7, so the stable leg has the lowest variation there and the first chunk is
    # its own unless the band takes it out (or rule 5 does): band_add decides tick 4 and the float boundary 0.99
    # decides tick 5 (checked below by running the engine again without band_add, and with 0.991 for 0.99).
    stable = [1.0, 0.999, 0.971, 0.971, 0.992, 0.99, 0.992, 1.01, 1.009, 0.995, 1.0, 0.98, 1.0, 0.97, 1.0]
    badd = [0.003, 0.003, 0.0, 0.003, 0.003, 0.0, 0.0, 0.0, 0.0, 0.003, 0.003, 0.0, 0.0, 0.003, 0.0]
    f0 = [1.00, 0.99, 0.98, 0.96, 1.00, 1.02, 1.03, 1.06, 1.05, 1.04, 1.05, 1.03, 1.02, 1.03, 1.03]
    f1 = [1.00, 1.01, 0.99, 0.97, 1.01, 1.03, 1.04, 1.07, 1.05, 1.05, 1.04, 1.02, 1.03, 1.02, 1.02]
    rows = [[round(VOLATILE[0] * a, 6), round(VOLATILE[1] * b, 6), p] for a, b, p in zip(f0, f1, stable)]
    vs.append(vector('band-n12-stable2-b100-soft', '25-25-50', 12, rows, stable=2, band=0.01, badd=badd,
                     notes='stable leg 2, band 1%: 0.971 out; 0.992 out only with band_add 0.003; 0.99 and 1.01 out '
                           '(float); out on the last nominal tick and on a grace tick; the stable has the lowest '
                           'variation at ticks 4-7; soft'))
    # Stable leg 0 (the 40% leg) at band 5%: 0.96 + 0.003 and 1.047 + 0.003 are in; 0.948, 1.06, 0.94 out; 0.95 out
    # (float |p - 1| = 0.050000000000000044).
    stable = [1.0, 0.96, 0.948, 1.047, 1.06, 1.0, 0.95, 1.0, 0.94, 1.0, 1.02, 1.0]
    badd = [0.003, 0.003, 0.0, 0.003, 0.0, 0.0, 0.0, 0.003, 0.0, 0.0, 0.003, 0.0]
    rng = rng_for('band/2')
    rows = calm_rows(rng, 12)
    for t, p in enumerate(stable):
        rows[t][0] = p
    vs.append(vector('band-n9-stable0-b500-soft', '40-40-20', 9, rows, stable=0, band=0.05, badd=badd,
                     notes='stable leg 0 (40%), band 5%: 0.96 and 1.047 in, 0.948, 1.06, 0.94 out, 0.95 out (float), '
                           'out on the last nominal tick; soft'))
    # Idle-reason priority: leg 0 falls at tick 1 and never recovers (rigid: rule 9 for good), leg 1 has no price at
    # ticks 2-3 while it still has chunks to buy, the stable leg 2 is out of band at 2-3, 5 and 9 and has no price at
    # 7. Ticks with chunks due and no eligible leg must say no_price before band before rule9; every pair of the three
    # meets on some tick (checked below).
    stable = [1.0, 1.0, 0.97, 0.97, 1.0, 0.97, 1.0, None, 1.0, 0.97, 1.0, 1.0]
    badd = [0.0] * 12
    rng = rng_for('band/3')
    rows = calm_rows(rng, 12)
    entry0 = rows[0][0]
    for t in range(1, 12):
        rows[t][0] = round(entry0 * 0.70, 6)
    for t in (2, 3):
        rows[t][1] = None
    for t, p in enumerate(stable):
        rows[t][2] = p
    vs.append(vector('band-n9-priority-rigid', '25-25-50', 9, rows, mode='rigid', stable=2, band=0.01, badd=badd,
                     notes='idle priority: leg 0 rule 9 from tick 1 (rigid), leg 1 no price at 2-3, stable leg 2 out '
                           'at 2-3, 5, 9 and no price at 7'))
    return vs


def family_min_fill():
    vs = []
    for vid, split, N, C, mf, notes in (
        ('minfill-c100-m16-n12', '25-25-50', 12, 100, 16, 'C=100, minFill 16: n capped to (1, 1, 3)'),
        ('minfill-c250-m16-n86', '40-40-20', 86, 250, 16, 'C=250, minFill 16, daily maximum N: every leg capped'),
        ('minfill-c30-m3-n26', '33-33-33', 26, 30, 3, 'C=30, minFill 3 (canonical route): n capped to (3, 3, 3)'),
        ('minfill-c1000-m16-n86', '25-25-50', 86, 1000, 16, 'C=1000, minFill 16, N=86: capped, M < N'),
        ('minfill-c20-m16-n6', '30-30-40', 6, 20, 16, 'C=20, minFill 16: every cap is max(1, 0) = 1'),
        ('minfill-c1000-m3-n86', '25-25-50', 86, 1000, 3, 'contrast to minfill-c1000-m16-n86: minFill 3 caps '
                                                           'nothing, n is the Hamilton split of 86'),
    ):
        rng = rng_for(f'min-fill/{vid}')
        vs.append(vector(vid, split, N, calm_rows(rng, N + GRACE), C=C, mf=mf, notes=notes + '; calm, soft'))
    return vs


def family_ties():
    """Ties of the variation. A tick where no leg has a price leaves chunks due, so the next tick has catch-ups and
    their tie-breaks are exercised too."""
    def dark(rows, ticks):
        for t in ticks:
            rows[t] = [None, None, None]
        return rows
    vs = []
    vs.append(vector('ties-flat-n12-thirds', '33-33-33', 12, dark([list(VOLATILE) for _ in range(15)], (4, 5)),
                     notes='every price constant (no price at all at ticks 4-5): every variation is 0, only the '
                           'tie-breaks decide; equal n'))
    vs.append(vector('ties-flat-n9-25-25-50', '25-25-50', 9, dark([list(VOLATILE) for _ in range(12)], (2, 3)),
                     notes='every price constant (no price at all at ticks 2-3): every variation is 0, only the '
                           'tie-breaks decide; unequal n'))
    # One common move per tick for every leg (P_i = base_i x g_t, unrounded): the variations agree to 12 decimals and
    # differ in the last bits, so the first chunk falls to the tie-breaks while catch-up compares the raw variations.
    for vid, split, N, mode, bases, gaps in (
        ('ties-common-n26-30-30-40', '30-30-40', 26, 'soft', (3.0, 7.0, 0.3), (5, 6, 15)),
        ('ties-common-n12-40-40-20', '40-40-20', 12, 'rigid', (0.1, 9.0, 1.7), (3, 4)),
        ('ties-common-n9-thirds', '33-33-33', 9, 'soft', (0.7, 3.3, 11.0), (2, 3)),
        ('ties-common-n15-thirds', '33-33-33', 15, 'soft', (1.1, 0.3, 7.0), (1, 2, 3, 7, 8)),
    ):
        rng = rng_for(f'ties/{vid}')
        g, rows = 1.0, []
        for _ in range(N + GRACE):
            rows.append([b * g for b in bases])
            g = g * (1 + round(0.06 * (2 * rng.random() - 1), 4))
        vs.append(vector(vid, split, N, dark(rows, gaps), mode=mode,
                         notes=f'one common percentage move per tick for every leg, prices unrounded, no price at all '
                               f'at ticks {", ".join(map(str, gaps))}; {mode}'))
    return vs


def family_mixed():
    """Seeded mixes of everything. A soft vector keeps its window and grace ticks priced and in band (else nothing
    can promise it completes); a rigid vector has no such guard."""
    vs = []
    for j in range(24):
        rng = rng_for(f'mixed/{j}')
        split = list(SPLITS)[int(rng.random() * 4)]
        N = (6, 7, 9, 12, 15, 26)[int(rng.random() * 6)]
        mode = 'soft' if j % 2 == 0 else 'rigid'
        thr = (0.10, 0.25, 0.40)[int(rng.random() * 3)]
        C = (100, 500, 1000, 5000)[int(rng.random() * 4)]
        mf = (3, 16)[int(rng.random() * 2)]
        stable = (None, 0, 1, 2)[int(rng.random() * 4)]
        band = (0.01, 0.02, 0.05, 0.10)[int(rng.random() * 4)] if stable is not None else None
        T = N + GRACE
        clean_from = N - K_SOFT(N) if mode == 'soft' else T
        bases = [1.0 if leg == stable else VOLATILE[leg] for leg in range(3)]
        rows = [[jitter(rng, b, 0.003 if leg == stable else 0.04) for leg, b in enumerate(bases)] for _ in range(T)]
        badd = [(0.0, 0.003)[int(rng.random() * 2)] for _ in range(T)] if stable is not None else None
        for p_fall in (0.7, 0.4):                                   # up to two falls on volatile legs, maybe recovering
            if rng.random() >= p_fall:
                continue
            legs = [x for x in range(3) if x != stable]
            leg = legs[int(rng.random() * len(legs))]
            a = 1 + int(rng.random() * max(1, T - 2))
            b = a + 1 + int(rng.random() * (T - a))
            depth = 0.55 + 0.30 * rng.random()
            for t in range(a, min(b, T)):
                rows[t][leg] = round(rows[0][leg] * depth * (1 + 0.02 * (2 * rng.random() - 1)), 6)
        for t in range(T):
            if t < clean_from and rng.random() < 0.12:              # a tick where no leg has a price
                rows[t] = [None, None, None]
                continue
            for leg in range(3):
                if t < clean_from and rng.random() < 0.10:
                    rows[t][leg] = None
            if stable is not None and t < clean_from and rows[t][stable] is not None and rng.random() < 0.2:
                rows[t][stable] = round(1 + (2 * rng.random() - 1) * 0.06, 6)
        if mode == 'soft' and stable is not None:
            for t in range(clean_from, T):                          # in band, whatever band_add says
                rows[t][stable] = 1.0
                badd[t] = 0.0
        vs.append(vector(f'mixed-{j:02d}-{mode}', split, N, rows, C=C, mf=mf, mode=mode, thr=thr, stable=stable,
                         band=band, badd=badd,
                         notes=f'seeded mix (seed "mixed/{j}"): missing prices, ticks with no price at all, up to two '
                               f'falls, stable excursions; {mode}'))
    return vs


# ------------------------------------------------------------------------------------------------- claims
def rerun(v, badd=None, price=None):
    """The engine on a modified copy of a vector: what the picks would be without one of its edges."""
    w = json.loads(json.dumps(v))
    if badd is not None:
        w['input']['bandAdd'] = badd
    if price is not None:
        t, leg, p = price
        w['input']['prices'][t][leg] = p
    return expected_of(run(ENGINE, w))


def leg_reasons(v, exp, t):
    """Why each leg with chunks left is out at tick t (the engine's why_not order), from the inputs and its fills."""
    i = v['input']
    window = i['mode'] == 'soft' and t >= i['cycles'] - K_SOFT(i['cycles'])
    out = {}
    for leg in range(3):
        if sum(1 for f in exp['fills'] if f[1] == leg and f[0] < t) >= exp['n'][leg]:
            continue
        p = i['prices'][t][leg]
        if p is None:
            out[leg] = 'no_price'
        elif leg == i['stableLeg'] and abs(p - 1) + i['bandAdd'][t] > i['band']:
            out[leg] = 'band'
        elif t in protected_ticks(v, leg) and not window:
            out[leg] = 'rule9'
        else:
            out[leg] = 'eligible'
    return out


def check_claims(family, v, exp):
    """What each vector claims to exercise, checked against its inputs and the engine's output."""
    i, vid = v['input'], v['id']
    fails = []
    def need(cond, what):
        if not cond:
            fails.append(f'{vid}: {what}')
    kinds = collections.Counter(f[2] for f in exp['fills'])
    idle = collections.Counter(r for _t, r in exp['idle'])
    per_tick_leg = collections.Counter((f[0], f[1]) for f in exp['fills'])
    need(max(per_tick_leg.values(), default=0) <= L, 'more than L chunks of one leg in a tick')
    need(all(f[0] < i['cycles'] + GRACE for f in exp['fills']), 'a fill after the last grace tick')
    if i['mode'] == 'soft':
        need(sum(exp['unbought']) == 0, 'a soft vector left chunks unbought')
        need(exp['deviationPp'] < 1e-9, 'a completed soft vector deviates from its split')
        need(exp['kSoft'] == K_SOFT(i['cycles']), 'k_soft is not max(1, ceil(N / 4))')
    else:
        need(exp['kSoft'] is None, 'the engine reports k_soft for a rigid run')
    if family == 'calm':
        need(not ({'rule9', 'no_price', 'band'} & set(idle)), 'a calm vector idles for a price reason')
        need(kinds['select'] > 0, 'a calm vector never bought')
    if family == 'fall':
        leg = int(vid.split('-leg')[1][0])
        prot = protected_ticks(v, leg)
        need(len(prot) >= (5 if 'boundary' not in vid else 7), f'leg {leg} protected on only {len(prot)} ticks')
        override = (lambda t: i['mode'] == 'soft' and t >= i['cycles'] - K_SOFT(i['cycles']))
        need(not [f for f in exp['fills'] if f[1] == leg and f[0] in prot and not override(f[0])],
             'a protected leg bought outside the soft window')
        if 'stays' in vid and i['mode'] == 'rigid':
            need(exp['unbought'][leg] > 0, 'rigid and never recovering, yet the leg completed')
        if 'stays' in vid and i['mode'] == 'soft':
            need(any(f[1] == leg and f[0] in prot for f in exp['fills']), 'soft never bought the protected leg')
            if i['cycles'] == 26:
                need(any(per_tick_leg[(t, leg)] == L for t in range(i['cycles'] + GRACE)), 'catch-up never hit L')
        if 'boundary' in vid:
            need(3 in prot and 4 not in prot, 'the 3.0 / 3.000001 boundary is not where it should be')
    if family == 'no-price':
        holes = {(t, leg) for t, row in enumerate(i['prices']) for leg, p in enumerate(row) if p is None}
        need(not [f for f in exp['fills'] if (f[0], f[1]) in holes], 'a fill on a tick without a price')
        N = i['cycles']
        need(any(t == N - 1 for t, _ in holes) and any(t >= N for t, _ in holes), 'no hole on N-1 and in grace')
    if family == 'band':
        out = out_of_band_ticks(v)
        s = i['stableLeg']
        need(not [f for f in exp['fills'] if f[1] == s and f[0] in out], 'the stable leg bought out of band')
        need(i['cycles'] - 1 in out or 'priority' in vid, 'not out of band on the last nominal tick')
        if vid.startswith('band-n12'):
            only_add = [t for t in out if abs(i['prices'][t][s] - 1) <= i['band']]
            need(4 in only_add, 'tick 4 (0.992 + 0.003) is not out only because of band_add')
            need(6 not in out, 'tick 6 (0.992 + 0) is out')
            need(i['cycles'] + 1 in out, 'not out of band on a grace tick')
            need(5 in out and 0.99 - 1 == -0.010000000000000009, 'tick 5 (0.99) is not out by the float |p - 1|')
            # Counterfactuals: the picks must depend on band_add and on the float boundary.
            need(rerun(v, badd=[0.0] * len(i['bandAdd']))['fills'] != exp['fills'], 'band_add decides no pick')
            need(rerun(v, price=(5, s, 0.991))['fills'] != exp['fills'], '0.99 at tick 5 decides no pick')
        if 'priority' in vid:
            pairs = set()
            for t, reason in exp['idle']:
                if reason in ('no_price', 'band', 'rule9'):
                    have = set(leg_reasons(v, exp, t).values())
                    pairs |= {(a, b) for a in have for b in have if a < b}
            for pair in (('band', 'no_price'), ('band', 'rule9'), ('no_price', 'rule9')):
                need(pair in pairs, f'no idle tick where {pair[0]} and {pair[1]} meet')
    if family == 'min-fill':
        w = [a / b for a, b in i['weights']]
        nominal = [int(x) for x in ENGINE.choose_n(np.asarray(w), i['capitalUsd'], i['cycles'], 0)]
        capped = [a < b for a, b in zip(exp['n'], nominal)]
        if vid == 'minfill-c1000-m3-n86':
            need(not any(capped) and sum(exp['n']) == 86, 'minFill 3 capped something at C=1000')
        else:
            need(any(capped), f'minFill caps nothing: n={exp["n"]} hamilton={nominal}')
    if family == 'ties':
        if 'flat' in vid:
            need(all(row == i['prices'][0] or row == [None] * 3 for row in i['prices']), 'a flat vector moved')
        need(kinds['catchup'] > 0, 'no catch-up, so no catch-up tie-break')
    return fails


# ------------------------------------------------------------------------------------------------- choose_n, rounding
def choose_n_cases(ed, engine_dir):
    tests = Path(os.path.expanduser(engine_dir)).parent / 'tests'
    cases = []
    # tests/test_engine_discrete.py::test_chunks_respect_min_fill_and_hamilton_sum (N, C, split; min_fill 16.0)
    for N, C, split in itertools.product((5, 7, 13, 30, 60, 90), (250, 1000), ANALYST_SPLITS):
        n = ed.choose_n(np.asarray(ANALYST_SPLITS[split]), C, N, 16.0)
        cases.append({'source': 'test_engine_discrete.py::test_chunks_respect_min_fill_and_hamilton_sum',
                      'weights': [list(p) for p in SPLITS[split]], 'capitalUsd': C, 'cycles': N, 'minFillUsd': 16,
                      'n': [int(x) for x in n]})
    # tests/test_engine_v32.py::test_chosen_k_always_leaves_rule9_room_and_fits_every_chunk over experiments_v32.COMBOS
    # (src/experiments_v32.py:21-26: NS, CADS, fits(N, c) = (N + 3) * c < 90), C = 1000.0, MINFILL = 16.0
    NS, CADS, MAX_DAYS = (6, 7, 8, 9, 10, 12, 15, 20, 26, 30, 60, 86), (1, 3, 7), 90
    combos = [(c, N) for c in CADS for N in NS if (N + GRACE) * c < MAX_DAYS]
    for (c, N), split in itertools.product(combos, ANALYST_SPLITS):
        n = ed.choose_n(np.asarray(ANALYST_SPLITS[split]), 1000.0, N, 16.0)
        cases.append({'source': 'test_engine_v32.py::test_chosen_k_always_leaves_rule9_room_and_fits_every_chunk',
                      'cadenceDays': c, 'weights': [list(p) for p in SPLITS[split]], 'capitalUsd': 1000, 'cycles': N,
                      'minFillUsd': 16, 'n': [int(x) for x in n], 'kSoft': K_SOFT(N)})
    sources = {'tests/test_engine_discrete.py': file_sha(tests / 'test_engine_discrete.py'),
               'tests/test_engine_v32.py': file_sha(tests / 'test_engine_v32.py'),
               'src/experiments_v32.py': file_sha(Path(os.path.expanduser(engine_dir)) / 'experiments_v32.py')}
    return cases, sources, len(combos)


def rounding_cases():
    """round(np.float64(v), 12), as the engine's first-chunk sort applies it: numpy computes rint(v * 1e12) / 1e12,
    half to even, which is not Python's round() on a float (they disagree on the three values listed below)."""
    rng = rng_for('rounding')
    vals = [0.0, 1e-13, -1e-13, 0.1, -0.25]
    for k in list(range(40)) + [123456789, 987654321012, 4503599627370]:
        for s in (1, -1):
            x = s * (k + 0.5) / 1e12
            if np.float64(x) * 1e12 == s * (k + 0.5):           # an exact halfway point after the scaling
                vals.append(x)
    vals += [-0.2370041199085, -0.2140024663715, 0.1168517820435]
    for _ in range(200):
        a = 0.5 + rng.random() * 1e5
        vals.append(a * (0.7 + 0.6 * rng.random()) / a - 1)
    out = [[float(x), float(round(np.float64(x), 12))] for x in vals]
    halfway = sum(1 for x in vals if float(np.float64(x) * 1e12) % 1 == 0.5)
    differs = sum(1 for x, r in out if r != round(x, 12))
    return out, halfway, differs


# ------------------------------------------------------------------------------------------------- JSON layout
def dump(obj, ind=0):
    """Readable, diff-friendly JSON: one tick or one fill per line. Floats are Python's shortest round-trip repr,
    which JSON.parse turns into the same double."""
    pad = ' ' * ind
    scalar = lambda x: not isinstance(x, (dict, list))  # noqa: E731
    text = lambda x: json.dumps(x, allow_nan=False, ensure_ascii=False)  # noqa: E731
    if isinstance(obj, dict):
        items = [f'{pad}  {text(k)}: {dump(v, ind + 2)}' for k, v in obj.items()]
        return '{\n' + ',\n'.join(items) + '\n' + pad + '}' if items else '{}'
    if isinstance(obj, list):
        if all(scalar(x) for x in obj):
            return '[' + ', '.join(text(x) for x in obj) + ']'
        items = [f'{pad}  {dump(x, ind + 2)}' for x in obj]
        return '[\n' + ',\n'.join(items) + '\n' + pad + ']'
    return text(obj)


def header(family, about, sha, extra=None):
    h = {
        'family': family,
        'about': about,
        'generator': GENERATOR,
        'engine': {'file': 'engine_discrete.py', 'sha256': sha,
                   'package': 'analyst package basket-dca-v2, docs-Reports-basket-dca/src (v3.2)'},
        'run': {'function': 'run_discrete', 'L': L, 'rule': 'hamilton', 'kSoft': 'max(1, ceil(N / 4))',
                'graceTicks': GRACE, 'pd0': [None, None, None],
                'Pe': 'the decision prices (Pe values fills only; no decision reads it)'},
        'idleReasons': IDLE,
        'generatedWith': {'python': platform.python_version(), 'numpy': np.__version__},
    }
    if extra:
        h.update(extra)
    return h


FAMILIES = (
    ('calm', family_calm, 'the 4 splits x N in {6, 9, 12, 26, 86}, calm prices'),
    ('fall', family_fall, 'one leg below entry x 0.75 for many ticks, recovering and not, soft and rigid; the rule 9 '
                          'boundary'),
    ('no-price', family_no_price, 'a leg without a price on several ticks, the last nominal tick and a grace tick '
                                  'included; a tick where no leg has a price'),
    ('band', family_band, 'the stable leg out of band, band_add pushing 0.992 out at band 1%; the idle-reason '
                          'priority'),
    ('min-fill', family_min_fill, 'minFill capping n (16 and 3 USD), with one uncapped contrast'),
    ('ties', family_ties, 'exact and 12-decimal ties of the variation: only the tie-breaks decide'),
    ('mixed', family_mixed, 'seeded mixes of holes, falls and stable excursions; soft and rigid'),
)

ENGINE = None


def build(engine_dir):
    global ENGINE
    ed, sha = load_engine(engine_dir)
    ENGINE = ed
    files, summary, fails = {}, [], []
    for family, make, about in FAMILIES:
        vs = make()
        for v in vs:
            exp = expected_of(run(ed, v))
            v['expected'] = exp
            fails += check_claims(family, v, exp)
        ids = [v['id'] for v in vs]
        assert len(ids) == len(set(ids)), family
        files[f'{family}.json'] = {'header': header(family, about, sha), 'vectors': vs}
        idle = collections.Counter(r for v in vs for _t, r in v['expected']['idle'])
        kinds = collections.Counter(f[2] for v in vs for f in v['expected']['fills'])
        summary.append((family, len(vs), sum(len(v['input']['prices']) for v in vs), dict(kinds), dict(idle),
                        sum(sum(v['expected']['unbought']) for v in vs)))
    cases, sources, n_combos = choose_n_cases(ed, engine_dir)
    files['choose-n.json'] = {
        'header': header('choose-n', 'every choose_n case of the engine tests, and k_soft for N = 1..100', sha,
                         {'sources': sources, 'combos': n_combos}),
        'cases': cases,
        'kSoft': [[N, K_SOFT(N)] for N in range(1, 101)],
    }
    summary.append(('choose-n', len(cases), 0, {}, {}, 0))
    rcases, halfway, differs = rounding_cases()
    files['rounding.json'] = {
        'header': header('rounding', 'round(np.float64(v), 12) as the first-chunk sort applies it: rint(v x 1e12) / '
                                     '1e12, half to even', sha, {'halfway': halfway, 'differFromPythonRound': differs}),
        'cases': rcases,
    }
    summary.append(('rounding', len(rcases), 0, {}, {}, 0))
    if fails:
        sys.exit('export_vectors: claims do not hold:\n  ' + '\n  '.join(fails))
    return files, summary, sha


def comparable(obj):
    obj = json.loads(json.dumps(obj))
    obj['header'].pop('generatedWith', None)
    return obj


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--engine-dir', default=os.environ.get('BASKET_ENGINE_DIR', DEFAULT_ENGINE_DIR))
    ap.add_argument('--check', action='store_true', help='regenerate in memory and compare; write nothing')
    args = ap.parse_args()
    for split, fr in SPLITS.items():
        assert tuple(a / b for a, b in fr) == ANALYST_SPLITS[split], split   # bit for bit
    files, summary, sha = build(args.engine_dir)
    print(f'engine_discrete.py sha256 {sha}  python {platform.python_version()}  numpy {np.__version__}')
    for family, count, ticks, kinds, idle, unbought in summary:
        print(f'  {family:9} {count:4} {"cases" if not ticks else "vectors"}'
              + (f'  ticks {ticks}  fills {kinds}  idle {idle}  unbought chunks {unbought}' if ticks else ''))
    bad = 0
    for name, obj in files.items():
        path = OUT_DIR / name
        text = dump(obj) + '\n'
        if args.check:
            same = path.exists() and comparable(json.loads(path.read_text(encoding='utf-8'))) == comparable(obj)
            print(f'  {"same" if same else "DIFFERS"}  {path.relative_to(REPO)}')
            bad += not same
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding='utf-8')
            print(f'  wrote {path.relative_to(REPO)} ({len(text)} bytes)')
    if args.check:
        stray = sorted(p.name for p in OUT_DIR.glob('*.json') if p.name not in files) if OUT_DIR.exists() else []
        for s in stray:
            print(f'  STRAY {s}')
        if bad or stray:
            sys.exit(1)


if __name__ == '__main__':
    main()
