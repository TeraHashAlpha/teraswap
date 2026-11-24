export function runWithHeldBackStdout(o: {
  command: string
  args: string[]
  cwd?: string
  env?: Record<string, string | undefined>
  input?: string
  releaseWhen: (stderrSoFar: string) => boolean
}): Promise<{ code: number | null; signal: string | null; stdout: Buffer; stderr: string }>
