'use client'

/**
 * [SPRINT token-selector-ux P1] Shared token logo with a fallback chain so NO token
 * ever renders a blank circle.
 *
 * The TokenSelector previously used bare `<img onError={display:none}>` in three
 * places (trigger, popular chip, TokenRow). When the catalog logoURI 404s (the old
 * 1inch icons are mainnet-keyed → 404 on Base, 403 for some mainnet entries) the
 * image vanished and left an empty circle. <TokenLogo> walks a deterministic,
 * de-duplicated fallback chain of reliable sources instead:
 *   1. token.logoURI                       (the catalog URL: local /tokens/*.png for
 *                                            core brands, else DefiLlama)
 *   2. DefiLlama token-icons, keyed by     (chainId-aware, lowercase address — no
 *      chainId + LOWERCASE address           checksum-casing pitfall; 200s on both
 *                                            mainnet AND Base for the long tail)
 *   3. Trust Wallet assets CDN, keyed by   (a DIFFERENT per-chain source, so a
 *      the EIP-55 CHECKSUMMED address        DefiLlama miss still has a real shot)
 *   4. a GENERATED AVATAR                   (deterministic colour from the address
 *      (TRUE last resort, never blank)        + the symbol's initials — now rare)
 *
 * Steps 1–3 are <img> elements; an onError advances the internal index. The list is
 * de-duplicated by exact URL string, so a catalog token whose logoURI is ALREADY the
 * DefiLlama URL never retries the same src. Step 4 is pure DOM (a coloured rounded
 * div with initials) and can never error, so the fallback always terminates on
 * something visible.
 */
import { useMemo, useState } from 'react'
import { getAddress } from 'viem'
import type { Token } from '@/lib/tokens'

interface Props {
  token: Pick<Token, 'address' | 'symbol' | 'logoURI' | 'chainId'>
  /** Rendered width/height in px. Default 32. */
  size?: number
  className?: string
}

// chainId → Trust Wallet `blockchains/<chain>` folder. Default ethereum.
const TRUST_WALLET_CHAIN: Record<number, string> = {
  1: 'ethereum',
  8453: 'base',
}

/**
 * DefiLlama token-icons URL. chainId-aware and keyed by the LOWERCASE address, so
 * there is no checksum-casing pitfall — it resolves real logos on both mainnet (1)
 * and Base (8453). Defaults to mainnet when chainId is absent.
 */
function defiLlamaLogo(address: string, chainId?: number): string {
  return `https://token-icons.llamao.fi/icons/tokens/${chainId ?? 1}/${address.toLowerCase()}?h=48&w=48`
}

/**
 * Trust Wallet assets logo URL, keyed by the EIP-55 checksummed address. Returns
 * null when the address can't be checksummed (native ETH sentinel 0xeeee…eeee,
 * empty/garbage input) — the caller then skips straight to the generated avatar.
 */
function trustWalletLogo(address: string, chainId?: number): string | null {
  let checksummed: string
  try {
    checksummed = getAddress(address)
  } catch {
    return null
  }
  const chain = TRUST_WALLET_CHAIN[chainId ?? 1] ?? 'ethereum'
  return `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/${chain}/assets/${checksummed}/logo.png`
}

/** Deterministic hue (0–359) from the lowercase address character codes. */
function hueFromAddress(address: string): number {
  const lower = address.toLowerCase()
  let sum = 0
  for (let i = 0; i < lower.length; i++) sum += lower.charCodeAt(i)
  return sum % 360
}

/** The 1–2 uppercase initials shown on the generated avatar. */
function initials(symbol: string): string {
  return (symbol || '?').replace(/[^a-zA-Z0-9]/g, '').slice(0, 2).toUpperCase() || '?'
}

export default function TokenLogo({ token, size = 32, className }: Props) {
  // Ordered, DE-DUPLICATED list of <img> src candidates, reliable sources first.
  // Index === sources.length ⇒ generated avatar (the TRUE last resort).
  //   1. token.logoURI                     (catalog: local /tokens/*.png or DefiLlama)
  //   2. DefiLlama (chainId + lowercase)   (200s on mainnet AND Base for the long tail)
  //   3. Trust Wallet (per-chain checksum) (a different source; skipped if not 0x)
  // Dedupe by exact URL string so a catalog logoURI that ALREADY equals the DefiLlama
  // URL is not pushed (and retried) twice.
  const sources = useMemo(() => {
    const list: string[] = []
    const push = (url: string | null) => {
      if (url && !list.includes(url)) list.push(url)
    }
    if (typeof token.logoURI === 'string' && token.logoURI.length > 0) push(token.logoURI)
    push(defiLlamaLogo(token.address, token.chainId))
    push(trustWalletLogo(token.address, token.chainId))
    return list
  }, [token.logoURI, token.address, token.chainId])

  const [index, setIndex] = useState(0)
  // Reset the fallback position when the token changes IN PLACE (e.g. the trigger's
  // single <TokenLogo> as `selected` switches). Without this, a new token whose
  // predecessor exhausted its sources would wrongly start at the generated avatar.
  // Reset-during-render (no effect flash) — the standard React idiom.
  const [prevAddress, setPrevAddress] = useState(token.address)
  if (token.address !== prevAddress) {
    setPrevAddress(token.address)
    setIndex(0)
  }

  const dimension = { width: size, height: size }

  // Fallback chain exhausted → deterministic generated avatar (never blank).
  if (index >= sources.length) {
    const hue = hueFromAddress(token.address)
    return (
      <div
        aria-hidden="true"
        title={token.symbol}
        className={`inline-flex items-center justify-center rounded-full font-semibold text-white ${className ?? ''}`}
        style={{
          ...dimension,
          backgroundColor: `hsl(${hue}, 60%, 45%)`,
          fontSize: Math.max(9, Math.round(size * 0.4)),
          lineHeight: 1,
        }}
      >
        {initials(token.symbol)}
      </div>
    )
  }

  return (
    <img
      src={sources[index]}
      alt={token.symbol}
      className={`rounded-full bg-surface-tertiary ${className ?? ''}`}
      style={dimension}
      onError={() => setIndex((i) => i + 1)}
    />
  )
}
