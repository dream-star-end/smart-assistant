/**
 * oc-review — 多模型评审的确定性汇总(R7 期 A,任务单 TEST-17)。
 *
 * 用户把同一份稿件并行交给 N 个评审员(模型×角色,经 `oc-memory delegate --model`
 * 或 MCP delegate_tasks 分发),各自产出结构化评审 JSON;本 CLI 负责确定性汇总
 * ——不让 LLM 心算合并,否则汇总本身就是单点幻觉:
 *
 *   oc-review schema                          打印评审员必须遵守的 JSON schema(贴进委派 prompt)
 *   oc-review collate --dir <dir> [--out md]  读 <dir>/reviews-*.json → 共识/分歧/单发三分区
 *
 * collate 产出:review-summary.md(汇总卡)+ review-summary.json(结构化,逐条保留
 * 来源模型);stdout 输出 JSON,末行单独打印 `COLLATE: <blocker>/<major>/<minor>/<suggestion>`
 * 供程序判读(照 oc-figcheck 的 VERDICT 模式)。
 *
 * 容错:某位评审员 429/超时/输出非 JSON 时,默认**跳过该文件并标注缺席**(汇总卡顶部
 * 缺席块 + JSON.skipped + COLLATE 行 ` skipped=<n>`),不让一位评审员的故障作废其余
 * 评审;全部无效才 exit 1。`--strict` 恢复任一坏文件即 exit 1。
 *
 * 聚合策略(R7 设计 §4.2):location 归一(章节/图/表/行号锚点)+ severity 档匹配的
 * 粗聚合;宁可漏聚(分别列出)不误聚(把不同问题合并)——分歧呈现是本功能的价值核心。
 * 无网络、无 DB;schema 为 CLI 本地定义,不进 protocol 包。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_BATCH_TIMEOUT_MS,
  DEFAULT_VERIFY_TIMEOUT_MS,
  VERIFICATION_STATUSES,
  VerificationFormatError,
  computeDefectIdentityKey,
  computeFindingDigest,
  computeSafeFileSha256,
  computeSafeScriptSha256,
  computeScientificMetrics,
  formatScientificGateMessage,
  formatVerifySummaryLine,
  isMachineVerificationStatus,
  normalizeDefectIssue,
  normalizeDefectText,
  parseVerificationReport,
  resolveModelFamily,
  verifyWitnessesInDir,
  type ExcludedScientificReviewer,
  type MachineVerificationStatus,
  type ScientificGateStatus,
  type ScientificMetrics,
  type ScientificMetricsActiveFinding,
  type VerificationEntry,
  type VerificationReport,
} from './ocReviewVerify.js'

export type {
  ExcludedScientificReviewer,
  MachineVerificationStatus,
  ScientificGateStatus,
  ScientificMetrics,
  VerificationEntry,
  VerificationReport,
}

const TOOL = 'oc-review'

export const SEVERITIES = ['blocker', 'major', 'minor', 'suggestion'] as const
export type ReviewSeverity = (typeof SEVERITIES)[number]

export const VERDICTS = ['accept', 'minor', 'major', 'reject'] as const
export type ReviewVerdict = (typeof VERDICTS)[number]

export const PRIORITIES = ['P0', 'P1', 'P2'] as const
export type ReviewPriority = (typeof PRIORITIES)[number]

export const CATEGORIES = [
  'math_physics',
  'code_data_mismatch',
  'citation',
  'consistency',
  'structure',
  'style',
  'other',
] as const
export type ReviewCategory = (typeof CATEGORIES)[number]

const P0_MAJOR_CATEGORIES: ReadonlySet<ReviewCategory> = new Set([
  'math_physics',
  'code_data_mismatch',
  'citation',
  'consistency',
])

export type ReviewFinding = {
  location: string
  severity: ReviewSeverity
  issue: string
  suggestion?: string
  priority?: ReviewPriority
  category?: ReviewCategory
  new_evidence?: boolean
  evidence?: string
  topic?: string
  model_family?: string
  repro_script?: string
  verified_by_machine?: MachineVerificationStatus
  verification_output?: string
}

export type ReviewFile = {
  reviewer: { model: string; role?: string; model_family?: string }
  verdict: ReviewVerdict
  findings: ReviewFinding[]
}

export const LEDGER_DECISIONS = ['accepted', 'rejected_with_evidence', 'deferred'] as const
export type LedgerDecision = (typeof LEDGER_DECISIONS)[number]

export type LedgerEntry = {
  id: string
  anchor: string
  topic: string
  decision: LedgerDecision
  reason: string
  evidence?: string
  round: number
  updatedAt?: string
}

export type DecisionLedger = {
  schemaVersion: 1
  entries: LedgerEntry[]
}

/** 坏评审文件:fatal(带文件名与字段路径),绝不静默跳过。 */
export class ReviewFormatError extends Error {}

/** `oc-review schema` 输出的评审员契约(委派 goal 里原样贴入)。 */
export const REVIEW_JSON_SCHEMA = `{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "ReviewFile",
  "type": "object",
  "required": ["reviewer", "verdict", "findings"],
  "properties": {
    "reviewer": {
      "type": "object",
      "required": ["model"],
      "properties": {
        "model": { "type": "string", "minLength": 1, "description": "评审员模型 slug,四大家族强档如 gpt-6.2-astra / antigravity-gemini-4-neon / grok-build / deepseek-v4-flash" },
        "role": { "type": "string", "description": "评审员角色,如 方法学审查" },
        "model_family": { "type": "string", "description": "展示用模型家族标注(可选;科学深审独立家族严格按权威 reviewer.model 归类,自填标签不提升覆盖率)" }
      }
    },
    "verdict": { "enum": ["accept", "minor", "major", "reject"] },
    "findings": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["location", "severity", "issue"],
        "properties": {
          "location": { "type": "string", "description": "稿件位置,如 §3.2 / 图4 / L120" },
          "severity": { "enum": ["blocker", "major", "minor", "suggestion"] },
          "priority": {
            "enum": ["P0", "P1", "P2"],
            "description": "硬分级(可选):P0=阻断级硬伤(数学/物理推导错误、代码与数据不一致、引文错误、前后硬矛盾);P1=重要论证/结构完善;P2=措辞/风格偏好(不阻断收敛放行)"
          },
          "category": {
            "enum": ["math_physics", "code_data_mismatch", "citation", "consistency", "structure", "style", "other"],
            "description": "问题类别(可选):未显式填 priority 时,major 且属于 math_physics/code_data_mismatch/citation/consistency 自动推导为 P0"
          },
          "topic": { "type": "string", "description": "问题主题/关键词(可选,供跨轮裁决账本去重与防 Flip-Flop 匹配)" },
          "issue": { "type": "string", "minLength": 1 },
          "suggestion": { "type": "string" },
          "evidence": { "type": "string", "description": "定位依据或可复核反证(可选)" },
          "new_evidence": { "type": "boolean", "description": "是否基于全新反证重开账本中已裁决条目(可选,默认 false)" },
          "model_family": { "type": "string", "description": "展示用模型家族标注(可选;科学深审独立家族仅按每份评审文件的 reviewer 字段计 1 票)" },
          "repro_script": { "type": "string", "description": "最小反例复现脚本相对路径(可选,仅允许 .py/.m;须 exit 0 并经 OC_WITNESS_VERDICT_FILE 或 stdout OC_WITNESS_VERDICT JSON 输出含匹配 finding_digest 的 confirmed/refuted)" },
          "verified_by_machine": { "enum": ["confirmed", "refuted", "unverified"], "description": "展示参考字段(可选;绝不能自报降级 P0,权威状态仅来自绑定 findingDigest+scriptSha256 的 --verification 报告)" },
          "verification_output": { "type": "string", "description": "机器反例核验输出摘要(可选)" }
        }
      }
    }
  }
}`

function isSeverity(v: unknown): v is ReviewSeverity {
  return typeof v === 'string' && (SEVERITIES as readonly string[]).includes(v)
}

function isVerdict(v: unknown): v is ReviewVerdict {
  return typeof v === 'string' && (VERDICTS as readonly string[]).includes(v)
}

function isPriority(v: unknown): v is ReviewPriority {
  return typeof v === 'string' && (PRIORITIES as readonly string[]).includes(v)
}

function isCategory(v: unknown): v is ReviewCategory {
  return typeof v === 'string' && (CATEGORIES as readonly string[]).includes(v)
}

function isLedgerDecision(v: unknown): v is LedgerDecision {
  return typeof v === 'string' && (LEDGER_DECISIONS as readonly string[]).includes(v)
}

/**
 * 确定性推导 finding 的硬分级(P0/P1/P2):
 *   1. 若显式填了合法 priority(P0/P1/P2),直接使用;
 *   2. 否则:blocker → P0;major 且 category ∈ {math_physics, code_data_mismatch, citation, consistency} → P0;
 *      其余 major → P1;minor / suggestion → P2。
 */
export function resolveFindingPriority(
  f: Pick<ReviewFinding, 'severity' | 'priority' | 'category'>,
): ReviewPriority {
  if (isPriority(f.priority)) return f.priority
  if (f.severity === 'blocker') return 'P0'
  if (f.severity === 'major') {
    if (f.category !== undefined && P0_MAJOR_CATEGORIES.has(f.category)) return 'P0'
    return 'P1'
  }
  return 'P2'
}

