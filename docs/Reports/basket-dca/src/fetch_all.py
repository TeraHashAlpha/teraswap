"""Fetch every price series used by the report (re-runnable; raw rounds are cached).

Chainlink: each series is sampled at 00:00 UTC (daily) or on the hour (hourly) and the value is
the answer of the last round with updatedAt <= T, i.e. what latestRoundData() returned at T.
Off-chain: DefiLlama coins.llama.fi/chart (the keeper's DefiLlama leg, historically) and the
Coinbase Exchange public candles API (largest USD venue for AERO/ETH/XRP).
"""
import os, sys, json, time, datetime as dt
from concurrent.futures import ThreadPoolExecutor
import pandas as pd, requests
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fetch_chainlink as fc, feeds_config
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SER = os.path.join(ROOT, 'data', 'series'); os.makedirs(SER, exist_ok=True)
END = '2026-11-07'   # last tick read = 00:00 UTC 7 Nov 2026 (= close of 6 Nov)
DAILY = {   # feed -> list of (start, end) daily ranges actually needed (fetched in this order)
    'ETH': [('2021-12-01', END)], 'cbBTC': [('2024-09-14', END)],
    'USDC': [('2021-12-01', END)], 'WBTC': [('2022-11-26', END)], 'USDT': [('2021-12-01', END)],
    'WBTC_BTC_mainnet': [('2021-12-01', '2022-12-31')], 'BTC_mainnet': [('2021-12-01', '2022-12-31')],
    'SOL': [('2022-02-16', END)], 'SOL_mainnet': [('2021-12-01', '2022-03-31')],
    'CRV': [('2022-02-16', END)], 'CRV_mainnet': [('2021-12-01', '2022-03-31')],
    'XRP': [('2022-08-26', END)],
    'DAI': [('2022-12-01', '2023-06-30')],
    'AERO': [('2026-05-01', END)], 'ETH_base': [('2026-05-01', END)],
    'UST_ETH': [('2022-03-01', '2022-08-31')], 'ETH_mainnet': [('2022-03-01', '2022-08-31')],
}
HOURLY = {
    'USDC': [('2023-03-01', '2023-03-25')], 'DAI': [('2023-03-01', '2023-03-25')],
    'USDT': [('2022-05-01', '2022-05-25')],
    'AERO': [('2026-07-01', END)], 'ETH_base': [('2026-07-01', END)],
}
UA = {'User-Agent': 'teraswap-basket-dca-research/1.0'}
def utc(ts): return dt.datetime.fromtimestamp(ts, dt.timezone.utc)

def _sample_feed(k, f):
    feed = fc.Feed(k, f); out = {'daily': [], 'hourly': []}
    for a, b in DAILY.get(k, []):
        g = fc.daily_grid(a, b); t0 = time.time(); r = feed.sample(g)
        out['daily'] += [(utc(T).date().isoformat(), p, (T - u) if u else None) for T, (p, u) in zip(g, r)]
        print(f'{k} daily {a}..{b}: {len(g)} ticks, {round(time.time() - t0)} s', flush=True)
    for a, b in HOURLY.get(k, []):
        g = fc.hourly_grid(a, b + 'T00:00:00'); t0 = time.time(); r = feed.sample(g)
        out['hourly'] += [(utc(T).isoformat(), p, (T - u) if u else None) for T, (p, u) in zip(g, r)]
        print(f'{k} hourly {a}..{b}: {len(g)} ticks, {round(time.time() - t0)} s', flush=True)
    pd.DataFrame(out['daily'], columns=['date', 'price', 'age_s']).to_csv(os.path.join(SER, f'cl_daily_{k}.csv'), index=False)
    if out['hourly']:
        pd.DataFrame(out['hourly'], columns=['utc', 'price', 'age_s']).to_csv(os.path.join(SER, f'cl_hourly_{k}.csv'), index=False)
    return k, out

def chainlink_all(only=None):
    feeds = feeds_config.build()
    ver = [fc.verify_feed(k, f) for k, f in feeds.items()]
    pd.DataFrame(ver).to_csv(os.path.join(SER, 'feed_verification.csv'), index=False)
    bad = [v for v in ver if not v['descriptionMatches']]
    if bad: raise SystemExit(f'ADR-018: feed identity mismatch: {bad}')
    keys = [k for k in DAILY if (only is None or k in only)]
    by_net = {}
    for k in keys: by_net.setdefault(feeds[k]['network'], []).append(k)
    def run_net(net):
        return [_sample_feed(k, feeds[k]) for k in by_net[net]]
    with ThreadPoolExecutor(len(by_net)) as ex:
        res = [x for r in ex.map(run_net, list(by_net)) for x in r]

