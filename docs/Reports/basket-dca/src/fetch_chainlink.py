"""Sample Chainlink price feeds (proxy round data) at fixed UTC timestamps.

For each target timestamp T the value returned is the answer of the LAST round
with updatedAt <= T — i.e. exactly what latestRoundData() would have returned
to a keeper reading the proxy at time T. No archive node is needed: rounds are
read with proxy.getRoundData((phaseId << 64) | aggregatorRoundId) from current
state (aggregators keep every round).
"""
import os, sys, json, time, datetime as dt
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rpc
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, 'data', 'raw', 'chainlink_round_cache')
os.makedirs(CACHE, exist_ok=True)

# 4-byte selectors = keccak256(signature)[:4], recomputed when this file was written
SEL = {'phaseId': '0x58303b10', 'phaseAggregators': '0xc1597304', 'latestRound': '0x668a0f02',
       'getRoundData': '0x9a6fc8f5', 'description': '0x7284e416', 'decimals': '0x313ce567'}

def _u(x): return int(x, 16)
def _word(h, i): return h[2 + 64 * i: 2 + 64 * (i + 1)]
def _int256(w):
    v = int(w, 16); return v - (1 << 256) if v >= (1 << 255) else v
def _str(h):
    b = bytes.fromhex(h[2:]); off = int.from_bytes(b[0:32], 'big'); ln = int.from_bytes(b[off:off + 32], 'big')
    return b[off + 32: off + 32 + ln].decode()

def verify_feed(key, f):
    d, dec = rpc.batch_call(f['network'], [(f['proxy'], SEL['description']), (f['proxy'], SEL['decimals'])])
    desc = _str(d); decimals = _u(dec)
    ok = desc.strip().lower() == f['expectedDescription'].strip().lower()
    return {'key': key, 'proxy': f['proxy'], 'network': f['network'], 'description': desc,
            'decimals': decimals, 'descriptionMatches': ok}

