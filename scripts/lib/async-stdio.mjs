/**
 * [fix/script-stdout-truncated-on-exit] Test preload (`node --import <this> script.mjs`): SIMULATES the asynchronous write of a pipe for
 * output too small to fill a real one. stdout and stderr accept a write, queue it, and hand it to the OS on the next turn of the event
 * loop (setImmediate). A script that ends by itself keeps every byte (the pending immediate keeps the loop alive until it ran); a
 * script that calls process.exit while something is queued loses it, exactly as it loses what a full pipe has not taken.
 *
 * It models the semantics, not the 64 KB capacity: scripts whose output can really overflow a pipe are tested with real pipes
 * (held-back-reader.mjs). This is for the one script whose output is a fixed 807 bytes.
 */
import { writeSync } from 'node:fs'

const pending = []
let scheduled = false
function flush() {
  scheduled = false
  while (pending.length > 0) {
    const [fd, chunk, cb] = pending.shift()
    writeSync(fd, chunk)
    if (typeof cb === 'function') cb()
  }
}
for (const [stream, fd] of [[process.stdout, 1], [process.stderr, 2]]) {
  stream.write = (chunk, encoding, cb) => {
    pending.splice(pending.length, 0, [fd, chunk, typeof encoding === 'function' ? encoding : cb])
    if (!scheduled) {
      scheduled = true
      setImmediate(flush)
    }
    return true
  }
}
