# Runbook — Signed Commits (GPG / SSH)

**Scope:** every commit pushed to `TeraHashAlpha/teraswap` must carry a cryptographic signature that GitHub verifies green. Branch protection on `main` rejects unsigned commits at the PR level, so an unsigned commit cannot reach the deployed branch even if it lands on a feature branch first.

**Audience:** anyone with push access (founder, contributors, future team).

**Why:** CVE-2026-3854 demonstrated remote code execution against GitHub itself via a single push, affecting millions of repos. CI checks and human review do not cryptographically attest *who wrote the commit*. Signed commits do — they tie every change to a key that lives only in the author's hardware/keychain. A compromised CI worker, a stolen GitHub session, or a future GitHub-side RCE cannot forge a signature it doesn't hold.

---

## 1. One-time setup (per developer + per machine)

Pick **one** signing path. SSH signing is simpler if you already authenticate to GitHub via SSH; GPG is the more traditional option and works on any host.

### Option A — SSH signing (recommended)

Uses the SSH key you already have for `git push`. Requires git ≥ 2.34.

```bash
# 1. Confirm git version (must be >= 2.34)
git --version

# 2. Configure git to sign with SSH using your existing key
git config --global gpg.format ssh
git config --global user.signingkey ~/.ssh/id_ed25519.pub   # adjust path if different
git config --global commit.gpgsign true
git config --global tag.gpgsign true

# 3. Tell git which keys are allowed to verify (so `git log --show-signature`
#    can validate locally too). One line per key, format: <email> <key-type> <key>.
mkdir -p ~/.config/git
echo "your.email@example.com $(cat ~/.ssh/id_ed25519.pub)" >> ~/.config/git/allowed_signers
git config --global gpg.ssh.allowedSignersFile ~/.config/git/allowed_signers
```

Add the **public** key to GitHub as a **signing key** (separate from auth keys):

1. Open https://github.com/settings/ssh/new
2. **Key type:** *Signing Key* (NOT *Authentication Key*)
3. Paste the contents of `~/.ssh/id_ed25519.pub`
4. Save

The same key can be registered twice — once as Authentication, once as Signing. You need both entries for `git push` and signature verification to work.

### Option B — GPG signing

Use this if you don't have an SSH key for GitHub or you specifically need GPG for other workflows (release tags, package signing, etc.).

```bash
# 1. Generate a key (4096-bit RSA, no expiry; or use --quick-generate-key for ed25519)
gpg --full-generate-key
# Select: (1) RSA and RSA, 4096 bits, 0 = key does not expire, real name, email matching GitHub

# 2. List keys and copy the long key ID
gpg --list-secret-keys --keyid-format=long
# Look for "sec   rsa4096/<KEY_ID>" — that hex after the slash is your KEY_ID

# 3. Export the public block to paste into GitHub
gpg --armor --export <KEY_ID>

# 4. Configure git
git config --global user.signingkey <KEY_ID>
git config --global commit.gpgsign true
git config --global tag.gpgsign true
git config --global gpg.program "$(which gpg)"
```

Add the public key block to GitHub: https://github.com/settings/gpg/new → paste the entire `-----BEGIN PGP PUBLIC KEY BLOCK-----` … `-----END PGP PUBLIC KEY BLOCK-----` block.

**Important:** the email on the GPG key MUST match the email GitHub has registered for your account (or be a *verified* secondary email). Otherwise GitHub will show the commit as "Unverified" even when the signature itself is valid.

#### macOS GPG note

On macOS, GPG often can't find the agent when called from non-interactive shells (CI runs, IDE git integrations). One-time fix:

```bash
brew install gnupg pinentry-mac
echo "pinentry-program $(brew --prefix)/bin/pinentry-mac" >> ~/.gnupg/gpg-agent.conf
echo "use-agent" >> ~/.gnupg/gpg.conf
echo "export GPG_TTY=\$(tty)" >> ~/.zshrc   # or ~/.bashrc
gpgconf --kill gpg-agent
```

---

## 2. Verify the setup works

```bash
# 1. Make a trivial signed commit on a throwaway branch
cd /path/to/your/clone
git checkout -b verify-signing-$(date +%s)
echo "// signature smoke test" >> /tmp/sig-test
git add /tmp/sig-test 2>/dev/null || true
git commit --allow-empty -m "test: verify signed-commit setup"

# 2. Inspect locally — should print "Good signature" + your name/email
git log --show-signature -1

# 3. Push to GitHub on a branch (NOT main)
git push -u origin verify-signing-$(date +%s)

# 4. Open the commit on github.com — it should show a green "Verified" badge
#    next to the commit hash. If it shows "Unverified" or no badge:
#      - GPG: email mismatch (see §1B "Important")
#      - SSH: key not registered as a Signing Key (see §1A "Important")

# 5. Clean up
git checkout main
git branch -D verify-signing-*
git push origin --delete verify-signing-*
```

