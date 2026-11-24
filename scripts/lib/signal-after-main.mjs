/**
 * [fix/script-stdout-truncated-on-exit] Test runner: `node signal-after-main.mjs <script> [args...]` runs <script> as if it were the
 * entry point (process.argv[1] = the script, its own arguments after it), and writes one line to file descriptor 3 as soon as the
 * script's module has finished evaluating (top-level await included), BEFORE its output has been drained.
 *
 * A script that ends by itself reaches that line with its output still queued, so the reader can start then and gets all of it. A
 * script that calls process.exit never reaches it: the process dies inside the import with whatever the pipe had taken, and the
 * reader (released by the child's exit) sees a cut report. Used with held-back-reader.mjs `releaseOnFd3`, for scripts that have no
 * natural "last stderr line" to release on.
 */
import { writeSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [script, ...rest] = process.argv.slice(2)
if (!script) {
  console.error('usage: signal-after-main.mjs <script> [args...]')
  process.exitCode = 2
} else {
  const abs = resolve(script)
  process.argv = [process.argv[0], abs, ...rest]
  await import(pathToFileURL(abs).href)
  writeSync(3, 'main-done\n')
}
