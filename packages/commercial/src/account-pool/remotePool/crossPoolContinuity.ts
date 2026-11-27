/**
 * OCV5-902 P0-1 — Master-side deterministic 0-token cross-pool warm-resume builder.
 *
 * Builds a bounded `anchored_v2` rolling checkpoint summary from `_masterHistoricalMessages`
 * (or a lazy history loader) and persists it to PostgreSQL `session_rolling_checkpoints`
 * prior to cross-pool placement migration (`remote_pool <-> local_container`).
 *
 * Module: accounts (L3, allow: identity, catalog).
 * Hard invariants: zero `process.env`, zero network I/O, zero `node:crypto`,
 * zero engine/provider literal comparisons, zero billing SQL.
 */
import {
  collectModelHistoryMediaPathHints,
  modelHistoryRoleLabel,
  modelHistorySemanticRole,
  modelHistorySemanticText,
  type AuthoritativeRollingCheckpoint,
  type AuthorityEngineKind,
  type ModelHistorySemanticRole,
} from '@openclaude/protocol'
import type { PgSessionAuthorityStateStore } from '../../db/threeLayerStateStore.js'

export const CROSS_POOL_CHECKPOINT_MAX_CHARS = 8_000

const FIRST_GOAL_MAX_CHARS = 900
const LATEST_PLAN_MAX_CHARS = 900
const ANCHORS_SECTION_MAX_CHARS = 2_000
const RECENT_EXCHANGE_ITEM_MAX_CHARS = 900
const MEDIA_SECTION_MAX_CHARS = 800

const NEGATIVE_CONSTRAINT_RE =
  /(?:不要|严禁|禁止|不得|切勿|不可|不许|切忌|绝不|决不|不准|不允许|别改|别动|别删|别碰|别推|别发|别提|勿动|勿改|勿删|只读|不能修改|不能删除|不能推送|不能提交)|\b(?:never|must\s+not|mustn['’]t|do\s+not|don['’]t|forbid(?:den)?|prohibit(?:ed)?|disallow(?:ed)?|read[- ]?only|strictly\s+forbid|cannot\s+(?:modify|edit|touch|delete|push|change|write|publish)|no\s+(?:writes?|edits?|modifications?|push|commit|deploy|deletions?))\b/i

const DECISION_PLAN_RE =
  /(?:改为|改成|换成|改用|确定|拍板|决定|采用|选用|否决|放弃|弃用|撤销|纠偏|纠正|更正|务必|必须|要求|限定|约束|阈值|上限|下限|端口|预算|里程碑|计划|方案|路径|分支|回退到)|\b(?:decided?|decision|plan|switch(?:ed)?\s+to|instead\s+of|reject(?:ed)?|drop(?:ped)?|abandon(?:ed)?|deprecated?|correction|constraint|requirement|must\s+|threshold|limit|cap|budget|port|scope|keep|preserve|agreed)\b/i

const TICKET_RE = /\b(?:OCV5|INC|JIRA|PR|RFC|ADR|CASE|ISSUE)-\d{2,8}\b/gi
const FULL_SHA_RE = /\b[0-9a-f]{40}\b/g
const SHORT_SHA_RE = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,12}\b/g
const ABS_PATH_RE =
  /(?:^|[\s`"'([:：=，,。；;])(\/(?:home|opt|var|etc|srv|usr|app|workspace|data|run|tmp)\/[A-Za-z0-9._/@+-]+)/g
const REL_PATH_RE =
  /(?:^|[\s`"'([:：=，,。；;])((?:packages|scripts|evals|apps|src|lib|config|docs|migrations|services|infra|tests|arch|\.github)\/[A-Za-z0-9._/@+-]+|[A-Za-z0-9_-]+\/[A-Za-z0-9._/-]+\.(?:ts|tsx|js|mjs|cjs|json|md|py|sql|yml|yaml|sh|go|rs|toml|env|conf))\b/g

export interface BuildCrossPoolAnchoredSummaryOptions {
  readonly maxChars?: number
  readonly excludeClientMessageId?: string
}

export interface CrossPoolAnchoredSummary {
  readonly summary: string
  readonly anchorSeq: number
  readonly messageCount: number
}

export interface EnsureCrossPoolRollingCheckpointInput {
  readonly authorityStore: Pick<
    PgSessionAuthorityStateStore,
    'peekRollingCheckpoint' | 'saveRollingCheckpoint'
  >
  readonly uid: number
  readonly sessionKey: string
  readonly sessionId: string
  readonly sourcePlacementEpoch: number
  readonly sourceEngine: AuthorityEngineKind
  readonly rawHistory?: readonly unknown[]
  readonly loadHistory?: () => Promise<readonly unknown[] | null | undefined>
  readonly excludeClientMessageId?: string
  readonly maxChars?: number
  readonly instructions?: string | null
}

interface NormalizedHistoryItem {
  readonly raw: Record<string, unknown>
  readonly role: ModelHistorySemanticRole
  readonly text: string
  readonly toolSummary: string
  readonly seq: number
}

/** UTF-16 surrogate-safe head slice. */
function safeSliceHead(text: string, maxChars: number): string {
  if (maxChars <= 0) return ''
  if (text.length <= maxChars) return text
  let end = maxChars
  const code = text.charCodeAt(end - 1)
  if (code >= 0xd800 && code <= 0xdbff && end > 1) end -= 1
  return text.slice(0, end)
}

function messageClientId(rec: Record<string, unknown>): string | null {
  const candidates = [rec.clientMessageId, rec.client_message_id, rec.id]
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim().length > 0) return c.trim()
  }
  return null
}

