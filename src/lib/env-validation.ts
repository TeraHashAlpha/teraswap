// ── Environment Variable Validation ─────────────────────────────────────────
// Validates critical env vars at build/startup time.
// Import this in layout.tsx or providers.tsx so missing vars fail fast.

import { DISABLED_SOURCES } from './constants'

type EnvRule = {
  key: string
  required: boolean
  /** If true, key is server-only (no NEXT_PUBLIC_ prefix) */
  serverOnly?: boolean
  /** Human-readable description for error messages */
  label: string
  /** Optional validation regex */
  pattern?: RegExp
}

const RULES: EnvRule[] = [
  // ── RPC ──
  {
    key: 'NEXT_PUBLIC_RPC_URL',
    required: true,
    label: 'Primary RPC URL (Alchemy/Infura)',
    pattern: /^https?:\/\//,
  },
  // ── WalletConnect ──
  {
    key: 'NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID',
    required: true,
    label: 'WalletConnect Project ID',
  },
  // ── Fees ──
  {
    key: 'NEXT_PUBLIC_FEE_RECIPIENT',
    required: true,
    label: 'Fee recipient wallet address',
    pattern: /^0x[a-fA-F0-9]{40}$/,
  },
  {
    key: 'NEXT_PUBLIC_FEE_COLLECTOR',
    required: true,
    label: 'FeeCollector contract address',
    pattern: /^0x[a-fA-F0-9]{40}$/,
  },
  // ── Supabase (public) ──
  {
    key: 'NEXT_PUBLIC_SUPABASE_URL',
    required: true,
    label: 'Supabase project URL',
    pattern: /^https:\/\/.*\.supabase\.co$/,
  },
  {
    key: 'NEXT_PUBLIC_SUPABASE_ANON_KEY',
    required: true,
    label: 'Supabase anon key',
  },
  // ── Aggregator API Keys (server-only) ──
  {
    key: 'ONEINCH_API_KEY',
    required: false, // optional — graceful degradation if not set
    serverOnly: true,
    label: '1inch API key (server-only)',
  },
  // [RQ-2026-06-11] Read by lib/api.ts (Odos quotes are skipped when absent) but
  // was never registered here — an unset key degraded Odos silently with no
  // startup warning, unlike its 1inch/0x siblings.
  {
    key: 'ODOS_API_KEY',
    required: false,
    serverOnly: true,
    label: 'Odos API key (server-only — Odos quotes skipped when absent)',
  },
  // ── Alchemy Enhanced API (server-only) ──
  // [CHORE-POLISH-3 P4 / E3-I-02] One key serves BOTH eth-mainnet and
  // base-mainnet since E-3 (portfolio Base discovery). Warning-only: when
  // absent, /api/portfolio/tokens 503s and usePortfolio falls back to the
  // multicall path. NOTE the app-scope requirement in the label — a key
  // scoped to mainnet only SILENTLY degrades Base discovery to 503 (Alchemy
  // rejects base-mainnet calls), which env validation cannot detect.
  {
    key: 'ALCHEMY_API_KEY',
    required: false,
    serverOnly: true,
    label:
      'Alchemy API key (server-only — must be app-scoped to BOTH eth-mainnet ' +
      'AND base-mainnet; a mainnet-only key degrades Base portfolio discovery to 503)',
  },
  // ── Supabase (server-only) ──
  {
    key: 'SUPABASE_URL',
    required: false,
    serverOnly: true,
    label: 'Supabase URL (server-side)',
  },
  {
    key: 'SUPABASE_SERVICE_ROLE_KEY',
    required: false,
    serverOnly: true,
    label: 'Supabase service role key (server-side)',
  },
]

// ── Zero-address guard ──────────────────────────────────────────────────────
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

