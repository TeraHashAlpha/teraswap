"""Build config/feeds.json WITHOUT hand-typed addresses.

Every feed address is selected programmatically from Chainlink's official
reference-data directory (canonical ENS-named, non-hidden entry for the pair),
then cross-checked by computed equality against the TeraSwap repo
(src/config/dca-feed-registrations.json + src/lib/chains/chainlink-feeds.ts at
the commit in _inputs/SOURCE_COMMIT.txt). On-chain description()/decimals()
are verified later by fetch_chainlink.verify_feeds() (ADR-018 rule).
"""
import json, re, os, sys
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, 'data', 'raw')
INP = os.path.join(ROOT, '_inputs')

DIRECTORIES = {
    'arbitrum': 'feeds-ethereum-mainnet-arbitrum-1.json',
    'base': 'feeds-ethereum-mainnet-base-1.json',
    'mainnet': 'feeds-mainnet.json',
}
CHAIN_ID = {'arbitrum': 42161, 'base': 8453, 'mainnet': 1}
# (series key, network, ens slug, expected description)
WANTED = [
    ('ETH',   'arbitrum', 'eth-usd',  'ETH / USD'),
    ('WBTC',  'arbitrum', 'wbtc-usd', 'WBTC / USD'),
    ('USDC',  'arbitrum', 'usdc-usd', 'USDC / USD'),
    ('USDT',  'arbitrum', 'usdt-usd', 'USDT / USD'),
    ('DAI',   'arbitrum', 'dai-usd',  'DAI / USD'),
    ('SOL',   'arbitrum', 'sol-usd',  'SOL / USD'),
    ('XRP',   'arbitrum', 'xrp-usd',  'XRP / USD'),
    ('CRV',   'arbitrum', 'crv-usd',  'CRV / USD'),
    ('cbBTC', 'base',     'cbbtc-usd','cbBTC / USD'),
    ('AERO',  'base',     'aero-usd', 'AERO / USD'),
    # UST (Terra) — only for the 'peg that never came back' real case (2.6 extra).
    # Composed UST/USD = USTC/ETH x ETH/USD, both mainnet Chainlink.
    ('UST_ETH', 'mainnet', 'ust-eth', 'USTC / ETH'),
    ('ETH_mainnet', 'mainnet', 'eth-usd', 'ETH / USD'),
    # Pre-coverage fallbacks (Arbitrum feeds start: WBTC 2022-11-25, SOL/CRV 2022-02-15):
    # WBTC/USD composed on mainnet = WBTC/BTC x BTC/USD (the repo's own mainnet composition).
    ('WBTC_BTC_mainnet', 'mainnet', 'wbtc-btc', 'WBTC / BTC'),
    ('BTC_mainnet', 'mainnet', 'btc-usd', 'BTC / USD'),
    ('SOL_mainnet', 'mainnet', 'sol-usd', 'SOL / USD'),
    ('CRV_mainnet', 'mainnet', 'crv-usd', 'CRV / USD'),
]

def fetch_directories():
    import requests
    os.makedirs(RAW, exist_ok=True)
    for net, fn in DIRECTORIES.items():
        p = os.path.join(RAW, fn)
        if not os.path.exists(p):
            r = requests.get(f'https://reference-data-directory.vercel.app/{fn}', timeout=60)
            r.raise_for_status(); open(p, 'wb').write(r.content)

def repo_addresses():
    """All feed addresses that appear in the repo sources, lowercased, with provenance."""
    out = {}
    reg = json.load(open(os.path.join(INP, 'dca-feed-registrations.json')))
    for cid, ch in reg['chains'].items():
        for r in ch['rows']:
            out[r['feed'].lower()] = f"dca-feed-registrations.json chain {cid} {r['symbol']} enabled={r['enabled']}"
    ts = open(os.path.join(INP, 'chainlink-feeds.ts')).read()
    cst = open(os.path.join(INP, 'constants.ts')).read()
    m0 = re.search(r"CHAINLINK_ETH_USD\s*=\s*'(0x[0-9a-fA-F]{40})'", cst)
    if m0: out[m0.group(1).lower()] = 'constants.ts CHAINLINK_ETH_USD (mainnet)'
    for m in re.finditer(r"'0x[0-9a-fA-F]{40}'\s*:\s*'(0x[0-9a-fA-F]{40})'", ts):
        out.setdefault(m.group(1).lower(), 'chainlink-feeds.ts map entry')
    return out

def build():
    fetch_directories()
    repo = repo_addresses()
    feeds = {}
    for key, net, ens, desc in WANTED:
        d = json.load(open(os.path.join(RAW, DIRECTORIES[net])))
        cands = [f for f in d if f.get('ens') == ens and not (f.get('docs') or {}).get('hidden')]
        if len(cands) != 1:
            # prefer the one the repo already uses
            inrepo = [f for f in cands if f['proxyAddress'].lower() in repo]
            if len(inrepo) == 1: cands = inrepo
        if len(cands) != 1:
            print(f'!! {key}: {len(cands)} canonical candidates for {net}/{ens}', file=sys.stderr); continue
        f = cands[0]
        addr = f['proxyAddress']
        feeds[key] = {
            'network': net, 'chainId': CHAIN_ID[net], 'ens': ens,
            'proxy': addr, 'expectedDescription': desc,
            'directoryDecimals': f.get('decimals'), 'heartbeat': f.get('heartbeat'),
            'deviationThreshold': f.get('threshold'),
            'inRepo': repo.get(addr.lower(), None),
        }
    # Base ETH/USD: the canonical proxy the repo uses is no longer listed under an
    # ENS name in the directory (only -svr siblings are). Take it from the repo:
    # catalog WETH address -> chainlink-feeds.ts map value. Verified on-chain later.
    cat = json.load(open(os.path.join(INP, 'token-catalog.8453.json')))['tokens']
    weth = [t['address'] for t in cat if t['symbol'] == 'WETH'][0].lower()
    ts = open(os.path.join(INP, 'chainlink-feeds.ts')).read()
    m = re.search(r"'" + weth + r"'\s*:\s*'(0x[0-9a-fA-F]{40})'", ts, re.I)
    feeds['ETH_base'] = {'network': 'base', 'chainId': 8453, 'ens': None, 'proxy': m.group(1),
        'expectedDescription': 'ETH / USD', 'directoryDecimals': 8, 'heartbeat': 1200,
        'deviationThreshold': None, 'inRepo': 'chainlink-feeds.ts 8453 WETH (not ENS-listed in directory)'}
    os.makedirs(os.path.join(ROOT, 'config'), exist_ok=True)
    json.dump(feeds, open(os.path.join(ROOT, 'config', 'feeds.json'), 'w'), indent=2)
    return feeds

if __name__ == '__main__':
    for k, v in build().items():
        print(f"{k:10s} {v['network']:8s} {v['proxy']} hb={v['heartbeat']} dev={v['deviationThreshold']} repo={v['inRepo']}")
