// [A74 S-12 (L)] The boot-alert gate's state file was checked by PATH (lstat the directory, O_NOFOLLOW on the
// file) and then used through whatever the open returned. Three gaps remained:
//   1. the opened object itself was never examined: a hard link (nlink 2) to a file someone else controls —
//      or one we own and must not rewrite — was read and written through, and an existing 0644 file was
//      never tightened (O_CREAT's mode only applies to a NEW file);
//   2. nothing noticed the directory or the file being swapped between the check and the open (a
//      rename-and-replace race): the check passed on the old object, the I/O went to the new one;
//   3. a HOME that others can write lets them rename/replace `~/.teraswap-keeper` at will, which no
//      per-file check can make safe — the whole directory is untrusted.
// Now: HOME (the state directory's parent) must not be group/other-writable; the directory is opened
// O_DIRECTORY|O_NOFOLLOW and fstat'd (same inode as the lstat, ours) before it is tightened with fchmod; the
// file is opened WITHOUT O_TRUNC, fstat'd (regular file, our uid, nlink 1), re-lstat'd by path (same inode, not
// a link) with the directory re-lstat'd (same inode) AFTER the open, and only then truncated, fchmod'd 0600
// and written. A refused read means "never sent" (the alert is SENT); a refused write means "not persisted".
//
// HOME is a temp directory, so nothing touches the real home.
//
// Run: node --test contracts/order-engine/executor/rpc-auth-state-fd.test.mjs

import { test, describe, after, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as rpcAuth from "./rpc-auth.js"

const { createBootAlertGate } = rpcAuth

const temps = []
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true })
})
const realHome = process.env.HOME
let home
let elsewhere
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "keeper-home-"))
  elsewhere = mkdtempSync(join(tmpdir(), "keeper-elsewhere-"))
  temps.push(home, elsewhere)
  process.env.HOME = home
})
afterEach(() => {
  process.env.HOME = realHome
})

const GATE = "rpc-auth-boot-8453.json"
const NOW = 5_000_000_000
const fresh = () => JSON.stringify({ lastSentAt: NOW - 1_000, suppressed: 0 })
const gate = () => createBootAlertGate({ chainId: 8453, now: () => NOW })

function stateDir({ dirMode = 0o700, file = fresh(), fileMode = 0o600 } = {}) {
  const dir = join(home, ".teraswap-keeper")
  mkdirSync(dir, { mode: dirMode })
  chmodSync(dir, dirMode)
  if (file != null) {
    writeFileSync(join(dir, GATE), file)
    chmodSync(join(dir, GATE), fileMode)
  }
  return dir
}

describe("[A74 S-12] a group/other-writable HOME makes the whole state directory untrusted", () => {
  for (const mode of [0o775, 0o757, 0o777, 0o770, 0o702]) {
    test(`HOME ${mode.toString(8)}: a planted 'just sent' file is not read (alert SENT), nothing is rewritten`, () => {
      const dir = stateDir()
      const before = readFileSync(join(dir, GATE), "utf-8")
      chmodSync(home, mode)
      assert.equal(gate().check().send, true, "a state directory others can rename is untrusted ⇒ never sent")
      assert.equal(readFileSync(join(dir, GATE), "utf-8"), before, "and the file was not rewritten")
    })
  }

  test("HOME 0775 and no state directory yet: nothing is created inside it", () => {
    chmodSync(home, 0o775)
    assert.equal(gate().check().send, true)
    assert.equal(existsSync(join(home, ".teraswap-keeper")), false)
  })

  for (const mode of [0o700, 0o750, 0o755, 0o500]) {
    test(`HOME ${mode.toString(8)} (not writable by others) is trusted: the gate rate-limits as before`, () => {
      stateDir()
      chmodSync(home, mode)
      try {
        assert.equal(gate().check().send, false, "a fresh lastSentAt within the cooldown suppresses")
      } finally {
        chmodSync(home, 0o700) // let the temp dir be removed
      }
    })
  }
})

