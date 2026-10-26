/** Pack number spec: addresses are lowercase `0x` + 4…4 (`0xd4a1…962d`); the full address is for hover/copy only. */
export function shortAddress(address: string): string {
  const a = address.toLowerCase()
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}
