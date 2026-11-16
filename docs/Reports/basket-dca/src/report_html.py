"""Render the same document model as a self-contained HTML report (charts inlined as SVG)."""
import os, re, html
from docmodel import to_html_body
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

CSS = r"""
/* Layout: long-form evidence report — sticky contents rail on wide screens, 70ch text column, figures run wider. */
:root{
  --bg:#f5f6f8; --surface:#fcfcfb; --ink:#14171c; --ink2:#4d5461; --muted:#7a818d; --rule:#dde1e7;
  --accent:#6a2c5e; --accent-soft:#f1e6ee; --code-bg:#eceef2;
  --s1:#2a78d6; --s2:#eb6834; --s3:#1baf7a; --neutral:#8c8a84; --grid:#e1e0d9; --axis:#c3c2b7;
  --seq1:#cde2fb; --crit:#d03b3b; --shade:rgba(208,59,59,.10);
  --f-display:"IBM Plex Sans Condensed","Arial Narrow",system-ui,sans-serif;
  --f-body:"IBM Plex Sans",system-ui,-apple-system,"Segoe UI",sans-serif;
  --f-mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
}
@media (prefers-color-scheme: dark){ :root:not([data-theme="light"]){
  --bg:#101216; --surface:#1a1a19; --ink:#eceef1; --ink2:#c3c7cf; --muted:#8d939d; --rule:#2b2f36;
  --accent:#d9a3cb; --accent-soft:#2b1f28; --code-bg:#20232a;
  --s1:#3987e5; --s2:#d95926; --s3:#199e70; --neutral:#8c8a84; --grid:#2c2c2a; --axis:#383835;
  --seq1:#1c3557; --crit:#e66767; --shade:rgba(230,103,103,.16); color-scheme:dark; } }
:root[data-theme="dark"]{
  --bg:#101216; --surface:#1a1a19; --ink:#eceef1; --ink2:#c3c7cf; --muted:#8d939d; --rule:#2b2f36;
  --accent:#d9a3cb; --accent-soft:#2b1f28; --code-bg:#20232a;
  --s1:#3987e5; --s2:#d95926; --s3:#199e70; --neutral:#8c8a84; --grid:#2c2c2a; --axis:#383835;
  --seq1:#1c3557; --crit:#e66767; --shade:rgba(230,103,103,.16); color-scheme:dark; }
*{box-sizing:border-box}
body{background:var(--bg);color:var(--ink);font:15px/1.6 var(--f-body);margin:0}
.page{max-width:1240px;margin:0 auto;padding-block:40px 80px;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px));
  display:grid;grid-template-columns:220px minmax(0,1fr);gap:48px}
nav.toc{position:sticky;top:calc(24px + env(safe-area-inset-top,0px));align-self:start;font-size:13px;max-height:calc(100vh - 48px);overflow:auto}
nav.toc .lbl{font:600 11px/1 var(--f-body);letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin-bottom:12px}
nav.toc a{display:block;color:var(--ink2);text-decoration:none;padding:5px 0 5px 10px;border-left:1px solid var(--rule)}
nav.toc a:hover,nav.toc a:focus-visible{color:var(--accent);border-left-color:var(--accent);outline:none}
main{min-width:0;max-width:940px}
header.top{border-bottom:1px solid var(--rule);padding-bottom:28px;margin-bottom:12px}
.eyebrow{font:600 12px/1 var(--f-mono);letter-spacing:.06em;color:var(--accent);text-transform:uppercase}
h1{font:600 clamp(30px,4.4vw,46px)/1.08 var(--f-display);letter-spacing:-.01em;margin:14px 0 14px;text-wrap:balance}
.meta{display:flex;flex-wrap:wrap;gap:8px 22px;font:13px/1.4 var(--f-mono);color:var(--ink2)}
.meta b{color:var(--ink);font-weight:600}
h2{font:600 26px/1.2 var(--f-display);margin:56px 0 14px;padding-top:18px;border-top:1px solid var(--rule);text-wrap:balance;scroll-margin-top:24px}
h3{font:600 17px/1.3 var(--f-body);margin:28px 0 8px;text-wrap:balance}
p,li{max-width:70ch}
p{margin:0 0 14px}
ul,ol{padding-left:22px;margin:0 0 16px}
li{margin:0 0 8px}
strong{font-weight:600}
a{color:var(--accent)}
code{font:0.88em var(--f-mono);background:var(--code-bg);padding:1px 5px;border-radius:4px;overflow-wrap:anywhere}
pre{background:var(--code-bg);padding:14px 16px;border-radius:6px;overflow-x:auto;font:13px/1.55 var(--f-mono)}
pre code{background:none;padding:0;word-break:normal}
aside.callout{background:var(--accent-soft);border-radius:8px;padding:16px 20px;margin:20px 0}
aside.callout p{margin:0 0 8px} aside.callout p:last-child{margin:0}
.answers{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin:18px 0 8px}
.answer{background:var(--surface);border:1px solid var(--rule);border-radius:10px;padding:18px 20px;display:grid;grid-template-columns:34px minmax(0,1fr);gap:6px 12px}
.answer .num{font:600 20px/1.2 var(--f-display);color:var(--accent);font-style:italic}
.answer h3{margin:0 0 6px;font-size:15px}
.answer p{font-size:14px;line-height:1.55;margin:0;max-width:none}
figure.chart{margin:24px 0 28px;background:var(--surface);border:1px solid var(--rule);border-radius:10px;padding:10px 10px 12px;overflow-x:auto}
figure.chart svg{display:block;width:100%;height:auto;min-width:560px}
figcaption{font-size:13px;color:var(--ink2);padding:8px 8px 0;line-height:1.5}
figcaption .src{display:block;font:11px var(--f-mono);color:var(--muted);margin-top:2px}
.tablewrap{overflow-x:auto;margin:14px 0 22px;border:1px solid var(--rule);border-radius:8px;background:var(--surface)}
table{border-collapse:collapse;width:100%;font-size:13px}
caption{caption-side:top;text-align:left;font-size:12.5px;color:var(--ink2);padding:10px 12px 8px;font-style:italic}
th,td{padding:7px 12px;text-align:left;vertical-align:top;border-top:1px solid var(--rule)}
th{font-weight:600;color:var(--ink2);font-size:12px;background:var(--bg);min-width:5.5em;line-height:1.35}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums;font-family:var(--f-mono);font-size:12.5px}
td code{font-size:11.5px}
hr{border:0;border-top:1px solid var(--rule);margin:32px 0}
footer{margin-top:56px;padding-top:18px;border-top:1px solid var(--rule);font-size:12.5px;color:var(--muted)}
@media (max-width:980px){ .page{grid-template-columns:minmax(0,1fr);gap:0} nav.toc{position:static;max-height:none;margin-bottom:8px;border-bottom:1px solid var(--rule);padding-bottom:14px}
  nav.toc .links{display:flex;flex-wrap:wrap;gap:4px 14px} nav.toc a{border:0;padding:2px 0} }
@media (max-width:680px){ nav.toc{display:none} .answers{grid-template-columns:minmax(0,1fr)} body{font-size:15px} h2{font-size:23px} }
@media (prefers-reduced-motion:reduce){ *{scroll-behavior:auto!important} }
"""