function extractFallbackText(rec: Record<string, unknown>): string {
  const semantic = modelHistorySemanticText(rec)
  if (semantic.trim().length > 0) return semantic.trim()
  if (typeof rec.text === 'string' && rec.text.trim().length > 0) return rec.text.trim()
  if (typeof rec.content === 'string' && rec.content.trim().length > 0) return rec.content.trim()
  if (Array.isArray(rec.content)) {
    const parts: string[] = []
    for (const part of rec.content) {
      if (typeof part === 'string' && part.trim()) {
        parts.push(part.trim())
      } else if (part && typeof part === 'object') {
        const p = part as Record<string, unknown>
        if (typeof p.text === 'string' && p.text.trim()) parts.push(p.text.trim())
      }
    }
    if (parts.length > 0) return parts.join('\n')
  }
  return ''
}

function extractToolSummary(rec: Record<string, unknown>): string {
  const names: string[] = []
  const seen = new Set<string>()
  const pushName = (rawName: unknown, detail?: unknown) => {
    if (typeof rawName !== 'string') return
    const n = rawName.trim()
    if (!n) return
    const label =
      typeof detail === 'string' && detail.trim().length > 0
        ? `${n}(${safeSliceHead(detail.trim().replace(/\s+/g, ' '), 48)})`
        : n
    const key = label.toLowerCase()
    if (seen.has(key) || names.length >= 6) return
    seen.add(key)
    names.push(label)
  }

  const collectToolArray = (arr: unknown) => {
    if (!Array.isArray(arr)) return
    for (const item of arr) {
      if (!item || typeof item !== 'object') continue
      const t = item as Record<string, unknown>
      const fn = t.function && typeof t.function === 'object' ? (t.function as Record<string, unknown>) : null
      const name = t.name ?? t.toolName ?? t.tool_name ?? fn?.name
      const target =
        typeof t.path === 'string'
          ? t.path
          : typeof t.command === 'string'
            ? t.command
            : typeof t.status === 'string'
              ? t.status
              : undefined
      pushName(name, target)
    }
  }

  collectToolArray(rec.tool_calls)
  collectToolArray(rec.tools)
  if (Array.isArray(rec.blocks)) {
    for (const block of rec.blocks) {
      if (!block || typeof block !== 'object') continue
      const b = block as Record<string, unknown>
      if (b.kind === 'tool' || b.type === 'tool_use' || b.type === 'tool_call') {
        pushName(b.name ?? b.toolName ?? b.tool, b.status)
      }
    }
  }
  if (Array.isArray(rec.content)) {
    for (const block of rec.content) {
      if (!block || typeof block !== 'object') continue
      const b = block as Record<string, unknown>
      if (b.type === 'tool_use' || b.type === 'tool_call') {
        pushName(b.name ?? b.toolName, undefined)
      }
    }
  }

  return names.length > 0 ? `[tools: ${names.join(', ')}]` : ''
}

function extractItemSeq(rec: Record<string, unknown>, fallbackIndex: number): number {
  const candidates = [rec.seq, rec.turnIndex, rec.turn_index, rec.messageSeq, rec.index]
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isSafeInteger(c) && c >= 0) return c
  }
  return fallbackIndex
}

