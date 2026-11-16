"""Basket DCA — modelação v2 + v3. One command reproduces everything:

    python3 run_all.py              # fetch series (cached) + v2 + v3: scenarios, charts, RESULTS
    python3 run_all.py --no-fetch   # reuse data/series/** as committed (v2 and v3)
    python3 run_all.py --v2-only    # only v2 (RESULTS-2026-11.md, unchanged by v3)
    python3 run_all.py --v3-only    # only v3 (RESULTS-2026-11-v3.md)
    python3 run_all.py --v31-only   # only v3.1 (RESULTS-2026-11-v3.1.md; reads the v3 inventory in results/v3)
    python3 run_all.py --v32-only   # only v3.2 (RESULTS-2026-11-v3.2.md; k_soft by N, stable leg USDT/DAI on Base)
    python3 run_all.py --v33-only   # only v3.3 (RESULTS-2026-11-v3.3.md; Coinbase tokenized stocks as Split DCA legs)

Outputs: data/series/**, results/*.csv (v2), results/v3/* (v3), charts/*.svg (+ .csv beside each),
RESULTS-2026-11.md (v2), RESULTS-2026-11-v3.md (v3), RESULTS-2026-11-v3.1.md (v3.1), RESULTS-2026-11-v3.2.md (v3.2) and RESULTS-2026-11-v3.3.md (v3.3),
with HTML beside them.
"""
import os, sys, time, json, pickle
ROOT = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, os.path.join(ROOT, 'src'))
import pandas as pd

def main():
    t0 = time.time()
    only = [a for a in sys.argv if a.endswith('-only')]
    if not only or '--v2-only' in only: v2()
    if not only or '--v3-only' in only: v3()
    if not only or '--v31-only' in only: v31()
    if not only or '--v32-only' in only: v32()
    if not only or '--v33-only' in only: v33()
    print('done in', round(time.time() - t0, 1), 's')

def v3():
    if '--no-fetch' not in sys.argv:
        import fetch_v3, fetch_v3_x, fetch_v3_stables2, fetch_v3_stables3, runpy
        fetch_v3.run(); fetch_v3_x.run()
        runpy.run_path(os.path.join(ROOT, 'src', 'fetch_v3_stables.py'), run_name='__main__')
        fetch_v3_stables2.run(); fetch_v3_stables2.hourly_windows(); fetch_v3_stables3.run()
    import report_v3
    report_v3.compute(); report_v3.g1_build(); report_v3.write()

def v31():
    if '--no-fetch' not in sys.argv:
        import fetch_v31; fetch_v31.registry()
    import report_v31
    report_v31.compute(); report_v31.write()

def v32():
    if '--no-fetch' not in sys.argv:
        import fetch_v32; fetch_v32.run()
    import report_v32
    report_v32.compute(); report_v32.write()

def v33():
    if '--no-fetch' not in sys.argv:
        import fetch_v33; fetch_v33.run()             # needs exchange_calendars (NYSE sessions); --no-fetch reads the saved CSV
    import report_v33
    report_v33.compute(); report_v33.write()

def v2():
    if '--no-fetch' not in sys.argv:
        import fetch_all; fetch_all.chainlink_all(); fetch_all.offchain_all()
        import fetch_hourly_events, hourly_events
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(8) as ex: list(ex.map(fetch_hourly_events.run, fetch_hourly_events.JOBS))
        hourly_events.fetch_all()
    import experiments as ex
    R = os.path.join(ROOT, 'results')
    out = {}
    out['2.1'], out['2.1_objs'] = ex.sec_2_1()
    out['2.2'], out['months'] = ex.sec_2_2()
    out['2.3'] = ex.sec_2_3()
    out['2.4'] = ex.sec_2_4()
    out['2.5'] = ex.sec_2_5()
    out['2.6'], out['2.6_paths'] = ex.sec_2_6()
    out['2.7'], out['2.7_quality'], out['al_aero'], out['al_eth'] = ex.sec_2_7()
    out['2.8'] = ex.sec_2_8()
    out['2.9'] = ex.sec_2_9([out['2.1'], out['2.2'], out['2.3'], out['2.4'], out['2.5']])
    out['2.10_scan'], out['2.10_hits'], out['2.10_feed'], out['2.10'] = ex.sec_2_10()
    out['2.11_rolling'], out['2.11'], out['2.11_pairs'] = ex.sec_2_11()
    out['2.11_other'] = ex.win_summary([
        ('2.1 janelas de stress S1–S7 (ticks 00:00)', out['2.1'], ['window', 'duration', 'cadence_d', 'split']),
        ('2.10 movimentos bruscos, ticks horários', out['2.10'], ['episode', 'cadence_h', 'n_ticks', 'start', 'split']),
        ('2.3 Jul–Out 2026', out['2.3'], ['start_day', 'duration', 'cadence_d', 'split'])])
    import signal_check; out['2.12_raw'], out['2.12'] = signal_check.sec_2_12()
    for k in ('2.1', '2.2', '2.3', '2.4', '2.5', '2.6', '2.7', '2.7_quality', '2.8', '2.9',
              '2.10_scan', '2.10_hits', '2.10_feed', '2.10', '2.11_rolling', '2.11', '2.11_other', '2.12_raw', '2.12'):
        out[k].to_csv(os.path.join(R, f'sec_{k.replace(".", "_")}.csv'), index=False)
    pd.DataFrame(out['months'], columns=['year', 'month', 'eth_vol30_annualised_pct']).to_csv(os.path.join(R, 'sec_2_2_months.csv'), index=False)
    pickle.dump(out, open(os.path.join(R, '_all.pkl'), 'wb'))
    import charts; charts.build_all(out)
    import report; report.write(out)

if __name__ == '__main__':
    main()
