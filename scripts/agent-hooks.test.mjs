import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { decide } from '../.claude/hooks/readonly-guard.mjs'
import { decide as guardDecide } from '../.claude/hooks/command-guard.mjs'

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
      for (const t of ['Edit', 'Write', 'NotebookEdit']) expect(tools, `${name} tools`).not.toContain(t)
      expect(fm).toContain('disallowedTools')
      expect(fm, 'MultiEdit is not a tool (A77): do not list it').not.toContain('MultiEdit')
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
    'gh pr checkout 5', 'gh pr update-branch 5', 'gh pr lock 5', 'gh -R a/b pr create', 'gh --repo a/b pr merge 5', 'gh pr -R a/b merge 5', 'gh pr --repo=a/b close 5', '/opt/homebrew/bin/gh pr create',
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
  'grep -rn "git push" docs', "grep -rn 'git push --force' docs", 'grep -n "ssh" README.md', 'grep -rn "\\.env" src', 'grep -n ".env" scripts/x.sh', 'grep -rn ".env.example" docs', 'rg ".env" docs', 'rg -e .env docs',
  'git log --grep=".env"', 'git grep -n "git push" -- docs', 'grep -rn "cast send" docs', 'grep -rn "gh pr create" docs', 'grep -c "history" docs/x.md', 'echo "git push --force"',
  'cat .env.example', 'cat ./.env.example', 'ls -la', 'ls *', 'ls -a', 'ls .env.example', 'cat package.json', 'sed -n "1,5p" file', 'ls docs/ssh', 'npm view ssh2 version', 'command -v ssh', 'which ssh',
  'npm ci', 'npm test', 'npm run build', 'npm run lint', 'npm audit', 'npm audit --json', 'npm audit --omit=dev', 'npm run audit:fix-report', 'npx tsc --noEmit', 'npx --no-install vitest run', './node_modules/.bin/vitest run', 'FOO=1 npm test',
  'env FOO=1 npm test', 'cd x && npm test', 'timeout 60 npm test', 'echo hi | cat', 'xargs echo', 'find . -name "*.ts"', 'node scripts/goal-lint.mjs goal.md', 'bash scripts/agent-verify.sh', 'bash -c "echo hi"', 'sh -c "git status"', 'eval "git status"',
  'bash -lc "npm test"', 'diff <(git show a:f) <(git show b:f)', 'echo "$(git rev-parse HEAD)"', 'git diff --stat 2>&1 | tail', 'rsync -a src/ dst/', 'rsync -a ./a ./b',
  'gh pr view 5', 'gh pr view 5 --json state', 'gh pr diff 5', 'gh pr checks 5', 'gh pr list', 'gh pr list --state merged', 'gh pr status', 'gh -R a/b pr view 5', 'gh --repo a/b pr checks 5',
  'gh api repos/a/b/pulls/5', 'gh api repos/a/b/pulls?per_page=5', 'gh api repos/a/b/contents/foo-Xbar', 'gh api repos/a/b/contents/x-f', 'gh api -X GET repos/a/b', 'gh api --method GET repos/a/b', 'gh api --method=get repos/a/b', 'gh api -XGET repos/a/b',
  'gh api repos/a/b -H "Accept: application/vnd.github+json"', 'gh api repos/a/b --jq ".name"', 'gh api repos/a/b -q .name', 'gh api repos/a/b/commits --paginate', 'gh api -H "X-Foo: -f" repos/a/b', 'gh codeql version', 'gh issue view 5',
  'forge test', 'forge build', 'forge script S.s.sol --rpc-url x', 'forge fmt --check', 'cast call 0x0 "f()"', 'cast block-number', 'cast --version', 'cast sig "send(address)"',
  'for f in a b; do echo $f; done', 'if true; then echo ok; fi', '# git push --force', 'echo ok # ssh host', 'git commit -m "x" # push --force',
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
    for (const stdin of ['not json', '', JSON.stringify({ tool_input: {} }), JSON.stringify({ tool_input: { command: 5 } }), bash('echo "unterminated'), bash("echo 'x"), bash('echo $(ssh')]) {
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
