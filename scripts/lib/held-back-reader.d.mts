// No `(x) => y` function type, method signature or call signature may appear in this file: eslint-config-next
// parses `.mts` with the Babel parser (its `next/typescript` block covers only `*.ts`/`*.tsx`), whose
// TSFunctionType has `parameters`, not `params`, so `@typescript-eslint/no-unused-vars` throws
// "node.params is not iterable". A `declare function` is handled, so the callback is typed through it.
declare function releaseWhen(stderrSoFar: string): boolean

export function runWithHeldBackStdout(o: {
  command: string
  args: string[]
  cwd?: string
  env?: Record<string, string | undefined>
  input?: string
  releaseWhen: typeof releaseWhen
}): Promise<{ code: number | null; signal: string | null; stdout: Buffer; stderr: string }>

export function runWithHeldBackOutput(o: {
  command: string
  args: string[]
  cwd?: string
  env?: Record<string, string | undefined>
  input?: string
}): Promise<{ code: number | null; signal: string | null; stdout: Buffer; stderr: Buffer; signalled: boolean }>
