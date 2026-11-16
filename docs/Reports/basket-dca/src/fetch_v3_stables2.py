"""T7 · the stablecoin universe (beyond the curated list): DefiLlama's stablecoin registry, its daily price
history for every USD-pegged coin, and the circulating-supply history of every coin that ever printed a daily
price below 0.97. Then, for each such coin not already fetched hour by hour, DefiLlama hourly prices around
its depeg windows. Raw responses are saved under data/series/v3/stables/raw so the run is reproducible offline."""
import os, sys, json, time, requests, numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fetch_v3
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ST = os.path.join(ROOT, 'data', 'series', 'v3', 'stables'); RAW = os.path.join(ST, 'raw'); os.makedirs(RAW, exist_ok=True)
SCREEN = 0.97          # a daily print below this marks a candidate
CURATED = {'usd-coin', 'tether', 'dai', 'binance-usd', 'true-usd', 'paxos-standard', 'frax', 'liquity-usd', 'gemini-dollar', 'usdd',
           'terrausd', 'ethena-usde', 'paypal-usd', 'first-digital-usd', 'nusd', 'magic-internet-money', 'crvusd', 'gho', 'usds',
           'dola-usd', 'usual-usd', 'ripple-usd'}

def get(url, tries=4):
    for k in range(tries):
        try:
            r = requests.get(url, timeout=60)
            if r.status_code == 200: return r.json()
        except Exception: pass
        time.sleep(2 + 3 * k)
    raise RuntimeError(url)

def run():
    lst = get('https://stablecoins.llama.fi/stablecoins?includePrices=true'); json.dump(lst, open(os.path.join(RAW, 'stablecoins.json'), 'w'))
    px = get('https://stablecoins.llama.fi/stablecoinprices'); json.dump(px, open(os.path.join(RAW, 'stablecoinprices.json'), 'w'))
    usd = {a['gecko_id']: a for a in lst['peggedAssets'] if a.get('pegType') == 'peggedUSD' and a.get('gecko_id')}
    rows = [(d['date'], g, p) for d in px if d['date'] > 0 for g, p in d['prices'].items() if g in usd and p is not None]
    daily = pd.DataFrame(rows, columns=['date', 'gecko_id', 'price']); daily.to_csv(os.path.join(ST, 'dl_daily_all_usd.csv'), index=False)
    cand = sorted(set(daily[daily.price < SCREEN].gecko_id) | (CURATED & set(usd)))
    circ = []
    for g in cand:
        a = usd[g]; d = get(f"https://stablecoins.llama.fi/stablecoin/{a['id']}")
        for t in d.get('tokens', []):
            c = t.get('circulating') or {}
            circ.append((t['date'], g, a['symbol'], float(c.get('peggedUSD', 0) or 0)))
        time.sleep(0.3)
    pd.DataFrame(circ, columns=['date', 'gecko_id', 'symbol', 'circulating_usd']).to_csv(os.path.join(ST, 'dl_circulating.csv'), index=False)
    print('candidates', len(cand), flush=True)
    return cand

def hourly_windows(min_circ=50e6):
    """Hourly DefiLlama around each candidate depeg (first print < 0.97 minus 3 days, to +45 days) for coins
    with >= min_circ circulating at the time, not in the curated hourly set."""
    daily = pd.read_csv(os.path.join(ST, 'dl_daily_all_usd.csv')); circ = pd.read_csv(os.path.join(ST, 'dl_circulating.csv'))
    out = []
    for g, d in daily[daily.price < SCREEN].groupby('gecko_id'):
        if g in CURATED: continue
        c = circ[circ.gecko_id == g].set_index('date').circulating_usd
        first = int(d.date.min())
        c_at = c[c.index <= first].iloc[-1] if (c.index <= first).any() else 0.0
        peak = c[c.index <= first].max() if (c.index <= first).any() else 0.0
        if max(c_at, peak) < min_circ: continue
        a = pd.Timestamp(first, unit='s') - pd.Timedelta(days=3); b = pd.Timestamp(first, unit='s') + pd.Timedelta(days=45)
        key = 'X_' + g
        fetch_v3.DL_IDS[key] = f'coingecko:{g}'; fetch_v3.DL_RANGES[key] = [(str(a.date()), str(b.date()))]
        fetch_v3.V3 = ST; out.append(fetch_v3.defillama_hourly(key))
    return out

if __name__ == '__main__':
    run(); print(hourly_windows(), flush=True)
