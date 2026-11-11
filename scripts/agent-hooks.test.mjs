import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { decide } from '../.claude/hooks/readonly-guard.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const HOOK = path.join(ROOT, '.claude', 'hooks', 'readonly-guard.mjs')
const AGENTS = path.join(ROOT, '.claude', 'agents')

const REFUSED = [
  'git commit -m x',
  'git commit -S --amend',
  'git push origin x',
  'git push',
  'git -C /tmp/wt push origin x',
  'git -c user.name=x commit -m y',
  'cd wt && git push',
  'echo ok; git push',
  'sh -c "git push origin x"',
  'FOO=1 git commit -m x',
  '/usr/bin/git push',
  'xargs git push',
  'git merge origin/main',
  'git rebase origin/main',
  'git tag v1',
  'git reset --hard',
  'git branch -D x',
  'git remote add x y',
  'gh pr create --title x',
  'gh pr merge 5',
  'gh pr comment 5 -b x',
  'gh issue create',
  'gh -R a/b pr close 5',
  'gh api -X POST repos/a/b/issues',
  'gh api repos/a/b --method=DELETE',
  'gh api repos/a/b/issues -f title=x',
  'gh release create v1',
  'gh workflow run x',
  'gh repo delete a/b',
  'echo $(git push)',
]

const ALLOWED = [
  'git status',
  'git log --oneline -5',
  'git diff origin/main...HEAD --stat',
  'git fetch origin main',
  'git worktree add --detach /tmp/wt origin/main',
  'git -C /tmp/wt rev-parse HEAD',
  'git show HEAD:package.json',
  'git branch --show-current',
  'git remote -v',
  'git log -1 --format=%H',
  'npm ci',
  'npm test',
  'npx tsc --noEmit',
  'gh pr view 5 --json state',
  'gh pr diff 5',
  'gh pr list',
  'gh api repos/a/b/pulls/5',
  'gh api repos/a/b/pulls?per_page=5',
  'gh codeql version',
  'gh -R a/b pr view 5',
  'grep -rn "git push" docs',
  'ls -la',
]

describe('readonly-guard decide()', () => {
  for (const c of REFUSED) it(`refuses: ${c}`, () => expect(decide(c), c).toEqual(expect.any(String)))
  for (const c of ALLOWED) it(`allows: ${c}`, () => {
    // `grep -rn "git push"` is the one accepted false positive (quoted text is flattened): documented below.
    if (c.startsWith('grep')) return
    expect(decide(c), c).toBeNull()
  })
  it('flattened quotes mean quoted `git push` text is refused (conservative, accepted)', () => {
    expect(decide('grep -rn "git push" docs')).not.toBeNull()
  })
})

describe('readonly-guard process protocol', () => {
  const run = (stdin) => spawnSync('node', [HOOK], { input: stdin, encoding: 'utf8' })
  it('exit 2 + stderr on a refused command', () => {
    const r = run(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push origin x' } }))
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('readonly-guard: refused')
  })
  it('exit 0 on an allowed command', () => {
    const r = run(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git status' } }))
    expect(r.status).toBe(0)
  })
  it('fails closed on garbage and on a missing command', () => {
    expect(run('not json').status).toBe(2)
    expect(run(JSON.stringify({ tool_input: {} })).status).toBe(2)
  })
})

function frontmatter(file) {
  const text = readFileSync(file, 'utf8')
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text)
  if (!m) throw new Error(`${file}: no frontmatter`)
  return { fm: m[1], body: text.slice(m[0].length) }
}
const field = (fm, key) => (new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(fm) || [])[1]?.trim()

describe('.claude/agents', () => {
  const files = readdirSync(AGENTS).filter((f) => f.endsWith('.md')).sort()
  it('ships exactly implementer, recon, auditor', () => {
    expect(files).toEqual(['auditor.md', 'implementer.md', 'recon.md'])
  })

  const spec = {
    implementer: { model: 'sonnet' },
    recon: { model: 'haiku' },
    auditor: { model: 'opus' },
  }
  for (const [name, { model }] of Object.entries(spec)) {
    describe(name, () => {
      const { fm, body } = frontmatter(path.join(AGENTS, `${name}.md`))
      it('has name, description, model, tools', () => {
        expect(field(fm, 'name')).toBe(name)
        expect(field(fm, 'description')).toBeTruthy()
        expect(field(fm, 'model')).toBe(model)
        expect(field(fm, 'tools')).toBeTruthy()
      })
      it('carries the standing rules in the body', () => {
        for (const needle of ['worktree', 'npm ci', 'SSH-signed', 'noreply', 'force-push', 'premise', 'Exit =']) {
          expect(body, `${name} missing "${needle}"`).toContain(needle)
        }
        expect(body).toMatch(/NO CI polling/)
        expect(body).toMatch(/never (open|merge)[^\n]*PR|PR[^\n]*never/i)
      })
    })
  }

  for (const name of ['recon', 'auditor']) {
    it(`${name}: no Edit/Write/NotebookEdit in tools, and the read-only hook is attached`, () => {
      const { fm } = frontmatter(path.join(AGENTS, `${name}.md`))
      const tools = field(fm, 'tools').split(/[,\s]+/).filter(Boolean)
      for (const t of ['Edit', 'Write', 'NotebookEdit', 'MultiEdit']) expect(tools, `${name} tools`).not.toContain(t)
      expect(fm).toContain('disallowedTools')
      expect(fm).toContain('readonly-guard.mjs')
      expect(fm).toMatch(/PreToolUse/)
    })
  }

  it('implementer has Edit and Write and no hook that blocks commits', () => {
    const { fm } = frontmatter(path.join(AGENTS, 'implementer.md'))
    const tools = field(fm, 'tools').split(/[,\s]+/)
    expect(tools).toEqual(expect.arrayContaining(['Edit', 'Write', 'Bash']))
    expect(fm).not.toContain('readonly-guard')
  })

  it('auditor body fixes the verdict line and the report-is-the-exit clause', () => {
    const { body } = frontmatter(path.join(AGENTS, 'auditor.md'))
    expect(body).toContain('VERDICT: 0C/0H → approved')
    expect(body).toContain('VERDICT: blocked — nC/nH')
    expect(body).toContain('ANY verdict')
    expect(body).toMatch(/[Dd]etached worktree/)
  })
})
