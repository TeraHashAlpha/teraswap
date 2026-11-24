/**
 * [fix/script-stdout-truncated-on-exit] Test preload (`node --import <this> script.mjs`): writes one line to file descriptor 3 at the
 * script's EXIT DECISION, which is after all of its output is queued and before the output can be drained:
 *   - a call to process.exit (the bug: the process dies right after, with whatever the pipe had taken), or
 *   - exitAfterDrain's marker (an empty write to stdout), the fix's way of saying "everything is queued, end when drained".
 * With held-back-reader.mjs `runWithHeldBackOutput` the reader starts there, so the result does not depend on timing: the bug loses
 * what is queued, the fix keeps it. A script that ends by itself has no such point: use signal-after-main.mjs for those.
 */
import { writeSync } from 'node:fs'

let signalled = false
const signal = () => {
  if (signalled) return
  signalled = true
  try { writeSync(3, 'exit-point\n') } catch { /* fd 3 not provided: not under the harness */ }
}

const realExit = process.exit
process.exit = function exit(code) {
  signal()
  return realExit.call(process, code)
}

const realWrite = process.stdout.write
process.stdout.write = function write(chunk, ...rest) {
  if (chunk === '') signal()
  return realWrite.call(this, chunk, ...rest)
}
