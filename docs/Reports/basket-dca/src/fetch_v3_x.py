"""v3 · three-volatile basket (ETH + cbBTC + X). X chosen from the Base catalog (owner §0.1):
  VIRTUAL — phase 1 (registered, enabled), Base-native, highest catalog volume among X candidates
  COMP    — phase 1 (registered, enabled), the only X with a Chainlink history long enough for 2022 windows
            (Ethereum COMP/USD before the Base feed existed)
  AERO    — phase 2 (Chainlink feed exists, not registered by TeraSwap), Base-native
Feeds come from dca-feed-registrations.json / the Chainlink directory (computed equality) and are checked by
description() on-chain. Outputs go to data/series/v3/ so the v2 inputs are untouched."""
import os, sys, json, time, datetime as dt, requests, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fetch_chainlink as fc, hourly_events as he, fetch_v3
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
V3 = os.path.join(ROOT, 'data', 'series', 'v3'); INP = os.path.join(ROOT, '_inputs')

def x_cfg():
    reg = json.load(open(os.path.join(INP, 'dca-feed-registrations.json')))['chains']['8453']['rows']
    dm = json.load(open(os.path.join(ROOT, 'data', 'raw', 'feeds-mainnet.json')))
    out = {}
    for sym, key in (('VIRTUAL', 'VIRTUAL_base'), ('COMP', 'COMP_base'), ('AERO', 'AERO_base')):
        r = [x for x in reg if x['symbol'] == sym][0]
        out[key] = dict(network='base', proxy=r['feed'], expectedDescription=r['description'], heartbeat=r['heartbeat'], phase=r['phase'], enabled=r['enabled'], token=r['token'])
    c = [f for f in dm if f.get('ens') == 'comp-usd' and not (f.get('docs') or {}).get('hidden')][0]
    out['COMP_mainnet'] = dict(network='mainnet', proxy=c['proxyAddress'], expectedDescription='COMP / USD', heartbeat=c['heartbeat'], phase=None, enabled=None, token=None)
    return out

DL = {'VIRTUAL': 'coingecko:virtual-protocol', 'COMP': 'coingecko:compound-governance-token', 'AERO': 'coingecko:aerodrome-finance'}
DLR = {'VIRTUAL': ('2024-10-01', '2026-11-07'), 'COMP': ('2021-11-01', '2026-11-07'), 'AERO': ('2023-09-01', '2026-11-07')}

def run():
    from concurrent.futures import ThreadPoolExecutor
    cfg = x_cfg(); json.dump(cfg, open(os.path.join(V3, 'x_feeds.json'), 'w'), indent=2)
    ver = [fc.verify_feed(k, dict(c)) for k, c in cfg.items()]
    pd.DataFrame(ver).to_csv(os.path.join(V3, 'x_feed_verification.csv'), index=False); print(ver, flush=True)
    assert all(v['descriptionMatches'] for v in ver)
    # DefiLlama + Coinbase (off-chain) in a side thread
    def offchain():
        for k, coin in DL.items():
            fetch_v3.DL_IDS[k] = coin; fetch_v3.DL_RANGES[k] = [DLR[k]]; fetch_v3.defillama_hourly(k)
        import fetch_hourly_events as fh
        fh.START, fh.END = '2024-04-01', '2026-11-07'
        fh.coinbase('AERO-USD').to_csv(os.path.join(V3, 'coinbase_AERO-USD_hourly.csv'), index=False)
        return 'offchain ok'
    def chain(net):
        res = []
        for k, c in cfg.items():
            if c['network'] != net: continue
            f = fc.Feed(k, c)
            first = f.rounds([0])[0]; start = dt.datetime.fromtimestamp(first[1], dt.timezone.utc).date() + dt.timedelta(days=1) if first else dt.date(2021, 12, 1)
            start = max(start, dt.date(2021, 12, 1))
            end = '2024-12-31' if k == 'COMP_mainnet' else '2026-11-07'
            g = fc.daily_grid(start.isoformat(), end); r = f.sample(g)
            pd.DataFrame({'date': [dt.datetime.fromtimestamp(t, dt.timezone.utc).date().isoformat() for t in g], 'price': [p for p, u in r],
                          'age_s': [(t - u) if u else None for t, (p, u) in zip(g, r)]}).to_csv(os.path.join(V3, f'cl_daily_{k}.csv'), index=False)
            hg = sorted({int(t.tz_localize('UTC').timestamp()) for ep in he.EPISODES for t in he.grids(ep) if t.date() >= start})
            hr = f.sample(hg) if hg else []
            pd.DataFrame({'utc': [dt.datetime.fromtimestamp(t, dt.timezone.utc).isoformat() for t in hg], 'price': [p for p, u in hr],
                          'age_s': [(t - u) if u else None for t, (p, u) in zip(hg, hr)]}).to_csv(os.path.join(V3, f'cl_hourly_ep_{k}.csv'), index=False)
            res.append((k, str(start), len(g), len(hg)))
        return res
    with ThreadPoolExecutor(3) as ex:
        a = ex.submit(offchain); b = ex.submit(chain, 'base'); c = ex.submit(chain, 'mainnet')
        print(b.result(), c.result(), a.result(), flush=True)

if __name__ == '__main__':
    run()
