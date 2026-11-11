// Guards .claude/settings.json: the standing agent deny-list must stay intact and must never widen.
// Bash rule matching below models the documented semantics (https://code.claude.com/docs/en/permissions):
// `*` matches any text incl. spaces, everything before the first `*` is anchored, a rule with no `*`
// is an exact match, a trailing ` *` also matches the bare command, compound commands are split on
// && || ; | & and newlines, and deny wins over everything. It is a MODEL of the rules (a lint), not the
// enforcement itself — the real denied/allowed attempts are recorded in docs/feedback/chore-agent-harness.md.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const SETTINGS_PATH = path.join(ROOT, '.claude', 'settings.json')

/** Commands that MUST be refused (each tried bare and wrapped in `git -C .` / `gh -R x` where relevant). */
export const MUST_DENY = [
  'ssh -V',
  'ssh host',
  'scp a.txt host:/tmp',
  'ssh-add -l',
  'pm2 restart keeper',
  'cast send 0x0 "f()"',
  'cast s 0x0 "f()"',
  'security find-generic-password -s x',
  'git credential fill',
  'git push --force',
  'git push origin main --force',
  'git push --force-with-lease origin x',
  'git push origin x --force-with-lease',
  'git push -f',
  'git push -f origin x',
  'git push origin x -f',
  'git push origin +x',
  'git push origin HEAD:+x',
  'git -C . push --force origin x',
  'git -C . push -f origin x',
  'gh pr create --title x',
  'gh pr merge 5 --squash',
  'gh pr ready 5',
  'gh pr close 5',
  'gh -R a/b pr merge 5',
  'gh api -X POST repos/a/b/issues',
  'gh api repos/a/b --method DELETE',
  'gh api repos/a/b/issues -f title=x',
  'gh api repos/a/b/issues -F n=1',
  'gh api repos/a/b/issues --field a=b',
  'gh api repos/a/b/issues --raw-field a=b',
  'gh api repos/a/b --input body.json',
  'gh api graphql -f query=mutation',
  'npm audit fix',
  'npm audit fix --force',
  'npm audit --fix',
  'history',
  'history 50',
  'npm test && ssh host', // deny applies to ANY subcommand of a compound
  'echo hi | pm2 list',
]

/** Commands that must NOT be refused by a deny rule (they may still prompt — there is no allow list). */
export const MUST_NOT_DENY = [
  'git status',
  'git commit -S -m "x"',
  'git push',
  'git push -u origin chore/agent-harness',
  'git push origin chore/agent-fix',
  'git push origin chore/force-field-copy',
  'git -C . push origin x',
  'git log --oneline -5',
  'git fetch origin main',
  'npm ci',
  'npm test',
  'npm run build',
  'npm run lint',
  'npm audit',
  'npx tsc --noEmit',
  'gh pr view 5',
  'gh pr view 5 --json state',
  'gh pr list',
  'gh api repos/a/b/pulls/5',
  'gh api repos/a/b/pulls',
  'forge test',
  'forge build',
  'cast call 0x0 "f()"',
  'cast block-number',
  'cast --version',
  'ls -la',
  'grep -rn ssh docs',
]

export const REQUIRED_PATH_RULES = [
  'Read(.env*)',
  'Read(!.env.example)',
  'Edit(.env*)',
  'Edit(!.env.example)',
  'Read(~/.zsh_history)',
  'Read(~/.bash_history)',
]

const WRAPPERS = new Set(['timeout', 'time', 'nice', 'nohup', 'stdbuf', 'command', 'builtin', 'noglob'])

