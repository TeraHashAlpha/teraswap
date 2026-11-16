#!/usr/bin/env python3
"""Export the Basket DCA selection test vectors from the analyst's reference engine.

What: JSON fixtures for contracts/order-engine/executor/basket-scheduler.js (SPEC-BASKET-DCA §4 and §4a, ADR-027).
A run vector holds the inputs (weights as integer fractions, capital C in USD, cycles N, minFill, mode, threshold,
stable leg, band, band_add per tick, the REFERENCE = the decision prices one cycle before tick 0 with null = the leg
has none, decision prices per tick with null = no price, N nominal ticks + 3 grace ticks) and what the engine did with
them: n per leg, every fill as [tick, leg, kind], the idle reason of every tick without a fill, done per leg, k_soft,
and one `perLeg` row per tick with the values the engine decided with (variation, entry, protected, in band) and why
each leg did or did not buy.

How: `engine_discrete.run_discrete` of the analyst package (v3.2) with L = 2, rule = 'hamilton',
k_soft = lambda N: max(1, ceil(N / 4)), pd0 = the vector's reference (nan where it is null), exactly as every analyst
run calls it (experiments_v31.py: pd0 = the decision prices of the row before the first cycle), and Pe = the decision
prices (Pe only values the fills; no decision reads it). In the engine pd0 gives `last` only: `entry`, the base of
rule 9, is the price of the leg's first tick with a price, whatever the reference (owner decision 2026-11-16: follow
the engine).

The engine file is a byte-for-byte copy of the analyst's, kept next to the fixtures
(contracts/order-engine/executor/fixtures/basket-dca/engine_discrete.py, sha256 in engine_discrete.py.sha256), so this
script and its --check run from the repo alone. It is hashed and executed from exactly the bytes that were hashed; a
sha256 other than ENGINE_SHA256 stops the script. It is never edited: the per-tick values are read from
run_discrete's own local variables with sys.settrace, at two lines found by their text.

Prices are written in this file, built from fixed seeds with random.Random.random() (a sequence Python keeps stable
across versions) and plain arithmetic only (no libm call), so the fixtures are byte-reproducible. No market data.
Every family asserts what it claims to cover (soft vectors complete, a band vector is out of band where it says, ...)
and the script stops when a claim does not hold.

Run it with Python 3.9+ and numpy only, from a venv OUTSIDE the repo:
    python3 -m venv ~/venvs/basket-dca && ~/venvs/basket-dca/bin/pip install numpy
    ~/venvs/basket-dca/bin/python -I scripts/basket-dca/export_vectors.py           # (re)write the fixtures
    ~/venvs/basket-dca/bin/python -I scripts/basket-dca/export_vectors.py --check   # regenerate in memory, compare
--check compares BYTES when this Python and numpy are the versions in the fixture's header (generatedWith); with
other versions it compares the parsed values and says so.
Options: --engine-dir DIR (default: $BASKET_ENGINE_DIR, else the fixtures folder); --analyst-src DIR (the analyst
package's src/ folder: also prove that the in-repo engine copy and the hashed choose-n sources are the analyst's).
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
REPO = Path(__file__).resolve().parents[2]
OUT_DIR = REPO / 'contracts' / 'order-engine' / 'executor' / 'fixtures' / 'basket-dca'
ENGINE_FILE = 'engine_discrete.py'
GENERATOR = 'scripts/basket-dca/export_vectors.py'

# The analyst files the choose-n cases were transcribed from (sha256 of each, relative to the package root). They are
# not in the repo; --analyst-src re-hashes them.
CHOOSE_N_SOURCES = {
    'tests/test_engine_discrete.py': '6a1a828c50fd2787a813a65d25d620d99b6035b8e3280c6652ef76a1ec88cf66',
    'tests/test_engine_v32.py': 'ab50d3311026bfc67ee4b47bf2a0796c433efc6f7bb39a5c2be41663f05af451',
    'src/experiments_v32.py': '0ae205f322ee387da405d1c76145c1c0c8e654cbcd0844d073e988a4083a18e1',
}

L = 2                                         # chunks per leg per tick: dcaInterval = T / 2
GRACE = 3                                     # grace ticks after the N nominal ones
K_SOFT = lambda N: max(1, math.ceil(N / 4))   # noqa: E731 (the goal's exact form; the engine calls k_soft(N))
THRESHOLD = 0.25                              # rule 9 default (spec §2)

# The engine's idle reasons (Portuguese) and the codes basket-scheduler.js returns for them.
IDLE = {'calendário': 'calendar', 'regra 6': 'complete', 'sem preço': 'no_price', 'banda': 'band',
        'regra 9': 'rule9', 'regra 5': 'rule5'}

# One `perLeg` row per tick: the engine's own values at that tick, then why each leg did or did not buy.
PER_LEG_COLUMNS = ['variation0', 'variation1', 'variation2', 'entry0', 'entry1', 'entry2',
                   'protected0', 'protected1', 'protected2', 'inBand', 'reason0', 'reason1', 'reason2']
V, E, P9, B, R = 0, 3, 6, 9, 10               # first column of each group
PER_LEG_ABOUT = {
    'variation': 'v = price / last - 1, unrounded; null when the leg has no price or no previous price (nan in the '
                 'engine)',
    'entry': "rule 9's base price: the leg's first tick with a price; null before it. Never the reference",
    'protected': 'price <= entry x (1 - threshold); false without a price. Reported in the soft window too, where it '
                 'no longer blocks',
    'inBand': 'the stable leg only: not(|price - 1| + band_add > band); null without a stable leg or without its price',
    'reason': "picked = at least one fill on the tick; complete / no_price / band / rule9 = the engine's why_not; "
              'cooldown = eligible, not picked, and first in the rule 4 order until rule 5 sent it to the back of the '
              'line; not_due = eligible and not picked for any other reason (nothing due, or the chunks due went to '
              'legs ahead of it)',
}

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
    path = Path(os.path.expanduser(engine_dir)) / ENGINE_FILE
    src = path.read_bytes()
    sha = hashlib.sha256(src).hexdigest()
    if sha != ENGINE_SHA256:
        sys.exit(f'export_vectors: {path} sha256 {sha} is not the pinned {ENGINE_SHA256}; '
                 'review the new engine, then update ENGINE_SHA256 and regenerate')
    mod = types.ModuleType('engine_discrete')
    mod.__file__ = str(path)
    exec(compile(src, str(path), 'exec'), mod.__dict__)   # the exact bytes hashed above, no bytecode cache written
    lines = src.decode('utf-8').split('\n')

    def line_of(start):
        hits = [k for k, s in enumerate(lines, 1) if s.strip().startswith(start)]
        assert len(hits) == 1, f'{ENGINE_FILE}: expected one line starting with {start!r}, found {len(hits)}'
        return hits[0]
    # Where the trace reads run_discrete's locals: once the tick's eligibility and calendar are known (before any
    # pick), and when the rule 4 order is sorted (before rule 5 moves the cooldown leg).
    mod.AT_STATE = line_of('took = np.zeros(Lg, int)')
    mod.AT_ORDER = line_of('if cooldown in order and len(order) > 1:')
    return mod, sha, path


def file_sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def verify_analyst(analyst_src, engine_path):
    """The in-repo engine copy is the analyst's file, byte for byte, and the choose-n sources are the hashed ones."""
    src = Path(os.path.expanduser(analyst_src))
    if (src / ENGINE_FILE).read_bytes() != Path(engine_path).read_bytes():
        sys.exit(f'export_vectors: {engine_path} is not byte-identical to {src / ENGINE_FILE}')
    for rel, sha in CHOOSE_N_SOURCES.items():
        got = file_sha(src.parent / rel)
        if got != sha:
            sys.exit(f'export_vectors: {rel} sha256 {got} is not the pinned {sha}; re-read its cases')
    print(f'  analyst package: {ENGINE_FILE} is byte-identical to the in-repo copy; '
          f'{len(CHOOSE_N_SOURCES)} choose-n sources match their pinned sha256')