/** 严格校验单份评审 JSON;任何缺字段/坏枚举/坏 JSON 都抛 ReviewFormatError(fail-loud)。 */
export function parseReviewFile(text: string, label: string): ReviewFile {
  // 必须是函数声明(或显式类型标注的标识符):TS 只对这类 never 返回调用做控制流收窄,
  // 否则下方 obj.findings / rec.model 在 bad() 之后仍是 unknown(tsc -b 报 TS18046)。
  function bad(msg: string): never {
    throw new ReviewFormatError(`${label}: ${msg}`)
  }
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    bad('invalid JSON')
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    bad('top-level must be an object')
  }
  const obj = data as Record<string, unknown>
  const reviewer = obj.reviewer
  if (typeof reviewer !== 'object' || reviewer === null || Array.isArray(reviewer)) {
    bad('reviewer must be an object {model, role?}')
  }
  const rec = reviewer as Record<string, unknown>
  if (typeof rec.model !== 'string' || rec.model.trim() === '') {
    bad('reviewer.model must be a non-empty string')
  }
  if (rec.role !== undefined && typeof rec.role !== 'string') {
    bad('reviewer.role must be a string when present')
  }
  if (rec.model_family !== undefined && typeof rec.model_family !== 'string') {
    bad('reviewer.model_family must be a string when present')
  }
  if (!isVerdict(obj.verdict)) {
    bad(`verdict must be one of ${VERDICTS.join('|')}`)
  }
  if (!Array.isArray(obj.findings)) {
    bad('findings must be an array')
  }
  const findings: ReviewFinding[] = obj.findings.map((raw, i) => {
    const where = `findings[${i}]`
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      bad(`${where} must be an object`)
    }
    const f = raw as Record<string, unknown>
    if (typeof f.location !== 'string' || f.location.trim() === '') {
      bad(`${where}.location must be a non-empty string`)
    }
    if (!isSeverity(f.severity)) {
      bad(`${where}.severity must be one of ${SEVERITIES.join('|')}`)
    }
    if (typeof f.issue !== 'string' || f.issue.trim() === '') {
      bad(`${where}.issue must be a non-empty string`)
    }
    if (f.suggestion !== undefined && typeof f.suggestion !== 'string') {
      bad(`${where}.suggestion must be a string when present`)
    }
    if (f.priority !== undefined && !isPriority(f.priority)) {
      bad(`${where}.priority must be one of ${PRIORITIES.join('|')}`)
    }
    if (f.category !== undefined && !isCategory(f.category)) {
      bad(`${where}.category must be one of ${CATEGORIES.join('|')}`)
    }
    if (f.new_evidence !== undefined && typeof f.new_evidence !== 'boolean') {
      bad(`${where}.new_evidence must be a boolean when present`)
    }
    if (f.evidence !== undefined && typeof f.evidence !== 'string') {
      bad(`${where}.evidence must be a string when present`)
    }
    if (f.topic !== undefined && typeof f.topic !== 'string') {
      bad(`${where}.topic must be a string when present`)
    }
    if (f.model_family !== undefined && typeof f.model_family !== 'string') {
      bad(`${where}.model_family must be a string when present`)
    }
    if (f.repro_script !== undefined && typeof f.repro_script !== 'string') {
      bad(`${where}.repro_script must be a string when present`)
    }
    if (f.verified_by_machine !== undefined && !isMachineVerificationStatus(f.verified_by_machine)) {
      bad(`${where}.verified_by_machine must be one of ${VERIFICATION_STATUSES.join('|')}`)
    }
    if (f.verification_output !== undefined && typeof f.verification_output !== 'string') {
      bad(`${where}.verification_output must be a string when present`)
    }
    const finding: ReviewFinding = { location: f.location, severity: f.severity, issue: f.issue }
    if (f.suggestion !== undefined) finding.suggestion = f.suggestion
    if (f.priority !== undefined) finding.priority = f.priority
    if (f.category !== undefined) finding.category = f.category
    if (f.new_evidence !== undefined) finding.new_evidence = f.new_evidence
    if (f.evidence !== undefined) finding.evidence = f.evidence
    if (f.topic !== undefined) finding.topic = f.topic
    if (f.model_family !== undefined) finding.model_family = f.model_family
    if (f.repro_script !== undefined) finding.repro_script = f.repro_script
    if (f.verified_by_machine !== undefined) finding.verified_by_machine = f.verified_by_machine
    if (f.verification_output !== undefined) finding.verification_output = f.verification_output
    return finding
  })
  const file: ReviewFile = { reviewer: { model: rec.model.trim() }, verdict: obj.verdict, findings }
  if (rec.role !== undefined) file.reviewer.role = rec.role
  if (rec.model_family !== undefined) file.reviewer.model_family = rec.model_family
  return file
}

/**
 * location → 归一锚点列表(确定性,不引入语义匹配):
 *   §3.2 / section 3.2 / Sec. 3.2 / 章节3   → sec:3.2
 *   图4 / Figure 4 / fig.4                  → fig:4
 *   表2 / Table 2 / tab.2                   → tab:2
 *   L120 / line 120 / 行120 / L120-130      → line:120 / line:120-130
 * 无可识别锚点 → raw:<小写原串>(精确匹配才聚合,宁可漏聚不误聚)。
 */
export function locationAnchors(location: string): string[] {
  const s = location.trim()
  if (!s) return []
  const anchors: string[] = []
  const push = (a: string) => {
    if (!anchors.includes(a)) anchors.push(a)
  }
  const num = String.raw`\d+(?:\.\d+)*`
  const patterns: [RegExp, string][] = [
    [new RegExp(String.raw`(?:^|[^a-z0-9])(?:§|sec(?:tion)?\.?|章节?)\s*(${num})`, 'gi'), 'sec'],
    [new RegExp(String.raw`(?:^|[^a-z0-9])(?:fig(?:ure)?\.?|图)\s*(${num})`, 'gi'), 'fig'],
    [new RegExp(String.raw`(?:^|[^a-z0-9])(?:tab(?:le)?\.?|表)\s*(${num})`, 'gi'), 'tab'],
    [
      new RegExp(
        String.raw`(?:^|[^a-z0-9\u4e00-\u9fff])(?:l(?:ines?)?\.?|行)\s*(\d+(?:\s*[-–—~]\s*\d+)?)`,
        'gi',
      ),
      'line',
    ],
  ]
  for (const [re, prefix] of patterns) {
    for (const m of s.matchAll(re)) {
      push(`${prefix}:${m[1].replace(/\s*[-–—~]\s*/g, '-')}`)
    }
  }
  if (anchors.length === 0) push(`raw:${s.toLowerCase().replace(/\s+/g, ' ')}`)
  return anchors
}

export type TaggedFinding = ReviewFinding & {
  reviewer: string
  resolvedPriority: ReviewPriority
  reopenedWithNewEvidence?: boolean
  matchedLedgerId?: string
  /** 仅来自加密绑定 `--verification` 报告的权威机器核验状态(绝不采信作者自填字段)。 */
  authoritativeVerification?: MachineVerificationStatus
}

export type SuppressedFlipFlop = {
  reviewer: string
  finding: ReviewFinding
  priority: ReviewPriority
  ledgerEntry: {
    id: string
    anchor: string
    topic: string
    decision: LedgerDecision
    reason: string
    evidence?: string
    round: number
  }
}

export type MachineRefutedFinding = {
  reviewer: string
  modelFamily: string
  finding: ReviewFinding
  priority: ReviewPriority
  reproScript?: string
  verificationOutput?: string
}

export type PriorityCounts = Record<ReviewPriority, number>

export type ConvergenceGate = {
  status: ScientificGateStatus
  activeP0: number
  suppressedFlipFlops: number
  round?: number
  message: string
}

export type ConsensusEntry = {
  kind: 'consensus'
  anchor: string
  severity: ReviewSeverity
  sources: string[]
  findings: TaggedFinding[]
}

export type DivergentSide = { severity: ReviewSeverity; sources: string[]; findings: TaggedFinding[] }

export type DivergentEntry = {
  kind: 'divergent'
  anchor: string
  sides: DivergentSide[]
  /** 来源最多的一档;并列取更严重档(确定性)。仅提示,不裁分歧。 */
  majority: ReviewSeverity
}

export type SoleEntry = {
  kind: 'sole'
  anchor: string
  source: string
  findings: TaggedFinding[]
}

export type ReviewerSummary = {
  model: string
  role?: string
  verdict: ReviewVerdict
  counts: Record<ReviewSeverity, number>
}

/** 被跳过的评审文件(坏 JSON/坏 schema/不可读):汇总照常出,但缺席必须可见。 */
export type SkippedReview = { file: string; reason: string }

