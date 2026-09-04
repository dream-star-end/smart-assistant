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
 * 聚合策略(R7 设计 §4.2):location 归一(章节/图/表/行号锚点)+ severity 档匹配的
 * 粗聚合;宁可漏聚(分别列出)不误聚(把不同问题合并)——分歧呈现是本功能的价值核心。
 * 无网络、无 DB;schema 为 CLI 本地定义,不进 protocol 包。
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const TOOL = 'oc-review'

export const SEVERITIES = ['blocker', 'major', 'minor', 'suggestion'] as const
export type ReviewSeverity = (typeof SEVERITIES)[number]

export const VERDICTS = ['accept', 'minor', 'major', 'reject'] as const
export type ReviewVerdict = (typeof VERDICTS)[number]

export type ReviewFinding = {
  location: string
  severity: ReviewSeverity
  issue: string
  suggestion?: string
}

export type ReviewFile = {
  reviewer: { model: string; role?: string }
  verdict: ReviewVerdict
  findings: ReviewFinding[]
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
        "model": { "type": "string", "minLength": 1, "description": "评审员模型 slug,如 kimi-k3" },
        "role": { "type": "string", "description": "评审员角色,如 方法学审查" }
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
          "issue": { "type": "string", "minLength": 1 },
          "suggestion": { "type": "string" }
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

/** 严格校验单份评审 JSON;任何缺字段/坏枚举/坏 JSON 都抛 ReviewFormatError(fail-loud)。 */
export function parseReviewFile(text: string, label: string): ReviewFile {
  const bad = (msg: string): never => {
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
    const finding: ReviewFinding = { location: f.location, severity: f.severity, issue: f.issue }
    if (f.suggestion !== undefined) finding.suggestion = f.suggestion
    return finding
  })
  const file: ReviewFile = { reviewer: { model: rec.model.trim() }, verdict: obj.verdict, findings }
  if (rec.role !== undefined) file.reviewer.role = rec.role
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

export type TaggedFinding = ReviewFinding & { reviewer: string }

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

export type CollateResult = {
  reviewers: ReviewerSummary[]
  verdictCounts: Record<ReviewVerdict, number>
  totals: Record<ReviewSeverity, number>
  consensus: ConsensusEntry[]
  divergent: DivergentEntry[]
  sole: SoleEntry[]
}

function emptySeverityCounts(): Record<ReviewSeverity, number> {
  return { blocker: 0, major: 0, minor: 0, suggestion: 0 }
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
 */
export function collateReviews(files: ReviewFile[]): CollateResult {
  const sorted = [...files].sort((a, b) => a.reviewer.model.localeCompare(b.reviewer.model))
  const totals = emptySeverityCounts()
  const verdictCounts = emptyVerdictCounts()
  const reviewers: ReviewerSummary[] = []
  const buckets = new Map<string, TaggedFinding[]>()
  for (const file of sorted) {
    const counts = emptySeverityCounts()
    verdictCounts[file.verdict] += 1
    for (const finding of file.findings) {
      counts[finding.severity] += 1
      totals[finding.severity] += 1
      const tagged: TaggedFinding = { ...finding, reviewer: file.reviewer.model }
      for (const anchor of locationAnchors(finding.location)) {
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

  return { reviewers, verdictCounts, totals, consensus, divergent, sole }
}

export function collateLine(result: CollateResult): string {
  const t = result.totals
  return `COLLATE: ${t.blocker}/${t.major}/${t.minor}/${t.suggestion}`
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** 渲染 Markdown 汇总卡(确定性:同一输入字节级相同输出)。 */
export function renderSummaryMd(result: CollateResult): string {
  const lines: string[] = []
  lines.push('# 多模型评审汇总', '')
  lines.push(`评审员 ${result.reviewers.length} 位:`)
  for (const r of result.reviewers) {
    const role = r.role === undefined ? '' : `(${r.role})`
    lines.push(
      `- \`${r.model}\`${role} verdict=${r.verdict},findings: ${SEVERITIES.map((s) => `${s}=${r.counts[s]}`).join(' ')}`,
    )
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
      lines.push(`- **${f.reviewer}** ${oneLine(f.location)}: ${oneLine(f.issue)}`)
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
        lines.push(`- [${side.severity}] **${f.reviewer}** ${oneLine(f.location)}: ${oneLine(f.issue)}`)
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
      lines.push(`- **${f.reviewer}** ${oneLine(f.location)}: ${oneLine(f.issue)}`)
      if (f.suggestion !== undefined) lines.push(`  - 建议: ${oneLine(f.suggestion)}`)
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
  lines.push('')
  return lines.join('\n')
}

export type OcReviewCliResult = { exitCode: number; stdout: string; stderr: string }

const USAGE = [
  'usage: oc-review schema',
  '       oc-review collate --dir <dir> [--out <summary.md>]',
  '  schema   打印评审员 JSON schema(贴进委派 prompt)',
  '  collate  读 <dir>/reviews-*.json → 写 review-summary.md/.json,stdout 末行 COLLATE',
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

function runCollate(rest: string[]): OcReviewCliResult {
  const flags = parseSimpleFlags(rest)
  const dir = flags.dir
  if (dir === undefined || dir === 'true') return err('collate --dir <dir>', 2)
  let names: string[]
  try {
    names = readdirSync(dir).filter((n) => /^reviews-.*\.json$/.test(n)).sort()
  } catch {
    return err(`cannot read dir: ${dir}`)
  }
  if (names.length === 0) return err(`no reviews-*.json in ${dir}`)
  const files: ReviewFile[] = []
  for (const name of names) {
    let text: string
    try {
      text = readFileSync(join(dir, name), 'utf8')
    } catch {
      return err(`cannot read ${join(dir, name)}`)
    }
    try {
      files.push(parseReviewFile(text, name))
    } catch (e) {
      const msg = e instanceof ReviewFormatError ? e.message : String(e)
      return err(msg)
    }
  }
  const result = collateReviews(files)
  const md = renderSummaryMd(result)
  const mdPath = flags.out !== undefined && flags.out !== 'true' ? flags.out : join(dir, 'review-summary.md')
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
export function runOcReviewCli(argv: string[]): OcReviewCliResult {
  const [cmd, ...rest] = argv
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    return { exitCode: 0, stdout: `${USAGE}\n`, stderr: '' }
  }
  switch (cmd) {
    case 'schema':
      return { exitCode: 0, stdout: `${REVIEW_JSON_SCHEMA}\n`, stderr: '' }
    case 'collate':
      return runCollate(rest)
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
