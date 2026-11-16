"""v3 data: DefiLlama at the tick hours, Base phase-1 feeds, and the Base OrderExecutorV3 feed registry.
Addresses are never typed: executor from docs/DEPLOYMENTS.md (repo), tokens from the generated catalog,
feeds from dca-feed-registrations.json, each checked on-chain before use."""
import os, sys, re, json, time, datetime as dt, requests, numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rpc, fetch_chainlink as fc
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SER = os.path.join(ROOT, 'data', 'series'); V3 = os.path.join(SER, 'v3'); os.makedirs(V3, exist_ok=True)
INP, INP3 = os.path.join(ROOT, '_inputs'), os.path.join(ROOT, '_inputs_v3')
UA = {'User-Agent': 'teraswap-basket-dca-research/1.0'}
try:
    from Crypto.Hash import keccak
    def sel(sig):
        k = keccak.new(digest_bits=256); k.update(sig.encode()); return '0x' + k.hexdigest()[:8]
except ImportError:   # pre-computed (keccak256(signature)[:4])
    _S = {'domainSeparator()': '0xf698da25', 'ORDER_TYPEHASH()': '0xf973a209', 'tokenUsdFeeds(address)': '0xdd719ac2'}
    def sel(sig): return _S[sig]

# ------------------------------------------------------------------ DefiLlama (coins API, CoinGecko ids)
DL_IDS = {'ETH': 'coingecko:ethereum', 'WBTC': 'coingecko:wrapped-bitcoin', 'cbBTC': 'coingecko:coinbase-wrapped-btc',
          'USDC': 'coingecko:usd-coin', 'UST': 'coingecko:terrausd', 'BTC': 'coingecko:bitcoin'}
DL_RANGES = {'ETH': [('2021-11-01', '2026-11-07')], 'WBTC': [('2022-03-01', '2026-11-07')], 'cbBTC': [('2024-09-01', '2026-11-07')],
             'USDC': [('2021-11-01', '2026-11-07')], 'UST': [('2022-04-01', '2022-07-15')], 'BTC': [('2021-11-01', '2022-01-10')]}