export type CollateResult = {
  reviewers: ReviewerSummary[]
  verdictCounts: Record<ReviewVerdict, number>
  totals: Record<ReviewSeverity, number>
  priorityTotals: PriorityCounts
  activePriorityTotals: PriorityCounts
  gate: ConvergenceGate
  suppressedFlipFlops: SuppressedFlipFlop[]
  consensus: ConsensusEntry[]
  divergent: DivergentEntry[]
  sole: SoleEntry[]
  /** 缺席评审员(默认宽松模式下跳过的坏文件);--strict 时任何坏文件直接 exit 1,此处恒为空。 */
  skipped: SkippedReview[]
  /** 经机器反例证伪的发现(已自动排除,不计入活跃 P0 与共识区);仅启用科学验证上下文时附带。 */
  machineRefuted?: MachineRefutedFinding[]
  /** 科学深审指标(跨家族覆盖、机器核验 P0 与 Chao1 残余估算);仅启用科学验证上下文时附带。 */
  scientificMetrics?: ScientificMetrics
}

export type CollateOptions = {
  ledger?: DecisionLedger
  round?: number
  verificationReport?: VerificationReport
  scriptRoot?: string
  /** 可选冻结稿件/数据输入版本摘要(SHA-256 或版本标签);提供时校验与 verificationReport 及 findingDigest 一致。 */
  inputDigest?: string
  scientificGate?: boolean
  minFamilies?: number
  maxResidual?: number
  sourceFiles?: ReadonlyMap<ReviewFile, string>
}

const CANONICAL_ANCHOR_RE = /^(sec|fig|tab|line|raw):(.+)$/i

/** 归一账本锚点:已归一串(如 sec:3.2/fig:4)保持同构,自然语言位置经 locationAnchors 归一。 */
export function normalizeLedgerAnchor(raw: string): string {
  const s = raw.trim()
  if (!s) return ''
  if (s === '*') return '*'
  const canon = CANONICAL_ANCHOR_RE.exec(s)
  if (canon) {
    const prefix = canon[1].toLowerCase()
    const body =
      prefix === 'line'
        ? canon[2].trim().replace(/\s*[-–—~]\s*/g, '-')
        : canon[2].trim().toLowerCase().replace(/\s+/g, ' ')
    return `${prefix}:${body}`
  }
  const anchors = locationAnchors(s)
  return anchors[0] ?? `raw:${s.toLowerCase().replace(/\s+/g, ' ')}`
}

export function normalizeTopic(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, ' ')
}

export function ledgerEntryId(anchor: string, topic: string): string {
  return `${normalizeLedgerAnchor(anchor)}::${normalizeTopic(topic)}`
}

export function createEmptyLedger(): DecisionLedger {
  return { schemaVersion: 1, entries: [] }
}

export function parseDecisionLedger(text: string, label: string): DecisionLedger {
  function bad(msg: string): never {
    throw new ReviewFormatError(`${label}: ${msg}`)
  }
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    bad('invalid JSON')
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    bad('ledger top-level must be an object')
  }
  const obj = data as Record<string, unknown>
  if (obj.schemaVersion !== 1) {
    bad('ledger schemaVersion must be 1')
  }
  if (!Array.isArray(obj.entries)) {
    bad('ledger entries must be an array')
  }
  const entries: LedgerEntry[] = obj.entries.map((raw, i) => {
    const where = `entries[${i}]`
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      bad(`${where} must be an object`)
    }
    const e = raw as Record<string, unknown>
    if (typeof e.anchor !== 'string' || e.anchor.trim() === '') {
      bad(`${where}.anchor must be a non-empty string`)
    }
    if (typeof e.topic !== 'string' || e.topic.trim() === '') {
      bad(`${where}.topic must be a non-empty string`)
    }
    if (!isLedgerDecision(e.decision)) {
      bad(`${where}.decision must be one of ${LEDGER_DECISIONS.join('|')}`)
    }
    if (typeof e.reason !== 'string' || e.reason.trim() === '') {
      bad(`${where}.reason must be a non-empty string`)
    }
    if (typeof e.round !== 'number' || !Number.isInteger(e.round) || e.round < 1) {
      bad(`${where}.round must be a positive integer`)
    }
    if (e.evidence !== undefined && typeof e.evidence !== 'string') {
      bad(`${where}.evidence must be a string when present`)
    }
    if (e.updatedAt !== undefined && typeof e.updatedAt !== 'string') {
      bad(`${where}.updatedAt must be a string when present`)
    }
    if (e.id !== undefined && (typeof e.id !== 'string' || e.id.trim() === '')) {
      bad(`${where}.id must be a non-empty string when present`)
    }
    const normAnchor = normalizeLedgerAnchor(e.anchor)
    const entry: LedgerEntry = {
      id: typeof e.id === 'string' && e.id.trim() !== '' ? e.id.trim() : ledgerEntryId(normAnchor, e.topic),
      anchor: normAnchor,
      topic: e.topic.trim(),
      decision: e.decision,
      reason: e.reason.trim(),
      round: e.round,
    }
    if (e.evidence !== undefined) entry.evidence = e.evidence
    if (e.updatedAt !== undefined) entry.updatedAt = e.updatedAt
    return entry
  })
  entries.sort((a, b) => a.id.localeCompare(b.id))
  return { schemaVersion: 1, entries }
}

export type LedgerUpsertInput = {
  anchor: string
  topic: string
  decision: LedgerDecision
  reason: string
  round: number
  evidence?: string
  updatedAt?: string
}

/**
 * 按归一 (anchor + topic) 幂等 upsert 裁决条目,保持 entries 按 id 确定性排序。
 * 乱序保护:若同键已存在更高轮裁决(input.round < existing.round),严禁覆盖高轮裁决,
 * 保留 existing 并返回 staleIgnored=true。
 */
export function upsertLedgerEntry(
  ledger: DecisionLedger,
  input: LedgerUpsertInput,
): { ledger: DecisionLedger; action: 'created' | 'updated' | 'ignored_stale'; entry: LedgerEntry; staleIgnored: boolean } {
  const normAnchor = normalizeLedgerAnchor(input.anchor)
  const trimmedTopic = input.topic.trim()
  const id = ledgerEntryId(normAnchor, trimmedTopic)
  const existing = ledger.entries.find((e) => ledgerEntryId(e.anchor, e.topic) === id || e.id === id)
  if (existing !== undefined && input.round < existing.round) {
    return { ledger, action: 'ignored_stale', entry: existing, staleIgnored: true }
  }
  const entry: LedgerEntry = {
    id,
    anchor: normAnchor,
    topic: trimmedTopic,
    decision: input.decision,
    reason: input.reason.trim(),
    round: input.round,
  }
  if (input.evidence !== undefined) entry.evidence = input.evidence
  if (input.updatedAt !== undefined) entry.updatedAt = input.updatedAt

  const nextEntries = ledger.entries.filter((e) => ledgerEntryId(e.anchor, e.topic) !== id && e.id !== id)
  const action: 'created' | 'updated' = existing === undefined ? 'created' : 'updated'
  nextEntries.push(entry)
  nextEntries.sort((a, b) => a.id.localeCompare(b.id))
  return { ledger: { schemaVersion: 1, entries: nextEntries }, action, entry, staleIgnored: false }
}

function ledgerEntryAnchors(anchor: string): string[] {
  const s = anchor.trim()
  if (!s) return []
  if (s === '*') return ['*']
  if (CANONICAL_ANCHOR_RE.test(s)) return [normalizeLedgerAnchor(s)]
  return locationAnchors(s)
}

/** 过于宽泛的短主题词:在 finding 未提供 topic 时不得仅凭正文子串折叠新 P0(fail-safe)。 */
const GENERIC_FALLBACK_TOPICS: ReadonlySet<string> = new Set([
  '符号', '公式', '单位', '格式', '图表', '引用', '数据', '结论', '方法', '误差',
  '问题', '错误', '修改', '文字', '措辞', '结构', '内容', '描述', '说明', '细节',
  '格式问题', '文字问题', '符号问题', '公式问题', '数据问题', '引用问题',
  'format', 'style', 'typo', 'symbol', 'unit', 'figure', 'table', 'citation',
  'error', 'issue', 'formula', 'data',
])

function isSpecificFallbackTopic(normalizedTopic: string): boolean {
  const compact = normalizedTopic.replace(/\s+/g, '')
  if (compact.length < 4) return false
  if (GENERIC_FALLBACK_TOPICS.has(normalizedTopic) || GENERIC_FALLBACK_TOPICS.has(compact)) return false
  return true
}

/**
 * 严格收紧的账本折叠匹配(fail-safe:宁可保留活跃项,绝不误折叠新 P0):
 *   1. finding 提供显式非空 topic:只允许与账本 topic 归一精确相等,或账本 topic === '*' 通配;
 *      严禁回退搜索 finding.issue 正文子串。
 *   2. finding 未提供 topic:仅允许账本 topic === '*',或账本 topic 足够具体(非泛词且去空白后 >= 4 字符)
 *      且被 finding.issue 包含。
 */
