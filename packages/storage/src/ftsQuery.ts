// FTS5 query encoding + CJK pre-tokenization shared by sessions_fts / archival_fts.
//
// unicode61 treats a contiguous CJK run as one token, so a natural-language
// query encoded as `"区间汇总"` only hits that exact run. Core-search already
// uses Intl.Segmenter('zh', { granularity: 'word' }). We apply the same
// segmenter to CJK runs on both write and query, and keep the historical
// `[\p{L}\p{N}_]+` splitter for Latin/digits so ATR / farinograph / filenames
// / shas / dotted versions do not change.

const CJK_CHAR_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
const CJK_RUN_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu
const WORD_TOKEN_RE = /[\p{L}\p{N}_]+/gu

let _zhSegmenter: Intl.Segmenter | null | undefined

function getZhSegmenter(): Intl.Segmenter | null {
  if (_zhSegmenter !== undefined) return _zhSegmenter
  try {
    _zhSegmenter = new Intl.Segmenter('zh', { granularity: 'word' })
  } catch {
    _zhSegmenter = null
  }
  return _zhSegmenter
}

export function hasCjkChar(text: string): boolean {
  return CJK_CHAR_RE.test(text)
}

/** Word pieces of one CJK run. Falls back to per-character tokens. */
export function splitCjkRun(run: string): string[] {
  const segmenter = getZhSegmenter()
  if (!segmenter) return Array.from(run)
  const words: string[] = []
  for (const part of segmenter.segment(run)) {
    if (part.isWordLike) words.push(part.segment)
  }
  return words.length > 0 ? words : Array.from(run)
}

export function cjkCharBigrams(run: string): string[] {
  const chars = Array.from(run)
  const out: string[] = []
  for (let i = 0; i + 1 < chars.length; i++) out.push(`${chars[i]}${chars[i + 1]}`)
  return out
}

function uniquePush(out: string[], seen: Set<string>, token: string): void {
  if (!token || seen.has(token)) return
  seen.add(token)
  out.push(token)
}

/**
 * CJK-only index tokens for `sessions_fts.content_fts`.
 * Original `content` stays intact (and indexed) so English / exact CJK runs
 * keep their historical BM25 identity; this column only adds word + bigram
 * pieces so a query term like `汇总` can hit inside `区间汇总`.
 */
export function cjkFtsColumn(text: string): string {
  if (!text) return ''
  const out: string[] = []
  const seen = new Set<string>()
  for (const match of text.matchAll(CJK_RUN_RE)) {
    const run = match[0]
    for (const word of splitCjkRun(run)) uniquePush(out, seen, word)
    for (const gram of cjkCharBigrams(run)) uniquePush(out, seen, gram)
  }
  return out.join(' ')
}

/**
 * Rewrite mixed text for archival_fts (and any FTS column that *is* the
 * searchable text): keep Latin/digits/punctuation, and expand each CJK run
 * into `original + segmenter words + char bigrams` so unicode61 indexes them
 * as separate tokens without dropping the exact run.
 */
export function tokenizeCjkForFts(text: string): string {
  if (!text) return ''
  return text.replace(CJK_RUN_RE, (run) => {
    const extra: string[] = []
    const seen = new Set<string>([run])
    for (const word of splitCjkRun(run)) uniquePush(extra, seen, word)
    for (const gram of cjkCharBigrams(run)) uniquePush(extra, seen, gram)
    return extra.length > 0 ? `${run} ${extra.join(' ')}` : run
  })
}

function quoteFtsToken(token: string): string {
  return `"${token.replace(/"/g, '""')}"`
}

/**
 * Expand one regex token for MATCH. Latin tokens are unchanged. A CJK token
 * becomes segmenter words of length ≥ 2 (same cutoff as core-search). If the
 * segmenter only produced 1-char pieces (`汇总` → 汇+总), keep the original
 * so it can hit a stored bigram or the exact run in `content`.
 */
export function expandFtsQueryToken(token: string, wholeQuery: string): string[] {
  if (!hasCjkChar(token)) return [token]
  const words = splitCjkRun(token).filter((word) => word.length >= 2)
  if (words.length > 0) return words
  const trimmed = wholeQuery.trim()
  if (token.length >= 2 || token === trimmed) return [token]
  return []
}

function literalTokenQuery(query: string): string {
  const raw = query.match(WORD_TOKEN_RE) ?? []
  const latin: string[] = []
  const cjk: string[] = []
  for (const token of raw) {
    for (const piece of expandFtsQueryToken(token, query)) {
      if (hasCjkChar(piece)) cjk.push(piece)
      else latin.push(piece)
    }
  }
  const implicitAnd = (tokens: string[]) => tokens.map(quoteFtsToken).join(' ')
  // Short CJK phrases stay AND (任务+面板). Conversational queries mint
  // many filler words (之前/那个/会话); AND of all of them is why
  // session-search returned empty. OR + BM25 matches core-search scoring.
  // FTS5 rejects implicit-AND next to a parenthesized OR group, so AND is
  // explicit only when an OR group is present.
  if (cjk.length <= 2) return implicitAnd([...latin, ...cjk])
  const orGroup = `(${cjk.map(quoteFtsToken).join(' OR ')})`
  return latin.length > 0 ? `${latin.map(quoteFtsToken).join(' AND ')} AND ${orGroup}` : orGroup
}

/** Convert natural language into literal FTS5 tokens, with bounded uppercase OR groups. */
export function literalFtsQuery(query: string): string {
  const groups = query.split(/\s+OR\s+/)
  if (groups.length > 1) {
    const encoded = groups.map(literalTokenQuery)
    if (encoded.every(Boolean)) return encoded.map((group) => `(${group})`).join(' OR ')
  }
  return literalTokenQuery(query)
}
