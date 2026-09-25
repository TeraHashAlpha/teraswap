/**
 * [R1 Group H] The partner Velora writes into Augustus V6.2 `partnerAndFee` by
 * itself — our adapter (src/lib/adapters/velora.ts) sends no partner
 * parameter. Observed as `partnerAndFee >> 96` in both captures in
 * __fixtures__/velora-augustus-uniswapv3-arbitrum.ts (1 bps, IS_CAP_SURPLUS).
 *
 * calldata-recipient.ts admits a non-zero partner only if it equals this
 * address. velora-partner.test.ts pins the literal to the captured calldata:
 * if Velora rotates its partner, those routes fail closed, the R1 reason logs
 * the new word, and a fresh capture fails that test.
 */
export const VELORA_DEFAULT_PARTNER = '0x45a6e007c874Ffc6321D6fB90eAC272Dd6864bFA' as const