function extractDirectMediaPaths(rawMessages: readonly Record<string, unknown>[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const push = (val: unknown) => {
    if (typeof val !== 'string') return
    const v = val.trim()
    if (!v || seen.has(v)) return
    seen.add(v)
    out.push(v)
  }

  for (const hint of collectModelHistoryMediaPathHints([...rawMessages])) {
    push(hint)
  }
  for (const rec of rawMessages) {
    for (const field of ['media', 'attachments', 'files'] as const) {
      const arr = rec[field]
      if (!Array.isArray(arr)) continue
      for (const entry of arr) {
        if (typeof entry === 'string') {
          push(entry)
        } else if (entry && typeof entry === 'object') {
          const obj = entry as Record<string, unknown>
          push(obj.path)
          push(obj.filePath)
          push(obj.localPath)
          push(obj.url)
        }
      }
    }
  }
  return out
}

function splitClauses(text: string): string[] {
  const out: string[] = []
  for (const rawLine of text.split(/\r?\n+/)) {
    const line = rawLine.trim()
    if (!line) continue
    for (const seg of line.split(/(?<=[。！？；!?])/)) {
      const cleaned = seg.replace(/^[-*•\d.)\s]+/, '').trim()
      if (cleaned.length >= 3) out.push(cleaned)
    }
  }
  return out
}

function stripTrailingPunctuation(raw: string): string {
  return raw.replace(/[.,;:!?)'"`\]】》。，；：、]+$/g, '')
}

function buildAnchorsSection(
  items: readonly NormalizedHistoryItem[],
  maxChars: number,
): string {
  const redlines: string[] = []
  const redlineSeen = new Set<string>()
  const decisions: string[] = []
  const decisionSeen = new Set<string>()
  const tickets: string[] = []
  const ticketSeen = new Set<string>()
  const shas: string[] = []
  const shaSeen = new Set<string>()
  const paths: string[] = []
  const pathSeen = new Set<string>()

  const pushUnique = (list: string[], seen: Set<string>, raw: string, lowerKey = true) => {
    const v = raw.replace(/\s+/g, ' ').trim()
    if (!v) return
    const key = lowerKey ? v.toLowerCase() : v
    if (seen.has(key)) return
    seen.add(key)
    list.push(v)
  }

  for (const item of items) {
    const body = item.text
    if (!body) continue
    for (const clause of splitClauses(body)) {
      if (NEGATIVE_CONSTRAINT_RE.test(clause)) {
        pushUnique(redlines, redlineSeen, safeSliceHead(clause, 200))
      } else if (
        (item.role === 'user' || item.role === 'plan' || item.role === 'goal') &&
        clause.length >= 6 &&
        DECISION_PLAN_RE.test(clause)
      ) {
        const clipped = safeSliceHead(clause, 180)
        if (!redlineSeen.has(clipped.toLowerCase())) {
          pushUnique(decisions, decisionSeen, clipped)
        }
      }
    }
    for (const m of body.matchAll(TICKET_RE)) {
      pushUnique(tickets, ticketSeen, m[0].toUpperCase())
    }
    for (const m of body.matchAll(FULL_SHA_RE)) {
      pushUnique(shas, shaSeen, m[0].toLowerCase())
    }
    for (const m of body.matchAll(SHORT_SHA_RE)) {
      const candidate = m[0].toLowerCase()
      if (!shas.some((full) => full.length === 40 && full.startsWith(candidate))) {
        pushUnique(shas, shaSeen, candidate)
      }
    }
    for (const m of body.matchAll(ABS_PATH_RE)) {
      const p = stripTrailingPunctuation(m[1] ?? '')
      if (p.length >= 4) pushUnique(paths, pathSeen, p, false)
    }
    for (const m of body.matchAll(REL_PATH_RE)) {
      const p = stripTrailingPunctuation(m[1] ?? '')
      if (p.length >= 5) pushUnique(paths, pathSeen, p, false)
    }
  }

  if (
    redlines.length === 0 &&
    decisions.length === 0 &&
    tickets.length === 0 &&
    shas.length === 0 &&
    paths.length === 0
  ) {
    return ''
  }

  const header = '### Key Decisions, Constraints & Anchors'
  const lines: string[] = [header]
  let used = header.length
  const tryPush = (line: string, limit: number): boolean => {
    if (used + 1 + line.length > limit) return false
    lines.push(line)
    used += 1 + line.length
    return true
  }

  const factualReserve =
    tickets.length > 0 || shas.length > 0 || paths.length > 0
      ? Math.min(560, Math.floor(maxChars * 0.35))
      : 0
  const clauseLimit = maxChars - factualReserve

  if (redlines.length > 0) {
    tryPush('- **Hard Constraints / Redlines**:', clauseLimit)
    for (const r of redlines) {
      if (!tryPush(`  - ${r}`, clauseLimit)) break
    }
  }
  if (decisions.length > 0 && used + 48 < clauseLimit) {
    tryPush('- **Decisions & Plans**:', clauseLimit)
    for (const d of decisions) {
      if (!tryPush(`  - ${d}`, clauseLimit)) break
    }
  }
  const factualGroups: Array<{ label: string; values: string[] }> = [
    { label: 'Tickets', values: tickets },
    { label: 'Commits', values: shas },
    { label: 'Paths', values: paths },
  ].filter((g) => g.values.length > 0)

  if (factualGroups.length > 0 && used + 32 < maxChars) {
    tryPush('- **Factual Anchors**:', maxChars)
    for (const group of factualGroups) {
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
      if (picked.length > 0) tryPush(`${prefix}${picked.join(', ')}`, maxChars)
    }
  }

  return lines.length > 1 ? lines.join('\n') : ''
}

function selectRecentTurns(items: readonly NormalizedHistoryItem[]): NormalizedHistoryItem[] {
  // Keep the most recent 2 user turns and all subsequent assistant/plan/tool rows (up to 6 entries).
  let userTurns = 0
  let startIdx = Math.max(0, items.length - 6)
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (items[i]!.role === 'user') {
      userTurns += 1
      if (userTurns >= 2) {
        startIdx = i
        break
      }
    }
  }
  const sliced = items.slice(startIdx)
  return sliced.length > 6 ? sliced.slice(-6) : sliced
}