def rng_for(name):
    return random.Random(int.from_bytes(hashlib.sha256(name.encode()).digest()[:8], 'big'))


def jitter(rng, base, amp):
    """base x (1 +- amp), rounded to 6 decimals: plain arithmetic, so every platform builds the same price."""
    return round(base * (1 + amp * (2 * rng.random() - 1)), 6)


def calm_rows(rng, ticks, bases=VOLATILE, amp=0.04):
    return [[jitter(rng, b, amp) for b in bases] for _ in range(ticks)]


def reference(name, bases=VOLATILE, amp=0.04):
    """The decision prices one cycle before tick 0 (the engine's pd0). Its own seed, so a vector's tick prices do not
    depend on it: the price rows of the families that existed before the reference are unchanged."""
    rng = rng_for(name + '/reference')
    return [jitter(rng, b, amp) for b in bases]


# ------------------------------------------------------------------------------------------------- vectors
def vector(vid, split, N, prices, *, ref, notes, C=1000, mf=16, mode='soft', thr=THRESHOLD, stable=None, band=None,
           badd=None):
    assert len(prices) == N + GRACE and all(len(r) == 3 for r in prices), vid
    assert len(ref) == 3, vid
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
            'reference': list(ref),
            'prices': prices,
        },
    }


def nan_none(a):
    return [None if np.isnan(x) else float(x) for x in a]


def traced(ed, *args, **kwargs):
    """run_discrete, unedited, with its per-tick locals copied out by a trace function."""
    code = ed.run_discrete.__code__
    tape = {}

    def local(frame, event, _arg):
        if event == 'line' and frame.f_lineno == ed.AT_STATE:
            loc = frame.f_locals
            tape[int(loc['t'])] = {
                'usable': [bool(x) for x in loc['usable']],
                'v': nan_none(loc['v']),
                'entry': nan_none(loc['entry']),
                'prot': [bool(x) for x in loc['prot']],
                'sblock': bool(loc['sblock']),
                'due': int(loc['due']),
                'cooldown': None if loc['cooldown'] is None else int(loc['cooldown']),
                'why': [loc['why_not'](k) for k in range(3)],
                'sorted': None,
            }
        elif event == 'line' and frame.f_lineno == ed.AT_ORDER:
            loc = frame.f_locals
            tape[int(loc['t'])]['sorted'] = [int(k) for k in loc['order']]
        return local

    def tracer(frame, _event, _arg):
        return local if frame.f_code is code else None

    sys.settrace(tracer)
    try:
        r = ed.run_discrete(*args, **kwargs)
    finally:
        sys.settrace(None)
    return r, tape


def run(ed, v, trace=True):
    i = v['input']
    N = i['cycles']
    w = [a / b for a, b in i['weights']]
    P = np.array([[np.nan if x is None else float(x) for x in row] for row in i['prices']], dtype=float)
    pd0 = np.array([np.nan if x is None else float(x) for x in i['reference']], dtype=float)
    kw = {}
    if i['stableLeg'] is not None:
        kw = dict(stable_idx=i['stableLeg'], band=i['band'], band_add=np.array(i['bandAdd'], dtype=float))
    args = (P[:N].copy(), w, i['capitalUsd'])
    kwargs = dict(n=None, min_fill=i['minFillUsd'], L=L, Pd=P[:N].copy(), pd0=pd0, rPe=P[N:].copy(), rPd=P[N:].copy(),
                  dd=i['threshold'], mode=i['mode'], k_soft=K_SOFT, rule='hamilton', **kw)
    if not trace:
        return ed.run_discrete(*args, **kwargs), None
    return traced(ed, *args, **kwargs)


