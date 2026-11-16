"""T7 · inventory of real USD-stablecoin depegs.
Detection series: DefiLlama hourly (one source for every stable, 2020-2026). Keeper series: Chainlink on
Ethereum where a feed exists (complete round history for the 24 h feeds; hourly samples around each event
for the 1 h feeds); otherwise the exchange/aggregator series, declared. Candle minimum: Coinbase or
Bitstamp hourly candles where the pair exists."""
import os, sys, json, time, datetime as dt, requests, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fetch_chainlink as fc, fetch_v3, fetch_hourly_events as fh
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ST = os.path.join(ROOT, 'data', 'series', 'v3', 'stables'); os.makedirs(ST, exist_ok=True)
STABLES = {   # symbol: (coingecko id for DefiLlama, Chainlink ENS on Ethereum or None, exchange candle source or None)
    'USDC': ('usd-coin', 'usdc-usd', ('bitstamp', 'usdcusd')), 'USDT': ('tether', 'usdt-usd', ('coinbase', 'USDT-USD')),
    'DAI': ('dai', 'dai-usd', ('coinbase', 'DAI-USD')), 'BUSD': ('binance-usd', None, None), 'TUSD': ('true-usd', 'tusd-usd', None),
    'USDP': ('paxos-standard', 'usdp-usd', ('coinbase', 'PAX-USD')), 'FRAX': ('frax', 'frax-usd', None), 'LUSD': ('liquity-usd', 'lusd-usd', None),
    'GUSD': ('gemini-dollar', None, ('coinbase', 'GUSD-USD')), 'USDD': ('usdd', None, None), 'UST': ('terrausd', 'ust-eth', None),
    'USDe': ('ethena-usde', 'usde-usd', None), 'PYUSD': ('paypal-usd', 'pyusd-usd', ('coinbase', 'PYUSD-USD')), 'FDUSD': ('first-digital-usd', 'fdusd-usd', None),
    'sUSD': ('nusd', None, None), 'MIM': ('magic-internet-money', None, None), 'crvUSD': ('crvusd', 'crvusd-usd', None), 'GHO': ('gho', 'gho-usd', None),
    'USDS': ('usds', 'usds-usd', None), 'DOLA': ('dola-usd', 'dola-usd', None), 'USD0': ('usual-usd', 'usd0-usd', None), 'RLUSD': ('ripple-usd', 'rlusd-usd', None),
}
SMALL_FEEDS = {'USDC', 'USDT', 'TUSD', 'FDUSD', 'PYUSD', 'USDe', 'USDS', 'GHO', 'crvUSD', 'DOLA', 'USD0', 'RLUSD'}

def dl_all():
    out = []
    for sym, (cg, _, _) in STABLES.items():
        fetch_v3.DL_IDS[sym] = f'coingecko:{cg}'; fetch_v3.DL_RANGES[sym] = [('2020-01-01', '2026-11-07')]
        fetch_v3.V3 = ST; k, n = fetch_v3.defillama_hourly(sym); out.append((k, n))
    return out

def feeds_cfg():
    d = json.load(open(os.path.join(ROOT, 'data', 'raw', 'feeds-mainnet.json'))); cfg = {}
    for sym, (_, ens, _) in STABLES.items():
        if not ens: continue
        f = [x for x in d if x.get('ens') == ens and not (x.get('docs') or {}).get('hidden')]
        if f: cfg[sym] = dict(network='mainnet', proxy=f[0]['proxyAddress'], expectedDescription=f[0]['name'], heartbeat=f[0].get('heartbeat'), threshold=f[0].get('threshold'))
    return cfg

def full_rounds(sym, c):
    f = fc.Feed('ST_' + sym, c); gids = list(range(f.total))
    for i in range(0, len(gids), 1000): f.rounds(gids[i:i + 1000])
    f.save()
    rows = [(f.cache[g][0] / 10 ** f.decimals, f.cache[g][1]) for g in gids if f.cache.get(g)]
    pd.DataFrame(rows, columns=['price', 'updatedAt']).sort_values('updatedAt').to_csv(os.path.join(ST, f'cl_rounds_{sym}.csv'), index=False)
    return sym, len(rows)

def candles():
    out = []
    for sym, (_, _, ex) in STABLES.items():
        if not ex: continue
        venue, pair = ex; fh.START, fh.END = '2020-01-01', '2026-11-07'
        df = fh.coinbase(pair) if venue == 'coinbase' else fh.bitstamp(pair)
        df.to_csv(os.path.join(ST, f'candles_{sym}.csv'), index=False); out.append((sym, len(df)))
    return out

if __name__ == '__main__':
    from concurrent.futures import ThreadPoolExecutor
    cfg = feeds_cfg(); json.dump(cfg, open(os.path.join(ST, 'stable_feeds.json'), 'w'), indent=2)
    ver = [fc.verify_feed('ST_' + s, dict(c)) for s, c in cfg.items()]
    pd.DataFrame(ver).to_csv(os.path.join(ST, 'stable_feed_verification.csv'), index=False)
    print([(v['key'], v['description'], v['descriptionMatches']) for v in ver], flush=True)
    with ThreadPoolExecutor(3) as ex:
        a = ex.submit(dl_all); b = ex.submit(candles)
        c = ex.submit(lambda: [full_rounds(s, cfg[s]) for s in cfg if s in SMALL_FEEDS])
        print(a.result(), b.result(), c.result(), flush=True)
