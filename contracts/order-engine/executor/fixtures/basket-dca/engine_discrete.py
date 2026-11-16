"""v3.1 · «A+ discreto»: the Basket as the V3 contract can execute it (Architect, 7 Nov 2026).

One Basket = one DCA order per leg. Leg i sells a FIXED chunk w_i·C / n_i, at most n_i times, at most L chunks per
cycle (L = 2 <=> dcaInterval = cadence / 2), and nothing after expiry = start + (N + 3) cycles. The keeper decides, each
cycle, which legs execute:

  schedule : by the end of cycle t (t < N) the Basket should have executed ceil(M·(t+1)/N) chunks, M = Σ n_i; in the
             3 grace cycles everything left is due. A cycle executes as many chunks as are due (0, 1 or more).
  rule 4   : the first chunk of a cycle goes to the eligible leg with the worst variation since the last cycle (P:
             decision prices); rule 5: not the leg that took the first chunk last cycle, unless it is the only one.
  catch-up : further chunks due in the same cycle go to the eligible legs furthest behind their own count
             (remaining chunks / n_i), never more than L per leg in the cycle.
  rule 6   : a leg is locked when it has executed all its chunks (DCAComplete).
  rule 9   : a protected leg is ineligible; in soft mode protection stops blocking in the last k_soft nominal cycles
             and in the grace cycles (the discrete form of E); in rigid mode it always blocks. v3.2: k_soft may be a
             function of N (k_soft(N) or k_soft(N, n) with n the chunks per leg); an int keeps the v3.1 behaviour.
  band B   : the stable leg is ineligible while |price − 1| > band (judged at the tick, grace cycles included).
             v3.2: band_add[t] is added to |price − 1| (the feed's deviation threshold when the decision price is the
             feed: the Architect's rule); None = 0, as in v3.1.
  no price : a leg without a usable decision price is out of that cycle.
Fills execute at the feed price of the tick (Pe), as in v2/v3. Chunks still pending at expiry are not bought: that
money never left the user's wallet. The split of what WAS bought is exact by construction: every fill is one chunk.
"""
import math, numpy as np

EPS = 1e-12

def choose_n(w, C, N, min_fill, rule='hamilton'):
    """Chunks per leg. hamilton: largest-remainder split of N by weight (Σ = N), at least 1 per leg, then capped so the
    chunk is >= min_fill. ceil / round: alternatives, same floor and cap."""
    w = np.asarray(w, float); raw = w * N
    if rule == 'ceil': n = np.ceil(raw - 1e-9).astype(int)
    elif rule == 'round': n = np.floor(raw + 0.5).astype(int)
    else:
        n = np.floor(raw + 1e-9).astype(int); rem = int(N - n.sum())
        for i in np.argsort(-(raw - n), kind='stable')[:max(rem, 0)]: n[i] += 1
    n = np.maximum(n, 1)
    cap = np.maximum(np.floor(w * C / min_fill + 1e-9).astype(int), 1) if min_fill else n
    return np.minimum(n, cap)

class DResult:
    pass

