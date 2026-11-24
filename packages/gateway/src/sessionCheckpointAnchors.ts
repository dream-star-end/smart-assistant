/**
 * OCV5-885 Rolling Checkpoint Summary & Mid-Session Anchor Extraction (`gateway-session` L3).
 *
 * Pure deterministic TypeScript projection — zero network calls, zero `process.env`,
 * zero crypto primitives, and zero engine-name branching.
 */
import {
  estimateModelHistoryTokens,
  modelHistoryRoleLabel,
  modelHistorySemanticText,
  projectModelHistoryForReplay,
} from '@openclaude/protocol'

/** UTF-16 surrogate-safe head slice (local pure helper — avoids cross-module L3 import). */
function safeSliceHead(text: string, maxChars: number): string {
  if (maxChars <= 0) return ''
  if (text.length <= maxChars) return text
  let end = maxChars
  const code = text.charCodeAt(end - 1)
  if (code >= 0xd800 && code <= 0xdbff && end > 1) end -= 1
  return text.slice(0, end)
}

/** UTF-16 surrogate-safe tail slice (local pure helper — avoids cross-module L3 import). */
function safeSliceTail(text: string, maxChars: number): string {
  if (maxChars <= 0) return ''
  if (text.length <= maxChars) return text
  let start = text.length - maxChars
  const code = text.charCodeAt(start)
  if (code >= 0xdc00 && code <= 0xdfff && start + 1 < text.length) start += 1
  return text.slice(start)
}

const CHECKPOINT_MAX_CHARS = 8_000
export const CHECKPOINT_MID_ANCHORS_MAX_CHARS = 1_800
const CHECKPOINT_INITIAL_GOAL_MAX_CHARS = 750
const CHECKPOINT_PLAN_MAX_CHARS = 900
const CHECKPOINT_PRIOR_CONCLUSION_MAX_CHARS = 750
const CHECKPOINT_RECENT_ITEM_MAX_CHARS = 850

export type RollingCheckpointSummaryMode = 'legacy_head_tail' | 'anchored_v2'

export interface RollingCheckpointSummaryOptions {
  mode?: RollingCheckpointSummaryMode
}

export interface RollingCheckpointSummaryResult {
  summary: string
  beforeBytes: number
  afterBytes: number
  beforeTokens: number
  afterTokens: number
  droppedEntries: number
}

const CHECKPOINT_NEGATIVE_RE =
  /(?:不要|严禁|禁止|不得|切勿|不可|不许|切忌|绝不|决不|不准|不允许|别改|别动|别删|别碰|别去|别推|别发|别提|别跑|别写|勿动|勿改|勿删|勿推|只读|仅只读|只做只读|免改|不可跳过|不能修改|不能删除|不能推送|不能提交|不能发布|不能改|不要动|不要改|不要删|不要推|不要提|不要发)|\b(?:never|must\s+not|mustn['’]t|do\s+not|don['’]t|forbid(?:den)?|prohibit(?:ed)?|disallow(?:ed)?|read[- ]?only|strictly\s+forbid|under\s+no\s+circumstances|cannot\s+(?:modify|edit|touch|delete|push|change|run|write|publish|restart|skip|upload)|no\s+(?:writes?|edits?|modifications?|push|force[- ]?push|commit|deploy|deletions?|network|external\s+api))\b/i

const CHECKPOINT_DECISION_RE =
  /(?:改为|改成|换成|改用|确定|拍板|决定|采用|选用|否决|放弃|弃用|撤销|纠偏|纠正|更正|务必|必须|要求|限定|约束|阈值|上限|下限|端口|预算|里程碑|先做|只做|记住|统一|对齐|保持|遵守|回退到)|\b(?:decided?|decision|switch(?:ed)?\s+to|instead\s+of|reject(?:ed)?|drop(?:ped)?|abandon(?:ed)?|deprecated?|correction|actually|update:|constraint|requirement|must\s+|threshold|limit|cap|budget|port|scope|only\s+do|keep|preserve|agreed|freeze\s+window)\b/i

