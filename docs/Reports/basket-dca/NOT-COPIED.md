# Basket DCA analyst package — what was NOT copied into this repo

Measured 2026-11-16. This folder holds the **narrow** package only: code, config, the `RESULTS-*.md` reports and the small
`results/` tables. The full package (about 220 MB) stays outside git.

**Full package lives at:** `~/Desktop/Claude/dex-aggregator 2/Analista/basket-dca-v2/docs-Reports-basket-dca/` (owner's Mac, not in git).

**Rebuild the data** (from the README; not run for this commit):

```
python3 run_all.py
```

`run_all.py` re-reads the feeds and public APIs and re-creates `data/` and `results/`. The `--no-fetch` variants in the README
need the `data/series/` tree, which is not here.

## What was copied (rule)

`README.md`, `requirements.txt`, `run_all.py`, every `RESULTS-*.md`, `src/**/*.py`, `tests/**/*.py`, `config/**`, and from `results/**`
only `.csv` and `.md` files under 1 MB (1 048 576 bytes). 100 files, 4 008 975 bytes, in this folder with NOT-COPIED.md excluded.

## What was left out (by rule)

| Where | Rule | Files | Bytes |
|---|---|---:|---:|
| `data/` (all) | never copied | 250 | 111 941 348 |
| `_inputs/` (all) | never copied | 6 | 373 044 |
| `_inputs_v3/` (all) | never copied | 2 | 17 197 |
| `charts/` (all) | never copied | 45 | 2 215 115 |
| top level `*.html` (RESULTS html) | not `.md` | 5 | 1 668 865 |
| top level `.gitignore` | not in the copy list | 1 | 141 |
| `results/**` `.csv` over 1 MB | size | 11 | 51 990 669 |
| `results/**` `.gz` archives | archives | 17 | 60 259 040 |
| `results/**` `.pkl` | not csv/md | 2 | 38 098 529 |
| `results/**` `.json` (incl. `v3/t4_registry.json`) | not csv/md | 3 | 2 195 |
| `src/__pycache__`, `tests/__pycache__` | never copied | 31 | 479 993 |

## Six files flagged by gitleaks (default ruleset), never copied

All six are `generic-api-key`, measured by scanning only those six files with the default gitleaks ruleset (matched text not printed):

| File | Rule | Hits |
|---|---|---:|
| `_inputs/dca-feed-registrations.json` | `generic-api-key` | 31 |
| `data/series/v3/base_feeds.json` | `generic-api-key` | 2 |
| `data/series/v3/executor_registry_base.json` | `generic-api-key` | 2 |
| `data/series/v3/x_feeds.json` | `generic-api-key` | 3 |
| `data/series/v31/executor_registry_base_v31.json` | `generic-api-key` | 5 |
| `results/v3/t4_registry.json` | `generic-api-key` | 2 |

Total 45. The narrow copy was scanned twice, once with this repo's `.gitleaks.toml` and once with the default ruleset, from a
location outside `docs/` so no path allow-list applied: 0 hits in both.