If steps 2 and 4 both pass, signing is working. From here every `git commit` will be signed automatically — no extra flag needed.

---

## 3. Branch protection rules on `main`

Configured in GitHub Settings → Branches → Branch protection rules → Add rule, target `main`. Apply ALL of these:

| Rule | Setting | Why |
|------|---------|-----|
| Require a pull request before merging | ✅ on | No direct pushes to `main` |
| Required approvals | **1** minimum | At least one human review |
| Dismiss stale approvals when new commits are pushed | ✅ on | Re-review after force-pushed-to-feature-branch changes |
| Require review from Code Owners | optional | Enable once `CODEOWNERS` exists |
| Require status checks to pass | ✅ on | CI gate |
| Required status checks | `ci`, `security-audit` | Both must be green |
| Require branches to be up to date before merging | ✅ on | Prevents stale-base merges |
| **Require signed commits** | **✅ on** | This is what makes the runbook bite |
| Require conversation resolution before merging | ✅ on | No unanswered review threads |
| Require linear history | ✅ on | No merge commits — only squash or rebase |
| Do not allow force pushes | ✅ on | Protects history |
| Do not allow deletions | ✅ on | `main` cannot be deleted |
| Restrict who can push to matching branches | leave default | Inherits org perms |
| Allow administrators to bypass | ❌ **off** | No admin shortcut except via §5 break-glass |

After saving, the next unsigned commit pushed *to* `main` (via PR merge or otherwise) is rejected with: `! [remote rejected] main -> main (committer email or signature missing)`.

---

## 4. Troubleshooting

### "Commit pushes are rejected with `signing failed: secret key not available`"

Your signing key isn't reachable to git. Check the agent:

```bash
gpg --list-secret-keys                    # GPG: is the secret key listed?
ssh-add -l                                # SSH: is the key in the agent?
git config --get user.signingkey          # confirm git knows which key to use
```

For GPG, this often happens after a reboot — `gpg-agent` died. Restart it:

```bash
gpgconf --kill gpg-agent
gpgconf --launch gpg-agent
```

### "GitHub shows the commit as `Unverified`"

The signature itself is valid (`git log --show-signature` says "Good signature") but GitHub doesn't recognise it. Three causes, in order of likelihood:

1. **Email mismatch.** The email on the key (GPG) or the email on the commit (`git config user.email`) does not match a verified email on the GitHub account. Add it under https://github.com/settings/emails or change `user.email`.
2. **Key not registered.** Add it under https://github.com/settings/keys (auth) AND https://github.com/settings/gpg/new or https://github.com/settings/ssh/new (signing).
3. **Wrong format.** SSH-signed commits with `gpg.format = openpgp` (default) won't verify. Run `git config --global gpg.format ssh`.

### "I committed unsigned by accident, push was rejected"

Re-sign the offending commits in place:

```bash
# Re-sign just the last commit
git commit --amend --no-edit -S

# Re-sign a range (last N commits) — replace 5 with your N
git rebase -i HEAD~5 --exec 'git commit --amend --no-edit -S'

git push --force-with-lease     # force-with-lease is safe; bare --force is not
```

`--force-with-lease` only succeeds if your local view of the remote is up-to-date, so it can't accidentally clobber a teammate's push.

---

## 5. Break-glass: emergency unsigned merge

There is no admin bypass on `main` (see §3 — "Allow administrators" is off). A genuine emergency where a fix MUST land on `main` without a signature requires a deliberate, audit-trailed procedure:

1. Founder logs into GitHub Settings → Branches → `main` → temporarily uncheck **Require signed commits**.
2. Merge the unsigned PR.
3. **Immediately** re-check **Require signed commits**.
4. Open an incident in `Audits/Incidents/INC-YYYY-MM-DD-NNN.md` documenting:
   - What was merged unsigned and why
   - Who approved the bypass
   - Time-window where the rule was off (should be < 60 seconds)
   - Why signing wasn't possible (lost key? compromised hardware? other?)
   - Remediation: re-sign the commits via §4 "I committed unsigned" within 24h, OR justify the gap in writing.

The repo's CI security-audit job inspects the incident log monthly. An undocumented gap is a compliance finding.

---

## 6. Related

- ADR-006 (proposed) — Signed-commit policy and supply-chain assumptions
- `docs/Runbooks/executor-compromise.md` — adjacent supply-chain incident response
- CVE-2026-3854 — GitHub RCE via push, the trigger for this policy
- CLAUDE.md → Do NOT §12 — repo-wide rule mirroring this runbook
