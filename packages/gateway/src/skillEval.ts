// Skill eval engine — pure prompt/parse/benchmark logic (no I/O), unit-testable.
//
// 一次评测 run:对目标技能的每个用例,在**干净的隔离会话**里各跑若干 arm:
//   - 'with'    技能可见(现版)
//   - 'without' 技能被隐藏(基线:模型裸跑)
//   - 'draft'   草稿版技能替换现版(SkillOpt 评测门)
// 然后由 grader(锁 pro 模型)按断言逐条判定 PASS/FAIL(PASS 须给证据),
// draft 模式附带匿名 A/B 盲测偏好。数值口径:pass rate = 断言通过数/断言总数。
//
// 成本纪律(boss 红线):评测消耗用户积分 —— 上限即成本上限(用例≤5),每 arm 每用例
// 恰一个会话一个 turn;所有用量逐 turn 累计进 run.usage,前端据公开费率折算并展示。

import type { SkillEvalCase } from '@openclaude/storage'

export type SkillEvalArm = 'with' | 'without' | 'draft'

export interface SkillEvalUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  turns: number
}

export const emptyUsage = (): SkillEvalUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  turns: 0,
})

export function addUsage(
  u: SkillEvalUsage,
  meta:
    | {
        inputTokens?: number
        outputTokens?: number
        cacheReadTokens?: number
        cacheCreationTokens?: number
      }
    | undefined,
): void {
  if (!meta) return
  u.inputTokens += meta.inputTokens ?? 0
  u.outputTokens += meta.outputTokens ?? 0
  u.cacheReadTokens += meta.cacheReadTokens ?? 0
  u.cacheCreationTokens += meta.cacheCreationTokens ?? 0
  u.turns += 1
}

export interface GradedAssertion {
  text: string
  passed: boolean
  /** PASS 的具体证据 / FAIL 的原因(grader 必填,防 benefit-of-the-doubt)。 */
  evidence: string
}

export interface SkillEvalCaseResult {
  caseId: string
  arm: SkillEvalArm
  /** 被测会话的最终文本(截断存档)。 */
  output: string
  /** 该 arm 会话的 token 用量。 */
  usage: SkillEvalUsage
  assertions: GradedAssertion[]
  /** 执行/评分失败时置错误,该 case-arm 不计入 pass rate。 */
  error?: string
}

export interface SkillEvalBenchmark {
  /** arm → 断言通过率(0-1,仅统计无 error 的 case-arm)。 */
  passRate: Partial<Record<SkillEvalArm, number>>
  /** arm → 断言计数 {passed,total}。 */
  counts: Partial<Record<SkillEvalArm, { passed: number; total: number }>>
  /** arm → 平均每用例输出 tokens(成本对比)。 */
  avgOutputTokens: Partial<Record<SkillEvalArm, number>>
  /** draft 模式:盲测偏好计票(per case one vote)。 */
  preference?: { draft: number; current: number; tie: number }
  /** 一句话结论(前端主标题)。 */
  verdict: string
}

// ── 被测会话 prompt ─────────────────────────────────────────────────────────

/** 用例任务原样下发,只加最小执行纪律 —— 不提"评测/技能",防被测会话迎合打分。 */
export function buildEvalCasePrompt(c: SkillEvalCase): string {
  return `${c.prompt.trim()}

(直接完成上述任务并给出最终结果;不要询问确认。)`
}

// ── grader ──────────────────────────────────────────────────────────────────

export interface GraderArmInput {
  /** 匿名标签(A/B/C…),与 arm 的映射由调用方持有,grader 不可见。 */
  label: string
  output: string
}

/**
 * 每用例一个 grader turn:对每个匿名输出逐断言判定;≥2 个输出时附盲测偏好。
 * 输出严格 JSON(容错解析在 parseGraderJson)。
 */
