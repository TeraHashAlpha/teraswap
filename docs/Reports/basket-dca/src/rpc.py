"""Minimal JSON-RPC client (eth_call only): batched, concurrent, retried, endpoint fallback."""
import time, threading, requests
from concurrent.futures import ThreadPoolExecutor
ENDPOINTS = {
    'arbitrum': ['https://arb1.arbitrum.io/rpc', 'https://arbitrum-one-rpc.publicnode.com'],
    'base': ['https://base-rpc.publicnode.com', 'https://mainnet.base.org'],
    'mainnet': ['https://ethereum-rpc.publicnode.com', 'https://eth.llamarpc.com'],
}
_local = threading.local()
_pool = ThreadPoolExecutor(4)

def _session():
    if not hasattr(_local, 's'): _local.s = requests.Session()
    return _local.s

def _chunk(net, chunk, k, retries=8):
    payload = [{'jsonrpc': '2.0', 'id': i, 'method': 'eth_call',
                'params': [{'to': to, 'data': data}, 'latest']} for i, (to, data) in enumerate(chunk)]
    last = None
    for attempt in range(retries):
        ep = ENDPOINTS[net][(k + attempt) % len(ENDPOINTS[net])]
        try:
            r = _session().post(ep, json=payload, timeout=30)
            if r.status_code == 429:
                last = '429'; time.sleep(1.5 * (attempt + 1)); continue
            r.raise_for_status(); res = r.json()
            if isinstance(res, dict): raise RuntimeError(str(res)[:200])
            byid = {x['id']: x for x in res}
            if len(byid) != len(chunk): raise RuntimeError('short batch')
            # any error that is not an EVM revert is transient (rate limits etc.) -> retry the chunk
            bad = [x for x in res if 'error' in x and 'revert' not in str(x['error']).lower()]
            if bad:
                last = bad[0]['error']; time.sleep(1.5 * (attempt + 1)); continue
            return [byid[i].get('result') if 'error' not in byid[i] else None for i in range(len(chunk))]
        except Exception as e:
            last = e; time.sleep(1 + attempt)
    raise RuntimeError(f'RPC failed for {net}: {last}')

def batch_call(net, calls, batch_size=50):
    """calls: list of (to, data_hex) -> list of result hex (None on revert)."""
    chunks = [calls[s:s + batch_size] for s in range(0, len(calls), batch_size)]
    if len(chunks) == 1: return _chunk(net, chunks[0], 0)
    res = list(_pool.map(lambda kc: _chunk(net, kc[1], kc[0]), enumerate(chunks)))
    return [x for r in res for x in r]
