// ── Environment Variable Validation ─────────────────────────────────────────
// Validates critical env vars at build/startup time.
// Import this in layout.tsx or providers.tsx so missing vars fail fast.

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
  {
    key: 'ZEROX_API_KEY',
    required: false,
    serverOnly: true,
    label: '0x API key (server-only)',
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
  // Warn if NEXT_PUBLIC_ API keys are still set (should be server-only)
  if (process.env.NEXT_PUBLIC_1INCH_API_KEY) {
    warnings.push(
      '⚠️  NEXT_PUBLIC_1INCH_API_KEY is set — this exposes the key in the browser bundle. ' +
      'Use ONEINCH_API_KEY (server-only) instead.'
    )
  }
  if (process.env.NEXT_PUBLIC_0X_API_KEY) {
    warnings.push(
      '⚠️  NEXT_PUBLIC_0X_API_KEY is set — this exposes the key in the browser bundle. ' +
      'Use ZEROX_API_KEY (server-only) instead.'
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
