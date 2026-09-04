/**
 * Minimal ambient stub of DefiLlama/dimension-adapters' `adapters/types.ts`,
 * scoped to the members the generated TeraSwap adapter actually imports.
 * `getLogs` returning `Promise<any[]>` matches the real upstream signature —
 * see __tests__/defillama-upstream-compiles.test.ts for why that matters.
 */
export type FetchOptions = {
  chain: string
  getLogs: (params: { target?: string; eventAbi?: string }) => Promise<any[]>
  createBalances: () => { add: (token: string, amount: bigint, metric?: string) => void }
}

export type SimpleAdapter = {
  version: number
  pullHourly: boolean
  fetch: (options: FetchOptions) => Promise<Record<string, unknown>>
  adapter: Record<string, unknown>
  methodology: Record<string, string>
  breakdownMethodology: Record<string, Record<string, string>>
}
