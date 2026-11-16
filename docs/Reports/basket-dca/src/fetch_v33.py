"""v3.3 · tokenized stocks (Coinbase, Base) as Split DCA legs: data.

- The Coinbase official token list (api.coinbase.com/v1/tokenized-stocks, every page).
- Chainlink directories for Base and Arbitrum, saved fresh under data/raw/v33/ (the v3.1/v3.2 copies stay untouched).
- Every round of the 13 «Coinbase X» total-return feeds on Base (24/5) and of the per-share NYSE equity feeds on
  Arbitrum (long history, raw price: they show weekends, holidays and splits as they happened).
- DefiLlama hourly prices of the Coinbase tokens that have a feed (the ADR-024 quorum price and the DEX price).
Feed addresses come from the directories, token addresses from the Coinbase list; each feed is checked on-chain with
description()/decimals(). Nothing is typed by hand."""
import os, sys, json, time, requests, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fetch_chainlink as fc
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
V33 = os.path.join(ROOT, 'data', 'series', 'v33'); RAW = os.path.join(ROOT, 'data', 'raw', 'v33')
for d in (V33, RAW): os.makedirs(d, exist_ok=True)
UA = {'User-Agent': 'teraswap-basket-dca-research/1.0'}
DIRS = {'base': 'feeds-ethereum-mainnet-base-1.json', 'arbitrum': 'feeds-ethereum-mainnet-arbitrum-1.json'}
ARB_EQ = ('NVDA', 'AAPL', 'MSFT', 'AMZN', 'GOOGL', 'META', 'TSLA', 'COIN', 'SPY')

def directories():
    for net, fn in DIRS.items():
        r = requests.get(f'https://reference-data-directory.vercel.app/{fn}', headers=UA, timeout=60); r.raise_for_status()
        open(os.path.join(RAW, fn), 'w').write(r.text)

def coinbase_list():
    toks, tok = [], None
    while True:
        r = requests.get('https://api.coinbase.com/v1/tokenized-stocks', params={'page_token': tok} if tok else {}, headers=UA, timeout=60)
        r.raise_for_status(); j = r.json(); toks += j['tokens']; tok = j.get('next_page_token')
        if not tok: break
    out = [{k: t.get(k) for k in ('symbol', 'name', 'contract_address', 'decimals', 'isin', 'multiplier')} for t in toks]
    json.dump(dict(read_at_utc=pd.Timestamp.utcnow().strftime('%Y-%m-%d %H:%M'), tokens=out), open(os.path.join(V33, 'coinbase_tokenized_stocks.json'), 'w'), indent=1)
    return out

def feed_configs():
    base = json.load(open(os.path.join(RAW, DIRS['base']))); arb = json.load(open(os.path.join(RAW, DIRS['arbitrum'])))
    cfg = {}
    for f in base:
        dc = f.get('docs') or {}
        if f.get('path', '').startswith('cb') and dc.get('marketHours') == 'us_equities_24/5' and not dc.get('hidden'):
            sym = f['path'][2:].split('-')[0].upper()
            cfg[f'cb_{sym}'] = dict(network='base', proxy=f['proxyAddress'], expectedDescription=f['name'], threshold=f.get('threshold'),
                                    heartbeat=f.get('heartbeat'), category=f.get('feedCategory'), path=f['path'], symbol=sym)
    for f in arb:
        sym = f.get('name', '').split(' / ')[0]
        if sym in ARB_EQ and f.get('path') == f'{sym.lower()}-usd' and f.get('proxyAddress'):
            cfg[f'arb_{sym}'] = dict(network='arbitrum', proxy=f['proxyAddress'], expectedDescription=f['name'], threshold=f.get('threshold'),
                                     heartbeat=f.get('heartbeat'), category=f.get('feedCategory'), path=f['path'], symbol=sym,
                                     hours=(f.get('docs') or {}).get('marketHours'))
    json.dump(cfg, open(os.path.join(V33, 'feeds_v33.json'), 'w'), indent=1)
    return cfg

