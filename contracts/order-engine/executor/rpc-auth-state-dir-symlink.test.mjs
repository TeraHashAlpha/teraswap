// [A71b S-2] The boot-alert gate refuses a symlinked state directory and a symlinked gate file.
//
// The audited head used statSync / chmodSync / writeFileSync / readFileSync, all of which FOLLOW
// symlinks: a `~/.teraswap-keeper` that is a symlink to another directory had that directory's mode
// forced to 0700 and the gate file written into it, and a gate file that is a symlink was read (a
// planted "just sent" mutes the boot alert) and written through (an arbitrary file truncated and
// overwritten). Now: lstat the directory and refuse a symlink; open the file with O_NOFOLLOW.
//
// HOME is a temp directory, so nothing touches the real home. A refused read means "never sent"
// (the alert is SENT); a refused write means "not persisted" (the next boot alerts again) — louder,
// never quieter.
//
// Run: node --test contracts/order-engine/executor/rpc-auth-state-dir-symlink.test.mjs

import { test, describe, after, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createBootAlertGate } from "./rpc-auth.js"

const temps = []
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true })
})
const realHome = process.env.HOME
let home
let elsewhere // a directory the attacker wants us to write into / read from
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

describe("[A71b S-2] a symlinked state directory is refused", () => {
  test("~/.teraswap-keeper → another directory: nothing is chmodded, nothing is written there, the alert is sent every time", () => {
    chmodSync(elsewhere, 0o755)
    symlinkSync(elsewhere, join(home, ".teraswap-keeper"))
    // even a trustworthy-looking "just sent" file behind the link must not mute the alert
    writeFileSync(join(elsewhere, GATE), JSON.stringify({ lastSentAt: Date.now(), suppressed: 0 }))
    chmodSync(join(elsewhere, GATE), 0o644)
    const before = readFileSync(join(elsewhere, GATE), "utf-8")

    const gate = createBootAlertGate({ chainId: 8453 })
    assert.equal(gate.check().send, true, "a symlinked directory is untrusted ⇒ never sent")
    assert.equal(gate.check().send, true, "…and nothing was persisted, so the next boot alerts again")

    assert.equal(statSync(elsewhere).mode & 0o777, 0o755, "the link target's mode was NOT forced to 0700")
    assert.equal(readFileSync(join(elsewhere, GATE), "utf-8"), before, "the gate file behind the link was not rewritten")
    assert.equal(statSync(join(elsewhere, GATE)).mode & 0o777, 0o644)
  })

  test("a dangling link: nothing is created at its target", () => {
    const target = join(elsewhere, "not-yet")
    symlinkSync(target, join(home, ".teraswap-keeper"))
    assert.equal(createBootAlertGate({ chainId: 8453 }).check().send, true)
    assert.equal(existsSync(target), false)
  })
})

describe("[A71b S-2] a symlinked gate file is refused", () => {
  function realDir() {
    const dir = join(home, ".teraswap-keeper")
    mkdirSync(dir, { mode: 0o700 })
    chmodSync(dir, 0o700)
    return dir
  }

  test("gate file → a file holding a fresh lastSentAt: not read (alert sent), not written through", () => {
    const dir = realDir()
    const planted = join(elsewhere, "planted.json")
    writeFileSync(planted, JSON.stringify({ lastSentAt: Date.now(), suppressed: 0 }))
    const before = readFileSync(planted, "utf-8")
    symlinkSync(planted, join(dir, GATE))

    assert.equal(createBootAlertGate({ chainId: 8453 }).check().send, true, "a planted 'just sent' must not mute the alert")
    assert.equal(readFileSync(planted, "utf-8"), before, "the link target was not overwritten")
  })

  test("gate file → a victim file: the victim is neither truncated nor rewritten", () => {
    const dir = realDir()
    const victim = join(elsewhere, "authorized_keys")
    writeFileSync(victim, "ssh-ed25519 AAAA… keep me\n")
    symlinkSync(victim, join(dir, GATE))
    createBootAlertGate({ chainId: 8453 }).check()
    createBootAlertGate({ chainId: 8453 }).check()
    assert.equal(readFileSync(victim, "utf-8"), "ssh-ed25519 AAAA… keep me\n")
    assert.deepEqual(readdirSync(elsewhere), ["authorized_keys"])
  })

  test("a dangling gate-file link is not created through", () => {
    const dir = realDir()
    const target = join(elsewhere, "created-by-us.json")
    symlinkSync(target, join(dir, GATE))
    createBootAlertGate({ chainId: 8453 }).check()
    assert.equal(existsSync(target), false)
  })
})

describe("[A71b S-2] the normal path is unchanged", () => {
  test("a real directory and file: dir 0700, file 0600, a restart is rate-limited, then the send repeats after the cooldown", () => {
    let t = 5_000_000_000
    const mk = () => createBootAlertGate({ chainId: 8453, now: () => t })
    assert.equal(mk().check().send, true)
    const dir = join(home, ".teraswap-keeper")
    assert.equal(statSync(dir).mode & 0o777, 0o700)
    assert.equal(statSync(join(dir, GATE)).mode & 0o777, 0o600)
    assert.equal(mk().check().send, false)
    t += 3_600_000
    assert.equal(mk().check().send, true)
    assert.equal(JSON.parse(readFileSync(join(dir, GATE), "utf-8")).lastSentAt, t)
  })
})
