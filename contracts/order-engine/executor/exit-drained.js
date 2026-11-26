// [fix/script-stdout-truncated-on-exit] Ending an operator CLI without losing its output.
//
// stdout and stderr are asynchronous when they are pipes: console.log queues the text and returns, and process.exit then drops
// whatever the kernel pipe (about 64 KB) has not taken, so `node cli.mjs | tee log` or a slow CI reader got a cut report. These two
// helpers keep the CLIs' behaviour (same text, same exit code, still a prompt exit that does not wait for open sockets) and only
// make the exit wait for the two streams.
//
//   throw new CliExit(1)   - where a CLI used `process.exit(1)` in the middle of main(): unwinds to the one handler at the bottom
//   exitAfterDrain(code)   - that handler: sets process.exitCode, waits until stdout and stderr have handed everything on, exits
//
// No timer: the write callbacks fire when the stream is empty (or errored, e.g. the reader closed the pipe), and a stream that is a
// file or a terminal calls back at once.

/** An early, deliberate end of a CLI run with an exit code (not an error to report). */
export class CliExit extends Error {
  constructor(code) {
    super(`exit ${code}`)
    this.name = "CliExit"
    this.code = code
  }
}

/** Exit with `code` once everything already written to stdout and stderr has been handed to the OS. */
export function exitAfterDrain(code) {
  process.exitCode = code
  // A write's callback runs after every earlier chunk of that stream; an empty write is the marker.
  process.stdout.write("", () => process.stderr.write("", () => process.exit(code)))
}
