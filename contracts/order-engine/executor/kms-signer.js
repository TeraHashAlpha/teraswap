/**
 * TeraSwap KMS Signer — AWS KMS + HashiCorp Vault integration
 *
 * [C-02/B-01] Replaces plaintext EXECUTOR_PRIVATE_KEY with HSM-backed signing.
 * The private key never leaves the HSM — only signatures are returned.
 *
 * SETUP (AWS KMS):
 *   1. Create asymmetric key in AWS KMS:
 *      aws kms create-key --key-usage SIGN_VERIFY \
 *        --customer-master-key-spec ECC_SECG_P256K1 \
 *        --description "TeraSwap Executor Signing Key"
 *
 *   2. Note the KeyId from the response
 *
 *   3. Create IAM policy for the executor:
 *      {
 *        "Version": "2012-10-17",
 *        "Statement": [{
 *          "Effect": "Allow",
 *          "Action": ["kms:Sign", "kms:GetPublicKey"],
 *          "Resource": "arn:aws:kms:REGION:ACCOUNT:key/KEY_ID"
 *        }]
 *      }
 *
 *   4. Set environment variables:
 *      KMS_KEY_ID=arn:aws:kms:us-east-1:123456789:key/your-key-id
 *      KMS_REGION=us-east-1
 *
 * SETUP (HashiCorp Vault):
 *   1. Enable Transit secrets engine:
 *      vault secrets enable transit
 *
 *   2. Create signing key:
 *      vault write transit/keys/teraswap-executor type=ecdsa-p256k1
 *
 *   3. Set environment variables:
 *      VAULT_ADDR=https://vault.yourcompany.com
 *      VAULT_TOKEN=hvs.your-token
 *      VAULT_KEY_NAME=teraswap-executor
 */

import { ethers } from "ethers"

// ── AWS KMS Signer ──────────────────────────────────────────────

export class AwsKmsSigner extends ethers.AbstractSigner {
  #keyId
  #region
  #kmsClient
  #address

  constructor(keyId, region, provider) {
    super(provider)
    this.#keyId = keyId
    this.#region = region
    this.#kmsClient = null
    this.#address = null
  }

  async #getKmsClient() {
    if (this.#kmsClient) return this.#kmsClient

    // Dynamic import — only needed when KMS is used
    const { KMSClient, SignCommand, GetPublicKeyCommand } = await import("@aws-sdk/client-kms")
    this.#kmsClient = new KMSClient({ region: this.#region })
    return this.#kmsClient
  }

  async getAddress() {
    if (this.#address) return this.#address

    const kms = await this.#getKmsClient()
    const { GetPublicKeyCommand } = await import("@aws-sdk/client-kms")

    const response = await kms.send(new GetPublicKeyCommand({ KeyId: this.#keyId }))
    const publicKeyDer = Buffer.from(response.PublicKey)

    // DER-encoded SubjectPublicKeyInfo → uncompressed EC point
    // secp256k1 public key starts at offset 23 in DER encoding (65 bytes uncompressed)
    const uncompressed = publicKeyDer.slice(-65)
    this.#address = ethers.computeAddress(ethers.hexlify(uncompressed))

    return this.#address
  }

  connect(provider) {
    return new AwsKmsSigner(this.#keyId, this.#region, provider)
  }

  async signTransaction(tx) {
    const unsignedTx = ethers.Transaction.from(tx)
    const hash = unsignedTx.unsignedHash

    const signature = await this.#kmsSign(hash)
    unsignedTx.signature = signature

    return unsignedTx.serialized
  }

  async signMessage(message) {
    const hash = ethers.hashMessage(message)
    return this.#kmsSign(hash)
  }

  async signTypedData(domain, types, value) {
    const hash = ethers.TypedDataEncoder.hash(domain, types, value)
    return this.#kmsSign(hash)
  }

  async #kmsSign(digestHex) {
    const kms = await this.#getKmsClient()
    const { SignCommand } = await import("@aws-sdk/client-kms")

    const digest = ethers.getBytes(digestHex)

    const response = await kms.send(new SignCommand({
      KeyId: this.#keyId,
      Message: digest,
      MessageType: "DIGEST",
      SigningAlgorithm: "ECDSA_SHA_256",
    }))

    // KMS returns DER-encoded ECDSA signature → decode to r, s
    const derSig = Buffer.from(response.Signature)
    const { r, s } = decodeDerSignature(derSig)

    // Determine recovery parameter (v)
    const address = await this.getAddress()
    for (let v = 27; v <= 28; v++) {
      try {
        const sig = ethers.Signature.from({ r, s, v })
        const recovered = ethers.recoverAddress(digestHex, sig)
        if (recovered.toLowerCase() === address.toLowerCase()) {
          return sig.serialized
        }
      } catch {
        continue
      }
    }

    throw new Error("KMS signature recovery failed — could not determine v")
  }
}

// ── DER Signature Decoder ──────────────────────────────────────

function decodeDerSignature(der) {
  // DER: 0x30 [total-len] 0x02 [r-len] [r] 0x02 [s-len] [s]
  let offset = 2 // Skip 0x30 + total length

  // R
  if (der[offset] !== 0x02) throw new Error("Invalid DER: expected 0x02 for R")
  offset++
  const rLen = der[offset++]
  let r = der.slice(offset, offset + rLen)
  offset += rLen

  // S
  if (der[offset] !== 0x02) throw new Error("Invalid DER: expected 0x02 for S")
  offset++
  const sLen = der[offset++]
  let s = der.slice(offset, offset + sLen)

  // Remove leading zero padding (DER uses signed integers)
  if (r[0] === 0x00 && r.length === 33) r = r.slice(1)
  if (s[0] === 0x00 && s.length === 33) s = s.slice(1)

  // Ensure s is in lower half of curve order (EIP-2)
  const curveOrder = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141")
  let sBigInt = BigInt("0x" + Buffer.from(s).toString("hex"))
  if (sBigInt > curveOrder / 2n) {
    sBigInt = curveOrder - sBigInt
  }

  return {
    r: "0x" + Buffer.from(r).toString("hex").padStart(64, "0"),
    s: "0x" + sBigInt.toString(16).padStart(64, "0"),
  }
}

// ── Factory: Create signer based on environment ────────────────

export async function createExecutorSigner(provider) {
  const kmsKeyId = process.env.KMS_KEY_ID
  const kmsRegion = process.env.KMS_REGION || "us-east-1"
  const vaultAddr = process.env.VAULT_ADDR
  const privateKey = process.env.EXECUTOR_PRIVATE_KEY

  // Priority: KMS > Vault > Plaintext key
  if (kmsKeyId) {
    console.log("[C-02] Using AWS KMS signer (key never leaves HSM)")
    const signer = new AwsKmsSigner(kmsKeyId, kmsRegion, provider)
    const address = await signer.getAddress()
    console.log(`[C-02] KMS executor address: ${address}`)
    return signer
  }

  if (vaultAddr) {
    console.log("[C-02] Vault signer configured but not yet implemented")
    console.log("[C-02] Falling back to plaintext key — implement Vault integration for production")
    // TODO: Implement HashiCorp Vault Transit signer
  }

  if (privateKey) {
    console.warn("[C-02] WARNING: Using plaintext private key — migrate to KMS for mainnet!")
    return new ethers.Wallet(privateKey, provider)
  }

  throw new Error("No signing method configured. Set KMS_KEY_ID, VAULT_ADDR, or EXECUTOR_PRIVATE_KEY")
}
