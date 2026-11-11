import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { decide as guardDecide } from '../.claude/hooks/command-guard.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const HOOK = path.join(ROOT, '.claude', 'hooks', 'readonly-guard.mjs')
const AGENTS = path.join(ROOT, '.claude', 'agents')

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
  'gh pr create --title x', 'gh pr merge 5', 'gh pr comment 5 -b x', 'gh pr checkout 5', 'gh pr edit 5', 'gh pr close 5', 'gh -R a/b pr close 5', 'gh issue create', 'gh issue comment 5', 'gh release create v1', 'gh workflow run x', 'gh run download 5', 'gh run rerun 5', 'gh repo delete a/b', 'gh repo clone a/b', 'gh auth login', 'gh alias set x y', 'gh gist create f',
  'gh api -X POST repos/a/b/issues', 'gh api -XPOST x', 'gh api repos/a/b --method=DELETE', 'gh api repos/a/b/issues -f title=x', 'gh api repos/a/b/issues -ftitle=x', 'gh api x -Fn=1', 'gh api x --field=a=b', 'gh api x --input=f', 'gh api -iX PATCH x',
  'bash', 'echo x | sh', 'eval "$CMD"',
]
const RO_ALLOWED = [
  'git status', 'git log --oneline -5', 'git diff origin/main...HEAD --stat', 'git fetch origin main', 'git fetch origin', 'git fetch --depth 1 origin main', 'git fetch origin pull/5/head', 'git worktree add --detach /tmp/wt origin/main',
  'git worktree remove /tmp/wt', 'git worktree remove --force /tmp/wt', 'git worktree list', 'git -C /tmp/wt rev-parse HEAD', 'git show HEAD:package.json', 'git branch --show-current', 'git branch -a', 'git branch -r --contains abc', 'git branch --list "chore/*"',
  'git remote -v', 'git log -1 --format=%H', 'git merge --no-commit origin/main', 'git merge --no-commit --no-ff x', 'git merge --abort', 'git merge --quit', 'git checkout --detach origin/main',
  'git ls-files', 'git blame -L1,5 file', 'git grep -n "git push" docs', 'git config --get remote.origin.url', 'git tag -l "v*"', 'git describe --tags',
  'npm ci', 'npm test', 'npx tsc --noEmit', 'npx --no-install vitest run',
  'gh pr view 5 --json state', 'gh pr diff 5', 'gh pr list', 'gh pr status', 'gh pr checks 5', 'gh -R a/b pr checks 5', 'gh --repo a/b pr view 5', 'gh api repos/a/b/pulls/5', 'gh api repos/a/b/pulls?per_page=5', 'gh api -X GET repos/a/b', 'gh api repos/a/b -H "Accept: x" --jq .name',
  'gh issue view 5', 'gh issue list', 'gh repo view', 'gh run view 5', 'gh run list', 'gh --version', 'gh',
  'grep -rn "git push" docs', "grep -rn 'git push --force' docs", 'rg "gh pr merge" docs', 'git log --grep="git commit"', 'echo "git push"', 'echo "do not git commit here" | cat', 'git log --oneline | grep "git push"', 'ls -la', 'cat package.json',
]

const { decide: roDecide, isReadOnlyAgent } = await import('../.claude/hooks/readonly-guard.mjs')

