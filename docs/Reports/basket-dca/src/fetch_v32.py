"""v3.2 · §B data: the Base OrderExecutorV3 registry (tokenUsdFeeds) for the stable legs a phase-1 Basket can use
(USDT, DAI; EURC recorded only) and the tokens the request lists as unregistered; every round of the registered Base
USDT/USD and DAI/USD feeds. Executor address from docs/DEPLOYMENTS.md, token addresses from the repo's Base catalog,
feed addresses as the executor returns them (computed, never typed); each feed matched to the Chainlink directory by
equality of address and checked on-chain with description()/decimals()."""
import os, sys, re, json, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rpc, fetch_chainlink as fc
from fetch_v3 import sel, INP, INP3
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
V32 = os.path.join(ROOT, 'data', 'series', 'v32'); os.makedirs(V32, exist_ok=True)
STABLE_LEGS = ('USDT', 'DAI')
SYMS = ('USDT', 'DAI', 'EURC', 'USDS', 'USDe', 'sUSDe', 'USDbC', 'cbETH', 'wstETH', 'AAVE', 'LINK', 'GHO')
REG_JSON = os.path.join(V32, 'executor_registry_base_v32.json')

def _directory():
    return json.load(open(os.path.join(ROOT, 'data', 'raw', 'feeds-ethereum-mainnet-base-1.json')))

def registry():
    txt = open(os.path.join(INP3, 'DEPLOYMENTS.md')).read()
    row = [l for l in txt.splitlines() if 'OrderExecutor V3' in l and 'Base (8453)' in l][0]
    addr = re.search(r'`(0x[0-9a-fA-F]{40})`', row).group(1)
    cat = {t['symbol']: t['address'] for t in json.load(open(os.path.join(INP, 'token-catalog.8453.json')))['tokens']}
    directory = _directory()
    byproxy = {d['proxyAddress'].lower(): d for d in directory if d.get('proxyAddress')}
    s = sel('tokenUsdFeeds(address)'); rows = []
    for sym in SYMS:
        if sym not in cat:
            rows.append(dict(symbol=sym, token=None, in_catalog=False, registered=False)); continue
        res = rpc.batch_call('base', [(addr, s + cat[sym][2:].lower().rjust(64, '0'))])[0]
        w = [res[2 + 64 * i: 2 + 64 * (i + 1)] for i in range(5)]
        feed = '0x' + w[0][24:]; reg = bool(int(w[4], 16))
        d = byproxy.get(feed.lower(), {})
        r = dict(symbol=sym, token=cat[sym], in_catalog=True, feed=feed if int(feed, 16) else None, feedDecimals=int(w[1], 16),
                 tokenDecimals=int(w[2], 16), maxStaleness=int(w[3], 16), registered=reg,
                 directory_match=bool(d), directory_name=d.get('name'), directory_path=d.get('path'),
                 directory_threshold_pct=d.get('threshold'), directory_heartbeat_s=d.get('heartbeat'))
        if reg and r['feed']:
            v = fc.verify_feed('BASE_' + sym, dict(network='base', proxy=r['feed'], expectedDescription=d.get('name') or ''))
            r['description_onchain'] = v.get('description'); r['decimals_onchain'] = v.get('decimals')
            r['description_matches'] = v.get('descriptionMatches')
        rows.append(r)
    eur = [d for d in directory if d.get('path') == 'eur-usd']           # §B «fora do pedido»: the EUR/USD reference on Base
    out = dict(executor=addr, read_at_utc=pd.Timestamp.utcnow().strftime('%Y-%m-%d %H:%M'), tokens=rows,
               eur_usd_directory=[dict(name=d.get('name'), path=d.get('path'), threshold_pct=d.get('threshold'), heartbeat_s=d.get('heartbeat')) for d in eur])
    json.dump(out, open(REG_JSON, 'w'), indent=2)
    return out

def rounds():
    reg = json.load(open(REG_JSON)); out = {}
    for t in reg['tokens']:
        if t['symbol'] not in STABLE_LEGS: continue
        assert t['registered'] and t['directory_match'] and t.get('description_matches'), t
        key = f"{t['symbol']}_base"
        f = fc.Feed(key, dict(network='base', proxy=t['feed'], expectedDescription=t['directory_name']))
        gids = list(range(f.total))
        for i in range(0, len(gids), 1000): f.rounds(gids[i:i + 1000])
        f.save()
        rows = [(g, f.cache[g][0] / 10 ** f.decimals, f.cache[g][1]) for g in gids if f.cache.get(g)]
        df = pd.DataFrame(rows, columns=['gid', 'price', 'updatedAt']).sort_values('updatedAt')
        df.to_csv(os.path.join(V32, f'rounds_{key}.csv'), index=False); out[key] = len(df)
    return out

def eth_rounds():
    """Every round of the Ethereum DAI/USD feed (the stable leg before the Base feeds exist, Aug 2023). The address
    is the one v3 T7 took from the Chainlink mainnet directory by ENS and verified on-chain (stable_feeds.json).
    USDT/USD on Ethereum already has every round in v3 (stables/cl_rounds_USDT.csv)."""
    ST = os.path.join(ROOT, 'data', 'series', 'v3', 'stables')
    c = json.load(open(os.path.join(ST, 'stable_feeds.json')))['DAI']
    v = fc.verify_feed('ST_DAI', dict(c)); assert v['descriptionMatches'], v
    f = fc.Feed('ST_DAI', c); gids = list(range(f.total))
    for i in range(0, len(gids), 1000): f.rounds(gids[i:i + 1000])
    f.save()
    rows = [(g, f.cache[g][0] / 10 ** f.decimals, f.cache[g][1]) for g in gids if f.cache.get(g)]
    df = pd.DataFrame(rows, columns=['gid', 'price', 'updatedAt']).sort_values('updatedAt')
    df.to_csv(os.path.join(V32, 'rounds_DAI_eth.csv'), index=False)
    return {'DAI_eth': len(df)}

def run():
    r = registry()
    print(json.dumps([{k: t.get(k) for k in ('symbol', 'registered', 'maxStaleness', 'directory_path', 'directory_threshold_pct', 'directory_heartbeat_s')} for t in r['tokens']], indent=0), flush=True)
    print(rounds(), flush=True)
    print(eth_rounds(), flush=True)

if __name__ == '__main__':
    run()
