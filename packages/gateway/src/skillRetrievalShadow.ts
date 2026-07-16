/**
 * Skill retrieval shadow rankers.
 *
 * All four routes are deterministic, side-effect-free, and operate only on the
 * metadata already visible to the current agent. In particular, this module
 * never calls the commercial embedding relay (or any other external model API).
 *
 * `existing_keyword_fallback` intentionally reuses the local fallback that powers
 * today's `skill_search`: the semantic branch of that tool calls DashScope and
 * is therefore outside the cost-free shadow budget.
 */
import { type SkillMetadata, cleanSkillQuery, searchSkillMetadata } from '@openclaude/storage'

export const SKILL_SHADOW_TOP_K = 5

export const SKILL_SHADOW_ROUTES = [
  'existing_keyword_fallback',
  'zh_lexical',
  'char_ngram',
  'bm25_multiquery',
] as const

export type SkillShadowRoute = (typeof SKILL_SHADOW_ROUTES)[number]

export interface SkillShadowRankedItem {
  name: string
  score: number
}

export type SkillShadowRankings = Record<SkillShadowRoute, SkillShadowRankedItem[]>

type ShadowSkill = Pick<SkillMetadata, 'name' | 'description' | 'tags' | 'related_skills'>

const CJK_RUN_RE = /\p{Script=Han}+/gu
const SEARCH_TOKEN_RE = /[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'can',
  'could',
  'for',
  'help',
  'i',
  'me',
  'my',
  'of',
  'please',
  'the',
  'to',
  'use',
  'want',
  'with',
  '一下',
  '一个',
  '一下子',
  '可以',
  '如何',
  '帮我',
  '怎么',
  '想要',
  '我们',
  '我要',
  '请帮',
  '这个',
])

const QUERY_EXPANSIONS: ReadonlyArray<readonly [RegExp, readonly string[]]> = [
  [/\b(?:xlsx|excel|spreadsheet)\b|表格|电子表格/iu, ['excel', 'spreadsheet', 'xlsx', '表格']],
  [/\b(?:docx|word)\b|文档|公文/iu, ['word', 'docx', 'document', '文档']],
  [/\b(?:pptx|powerpoint|slides?)\b|幻灯片|演示文稿/iu, ['powerpoint', 'pptx', 'slides', '演示']],
  [/\bpdf\b|便携文档/iu, ['pdf', 'document', '文档']],
  [
    /\b(?:code|coding|debug|test)\b|代码|编程|调试|测试/iu,
    ['code', 'coding', 'debug', '代码', '编程'],
  ],
  [
    /\b(?:paper|research|literature|citation)\b|论文|科研|文献|引用/iu,
    ['paper', 'research', 'literature', '论文', '文献'],
  ],
  [/\b(?:web|website|url)\b|网页|网站|链接/iu, ['web', 'website', 'url', '网页']],
]

let zhSegmenter: Intl.Segmenter | null | undefined

function getZhSegmenter(): Intl.Segmenter | null {
  if (zhSegmenter !== undefined) return zhSegmenter
  try {
    zhSegmenter = new Intl.Segmenter('zh', { granularity: 'word' })
  } catch {
    zhSegmenter = null
  }
  return zhSegmenter
}

function normalize(value: string): string {
  return (value ?? '').normalize('NFKC').toLocaleLowerCase().trim()
}

function compact(value: string): string {
  return normalize(value).replace(/[^\p{L}\p{N}]+/gu, '')
}

function unique<T>(values: Iterable<T>): T[] {
  return [...new Set(values)]
}

/**
 * Tokenize Chinese/English mixed text without a dependency. `Intl.Segmenter`
 * supplies word boundaries when available; Han bigrams make the result robust
 * to dictionary/segmentation differences (e.g. "电子表格" vs "表格").
 */
export function tokenizeZhAware(value: string): string[] {
  const text = normalize(value)
  if (!text) return []
  const out: string[] = []
  const segmenter = getZhSegmenter()
  if (segmenter) {
    for (const part of segmenter.segment(text)) {
      if (!part.isWordLike) continue
      const token = part.segment.replace(/[^\p{L}\p{N}-]+/gu, '')
      if (token) out.push(token)
      if (token.includes('-')) out.push(...token.split('-').filter(Boolean))
    }
  } else {
    out.push(...(text.match(SEARCH_TOKEN_RE) ?? []))
  }

  for (const match of text.matchAll(CJK_RUN_RE)) {
    const chars = Array.from(match[0])
    if (chars.length === 1) out.push(chars[0])
    for (let i = 0; i + 1 < chars.length; i++) out.push(chars.slice(i, i + 2).join(''))
  }
  return unique(out.filter(Boolean))
}

function rankAndLimit(
  scored: Iterable<SkillShadowRankedItem>,
  limit: number,
): SkillShadowRankedItem[] {
  return [...scored]
    .filter((item) => Number.isFinite(item.score) && item.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, Math.max(1, Math.floor(limit)))
}

