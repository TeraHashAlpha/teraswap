"""A+ — the v2 Basket (rules 1-9, rule 3 corrected) with four independent switches (Architect, v3):

  P  single price   : rule 4 / rule 9 / peg band decide with the ADR-024 resolved price per leg
                      (Chainlink if its round is <= 600 s old at the tick, else DefiLlama). A leg with no
                      usable price is out of that cycle (not compared, not bought). No leg usable -> cycle skipped.
  M  minimum fill   : no fill below min_fill USD. A purchase that would be smaller waits and joins the next
                      purchase (pooled into the next cycle's budget); a leg whose remaining gap is below
                      min_fill is parked until the last cycle, which is exempt (buys anything >= 0.01 USD).
  E  staged catch-up: soft mode only. Capital deferred by skipped cycles is bought over the last k cycles
                      (an equal tranche of what remains deferred each cycle, split by remaining gap) instead of
                      all in the last one. cap = ceiling per fill as a fraction of capital; whatever the cap
                      stops on the last cycle stays uninvested and is reported.
  final_retry      : the last cycle does not give up on a leg for lack of a usable price.
                      With retry_Pe/retry_Pd (owner's rule, 7 Nov 2026): it waits up to len(retry_Pd) further cycles
                      (3) for a usable price and buys there, at that cycle's feed price; if none comes, the order
                      closes with that leg unbought, the money stays with the user and the reason is reported
                      (res.unbought). Without the arrays (older runs): it waits and executes at the last tick's price.
  B  peg band       : stable leg ineligible while |price - 1| > band, judged at the tick, also on the last
                      cycle and in soft mode.

select=False gives B+: the fixed 3-leg DCA (every cycle buys w_i * b of each eligible leg; no rules 4, 5, 6)
with the same rule 9, E, M, B and P.

k=1, cap=None, min_fill=None, P off, B off reproduces engine.run_basket exactly (tested).
Fills are executed and valued at the Chainlink feed price (as in v2); P changes only decisions.
"""
import numpy as np
from engine import Result

EPS = 1e-9