function matchSuppressedLedgerEntry(finding: ReviewFinding, ledger: DecisionLedger): LedgerEntry | undefined {
  const fAnchors = locationAnchors(finding.location)
  const fTopic = finding.topic !== undefined ? normalizeTopic(finding.topic) : ''
  const fIssue = normalizeTopic(finding.issue)
  const isP0 = resolveFindingPriority(finding) === 'P0'
  let wildcardMatch: LedgerEntry | undefined
  for (const entry of ledger.entries) {
    if (entry.decision !== 'rejected_with_evidence' && entry.decision !== 'accepted') continue
    const eAnchors = ledgerEntryAnchors(entry.anchor)
    const anchorHit =
      eAnchors.includes('*') || fAnchors.some((a) => eAnchors.includes(a))
    if (!anchorHit) continue
    const eTopic = normalizeTopic(entry.topic)
    if (eTopic === '*') {
      if (wildcardMatch === undefined) wildcardMatch = entry
      continue
    }
    if (eTopic === '') continue
    if (fTopic !== '') {
      if (fTopic === eTopic) return entry
      continue
    }
    // Fail-safe for P0: without an explicit matching topic (or wildcard '*'), never suppress a P0 via substring match.
    if (!isP0 && isSpecificFallbackTopic(eTopic) && fIssue.includes(eTopic)) {
      return entry
    }
  }
  return wildcardMatch
}

function emptySeverityCounts(): Record<ReviewSeverity, number> {
  return { blocker: 0, major: 0, minor: 0, suggestion: 0 }
}

function emptyPriorityCounts(): PriorityCounts {
  return { P0: 0, P1: 0, P2: 0 }
}

function emptyVerdictCounts(): Record<ReviewVerdict, number> {
  return { accept: 0, minor: 0, major: 0, reject: 0 }
}

const sevRank = (s: ReviewSeverity): number => SEVERITIES.indexOf(s)

function soleSeverity(entry: SoleEntry): ReviewSeverity {
  return entry.findings.reduce<ReviewSeverity>(
    (max, f) => (sevRank(f.severity) < sevRank(max) ? f.severity : max),
    'suggestion',
  )
}

/**
 * 确定性聚合:
 *   共识 = 同锚点、≥2 位评审员、且全部同 severity 档;
 *   分歧 = 同锚点、≥2 位评审员、severity 档冲突(双方并列,多数侧只标注不裁决);
 *   单发 = 该锚点只有一位评审员命中。
 * 同一 finding 命中多锚点时进入每个锚点的桶(输出可能多处出现,如实呈现)。
 * 当提供 ledger 时,命中 accepted / rejected_with_evidence 且未声明 new_evidence: true 的
 * finding 自动折叠进 suppressedFlipFlops,不计入 activePriorityTotals 与活跃 P0 闸门。
 */
type AuthoritativeVerificationResolution = {
  status?: MachineVerificationStatus
  output?: string
  reproScript?: string
}

/**
 * 严格按 `(file, findingDigest)` 加密绑定解析权威机器核验状态(B4):
 *   - 无 `--verification` 或缺失 `sourceFile` 时 fail-closed 返回空(绝不按索引或跨文件回退);
 *   - 冻结输入版本 `inputDigest` 不匹配时 fail-closed 返回 `unverified`;
 *   - 同一 `(file, findingDigest)` 在报告中存在冲突条目时 fail-closed 返回 `unverified`;
 *   - 对 `confirmed`/`refuted` 且提供可信 `checkScriptRoot` 时,既核对 `report.scriptRoot` 与
 *     可信目录一致,又按可信目录校核实时磁盘脚本 SHA-256,不一致视为陈旧退回 `unverified`。
 */
function resolveAuthoritativeVerification(
  report: VerificationReport | undefined,
  sourceFile: string | undefined,
  reviewerModel: string,
  finding: ReviewFinding,
  checkScriptRoot: string | undefined,
  inputDigest: string | undefined,
): AuthoritativeVerificationResolution {
  if (!report || sourceFile === undefined) return {}
  const expectedInputDigest = inputDigest?.trim() || undefined
  const reportInputDigest = report.inputDigest?.trim() || undefined
  if (expectedInputDigest !== undefined && reportInputDigest !== expectedInputDigest) {
    return {
      status: 'unverified',
      output: 'stale verification: input/manuscript version mismatch',
      ...(finding.repro_script !== undefined ? { reproScript: finding.repro_script } : {}),
    }
  }
  const effectiveInputDigest = expectedInputDigest ?? reportInputDigest
  const digest = computeFindingDigest(sourceFile, reviewerModel, finding, effectiveInputDigest)
  const matches = report.entries.filter(
    (e) => e.file === sourceFile && e.findingDigest === digest,
  )
  if (matches.length === 0) return {}
  if (matches.length > 1) {
    const distinctStates = new Set(matches.map((m) => `${m.status}|${m.scriptSha256 ?? ''}`))
    if (distinctStates.size > 1) {
      return {
        status: 'unverified',
        output: 'conflicting duplicate verification entries for finding digest',
        reproScript: matches[0]!.reproScript,
      }
    }
  }
  const entry = matches[0]!
  if (
    (entry.status === 'confirmed' || entry.status === 'refuted') &&
    finding.repro_script !== undefined &&
    checkScriptRoot !== undefined &&
    checkScriptRoot.trim() !== ''
  ) {
    let realTrustedRoot: string
    let realReportRoot: string
    try {
      realTrustedRoot = realpathSync(resolve(checkScriptRoot))
      realReportRoot = realpathSync(resolve(report.scriptRoot))
    } catch {
      return {
        status: 'unverified',
        output: 'stale verification: scriptRoot cannot be resolved',
        reproScript: entry.reproScript,
      }
    }
    if (realTrustedRoot !== realReportRoot) {
      return {
        status: 'unverified',
        output: 'stale verification: verification report scriptRoot does not match trusted scriptRoot',
        reproScript: entry.reproScript,
      }
    }
    if (!entry.scriptSha256) {
      return {
        status: 'unverified',
        output: 'stale verification: missing scriptSha256',
        reproScript: entry.reproScript,
      }
    }
    const liveSha = computeSafeScriptSha256(realTrustedRoot, finding.repro_script)
    if (liveSha === null || liveSha !== entry.scriptSha256) {
      return {
        status: 'unverified',
        output: 'stale verification: repro_script changed or missing on disk',
        reproScript: entry.reproScript,
      }
    }
  }
  const output = entry.summary || entry.outputPreview || entry.reason || undefined
  return {
    status: entry.status,
    ...(output !== undefined ? { output } : {}),
    reproScript: entry.reproScript,
  }
}

