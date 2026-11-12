/**
 * [fix/portfolio-tokens-view] Wording the Portfolio tab shows in BOTH UIs. One module so v1 and v2 cannot drift apart
 * (v2 imports v1's logic rather than forking it; the parity sweep compares the rendered text).
 */

/** Shown when /api/portfolio/tokens answered `truncated: true`: catalog tokens are complete, the long tail may not be. */
export const PORTFOLIO_TRUNCATED_NOTE = 'This wallet holds a very large number of tokens, so the list may be incomplete.'