def run_plus(Pe, w, C=1000.0, *, Pd=None, pd0=None, p0=None, select=True,
             dd=None, mode='soft', k=1, cap=None, min_fill=None, final_min=None,
             stable_idx=None, band=None, signal='tick', final_retry=False, retry_Pe=None, retry_Pd=None):
    Pe = np.asarray(Pe, float); N, L = Pe.shape; w = np.asarray(w, float)
    if Pd is None: Pd, pd0 = Pe, np.asarray(p0, float)
    Pd = np.asarray(Pd, float); pd0 = np.asarray(pd0, float)
    b = C / N; T = w * C; S = np.zeros(L); Q = np.zeros(L); cash = C
    mf = min_fill or 0.0; capu = cap * C if cap else np.inf
    if final_min is None: final_min = 0.01 if min_fill else EPS
    fills, cand, vpath, apath = [], [], [], []
    lock_tick = [None] * L; lock_final = [False] * L; retry_legs = 0
    window = final_retry and retry_Pd is not None
    if window: retry_Pe = np.asarray(retry_Pe, float); retry_Pd = np.asarray(retry_Pd, float)
    exec_px = {}; waited = {}; unbought = {}
    cooldown = None; carry = 0.0; pend = np.zeros(L)          # carry: A+ pooled (M); pend: B+ per leg (M)
    last = np.where(np.isnan(pd0), np.nan, pd0)                 # last usable decision price per leg
    entry = np.array([np.nan] * L); protect_ticks = {i: 0 for i in range(L)}; protect_events = {i: 0 for i in range(L)}
    wasp = [False] * L; unusable = np.zeros(L, int); skipped_all = 0; band_ticks = 0
    prot_marks, cd_marks, lock_events = [], [], []

    def gap(i): return max(0.0, T[i] - S[i])
    def locked(i): return S[i] >= T[i] - EPS

    for t in range(N):
        r = N - t; final = (r == 1)
        usable = ~np.isnan(Pd[t])
        unusable += (~usable).astype(int)
        for i in range(L):
            if np.isnan(entry[i]) and usable[i]: entry[i] = Pd[t, i]
        v = np.where(usable & ~np.isnan(last), Pd[t] / np.where(np.isnan(last), 1, last) - 1, np.nan)
        prot = [False] * L
        if dd is not None:
            for i in range(L):
                prot[i] = bool(usable[i] and Pd[t, i] <= entry[i] * (1 - dd))
                if prot[i]:
                    protect_ticks[i] += 1; prot_marks.append((t, i))
                    if not wasp[i]: protect_events[i] += 1
                wasp[i] = prot[i]
        sblock = stable_idx is not None and band is not None and usable[stable_idx] and abs(Pd[t, stable_idx] - 1) > band
        if final and final_retry and not window and stable_idx is not None and band is not None and not usable[stable_idx]:
            sblock = abs(Pe[t, stable_idx] - 1) > band          # the retried price is judged by the same band
        band_ticks += int(sblock)
        def blocked(i, liquidation=False):
            if not usable[i] and not (final and final_retry and not window): return True   # legacy: waits, executes here
            if sblock and i == stable_idx: return True
            if prot[i] and (mode == 'rigid' or not liquidation): return True
            return False
        want = np.zeros(L); kinds = {}
        if not usable.any(): skipped_all += 1

        if final:
            retry_legs = sum(1 for i in range(L) if not usable[i] and not locked(i))
            for i in range(L):
                if locked(i): continue
                if window and not usable[i]:                 # owner's rule: up to len(retry_Pd) more cycles
                    hit = None
                    for kk in range(len(retry_Pd)):
                        q = retry_Pd[kk, i]
                        if q == q: hit = kk; break
                    if hit is None: unbought[i] = ('sem preço utilizável no último ciclo nem nos seguintes', gap(i)); continue
                    if stable_idx is not None and band is not None and i == stable_idx and abs(retry_Pd[hit, i] - 1) > band:
                        unbought[i] = ('stable fora da banda quando o preço voltou', gap(i)); continue
                    want[i] = gap(i); kinds[i] = 'final-retry'; exec_px[i] = retry_Pe[hit, i]; waited[i] = hit + 1
                    continue
                if not blocked(i, liquidation=True):
                    want[i] = gap(i); kinds[i] = 'final'
        else:
            # ---- normal cycle
            if select:
                budget = b + carry; carry = 0.0
                el = [i for i in range(L) if not locked(i) and not blocked(i) and gap(i) >= mf - EPS]
                if cooldown in el and len(el) > 1: el.remove(cooldown); cd_marks.append((t, cooldown))
                if signal == 'rotacao':
                    el.sort(key=lambda i: ((i - t) % L, -(gap(i) / T[i])))
                else:
                    el.sort(key=lambda i: (round(v[i], 12) if not np.isnan(v[i]) else 0.0, -(gap(i) / T[i])))
                prim = None; held = False
                for i in el:
                    if budget <= EPS: break
                    x = min(budget, gap(i), capu)
                    if x < mf - EPS: held = True; break     # too small: waits for the next cycle (M)
                    if x < min(budget, gap(i)) - EPS: held = True   # cut by the cap
                    want[i] += x; budget -= x; kinds.setdefault(i, 'select' if prim is None else 'roll')
                    if prim is None: prim = i
                cooldown = prim
                if held and budget > EPS: carry = budget        # held back by M or the cap: pooled into the next cycle
                # a budget with no eligible leg at all is deferred (waits in cash, as in v2)
            else:
                for i in range(L):
                    if locked(i): continue
                    if blocked(i): continue                     # its share is deferred, as in A
                    due = w[i] * b + pend[i]
                    x = min(due, gap(i), capu)
                    if x >= mf - EPS and x > EPS:
                        want[i] += x; kinds[i] = 'fixed'; pend[i] = due - x
                    else:
                        pend[i] = due
            # ---- staged catch-up of deferred capital (E), soft mode, last k cycles
            if mode == 'soft' and r <= k:
                committed = want.sum()
                waiting_small = carry if select else pend.sum()
                deferred = cash - committed - b * (r - 1) - waiting_small
                if deferred > EPS:
                    tranche = deferred / r
                    legs = [i for i in range(L) if not locked(i) and not blocked(i, liquidation=True)]
                    rem = {i: max(0.0, gap(i) - want[i]) for i in legs}
                    tot = sum(rem.values())
                    for i in legs:
                        if tot <= EPS: break
                        x = min(tranche * rem[i] / tot, capu - want[i], rem[i])
                        if x >= mf - EPS and x > EPS: want[i] += x; kinds[i] = kinds.get(i, 'catchup')
        # ---- execute (one fill per leg per tick, capped)
        for i in range(L):
            x = min(want[i], capu, cash)
            thr = final_min if final else mf
            if x <= EPS or x < thr - EPS: continue
            S[i] += x; Q[i] += x / exec_px.get(i, Pe[t, i]); cash -= x
            fills.append((t, i, x, kinds.get(i, 'select'))); cand.append(1)
            if lock_tick[i] is None and locked(i):
                lock_tick[i] = t; lock_final[i] = final; lock_events.append((t, i))
        for i in range(L):
            if usable[i]: last[i] = Pd[t, i]
        vpath.append(float((Q * Pe[t]).sum() + cash)); apath.append(S / C)

    res = Result('A+' if select else 'B+', S, Q, cash, C, w, fills, lock_tick, lock_final, np.array(vpath),
                 protect_events, protect_ticks, band_ticks, cd_marks, lock_events, prot_marks, np.array(apath))
    res.cand = cand; res.unusable = unusable; res.skipped_all = skipped_all; res.final_unusable_legs = retry_legs
    res.retry_waited = waited; res.unbought = {i: (why, float(usd)) for i, (why, usd) in unbought.items()}
    res.unbought_usd = float(sum(u for _, u in res.unbought.values()))
    res.max_fill_pct = 100 * max((f[2] for f in fills), default=0) / C
    res.primary = {f[0]: f[1] for f in fills if f[3] == 'select'}
    pm = set(prot_marks); allp = [all((t, i) in pm for i in range(L)) for t in range(N)]
    res.all_protected_ticks = int(sum(allp)); run_ = best = 0
    for a in allp:
        run_ = run_ + 1 if a else 0; best = max(best, run_)
    res.all_protected_maxrun = best
    res.prot_marks = prot_marks
    return res
