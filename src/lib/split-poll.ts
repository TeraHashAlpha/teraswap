/**
 * [fix/quote-rate-limit-normal-use] How a split refresh rides on the quote poll.
 *
 * A split analysis that must stay current would otherwise cost one more /api/quote request per poll. Instead the split
 * hook registers here, and useQuote asks as it builds each request: when the answer is yes it adds `split=1`, so the one
 * poll returns the quote and the sub-amount quotes together, priced at the same moment. useQuote owns the channel (it is
 * created per hook instance and handed to useSplitRoute), so no option or global state is involved.
 */
import type { QuoteKey } from './quote-identity'
import type { SplitBatch } from './split-routing-types'

/** A batch that arrived on a quote poll, stamped when it reached the browser (what its age is measured from). */
export type PolledSplit = SplitBatch & { receivedAt: number }

export interface SplitPollChannel {
  /** useSplitRoute: "should the request for this identity also fetch the split?". Returns an unregister function. */
  register(wants: (key: QuoteKey) => boolean): () => void
  /** useQuote, as it builds a request. False while nothing is registered. */
  wants(key: QuoteKey): boolean
}

export function createSplitPollChannel(): SplitPollChannel {
  let ask: ((key: QuoteKey) => boolean) | null = null
  return {
    register(wants) {
      ask = wants
      return () => {
        if (ask === wants) ask = null
      }
    },
    wants: (key) => ask?.(key) ?? false,
  }
}
