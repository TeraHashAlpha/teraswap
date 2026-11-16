"""Hourly exchange candles, Nov 2021 - Nov 2026, used ONLY to find the hours with an abrupt move
(> 15% in one hour) in ETH, BTC or a stablecoin. Two venues per asset where both exist."""
import os, sys, time, datetime as dt, requests, pandas as pd
from concurrent.futures import ThreadPoolExecutor
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'data', 'series', 'hourly_exchange'); os.makedirs(OUT, exist_ok=True)
UA = {'User-Agent': 'teraswap-basket-dca-research/1.0'}
START, END = '2021-11-07', '2026-11-07'

def coinbase(product):
    s = dt.datetime.fromisoformat(START).replace(tzinfo=dt.timezone.utc); e = dt.datetime.fromisoformat(END).replace(tzinfo=dt.timezone.utc)
    rows = []; cur = s
    while cur < e:
        nxt = min(e, cur + dt.timedelta(hours=300))
        for att in range(5):
            try:
                r = requests.get(f'https://api.exchange.coinbase.com/products/{product}/candles',
                                 params={'granularity': 3600, 'start': cur.isoformat(), 'end': nxt.isoformat()}, headers=UA, timeout=30)
                if r.status_code == 429: time.sleep(2 + att); continue
                r.raise_for_status(); rows += r.json(); break
            except Exception: time.sleep(2 + att)
        cur = nxt; time.sleep(0.25)
    df = pd.DataFrame(rows, columns=['ts', 'low', 'high', 'open', 'close', 'volume']).drop_duplicates('ts').sort_values('ts')
    return df[['ts', 'open', 'high', 'low', 'close', 'volume']]

def bitstamp(pair):
    s = int(dt.datetime.fromisoformat(START).replace(tzinfo=dt.timezone.utc).timestamp())
    e = int(dt.datetime.fromisoformat(END).replace(tzinfo=dt.timezone.utc).timestamp())
    rows = []; cur = s
    while cur < e:
        for att in range(5):
            try:
                r = requests.get(f'https://www.bitstamp.net/api/v2/ohlc/{pair}/', params={'step': 3600, 'limit': 1000, 'start': cur}, headers=UA, timeout=30)
                r.raise_for_status(); data = r.json()['data']['ohlc']; break
            except Exception: time.sleep(2 + att); data = []
        rows += [(int(x['timestamp']), float(x['open']), float(x['high']), float(x['low']), float(x['close']), float(x['volume'])) for x in data]
        cur += 1000 * 3600; time.sleep(0.3)
    df = pd.DataFrame(rows, columns=['ts', 'open', 'high', 'low', 'close', 'volume']).drop_duplicates('ts').sort_values('ts')
    return df[df.ts < e]

JOBS = [('coinbase', 'ETH-USD'), ('coinbase', 'BTC-USD'), ('coinbase', 'USDT-USD'), ('coinbase', 'DAI-USD'),
        ('bitstamp', 'ethusd'), ('bitstamp', 'btcusd'), ('bitstamp', 'usdcusd'), ('bitstamp', 'usdtusd')]

def run(job):
    venue, sym = job; t0 = time.time()
    df = coinbase(sym) if venue == 'coinbase' else bitstamp(sym)
    df.to_csv(os.path.join(OUT, f'{venue}_{sym}.csv'), index=False)
    return f'{venue} {sym}: {len(df)} candles, {round(time.time() - t0)} s'

if __name__ == '__main__':
    with ThreadPoolExecutor(8) as ex:
        for msg in ex.map(run, JOBS): print(msg, flush=True)