export function validateEnv(): { valid: boolean; errors: string[]; warnings: string[] } {
  const errors: string[] = []
  const warnings: string[] = []

  for (const rule of RULES) {
    // Skip server-only vars when running in browser
    if (rule.serverOnly && typeof window !== 'undefined') continue

    const value = process.env[rule.key]

    if (!value || value.trim() === '') {
      if (rule.required) {
        errors.push(`❌ Missing required env var: ${rule.key} (${rule.label})`)
      } else {
        warnings.push(`⚠️  Optional env var not set: ${rule.key} (${rule.label})`)
      }
      continue
    }

    // Pattern validation
    if (rule.pattern && !rule.pattern.test(value)) {
      errors.push(
        `❌ Invalid format for ${rule.key}: expected to match ${rule.pattern} (${rule.label})`
      )
    }

    // Zero-address guard for address fields
    if (rule.pattern?.toString().includes('0x') && value === ZERO_ADDRESS) {
      errors.push(
        `❌ ${rule.key} is set to zero address — fees will be burned! Set a real address.`
      )
    }
  }

  // ── Cross-checks ──

  // [dead-sources-are-loud, 2026-09] Required-when-enabled: a source's API
  // key must not be able to silently 401 forever. ZEROX_API_KEY used to be
  // OPTIONAL — a missing or expired key never failed a build or boot, so 0x
  // 401'd quietly on every quote (measured 2026-09-02; the same failure mode
  // as the July silent-sources incident). Computed here (not a static RULES
  // entry) so it stays in sync with DISABLED_SOURCES at call time: the key
  // is required only while '0x' is enabled (not in DISABLED_SOURCES) — if
  // 0x is ever disabled, its key requirement lapses with it.
  //
  // OpenOcean (src/lib/adapters/openocean.ts) sends no Authorization/API-key
  // header at all — its v4 quote endpoint is unauthenticated — so there is no
  // OpenOcean key variable to add here.
  if (typeof window === 'undefined' && !('0x' in DISABLED_SOURCES)) {
    const zeroxKey = process.env.ZEROX_API_KEY
    if (!zeroxKey || zeroxKey.trim() === '') {
      errors.push(
        '❌ Missing required env var: ZEROX_API_KEY — source "0x" is enabled ' +
        '(not in DISABLED_SOURCES) and its adapter requires this key to ' +
        'authenticate. Set ZEROX_API_KEY or add "0x" to DISABLED_SOURCES ' +
        'before deploying.'
      )
    }
  }

  // BLOCK if NEXT_PUBLIC_ API keys are set — they leak keys into the browser bundle.
  // The fallbacks were removed from constants.ts; these vars must NOT be used.
  if (process.env.NEXT_PUBLIC_1INCH_API_KEY) {
    errors.push(
      '❌ NEXT_PUBLIC_1INCH_API_KEY is set — this exposes the key in the browser bundle! ' +
      'Remove it and use ONEINCH_API_KEY (server-only) instead.'
    )
  }
  if (process.env.NEXT_PUBLIC_0X_API_KEY) {
    errors.push(
      '❌ NEXT_PUBLIC_0X_API_KEY is set — this exposes the key in the browser bundle! ' +
      'Remove it and use ZEROX_API_KEY (server-only) instead.'
    )
  }

  return { valid: errors.length === 0, errors, warnings }
}

/**
 * Call this at app startup (e.g. in providers.tsx or a server component).
 * In production, throws on critical missing vars.
 * In development, logs warnings but continues.
 */
export function assertEnv(): void {
  const { valid, errors, warnings } = validateEnv()

  // Always log warnings
  for (const w of warnings) {
    console.warn(`[TeraSwap Env] ${w}`)
  }

  if (!valid) {
    const msg = [
      '═══════════════════════════════════════════════════════',
      '  TeraSwap — Environment Configuration Errors',
      '═══════════════════════════════════════════════════════',
      '',
      ...errors,
      '',
      'Fix these in your .env.local (dev) or hosting env vars (prod).',
      '═══════════════════════════════════════════════════════',
    ].join('\n')

    if (process.env.NODE_ENV === 'production') {
      // In production, fail hard so the build/deploy stops
      throw new Error(msg)
    } else {
      // In development, warn loudly but don't crash
      console.error(msg)
    }
  }
}