def defillama(coin, start, end, period):
    s = int(dt.datetime.fromisoformat(start).replace(tzinfo=dt.timezone.utc).timestamp())
    e = int(dt.datetime.fromisoformat(end).replace(tzinfo=dt.timezone.utc).timestamp())
    step = 86400 if period == '1d' else 3600
    rows = []; cur = s
    while cur <= e:
        span = min(400, (e - cur) // step + 1)
        r = requests.get(f'https://coins.llama.fi/chart/{coin}', params={'start': cur, 'span': span, 'period': period, 'searchWidth': '600'}, headers=UA, timeout=60)
        r.raise_for_status()
        rows += [(p['timestamp'], p['price'], p.get('confidence')) for p in r.json()['coins'].get(coin, {}).get('prices', [])]
        cur += span * step; time.sleep(0.3)
    df = pd.DataFrame(rows, columns=['ts', 'price', 'confidence']).drop_duplicates('ts').sort_values('ts')
    df['utc'] = [utc(t).isoformat() for t in df.ts]
    return df

def coinbase(product, start, end, gran):
    s = dt.datetime.fromisoformat(start).replace(tzinfo=dt.timezone.utc)
    e = dt.datetime.fromisoformat(end).replace(tzinfo=dt.timezone.utc)
    rows = []; cur = s
    while cur < e:
        nxt = min(e, cur + dt.timedelta(seconds=gran * 300))
        r = requests.get(f'https://api.exchange.coinbase.com/products/{product}/candles',
                         params={'granularity': gran, 'start': cur.isoformat(), 'end': nxt.isoformat()}, headers=UA, timeout=60)
        r.raise_for_status(); rows += r.json(); cur = nxt; time.sleep(0.35)
    df = pd.DataFrame(rows, columns=['ts', 'low', 'high', 'open', 'close', 'volume']).drop_duplicates('ts').sort_values('ts')
    df['utc'] = [utc(t).isoformat() for t in df.ts]
    return df

def bitstamp(pair, start, end):
    s = int(dt.datetime.fromisoformat(start).replace(tzinfo=dt.timezone.utc).timestamp())
    e = int(dt.datetime.fromisoformat(end).replace(tzinfo=dt.timezone.utc).timestamp())
    r = requests.get(f'https://www.bitstamp.net/api/v2/ohlc/{pair}/', params={'step': 86400, 'limit': 1000, 'start': s}, headers=UA, timeout=60)
    r.raise_for_status()
    rows = [(int(x['timestamp']), float(x['open']), float(x['close'])) for x in r.json()['data']['ohlc'] if int(x['timestamp']) <= e]
    df = pd.DataFrame(rows, columns=['ts', 'open', 'close']); df['utc'] = [utc(t).isoformat() for t in df.ts]
    return df

def offchain_all():
    cat = json.load(open(os.path.join(ROOT, '_inputs', 'token-catalog.8453.json')))['tokens']
    addr = {t['symbol']: t['address'] for t in cat if t['symbol'] in ('AERO', 'WETH')}
    a = '2026-05-01'
    for key, coin, prod in [('AERO', f"base:{addr['AERO']}", 'AERO-USD'), ('ETH', f"base:{addr['WETH']}", 'ETH-USD')]:
        defillama(coin, a, END, '1d').to_csv(os.path.join(SER, f'defillama_{key}_daily.csv'), index=False)
        defillama(coin, '2026-07-01', END, '1h').to_csv(os.path.join(SER, f'defillama_{key}_hourly.csv'), index=False)
        coinbase(prod, a, END, 86400).to_csv(os.path.join(SER, f'coinbase_{key}_daily.csv'), index=False)
        coinbase(prod, '2026-07-01', END, 3600).to_csv(os.path.join(SER, f'coinbase_{key}_hourly.csv'), index=False)
    # XRP before the Arbitrum feed existed (2022-08-25): exchange daily candles, declared as such.
    # Coinbase had XRP suspended Jan 2021 - Jul 2023 (returns no candles), so Bitstamp XRP/USD is used.
    bitstamp('xrpusd', '2021-11-30', '2022-09-30').to_csv(os.path.join(SER, 'bitstamp_XRP_daily.csv'), index=False)

if __name__ == '__main__':
    t = time.time()
    only = [a for a in sys.argv[1:] if a not in ('offchain', 'chainlink')] or None
    if 'offchain' not in sys.argv: chainlink_all(only)
    if 'chainlink' not in sys.argv: offchain_all()
    print('done', round(time.time() - t, 1), 's')