class Feed:
    def __init__(self, key, f):
        self.key, self.net, self.proxy = key, f['network'], f['proxy']
        self.cache_path = os.path.join(CACHE, f'{key}.json')
        self.cache = {}
        if os.path.exists(self.cache_path):
            self.cache = {int(k): tuple(v) if v else None for k, v in json.load(open(self.cache_path)).items()}
        cur = _u(rpc.batch_call(self.net, [(self.proxy, SEL['phaseId'])])[0])
        calls = [(self.proxy, SEL['phaseAggregators'] + format(p, '064x')) for p in range(1, cur + 1)]
        aggs = ['0x' + _word(h, 0)[24:] for h in rpc.batch_call(self.net, calls)]
        self.phases = []  # (phaseId, nRounds)
        for p, a in zip(range(1, cur + 1), aggs):
            if int(a, 16) == 0: continue
            lr = rpc.batch_call(self.net, [(a, SEL['latestRound'])])[0]
            n = _u(lr) if (lr and lr != '0x') else 0
            if n > 0: self.phases.append((p, n))
        self.offsets = []; tot = 0
        for p, n in self.phases:
            self.offsets.append(tot); tot += n
        self.total = tot
        self.decimals = _u(rpc.batch_call(self.net, [(self.proxy, SEL['decimals'])])[0])

    def _gid_to_round(self, g):
        for (p, n), off in zip(self.phases, self.offsets):
            if g < off + n: return (p << 64) | (g - off + 1)
        raise IndexError(g)

    def rounds(self, gids):
        need = [g for g in set(gids) if g not in self.cache]
        if need:
            calls = [(self.proxy, SEL['getRoundData'] + format(self._gid_to_round(g), '064x')) for g in need]
            res = rpc.batch_call(self.net, calls)
            for g, h in zip(need, res):
                if not h or len(h) < 2 + 64 * 5:
                    self.cache[g] = None
                else:
                    ans = _int256(_word(h, 1)); upd = _u(_word(h, 3))
                    self.cache[g] = (ans, upd) if upd > 0 else None
        return [self.cache[g] for g in gids]

    def save(self):
        json.dump({str(k): v for k, v in self.cache.items()}, open(self.cache_path, 'w'))

    def _upd(self, g):
        r = self.cache.get(g)
        return r[1] if r else None

    def _solve(self, timestamps, lo, hi):
        """Find, for each T, the max gid in [lo, hi] with updatedAt <= T (lo is assumed <= T).
        Interpolation guess m plus its neighbour m+1 each pass (an exact hit closes the bracket);
        plain bisection every 4th pass as a safeguard."""
        n = len(timestamps)
        self.rounds(sorted(set(lo) | set(hi)))
        ulo = [self._upd(g) or 0 for g in lo]
        uhi = []
        for i, g in enumerate(hi):
            u = self._upd(g)
            if u is not None and u <= timestamps[i]: lo[i] = g; ulo[i] = u   # hi itself qualifies
            uhi.append(u if u is not None else 2**62)
        active = [i for i in range(n) if lo[i] < hi[i]]
        it = 0
        while active:
            it += 1; probes = {}
            for i in active:
                T = timestamps[i]; span = hi[i] - lo[i]
                if it % 4 == 0 or uhi[i] <= ulo[i]:
                    m = (lo[i] + hi[i] + 1) // 2
                else:
                    m = lo[i] + int((T - ulo[i]) / (uhi[i] - ulo[i]) * span)
                m = min(max(m, lo[i] + 1), hi[i])
                probes[i] = [m] if m == hi[i] else [m, m + 1]
            self.rounds(sorted({g for v in probes.values() for g in v}))
            nxt = []
            for i in active:
                T = timestamps[i]
                for g in probes[i]:
                    if g <= lo[i] or g > hi[i]: continue
                    u = self._upd(g)
                    if u is not None and u <= T: lo[i] = g; ulo[i] = u
                    else:
                        hi[i] = g - 1; uhi[i] = u if u is not None else uhi[i]
                        break
                if lo[i] < hi[i]: nxt.append(i)
            active = nxt
            if it % 2 == 0: self.save()
            if os.environ.get('CL_DEBUG'): print(self.key, 'pass', it, 'active', len(active), 'cache', len(self.cache), flush=True)
        return lo

    def sample(self, timestamps):
        """Value of latestRoundData() at each T (sorted). Coarse pass on every 8th target, then the
        rest inside the brackets the coarse pass found. Returns [(price, updatedAt) | (None, None)]."""
        n = len(timestamps)
        self.rounds([0, self.total - 1])
        first = self._upd(0) or 0
        res = [None] * n
        idx_coarse = sorted(set(list(range(0, n, 8)) + [n - 1]))
        valid = [i for i in idx_coarse if timestamps[i] >= first]
        g = self._solve([timestamps[i] for i in valid], [0] * len(valid), [self.total - 1] * len(valid))
        for i, gi in zip(valid, g): res[i] = gi
        self.save()
        known = sorted(i for i in range(n) if res[i] is not None)
        rest = [i for i in range(n) if res[i] is None and timestamps[i] >= first]
        if rest:
            import bisect
            los, his = [], []
            for i in rest:
                k = bisect.bisect_left(known, i)
                los.append(res[known[k - 1]] if k > 0 else 0)
                his.append(res[known[k]] if k < len(known) else self.total - 1)
            g = self._solve([timestamps[i] for i in rest], los, his)
            for i, gi in zip(rest, g): res[i] = gi
        out = []
        self.rounds([r for r in res if r is not None])
        for i, T in enumerate(timestamps):
            r = self.cache.get(res[i]) if res[i] is not None else None
            out.append((r[0] / 10 ** self.decimals, r[1]) if (r and r[1] <= T) else (None, None))
        self.save()
        return out

def daily_grid(start, end):
    d = dt.datetime.fromisoformat(start).replace(tzinfo=dt.timezone.utc)
    e = dt.datetime.fromisoformat(end).replace(tzinfo=dt.timezone.utc)
    out = []
    while d <= e:
        out.append(int(d.timestamp())); d += dt.timedelta(days=1)
    return out

def hourly_grid(start, end):
    d = dt.datetime.fromisoformat(start).replace(tzinfo=dt.timezone.utc)
    e = dt.datetime.fromisoformat(end).replace(tzinfo=dt.timezone.utc)
    out = []
    while d <= e:
        out.append(int(d.timestamp())); d += dt.timedelta(hours=1)
    return out
