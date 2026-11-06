// [A71 L-3] The boot-alert gate cannot be muted by a planted or skewed state file.
//
// The audited head kept the gate file in the shared, world-writable os.tmpdir() and trusted any
// lastSentAt it found there: a file with lastSentAt in the future (planted by another local user, or
// left by a clock that jumped back) suppressed every boot auth alert until that moment.
//
// These tests point HOME at a temp directory, so nothing touches the real home or /tmp.
//
// Run: node --test contracts/order-engine/executor/rpc-auth-boot-gate.test.mjs

import { test, describe, after, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { createBootAlertGate } from "./rpc-auth.js"

const HOUR = 3_600_000
const temps = []
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true })
})
const realHome = process.env.HOME
let home
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "keeper-home-"))
  temps.push(home)
  process.env.HOME = home
})
afterEach(() => {
  process.env.HOME = realHome
})

describe("[A71 L-3] boot gate: a future lastSentAt is 'never sent'", () => {
  test("lastSentAt one hour AHEAD of now ⇒ the alert is sent, and the file is rewritten with now", () => {
    const t = 5_000_000_000
    const disk = new Map([["/gate.json", JSON.stringify({ lastSentAt: t + HOUR, suppressed: 7 })]])
    const gate = createBootAlertGate({ chainId: 8453, now: () => t, file: "/gate.json", read: (f) => disk.get(f), write: (f, s) => disk.set(f, s) })
    const v = gate.check()
    assert.equal(v.send, true)
    assert.equal(v.lastSentAt, null)
    assert.deepEqual(JSON.parse(disk.get("/gate.json")), { lastSentAt: t, suppressed: 0 })
  })

  test("a far-future lastSentAt cannot mute the alert either; a past one inside the hour still does", () => {
    const t = 5_000_000_000
    const at = (lastSentAt) =>
      createBootAlertGate({ chainId: 8453, now: () => t, file: "/g", read: () => JSON.stringify({ lastSentAt, suppressed: 0 }), write: () => {} }).check().send
    assert.equal(at(8.64e15), true)
    assert.equal(at(t - 60_000), false, "a genuine recent send is still rate-limited")
  })
})

describe("[A71 L-3] boot gate: the default state file is the keeper's own, not os.tmpdir()", () => {
  test("default path = $HOME/.teraswap-keeper/rpc-auth-boot-<chain>.json — never under os.tmpdir()", () => {
    let wrote = null
    createBootAlertGate({ chainId: 8453, read: () => { throw new Error("ENOENT") }, write: (f) => { wrote = f } }).check()
    assert.equal(wrote, join(homedir(), ".teraswap-keeper", "rpc-auth-boot-8453.json"))
    assert.equal(homedir(), home)
  })

  test("default read/write on the real filesystem: dir 0700, file 0600, and a restart is rate-limited", () => {
    assert.equal(createBootAlertGate({ chainId: 8453 }).check().send, true)
    const dir = join(home, ".teraswap-keeper")
    assert.equal(statSync(dir).mode & 0o777, 0o700)
    assert.equal(statSync(join(dir, "rpc-auth-boot-8453.json")).mode & 0o777, 0o600)
    assert.equal(createBootAlertGate({ chainId: 8453 }).check().send, false)
  })

  test("a state file in a directory others can write is not trusted (sent), and the directory is tightened", () => {
    const dir = join(home, ".teraswap-keeper")
    mkdirSync(dir)
    chmodSync(dir, 0o777)
    writeFileSync(join(dir, "rpc-auth-boot-8453.json"), JSON.stringify({ lastSentAt: Date.now(), suppressed: 0 }))
    assert.equal(createBootAlertGate({ chainId: 8453 }).check().send, true, "a planted 'just sent' must not mute the alert")
    assert.equal(statSync(dir).mode & 0o777, 0o700)
    assert.equal(createBootAlertGate({ chainId: 8453 }).check().send, false, "now trusted: a restart is rate-limited")
    assert.ok(JSON.parse(readFileSync(join(dir, "rpc-auth-boot-8453.json"), "utf-8")).lastSentAt <= Date.now())
  })
})
