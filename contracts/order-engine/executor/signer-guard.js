// signer-guard.js — pure signer-resolution guard (no I/O, no viem, never throws).
//
// [CHORE-KEEPER-HARDENING / P5a HIGH] The HashiCorp Vault Transit signer is NOT
// implemented. Until it is, a configured VAULT_ADDR must NOT be treated as a
// managed signer: previously it (a) suppressed the plaintext-key FATAL in
// validateConfig and (b) let createExecutorAccount fall through to
// privateKeyToAccount — so `VAULT_ADDR` set (with a leftover EXECUTOR_PRIVATE_KEY)
// silently ran a PLAINTEXT mainnet key behind a single log line. These helpers
// make the Vault path fail-closed: it counts as no signer, and the caller must
// throw rather than downgrade. Flip VAULT_WIRED to true only when the real Vault
// signer lands.

/** True only when the Vault Transit signer is actually implemented + wired. */
export const VAULT_WIRED = false

/** A configured Vault counts as a managed signer ONLY once wired. */
export function vaultCountsAsManagedSigner(hasVaultConfigured) {
  return !!hasVaultConfigured && VAULT_WIRED
}

/** createExecutorAccount must THROW (not fall through to a plaintext key) when a
 *  Vault is configured but unwired. */
export function shouldRefuseUnwiredVault(hasVaultConfigured) {
  return !!hasVaultConfigured && !VAULT_WIRED
}

/**
 * The signer kind that will actually be used, honouring priority
 * KMS > wired-Vault > plaintext. An unwired Vault never yields "vault".
 * @param {{ hasKms: boolean, hasVaultConfigured: boolean, hasKey: boolean }} p
 * @returns {"kms"|"vault"|"plaintext"|"none"}
 */
export function resolveSignerKind({ hasKms, hasVaultConfigured, hasKey }) {
  if (hasKms) return "kms"
  if (vaultCountsAsManagedSigner(hasVaultConfigured)) return "vault"
  if (hasKey) return "plaintext"
  return "none"
}