def run_discrete(Pe, w, C=1000.0, *, n=None, min_fill=16.0, L=1, Pd=None, pd0=None, p0=None, rPe=None, rPd=None,
                 dd=None, mode='soft', k_soft=10, stable_idx=None, band=None, rule='hamilton', band_add=None):
    Pe = np.asarray(Pe, float); N, Lg = Pe.shape; w = np.asarray(w, float)
    if Pd is None: Pd, pd0 = Pe, np.asarray(p0, float)
    Pd = np.asarray(Pd, float); pd0 = np.asarray(pd0, float)
    G = 0 if rPe is None else len(rPe)
    if G:
        PeA = np.vstack([Pe, np.asarray(rPe, float)]); PdA = np.vstack([Pd, np.asarray(rPd, float)])
        PeA = np.where(np.isnan(PeA), PdA, PeA)
    else:
        PeA, PdA = Pe, Pd
    T = N + G
    n = choose_n(w, C, N, min_fill, rule) if n is None else np.asarray(n, int)
    chunk = w * C / n; M = int(n.sum())
    if callable(k_soft):
        try: k = int(k_soft(N, n))
        except TypeError: k = int(k_soft(N))
    else: k = int(k_soft)
    badd = np.zeros(T) if band_add is None else np.asarray(band_add, float)
    done = np.zeros(Lg, int); S = np.zeros(Lg); Q = np.zeros(Lg)
    last = pd0.copy(); entry = np.full(Lg, np.nan)
    fills, idle = [], {}; cooldown = None; max_cycle_spend = 0.0
    prot_cycles = np.zeros(Lg, int); band_cycles = 0
    prot_fills = []; r9_cycles = 0; r9_leg_cycles = 0                   # v3.2: what the soft window costs and what rule 9 did
    for t in range(T):
        usable = ~np.isnan(PdA[t])
        for i in range(Lg):
            if np.isnan(entry[i]) and usable[i]: entry[i] = PdA[t, i]
        v = np.where(usable & ~np.isnan(last), PdA[t] / np.where(np.isnan(last), 1, last) - 1, np.nan)
        prot = np.array([bool(dd is not None and usable[i] and PdA[t, i] <= entry[i] * (1 - dd)) for i in range(Lg)])
        prot_cycles += prot
        override = mode == 'soft' and t >= N - k                          # soft: protection stops blocking at the end
        sblock = stable_idx is not None and band is not None and usable[stable_idx] and abs(PdA[t, stable_idx] - 1) + badd[t] > band
        band_cycles += int(sblock)
        def why_not(i):
            if done[i] >= n[i]: return 'regra 6'
            if not usable[i]: return 'sem preço'
            if sblock and i == stable_idx: return 'banda'
            if prot[i] and not override: return 'regra 9'
            return None
        due_total = M if t >= N - 1 else min(M, math.ceil(M * (t + 1) / N - 1e-9))
        due = due_total - int(done.sum())
        el = [i for i in range(Lg) if why_not(i) is None]
        if due > 0:
            b9 = sum(1 for i in range(Lg) if why_not(i) == 'regra 9')
            r9_leg_cycles += b9; r9_cycles += int(b9 > 0)
        took = np.zeros(Lg, int); spend = 0.0; first = None
        if due > 0 and el:
            order = sorted(el, key=lambda i: (round(v[i], 12) if not np.isnan(v[i]) else 0.0, -(n[i] - done[i]) / n[i]))
            if cooldown in order and len(order) > 1: order.remove(cooldown); order.append(cooldown)
            picks = [order[0]]
            while len(picks) < due:
                cand = [i for i in el if took[i] + picks.count(i) < min(L, n[i] - done[i])]
                cand = [i for i in cand if (picks.count(i) + took[i]) < L]
                cand = [i for i in cand if done[i] + picks.count(i) < n[i]]
                if not cand: break
                picks.append(max(cand, key=lambda i: ((n[i] - done[i] - picks.count(i)) / n[i], -(v[i] if not np.isnan(v[i]) else 0.0))))
            for j, i in enumerate(picks):
                x = chunk[i] if done[i] < n[i] - 1 else w[i] * C - S[i]          # the last chunk takes the exact rest
                S[i] += x; Q[i] += x / PeA[t, i]; done[i] += 1; took[i] += 1; spend += x
                fills.append((t, i, x, 'select' if j == 0 else 'catchup'))
                if prot[i]: prot_fills.append((t, i, x, float(PdA[t, i] / entry[i] - 1)))
            first = picks[0]
        if took.sum() == 0:
            if due <= 0: idle[t] = 'calendário' if done.sum() < M else 'regra 6'
            else:
                rs = [why_not(i) for i in range(Lg) if done[i] < n[i]]
                idle[t] = 'regra 6' if not rs else next((r for r in ('sem preço', 'banda', 'regra 9') if r in rs), 'regra 5')
        cooldown = first
        max_cycle_spend = max(max_cycle_spend, spend)
        for i in range(Lg):
            if usable[i]: last[i] = PdA[t, i]
    r = DResult()
    r.n = n; r.chunk = chunk; r.done = done; r.spent = S; r.qty = Q; r.capital = C; r.weights = w; r.fills = fills
    r.pending_chunks = int((n - done).sum()); r.unbought_usd = float(C - S.sum())
    r.deviation_pp = float(np.max(np.abs(S / C - w)) * 100)
    r.max_fill_pct = 100 * float(max((f[2] for f in fills), default=0.0)) / C
    r.max_cycle_pct = 100 * max_cycle_spend / C
    r.n_fills = len(fills); r.extra_vs_N = M - N
    r.fills_in_grace = sum(1 for f in fills if f[0] >= N)
    r.idle = idle; r.idle_counts = {k: sum(1 for x in idle.values() if x == k) for k in ('calendário', 'regra 5', 'regra 6', 'regra 9', 'banda', 'sem preço')}
    r.prot_cycles = prot_cycles; r.band_cycles = band_cycles
    r.k_soft = k if mode == 'soft' else None
    r.prot_fills = prot_fills; r.n_prot_fills = len(prot_fills)               # chunks bought with the leg still protected
    r.prot_spent_pct = 100 * sum(f[2] for f in prot_fills) / C
    r.prot_mean_drop_pct = 100 * float(np.mean([f[3] for f in prot_fills])) if prot_fills else np.nan
    r.r9_block_cycles = r9_cycles; r.r9_block_leg_cycles = r9_leg_cycles      # cycles with purchases due where rule 9 took a leg out
    with np.errstate(divide='ignore', invalid='ignore'):
        r.avg_price = np.where(Q > 0, S / Q, np.nan)
    r.value_end = float((Q * PeA[N - 1]).sum() + (C - S.sum()))            # valued at the nominal last tick, as A+/B+
    return r