/**
 * Pure deterministic 0-token cross-pool warm-resume summary builder (`anchored_v2`).
 * Returns `null` when no valid historical messages remain after filtering (never fabricates
 * an empty checkpoint so callers honestly fall back to `cold_degraded`).
 */
export function buildCrossPoolAnchoredSummary(
  rawMessages: readonly unknown[],
  opts?: BuildCrossPoolAnchoredSummaryOptions,
): CrossPoolAnchoredSummary | null {
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) return null
  const excludeId =
    typeof opts?.excludeClientMessageId === 'string' && opts.excludeClientMessageId.trim().length > 0
      ? opts.excludeClientMessageId.trim()
      : null
  const maxChars = Math.max(
    256,
    Math.min(
      CROSS_POOL_CHECKPOINT_MAX_CHARS,
      typeof opts?.maxChars === 'number' && Number.isFinite(opts.maxChars)
        ? Math.floor(opts.maxChars)
        : CROSS_POOL_CHECKPOINT_MAX_CHARS,
    ),
  )

  const items: NormalizedHistoryItem[] = []
  let maxSeq = 0
  for (let i = 0; i < rawMessages.length; i += 1) {
    const raw = rawMessages[i]
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const rec = raw as Record<string, unknown>
    if (excludeId !== null && messageClientId(rec) === excludeId) continue
    const role = modelHistorySemanticRole(rec)
    if (!role) continue
    const text = extractFallbackText(rec)
    const toolSummary = extractToolSummary(rec)
    if (!text && !toolSummary) continue
    const seq = extractItemSeq(rec, items.length + 1)
    if (seq > maxSeq) maxSeq = seq
    items.push({ raw: rec, role, text, toolSummary, seq })
  }

  if (items.length === 0) return null

  const parts: string[] = ['## Cross-Pool Warm-Resume Checkpoint']
  const firstUser = items.find((m) => m.role === 'user')
  if (firstUser) {
    const firstBody = [firstUser.text, firstUser.toolSummary].filter(Boolean).join(' ')
    parts.push('', '### First-Turn Goal', safeSliceHead(firstBody, FIRST_GOAL_MAX_CHARS))
  }

  const planOrGoalRows = items.filter((m) => m.role === 'plan' || m.role === 'goal')
  if (planOrGoalRows.length > 0) {
    const latestPlan = planOrGoalRows[planOrGoalRows.length - 1]!
    parts.push('', '### Latest Plan / Goal', safeSliceHead(latestPlan.text, LATEST_PLAN_MAX_CHARS))
  }

  const anchorsSection = buildAnchorsSection(
    items,
    Math.min(ANCHORS_SECTION_MAX_CHARS, Math.floor(maxChars * 0.35)),
  )
  if (anchorsSection) {
    parts.push('', anchorsSection)
  }

  const mediaPaths = extractDirectMediaPaths(items.map((m) => m.raw))
  if (mediaPaths.length > 0) {
    const mediaLines: string[] = ['### Media & File References']
    let mediaLen = mediaLines[0]!.length
    for (const p of mediaPaths) {
      const line = `- ${safeSliceHead(p, 200)}`
      if (mediaLen + 1 + line.length > MEDIA_SECTION_MAX_CHARS) break
      mediaLines.push(line)
      mediaLen += 1 + line.length
    }
    if (mediaLines.length > 1) {
      parts.push('', mediaLines.join('\n'))
    }
  }

  const recentItems = selectRecentTurns(items)
  const prefixLen = parts.join('\n').length
  const recentBudget = Math.max(240, maxChars - prefixLen - 64)
  const perRecentCap = Math.min(
    RECENT_EXCHANGE_ITEM_MAX_CHARS,
    Math.max(120, Math.floor(recentBudget / Math.max(1, recentItems.length))),
  )
  parts.push('', '### Recent Exchanges & Tools')
  for (const item of recentItems) {
    const combined = [item.text, item.toolSummary].filter(Boolean).join(' ')
    parts.push(`- **${modelHistoryRoleLabel(item.role)}**: ${safeSliceHead(combined, perRecentCap)}`)
  }

  let summary = parts.join('\n')
  if (summary.length > maxChars) {
    const suffix = '\n… [checkpoint truncated]'
    summary = `${safeSliceHead(summary, Math.max(1, maxChars - suffix.length))}${suffix}`
  }

  return Object.freeze({
    summary,
    anchorSeq: Math.max(maxSeq, items.length),
    messageCount: items.length,
  })
}