export function collateReviews(
  files: ReviewFile[],
  skipped: SkippedReview[] = [],
  options: CollateOptions = {},
): CollateResult {
  const sorted = [...files].sort(
    (a, b) =>
      a.reviewer.model.localeCompare(b.reviewer.model) ||
      (options.sourceFiles?.get(a) ?? '').localeCompare(options.sourceFiles?.get(b) ?? ''),
  )
  const totals = emptySeverityCounts()
  const priorityTotals = emptyPriorityCounts()
  const activePriorityTotals = emptyPriorityCounts()
  const verdictCounts = emptyVerdictCounts()
  const reviewers: ReviewerSummary[] = []
  const suppressedFlipFlops: SuppressedFlipFlop[] = []
  const machineRefuted: MachineRefutedFinding[] = []
  const activeFindingsForMetrics: ScientificMetricsActiveFinding[] = []
  const buckets = new Map<string, TaggedFinding[]>()
  let hasScientificContext = Boolean(options.verificationReport || options.scientificGate)
  const checkScriptRoot = options.scriptRoot
  const inputDigest = options.inputDigest?.trim() || undefined

  for (const file of sorted) {
    const counts = emptySeverityCounts()
    verdictCounts[file.verdict] += 1
    const sourceFile = options.sourceFiles?.get(file)
    // B6: 独立家族严格按可核实的实际来源 `reviewer.model` 归类(绝不采纳自报 model_family 字符串)
    const fileFamily = resolveModelFamily(file.reviewer.model)

    for (let findingIdx = 0; findingIdx < file.findings.length; findingIdx++) {
      const finding = file.findings[findingIdx]!
      counts[finding.severity] += 1
      totals[finding.severity] += 1
      const resolvedPriority = resolveFindingPriority(finding)
      priorityTotals[resolvedPriority] += 1

      if (
        finding.repro_script !== undefined ||
        finding.verified_by_machine !== undefined ||
        finding.verification_output !== undefined
      ) {
        hasScientificContext = true
      }

      // B4: 权威机器核验仅来自加密绑定 `--verification` 报告,评审 JSON 自填字段仅作展示
      const auth = resolveAuthoritativeVerification(
        options.verificationReport,
        sourceFile,
        file.reviewer.model,
        finding,
        checkScriptRoot,
        inputDigest,
      )
      const authoritativeStatus = auth.status

      if (authoritativeStatus === 'refuted') {
        hasScientificContext = true
        const refutedItem: MachineRefutedFinding = {
          reviewer: file.reviewer.model,
          modelFamily: fileFamily,
          finding: { ...finding, verified_by_machine: 'refuted' },
          priority: resolvedPriority,
        }
        const scriptRef = auth.reproScript ?? finding.repro_script
        if (scriptRef !== undefined) refutedItem.reproScript = scriptRef
        if (auth.output !== undefined) {
          refutedItem.verificationOutput = auth.output
          refutedItem.finding.verification_output = auth.output
        }
        machineRefuted.push(refutedItem)
        continue
      }

      const matchedEntry =
        options.ledger !== undefined ? matchSuppressedLedgerEntry(finding, options.ledger) : undefined
      // B4: 新机器 confirmed 与旧账本冲突时严禁静默折叠,强制以新反证重开进入活跃 P0
      const forcedReopenByMachine = matchedEntry !== undefined && authoritativeStatus === 'confirmed'
      if (matchedEntry !== undefined && finding.new_evidence !== true && !forcedReopenByMachine) {
        const ledgerSnapshot: SuppressedFlipFlop['ledgerEntry'] = {
          id: matchedEntry.id,
          anchor: matchedEntry.anchor,
          topic: matchedEntry.topic,
          decision: matchedEntry.decision,
          reason: matchedEntry.reason,
          round: matchedEntry.round,
        }
        if (matchedEntry.evidence !== undefined) ledgerSnapshot.evidence = matchedEntry.evidence
        suppressedFlipFlops.push({
          reviewer: file.reviewer.model,
          finding: { ...finding },
          priority: resolvedPriority,
          ledgerEntry: ledgerSnapshot,
        })
        continue
      }

      activePriorityTotals[resolvedPriority] += 1
      const tagged: TaggedFinding = {
        ...finding,
        reviewer: file.reviewer.model,
        resolvedPriority,
      }
      if (authoritativeStatus !== undefined) {
        tagged.authoritativeVerification = authoritativeStatus
        tagged.verified_by_machine = authoritativeStatus
      }
      if (auth.output !== undefined) tagged.verification_output = auth.output
      if (matchedEntry !== undefined && (finding.new_evidence === true || forcedReopenByMachine)) {
        tagged.reopenedWithNewEvidence = true
        tagged.matchedLedgerId = matchedEntry.id
      }
      const anchors = locationAnchors(finding.location)
      const defectKey = computeDefectIdentityKey(anchors, finding.location, finding.topic, finding.issue)
      const normalizedTopic = normalizeDefectText(finding.topic)
      const normalizedIssue = normalizeDefectIssue(finding.issue)
      activeFindingsForMetrics.push({
        reviewer: file.reviewer.model,
        modelFamily: fileFamily,
        defectKey,
        anchors,
        ...(normalizedTopic !== '' ? { normalizedTopic } : {}),
        ...(normalizedIssue !== '' ? { normalizedIssue } : {}),
        resolvedPriority,
        ...(finding.category !== undefined ? { category: finding.category } : {}),
        ...(authoritativeStatus !== undefined ? { verifiedByMachine: authoritativeStatus } : {}),
      })
      for (const anchor of anchors) {
        const bucket = buckets.get(anchor)
        if (bucket) bucket.push(tagged)
        else buckets.set(anchor, [tagged])
      }
    }
    const summary: ReviewerSummary = {
      model: file.reviewer.model,
      verdict: file.verdict,
      counts,
    }
    if (file.reviewer.role !== undefined) summary.role = file.reviewer.role
    reviewers.push(summary)
  }

  const consensus: ConsensusEntry[] = []
  const divergent: DivergentEntry[] = []
  const sole: SoleEntry[] = []
  for (const [anchor, items] of [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const reviewersHere = [...new Set(items.map((x) => x.reviewer))]
    if (reviewersHere.length === 1) {
      sole.push({ kind: 'sole', anchor, source: reviewersHere[0], findings: items })
      continue
    }
    const bySeverity = new Map<ReviewSeverity, TaggedFinding[]>()
    for (const item of items) {
      const list = bySeverity.get(item.severity)
      if (list) list.push(item)
      else bySeverity.set(item.severity, [item])
    }
    const sides: DivergentSide[] = [...bySeverity.entries()]
      .map(([severity, findings]) => ({
        severity,
        sources: [...new Set(findings.map((f) => f.reviewer))].sort(),
        findings,
      }))
      .sort((a, b) => sevRank(a.severity) - sevRank(b.severity))
    if (sides.length === 1) {
      consensus.push({
        kind: 'consensus',
        anchor,
        severity: sides[0].severity,
        sources: sides[0].sources,
        findings: sides[0].findings,
      })
    } else {
      // 严格 > 保序归约:并列时保留更严重档(sides 已按严重度升序 rank)
      const majority = sides.reduce((best, s) => (s.sources.length > best.sources.length ? s : best), sides[0])
      divergent.push({ kind: 'divergent', anchor, sides, majority: majority.severity })
    }
  }
  consensus.sort((a, b) => sevRank(a.severity) - sevRank(b.severity) || a.anchor.localeCompare(b.anchor))
  divergent.sort(
    (a, b) => sevRank(a.sides[0].severity) - sevRank(b.sides[0].severity) || a.anchor.localeCompare(b.anchor),
  )
  sole.sort((a, b) => sevRank(soleSeverity(a)) - sevRank(soleSeverity(b)) || a.anchor.localeCompare(b.anchor))
  suppressedFlipFlops.sort(
    (a, b) =>
      a.ledgerEntry.id.localeCompare(b.ledgerEntry.id) ||
      a.reviewer.localeCompare(b.reviewer) ||
      a.finding.location.localeCompare(b.finding.location) ||
      a.finding.issue.localeCompare(b.finding.issue),
  )
  machineRefuted.sort(
    (a, b) =>
      a.reviewer.localeCompare(b.reviewer) ||
      a.finding.location.localeCompare(b.finding.location) ||
      a.finding.issue.localeCompare(b.finding.issue),
  )

  const activeP0 = activePriorityTotals.P0
  const gate: ConvergenceGate = {
    status: activeP0 === 0 ? 'PASS_READY' : 'FIX_REQUIRED',
    activeP0,
    suppressedFlipFlops: suppressedFlipFlops.length,
    message:
      activeP0 === 0
        ? 'P0 硬伤已归零，达到收敛放行线，禁止为交差继续发散挑刺'
        : `仍有 ${activeP0} 条活跃 P0 硬伤待修复，暂不可放行`,
  }
  if (options.round !== undefined) gate.round = options.round

  const skippedSorted = [...skipped].sort((a, b) => a.file.localeCompare(b.file))
  const result: CollateResult = {
    reviewers,
    verdictCounts,
    totals,
    priorityTotals,
    activePriorityTotals,
    gate,
    suppressedFlipFlops,
    consensus,
    divergent,
    sole,
    skipped: skippedSorted,
  }
  if (hasScientificContext) {
    const scientificMetrics = computeScientificMetrics({
      files: sorted,
      activeFindings: activeFindingsForMetrics,
      machineRefuted: machineRefuted.map((m) => ({ resolvedPriority: m.priority })),
      ...(options.minFamilies !== undefined ? { minFamilies: options.minFamilies } : {}),
      ...(options.maxResidual !== undefined ? { maxResidual: options.maxResidual } : {}),
    })
    if (options.scientificGate === true) {
      gate.status = scientificMetrics.scientificGateStatus
      gate.message = formatScientificGateMessage(scientificMetrics)
    }
    result.machineRefuted = machineRefuted
    result.scientificMetrics = scientificMetrics
  }
  return result
}

/** 末行 `COLLATE: b/m/mi/s`;有缺席评审员时追加 ` skipped=<n>`,程序判读能一眼看出汇总不完整。 */
export function collateLine(result: CollateResult): string {
  const t = result.totals
  const base = `COLLATE: ${t.blocker}/${t.major}/${t.minor}/${t.suggestion}`
  return result.skipped.length > 0 ? `${base} skipped=${result.skipped.length}` : base
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function findingIssueSuffix(f: TaggedFinding): string {
  const tags: string[] = []
  if (f.reopenedWithNewEvidence === true) tags.push('[reopened_with_new_evidence]')
  if (f.authoritativeVerification === 'confirmed') tags.push('[machine_confirmed]')
  return tags.length > 0 ? ` ${tags.join(' ')}` : ''
}

/** 渲染 Markdown 汇总卡(确定性:同一输入字节级相同输出)。 */
export function renderSummaryMd(result: CollateResult): string {
  const lines: string[] = []
  lines.push('# 多模型评审汇总', '')
  const gateMeta: string[] = [`活跃 P0=${result.gate.activeP0}`]
  if (result.gate.round !== undefined) gateMeta.push(`第 ${result.gate.round} 轮`)
  if (result.gate.suppressedFlipFlops > 0) gateMeta.push(`已折叠翻案 ${result.gate.suppressedFlipFlops} 条`)
  lines.push(`> **收敛闸门: \`${result.gate.status}\` (${gateMeta.join(' | ')})** — ${result.gate.message}`)
  const pt = result.priorityTotals
  const apt = result.activePriorityTotals
  lines.push(
    `> 优先级分布: 活跃 P0=${apt.P0} / P1=${apt.P1} / P2=${apt.P2}（全量 P0=${pt.P0} / P1=${pt.P1} / P2=${pt.P2}）`,
    '',
  )
  lines.push(`评审员 ${result.reviewers.length} 位:`)
  for (const r of result.reviewers) {
    const role = r.role === undefined ? '' : `(${r.role})`
    lines.push(
      `- \`${r.model}\`${role} verdict=${r.verdict},findings: ${SEVERITIES.map((s) => `${s}=${r.counts[s]}`).join(' ')}`,
    )
  }
  if (result.skipped.length > 0) {
    lines.push(
      '',
      `> **缺席 ${result.skipped.length} 位评审员**(评审文件坏格式已跳过,本汇总不完整;修文件后重跑可补齐):`,
    )
    for (const s of result.skipped) lines.push(`> - \`${s.file}\`: ${oneLine(s.reason)}`)
  }
  const vc = result.verdictCounts
  lines.push(
    '',
    `verdict 分布: accept=${vc.accept} / minor=${vc.minor} / major=${vc.major} / reject=${vc.reject}`,
    '',
    '## 共识(≥2 位评审员,同位置同严重度)',
    '',
  )
  if (result.consensus.length === 0) lines.push('_(无)_')
  for (const entry of result.consensus) {
    lines.push(`### [${entry.severity}] ${entry.anchor} — 来源: ${entry.sources.join(', ')}`)
    for (const f of entry.findings) {
      lines.push(`- **${f.reviewer}** ${oneLine(f.location)}: ${oneLine(f.issue)}${findingIssueSuffix(f)}`)
      if (f.suggestion !== undefined) lines.push(`  - 建议: ${oneLine(f.suggestion)}`)
    }
    lines.push('')
  }
  lines.push('## 分歧(同位置,严重度判断不一致 — 分歧 ≠ 错误,由人裁决)', '')
  if (result.divergent.length === 0) lines.push('_(无)_')
  for (const entry of result.divergent) {
    const sidesText = entry.sides
      .map((s) => `[${s.severity}](${s.sources.join(', ')})`)
      .join(' vs ')
    lines.push(`### ${entry.anchor} — 多数侧 [${entry.majority}] | ${sidesText}`)
    for (const side of entry.sides) {
      for (const f of side.findings) {
        lines.push(
          `- [${side.severity}] **${f.reviewer}** ${oneLine(f.location)}: ${oneLine(f.issue)}${findingIssueSuffix(f)}`,
        )
        if (f.suggestion !== undefined) lines.push(`  - 建议: ${oneLine(f.suggestion)}`)
      }
    }
    lines.push('')
  }
  lines.push('## 单发(仅一位评审员提出)', '')
  if (result.sole.length === 0) lines.push('_(无)_')
  for (const entry of result.sole) {
    lines.push(`### [${soleSeverity(entry)}] ${entry.anchor} — 来源: ${entry.source}`)
    for (const f of entry.findings) {
      lines.push(`- **${f.reviewer}** ${oneLine(f.location)}: ${oneLine(f.issue)}${findingIssueSuffix(f)}`)
      if (f.suggestion !== undefined) lines.push(`  - 建议: ${oneLine(f.suggestion)}`)
    }
    lines.push('')
  }
  if (result.suppressedFlipFlops.length > 0) {
    lines.push('## 已按裁决账本折叠的重复/翻案意见', '')
    for (const item of result.suppressedFlipFlops) {
      lines.push(
        `- [${item.priority}] **${item.reviewer}** ${oneLine(item.finding.location)}: ${oneLine(item.finding.issue)}`,
      )
      const ev = item.ledgerEntry.evidence !== undefined ? ` | 证据: ${oneLine(item.ledgerEntry.evidence)}` : ''
      lines.push(
        `  - 账本裁决: \`${item.ledgerEntry.decision}\` (round=${item.ledgerEntry.round}, id=\`${item.ledgerEntry.id}\`) — ${oneLine(item.ledgerEntry.reason)}${ev}`,
      )
    }
    lines.push('')
  }
  if (result.machineRefuted !== undefined && result.machineRefuted.length > 0) {
    lines.push('## 机器反例证伪（已自动排除，防多模型集体误判）', '')
    for (const item of result.machineRefuted) {
      lines.push(
        `- [${item.priority}] **${item.reviewer}** (\`${item.modelFamily}\`) ${oneLine(item.finding.location)}: ${oneLine(item.finding.issue)}`,
      )
      const detailParts: string[] = []
      if (item.reproScript !== undefined) detailParts.push(`脚本: \`${oneLine(item.reproScript)}\``)
      if (item.verificationOutput !== undefined && item.verificationOutput.trim() !== '') {
        detailParts.push(`输出: ${oneLine(item.verificationOutput)}`)
      }
      if (detailParts.length > 0) lines.push(`  - 机器证伪: ${detailParts.join(' | ')}`)
    }
    lines.push('')
  }
  if (result.scientificMetrics !== undefined) {
    const m = result.scientificMetrics
    lines.push('## 科学深审门禁（反例仲裁 + Chao1 残余估算）', '')
    lines.push(`- 科学闸门: \`${m.scientificGateStatus}\``)
    lines.push(
      `- 独立模型家族 (${m.familyCount}/${m.minFamilies}): ${m.distinctFamilies.join(', ') || '(无)'}`,
    )
    lines.push(
      `- 机器核验 P0: confirmed=${m.confirmedP0} / refuted=${m.refutedP0} / unverified=${m.unverifiedP0}（机器总证伪 ${m.totalMachineRefuted} 条）`,
    )
    lines.push(
      `- Chao1 残余估算: ${m.chao1Residual} (阈值 < ${m.maxResidual}; 独立高危桶=${m.observedDefectBuckets}, f1=${m.f1}, f2=${m.f2})`,
    )
    if (m.excludedReviewers.length > 0) {
      lines.push(
        `- 已排除非强档/非四大家族评审员（不计入跨家族覆盖与 Chao1 捕获，共 ${m.excludedReviewers.length} 位）:`,
      )
      for (const ex of m.excludedReviewers) {
        lines.push(`  - \`${ex.model}\` (family=\`${ex.family}\`, reason=\`${ex.reason}\`)`)
      }
    }
    lines.push('')
  }
  const t = result.totals
  const totalFindings = t.blocker + t.major + t.minor + t.suggestion
  lines.push('## 统计', '')
  lines.push(
    `- findings 共 ${totalFindings} 条: blocker=${t.blocker} / major=${t.major} / minor=${t.minor} / suggestion=${t.suggestion}`,
  )
  lines.push(`- exit-relevant: blocker ${t.blocker} 条、major ${t.major} 条;verdict=reject 的评审员 ${vc.reject} 位`)
  lines.push(
    `- convergence-gate: ${result.gate.status} (active P0=${apt.P0}, P1=${apt.P1}, P2=${apt.P2}; suppressedFlipFlops=${result.gate.suppressedFlipFlops})`,
  )
  lines.push('')
  return lines.join('\n')
}

export type OcReviewCliResult = { exitCode: number; stdout: string; stderr: string }

const USAGE = [
  'usage: oc-review schema',
  '       oc-review verify --dir <dir> [--exec|--unsafe-local-exec] [--script-root <root>] [--manuscript <file>|--input-sha <id>] [--timeout <sec>] [--batch-timeout <sec>] [--out <verification-report.json>]',
  '       oc-review collate --dir <dir> [--out <summary.md>] [--ledger <decision-ledger.json>] [--round <n>] [--verification <verification-report.json>] [--script-root <root>] [--manuscript <file>|--input-sha <id>] [--scientific-gate] [--min-families <n>] [--max-residual <num>] [--strict]',
  '       oc-review ledger <init|record|show> --file <path> [...]',
  '  schema   打印评审员 JSON schema(贴进委派 prompt)',
  '  verify   默认只采集 reviews-*.json 中的 repro_script 哈希与 findingDigest(不执行);',
  '           --exec 仅在具备内核强制只读/断网沙箱时执行,无沙箱环境自动退回只采集;',
  '           --unsafe-local-exec 仅限运行经人工/净室审计的本地脚本(当前容器无 OS 隔离),末行 VERIFY',
  '  collate  读 <dir>/reviews-*.json → 写 review-summary.md/.json,stdout 末行 COLLATE',
  '           可选 --ledger 挂载跨轮裁决账本防 Flip-Flop,输出 P0 收敛闸门(PASS_READY/FIX_REQUIRED)',
  '           可选 --verification 接入加密绑定机器核验报告自动排除 refuted 误判;--scientific-gate 启用 Chao1 科学深审门禁',
  '           坏格式文件默认跳过并标注缺席(COLLATE 行追加 skipped=<n>);--strict 任一坏文件即 exit 1',
  '  ledger   管理跨轮裁决账本(init / record / show),幂等记录 accepted|rejected_with_evidence|deferred',
].join('\n')

function parseSimpleFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) continue
    const key = args[i].slice(2)
    const val = args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[(i += 1)] : 'true'
    flags[key] = val
  }
  return flags
}