def defillama_hourly(key):
    coin = DL_IDS[key]; rows = []
    for a, b in DL_RANGES[key]:
        s = int(pd.Timestamp(a, tz='UTC').timestamp()); e = int(pd.Timestamp(b, tz='UTC').timestamp()); cur = s
        while cur <= e:
            span = min(400, (e - cur) // 3600 + 1)
            for att in range(5):
                try:
                    r = requests.get(f'https://coins.llama.fi/chart/{coin}', params={'start': cur, 'span': span, 'period': '1h', 'searchWidth': '1200'}, headers=UA, timeout=60)
                    r.raise_for_status(); pts = r.json()['coins'].get(coin, {}).get('prices', []); break
                except Exception: time.sleep(2 + att); pts = []
            rows += [(p['timestamp'], p['price']) for p in pts]
            cur += span * 3600; time.sleep(0.2)
    df = pd.DataFrame(rows, columns=['ts', 'price']).drop_duplicates('ts').sort_values('ts')
    df.to_csv(os.path.join(V3, f'defillama_{key}_hourly.csv'), index=False)
    return key, len(df)

# ------------------------------------------------------------------ Base feeds
def base_feed_cfg():
    reg = json.load(open(os.path.join(INP, 'dca-feed-registrations.json')))['chains']['8453']['rows']
    out = {}
    for sym, key in (('USDC', 'USDC_base'), ('cbBTC', 'cbBTC'), ('WETH', 'ETH_base')):
        r = [x for x in reg if x['symbol'] == sym]
        if r: out[key] = {'network': 'base', 'proxy': r[0]['feed'], 'expectedDescription': r[0]['description'],
                          'heartbeat_registry': r[0]['heartbeat'], 'enabled': r[0]['enabled'], 'token': r[0]['token']}
    feeds = json.load(open(os.path.join(ROOT, 'config', 'feeds.json')))
    if 'ETH_base' not in out:
        out['ETH_base'] = dict(feeds['ETH_base'], heartbeat_registry=feeds['ETH_base']['heartbeat'], enabled=True, token=None)
    return out

def all_rounds(key, cfg, last=None):
    f = fc.Feed(key, cfg); lo = 0 if last is None else max(0, f.total - last)
    gids = list(range(lo, f.total))
    for i in range(0, len(gids), 1000): f.rounds(gids[i:i + 1000])
    f.save()
    rows = [(g, f.cache[g][0] / 10 ** f.decimals, f.cache[g][1]) for g in gids if f.cache.get(g)]
    df = pd.DataFrame(rows, columns=['gid', 'price', 'updatedAt']); df.to_csv(os.path.join(V3, f'rounds_{key}.csv'), index=False)
    return df

def executor_registry():
    txt = open(os.path.join(INP3, 'DEPLOYMENTS.md')).read()
    row = [l for l in txt.splitlines() if 'OrderExecutor V3' in l and 'Base (8453)' in l][0]
    addr = re.search(r'`(0x[0-9a-fA-F]{40})`', row).group(1)
    code = requests.post(rpc.ENDPOINTS['base'][0], json={'jsonrpc': '2.0', 'id': 1, 'method': 'eth_getCode', 'params': [addr, 'latest']}, timeout=30).json()['result']
    v3_probe = rpc.batch_call('base', [(addr, sel('domainSeparator()')), (addr, sel('ORDER_TYPEHASH()'))])
    cat = {t['symbol']: t['address'] for t in json.load(open(os.path.join(INP, 'token-catalog.8453.json')))['tokens']}
    out = dict(executor=addr, code_bytes=(len(code) - 2) // 2, domainSeparator_ok=bool(v3_probe[0]), ORDER_TYPEHASH_ok=bool(v3_probe[1]), tokens=[])
    s = sel('tokenUsdFeeds(address)')
    for sym in ('USDC', 'WETH', 'cbBTC'):
        res = rpc.batch_call('base', [(addr, s + cat[sym][2:].lower().rjust(64, '0'))])[0]
        w = [res[2 + 64 * i: 2 + 64 * (i + 1)] for i in range(5)]
        out['tokens'].append(dict(symbol=sym, token=cat[sym], feed='0x' + w[0][24:], feedDecimals=int(w[1], 16), tokenDecimals=int(w[2], 16),
                                  maxStaleness=int(w[3], 16), registered=bool(int(w[4], 16))))
    json.dump(out, open(os.path.join(V3, 'executor_registry_base.json'), 'w'), indent=2)
    return out

def run():
    from concurrent.futures import ThreadPoolExecutor
    print(json.dumps(executor_registry(), indent=1), flush=True)
    cfg = base_feed_cfg(); json.dump(cfg, open(os.path.join(V3, 'base_feeds.json'), 'w'), indent=2)
    ver = [dict(fc.verify_feed(k, dict(c)), heartbeat_registry=c['heartbeat_registry'], enabled=c['enabled']) for k, c in cfg.items()]
    pd.DataFrame(ver).to_csv(os.path.join(V3, 'base_feed_verification.csv'), index=False); print(ver, flush=True)
    with ThreadPoolExecutor(3) as ex:
        dl = ex.submit(lambda: [defillama_hourly(k) for k in DL_IDS])
        r1 = all_rounds('USDC_base', cfg['USDC_base'])
        r2 = all_rounds('cbBTC', cfg['cbBTC'], last=6000)
        r3 = all_rounds('ETH_base', cfg['ETH_base'], last=6000)
        g = fc.hourly_grid('2026-07-01', '2026-11-07T00:00:00')
        f = fc.Feed('cbBTC', cfg['cbBTC']); r = f.sample(g)
        pd.DataFrame({'utc': [dt.datetime.fromtimestamp(t, dt.timezone.utc).isoformat() for t in g], 'price': [p for p, u in r],
                      'age_s': [(t - u) if u else None for t, (p, u) in zip(g, r)]}).to_csv(os.path.join(V3, 'cl_hourly_cbBTC.csv'), index=False)
        print('defillama', dl.result(), 'rounds', len(r1), len(r2), len(r3), flush=True)

if __name__ == '__main__':
    run()
