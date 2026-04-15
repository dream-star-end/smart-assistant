/**
 * Context Packer (P1.4)
 *
 * Dynamically selects and packs retrieval results into a token-budgeted
 * context window. Maximizes relevance within the available budget.
 *
 * Strategy: greedy knapsack — iterate candidates by descending relevance,
 * add each if it fits within remaining budget, skip if too large.
 *
 * Token estimation uses a CJK-aware heuristic rather than a full tokenizer,
 * trading accuracy for zero dependencies.
 */

// ── Token estimation ─────────────────────────────

// CJK range patterns for detecting mixed content
const CJK_RE = /[\u2E80-\u9FFF\uF900-\uFAFF]/

/**
 * Estimate token count from text.
 *
 * CJK characters ≈ 1 token each. English/Latin ≈ 1 token per ~4 chars.
 * Counts CJK chars individually and divides the rest by 4 for a conservative
 * estimate that works for mixed Chinese+English content.
 */
export function estimateTokens(text: string): number {
  let cjkCount = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    // CJK Unified Ideographs and common CJK ranges
    if ((code >= 0x2E80 && code <= 0x9FFF) || (code >= 0xF900 && code <= 0xFAFF)) {
      cjkCount++
    }
  }
  const nonCjkChars = text.length - cjkCount
  // CJK: ~1 token each. Non-CJK: ~1 token per 4 chars (conservative)
  return Math.ceil(cjkCount + nonCjkChars / 4)
}

/**
 * Estimate tokens for a formatted item including its `[source] ` prefix.
 */
function estimateItemTokens(content: string, source: string): number {
  // Account for the "[source] " prefix and "\n\n" separator
  return estimateTokens(`[${source}] ${content}`) + 1 // +1 for \n\n separator
}

// ── Packer ───────────────────────────────────────

export interface PackerCandidate {
  /** Unique identifier */
  id: string
  /** Text content to inject into context */
  content: string
  /** Relevance score (higher = better) */
  score: number
  /** Source label (e.g. "archival", "session", "core_memory") */
  source: string
}

export interface PackerResult {
  /** Selected candidates sorted by score descending */
  items: PackerCandidate[]
  /** Total estimated tokens used (including formatting overhead) */
  totalTokens: number
  /** Number of unique candidates that were skipped due to budget */
  skippedCount: number
}

export interface PackerOptions {
  /** Max tokens for the packed context (default: 4000) */
  tokenBudget?: number
  /** Max content length per item in chars — truncate longer items (default: 2000) */
  maxItemChars?: number
  /** Min score threshold — skip items below this score (default: 0) */
  minScore?: number
  /**
   * Token budget reserved for higher-priority sources.
   * E.g. { core_memory: 1000 } reserves 1000 tokens for core_memory items
   * before general allocation.
   */
  reservedBudgets?: Record<string, number>
}

/**
 * Pack candidates into a token-budgeted context.
 *
 * Algorithm:
 * 1. Filter and truncate candidates, sort by score descending
 * 2. Phase 1: fill reserved budgets for specific sources
 * 3. Phase 2: fill remaining budget with all remaining candidates (greedy)
 * 4. Sort final selection by score descending
 *
 * Token accounting includes formatting overhead ([source] prefix, separators).
 *
 * @param candidates  Retrieval results to pack
 * @param options     Budget and filtering options
 * @returns Packed result with selected items and metadata
 */
export function packContext(
  candidates: PackerCandidate[],
  options: PackerOptions = {},
): PackerResult {
  const budget = options.tokenBudget ?? 4000
  const maxItemChars = options.maxItemChars ?? 2000
  const minScore = options.minScore ?? 0

  // Filter by min score and truncate content (keep within maxItemChars exactly)
  const prepared = candidates
    .filter(c => c.score >= minScore && c.content.length > 0)
    .map(c => ({
      ...c,
      content: c.content.length > maxItemChars
        ? c.content.slice(0, maxItemChars)
        : c.content,
    }))
    .sort((a, b) => b.score - a.score)

  if (budget <= 0) {
    return { items: [], totalTokens: 0, skippedCount: prepared.length }
  }

  const selectedIds = new Set<string>()
  let usedTokens = 0
  const reservedBudgets = options.reservedBudgets ?? {}

  // Track per-source reserved usage
  const reservedUsed: Record<string, number> = {}
  for (const source of Object.keys(reservedBudgets)) {
    reservedUsed[source] = 0
  }

  // Phase 1: Fill reserved budgets for specific sources
  for (const candidate of prepared) {
    const sourceBudget = reservedBudgets[candidate.source]
    if (sourceBudget === undefined) continue

    const tokens = estimateItemTokens(candidate.content, candidate.source)
    const sourceRemaining = sourceBudget - (reservedUsed[candidate.source] ?? 0)

    if (tokens <= sourceRemaining && usedTokens + tokens <= budget) {
      selectedIds.add(candidate.id)
      usedTokens += tokens
      reservedUsed[candidate.source] = (reservedUsed[candidate.source] ?? 0) + tokens
    }
  }

  // Phase 2: Fill remaining budget with all unselected candidates
  for (const candidate of prepared) {
    if (selectedIds.has(candidate.id)) continue

    const tokens = estimateItemTokens(candidate.content, candidate.source)
    if (usedTokens + tokens <= budget) {
      selectedIds.add(candidate.id)
      usedTokens += tokens
    }
  }

  // Build final list in score order
  const items = prepared.filter(c => selectedIds.has(c.id))
  const skippedCount = prepared.length - items.length

  return {
    items,
    totalTokens: usedTokens,
    skippedCount,
  }
}

/**
 * Format packed items into a single context string for injection into prompts.
 *
 * @param result  PackerResult from packContext()
 * @param header  Optional header text (e.g. "## Relevant Context")
 * @returns Formatted context string
 */
export function formatPackedContext(result: PackerResult, header?: string): string {
  if (result.items.length === 0) return ''

  const parts: string[] = []
  if (header) parts.push(header)

  for (const item of result.items) {
    parts.push(`[${item.source}] ${item.content}`)
  }

  return parts.join('\n\n')
}
