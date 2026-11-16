"""Basket DCA engine — rules 1-9 of claude/basket-dca-definicao-mecanismo.md.

Strategies
  A  : Basket DCA, rule 3 CORRECTED (cap to the winner's gap, roll the leftover to the
       next-best eligible leg by rule 4, final liquidation ignores the rule-5 cooldown).
  A0 : Basket DCA with the ORIGINAL rule 3 (whole cycle budget to the winner, no roll,
       final liquidation still honours the cooldown). Kept only to reproduce the July defect.
  B  : fixed 3-leg DCA (every cycle buys every leg in the target proportion, no selection).
  C  : single-leg DCA in the main volatile leg (ETH).

Modelling choices (declared in RESULTS):
  * one cycle budget b = C/N; a cycle in which no leg is eligible is SKIPPED and its cash
    waits (ADR-024 "skip the cycle, never the order"); the final tick (rule 8) settles it.
  * rule 4 variation = price(t)/price(t-1) - 1 per leg, where t-1 is one cadence earlier
    (for tick 0, the feed value one cadence before the first tick).
  * rule 5 cooldown is set on the cycle's PRIMARY winner only (the leg chosen by rule 4
    before any roll-over).
  * fills execute at the tick's feed price (no slippage, no fee) — the guarantee being
    tested is the USD split, which does not depend on execution price.
"""
from dataclasses import dataclass, field
import numpy as np

EPS = 1e-9

@dataclass
class Result:
    strategy: str
    spent: np.ndarray          # USD per leg
    qty: np.ndarray            # units per leg
    cash_left: float           # uninvested USD at the end
    capital: float
    weights: np.ndarray
    fills: list                # (tick, leg, usd, kind) kind in {'select','roll','final','fixed'}
    lock_tick: list            # per leg: tick index when target reached (None if never)
    lock_via_final: list       # per leg: reached only through rule-8 liquidation
    value_path: np.ndarray     # mark-to-market value after each tick (holdings + cash)
    protect_events: dict = field(default_factory=dict)   # leg -> number of eligible->protected transitions
    protect_ticks: dict = field(default_factory=dict)    # leg -> ticks spent protected
    stable_block_ticks: int = 0
    cooldown_ticks: list = field(default_factory=list)   # (tick, leg) cooldown actually excluded a leg
    lock_events: list = field(default_factory=list)      # (tick, leg)
    protect_marks: list = field(default_factory=list)    # (tick, leg) protected at tick
    alloc_path: np.ndarray = None                        # cumulative spent share per leg after each tick
    final_tick_usd: float = 0.0
    cand: list = field(default_factory=list)            # per fill: number of candidate legs when it was decided
    peak_price: np.ndarray = None
    entry_price: np.ndarray = None

    @property
    def deviation_pp(self):
        """max_i |spent_i / capital - w_i| in percentage points (capital-based)."""
        return float(np.max(np.abs(self.spent / self.capital - self.weights)) * 100)

    @property
    def deviation_invested_pp(self):
        tot = self.spent.sum()
        if tot <= 0: return float('nan')
        return float(np.max(np.abs(self.spent / tot - self.weights)) * 100)

    @property
    def uninvested_pct(self): return 100 * self.cash_left / self.capital

    def final_value(self, p_end): return float((self.qty * p_end).sum() + self.cash_left)

    @property
    def max_drawdown_pct(self):
        v = self.value_path; peak = np.maximum.accumulate(v)
        return float(np.max((peak - v) / peak) * 100)

    @property
    def avg_price(self):
        with np.errstate(divide='ignore', invalid='ignore'):
            return np.where(self.qty > 0, self.spent / self.qty, np.nan)

    @property
    def n_fills(self): return len(self.fills)


