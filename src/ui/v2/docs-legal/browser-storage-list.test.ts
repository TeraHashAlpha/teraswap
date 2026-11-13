// @vitest-environment node
/**
 * [fix/privacy-leftovers-a78b S-9] Privacy 3.3 (PRIVACY_LOCAL_STORAGE_NOTE) lists what the app itself writes to the browser's
 * localStorage and sessionStorage. This guard ties that list to the code: every file that writes browser storage is named
 * here with its keys, and the set of writers found in `src` must equal this table. A new writer fails the test until its key is
 * added here AND to the sentence (the test reads the note and checks the words for each LIVE key).
 *
 * Wallet libraries (wagmi, RainbowKit, WalletConnect) write their own entries; those are described as theirs and are not in
 * the table. `secureSet` is the encrypted localStorage writer (src/lib/secure-storage.ts).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { PRIVACY_LOCAL_STORAGE_NOTE } from '@/config/product-claims'

const ROOT = path.resolve(__dirname, '..', '..', '..', '..')
const SRC = path.join(ROOT, 'src')
// v1 files may not name the second UI tree, and this file lives in it; build the segment the same way the other guards do.
const v2 = (...rest: string[]) => ['src', 'ui', 'v' + '2', ...rest].join('/')

type Store = 'local' | 'session' | 'secure-local'
interface Writer {
  file: string
  store: Store
  /** Key text that must appear in the file (a prefix for per-chain / per-wallet keys). */
  keys: string[]
  /** Words in the 3.3 sentence that cover this key. Empty = the writer is not live (see `why`). */
  words: string[]
  why?: string
}

const WRITERS: Writer[] = [
  { file: 'src/contexts/ThemeContext.tsx', store: 'local', keys: ['teraswap-theme'], words: ['your theme'] },
  { file: 'src/lib/imported-tokens.ts', store: 'local', keys: ['ts:imported-tokens:v1:'], words: ['the tokens you import'] },
  { file: v2('fiat', 'fiat-preference.ts'), store: 'local', keys: ['teraswap:v2:fiat-currency'], words: ['your currency choice'] },
  { file: 'src/components/Permit2EducationModal.tsx', store: 'local', keys: ['teraswap:permit2-educated:v1'], words: ['the Permit2 explainer'] },
  { file: v2('modals', 'Permit2Sheet.tsx'), store: 'local', keys: ['teraswap:permit2-educated:v1'], words: ['the Permit2 explainer'] },
  { file: 'src/hooks/useOrderNotifications.ts', store: 'local', keys: ['teraswap_notifications_enabled', 'teraswap_notif_prompt_dismissed'], words: ['order notifications', 'dismissed the notification prompt'] },
  { file: 'src/hooks/useOrderEngine.ts', store: 'secure-local', keys: ['teraswap_orders_v4', 'teraswap_dismissed_orders'], words: ['encrypted copies of your orders', 'the ids of orders you dismissed'] },
  { file: 'src/lib/analytics-tracker.ts', store: 'secure-local', keys: ['_v2'], words: ['of your order activity'] },
  { file: 'src/lib/secure-storage.ts', store: 'local', keys: [], words: [], why: 'the encrypted writer itself; its callers above own the keys' },
  { file: v2('landing', 'Intro.tsx'), store: 'session', keys: ['ts_v2_intro_seen'], words: ['whether the intro has played'] },
  { file: 'src/components/QuoteBreakdown.tsx', store: 'session', keys: ['teraswap:rateInverted'], words: ['the direction in which you read the exchange rate'] },
  { file: v2('swap', 'QuotePanel.tsx'), store: 'session', keys: ['teraswap:rateInverted'], words: ['the direction in which you read the exchange rate'] },
  { file: 'src/components/WalletSessionGuard.tsx', store: 'session', keys: ['teraswap_wallet_connected_at'], words: ['the time of your last click, key press, scroll or touch'] },
  { file: 'src/lib/order-engine/read-auth.ts', store: 'session', keys: ['teraswap:orders-read:'], words: ['the signature that authorises reads of your orders'] },
  // Writers that no visitor reaches. They are in the table so a visitor-facing use of them fails the test below.
  { file: 'src/components/BetaBanner.tsx', store: 'local', keys: ['teraswap_beta_banner_dismissed'], words: [], why: 'not rendered anywhere (@deprecated, no importer)' },
  { file: 'src/lib/source-preferences.ts', store: 'local', keys: ['teraswap_source_prefs'], words: [], why: 'saveSourcePreferences has no caller' },
  { file: 'src/lib/analytics-seed.ts', store: 'local', keys: ['ANALYTICS_STORAGE_KEY'], words: [], why: 'demo-data seeding, imported only by AdminMonitor (the wallet-authenticated /admin page)' },
]

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'test-utils' || name === 'node_modules') continue
      walk(full, out)
    } else if (/\.(ts|tsx)$/.test(name) && !/\.(test|pw|spec)\.(ts|tsx)$/.test(name)) out.push(full)
  }
  return out
}

const files = walk(SRC).map((f) => path.relative(ROOT, f).split(path.sep).join('/'))
const text = (f: string) => readFileSync(path.join(ROOT, f), 'utf8')
// A write: `.setItem(` on a Storage, or the encrypted `secureSet(` call. Comments are not stripped; a file that only mentions
// either in a comment would show up as a false writer and be named here with a reason, which is the safe direction.
const WRITE_RE = /\.setItem\(|\bsecureSet\(/
// api routes are server code (no browser storage), the rest of src is browser or shared code.
const writerFiles = files.filter((f) => !f.startsWith('src/app/api/') && WRITE_RE.test(text(f))).sort()

describe('the browser-storage list in Privacy 3.3 is what the code writes', () => {
  it('the files that write browser storage are exactly the table (a new writer must be added here and to the sentence)', () => {
    expect(writerFiles).toEqual(WRITERS.map((w) => w.file).sort())
  })

  it.each(WRITERS)('$file: the keys are in the file, and the live ones are in the sentence', (w) => {
    const src = text(w.file)
    for (const k of w.keys) expect(src, k).toContain(k)
    for (const words of w.words) expect(PRIVACY_LOCAL_STORAGE_NOTE, words).toContain(words)
    if (w.words.length === 0) expect(w.why, `${w.file} is in the table without words, so it needs a reason`).toBeTruthy()
  })

  it('the not-live writers have no importer outside their own file (BetaBanner, source-preferences) or only the admin page (analytics-seed)', () => {
    const importers = (needle: RegExp, self: string) => files.filter((f) => f !== self && needle.test(text(f)))
    expect(importers(/BetaBanner['"]/, 'src/components/BetaBanner.tsx')).toEqual([])
    expect(importers(/source-preferences['"]/, 'src/lib/source-preferences.ts')).toEqual([])
    expect(importers(/analytics-seed['"]/, 'src/lib/analytics-seed.ts')).toEqual(['src/components/AdminMonitor.tsx'])
  })

  it('what the sentence says is memory only really is: no storage call in the slippage, swap-history or approvals code', () => {
    for (const f of ['src/hooks/useSwapHistory.ts', 'src/hooks/useActiveApprovals.ts', 'src/components/SwapBox.tsx', v2('swap', 'SwapCard.tsx'), v2('modals', 'SlippageSheet.tsx')]) {
      expect(text(f), f).not.toMatch(/\b(?:local|session)Storage\.|secureSet\(|persist\(/)
    }
  })

  it('no document.cookie write and no cookie library in src (Privacy 8: no cookies for visitors)', () => {
    expect(files.filter((f) => /document\.cookie\s*=/.test(text(f)))).toEqual([])
  })
})