def per_leg_rows(v, r, tape):
    """One row per tick from the engine's own state (PER_LEG_COLUMNS)."""
    stable = v['input']['stableLeg']
    rows = []
    for t in range(v['input']['cycles'] + GRACE):
        s = tape[t]
        picked = {int(i) for tt, i, _x, _kind in r.fills if tt == t}
        order = s['sorted'] or []
        moved = s['cooldown'] if len(order) > 1 and order[0] == s['cooldown'] else None   # rule 5 took its first place
        reasons = []
        for leg in range(3):
            if leg in picked:
                reasons.append('picked')
            elif s['why'][leg] is not None:
                reasons.append(IDLE[s['why'][leg]])
            elif leg == moved:
                reasons.append('cooldown')
            else:
                reasons.append('not_due')
        in_band = None if stable is None or not s['usable'][stable] else not s['sblock']
        rows.append(s['v'] + s['entry'] + s['prot'] + [in_band] + reasons)
    return rows


def expected_of(v, r, tape=None):
    n = [int(x) for x in r.n]
    done = [int(x) for x in r.done]
    exp = {
        'n': n,
        'kSoft': None if r.k_soft is None else int(r.k_soft),
        'fills': [[int(t), int(i), str(kind)] for t, i, _x, kind in r.fills],
        'idle': [[int(t), IDLE[reason]] for t, reason in sorted(r.idle.items())],
        'done': done,
        'unbought': [a - b for a, b in zip(n, done)],
        'deviationPp': float(r.deviation_pp),
    }
    if tape is not None:
        exp['perLeg'] = per_leg_rows(v, r, tape)
    return exp


def protected_ticks(v, leg):
    """Ticks where the leg's price is <= entry x (1 - threshold), entry = its first TICK price (spec §4.3; the
    reference is not a tick)."""
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
            name = f'calm/{split}/{N}'
            vs.append(vector(f'calm-{split}-n{N}', split, N, calm_rows(rng_for(name), N + GRACE), ref=reference(name),
                             notes='calm prices (each leg within 4% of its base, the reference too), soft, C=1000, '
                                   'minFill 16'))
    return vs


def family_fall():
    vs = []
    for N, split, leg in ((9, '40-40-20', 1), (26, '25-25-50', 2)):
        for recover in (False, True):
            name = f'fall/{N}/{recover}'
            rng = rng_for(name)
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
                                 [list(r) for r in rows], ref=reference(name), mode=mode,
                                 notes=f'leg {leg} at 0.679-0.700 x entry (its tick 0 price) from tick 1, {what}; '
                                       f'{mode}'))
    # The rule 9 boundary: entry 4.0, threshold 0.25, so entry x 0.75 = 3.0 exactly; 3.0 is protected (<=),
    # 3.000001 is not. The reference (4.4) is not the entry: against 4.4 both would be protected.
    rng = rng_for('fall/boundary')
    rows = calm_rows(rng, 12 + GRACE)
    path = [4.0, 3.6, 3.0, 3.0, 3.000001, 3.0, 2.9, 3.2, 3.0, 3.000001, 3.0, 3.5, 3.0, 3.000001, 3.0]
    for t, p in enumerate(path):
        rows[t][0] = p
    ref = reference('fall/boundary')
    ref[0] = 4.4
    vs.append(vector('fall-boundary-n12-leg0-rigid', '33-33-33', 12, rows, ref=ref, mode='rigid',
                     notes='leg 0 entry 4.0 (reference 4.4): exactly 3.0 (= entry x 0.75) is protected, 3.000001 is '
                           'not; rigid'))
    # Rule 9 in doubles: entry 1.2, threshold 0.25. 1.2 x (1 - 0.25) is 0.8999999999999999, one double under 0.9, so
    # a price of exactly 0.9 (entry x 0.75 on paper) is NOT protected and the leg buys; 0.8999999999999999 is protected.
    rng = rng_for('fall/inexact')
    rows = calm_rows(rng, 12 + GRACE, amp=0.005)
    path = [1.2, 1.1, 0.9, 0.9, 0.8999999999999999, 0.9, 0.95, 0.9, 0.8999999999999999, 0.9, 1.0, 0.9, 0.9,
            0.8999999999999999, 0.9]
    for t, p in enumerate(path):
        rows[t][0] = p
    ref = reference('fall/inexact', amp=0.005)
    ref[0] = 1.25
    vs.append(vector('fall-inexact-n12-leg0-rigid', '33-33-33', 12, rows, ref=ref, mode='rigid',
                     notes='leg 0 entry 1.2: 1.2 x 0.75 is 0.8999999999999999 in doubles, so a price of exactly 0.9 '
                           'is NOT protected (it buys) and 0.8999999999999999 is; rigid'))
    # The reference is not rule 9's entry. Leg 0 opens about 30% under its reference and stays there: its entry is
    # its tick 0 price, so it is never protected, and with the lowest variation it takes the first chunk.
    rng = rng_for('fall/below-reference')
    rows = calm_rows(rng, 9 + GRACE)
    for t in range(9 + GRACE):
        rows[t][0] = round(70.0 * (1 + 0.02 * (2 * rng.random() - 1)), 6)
    ref = reference('fall/below-reference')
    ref[0] = 100.0
    vs.append(vector('fall-below-reference-n9-leg0-rigid', '33-33-33', 9, rows, ref=ref, mode='rigid',
                     notes='leg 0: reference 100, then 68.6-71.4 from tick 0 on (25% under the reference at every '
                           'tick, never 25% under its tick 0 price): never protected, and it takes the first chunk; '
                           'rigid'))
    # The other way round. Leg 1 opens 40% over its reference and then sits at 100.9-104: over the reference, but 25%
    # under its tick 0 price, so it is protected from tick 1 on and (rigid) never buys.
    rng = rng_for('fall/below-entry')
    rows = calm_rows(rng, 9 + GRACE)
    rows[0][1] = 140.0
    for t in range(1, 9 + GRACE):
        rows[t][1] = round(104.0 * (1 - 0.03 * rng.random()), 6)
    ref = reference('fall/below-entry')
    ref[1] = 100.0
    vs.append(vector('fall-below-entry-n9-leg1-rigid', '40-40-20', 9, rows, ref=ref, mode='rigid',
                     notes='leg 1: reference 100, 140 at tick 0, then 100.9-104 (over the reference, 25% under its '
                           'tick 0 price): protected from tick 1 on, never buys; rigid'))
    return vs