describe("[A74 S-12] the OPENED object is examined: regular file, our uid, nlink 1", () => {
  test("a hard link to another file is not read and not written through", () => {
    const dir = stateDir({ file: null })
    const other = join(elsewhere, "other.json")
    writeFileSync(other, fresh())
    linkSync(other, join(dir, GATE)) // nlink 2
    assert.equal(gate().check().send, true, "a hard-linked gate file is untrusted ⇒ never sent")
    assert.equal(readFileSync(other, "utf-8"), fresh(), "the other name for the inode was not rewritten")
  })

  test("a hard link from inside the state directory (same directory, nlink 2) is refused too", () => {
    const dir = stateDir()
    linkSync(join(dir, GATE), join(dir, "second-name.json"))
    const before = readFileSync(join(dir, GATE), "utf-8")
    assert.equal(gate().check().send, true)
    assert.equal(readFileSync(join(dir, GATE), "utf-8"), before)
  })

  test("an existing 0644 gate file is tightened to 0600 on write (O_CREAT's mode only applies to a new file)", () => {
    const dir = stateDir({ file: JSON.stringify({ lastSentAt: NOW - 10 * 3_600_000, suppressed: 0 }), fileMode: 0o644 })
    assert.equal(gate().check().send, true) // past the cooldown ⇒ send, and persist
    assert.equal(statSync(join(dir, GATE)).mode & 0o777, 0o600)
    assert.equal(JSON.parse(readFileSync(join(dir, GATE), "utf-8")).lastSentAt, NOW)
  })

  test("the predicate: regular file, own uid, nlink 1 — each failure alone is a refusal", () => {
    assert.equal(typeof rpcAuth.assertOwnedRegularFile, "function", "rpc-auth.js exports assertOwnedRegularFile")
    const ok = { isFile: () => true, uid: 1000, nlink: 1 }
    assert.doesNotThrow(() => rpcAuth.assertOwnedRegularFile(ok, 1000))
    assert.doesNotThrow(() => rpcAuth.assertOwnedRegularFile(ok, null), "no uid on this platform ⇒ not checked")
    assert.throws(() => rpcAuth.assertOwnedRegularFile({ ...ok, isFile: () => false }, 1000), /regular file/)
    assert.throws(() => rpcAuth.assertOwnedRegularFile({ ...ok, uid: 0 }, 1000), /owner|uid/i)
    assert.throws(() => rpcAuth.assertOwnedRegularFile({ ...ok, nlink: 2 }, 1000), /link/i)
  })
})

/** A refusal is a deliberate Error from the state-file code — a TypeError ("not a function") is not one. */
function refuses(fn, re) {
  assert.throws(fn, (e) => e instanceof Error && !(e instanceof TypeError) && re.test(e.message), "expected a deliberate refusal")
}

describe("[A74 S-12] a swap between the check and the open is noticed (hook runs right after open())", () => {
  function setup() {
    const dir = stateDir()
    return { dir, file: join(dir, GATE) }
  }
  function swapDirectory(dir) {
    renameSync(dir, `${dir}.old`)
    mkdirSync(dir, { mode: 0o700 })
    writeFileSync(join(dir, GATE), fresh())
  }
  function swapFileForSymlink(file) {
    const planted = join(elsewhere, "planted.json")
    writeFileSync(planted, fresh())
    unlinkSync(file)
    symlinkSync(planted, file)
    return planted
  }

  test("the seam exists", () => {
    assert.equal(typeof rpcAuth.readOwnedState, "function")
    assert.equal(typeof rpcAuth.writeOwnedState, "function")
  })

  test("read: the directory replaced after open ⇒ refused", () => {
    const { dir, file } = setup()
    refuses(() => rpcAuth.readOwnedState(file, { afterOpen: () => swapDirectory(dir) }), /director|changed/i)
  })

  test("read: the file replaced by a symlink after open ⇒ refused", () => {
    const { file } = setup()
    refuses(() => rpcAuth.readOwnedState(file, { afterOpen: () => swapFileForSymlink(file) }), /file|changed|link/i)
  })

  test("write: the directory replaced after open ⇒ refused, and nothing was written to the old inode", () => {
    const { dir, file } = setup()
    refuses(() => rpcAuth.writeOwnedState(file, '{"lastSentAt":1}', { afterOpen: () => swapDirectory(dir) }), /director|changed/i)
    assert.equal(readFileSync(join(`${dir}.old`, GATE), "utf-8"), fresh(), "the old file was neither truncated nor written")
    assert.equal(readFileSync(join(dir, GATE), "utf-8"), fresh(), "the new directory's file is untouched")
  })

  test("write: the file replaced by a symlink after open ⇒ refused, the link target untouched, old inode not truncated", () => {
    const { file } = setup()
    let planted
    refuses(() => rpcAuth.writeOwnedState(file, '{"lastSentAt":1}', { afterOpen: () => (planted = swapFileForSymlink(file)) }), /file|changed|link/i)
    assert.equal(readFileSync(planted, "utf-8"), fresh())
  })

  test("no swap: the same calls succeed (the hook is inert)", () => {
    const { file } = setup()
    let ran = 0
    assert.equal(rpcAuth.readOwnedState(file, { afterOpen: () => ran++ }), fresh())
    rpcAuth.writeOwnedState(file, '{"lastSentAt":7}', { afterOpen: () => ran++ })
    assert.equal(ran, 2)
    assert.equal(readFileSync(file, "utf-8"), '{"lastSentAt":7}')
  })
})

describe("[A74 S-12] unchanged", () => {
  test("a looser existing state directory is tightened to 0700, a fresh one is created 0700/0600", () => {
    const dir = stateDir({ dirMode: 0o755, file: null })
    assert.equal(gate().check().send, true)
    assert.equal(statSync(dir).mode & 0o777, 0o700)
    assert.equal(statSync(join(dir, GATE)).mode & 0o777, 0o600)
  })
})