function err(msg: string, exitCode = 1): OcReviewCliResult {
  return { exitCode, stdout: '', stderr: `${TOOL}: ${msg}\n` }
}

export interface OcReviewCliOptions {
  callerCwd?: string
}

/**
 * 解析调用方传入的路径:若为相对路径且显式提供 callerCwd(如经 oc-review.sh 注入 `--caller-cwd "$PWD"`),
 * 按调用方原始工作目录解析,避免相对路径落到只读的 /opt/openclaude。
 */
export function resolveCallerPath(p: string, callerCwd?: string): string {
  if (isAbsolute(p)) return p
  const base = callerCwd?.trim()
  if (base) return resolve(base, p)
  return resolve(p)
}

function extractLeadingCallerCwd(
  argv: string[],
  fallbackCwd?: string,
): { argv: string[]; callerCwd?: string } {
  if (argv[0] === '--caller-cwd' && argv.length >= 2) {
    const injected = argv[1]!.trim()
    return { argv: argv.slice(2), callerCwd: injected || fallbackCwd }
  }
  return { argv, callerCwd: fallbackCwd }
}

function parsePositiveInt(raw: string): number | null {
  if (!/^\d+$/.test(raw.trim())) return null
  const n = Number(raw.trim())
  return Number.isSafeInteger(n) && n >= 1 ? n : null
}