def rounds(keys=None):
    cfg = json.load(open(os.path.join(V33, 'feeds_v33.json'))); ver = []
    for key, c in cfg.items():
        if keys and key not in keys: continue
        v = fc.verify_feed(key, dict(c)); ver.append(v)
        assert v['descriptionMatches'], v
        f = fc.Feed('V33_' + key, c); gids = list(range(f.total))
        for i in range(0, len(gids), 500):
            for att in range(5):
                try: f.rounds(gids[i:i + 500]); break
                except Exception: time.sleep(3 + att)
            if (i // 500) % 10 == 0: f.save()
        f.save()
        rows = [(g, f.cache[g][0] / 10 ** f.decimals, f.cache[g][1]) for g in gids if f.cache.get(g)]
        pd.DataFrame(rows, columns=['gid', 'price', 'updatedAt']).sort_values('updatedAt').to_csv(os.path.join(V33, f'rounds_{key}.csv'), index=False)
        print(key, len(rows), flush=True)
    if ver: pd.DataFrame(ver).to_csv(os.path.join(V33, 'feed_verification_v33.csv'), index=False)

def defillama_hourly(start='2026-08-20', end='2026-11-16'):
    cfg = json.load(open(os.path.join(V33, 'feeds_v33.json')))
    toks = {t['symbol']: t['contract_address'] for t in json.load(open(os.path.join(V33, 'coinbase_tokenized_stocks.json')))['tokens']}
    for key, c in cfg.items():
        if not key.startswith('cb_'): continue
        sym = c['symbol'] + 'c'
        if sym not in toks: print('no token for', sym); continue
        coin = f'base:{toks[sym]}'; rows = []
        s = int(pd.Timestamp(start, tz='UTC').timestamp()); e = int(pd.Timestamp(end, tz='UTC').timestamp()); cur = s
        while cur <= e:
            span = min(400, (e - cur) // 3600 + 1)
            for att in range(5):
                try:
                    r = requests.get(f'https://coins.llama.fi/chart/{coin}', params={'start': cur, 'span': span, 'period': '1h', 'searchWidth': '1200'}, headers=UA, timeout=60)
                    r.raise_for_status(); pts = r.json()['coins'].get(coin, {}).get('prices', []); break
                except Exception: time.sleep(2 + att); pts = []
            rows += [(p['timestamp'], p['price']) for p in pts]; cur += span * 3600; time.sleep(0.2)
        pd.DataFrame(rows, columns=['ts', 'price']).drop_duplicates('ts').sort_values('ts').to_csv(os.path.join(V33, f'defillama_{sym}_hourly.csv'), index=False)
        print(sym, len(rows), flush=True)

CRYPTO = {'ETH': 'coingecko:ethereum', 'cbBTC': 'coingecko:coinbase-wrapped-btc', 'WBTC': 'coingecko:wrapped-bitcoin', 'USDT': 'coingecko:tether'}
def crypto_hourly(start='2022-12-01', end='2026-11-16'):
    """DefiLlama hourly for the crypto legs, over both v3.3 windows (one source for every leg, declared)."""
    for sym, coin in CRYPTO.items():
        rows = []; s = int(pd.Timestamp(start, tz='UTC').timestamp()); e = int(pd.Timestamp(end, tz='UTC').timestamp()); cur = s
        while cur <= e:
            span = min(400, (e - cur) // 3600 + 1)
            for att in range(5):
                try:
                    r = requests.get(f'https://coins.llama.fi/chart/{coin}', params={'start': cur, 'span': span, 'period': '1h', 'searchWidth': '1200'}, headers=UA, timeout=60)
                    r.raise_for_status(); pts = r.json()['coins'].get(coin, {}).get('prices', []); break
                except Exception: time.sleep(2 + att); pts = []
            rows += [(p['timestamp'], p['price']) for p in pts]; cur += span * 3600; time.sleep(0.2)
        pd.DataFrame(rows, columns=['ts', 'price']).drop_duplicates('ts').sort_values('ts').to_csv(os.path.join(V33, f'defillama_{sym}_hourly.csv'), index=False)
        print(sym, len(rows), flush=True)

def sessions():
    """NYSE sessions (exchange_calendars, XNYS) for the long window; saved so the report never needs the library."""
    import exchange_calendars as xc
    sess = xc.get_calendar('XNYS').sessions_in_range('2022-12-01', '2026-12-31')
    pd.DataFrame({'session': [d.date().isoformat() for d in sess]}).to_csv(os.path.join(V33, 'xnys_sessions.csv'), index=False)
    return len(sess)

def run():
    sessions(); directories(); coinbase_list(); print(json.dumps(feed_configs(), indent=0)[:3000], flush=True)
    rounds(); defillama_hourly(); crypto_hourly()

if __name__ == '__main__':
    run()
