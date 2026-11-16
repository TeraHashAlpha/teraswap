"""v3.1 · §3: the Base OrderExecutorV3 registry (tokenUsdFeeds) for every token a Basket leg can use in phase 1
(VIRTUAL, COMP, cbBTC, USDC, WETH) plus AERO (phase 2, expected unregistered). Executor address from
docs/DEPLOYMENTS.md, token addresses from the repo's Base catalog (computed, never typed). Each registered feed is
checked against the Chainlink directory (threshold, heartbeat) and by description() on-chain."""
import os, sys, re, json, pandas as pd, requests
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rpc, fetch_chainlink as fc
from fetch_v3 import sel, INP, INP3
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
V31 = os.path.join(ROOT, 'data', 'series', 'v31'); os.makedirs(V31, exist_ok=True)
SYMS = ('VIRTUAL', 'COMP', 'cbBTC', 'USDC', 'WETH', 'AERO')

def registry():
    txt = open(os.path.join(INP3, 'DEPLOYMENTS.md')).read()
    row = [l for l in txt.splitlines() if 'OrderExecutor V3' in l and 'Base (8453)' in l][0]
    addr = re.search(r'`(0x[0-9a-fA-F]{40})`', row).group(1)
    cat = {t['symbol']: t['address'] for t in json.load(open(os.path.join(INP, 'token-catalog.8453.json')))['tokens']}
    directory = json.load(open(os.path.join(ROOT, 'data', 'raw', 'feeds-ethereum-mainnet-base-1.json')))
    byproxy = {d['proxyAddress'].lower(): d for d in directory if d.get('proxyAddress')}
    s = sel('tokenUsdFeeds(address)'); rows = []
    for sym in SYMS:
        res = rpc.batch_call('base', [(addr, s + cat[sym][2:].lower().rjust(64, '0'))])[0]
        w = [res[2 + 64 * i: 2 + 64 * (i + 1)] for i in range(5)]
        feed = '0x' + w[0][24:]; reg = bool(int(w[4], 16))
        d = byproxy.get(feed.lower(), {})
        r = dict(symbol=sym, token=cat[sym], feed=feed if int(feed, 16) else None, feedDecimals=int(w[1], 16), tokenDecimals=int(w[2], 16),
                 maxStaleness=int(w[3], 16), registered=reg, directory_name=d.get('name'), directory_threshold_pct=d.get('threshold'),
                 directory_heartbeat_s=d.get('heartbeat'))
        if reg and r['feed']:
            v = fc.verify_feed('BASE_' + sym, dict(network='base', proxy=r['feed'], expectedDescription=d.get('name') or ''))
            r['description_onchain'] = v.get('description'); r['decimals_onchain'] = v.get('decimals')
        rows.append(r)
    out = dict(executor=addr, read_at_utc=pd.Timestamp.utcnow().strftime('%Y-%m-%d %H:%M'), tokens=rows)
    json.dump(out, open(os.path.join(V31, 'executor_registry_base_v31.json'), 'w'), indent=2)
    return out

if __name__ == '__main__':
    print(json.dumps(registry(), indent=1))
