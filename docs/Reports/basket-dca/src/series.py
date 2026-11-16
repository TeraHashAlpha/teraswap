"""Load the fetched series and build the per-leg price series used by each scenario.

Every leg is resolved to ONE declared source for the whole position (never mixed inside a
position). Source priority per leg (first that covers [start - cadence, end] wins):
  BTC-leg : cbBTC/USD (Base)  >  WBTC/USD (Arbitrum)  >  WBTC/BTC x BTC/USD (Ethereum mainnet)
  SOL, CRV: Arbitrum feed  >  Ethereum mainnet feed
  XRP     : Arbitrum feed  >  Bitstamp XRP/USD daily candle (exchange, declared; Coinbase had XRP suspended 2021-23)
  UST     : USTC/ETH x ETH/USD (Ethereum mainnet)
  ETH, USDC, USDT, DAI: Arbitrum feeds (cover the whole study period)
"""
import os, pandas as pd, numpy as np
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SER = os.path.join(ROOT, 'data', 'series')

SOURCE_LABEL = {
    'ETH': 'Chainlink ETH/USD · Arbitrum', 'USDC': 'Chainlink USDC/USD · Arbitrum',
    'USDT': 'Chainlink USDT/USD · Arbitrum', 'DAI': 'Chainlink DAI/USD · Arbitrum',
    'cbBTC': 'Chainlink cbBTC/USD · Base', 'WBTC': 'Chainlink WBTC/USD · Arbitrum',
    'WBTC_mainnet': 'Chainlink WBTC/BTC × BTC/USD · Ethereum',
    'SOL': 'Chainlink SOL/USD · Arbitrum', 'SOL_mainnet': 'Chainlink SOL/USD · Ethereum',
    'CRV': 'Chainlink CRV/USD · Arbitrum', 'CRV_mainnet': 'Chainlink CRV/USD · Ethereum',
    'XRP': 'Chainlink XRP/USD · Arbitrum', 'XRP_bs': 'Bitstamp XRP/USD (abertura da vela diária, 00:00 UTC)',
    'UST': 'Chainlink USTC/ETH × ETH/USD · Ethereum', 'AERO': 'Chainlink AERO/USD · Base',
    'ETH_base': 'Chainlink ETH/USD · Base',
}

_cache = {}
def cl(key):
    if key not in _cache:
        p = os.path.join(SER, f'cl_daily_{key}.csv')
        df = pd.read_csv(p, parse_dates=['date']).dropna(subset=['price'])
        _cache[key] = df.set_index('date')['price'].astype(float)
    return _cache[key]

def _composed(a, b):
    s = (cl(a) * cl(b)).dropna(); return s

def raw(src):
    if src == 'WBTC_mainnet': return _composed('WBTC_BTC_mainnet', 'BTC_mainnet')
    if src == 'UST': return _composed('UST_ETH', 'ETH_mainnet')
    if src == 'XRP_bs':
        df = pd.read_csv(os.path.join(SER, 'bitstamp_XRP_daily.csv'))
        # candle starting at D 00:00 -> 'open' is the price at D 00:00 UTC
        idx = pd.to_datetime(df['ts'], unit='s').dt.normalize()
        return pd.Series(df['open'].values, index=idx).astype(float).sort_index()
    return cl(src)

PRIORITY = {
    'BTC': ['cbBTC', 'WBTC', 'WBTC_mainnet'],
    'SOL': ['SOL', 'SOL_mainnet'], 'CRV': ['CRV', 'CRV_mainnet'], 'XRP': ['XRP', 'XRP_bs'],
}

def covers(s, dates):
    return all(d in s.index for d in dates)

def resolve(leg, dates):
    """Return (source_key, series) for a leg covering every date in `dates`."""
    for src in PRIORITY.get(leg, [leg]):
        try: s = raw(src)
        except FileNotFoundError: continue
        if covers(s, dates): return src, s
    return None, None
