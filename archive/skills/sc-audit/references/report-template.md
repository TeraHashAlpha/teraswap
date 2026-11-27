# Audit Report Template

Use this exact structure for the final report.

---

# Security Audit Report: [PROJECT NAME]

**Auditor**: TeraSwap Security
**Date**: [DATE]
**Commit**: [GIT COMMIT HASH or "N/A"]
**Solidity Version**: [VERSION]
**Scope**: [LIST OF FILES]

---

## Executive Summary

[2-3 paragraph overview: what was audited, methodology used, high-level findings summary]

**Key Statistics:**
| Metric | Count |
|--------|-------|
| Files in scope | X |
| Lines of code | X |
| Critical findings | X |
| High findings | X |
| Medium findings | X |
| Low findings | X |
| Informational | X |

**Overall Risk Assessment**: [Critical / High / Moderate / Low]

---

## Findings Summary

| # | Title | Severity | Confidence | Status |
|---|-------|----------|------------|--------|
| 1 | [Title] | Critical | Confirmed | Open |
| 2 | [Title] | High | Likely | Open |
| ... | ... | ... | ... | ... |

---

## Detailed Findings

### [F-01] [SEVERITY] — [Descriptive Title]

**Severity**: Critical / High / Medium / Low / Informational
**Confidence**: Confirmed / Likely / Possible
**Location**: `[file.sol]:[line numbers]`

**Description**:
[Clear explanation of the vulnerability and why it matters]

**Vulnerable Code**:
```solidity
// [file.sol] lines X-Y
[paste the vulnerable code snippet]
```

**Attack Scenario**:
1. Attacker does X
2. This causes Y
3. Result: Z (quantify the impact)

**Impact**:
[What happens if exploited — funds at risk, users affected, protocol damage]

**Recommendation**:
```solidity
// Suggested fix
[code showing the remediation]
```

**References**:
- [Link to similar real-world exploit if applicable]
- [Relevant EIP or documentation]

---

[Repeat for each finding]

---

## Systemic Observations

### Architecture Quality
[Comments on overall design patterns, modularity, code organization]

### Test Coverage
[Assessment of test quality if tests were reviewed]

### Documentation
[Assessment of NatSpec, README, technical documentation]

### Centralization Risks
[Summary of admin powers and trust assumptions]

---

## Appendix

### A. Scope
| File | Lines | SHA256 |
|------|-------|--------|
| [file.sol] | [count] | [hash] |

### B. Methodology
Four-phase MAP → HUNT → ATTACK → REPORT methodology combining static analysis,
behavioral state analysis, invariant testing, and adversarial validation.

### C. Severity Definitions
- **Critical**: Direct, unconditional loss of funds or complete protocol takeover
- **High**: Conditional fund loss, access control breach, or severe protocol malfunction
- **Medium**: Unlikely fund loss, griefing attacks, or significant functionality impairment
- **Low**: Best practice violations, gas inefficiencies, or edge cases with minimal impact
- **Informational**: Code quality suggestions, documentation improvements

### D. Disclaimer
This audit does not guarantee the absence of vulnerabilities. It is a time-bounded
review based on the provided source code. The findings are based on the auditor's
assessment at the time of review. Smart contracts should undergo multiple independent
audits before handling significant value.
