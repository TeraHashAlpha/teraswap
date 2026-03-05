---
name: sc-audit
description: >
  Smart contract security auditor for Solidity contracts. Performs comprehensive multi-phase
  audits combining static analysis, vulnerability scanning, invariant testing, and adversarial
  reasoning. MANDATORY TRIGGERS: audit, security review, vulnerability scan, smart contract
  security, Solidity audit, contract review, pentest, security assessment, find bugs in contract,
  check for exploits, reentrancy check, access control review. Use this skill whenever the user
  mentions auditing, reviewing, or checking the security of any .sol file or smart contract code,
  even casually (e.g. "is this contract safe?", "check this for bugs", "review my contract").
---

# Smart Contract Security Auditor

A comprehensive 4-phase audit methodology combining the best techniques from Trail of Bits,
Pashov Audit Group, QuillShield, Archethect sc-auditor, and SCV-Scan. Produces professional
audit reports with severity classifications, PoC attack narratives, and remediation guidance.

## Before You Begin

Read the vulnerability cheatsheet at `references/cheatsheet.md` — this is your lookup table
for all vulnerability patterns and detection heuristics. Having it loaded before examining any
code ensures consistent, thorough coverage.

If the contract is in this repository, locate all `.sol` files first:
```bash
find . -name "*.sol" -not -path "*/node_modules/*" -not -path "*/lib/*"
```

## Audit Methodology: MAP → HUNT → ATTACK → REPORT

### Phase 1: MAP (System Understanding)

Build a mental model of the system before looking for bugs. Rushing to find vulnerabilities
without understanding architecture leads to false positives and missed issues.

**1.1 — Scope & Architecture**
- Identify all contracts, their inheritance hierarchy, and deployment configuration
- Map external dependencies (OpenZeppelin, Chainlink, Uniswap, etc.)
- Note the compiler version and any unusual pragma settings
- Identify the protocol type (lending, DEX, vault, NFT, governance, bridge, etc.)

**1.2 — Entry Point Analysis** (inspired by Trail of Bits)
- List every `external` and `public` function that modifies state
- Classify access levels:
  - **Unrestricted** (anyone can call — highest risk)
  - **Role-restricted** (onlyOwner, onlyAdmin, specific roles)
  - **Conditional** (requires specific state, e.g. not paused)
  - **Internal-only** (called by other contracts or callbacks)
- Ignore `view`/`pure` functions for attack surface — they can't change state

**1.3 — State & Invariant Mapping**
- Document every storage variable and its expected range/constraints
- Identify mathematical invariants the system must maintain:
  - Conservation: `totalSupply == sum(balances)`
  - Monotonic: `nonce` only increases
  - Bounds: `fee <= MAX_FEE`
  - Ratio: `collateralRatio >= MIN_RATIO`
- These invariants become your test oracle in Phase 2

**1.4 — Trust Boundaries**
- Who can change critical parameters? (admin, governance, timelock)
- What external data does the contract consume? (oracles, user input, other contracts)
- Where does value flow? (deposits, withdrawals, fee collection)

Output a brief architecture summary before proceeding.

---

### Phase 2: HUNT (Vulnerability Detection)

Systematically scan for vulnerabilities using two complementary passes. This dual approach
catches both syntactic patterns (grep-able) and semantic issues (logic-level).

**2.1 — Syntactic Pass**
Scan for keyword patterns that indicate potential issues. For each pattern found, don't
immediately flag it — note it as a candidate for validation in Phase 3.

Key patterns to grep for:
- `call{value:` / `.call(` / `delegatecall` / `staticcall` → reentrancy, unchecked returns
- `tx.origin` → phishing vulnerability
- `block.timestamp` / `block.number` → timestamp manipulation
- `selfdestruct` / `suicide` → forced ether
- `assembly` / `mstore` / `sload` → low-level manipulation risks
- `ecrecover` → signature malleability
- `abi.encodePacked` with multiple dynamic types → hash collision
- `.transfer(` / `.send(` → 2300 gas limit issues
- `delete` on mappings → incomplete state cleanup
- Unchecked arithmetic in Solidity <0.8 or inside `unchecked {}` blocks
- Missing `address(0)` checks on critical parameters
- Missing return value checks on ERC20 `transfer`/`transferFrom`

**2.2 — Semantic Pass (Behavioral State Analysis)**
This catches vulnerabilities that have no syntactic marker. Review each state-changing function
and ask these questions:

- **Consistency Principle**: If function A enforces a check, do all similar functions enforce it
  too? A missing check in one path when others have it is a strong signal.