def run_basket(P, p_prev0, weights, capital=1000.0, rule3_fix=True,
               dd_threshold=None, dd_mode='soft', stable_idx=None, stable_band=None,
               stable_final='soft'):
    """P: (N, 3) prices at the N ticks. p_prev0: (3,) prices one cadence before tick 0.
    dd_threshold: rule-9 threshold as a fraction (0.2 = 20%) or None (rule 9 off).
    dd_mode: 'soft' (final liquidation ignores protection) | 'rigid' (never buys a protected leg).
    stable_idx/stable_band: proposed stable-peg rule — stable leg ineligible while |p-1| > band.
    stable_final: at the final tick a de-pegged stable is 'soft' (bought anyway) or 'rigid' (left uninvested)."""
    P = np.asarray(P, float); N, L = P.shape
    w = np.asarray(weights, float); assert abs(w.sum() - 1) < 1e-9
    C = float(capital); b = C / N; T = w * C
    S = np.zeros(L); Q = np.zeros(L); cash = C
    entry = P[0].copy(); peak = P[0].copy()
    fills, lock_tick, lock_final = [], [None] * L, [False] * L
    vpath, apath = [], []
    pe = {i: 0 for i in range(L)}; pt = {i: 0 for i in range(L)}
    was_protected = [False] * L
    cooldown_leg = None; stable_block_ticks = 0
    cd_marks, lock_events, prot_marks = [], [], []
    final_usd = 0.0

    def gap(i): return max(0.0, T[i] - S[i])
    def locked(i): return S[i] >= T[i] - EPS

    cand = []
    def buy(t, i, usd, kind, ncand=1):
        nonlocal cash
        usd = min(usd, cash)
        if usd <= EPS: return 0.0
        S[i] += usd; Q[i] += usd / P[t, i]; cash -= usd
        fills.append((t, i, usd, kind)); cand.append(ncand)
        if lock_tick[i] is None and locked(i):
            lock_tick[i] = t; lock_final[i] = (kind == 'final'); lock_events.append((t, i))
        return usd

    def rank(cands, v):
        # rule 4: smallest signed variation; rule 7: tie -> most behind its own target
        return sorted(cands, key=lambda i: (round(v[i], 12), -(gap(i) / T[i] if T[i] > 0 else 0)))

    for t in range(N):
        prev = P[t - 1] if t > 0 else np.asarray(p_prev0, float)
        v = P[t] / prev - 1
        peak = np.maximum(peak, P[t])
        protected = [False] * L
        if dd_threshold is not None:
            for i in range(L):
                protected[i] = P[t, i] <= entry[i] * (1 - dd_threshold)
                if protected[i]:
                    pt[i] += 1; prot_marks.append((t, i))
                    if not was_protected[i]: pe[i] += 1
                was_protected[i] = protected[i]
        sblock = (stable_idx is not None and stable_band is not None
                  and abs(P[t, stable_idx] - 1.0) > stable_band)
        if sblock: stable_block_ticks += 1
        final = (t == N - 1)

        if final:
            # rule 8: liquidate every under-filled leg
            order = rank([i for i in range(L) if not locked(i)], v)
            for i in order:
                if not rule3_fix and i == cooldown_leg and len(order) > 1:
                    continue  # original: cooldown still honoured at the final tick
                if protected[i] and dd_mode == 'rigid':
                    continue
                if sblock and i == stable_idx and stable_final == 'rigid':
                    continue
                final_usd += buy(t, i, gap(i), 'final')
        else:
            unlocked = [i for i in range(L) if not locked(i)]
            elig = [i for i in unlocked if not protected[i] and not (sblock and i == stable_idx)]
            if cooldown_leg in elig and len(elig) > 1:
                elig.remove(cooldown_leg); cd_marks.append((t, cooldown_leg))
            budget = min(b, cash)
            order = rank(elig, v)
            primary = order[0] if order else None
            if rule3_fix:
                for k, i in enumerate(order):
                    if budget <= EPS: break
                    budget -= buy(t, i, min(budget, gap(i)), 'select' if i == primary else 'roll', len(order) - k)
            elif primary is not None:
                buy(t, primary, budget, 'select', len(order))   # original: whole budget, may overshoot
            cooldown_leg = primary
        vpath.append(float((Q * P[t]).sum() + cash))
        apath.append(S / C)

    res = Result('A' if rule3_fix else 'A0', S, Q, cash, C, w, fills, lock_tick, lock_final,
                 np.array(vpath), pe, pt, stable_block_ticks, cd_marks, lock_events, prot_marks,
                 np.array(apath), final_usd, peak, entry)
    res.cand = cand
    return res


def run_fixed(P, weights, capital=1000.0):
    P = np.asarray(P, float); N, L = P.shape; w = np.asarray(weights, float)
    C = float(capital); b = C / N
    S = np.zeros(L); Q = np.zeros(L); fills = []; vpath = []; apath = []; cash = C
    for t in range(N):
        for i in range(L):
            x = w[i] * b; S[i] += x; Q[i] += x / P[t, i]; cash -= x; fills.append((t, i, x, 'fixed'))
        vpath.append(float((Q * P[t]).sum() + cash)); apath.append(S / C)
    cash = max(cash, 0.0) if abs(cash) > 1e-7 else 0.0
    return Result('B', S, Q, cash, C, w, fills, [N - 1] * L, [False] * L, np.array(vpath), alloc_path=np.array(apath))


def run_single(p, capital=1000.0):
    p = np.asarray(p, float); N = len(p); C = float(capital); b = C / N
    q = 0.0; vpath = []; fills = []
    for t in range(N):
        q += b / p[t]; fills.append((t, 0, b, 'fixed')); vpath.append(q * p[t] + C - b * (t + 1))
    return Result('C', np.array([C]), np.array([q]), 0.0, C, np.array([1.0]), fills, [N - 1], [False], np.array(vpath))