/** Exact deterministic fallback used by the current `skill_search` tool. */
export function rankExistingKeywordFallback(
  skills: readonly SkillMetadata[],
  query: string,
  limit = SKILL_SHADOW_TOP_K,
): SkillShadowRankedItem[] {
  return searchSkillMetadata([...skills], query, limit).map((item) => ({
    name: item.name,
    score: item.score,
  }))
}

function tokenSet(value: string): Set<string> {
  return new Set(tokenizeZhAware(value))
}

function weightedTokenOverlap(query: Set<string>, field: Set<string>, weight: number): number {
  if (query.size === 0 || field.size === 0) return 0
  let overlap = 0
  for (const token of query) if (field.has(token)) overlap += 1
  if (overlap === 0) return 0
  const coverage = overlap / query.size
  const precision = overlap / field.size
  return weight * (0.75 * coverage + 0.25 * precision)
}

/** Chinese punctuation/word-boundary aware lexical ranker. */
export function rankZhLexical(
  skills: readonly ShadowSkill[],
  query: string,
  limit = SKILL_SHADOW_TOP_K,
): SkillShadowRankedItem[] {
  const cleaned = cleanSkillQuery(query)
  const q = tokenSet(cleaned)
  const cq = compact(cleaned)
  if (q.size === 0) return []

  return rankAndLimit(
    skills.map((skill) => {
      const name = normalize(skill.name)
      const tags = (skill.tags ?? []).join(' ')
      const related = (skill.related_skills ?? []).join(' ')
      let score = 0
      score += weightedTokenOverlap(q, tokenSet(name.replaceAll('-', ' ')), 12)
      score += weightedTokenOverlap(q, tokenSet(tags), 8)
      score += weightedTokenOverlap(q, tokenSet(related), 5)
      score += weightedTokenOverlap(q, tokenSet(skill.description), 4)
      if (cq && (compact(name) === cq || cq.includes(compact(name)))) score += 30
      return { name: skill.name, score }
    }),
    limit,
  )
}

function charNgrams(value: string): Set<string> {
  const chars = Array.from(compact(value))
  const grams = new Set<string>()
  for (const n of [2, 3]) {
    if (chars.length < n) continue
    for (let i = 0; i + n <= chars.length; i++) grams.add(chars.slice(i, i + n).join(''))
  }
  if (grams.size === 0 && chars.length > 0) grams.add(chars.join(''))
  return grams
}

function ngramSimilarity(query: Set<string>, value: string): number {
  const target = charNgrams(value)
  if (query.size === 0 || target.size === 0) return 0
  let overlap = 0
  for (const gram of query) if (target.has(gram)) overlap += 1
  if (overlap === 0) return 0
  const queryRecall = overlap / query.size
  const dice = (2 * overlap) / (query.size + target.size)
  return 0.7 * queryRecall + 0.3 * dice
}

/** Character 2/3-gram similarity for punctuation and mixed-language robustness. */
export function rankCharNgram(
  skills: readonly ShadowSkill[],
  query: string,
  limit = SKILL_SHADOW_TOP_K,
): SkillShadowRankedItem[] {
  const cleaned = cleanSkillQuery(query)
  const q = charNgrams(cleaned)
  if (q.size === 0) return []
  return rankAndLimit(
    skills.map((skill) => {
      const name = skill.name.replaceAll('-', ' ')
      const tagScore = Math.max(0, ...(skill.tags ?? []).map((tag) => ngramSimilarity(q, tag)))
      const relatedScore = Math.max(
        0,
        ...(skill.related_skills ?? []).map((related) => ngramSimilarity(q, related)),
      )
      let score =
        12 * ngramSimilarity(q, name) +
        7 * tagScore +
        4 * relatedScore +
        5 * ngramSimilarity(q, skill.description)
      const cq = compact(cleaned)
      const cn = compact(skill.name)
      if (cq && cn && (cq === cn || cq.includes(cn))) score += 30
      return { name: skill.name, score }
    }),
    limit,
  )
}

/** Deterministic 2-3 query rewrite; no LLM/model call. */
export function deriveSkillQueries(query: string): string[] {
  const cleaned = cleanSkillQuery(query)
  if (!cleaned) return []
  const queries = [cleaned]
  const salient = tokenizeZhAware(cleaned).filter((token) => !STOP_WORDS.has(token))
  const condensed = unique(salient).slice(0, 16).join(' ')
  if (condensed && condensed !== normalize(cleaned)) queries.push(condensed)

  const expanded: string[] = []
  for (const [pattern, additions] of QUERY_EXPANSIONS) {
    if (pattern.test(cleaned)) expanded.push(...additions)
  }
  const rewrite = unique([...salient.slice(0, 10), ...expanded]).join(' ')
  if (rewrite && !queries.includes(rewrite)) queries.push(rewrite)
  return queries.slice(0, 3)
}

function bm25DocumentTokens(skill: ShadowSkill): string[] {
  const name = tokenizeZhAware(skill.name.replaceAll('-', ' '))
  const tags = tokenizeZhAware((skill.tags ?? []).join(' '))
  const related = tokenizeZhAware((skill.related_skills ?? []).join(' '))
  const description = tokenizeZhAware(skill.description)
  return [...name, ...name, ...name, ...tags, ...tags, ...related, ...related, ...description]
}