function parseNonNegativeNumber(raw: string): number | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  const n = Number(trimmed)
  return Number.isFinite(n) && n >= 0 ? n : null
}

function resolveInputDigestFlag(
  cmdName: string,
  flags: Record<string, string>,
  callerCwd?: string,
): { ok: true; inputDigest?: string } | { ok: false; result: OcReviewCliResult } {
  const hasManuscript = flags.manuscript !== undefined
  const hasInputSha = flags['input-sha'] !== undefined
  if (hasManuscript && hasInputSha) {
    return {
      ok: false,
      result: err(`${cmdName}: specify at most one of --manuscript or --input-sha`, 2),
    }
  }
  if (hasManuscript) {
    if (flags.manuscript === 'true' || flags.manuscript.trim() === '') {
      return { ok: false, result: err(`${cmdName} --manuscript <file>`, 2) }
    }
    const target = resolveCallerPath(flags.manuscript, callerCwd)
    try {
      return { ok: true, inputDigest: `sha256:${computeSafeFileSha256(target)}` }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { ok: false, result: err(`cannot hash --manuscript ${target}: ${msg}`) }
    }
  }
  if (hasInputSha) {
    if (flags['input-sha'] === 'true' || flags['input-sha'].trim() === '') {
      return { ok: false, result: err(`${cmdName} --input-sha <id>`, 2) }
    }
    return { ok: true, inputDigest: flags['input-sha'].trim() }
  }
  return { ok: true }
}

function runVerify(rest: string[], callerCwd?: string): OcReviewCliResult {
  const flags = parseSimpleFlags(rest)
  const rawDir = flags.dir
  if (rawDir === undefined || rawDir === 'true' || rawDir.trim() === '') {
    return err(
      'verify --dir <dir> [--exec|--unsafe-local-exec] [--script-root <root>] [--manuscript <file>|--input-sha <id>] [--timeout <sec>] [--batch-timeout <sec>] [--out <verification-report.json>]',
      2,
    )
  }
  const dir = resolveCallerPath(rawDir, callerCwd)
  const execEnabled = flags.exec !== undefined && flags.exec !== 'false'
  const unsafeLocalExec =
    flags['unsafe-local-exec'] !== undefined && flags['unsafe-local-exec'] !== 'false'
  let scriptRoot = dir
  if (flags['script-root'] !== undefined) {
    if (flags['script-root'] === 'true' || flags['script-root'].trim() === '') {
      return err('verify --script-root <root>', 2)
    }
    scriptRoot = resolveCallerPath(flags['script-root'], callerCwd)
  }
  const inputRes = resolveInputDigestFlag('verify', flags, callerCwd)
  if (!inputRes.ok) return inputRes.result
  const inputDigest = inputRes.inputDigest
  let timeoutMs = DEFAULT_VERIFY_TIMEOUT_MS
  if (flags.timeout !== undefined) {
    if (flags.timeout === 'true') {
      return err('verify --timeout must be a positive number (seconds)', 2)
    }
    const sec = Number(flags.timeout.trim())
    if (!Number.isFinite(sec) || sec <= 0) {
      return err('verify --timeout must be a positive number (seconds)', 2)
    }
    timeoutMs = sec * 1000
  }
  let batchTimeoutMs = DEFAULT_BATCH_TIMEOUT_MS
  if (flags['batch-timeout'] !== undefined) {
    if (flags['batch-timeout'] === 'true') {
      return err('verify --batch-timeout must be a positive number (seconds)', 2)
    }
    const sec = Number(flags['batch-timeout'].trim())
    if (!Number.isFinite(sec) || sec <= 0) {
      return err('verify --batch-timeout must be a positive number (seconds)', 2)
    }
    batchTimeoutMs = sec * 1000
  }
  let outPath = join(dir, 'verification-report.json')
  if (flags.out !== undefined) {
    if (flags.out === 'true' || flags.out.trim() === '') {
      return err('verify --out <path>', 2)
    }
    outPath = resolveCallerPath(flags.out, callerCwd)
  }

  let names: string[]
  try {
    names = readdirSync(dir)
      .filter((n) => /^reviews-.*\.json$/.test(n))
      .sort()
  } catch {
    return err(`cannot read dir: ${dir}`)
  }
  if (names.length === 0) return err(`no reviews-*.json in ${dir}`)

  try {
    if (!statSync(scriptRoot).isDirectory()) {
      return err(`scriptRoot is not a directory: ${scriptRoot}`)
    }
  } catch {
    return err(`cannot read scriptRoot: ${scriptRoot}`)
  }

  let validCount = 0
  const badReasons: string[] = []
  for (const name of names) {
    try {
      parseReviewFile(readFileSync(join(dir, name), 'utf8'), name)
      validCount += 1
    } catch (e) {
      badReasons.push(e instanceof ReviewFormatError ? e.message : `${name}: cannot read file`)
    }
  }
  if (validCount === 0) {
    return err(`no valid reviews-*.json in ${dir} (${badReasons.join('; ')})`)
  }

  let report: VerificationReport
  try {
    report = verifyWitnessesInDir({
      dir,
      scriptRoot,
      exec: execEnabled,
      unsafeLocalExec,
      ...(inputDigest !== undefined ? { inputDigest } : {}),
      timeoutMs,
      batchTimeoutMs,
      parseReview: parseReviewFile,
    })
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e))
  }

  try {
    mkdirSync(dirname(resolve(outPath)), { recursive: true })
    writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return err(`cannot write ${outPath}: ${msg}`)
  }

  const stdout = `${JSON.stringify({ ...report, reportPath: outPath }, null, 2)}\n${formatVerifySummaryLine(report)}\n`
  return { exitCode: 0, stdout, stderr: '' }
}

