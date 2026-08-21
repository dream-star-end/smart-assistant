/**
 * Shared Core lexical helpers. The strong-hit threshold lives here so
 * retrieval and auto-write dedup use the same number and the same rule.
 *
 * Strong hit: whole-query phrase match, or matched query-term characters
 * cover at least half the query (`matchedCharacters * CORE_COVERAGE_NUMERATOR
 * >= totalTermCharacters`).
 */

export const CORE_COVERAGE_NUMERATOR = 2

export function tokenizeCoreMemory(normalized: string, segmenter: Intl.Segmenter): string[] {
  const tokens: string[] = []
  for (const part of segmenter.segment(normalized)) {
    if (part.isWordLike) tokens.push(part.segment)
  }
  return tokens
}

export function coverageAtLeastHalf(matchedCharacters: number, totalTermCharacters: number): boolean {
  return totalTermCharacters > 0 && matchedCharacters * CORE_COVERAGE_NUMERATOR >= totalTermCharacters
}

export function coreQueryTerms(query: string): { q: string; terms: string[]; totalTermCharacters: number } {
  const q = query.normalize('NFKC').toLocaleLowerCase()
  const terms = [
    ...new Set(
      [...new Intl.Segmenter('zh', { granularity: 'word' }).segment(q)]
        .filter((part) => part.isWordLike)
        .map((part) => part.segment)
        .filter((term) => term.length >= 2 || term === q),
    ),
  ]
  const totalTermCharacters = terms.reduce((total, term) => total + term.length, 0)
  return { q, terms, totalTermCharacters }
}

/** Same strong-hit predicate core-search uses before BM25 ranking. */
export function isStrongLexicalDocument(query: string, content: string): boolean {
  const { q, terms, totalTermCharacters } = coreQueryTerms(query)
  const normalized = content.normalize('NFKC').toLocaleLowerCase()
  const phraseHit = q.length >= 2 && normalized.includes(q)
  if (phraseHit) return true
  const tokens = new Set(tokenizeCoreMemory(normalized, new Intl.Segmenter('zh', { granularity: 'word' })))
  let matchedCharacters = 0
  for (const term of terms) {
    if (tokens.has(term)) matchedCharacters += term.length
  }
  return coverageAtLeastHalf(matchedCharacters, totalTermCharacters)
}
