"""T7 · second pass, driven by the first-pass inventory (t7_stables.detect):
  - DefiLlama hourly around EVERY candidate event of the non-curated coins (the first pass only had the first one);
  - Chainlink (Ethereum) hour by hour around each event of the 1 h-heartbeat feeds (DAI, FRAX, LUSD, USDP), which are
    too long to read round by round."""
import os, sys, json, pandas as pd, datetime as dt
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fetch_v3, fetch_chainlink as fc, t7_stables as T
ST = T.ST

def run():
    ev = T.detect(); print(len(ev), 'events', flush=True)
    done = []
    for g, x in ev[~ev.gecko_id.isin(set(T.CURATED.values()))].groupby('gecko_id'):
        rng = [(str((t - pd.Timedelta(days=3)).date()), str((t + pd.Timedelta(days=45)).date())) for t in x.start]
        key = 'X_' + g; fetch_v3.DL_IDS[key] = f'coingecko:{g}'; fetch_v3.DL_RANGES[key] = rng; fetch_v3.V3 = ST
        done.append(fetch_v3.defillama_hourly(key))
    print(done, flush=True)
    cfg = json.load(open(os.path.join(ST, 'stable_feeds.json')))
    for sym in ('DAI', 'FRAX', 'LUSD', 'USDP'):
        x = ev[ev.symbol == sym]
        if x.empty or sym not in cfg: continue
        ts = set()
        for _, e in x.iterrows():
            a = (e.start - pd.Timedelta(days=1)).floor('h'); b = (e.recovered_at if e.recovered else e.start + pd.Timedelta(days=30)) + pd.Timedelta(days=4)
            ts.update(int(t.tz_localize('UTC').timestamp()) for t in pd.date_range(a, b, freq='h'))
        ts = sorted(ts); f = fc.Feed('ST_' + sym, cfg[sym]); r = f.sample(ts)
        pd.DataFrame({'utc': [dt.datetime.fromtimestamp(t, dt.timezone.utc).isoformat() for t in ts], 'price': [p for p, u in r],
                      'age_s': [(t - u) if u else None for t, (p, u) in zip(ts, r)]}).to_csv(os.path.join(ST, f'cl_hourly_ev_{sym}.csv'), index=False)
        print(sym, len(ts), flush=True)

if __name__ == '__main__':
    run()