export function buildGraderPrompt(
  c: SkillEvalCase,
  arms: GraderArmInput[],
  opts: { wantPreference: boolean },
): string {
  const outputs = arms
    .map((a) => `### 输出 ${a.label}\n\n${truncate(a.output, 6000) || '(空输出)'}`)
    .join('\n\n')
  const pref = opts.wantPreference
    ? `,\n  "preference": "A" | "B" | "tie"  // 整体质量盲测:哪个输出更好(组织/正确性/可用性)`
    : ''
  return `你是严格的评测打分员。针对下面的任务,有 ${arms.length} 份匿名输出。逐条断言判定每份输出 PASS/FAIL。

规则(必须遵守):
- PASS 必须引用输出中的**具体证据**(短引文);给不出证据就判 FAIL。不做善意推定。
- FAIL 写明缺了什么/错在哪。
- 只依据输出本身判定,不脑补"它可能做了"。
- 只输出一个 JSON 对象,不要任何其它文字。

## 任务
${truncate(c.prompt, 3000)}
${c.expectedOutput ? `\n## 参考期望(软参照,不是逐字标准)\n${truncate(c.expectedOutput, 2000)}\n` : ''}
## 断言
${c.assertions.map((a, i) => `${i + 1}. ${a}`).join('\n')}

## 匿名输出
${outputs}

## 输出格式(严格 JSON)
{
  "grades": {
${arms.map((a) => `    "${a.label}": [ { "assertion": 1, "passed": true, "evidence": "…" }, … ]`).join(',\n')}
  }${pref}
}`
}

export interface ParsedGrades {
  /** label → 按断言序号(1-based)对齐的判定。 */
  grades: Record<string, Array<{ assertion: number; passed: boolean; evidence: string }>>
  preference?: 'A' | 'B' | 'tie'
}

/** 容错解析 grader 输出:剥 \`\`\`json 围栏/前后杂文,抓第一个平衡的 {...}。 */
export function parseGraderJson(text: string): ParsedGrades | null {
  const cleaned = text.replace(/```json\s*/gi, '').replace(/```/g, '')
  const start = cleaned.indexOf('{')
  if (start < 0) return null
  // 从第一个 { 起找平衡闭合(简单深度计数,足够应付 grader 输出)。
  let depth = 0
  let end = -1
  let inStr = false
  let esc = false
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i]
    if (esc) {
      esc = false
      continue
    }
    if (ch === '\\') {
      esc = true
      continue
    }
    if (ch === '"') inStr = !inStr
    if (inStr) continue
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  if (end < 0) return null
  let raw: unknown
  try {
    raw = JSON.parse(cleaned.slice(start, end + 1))
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const grades = o.grades
  if (!grades || typeof grades !== 'object' || Array.isArray(grades)) return null
  const out: ParsedGrades = { grades: {} }
  for (const [label, arr] of Object.entries(grades as Record<string, unknown>)) {
    if (!Array.isArray(arr)) return null
    out.grades[label] = arr
      .filter((g): g is Record<string, unknown> => !!g && typeof g === 'object')
      .map((g) => ({
        assertion: Number(g.assertion) || 0,
        passed: g.passed === true,
        evidence: typeof g.evidence === 'string' ? g.evidence.slice(0, 800) : '',
      }))
  }
  if (o.preference === 'A' || o.preference === 'B' || o.preference === 'tie') {
    out.preference = o.preference
  }
  return out
}

/** grader 的 label 判定 → 按用例断言文本对齐的 GradedAssertion[](缺失序号按 FAIL 补齐)。 */
export function gradesToAssertions(
  c: SkillEvalCase,
  graded: Array<{ assertion: number; passed: boolean; evidence: string }> | undefined,
): GradedAssertion[] {
  return c.assertions.map((text, idx) => {
    const g = graded?.find((x) => x.assertion === idx + 1)
    if (!g) return { text, passed: false, evidence: '(grader 未给出该断言的判定,按 FAIL 计)' }
    // PASS 必须带证据 —— 无证据的 PASS 一律降级为 FAIL(反 benefit-of-the-doubt)。
    if (g.passed && !g.evidence.trim()) {
      return { text, passed: false, evidence: '(判 PASS 但未附证据,按 FAIL 计)' }
    }
    return { text, passed: g.passed, evidence: g.evidence }
  })
}

// ── benchmark ───────────────────────────────────────────────────────────────

export function computeBenchmark(
  results: SkillEvalCaseResult[],
  opts: { draftMode: boolean; preferences?: Array<'draft' | 'current' | 'tie'> },
): SkillEvalBenchmark {
  const counts: SkillEvalBenchmark['counts'] = {}
  const outTok: Partial<Record<SkillEvalArm, { sum: number; n: number }>> = {}
  for (const r of results) {
    if (r.error) continue
    const c = (counts[r.arm] ??= { passed: 0, total: 0 })
    for (const a of r.assertions) {
      c.total++
      if (a.passed) c.passed++
    }
    const t = (outTok[r.arm] ??= { sum: 0, n: 0 })
    t.sum += r.usage.outputTokens
    t.n++
  }
  const passRate: SkillEvalBenchmark['passRate'] = {}
  for (const [arm, c] of Object.entries(counts) as Array<
    [SkillEvalArm, { passed: number; total: number }]
  >) {
    passRate[arm] = c.total > 0 ? c.passed / c.total : 0
  }
  const avgOutputTokens: SkillEvalBenchmark['avgOutputTokens'] = {}
  for (const [arm, t] of Object.entries(outTok) as Array<
    [SkillEvalArm, { sum: number; n: number }]
  >) {
    avgOutputTokens[arm] = t.n > 0 ? Math.round(t.sum / t.n) : 0
  }

  let preference: SkillEvalBenchmark['preference']
  if (opts.draftMode) {
    preference = { draft: 0, current: 0, tie: 0 }
    for (const p of opts.preferences ?? []) preference[p]++
  }

  const pct = (x: number | undefined) => `${Math.round((x ?? 0) * 100)}%`
  let verdict: string
  if (opts.draftMode) {
    const d = passRate.draft
    const w = passRate.with
    if (d === undefined || w === undefined) verdict = '评测未完成,无法对比'
    else if (d > w) verdict = `草稿更好:断言通过率 ${pct(w)} → ${pct(d)}`
    else if (d < w) verdict = `草稿更差:断言通过率 ${pct(w)} → ${pct(d)},不建议合并`
    else {
      const p = preference
      if (p && p.draft > p.current) verdict = `通过率持平(${pct(d)}),盲测更偏好草稿`
      else if (p && p.current > p.draft) verdict = `通过率持平(${pct(d)}),盲测更偏好现版`
      else verdict = `通过率持平(${pct(d)}),两版相当`
    }
  } else {
    const w = passRate.with
    const wo = passRate.without
    if (w === undefined || wo === undefined) verdict = '评测未完成'
    else if (w > wo) verdict = `技能有效:通过率 ${pct(wo)}(无技能)→ ${pct(w)}(有技能)`
    else if (w < wo) verdict = `注意:有技能反而更差(${pct(wo)} → ${pct(w)}),建议精简或重写`
    else verdict = `技能未带来可测提升(均 ${pct(w)}),模型可能已内化该能力`
  }
  return { passRate, counts, avgOutputTokens, ...(preference ? { preference } : {}), verdict }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}\n…(截断)` : s
}
