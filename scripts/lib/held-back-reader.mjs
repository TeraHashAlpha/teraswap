/**
 * [fix/script-stdout-truncated-on-exit] Test harness: run a script whose stdout is a PIPE that nobody reads until the script has
 * produced all of its output, which is how a slow reader (an operator's `| less`, a busy CI runner) looks to the script.
 *
 * Why it is deterministic (no sleep, no timer, no load): the harness does not start reading stdout until `releaseWhen(stderrSoFar)`
 * is true, and a caller picks a point the script reaches only AFTER its last stdout write and BEFORE its exit decision (for the
 * order-hash checker: its stderr summary line). By then the whole of stdout is either in the kernel pipe (about 64 KB), in the
 * parent's read buffer (about 64 KB) or in the script's own write queue. A script that calls `process.exit` there loses the
 * queue; a script that ends by itself keeps it, because the harness reads on after the release.
 *
 * Use an input large enough that stdout is several times the ~128 KB the two buffers hold, so the answer does not depend on the
 * platform's pipe size.
 *
 * @param {{command: string, args: string[], cwd?: string, env?: Record<string,string|undefined>, input?: string,
 *   releaseWhen: (stderrSoFar: string) => boolean}} o
 * @returns {Promise<{code: number|null, signal: string|null, stdout: Buffer, stderr: string}>}
 */
import { spawn } from 'node:child_process'

export function runWithHeldBackStdout({ command, args, cwd, env, input, releaseWhen }) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd, env: env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] })
    const chunks = []
    let stderr = ''
    let released = false
    const release = () => {
      if (released) return
      released = true
      child.stdout.on('data', (c) => chunks.push(c))
      child.stdout.resume()
    }
    child.stdout.pause()
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (c) => {
      stderr += c
      if (!released && releaseWhen(stderr)) release()
    })
    child.on('error', rejectRun)
    // A script that never reached the release point (it crashed first) must not leave a paused pipe that keeps `close` from firing.
    child.on('exit', release)
    child.on('close', (code, signal) => {
      resolveRun({ code, signal, stdout: Buffer.concat(chunks), stderr })
    })
    child.stdin.on('error', () => { /* the child may exit before reading all of its input */ })
    child.stdin.end(input ?? '')
  })
}

/**
 * Same idea for scripts whose big output may be on stderr (a failure report) or stdout: BOTH are held back until fd 3 receives its
 * first byte (see signal-after-main.mjs) or the child exits, whichever comes first.
 *
 * @param {{command: string, args: string[], cwd?: string, env?: Record<string,string|undefined>, input?: string}} o
 * @returns {Promise<{code: number|null, signal: string|null, stdout: Buffer, stderr: Buffer, signalled: boolean}>}
 */
export function runWithHeldBackOutput({ command, args, cwd, env, input }) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd, env: env ?? process.env, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] })
    const out = []
    const err = []
    let released = false
    let signalled = false
    const release = () => {
      if (released) return
      released = true
      child.stdout.on('data', (c) => out.push(c))
      child.stderr.on('data', (c) => err.push(c))
      child.stdout.resume()
      child.stderr.resume()
    }
    child.stdout.pause()
    child.stderr.pause()
    child.stdio[3].on('data', () => { signalled = true; release() })
    child.on('error', rejectRun)
    child.on('exit', release)
    child.on('close', (code, signal) => resolveRun({ code, signal, stdout: Buffer.concat(out), stderr: Buffer.concat(err), signalled }))
    child.stdin.on('error', () => { /* the child may exit before reading all of its input */ })
    child.stdin.end(input ?? '')
  })
}