def family_no_price():
    def holes(rows, leg, ticks):
        for t in ticks:
            rows[t][leg] = None
        return rows
    vs = []
    rng = rng_for('no-price/1')
    vs.append(vector('noprice-n12-leg1-soft', '30-30-40', 12, holes(calm_rows(rng, 15), 1, (3, 4, 5, 11, 13)),
                     ref=reference('no-price/1'),
                     notes='leg 1 has no price at ticks 3-5, 11 (last nominal) and 13 (grace); soft'))
    rng = rng_for('no-price/2')
    vs.append(vector('noprice-n9-leg0-start-soft', '33-33-33', 9, holes(calm_rows(rng, 12), 0, (0, 1, 8, 9)),
                     ref=reference('no-price/2'),
                     notes='leg 0 has no price at ticks 0-1 (its entry comes at tick 2, where its variation is '
                           'against the reference), 8 (last nominal) and 9 (grace); soft'))
    rng = rng_for('no-price/3')
    rows = calm_rows(rng, 29)
    for leg in range(3):
        holes(rows, leg, (10, 11))
    vs.append(vector('noprice-n26-all-soft', '40-40-20', 26, holes(rows, 2, (25, 27)), ref=reference('no-price/3'),
                     notes='no leg has a price at ticks 10-11; leg 2 none at 25 (last nominal) and 27 (grace); soft'))
    rng = rng_for('no-price/4')
    vs.append(vector('noprice-n12-leg2-rigid', '25-25-50', 12, holes(calm_rows(rng, 15), 2, (0, 5, 6, 7, 11, 12, 14)),
                     ref=reference('no-price/4'), mode='rigid',
                     notes='leg 2 has no price at ticks 0, 5-7, 11 (last nominal), 12 and 14 (grace); rigid'))
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
    ref = [round(VOLATILE[0] * 1.01, 6), VOLATILE[1], 1.0]
    vs.append(vector('band-n12-stable2-b100-soft', '25-25-50', 12, rows, ref=ref, stable=2, band=0.01, badd=badd,
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
    ref = reference('band/2')
    ref[0] = 1.0
    vs.append(vector('band-n9-stable0-b500-soft', '40-40-20', 9, rows, ref=ref, stable=0, band=0.05, badd=badd,
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
    ref = reference('band/3')
    ref[2] = 1.0
    vs.append(vector('band-n9-priority-rigid', '25-25-50', 9, rows, ref=ref, mode='rigid', stable=2, band=0.01,
                     badd=badd,
                     notes='idle priority: leg 0 rule 9 from tick 1 (rigid), leg 1 no price at 2-3, stable leg 2 out '
                           'at 2-3, 5, 9 and no price at 7'))
    # The band edge, exactly. At the four product bands (1%, 2%, 5%, 10%) no double price makes |p - 1| + band_add
    # EQUAL the band, so `>` and `>=` cannot differ there; at a widened band of 171 bps with band_add 0.003 they can:
    # |0.9859 - 1| + 0.003 and |1.0141 - 1| + 0.003 are both exactly 0.0171. The engine says `> band`, so both are IN
    # band and the stable leg buys (ticks 1 and 7); 0.9858 (tick 5) is out. The volatile legs rise 1% a tick, so the
    # stable has the lowest variation whenever it dips.
    stable = [1.0, 0.9859, 1.0, 1.0141, 1.0, 0.9858, 1.0, 0.9859, 1.0, 1.0, 1.0, 1.0]
    badd = [0.003] * 12
    rows = [[round(VOLATILE[0] * 1.01 ** t, 6), round(VOLATILE[1] * 1.01 ** t, 6), p] for t, p in enumerate(stable)]
    ref = [round(VOLATILE[0] * 1.01, 6), VOLATILE[1], 1.0]
    vs.append(vector('band-edge-n9-stable2-b171-soft', '25-25-50', 9, rows, ref=ref, stable=2, band=0.0171, badd=badd,
                     notes='stable leg 2, band 171 bps, band_add 0.003: at 0.9859 and 1.0141 the sum |p - 1| + '
                           'band_add equals the band exactly, which is IN band (the engine compares with >), and the '
                           'stable buys at ticks 1 and 7; 0.9858 is out; soft'))
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
        name = f'min-fill/{vid}'
        vs.append(vector(vid, split, N, calm_rows(rng_for(name), N + GRACE), ref=reference(name), C=C, mf=mf,
                         notes=notes + '; calm, soft'))
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
                     ref=list(VOLATILE),
                     notes='every price constant, the reference included (no price at all at ticks 4-5): every '
                           'variation is 0, only the tie-breaks decide; equal n'))
    vs.append(vector('ties-flat-n9-25-25-50', '25-25-50', 9, dark([list(VOLATILE) for _ in range(12)], (2, 3)),
                     ref=list(VOLATILE),
                     notes='every price constant, the reference included (no price at all at ticks 2-3): every '
                           'variation is 0, only the tie-breaks decide; unequal n'))
    # One common move per tick for every leg (P_i = base_i x g_t, unrounded), from the reference on: the variations
    # agree to 12 decimals and differ in the last bits, so the first chunk falls to the tie-breaks while catch-up
    # compares the raw variations.
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
        g0 = 1 + round(0.06 * (2 * rng_for(f'ties/{vid}/reference').random() - 1), 4)
        vs.append(vector(vid, split, N, dark(rows, gaps), ref=[b / g0 for b in bases], mode=mode,
                         notes=f'one common percentage move per tick for every leg, from the reference on, prices '
                               f'unrounded, no price at all at ticks {", ".join(map(str, gaps))}; {mode}'))
    return vs


def family_mixed():
    """Seeded mixes of everything. A soft vector keeps its window and grace ticks priced and in band (else nothing
    can promise it completes); a rigid vector has no such guard. A leg has no reference with probability 0.15."""
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
        rr = rng_for(f'mixed/{j}/reference')
        ref = []
        for leg, b in enumerate(bases):
            missing = rr.random() < 0.15
            p = jitter(rr, b, 0.003 if leg == stable else 0.04)
            ref.append(None if missing else p)
        vs.append(vector(f'mixed-{j:02d}-{mode}', split, N, rows, ref=ref, C=C, mf=mf, mode=mode, thr=thr,
                         stable=stable, band=band, badd=badd,
                         notes=f'seeded mix (seed "mixed/{j}"): missing prices, ticks with no price at all, up to two '
                               f'falls, stable excursions, a leg without a reference now and then; {mode}'))
    return vs


def family_no_reference():
    """A leg with NO reference (null, the engine's nan in pd0): no previous price, so its variation counts as 0 at
    its first tick with a price, and that tick sets its entry as for every leg."""
    vs = []
    # No reference on any leg = "buy the first one now" (spec §4): every variation is 0 at tick 0 and the last tie
    # goes to the lower leg, so leg 0 takes the first chunk. The prices are those of the calm vector of the same split
    # and N, which is how these vectors looked before the reference existed.
    for split in SPLITS:
        for N in (6, 9, 26):
            vs.append(vector(f'noref-all-{split}-n{N}', split, N, calm_rows(rng_for(f'calm/{split}/{N}'), N + GRACE),
                             ref=[None, None, None],
                             notes=f'no reference on any leg ("buy the first one now"): leg 0 takes the first chunk; '
                                   f'the prices of calm-{split}-n{N}; soft'))
    for leg, split, N in ((0, '25-25-50', 9), (1, '40-40-20', 12), (2, '30-30-40', 9)):
        name = f'no-reference/one/{leg}'
        ref = reference(name)
        ref[leg] = None
        vs.append(vector(f'noref-leg{leg}-n{N}', split, N, calm_rows(rng_for(name), N + GRACE), ref=ref,
                         notes=f'leg {leg} has no reference, the other two do; calm, soft'))
    # The leg without a reference counts as 0: it wins the first chunk when the others rose, whatever its index...
    name = 'no-reference/others-rise'
    rows = calm_rows(rng_for(name), 9 + GRACE)
    ref = [round(rows[0][0] * 0.97, 6), round(rows[0][1] * 0.97, 6), None]
    vs.append(vector('noref-leg2-others-rise-n9', '33-33-33', 9, rows, ref=ref,
                     notes='leg 2 has no reference (variation 0); legs 0 and 1 are 3.1% over theirs at tick 0: leg 2 '
                           'takes the first chunk; soft'))
    # ... and loses it when the others fell, even as leg 0.
    name = 'no-reference/others-fall'
    rows = calm_rows(rng_for(name), 9 + GRACE)
    ref = [None, round(rows[0][1] * 1.03, 6), round(rows[0][2] * 1.03, 6)]
    vs.append(vector('noref-leg0-others-fall-n9', '33-33-33', 9, rows, ref=ref,
                     notes='leg 0 has no reference (variation 0); legs 1 and 2 are 2.9% under theirs at tick 0: leg 0 '
                           'does not take the first chunk; soft'))
    # No reference and no price at ticks 0-1: the leg's first variation (0) and its entry come at tick 2.
    name = 'no-reference/late'
    rows = calm_rows(rng_for(name), 9 + GRACE)
    rows[0][1] = rows[1][1] = None
    ref = reference(name)
    ref[1] = None
    vs.append(vector('noref-leg1-late-n9', '40-40-20', 9, rows, ref=ref,
                     notes='leg 1 has no reference and no price at ticks 0-1: at tick 2 its variation counts as 0 '
                           'and its entry is set; soft'))
    name = 'no-reference/two'
    ref = reference(name)
    ref[0] = ref[1] = None
    vs.append(vector('noref-legs01-n12', '30-30-40', 12, calm_rows(rng_for(name), 12 + GRACE), ref=ref,
                     notes='legs 0 and 1 have no reference, leg 2 does; calm, soft'))
    # Rule 9 for a leg without a reference: entry is its tick 0 price, as for every leg.
    name = 'no-reference/fall'
    rng = rng_for(name)
    rows = calm_rows(rng, 9 + GRACE)
    for t in range(1, 9 + GRACE):
        rows[t][0] = round(rows[0][0] * 0.70 * (1 - 0.03 * rng.random()), 6)
    ref = reference(name)
    ref[0] = None
    vs.append(vector('noref-leg0-fall-n9-rigid', '40-40-20', 9, rows, ref=ref, mode='rigid',
                     notes='leg 0 has no reference and sits at 0.679-0.700 x its tick 0 price from tick 1: protected, '
                           'never recovers; rigid'))
    return vs


# ------------------------------------------------------------------------------------------------- claims
def rerun(v, badd=None, price=None, ref=None):
    """The engine on a modified copy of a vector: what the picks would be without one of its edges."""
    w = json.loads(json.dumps(v))
    if badd is not None:
        w['input']['bandAdd'] = badd
    if price is not None:
        t, leg, p = price
        w['input']['prices'][t][leg] = p
    if ref is not None:
        w['input']['reference'] = ref
    r, _tape = run(ENGINE, w, trace=False)
    return expected_of(w, r)


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
    rows = exp['perLeg']
    need(max(per_tick_leg.values(), default=0) <= L, 'more than L chunks of one leg in a tick')
    need(all(f[0] < i['cycles'] + GRACE for f in exp['fills']), 'a fill after the last grace tick')
    # The engine's per-tick values are what this file says they are: entry = the leg's first TICK price (never the
    # reference), variation = price / previous price - 1 with the reference as the first previous price, protected =
    # price <= entry x (1 - threshold), and "picked" marks exactly the legs with a fill.
    need(len(rows) == i['cycles'] + GRACE, 'a tick is missing from the engine trace')
    first, last = [None] * 3, list(i['reference'])
    for t, row in enumerate(rows):
        for leg in range(3):
            p = i['prices'][t][leg]
            if first[leg] is None and p is not None:
                first[leg] = p
            need(row[E + leg] == first[leg], f'tick {t} leg {leg}: the entry is not the first tick price')
            need(row[V + leg] == (None if p is None or last[leg] is None else p / last[leg] - 1),
                 f'tick {t} leg {leg}: the variation is not price / previous price - 1')
            need(row[P9 + leg] == (p is not None and p <= first[leg] * (1 - i['threshold'])),
                 f'tick {t} leg {leg}: protected is not price <= entry x (1 - threshold)')
            if p is not None:
                last[leg] = p
        need({leg for leg in range(3) if row[R + leg] == 'picked'} == {f[1] for f in exp['fills'] if f[0] == t},
             f'tick {t}: "picked" is not exactly the legs with a fill')
    if i['mode'] == 'soft':
        need(sum(exp['unbought']) == 0, 'a soft vector left chunks unbought')
        need(exp['deviationPp'] < 1e-9, 'a completed soft vector deviates from its split')
        need(exp['kSoft'] == K_SOFT(i['cycles']), 'k_soft is not max(1, ceil(N / 4))')
    else:
        need(exp['kSoft'] is None, 'the engine reports k_soft for a rigid run')
    if family == 'calm':
        need(not ({'rule9', 'no_price', 'band'} & set(idle)), 'a calm vector idles for a price reason')
        need(kinds['select'] > 0, 'a calm vector never bought')
        need(all(x is not None for x in i['reference']), 'a calm vector lacks a reference')
        need(rerun(v, ref=[None] * 3)['fills'][0] == [0, 0, 'select'], 'without the reference leg 0 is not first')
    if family == 'fall':
        leg = int(vid.split('-leg')[1][0])
        prot = protected_ticks(v, leg)
        override = (lambda t: i['mode'] == 'soft' and t >= i['cycles'] - K_SOFT(i['cycles']))
        need(not [f for f in exp['fills'] if f[1] == leg and f[0] in prot and not override(f[0])],
             'a protected leg bought outside the soft window')
        under_ref = [t for t, row in enumerate(i['prices']) if row[leg] <= i['reference'][leg] * (1 - i['threshold'])]
        if 'below-reference' in vid:
            need(len(under_ref) == len(i['prices']), 'not 25% under its reference at every tick')
            need(not prot, 'protected, though never 25% under its tick 0 price')
            need(exp['fills'][0] == [0, leg, 'select'], 'the leg under its reference does not take the first chunk')
            need(exp['unbought'] == [0, 0, 0], 'rigid, never protected, yet chunks were left')
        elif 'below-entry' in vid:
            need(not under_ref, 'under its reference on some tick')
            need(prot == list(range(1, len(i['prices']))), 'not protected from tick 1 on')
            need(exp['unbought'][leg] == exp['n'][leg], 'protected from tick 1, yet it bought')
        elif 'inexact' in vid:
            edge = i['prices'][0][leg] * (1 - i['threshold'])
            need(i['prices'][0][leg] == 1.2 and i['threshold'] == 0.25 and edge == 0.8999999999999999 and edge < 0.9,
                 'entry x (1 - threshold) is not the inexact 1.2 x 0.75')
            at, under = [t for t, row in enumerate(i['prices']) if row[leg] == 0.9], \
                        [t for t, row in enumerate(i['prices']) if row[leg] == edge]
            need(len(at) >= 5 and len(under) >= 2, 'too few ticks at 0.9 and at 0.8999999999999999')
            need(not (set(at) & set(prot)) and set(under) <= set(prot), '0.9 protected, or 0.8999999999999999 not')
            bought = [f[0] for f in exp['fills'] if f[1] == leg and f[0] in at]
            need(bought, 'the leg never buys at exactly 0.9')
            for t in bought[:1]:      # the engine's answer decides a pick: one double lower and the leg does not buy
                need(rerun(v, price=(t, leg, edge))['fills'] != exp['fills'], '0.9 against 0.8999999999999999 decides '
                                                                             'no pick')
        else:
            need(len(prot) >= (5 if 'boundary' not in vid else 7), f'leg {leg} protected on only {len(prot)} ticks')
            if 'stays' in vid and i['mode'] == 'rigid':
                need(exp['unbought'][leg] > 0, 'rigid and never recovering, yet the leg completed')
            if 'stays' in vid and i['mode'] == 'soft':
                need(any(f[1] == leg and f[0] in prot for f in exp['fills']), 'soft never bought the protected leg')
                if i['cycles'] == 26:
                    need(any(per_tick_leg[(t, leg)] == L for t in range(i['cycles'] + GRACE)), 'catch-up never hit L')
            if 'boundary' in vid:
                need(3 in prot and 4 not in prot, 'the 3.0 / 3.000001 boundary is not where it should be')
                need(set(under_ref) >= {3, 4}, 'the reference does not put 3.0 and 3.000001 on the same side')
    if family == 'no-price':
        holes = {(t, leg) for t, row in enumerate(i['prices']) for leg, p in enumerate(row) if p is None}
        need(not [f for f in exp['fills'] if (f[0], f[1]) in holes], 'a fill on a tick without a price')
        N = i['cycles']
        need(any(t == N - 1 for t, _ in holes) and any(t >= N for t, _ in holes), 'no hole on N-1 and in grace')
        if 'start' in vid:            # the reference spans the gap: the first variation is against it
            need(rows[2][V] == i['prices'][2][0] / i['reference'][0] - 1 and rows[2][E] == i['prices'][2][0],
                 'tick 2 does not compare against the reference')
    if family == 'band':
        out = out_of_band_ticks(v)
        s = i['stableLeg']
        need(not [f for f in exp['fills'] if f[1] == s and f[0] in out], 'the stable leg bought out of band')
        need(all(row[B] == (None if i['prices'][t][s] is None else t not in out) for t, row in enumerate(rows)),
             "the engine's band verdict is not |p - 1| + band_add > band")
        need(i['cycles'] - 1 in out or 'priority' in vid or 'edge' in vid, 'not out of band on the last nominal tick')
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
        if 'edge' in vid:
            edge = [t for t, row in enumerate(i['prices']) if abs(row[s] - 1) + i['bandAdd'][t] == i['band']]
            need({i['prices'][t][s] for t in edge} == {0.9859, 1.0141}, 'no tick exactly on the band edge, both sides')
            need(not (set(edge) & set(out)) and all(rows[t][B] is True for t in edge), 'an exact-edge tick is out')
            need(5 in out and i['prices'][5][s] == 0.9858, '0.9858 at tick 5 is not out')
            bought = [t for t in edge if any(f[0] == t and f[1] == s for f in exp['fills'])]
            need(len(bought) >= 2, 'the stable leg does not buy on two exact-edge ticks')
            for t in bought:          # one double past the edge and the stable is out: the pick changes
                p = i['prices'][t][s]
                past = math.nextafter(p, 0.0 if p < 1 else 2.0)
                need(abs(past - 1) + i['bandAdd'][t] > i['band'], 'the next double is not out of band')
                need(rerun(v, price=(t, s, past))['fills'] != exp['fills'], f'the edge at tick {t} decides no pick')
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
            need(i['reference'] == i['prices'][0] and rows[0][V:V + 3] == [0.0, 0.0, 0.0], 'the reference moved')
        else:                         # tick 0 too is a 12-decimal tie
            need(len({float(round(np.float64(x), 12)) for x in rows[0][V:V + 3]}) == 1, 'tick 0 is not a tie')
        need(kinds['catchup'] > 0, 'no catch-up, so no catch-up tie-break')
        need(exp['fills'][0] == [0, 0, 'select'], 'a tie at tick 0 does not go to leg 0')
    if family == 'no-reference':
        none = [leg for leg in range(3) if i['reference'][leg] is None]
        need(none, 'every leg has a reference')
        for leg in none:              # no previous price at its first priced tick: the engine's v is nan there
            t0 = next(t for t, row in enumerate(i['prices']) if row[leg] is not None)
            need(rows[t0][V + leg] is None and rows[t0][E + leg] == i['prices'][t0][leg],
                 f'leg {leg}: its first priced tick has a variation, or does not set its entry')
            need(all(rows[t][E + leg] is None for t in range(t0)), f'leg {leg}: an entry before its first price')
        if 'noref-all' in vid:
            need(len(none) == 3 and exp['fills'][0] == [0, 0, 'select'], 'no reference at all: leg 0 is not first')
        if 'others-rise' in vid:
            need(exp['fills'][0] == [0, 2, 'select'], 'the leg without a reference does not win against rises')
        if 'others-fall' in vid:
            need(exp['fills'][0][1] != 0 and rows[0][R] != 'picked', 'leg 0 without a reference wins against falls')
        if 'late' in vid:
            need(none == [1] and rows[2][V + 1] is None and rows[2][E + 1] == i['prices'][2][1], 'tick 2 is not '
                 "leg 1's first")
        if vid == 'noref-leg0-fall-n9-rigid':
            need(protected_ticks(v, 0) == list(range(1, len(i['prices']))) and exp['unbought'][0] > 0,
                 'the leg without a reference is not protected from tick 1 on')
    return fails


# ------------------------------------------------------------------------------------------------- choose_n, rounding
def choose_n_cases(ed):
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
    return cases, dict(CHOOSE_N_SOURCES), len(combos)


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


def header(family, about, sha, extra=None, per_leg=True):
    h = {
        'family': family,
        'about': about,
        'generator': GENERATOR,
        'engine': {'file': ENGINE_FILE, 'sha256': sha,
                   'package': 'analyst package basket-dca-v2, docs-Reports-basket-dca/src (v3.2)',
                   'copy': f'{OUT_DIR.relative_to(REPO).as_posix()}/{ENGINE_FILE} (byte for byte)'},
        'run': {'function': 'run_discrete', 'L': L, 'rule': 'hamilton', 'kSoft': 'max(1, ceil(N / 4))',
                'graceTicks': GRACE,
                'pd0': 'input.reference of each vector: the decision prices one cycle before tick 0 (null = nan: the '
                       'leg has no reference). It gives `last`; `entry` is the first tick price',
                'Pe': 'the decision prices (Pe values fills only; no decision reads it)'},
        'idleReasons': IDLE,
    }
    if per_leg:                   # the families that run the engine tick by tick
        h['perLegColumns'] = PER_LEG_COLUMNS
        h['perLeg'] = PER_LEG_ABOUT
    h['generatedWith'] = {'python': platform.python_version(), 'numpy': np.__version__}
    if extra:
        h.update(extra)
    return h


FAMILIES = (
    ('calm', family_calm, 'the 4 splits x N in {6, 9, 12, 26, 86}, calm prices, every leg with a reference'),
    ('fall', family_fall, 'one leg below entry x 0.75 for many ticks, recovering and not, soft and rigid; the rule 9 '
                          'boundary, exact (entry 4.0) and inexact in doubles (entry 1.2); the reference is not the '
                          'entry, both ways'),
    ('no-price', family_no_price, 'a leg without a price on several ticks, the last nominal tick and a grace tick '
                                  'included; a tick where no leg has a price'),
    ('band', family_band, 'the stable leg out of band, band_add pushing 0.992 out at band 1%; the idle-reason '
                          'priority; the sum exactly on the band edge'),
    ('min-fill', family_min_fill, 'minFill capping n (16 and 3 USD), with one uncapped contrast'),
    ('ties', family_ties, 'exact and 12-decimal ties of the variation, from the reference on: only the tie-breaks '
                          'decide'),
    ('mixed', family_mixed, 'seeded mixes of holes, falls, stable excursions and missing references; soft and rigid'),
    ('no-reference', family_no_reference, 'a leg with no reference: none at all ("buy the first one now", the calm '
                                          'prices), one leg, two legs; with the others rising, falling, and with no '
                                          'price at first'),
)

ENGINE = None


def build(engine_dir):
    global ENGINE
    ed, sha, engine_path = load_engine(engine_dir)
    ENGINE = ed
    files, summary, fails = {}, [], []
    for family, make, about in FAMILIES:
        vs = make()
        for v in vs:
            r, tape = run(ed, v)
            exp = expected_of(v, r, tape)
            v['expected'] = exp
            fails += check_claims(family, v, exp)
        ids = [v['id'] for v in vs]
        assert len(ids) == len(set(ids)), family
        extra = {}
        if family == 'calm':          # the reference decides the first chunk: without it, it is always leg 0
            changed = [v['id'] for v in vs if v['expected']['fills'][0][1] != 0]
            if not changed:
                fails.append('calm: the reference changes no first pick')
            extra['referenceChangesFirstPick'] = changed
        files[f'{family}.json'] = {'header': header(family, about, sha, extra), 'vectors': vs}
        idle = collections.Counter(r for v in vs for _t, r in v['expected']['idle'])
        kinds = collections.Counter(f[2] for v in vs for f in v['expected']['fills'])
        reasons = collections.Counter(x for v in vs for row in v['expected']['perLeg'] for x in row[R:R + 3])
        summary.append((family, len(vs), sum(len(v['input']['prices']) for v in vs), dict(kinds), dict(idle),
                        sum(sum(v['expected']['unbought']) for v in vs), dict(sorted(reasons.items()))))
    cases, sources, n_combos = choose_n_cases(ed)
    files['choose-n.json'] = {
        'header': header('choose-n', 'every choose_n case of the engine tests, and k_soft for N = 1..100', sha,
                         {'sources': sources, 'combos': n_combos}, per_leg=False),
        'cases': cases,
        'kSoft': [[N, K_SOFT(N)] for N in range(1, 101)],
    }
    summary.append(('choose-n', len(cases), 0, {}, {}, 0, {}))
    rcases, halfway, differs = rounding_cases()
    files['rounding.json'] = {
        'header': header('rounding', 'round(np.float64(v), 12) as the first-chunk sort applies it: rint(v x 1e12) / '
                                     '1e12, half to even', sha, {'halfway': halfway, 'differFromPythonRound': differs},
                         per_leg=False),
        'cases': rcases,
    }
    summary.append(('rounding', len(rcases), 0, {}, {}, 0, {}))
    if fails:
        sys.exit('export_vectors: claims do not hold:\n  ' + '\n  '.join(fails))
    return files, summary, sha, engine_path


def comparable(obj):
    obj = json.loads(json.dumps(obj))
    obj['header'].pop('generatedWith', None)
    return obj


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--engine-dir', default=os.environ.get('BASKET_ENGINE_DIR', str(OUT_DIR)),
                    help='folder holding engine_discrete.py (default: the fixtures folder, the in-repo copy)')
    ap.add_argument('--analyst-src', default=None,
                    help="the analyst package's src/ folder: also prove the in-repo engine copy and the choose-n "
                         "sources are the analyst's files")
    ap.add_argument('--check', action='store_true', help='regenerate in memory and compare; write nothing')
    args = ap.parse_args()
    for split, fr in SPLITS.items():
        assert tuple(a / b for a, b in fr) == ANALYST_SPLITS[split], split   # bit for bit
    files, summary, sha, engine_path = build(args.engine_dir)
    versions = {'python': platform.python_version(), 'numpy': np.__version__}
    print(f'{ENGINE_FILE} sha256 {sha}  python {versions["python"]}  numpy {versions["numpy"]}')
    print(f'  engine read from {engine_path}')
    if args.analyst_src:
        verify_analyst(args.analyst_src, OUT_DIR / ENGINE_FILE)
    for family, count, ticks, kinds, idle, unbought, reasons in summary:
        print(f'  {family:12} {count:4} {"cases" if not ticks else "vectors"}'
              + (f'  ticks {ticks}  fills {kinds}  idle {idle}  unbought chunks {unbought}  leg reasons {reasons}'
                 if ticks else ''))
    texts = {name: dump(obj) + '\n' for name, obj in files.items()}
    texts[ENGINE_FILE + '.sha256'] = f'{sha}  {ENGINE_FILE}\n'             # `shasum -a 256 -c` reads this
    bad = 0
    for name, text in texts.items():
        path = OUT_DIR / name
        if args.check:
            raw = path.read_bytes() if path.exists() else None
            how = 'bytes'
            if raw is None:
                same, how = False, 'missing'
            else:
                wrote = json.loads(raw)['header'].get('generatedWith', {}) if name in files else versions
                if wrote == versions:
                    same = raw == text.encode('utf-8')
                else:
                    # Another Python or numpy than the one that wrote the file: the text of a float is not promised
                    # to be the same, so compare what the JSON says, not how it is spelt.
                    same = comparable(json.loads(raw)) == comparable(files[name])
                    how = f'values, not bytes: written with python {wrote.get("python")} numpy {wrote.get("numpy")}'
            print(f'  {"same" if same else "DIFFERS"} ({how})  {path.relative_to(REPO)}')
            bad += not same
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding='utf-8')
            print(f'  wrote {path.relative_to(REPO)} ({len(text.encode("utf-8"))} bytes)')
    if args.check:
        known = set(texts) | {ENGINE_FILE}
        stray = sorted(p.name for p in OUT_DIR.iterdir()
                       if p.suffix in ('.json', '.py', '.sha256') and p.name not in known) if OUT_DIR.exists() else []
        for s in stray:
            print(f'  STRAY {s}')
        if bad or stray:
            sys.exit(1)


if __name__ == '__main__':
    main()
