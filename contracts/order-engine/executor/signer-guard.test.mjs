// Tests for signer-guard.js — the pure signer-resolution guard.
//
// [CHORE-KEEPER-HARDENING / P5a HIGH] A configured-but-unwired VAULT_ADDR used to
// (a) suppress the plaintext-key FATAL in validateConfig and (b) fall through to a
// plaintext key in createExecutorAccount — so setting VAULT_ADDR without a real
// Vault silently ran a plaintext mainnet key. These pure helpers make the Vault
// path fail-closed until it is actually wired (VAULT_WIRED).

import { test, describe } from "node:test"
import assert from "node:assert/strict"

import {
  VAULT_WIRED,
  vaultCountsAsManagedSigner,
  shouldRefuseUnwiredVault,
  resolveSignerKind,
} from "./signer-guard.js"

describe("signer-guard — Vault is not a managed signer until wired", () => {
  test("VAULT_WIRED is false (Vault Transit signer not implemented yet)", () => {
    assert.equal(VAULT_WIRED, false)
  })

  test("a configured Vault does NOT count as a managed signer while unwired", () => {
    assert.equal(vaultCountsAsManagedSigner(true), false)
  })

  test("shouldRefuseUnwiredVault is true when VAULT_ADDR is set but Vault is unwired", () => {
    assert.equal(shouldRefuseUnwiredVault(true), true)
    assert.equal(shouldRefuseUnwiredVault(false), false)
  })
})

describe("signer-guard — resolveSignerKind (priority KMS > wired-Vault > plaintext)", () => {
  test("KMS wins over everything", () => {
    assert.equal(resolveSignerKind({ hasKms: true, hasVaultConfigured: true, hasKey: true }), "kms")
  })

  test("VAULT_ADDR + plaintext key resolves to PLAINTEXT (not vault) — so the plaintext guard fires", () => {
    assert.equal(resolveSignerKind({ hasKms: false, hasVaultConfigured: true, hasKey: true }), "plaintext")
  })

  test("VAULT_ADDR alone (no KMS, no key) resolves to NONE — an unwired vault cannot sign", () => {
    assert.equal(resolveSignerKind({ hasKms: false, hasVaultConfigured: true, hasKey: false }), "none")
  })

  test("plaintext key alone resolves to plaintext; nothing resolves to none", () => {
    assert.equal(resolveSignerKind({ hasKms: false, hasVaultConfigured: false, hasKey: true }), "plaintext")
    assert.equal(resolveSignerKind({ hasKms: false, hasVaultConfigured: false, hasKey: false }), "none")
  })
})