const CHECKPOINT_TICKET_RE = /\b(?:OCV5|INC|JIRA|PR|RFC|ADR|CASE|ISSUE)-\d{2,8}\b/gi
const CHECKPOINT_FULL_SHA_RE = /\b[0-9a-f]{40}\b/g
const CHECKPOINT_SHORT_SHA_RE = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,12}\b/g
const CHECKPOINT_ABS_PATH_RE =
  /(?:^|[\s`"'([:：=，,。；;])(\/(?:home|opt|var|etc|srv|usr|app|workspace|data|run|tmp)\/[A-Za-z0-9._/@+-]+)/g
const CHECKPOINT_REL_PATH_RE =
  /(?:^|[\s`"'([:：=，,。；;])((?:packages|scripts|evals|apps|src|lib|config|docs|migrations|services|infra|tests|arch|\.github)\/[A-Za-z0-9._/@+-]+|[A-Za-z0-9_-]+\/[A-Za-z0-9._/-]+\.(?:ts|tsx|js|mjs|cjs|json|md|py|sql|yml|yaml|sh|go|rs|toml|env|conf))\b/g
const CHECKPOINT_BRANCH_LABELED_RE =
  /(?:branch|分支|worktree|工作树)\s*[:=：]?\s*[`"'«]?([A-Za-z0-9._/-]{3,64})[`"'»]?/gi
const CHECKPOINT_BRANCH_PREFIX_RE =
  /\b((?:feat|fix|chore|release|hotfix|ocv5)\/[A-Za-z0-9._-]+|ocv5-\d{2,6}-[a-z0-9-]+)\b/gi
const CHECKPOINT_THRESHOLD_RE =
  /(?:\b(?:port|timeout|budget|limit|max_concurrency|concurrency|max|min|cap|threshold|p95|p99|sla|qps|rpm|ttl|quota|batch|ratio|window)\s*(?:[:=]|<=|>=|<|>|≤|≥)?\s*\d[\d,_.]*(?:\s*(?:ms|s|sec|min|h|d|kb|mb|gb|bytes?|chars?|tokens?|%|pp|usd|req\/s))?|(?:端口|超时|预算|上限|下限|阈值|并发|配额|窗口)\s*(?:[:=：]|<=|>=|<|>|≤|≥)?\s*\d[\d,_.]*(?:\s*(?:ms|s|秒|分钟|小时|天|kb|mb|gb|bytes?|字节|chars?|字符|tokens?|%|pp|元|美元))?|(?:<=|>=|≤|≥)\s*\d[\d,_.]*\s*(?:ms|s|kb|mb|gb|bytes?|chars?|tokens?|%|pp))/gi

const CHECKPOINT_FILE_EXT_BEFORE_DOT_RE =
  /\.(?:ts|tsx|js|mjs|cjs|json|md|py|sh|yml|yaml|sql|txt|log|env|go|rs|java|conf|toml)$/i

function normalizeClauseKey(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim()
}

function stripTrailingAnchorPunctuation(raw: string): string {
  return raw.replace(/[.,;:!?)'"`\]】》。，；：、]+$/g, '')
}

/**
 * Admit negative/redline polarity clauses as short as 3 chars (e.g. "不要发布。", "严禁push",
 * "只读模式") BEFORE applying the 6-char minimum length filter for ordinary clauses (Blocker #10).
 */
function shouldKeepCheckpointClause(cleaned: string): boolean {
  if (!cleaned) return false
  if (CHECKPOINT_NEGATIVE_RE.test(cleaned)) {
    return cleaned.length >= 3
  }
  return cleaned.length >= 6
}

function splitCheckpointClauses(text: string): string[] {
  const out: string[] = []
  const lines = text.split(/\r?\n+/)
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue
    // Split on CJK/strong punctuation while preserving delimiters on the clause.
    const rough = line.split(/(?<=[。！？；!?])/)
    for (const seg of rough) {
      const trimmedSeg = seg.trim()
      if (!trimmedSeg) continue
      // Further split long English multi-sentence runs on ". " when not after a file extension or digit.
      let start = 0
      for (let i = 0; i < trimmedSeg.length - 2; i += 1) {
        if (trimmedSeg[i] === '.' && trimmedSeg[i + 1] === ' ') {
          const nextCh = trimmedSeg[i + 2]!
          if (/[A-Z\u4e00-\u9fff]/.test(nextCh)) {
            const left = trimmedSeg.slice(start, i + 1)
            const lastToken = left.split(/\s+/).pop() ?? ''
            if (!CHECKPOINT_FILE_EXT_BEFORE_DOT_RE.test(lastToken) && !/\d\.$/.test(lastToken)) {
              const cleaned = left.replace(/^[-*•\d.)\s]+/, '').trim()
              if (shouldKeepCheckpointClause(cleaned)) out.push(cleaned)
              start = i + 2
            }
          }
        }
      }
      const tail = trimmedSeg.slice(start).replace(/^[-*•\d.)\s]+/, '').trim()
      if (shouldKeepCheckpointClause(tail)) out.push(tail)
    }
  }
  return out
}

function clipClausePreservingPolarity(clause: string, maxChars: number): string {
  const singleLine = clause.replace(/\s+/g, ' ').trim()
  if (singleLine.length <= maxChars) return singleLine
  const m = CHECKPOINT_NEGATIVE_RE.exec(singleLine)
  if (m && m.index > 32) {
    const start = Math.max(0, m.index - 28)
    const slice = safeSliceHead(singleLine.slice(start), maxChars - 2)
    return `…${slice}`
  }
  return `${safeSliceHead(singleLine, maxChars - 1)}…`
}

function extractTailConclusion(text: string, maxChars: number): string {
  const trimmed = text.trim()
  if (!trimmed) return ''
  const tail = safeSliceTail(trimmed, maxChars).trim()
  // Snap forward to the first clean line/sentence boundary if we sliced mid-sentence.
  const boundary = tail.search(/(?:^|\n|[。！？；!?]\s*)/)
  const cleaned =
    boundary > 0 && boundary < Math.floor(tail.length * 0.45)
      ? tail.slice(boundary).replace(/^[\n。！？；!?\s]+/, '').trim()
      : tail
  return (cleaned || tail).replace(/\s+/g, ' ').trim()
}

interface ExtractedFactualAnchors {
  tickets: string[]
  shas: string[]
  paths: string[]
  branches: string[]
  thresholds: string[]
}

function extractFactualAnchors(texts: readonly string[]): ExtractedFactualAnchors {
  const tickets: string[] = []
  const ticketSeen = new Set<string>()
  const shas: string[] = []
  const shaSeen = new Set<string>()
  const paths: string[] = []
  const pathSeen = new Set<string>()
  const branches: string[] = []
  const branchSeen = new Set<string>()
  const thresholds: string[] = []
  const thresholdSeen = new Set<string>()

  const pushUnique = (list: string[], seen: Set<string>, value: string, normalizeLower = false): void => {
    const v = value.trim()
    if (!v) return
    const key = normalizeLower ? v.toLowerCase() : v
    if (seen.has(key)) return
    seen.add(key)
    list.push(v)
  }

  for (const text of texts) {
    if (!text) continue
    for (const m of text.matchAll(CHECKPOINT_TICKET_RE)) {
      pushUnique(tickets, ticketSeen, m[0].toUpperCase(), true)
    }
    for (const m of text.matchAll(CHECKPOINT_FULL_SHA_RE)) {
      pushUnique(shas, shaSeen, m[0].toLowerCase(), true)
    }
    for (const m of text.matchAll(CHECKPOINT_SHORT_SHA_RE)) {
      const candidate = m[0].toLowerCase()
      const coveredByFull = shas.some((full) => full.length === 40 && full.startsWith(candidate))
      if (!coveredByFull) pushUnique(shas, shaSeen, candidate, true)
    }
    for (const m of text.matchAll(CHECKPOINT_ABS_PATH_RE)) {
      const p = stripTrailingAnchorPunctuation(m[1] ?? '')
      if (p.length >= 4) pushUnique(paths, pathSeen, p)
    }
    for (const m of text.matchAll(CHECKPOINT_REL_PATH_RE)) {
      const p = stripTrailingAnchorPunctuation(m[1] ?? '')
      if (p.length >= 5) pushUnique(paths, pathSeen, p)
    }
    for (const m of text.matchAll(CHECKPOINT_BRANCH_LABELED_RE)) {
      const b = stripTrailingAnchorPunctuation(m[1] ?? '')
      if (b.length >= 3 && !b.startsWith('/')) pushUnique(branches, branchSeen, b, true)
    }
    for (const m of text.matchAll(CHECKPOINT_BRANCH_PREFIX_RE)) {
      const b = stripTrailingAnchorPunctuation(m[1] ?? '')
      if (b.length >= 4) pushUnique(branches, branchSeen, b, true)
    }
    for (const m of text.matchAll(CHECKPOINT_THRESHOLD_RE)) {
      const t = m[0].replace(/\s+/g, ' ').trim()
      if (t.length >= 3) pushUnique(thresholds, thresholdSeen, t, true)
    }
  }

  return { tickets, shas, paths, branches, thresholds }
}

export function buildMidSessionAnchorsSection(input: {
  midRows: ReadonlyArray<{ role: string; text: string }>
  truncatedTails: ReadonlyArray<{ role: string; tail: string }>
  alreadyVisibleText: string
  maxChars: number
}): string {
  const { midRows, truncatedTails, alreadyVisibleText, maxChars } = input
  if (midRows.length === 0 && truncatedTails.length === 0) return ''

  const visibleLower = alreadyVisibleText.toLowerCase()
  const redlines: string[] = []
  const redlineSeen = new Set<string>()
  const decisions: string[] = []
  const decisionSeen = new Set<string>()

  const addRedline = (rawClause: string): void => {
    const clipped = clipClausePreservingPolarity(rawClause, 220)
    const key = normalizeClauseKey(clipped)
    if (!key || redlineSeen.has(key)) return
    redlineSeen.add(key)
    redlines.push(clipped)
  }

  const addDecision = (rawClause: string): void => {
    const clipped = clipClausePreservingPolarity(rawClause, 180)
    const key = normalizeClauseKey(clipped)
    if (!key || redlineSeen.has(key) || decisionSeen.has(key)) return
    decisionSeen.add(key)
    decisions.push(clipped)
  }

  // Pass 1: User-authored mid-session messages & truncated user tails (highest authority).
  const userSources: string[] = []
  for (const row of midRows) {
    if (row.role === 'user') userSources.push(row.text)
  }
  for (const item of truncatedTails) {
    if (item.role === 'user') userSources.push(item.tail)
  }

  for (const src of userSources) {
    const clauses = splitCheckpointClauses(src)
    let matchedInSource = false
    for (const clause of clauses) {
      if (CHECKPOINT_NEGATIVE_RE.test(clause)) {
        addRedline(clause)
        matchedInSource = true
      } else if (CHECKPOINT_DECISION_RE.test(clause)) {
        addDecision(clause)
        matchedInSource = true
      }
    }
    // Preserve tail conclusion for long user messages whose end wasn't captured above.
    if (src.length > 480 && !matchedInSource) {
      const tailNote = extractTailConclusion(src, 180)
      if (tailNote) addDecision(tailNote)
    }
  }

  // Pass 2: Plan/Goal/Assistant mid-session rows & truncated tails (redlines only, never raw tool dumps).
  for (const row of midRows) {
    if (row.role !== 'plan' && row.role !== 'goal' && row.role !== 'assistant') continue
    for (const clause of splitCheckpointClauses(row.text)) {
      if (CHECKPOINT_NEGATIVE_RE.test(clause)) addRedline(clause)
    }
  }
  for (const item of truncatedTails) {
    if (item.role !== 'plan' && item.role !== 'goal' && item.role !== 'assistant') continue
    for (const clause of splitCheckpointClauses(item.tail)) {
      if (CHECKPOINT_NEGATIVE_RE.test(clause)) addRedline(clause)
    }
  }

  // Pass 3: Deduplicated factual anchors from all uncovered mid-session rows & truncated tails.
  const anchorSources: string[] = [
    ...midRows.map((r) => r.text),
    ...truncatedTails.map((t) => t.tail),
  ]
  const anchors = extractFactualAnchors(anchorSources)

  const orderUncoveredFirst = (items: string[]): string[] => {
    const uncovered: string[] = []
    const covered: string[] = []
    for (const item of items) {
      if (visibleLower.includes(item.toLowerCase())) covered.push(item)
      else uncovered.push(item)
    }
    return [...uncovered, ...covered]
  }

  const orderedAnchors: Array<{ label: string; values: string[] }> = [
    { label: 'Tickets', values: orderUncoveredFirst(anchors.tickets) },
    { label: 'Commits', values: orderUncoveredFirst(anchors.shas) },
    { label: 'Paths', values: orderUncoveredFirst(anchors.paths) },
    { label: 'Branches/Worktrees', values: orderUncoveredFirst(anchors.branches) },
    { label: 'Thresholds', values: orderUncoveredFirst(anchors.thresholds) },
  ].filter((group) => group.values.length > 0)

  if (redlines.length === 0 && decisions.length === 0 && orderedAnchors.length === 0) {
    return ''
  }

  const header = '### Mid-Session Constraints & Key Anchors'
  const lines: string[] = [header]
  let used = header.length

  const tryPush = (line: string, limit: number): boolean => {
    if (used + 1 + line.length > limit) return false
    lines.push(line)
    used += 1 + line.length
    return true
  }

  // Reserve space for anchors so factual indices are never starved by verbose decisions.
  const anchorsReserve = orderedAnchors.length > 0 ? Math.min(520, Math.floor(maxChars * 0.34)) : 0
  const redlineBudget = maxChars - anchorsReserve

  if (redlines.length > 0) {
    tryPush('- **Hard Constraints / Redlines**:', redlineBudget)
    for (const r of redlines) {
      if (!tryPush(`  - ${r}`, redlineBudget)) break
    }
  }

  if (decisions.length > 0) {
    const decisionBudget = Math.min(redlineBudget, used + 520)
    if (used + 40 < decisionBudget) {
      tryPush('- **Mid-Session Decisions & Corrections**:', decisionBudget)
      for (const d of decisions) {
        if (!tryPush(`  - ${d}`, decisionBudget)) break
      }
    }
  }

  if (orderedAnchors.length > 0) {
    if (used + 32 < maxChars) {
      tryPush('- **Key Factual Anchors**:', maxChars)
      for (const group of orderedAnchors) {
        const prefix = `  - ${group.label}: `
        const available = maxChars - used - 1 - prefix.length
        if (available < 12) break
        const picked: string[] = []
        let len = 0
        for (const val of group.values) {
          const addLen = picked.length === 0 ? val.length : 2 + val.length
          if (len + addLen > available) break
          picked.push(val)
          len += addLen
        }
        if (picked.length > 0) {
          tryPush(`${prefix}${picked.join(', ')}`, maxChars)
        }
      }
    }
  }

  if (lines.length <= 1) return ''
  return lines.join('\n')
}

/** Legacy head+tail checkpoint summary builder preserved for A/B baseline comparisons. */
export function buildLegacyRollingCheckpointSummary(
  messages: readonly unknown[],
  instructions?: string,
): RollingCheckpointSummaryResult {
  return buildRollingCheckpointSummary(messages, instructions, { mode: 'legacy_head_tail' })
}

/** Build a bounded structured checkpoint summary (<=8K chars) from session history. */
export function buildRollingCheckpointSummary(
  messages: readonly unknown[],
  instructions?: string,
  options?: RollingCheckpointSummaryOptions,
): RollingCheckpointSummaryResult {
  const mode: RollingCheckpointSummaryMode = options?.mode ?? 'anchored_v2'
  const projected = projectModelHistoryForReplay(messages, { recentFullTurns: 2 })
  let beforeBytes = 0
  let beforeTokens = 0
  for (const row of projected) {
    const rawText = modelHistorySemanticText(row.raw) || row.text
    beforeBytes += Buffer.byteLength(rawText, 'utf8')
    beforeTokens += estimateModelHistoryTokens(rawText)
  }
  if (projected.length === 0) {
    return {
      summary: '',
      beforeBytes: 0,
      afterBytes: 0,
      beforeTokens: 0,
      afterTokens: 0,
      droppedEntries: 0,
    }
  }
  const userRows = projected.filter((r) => r.role === 'user')
  const assistantRows = projected.filter((r) => r.role === 'assistant')
  const goalOrPlanRows = projected.filter((r) => r.role === 'goal' || r.role === 'plan')
  const recentTail = projected.slice(-6)
  const keptSet = new Set<unknown>(recentTail.map((r) => r.raw))

  if (mode === 'legacy_head_tail') {
    const parts: string[] = [
      '## Rolling Context Checkpoint',
      ...(instructions?.trim() ? [`Focus: ${safeSliceHead(instructions.trim(), 240)}`] : []),
    ]
    if (userRows.length > 0) {
      keptSet.add(userRows[0]!.raw)
      parts.push('', '### Initial Goal / Request', safeSliceHead(userRows[0]!.text, 800))
    }
    if (goalOrPlanRows.length > 0) {
      const latestPlan = goalOrPlanRows[goalOrPlanRows.length - 1]!
      keptSet.add(latestPlan.raw)
      parts.push('', '### Latest Plan / Goal', safeSliceHead(latestPlan.text, 1_000))
    }
    if (assistantRows.length > 1) {
      const midAssistant = assistantRows[Math.max(0, assistantRows.length - 2)]!
      if (!keptSet.has(midAssistant.raw)) {
        keptSet.add(midAssistant.raw)
        parts.push('', '### Prior Key Conclusion', safeSliceHead(midAssistant.text, 1_000))
      }
    }
    parts.push('', '### Recent Exchanges')
    for (const item of recentTail) {
      parts.push(`- **${modelHistoryRoleLabel(item.role)}**: ${safeSliceHead(item.text, 900)}`)
    }

    let summary = parts.join('\n')
    if (summary.length > CHECKPOINT_MAX_CHARS) {
      summary = `${safeSliceHead(summary, CHECKPOINT_MAX_CHARS - 32)}\n… [checkpoint truncated]`
    }
    const afterBytes = Buffer.byteLength(summary, 'utf8')
    const afterTokens = estimateModelHistoryTokens(summary)
    const droppedEntries = Math.max(0, projected.length - keptSet.size)
    return { summary, beforeBytes, afterBytes, beforeTokens, afterTokens, droppedEntries }
  }

  // anchored_v2: preserve head/plan/tail AND extract bounded mid-session constraints,
  // polarity-intact negative redlines, decisions, and deduplicated factual anchors.
  const truncatedTails: Array<{ role: string; tail: string }> = []
  const prefixParts: string[] = [
    '## Rolling Context Checkpoint',
    ...(instructions?.trim() ? [`Focus: ${safeSliceHead(instructions.trim(), 240)}`] : []),
  ]
  if (userRows.length > 0) {
    const firstUser = userRows[0]!
    keptSet.add(firstUser.raw)
    const head = safeSliceHead(firstUser.text, CHECKPOINT_INITIAL_GOAL_MAX_CHARS)
    if (firstUser.text.length > head.length) {
      truncatedTails.push({ role: firstUser.role, tail: firstUser.text.slice(head.length) })
    }
    prefixParts.push('', '### Initial Goal / Request', head)
  }
  if (goalOrPlanRows.length > 0) {
    const latestPlan = goalOrPlanRows[goalOrPlanRows.length - 1]!
    keptSet.add(latestPlan.raw)
    const head = safeSliceHead(latestPlan.text, CHECKPOINT_PLAN_MAX_CHARS)
    if (latestPlan.text.length > head.length) {
      truncatedTails.push({ role: latestPlan.role, tail: latestPlan.text.slice(head.length) })
    }
    prefixParts.push('', '### Latest Plan / Goal', head)
  }
  if (assistantRows.length > 1) {
    const midAssistant = assistantRows[Math.max(0, assistantRows.length - 2)]!
    if (!keptSet.has(midAssistant.raw)) {
      keptSet.add(midAssistant.raw)
      const head = safeSliceHead(midAssistant.text, CHECKPOINT_PRIOR_CONCLUSION_MAX_CHARS)
      if (midAssistant.text.length > head.length) {
        truncatedTails.push({ role: midAssistant.role, tail: midAssistant.text.slice(head.length) })
      }
      prefixParts.push('', '### Prior Key Conclusion', head)
    }
  }

  // Pre-estimate per-item recent budget so truncated recent tails can also feed anchor/redline extraction.
  const prefixText = prefixParts.join('\n')
  const recentHeaderOverhead = '\n\n### Recent Exchanges\n'.length + recentTail.length * 24
  const estRemaining = Math.max(
    600,
    CHECKPOINT_MAX_CHARS - prefixText.length - CHECKPOINT_MID_ANCHORS_MAX_CHARS - recentHeaderOverhead - 64,
  )
  const recentItemCap = Math.min(
    CHECKPOINT_RECENT_ITEM_MAX_CHARS,
    Math.max(180, Math.floor(estRemaining / Math.max(1, recentTail.length))),
  )

  const recentRendered: string[] = []
  for (const item of recentTail) {
    const head = safeSliceHead(item.text, recentItemCap)
    if (item.text.length > head.length) {
      truncatedTails.push({ role: item.role, tail: item.text.slice(head.length) })
    }
    recentRendered.push(`- **${modelHistoryRoleLabel(item.role)}**: ${head}`)
  }

  const midRows = projected.filter((row) => !keptSet.has(row.raw))
  const midSection = buildMidSessionAnchorsSection({
    midRows,
    truncatedTails,
    alreadyVisibleText: `${prefixText}\n${recentRendered.join('\n')}`,
    maxChars: CHECKPOINT_MID_ANCHORS_MAX_CHARS,
  })

  const finalParts: string[] = [...prefixParts]
  if (midSection) {
    finalParts.push('', midSection)
  }
  finalParts.push('', '### Recent Exchanges', ...recentRendered)

  let summary = finalParts.join('\n')
  if (summary.length > CHECKPOINT_MAX_CHARS) {
    summary = `${safeSliceHead(summary, CHECKPOINT_MAX_CHARS - 32)}\n… [checkpoint truncated]`
  }
  const afterBytes = Buffer.byteLength(summary, 'utf8')
  const afterTokens = estimateModelHistoryTokens(summary)
  const droppedEntries = Math.max(0, projected.length - keptSet.size)
  return { summary, beforeBytes, afterBytes, beforeTokens, afterTokens, droppedEntries }
}