- **State Transition Safety**: Can this function be called in an unexpected order? What if it's
  called twice? What if it's called with the same parameters?
- **Cross-Function Reentrancy**: Does this function call external code before updating state?
  Does another function read the stale state?
- **Access Escalation**: Can a low-privilege user influence parameters that affect high-privilege
  operations?
- **Economic Invariant**: Does this function maintain or break the invariants from Phase 1?

**2.3 — Detection Layers**
Apply each specialized detection layer from the cheatsheet (read `references/cheatsheet.md`):

1. Reentrancy (all variants: same-function, cross-function, cross-contract, read-only)
2. Access Control & Authorization
3. Oracle & Price Manipulation
4. Flash Loan Attack Vectors
5. Arithmetic & Precision Loss
6. Proxy & Upgrade Safety
7. Input Validation
8. External Call Safety (weird ERC20s, unchecked returns)
9. Signature & Replay Protection
10. DoS & Griefing (unbounded loops, gas exhaustion, storage bloat)
11. MEV & Frontrunning
12. State Invariant Violations

---

### Phase 3: ATTACK (Deep Validation)

Every candidate finding from Phase 2 must survive adversarial validation. This prevents
false positives and ensures findings are actionable.

**The Devil's Advocate Protocol** (from Archethect sc-auditor):

For each candidate finding, BEFORE confirming it:

1. **Trace the full call path** — follow the exact execution flow from entry point to the
   vulnerable code. Document each function call, state read, and external interaction.

2. **Search for mitigating controls** — actively look for reasons this ISN'T a vulnerability:
   - Is there a modifier or require that prevents the attack?
   - Does the function ordering make the attack impossible?
   - Is there a timelock or delay that neutralizes it?
   - Does another mechanism (e.g. reentrancy guard) block it?

3. **Construct the attack narrative** — write a step-by-step scenario:
   - Preconditions required
   - Exact sequence of transactions
   - Expected outcome for the attacker
   - Impact quantification (funds at risk, users affected)

4. **Classify confidence**:
   - **Confirmed**: Complete attack path with no mitigating controls found
   - **Likely**: Strong evidence, minor uncertainty about preconditions
   - **Possible**: Theoretical risk, some mitigating factors exist

**Evidence Mandate**: Every finding MUST include:
- Exact file and line numbers
- Code snippet showing the vulnerable pattern
- The attack narrative
- References to similar real-world exploits (if applicable)

---

### Phase 4: REPORT

Generate the audit report. Read `references/report-template.md` for the exact structure.

**Severity Classification:**

| Severity | Criteria | Examples |
|----------|----------|---------|
| **Critical** | Direct, unconditional loss of funds or complete protocol takeover | Reentrancy drain, unauthorized admin access, infinite mint |
| **High** | Conditional fund loss, access control breach, or severe protocol malfunction | Flash loan attack requiring specific market conditions, fee bypass |
| **Medium** | Unlikely fund loss, griefing attacks, or significant functionality impairment | DoS on non-critical function, minor economic manipulation |
| **Low** | Best practice violations, gas inefficiencies, or edge cases with minimal impact | Missing events, suboptimal storage patterns, unused variables |
| **Informational** | Code quality suggestions, documentation improvements | Naming conventions, NatSpec comments, code organization |

**For each finding, include:**
1. Title (descriptive, starts with severity)
2. Severity + Confidence (Confirmed/Likely/Possible)
3. Location (file:line)
4. Description (what the vulnerability is)
5. Attack Scenario (step-by-step)
6. Impact (what happens if exploited)
7. Recommendation (how to fix, with code example)

**Report sections:**
1. Executive Summary (scope, methodology, key stats)
2. Findings Summary Table (severity, title, status)
3. Detailed Findings (one per finding, using the template above)
4. Systemic Observations (architecture patterns, code quality)
5. Appendix: Files in Scope, Tools Used

---

## Output Format

Save the report as both Markdown and PDF (if PDF skill is available):
- `<project>-audit-report.md`
- `<project>-audit-report.pdf`

---

## Common Pitfalls to Avoid

- Don't flag Solidity >=0.8 arithmetic as overflow without checking for `unchecked` blocks
- Don't flag `call` as reentrancy if there's a `nonReentrant` modifier
- Don't flag admin-only functions as access control issues unless admin can be compromised
- Don't flag gas optimization in test/mock files
- Don't assume OpenZeppelin is vulnerable — focus on how the protocol uses it
- Always check if `SafeERC20` is used before flagging unchecked transfers
- Be careful with false positives — a wrong finding wastes developer time and erodes trust