function countTokens(tokens: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1)
  return counts
}

/** BM25 over metadata, fused across deterministic query rewrites. */
export function rankBm25MultiQuery(
  skills: readonly ShadowSkill[],
  query: string,
  limit = SKILL_SHADOW_TOP_K,
): SkillShadowRankedItem[] {
  const rewrites = deriveSkillQueries(query)
  if (rewrites.length === 0 || skills.length === 0) return []

  const docs = skills.map((skill) => bm25DocumentTokens(skill))
  const docCounts = docs.map(countTokens)
  const avgLength = docs.reduce((sum, doc) => sum + doc.length, 0) / docs.length || 1
  const documentFrequency = new Map<string, number>()
  for (const counts of docCounts) {
    for (const token of counts.keys()) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1)
    }
  }

  const k1 = 1.2
  const b = 0.75
  const scores = new Array<number>(skills.length).fill(0)
  rewrites.forEach((rewrite, rewriteIndex) => {
    const queryTokens = unique(tokenizeZhAware(rewrite).filter((token) => !STOP_WORDS.has(token)))
    const rewriteWeight = rewriteIndex === 0 ? 1 : rewriteIndex === 1 ? 0.85 : 0.7
    queryTokens.forEach((token) => {
      const df = documentFrequency.get(token) ?? 0
      if (df === 0) return
      const idf = Math.log(1 + (skills.length - df + 0.5) / (df + 0.5))
      docCounts.forEach((counts, docIndex) => {
        const tf = counts.get(token) ?? 0
        if (tf === 0) return
        const norm = tf + k1 * (1 - b + b * (docs[docIndex].length / avgLength))
        scores[docIndex] += rewriteWeight * idf * ((tf * (k1 + 1)) / norm)
      })
    })
  })

  return rankAndLimit(
    skills.map((skill, index) => ({ name: skill.name, score: scores[index] })),
    limit,
  )
}

export function runSkillShadowRankers(
  skills: readonly SkillMetadata[],
  query: string,
  limit = SKILL_SHADOW_TOP_K,
): SkillShadowRankings {
  return {
    existing_keyword_fallback: rankExistingKeywordFallback(skills, query, limit),
    zh_lexical: rankZhLexical(skills, query, limit),
    char_ngram: rankCharNgram(skills, query, limit),
    bm25_multiquery: rankBm25MultiQuery(skills, query, limit),
  }
}

/**
 * Async fan-out used by the live shadow observer. Each route stays independently
 * replaceable/testable; Promise.all also prevents a future async local route from
 * accidentally serializing the four-way experiment.
 */
export async function runSkillShadowRankersParallel(
  skills: readonly SkillMetadata[],
  query: string,
  limit = SKILL_SHADOW_TOP_K,
): Promise<SkillShadowRankings> {
  const [existing, lexical, ngram, bm25] = await Promise.all([
    Promise.resolve().then(() => rankExistingKeywordFallback(skills, query, limit)),
    Promise.resolve().then(() => rankZhLexical(skills, query, limit)),
    Promise.resolve().then(() => rankCharNgram(skills, query, limit)),
    Promise.resolve().then(() => rankBm25MultiQuery(skills, query, limit)),
  ])
  return {
    existing_keyword_fallback: existing,
    zh_lexical: lexical,
    char_ngram: ngram,
    bm25_multiquery: bm25,
  }
}

/** Keep only ranked names for the privacy-minimal wire/storage payload. */
export function compactSkillShadowRankings(
  rankings: SkillShadowRankings,
): Record<SkillShadowRoute, string[]> {
  return Object.fromEntries(
    SKILL_SHADOW_ROUTES.map((route) => [
      route,
      rankings[route].slice(0, SKILL_SHADOW_TOP_K).map((item) => item.name),
    ]),
  ) as Record<SkillShadowRoute, string[]>
}

export interface SkillShadowRecall {
  actualCount: number
  hitsAt3: number
  hitsAt5: number
  recallAt3: number
  recallAt5: number
}

/** Shared set-recall@3/@5 definition for offline eval reuse; live SQL mirrors it. */
export function scoreSkillShadowRecall(
  rankings: SkillShadowRankings,
  actualSkills: readonly string[],
): Record<SkillShadowRoute, SkillShadowRecall> {
  const actual = new Set(actualSkills)
  return Object.fromEntries(
    SKILL_SHADOW_ROUTES.map((route) => {
      const names = rankings[route].map((item) => item.name)
      const hitsAt = (limit: number): number => {
        const retrieved = new Set(names.slice(0, limit))
        let hits = 0
        for (const name of actual) if (retrieved.has(name)) hits += 1
        return hits
      }
      const hitsAt3 = hitsAt(3)
      const hitsAt5 = hitsAt(5)
      const actualCount = actual.size
      return [
        route,
        {
          actualCount,
          hitsAt3,
          hitsAt5,
          recallAt3: actualCount === 0 ? 0 : hitsAt3 / actualCount,
          recallAt5: actualCount === 0 ? 0 : hitsAt5 / actualCount,
        },
      ]
    }),
  ) as Record<SkillShadowRoute, SkillShadowRecall>
}