def write(doc, svgs, path, n_runs, title='Basket DCA Modelação v2', eyebrow='TeraSwap · Analista → Arquitecto · RESULTS-2026-11',
          h1='Basket DCA — modelação v2 com dados reais', extra_meta=None,
          feeds_txt='17 feeds Chainlink verificados on-chain', period_txt='Nov 2021 – Nov 2026 · diário e horário', date_txt='7 Nov 2026'):
    body, toc = to_html_body(doc, svgs)
    toc_html = ''.join(f'<a href="#{a}">{html.escape(t)}</a>' for a, t in toc)
    page = f"""<title>{title}</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&family=IBM+Plex+Sans+Condensed:ital,wght@0,600;1,600&family=IBM+Plex+Sans:wght@400;600&display=swap">
<style>{CSS}</style>
<div class="page">
<nav class="toc" aria-label="Conteúdo"><div class="lbl">Conteúdo</div><div class="links">{toc_html}</div></nav>
<main>
<header class="top">
<div class="eyebrow">{eyebrow}</div>
<h1>{h1}</h1>
<div class="meta"><span><b>{date_txt}</b></span><span>{n_runs} simulações</span><span>{feeds_txt}</span><span>{period_txt}</span><span>Destino: docs/Reports/basket-dca/</span>{("<span>" + extra_meta + "</span>") if extra_meta else ""}</div>
</header>
{body}
<footer>Gerado por <code>python3 run_all.py</code>. Cada número tem ao lado, nos CSV de <code>results/</code>, o cenário completo: par, repartição, datas, cadência, limiar, modo e fontes. Os valores de posição são histórico e nunca promessa.</footer>
</main></div>
"""
    open(path, 'w').write(page)
    return path