function splitCompound(cmd) {
  return cmd
    .split(/&&|\|\||\|&|;|\||&|\n/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function stripWrappers(sub) {
  const parts = sub.split(/\s+/)
  while (parts.length > 1 && WRAPPERS.has(parts[0])) parts.shift()
  return parts.join(' ')
}

function globToRegExp(glob) {
  const esc = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${esc}$`)
}

export function bashRuleMatches(rule, command) {
  const m = /^Bash\((.*)\)$/s.exec(rule)
  if (!m) return false
  let pattern = m[1]
  if (pattern.endsWith(':*')) pattern = `${pattern.slice(0, -2)} *`
  const re = globToRegExp(pattern)
  // `ls *` also matches bare `ls` (documented word-boundary behaviour).
  const bare = pattern.endsWith(' *') ? globToRegExp(pattern.slice(0, -2)) : null
  return splitCompound(command).some((sub) => {
    const s = stripWrappers(sub)
    return re.test(s) || (bare !== null && bare.test(s))
  })
}

export function isDenied(settings, command) {
  const deny = settings.permissions?.deny ?? []
  return deny.some((r) => bashRuleMatches(r, command))
}

/** Every problem found in a settings object; empty array = compliant. */
export function validateSettings(settings) {
  const problems = []
  const p = settings.permissions ?? {}
  const deny = p.deny ?? []

  if (Array.isArray(p.allow) ? p.allow.length > 0 : p.allow !== undefined) problems.push('permissions.allow must be absent or empty (no widening)')
  if (Array.isArray(p.ask) && p.ask.length > 0) problems.push('permissions.ask is not part of the contract')
  const mode = p.defaultMode
  if (mode !== undefined && !['default', 'manual', 'plan'].includes(mode)) problems.push(`permissions.defaultMode "${mode}" widens (only default/manual/plan allowed)`)
  if (p.disableBypassPermissionsMode !== 'disable') problems.push('permissions.disableBypassPermissionsMode must be "disable"')
  for (const key of ['allowedTools', 'skipDangerousModePermissionPrompt', 'dangerouslySkipPermissions']) {
    if (key in settings || key in p) problems.push(`${key} must not appear`)
  }
  if (/bypassPermissions|dangerously-skip-permissions/.test(JSON.stringify({ ...settings, permissions: { ...p, disableBypassPermissionsMode: undefined } }))) {
    problems.push('bypass mode referenced')
  }

  for (const cmd of MUST_DENY) if (!isDenied(settings, cmd)) problems.push(`not denied: ${cmd}`)
  for (const cmd of MUST_NOT_DENY) if (isDenied(settings, cmd)) problems.push(`wrongly denied: ${cmd}`)

  for (const rule of REQUIRED_PATH_RULES) if (!deny.includes(rule)) problems.push(`missing deny rule: ${rule}`)
  // gitignore negation only carves out of rules listed BEFORE it.
  for (const tool of ['Read', 'Edit']) {
    const base = deny.indexOf(`${tool}(.env*)`)
    const neg = deny.indexOf(`${tool}(!.env.example)`)
    if (base !== -1 && neg !== -1 && neg < base) problems.push(`${tool}(!.env.example) must come after ${tool}(.env*)`)
  }
  return problems
}

const settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'))
const clone = () => JSON.parse(JSON.stringify(settings))

describe('.claude/settings.json', () => {
  it('is compliant: required denies present, nothing widens, allowed work not blocked', () => {
    expect(validateSettings(settings)).toEqual([])
  })

  it('has no allow rules and no bypass default mode', () => {
    expect(settings.permissions.allow ?? []).toEqual([])
    expect(settings.permissions.defaultMode).toBeUndefined()
    expect(settings.permissions.disableBypassPermissionsMode).toBe('disable')
  })

  it('fails when a required deny is removed (every rule that makes a probe denied)', () => {
    const deny = settings.permissions.deny
    // Removing ALL rules for one family must be caught.
    const families = {
      ssh: /^Bash\((ssh|scp|ssh-add)\b/,
      pm2: /^Bash\(pm2/,
      cast: /^Bash\(cast /,
      security: /^Bash\(security/,
      'force-push': /^Bash\(git .*push/,
      'gh pr': /^Bash\(gh .*pr /,
      'gh api': /^Bash\(gh .*api/,
      'npm audit fix': /^Bash\(npm audit/,
      history: /^Bash\(history/,
      'env read': /^Read\(\.env|^Read\(!\.env/,
      'env edit': /^Edit\(\.env|^Edit\(!\.env/,
      'history files': /^Read\(~\/\.(zsh|bash)_history/,
    }
    for (const [name, re] of Object.entries(families)) {
      const s = clone()
      s.permissions.deny = deny.filter((r) => !re.test(r))
      expect(s.permissions.deny.length, name).toBeLessThan(deny.length)
      expect(validateSettings(s).length, `removing "${name}" must be caught`).toBeGreaterThan(0)
    }
  })

  it('fails when an allow rule appears', () => {
    const s = clone()
    s.permissions.allow = ['Bash(git status)']
    expect(validateSettings(s).join('\n')).toMatch(/permissions\.allow/)
  })

  it('fails on bypass / widening modes and on dropping disableBypassPermissionsMode', () => {
    for (const mode of ['bypassPermissions', 'auto', 'dontAsk', 'acceptEdits']) {
      const s = clone()
      s.permissions.defaultMode = mode
      expect(validateSettings(s).join('\n'), mode).toMatch(/widens|bypass/)
    }
    const s = clone()
    delete s.permissions.disableBypassPermissionsMode
    expect(validateSettings(s).join('\n')).toMatch(/disableBypassPermissionsMode/)
    const t = clone()
    t.skipDangerousModePermissionPrompt = true
    expect(validateSettings(t).join('\n')).toMatch(/skipDangerousModePermissionPrompt/)
  })

  it('fails when a deny is so broad it blocks normal work', () => {
    const s = clone()
    s.permissions.deny.push('Bash(git push *)')
    expect(validateSettings(s).join('\n')).toMatch(/wrongly denied: git push/)
    const t = clone()
    t.permissions.deny.push('Bash(gh pr *)')
    expect(validateSettings(t).join('\n')).toMatch(/wrongly denied: gh pr view/)
  })

  it('fails when the .env negation is listed before its base rule', () => {
    const s = clone()
    const d = s.permissions.deny
    d.splice(d.indexOf('Read(!.env.example)'), 1)
    d.splice(d.indexOf('Read(.env*)'), 0, 'Read(!.env.example)')
    expect(validateSettings(s).join('\n')).toMatch(/must come after/)
  })
})

describe('bashRuleMatches (model of documented semantics)', () => {
  it('anchors at the start and treats * as any text', () => {
    expect(bashRuleMatches('Bash(git push *)', 'git push origin main')).toBe(true)
    expect(bashRuleMatches('Bash(git push *)', 'git -C . push origin main')).toBe(false) // documented gap
    expect(bashRuleMatches('Bash(ls *)', 'ls')).toBe(true)
    expect(bashRuleMatches('Bash(ls *)', 'lsof')).toBe(false)
    expect(bashRuleMatches('Bash(ls*)', 'lsof')).toBe(true)
    expect(bashRuleMatches('Bash(ssh)', 'ssh -V')).toBe(false)
  })
  it('checks every subcommand and strips wrappers', () => {
    expect(bashRuleMatches('Bash(pm2 *)', 'echo a && nohup pm2 list')).toBe(true)
  })
})