describe('readonly-guard decide() — refused', () => {
  for (const c of RO_REFUSED) it(`refuses: ${JSON.stringify(c)}`, () => expect(roDecide(c), c).toEqual(expect.any(String)))
})
describe('readonly-guard decide() — allowed (a quoted "git push" is not a push)', () => {
  for (const c of RO_ALLOWED) it(`allows: ${JSON.stringify(c)}`, () => expect(roDecide(c), c).toBeNull())
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
  'grep -rn "git push" docs', "grep -rn 'git push --force' docs", 'grep -n "ssh" README.md', 'grep -rn "\\.env" src', 'grep -n ".env" scripts/x.sh', 'grep -rn ".env.example" docs', 'rg ".env" docs', 'rg -e .env docs',
  'git log --grep=".env"', 'git grep -n "git push" -- docs', 'grep -rn "cast send" docs', 'grep -rn "gh pr create" docs', 'grep -c "history" docs/x.md', 'echo "git push --force"',
  'cat .env.example', 'cat ./.env.example', 'ls -la', 'ls *', 'ls -a', 'ls .env.example', 'cat package.json', 'sed -n "1,5p" file', 'ls docs/ssh', 'npm view ssh2 version', 'command -v ssh', 'which ssh',
  'npm ci', 'npm test', 'npm run build', 'npm run lint', 'npm audit', 'npm audit --json', 'npm audit --omit=dev', 'npm run audit:fix-report', 'npx tsc --noEmit', 'npx --no-install vitest run', './node_modules/.bin/vitest run', 'FOO=1 npm test',
  'env FOO=1 npm test', 'cd x && npm test', 'timeout 60 npm test', 'echo hi | cat', 'xargs echo', 'find . -name "*.ts"', 'node scripts/goal-lint.mjs goal.md', 'bash scripts/agent-verify.sh', 'bash -c "echo hi"', 'sh -c "git status"', 'eval "git status"',
  'bash -lc "npm test"', 'diff <(git show a:f) <(git show b:f)', 'echo "$(git rev-parse HEAD)"', 'git diff --stat 2>&1 | tail', 'rsync -a src/ dst/', 'rsync -a ./a ./b',
  'gh pr view 5', 'gh pr view 5 --json state', 'gh pr diff 5', 'gh pr checks 5', 'gh pr checkout 5', 'gh pr list', 'gh pr list --state merged', 'gh pr status', 'gh -R a/b pr view 5', 'gh --repo a/b pr checks 5',
  'gh api repos/a/b/pulls/5', 'gh api repos/a/b/pulls?per_page=5', 'gh api repos/a/b/contents/foo-Xbar', 'gh api repos/a/b/contents/x-f', 'gh api -X GET repos/a/b', 'gh api --method GET repos/a/b', 'gh api --method=get repos/a/b', 'gh api -XGET repos/a/b',
  'gh api repos/a/b -H "Accept: application/vnd.github+json"', 'gh api repos/a/b --jq ".name"', 'gh api repos/a/b -q .name', 'gh api repos/a/b/commits --paginate', 'gh api -H "X-Foo: -f" repos/a/b', 'gh issue view 5',
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
const A77_TABLE_B_READONLY = ['gh pr checks 5', 'git merge --no-commit origin/main', 'grep -rn "git push" docs', ...A77_TABLE_B_ALL.filter((c) => !/^git (commit|push)/.test(c))]

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
    expect(roDecide(c), c).toBeNull()
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
  'gh api repos/a/b/pulls/5', 'gh api -X GET repos/a/b', 'gh api --method GET repos/a/b', 'gh api repos/a/b -H "Accept: x" --jq .name',
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
  'cast chain-id', 'cast gas-price', 'cast nonce 0x0', 'cast logs --from-block 1', 'cast estimate 0x0 "f()"', 'cast sig "f()"', 'cast sig "send(address)"', 'cast 4byte 0xa9059cbb', 'cast 4byte-decode 0x', 'cast abi-decode "f()(uint256)" 0x',
  'cast abi-encode "f(uint256)" 1', 'cast calldata "f(uint256)" 1', 'cast calldata-decode "f()" 0x', 'cast keccak x', 'cast to-wei 1', 'cast to-hex 5', 'cast from-wei 1', 'cast --version', 'cast --help', 'cast',
  'cast send --help', 'cast send -h', 'cast wallet new --help', 'cast erc20 transfer --help',
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
  'git config --global --get core.editor', 'git fetch', 'git fetch origin', 'git fetch origin main', 'git fetch --depth 1 origin main', 'git fetch origin pull/5/head', 'git worktree add /tmp/w origin/main', 'git worktree add --detach /tmp/w origin/main',
  'git worktree remove /tmp/w', 'git worktree remove --force /tmp/w', 'git worktree list', 'git checkout --detach origin/main', 'git merge --no-commit origin/main', 'git merge --no-commit --no-ff x', 'git merge --abort', 'git merge --quit', 'git -C /tmp/w status', 'git --no-pager log -1',
]
const RO_GIT_UNLISTED = [
  'git commit -m x', 'git push', 'git pull', 'git add .', 'git rm f', 'git mv a b', 'git reset --hard', 'git clean -fd', 'git stash', 'git stash list', 'git restore f', 'git apply p', 'git am p', 'git rebase main', 'git cherry-pick abc', 'git revert HEAD',
  'git merge origin/main', 'git merge --continue', 'git checkout .', 'git checkout -- .', 'git checkout main', 'git checkout origin/main', 'git checkout -b x', 'git checkout abc123', 'git switch main', 'git switch --detach x', 'git switch -c x',
  'git worktree add -b x /tmp/w origin/main', 'git worktree add -B x /tmp/w', 'git worktree prune', 'git worktree move a b', 'git worktree lock a', 'git branch x', 'git branch -D x', 'git branch -m a b', 'git tag v1', 'git tag -d v1', 'git tag -a v1 -m x',
  'git config user.name x', 'git config --list', 'git config --unset user.name', 'git config --get', 'git fetch origin a:b', 'git fetch +refs/heads/*:refs/x/*', 'git fetch --prune', 'git fetch --refmap=x:y origin main', 'git remote add x y', 'git remote get-url origin', 'git remote show origin',
  'git rev-list HEAD', 'git merge-base a b', 'git reflog', 'git update-ref -d x', 'git symbolic-ref HEAD x', 'git gc', 'git fsck', 'git init', 'git clone a b', 'git submodule update', 'git bisect start', 'git notes add', 'git archive HEAD -o x.tar', 'git bundle create x',
  'git log --output=f', 'git diff --output=f', 'git grep -O sh x', 'git grep --no-index x', 'git -c core.pager=sh log', 'git -c alias.x=y x', 'git --exec-path=/x log', 'git credential fill', 'git hash-object -w f', 'git fast-import',
]

describe('allow-list: gh', () => {
  it('lists are big enough to mean something', () => { expect(GH_UNLISTED.length).toBeGreaterThanOrEqual(20) })
  for (const c of GH_PERMITTED) it(`permits: ${JSON.stringify(c)}`, () => expect(guardDecide(c), c).toBeNull())
  for (const c of GH_UNLISTED) it(`refuses: ${JSON.stringify(c)}`, () => expect(guardDecide(c), c).toEqual(expect.any(String)))
  it('read-only agents lose `pr checkout` (it writes a local branch) and keep the rest', () => {
    expect(roDecide('gh pr checkout 5')).toEqual(expect.any(String))
    for (const c of GH_PERMITTED.filter((x) => x !== 'gh pr checkout 5')) expect(roDecide(c), c).toBeNull()
    for (const c of GH_UNLISTED) expect(roDecide(c), c).toEqual(expect.any(String))
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
  for (const c of RO_GIT_PERMITTED) it(`permits: ${JSON.stringify(c)}`, () => { expect(roDecide(c), c).toBeNull(); expect(guardDecide(c), c).toBeNull() })
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