/**
 * Ensures an unacked PG rolling checkpoint exists for `(uid, sessionKey, sourcePlacementEpoch)`.
 * Reuses an existing unacked checkpoint when present; otherwise builds a deterministic 0-token
 * `anchored_v2` summary from `rawHistory` (or `loadHistory()`) and writes it to PG.
 * Fail-open: returns `null` on empty history or any error so callers degrade honestly to `cold_degraded`.
 */
export async function ensureCrossPoolRollingCheckpoint(
  input: EnsureCrossPoolRollingCheckpointInput,
): Promise<AuthoritativeRollingCheckpoint | null> {
  try {
    const existing = await input.authorityStore.peekRollingCheckpoint(
      input.uid,
      input.sessionKey,
      input.sourcePlacementEpoch,
    )
    if (existing !== null) return existing

    const rawHistory =
      input.rawHistory !== undefined ? input.rawHistory : await input.loadHistory?.()
    if (!Array.isArray(rawHistory) || rawHistory.length === 0) return null

    const built = buildCrossPoolAnchoredSummary(rawHistory, {
      maxChars: input.maxChars,
      excludeClientMessageId: input.excludeClientMessageId,
    })
    if (built === null) return null

    const saved = await input.authorityStore.saveRollingCheckpoint({
      userId: input.uid,
      sessionKey: input.sessionKey,
      sessionId: input.sessionId,
      expectedPlacementEpoch: input.sourcePlacementEpoch,
      mode: 'anchored_v2',
      anchorSeq: built.anchorSeq,
      sourceEngine: input.sourceEngine,
      summary: built.summary,
      ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
    })

    return Object.freeze({
      sessionKey: input.sessionKey,
      sessionId: input.sessionId,
      checkpointGeneration: saved.checkpointGeneration,
      placementEpoch: input.sourcePlacementEpoch,
      mode: 'anchored_v2' as const,
      anchorSeq: built.anchorSeq,
      sourceEngine: input.sourceEngine,
      summary: built.summary,
      instructions: input.instructions ?? null,
      ackedByTurnKey: null,
      ackedAt: null,
      createdAt: new Date(
        Number.isFinite(saved.createdAtMs) ? saved.createdAtMs : Date.now(),
      ).toISOString(),
    })
  } catch {
    return null
  }
}