function runLedger(rest: string[], callerCwd?: string): OcReviewCliResult {
  const [subcmd, ...args] = rest
  if (!subcmd || (subcmd !== 'init' && subcmd !== 'record' && subcmd !== 'show')) {
    return err('ledger <init|record|show> --file <path>', 2)
  }
  const flags = parseSimpleFlags(args)
  const rawFile = flags.file
  if (rawFile === undefined || rawFile === 'true' || rawFile.trim() === '') {
    return err(`ledger ${subcmd} --file <path>`, 2)
  }
  const file = resolveCallerPath(rawFile, callerCwd)

  if (subcmd === 'init') {
    const force = flags.force !== undefined
    const existed = existsSync(file)
    if (existed && !force) {
      let existing: DecisionLedger
      try {
        existing = parseDecisionLedger(readFileSync(file, 'utf8'), file)
      } catch (e) {
        const msg = e instanceof ReviewFormatError ? e.message : String(e)
        return err(`existing ledger invalid (use --force to overwrite): ${msg}`)
      }
      return {
        exitCode: 0,
        stdout: `${JSON.stringify({ action: 'exists', file, ledger: existing }, null, 2)}\n`,
        stderr: '',
      }
    }
    const ledger = createEmptyLedger()
    try {
      mkdirSync(dirname(resolve(file)), { recursive: true })
      writeFileSync(file, `${JSON.stringify(ledger, null, 2)}\n`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return err(`cannot write ledger ${file}: ${msg}`)
    }
    return {
      exitCode: 0,
      stdout: `${JSON.stringify({ action: existed ? 'reset' : 'created', file, ledger }, null, 2)}\n`,
      stderr: '',
    }
  }

  if (subcmd === 'record') {
    const anchor = flags.anchor
    const topic = flags.topic
    const decision = flags.decision
    const reason = flags.reason
    if (
      anchor === undefined ||
      anchor === 'true' ||
      anchor.trim() === '' ||
      topic === undefined ||
      topic === 'true' ||
      topic.trim() === '' ||
      decision === undefined ||
      decision === 'true' ||
      reason === undefined ||
      reason === 'true' ||
      reason.trim() === ''
    ) {
      return err(
        'ledger record --file <path> --anchor <anchor> --topic <topic> --decision <accepted|rejected_with_evidence|deferred> --reason <reason> [--round <n>] [--evidence <text>]',
        2,
      )
    }
    if (!isLedgerDecision(decision)) {
      return err(`ledger record --decision must be one of ${LEDGER_DECISIONS.join('|')}`, 2)
    }
    let round = 1
    if (flags.round !== undefined) {
      if (flags.round === 'true') return err('ledger record --round must be a positive integer', 2)
      const parsed = parsePositiveInt(flags.round)
      if (parsed === null) return err('ledger record --round must be a positive integer', 2)
      round = parsed
    }
    if (flags.evidence === 'true') {
      return err('ledger record --evidence requires a value', 2)
    }
    if (flags['updated-at'] === 'true') {
      return err('ledger record --updated-at requires a value', 2)
    }

    let baseLedger: DecisionLedger
    if (existsSync(file)) {
      try {
        baseLedger = parseDecisionLedger(readFileSync(file, 'utf8'), file)
      } catch (e) {
        const msg = e instanceof ReviewFormatError ? e.message : String(e)
        return err(msg)
      }
    } else {
      baseLedger = createEmptyLedger()
    }

    const input: LedgerUpsertInput = { anchor, topic, decision, reason, round }
    if (flags.evidence !== undefined) input.evidence = flags.evidence
    if (flags['updated-at'] !== undefined) input.updatedAt = flags['updated-at']
    const { ledger, action, entry, staleIgnored } = upsertLedgerEntry(baseLedger, input)
    if (!staleIgnored) {
      try {
        mkdirSync(dirname(resolve(file)), { recursive: true })
        writeFileSync(file, `${JSON.stringify(ledger, null, 2)}\n`)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return err(`cannot write ledger ${file}: ${msg}`)
      }
    }
    return {
      exitCode: 0,
      stdout: `${JSON.stringify({ action, file, entry, totalEntries: ledger.entries.length, staleIgnored }, null, 2)}\n`,
      stderr: '',
    }
  }

  // show
  let ledger: DecisionLedger
  try {
    ledger = parseDecisionLedger(readFileSync(file, 'utf8'), file)
  } catch (e) {
    const msg = e instanceof ReviewFormatError ? e.message : `cannot read ledger ${file}`
    return err(msg)
  }
  const summary: Record<LedgerDecision, number> & { total: number } = {
    total: ledger.entries.length,
    accepted: 0,
    rejected_with_evidence: 0,
    deferred: 0,
  }
  for (const e of ledger.entries) summary[e.decision] += 1
  return {
    exitCode: 0,
    stdout: `${JSON.stringify({ file, summary, ledger }, null, 2)}\n`,
    stderr: '',
  }
}

function runCollate(rest: string[], callerCwd?: string): OcReviewCliResult {
  const flags = parseSimpleFlags(rest)
  const rawDir = flags.dir
  if (rawDir === undefined || rawDir === 'true') return err('collate --dir <dir>', 2)
  const dir = resolveCallerPath(rawDir, callerCwd)
  let ledger: DecisionLedger | undefined
  if (flags.ledger !== undefined) {
    if (flags.ledger === 'true' || flags.ledger.trim() === '') {
      return err('collate --ledger <path>', 2)
    }
    const ledgerPath = resolveCallerPath(flags.ledger, callerCwd)
    try {
      ledger = parseDecisionLedger(readFileSync(ledgerPath, 'utf8'), ledgerPath)
    } catch (e) {
      const msg = e instanceof ReviewFormatError ? e.message : `cannot read ledger ${ledgerPath}`
      return err(msg)
    }
  }
  let round: number | undefined
  if (flags.round !== undefined) {
    if (flags.round === 'true') return err('collate --round must be a positive integer', 2)
    const parsed = parsePositiveInt(flags.round)
    if (parsed === null) return err('collate --round must be a positive integer', 2)
    round = parsed
  }
  let verificationReport: VerificationReport | undefined
  if (flags.verification !== undefined) {
    if (flags.verification === 'true' || flags.verification.trim() === '') {
      return err('collate --verification <path>', 2)
    }
    const verPath = resolveCallerPath(flags.verification, callerCwd)
    try {
      verificationReport = parseVerificationReport(readFileSync(verPath, 'utf8'), verPath)
    } catch (e) {
      const msg =
        e instanceof VerificationFormatError ? e.message : `cannot read verification report ${verPath}`
      return err(msg)
    }
  }
  // B4: 默认以调用方指定的 --script-root 或 --dir 作为可信脚本根,绝不盲信验证报告自报的 scriptRoot
  let trustedScriptRoot = dir
  if (flags['script-root'] !== undefined) {
    if (flags['script-root'] === 'true' || flags['script-root'].trim() === '') {
      return err('collate --script-root <root>', 2)
    }
    trustedScriptRoot = resolveCallerPath(flags['script-root'], callerCwd)
  }
  const inputRes = resolveInputDigestFlag('collate', flags, callerCwd)
  if (!inputRes.ok) return inputRes.result
  const inputDigest = inputRes.inputDigest
  const scientificGate =
    flags['scientific-gate'] !== undefined && flags['scientific-gate'] !== 'false'
  let minFamilies: number | undefined
  if (flags['min-families'] !== undefined) {
    if (flags['min-families'] === 'true') {
      return err('collate --min-families must be a positive integer', 2)
    }
    const parsed = parsePositiveInt(flags['min-families'])
    if (parsed === null) return err('collate --min-families must be a positive integer', 2)
    minFamilies = parsed
  }
  let maxResidual: number | undefined
  if (flags['max-residual'] !== undefined) {
    if (flags['max-residual'] === 'true') {
      return err('collate --max-residual must be a non-negative number', 2)
    }
    const parsed = parseNonNegativeNumber(flags['max-residual'])
    if (parsed === null) return err('collate --max-residual must be a non-negative number', 2)
    maxResidual = parsed
  }
  let names: string[]
  try {
    names = readdirSync(dir).filter((n) => /^reviews-.*\.json$/.test(n)).sort()
  } catch {
    return err(`cannot read dir: ${dir}`)
  }
  if (names.length === 0) return err(`no reviews-*.json in ${dir}`)
  // 默认宽松:坏文件跳过并在汇总卡/JSON/COLLATE 行标注缺席(一位评审员 429/超时/输出非 JSON
  // 不该让其余评审员的结果全部作废);--strict 恢复任一坏文件即 exit 1 的旧行为。
  const strict = flags.strict !== undefined
  const files: ReviewFile[] = []
  const sourceFiles = new Map<ReviewFile, string>()
  const skipped: SkippedReview[] = []
  for (const name of names) {
    let text: string
    try {
      text = readFileSync(join(dir, name), 'utf8')
    } catch {
      if (strict) return err(`cannot read ${join(dir, name)}`)
      skipped.push({ file: name, reason: 'cannot read file' })
      continue
    }
    try {
      const parsedFile = parseReviewFile(text, name)
      files.push(parsedFile)
      sourceFiles.set(parsedFile, name)
    } catch (e) {
      const msg = e instanceof ReviewFormatError ? e.message : String(e)
      if (strict) return err(msg)
      const prefix = `${name}: `
      skipped.push({ file: name, reason: msg.startsWith(prefix) ? msg.slice(prefix.length) : msg })
    }
  }
  if (files.length === 0) {
    const detail = skipped.map((s) => `${s.file}: ${s.reason}`).join('; ')
    return err(`no valid reviews-*.json in ${dir} (${detail})`)
  }
  const collateOpts: CollateOptions = { sourceFiles, scriptRoot: trustedScriptRoot }
  if (ledger !== undefined) collateOpts.ledger = ledger
  if (round !== undefined) collateOpts.round = round
  if (verificationReport !== undefined) collateOpts.verificationReport = verificationReport
  if (inputDigest !== undefined) collateOpts.inputDigest = inputDigest
  if (scientificGate) collateOpts.scientificGate = true
  if (minFamilies !== undefined) collateOpts.minFamilies = minFamilies
  if (maxResidual !== undefined) collateOpts.maxResidual = maxResidual
  const result = collateReviews(files, skipped, collateOpts)
  const md = renderSummaryMd(result)
  const mdPath =
    flags.out !== undefined && flags.out !== 'true'
      ? resolveCallerPath(flags.out, callerCwd)
      : join(dir, 'review-summary.md')
  const jsonPath = mdPath.endsWith('.md') ? `${mdPath.slice(0, -3)}.json` : `${mdPath}.json`
  try {
    writeFileSync(mdPath, md)
    writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return err(`cannot write ${mdPath}: ${msg}`)
  }
  const stdout = `${JSON.stringify({ ...result, mdPath, jsonPath }, null, 2)}\n${collateLine(result)}\n`
  return { exitCode: 0, stdout, stderr: '' }
}

/** 库入口:解析 argv 并返回结果,不直接 process.exit(供测试与 probe 直接调用)。 */
export function runOcReviewCli(argv: string[], opts?: OcReviewCliOptions): OcReviewCliResult {
  const parsed = extractLeadingCallerCwd(argv, opts?.callerCwd)
  const [cmd, ...rest] = parsed.argv
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    return { exitCode: 0, stdout: `${USAGE}\n`, stderr: '' }
  }
  switch (cmd) {
    case 'schema':
      return { exitCode: 0, stdout: `${REVIEW_JSON_SCHEMA}\n`, stderr: '' }
    case 'verify':
      return runVerify(rest, parsed.callerCwd)
    case 'collate':
      return runCollate(rest, parsed.callerCwd)
    case 'ledger':
      return runLedger(rest, parsed.callerCwd)
    default: {
      // 不写 `cmd ?? ''`:覆盖率契约用 AST 扫 `cmd` 的二元表达式,会把 '' 误当子命令。
      const shown = typeof cmd === 'string' ? cmd : ''
      return err(`unknown command '${shown}'\n${USAGE}`, 2)
    }
  }
}

function isDirectExecution(): boolean {
  const argv1 = process.argv[1]
  if (!argv1) return false
  return resolve(argv1) === fileURLToPath(import.meta.url)
}

if (isDirectExecution()) {
  const r = runOcReviewCli(process.argv.slice(2))
  if (r.stdout) process.stdout.write(r.stdout)
  if (r.stderr) process.stderr.write(r.stderr)
  process.exit(r.exitCode)
}
