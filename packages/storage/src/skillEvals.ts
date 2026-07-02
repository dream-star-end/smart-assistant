/**
 * Skill evals — 技能评测用例文件(skill 目录内 `evals/evals.json`)的 schema 与
 * 解析/序列化单一权威。对齐 Anthropic skill-creator 的约定:用例驱动验收,
 * 断言化打分;文件本身随技能走(草稿/合并/市场 bundle 同一格式)。
 *
 * 设计约束:
 *  - 纯函数,无 I/O — 读写由 SkillStore(saveAuxFile/view(name,'evals/evals.json'))承担。
 *  - 容量上限收紧(用例≤5/断言≤8):评测跑真模型消耗用户积分,上限即成本上限。
 *  - autoRegression 是 P3 自动回归的 opt-in 开关,默认缺省=关闭 —— 任何自动消耗
 *    积分的行为都必须用户显式开启(boss 红线:不静默扣费)。
 */

export const MAX_EVAL_CASES = 5
export const MAX_EVAL_ASSERTIONS = 8
export const MAX_EVAL_PROMPT_CHARS = 4000
export const MAX_EVAL_ASSERTION_CHARS = 500
export const MAX_EVAL_EXPECTED_CHARS = 4000

export interface SkillEvalCase {
  /** 稳定 id(小写字母数字连字符),结果与历史按它对齐。 */
  id: string
  /** 交给被测会话执行的任务描述(真实措辞,含必要上下文)。 */
  prompt: string
  /** 可判定的验收断言(每条独立判 PASS/FAIL,PASS 须给证据)。 */
  assertions: string[]
  /** 参考期望输出(给 grader 的软参照,可缺省)。 */
  expectedOutput?: string
}

export interface SkillEvalsFile {
  version: 1
  cases: SkillEvalCase[]
  /** P3 每日自动回归 opt-in(消耗积分,默认关闭;UI 显式开启并告知成本)。 */
  autoRegression?: boolean
}

const CASE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

export type ParseEvalsResult =
  | { ok: true; file: SkillEvalsFile }
  | { ok: false; errors: string[] }

/** 解析 + 严格校验 evals.json 文本。宽进(容忍多余空白)严出(结构必须合法)。 */
export function parseSkillEvalsJson(text: string): ParseEvalsResult {
  const errors: string[] = []
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    return { ok: false, errors: [`evals.json 不是合法 JSON: ${(e as Error).message}`] }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['evals.json 须为对象'] }
  }
  const o = raw as Record<string, unknown>
  if (o.version !== 1) errors.push('version 须为 1')
  if (!Array.isArray(o.cases)) {
    errors.push('cases 须为数组')
    return { ok: false, errors }
  }
  if (o.cases.length === 0) errors.push('cases 不能为空(至少 1 个用例)')
  if (o.cases.length > MAX_EVAL_CASES) errors.push(`cases 最多 ${MAX_EVAL_CASES} 个(评测消耗积分,上限即成本上限)`)
  const cases: SkillEvalCase[] = []
  const seen = new Set<string>()
  for (const [i, c] of (o.cases as unknown[]).entries()) {
    const at = `cases[${i}]`
    if (!c || typeof c !== 'object' || Array.isArray(c)) {
      errors.push(`${at} 须为对象`)
      continue
    }
    const cc = c as Record<string, unknown>
    const id = typeof cc.id === 'string' ? cc.id : ''
    if (!CASE_ID_RE.test(id)) errors.push(`${at}.id 须为小写字母/数字/连字符(1-64)`)
    else if (seen.has(id)) errors.push(`${at}.id "${id}" 重复`)
    else seen.add(id)
    const prompt = typeof cc.prompt === 'string' ? cc.prompt.trim() : ''
    if (!prompt) errors.push(`${at}.prompt 必填`)
    if (prompt.length > MAX_EVAL_PROMPT_CHARS) errors.push(`${at}.prompt 超长(≤${MAX_EVAL_PROMPT_CHARS})`)
    const assertions: string[] = []
    if (!Array.isArray(cc.assertions) || cc.assertions.length === 0) {
      errors.push(`${at}.assertions 必填且非空`)
    } else {
      if (cc.assertions.length > MAX_EVAL_ASSERTIONS)
        errors.push(`${at}.assertions 最多 ${MAX_EVAL_ASSERTIONS} 条`)
      for (const a of cc.assertions) {
        const t = typeof a === 'string' ? a.trim() : ''
        if (!t) {
          errors.push(`${at}.assertions 含空条目`)
          continue
        }
        if (t.length > MAX_EVAL_ASSERTION_CHARS)
          errors.push(`${at}.assertions 有条目超长(≤${MAX_EVAL_ASSERTION_CHARS})`)
        assertions.push(t)
      }
    }
    let expectedOutput: string | undefined
    if (cc.expectedOutput !== undefined) {
      if (typeof cc.expectedOutput !== 'string') errors.push(`${at}.expectedOutput 须为字符串`)
      else if (cc.expectedOutput.length > MAX_EVAL_EXPECTED_CHARS)
        errors.push(`${at}.expectedOutput 超长(≤${MAX_EVAL_EXPECTED_CHARS})`)
      else expectedOutput = cc.expectedOutput
    }
    cases.push({ id, prompt, assertions, ...(expectedOutput ? { expectedOutput } : {}) })
  }
  let autoRegression: boolean | undefined
  if (o.autoRegression !== undefined) {
    if (typeof o.autoRegression !== 'boolean') errors.push('autoRegression 须为布尔')
    else autoRegression = o.autoRegression
  }
  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    file: { version: 1, cases, ...(autoRegression !== undefined ? { autoRegression } : {}) },
  }
}

/** 规范序列化(稳定字段顺序,2 空格缩进,尾随换行)。 */
export function serializeSkillEvals(file: SkillEvalsFile): string {
  const out = {
    version: 1 as const,
    cases: file.cases.map((c) => ({
      id: c.id,
      prompt: c.prompt,
      assertions: c.assertions,
      ...(c.expectedOutput ? { expectedOutput: c.expectedOutput } : {}),
    })),
    ...(file.autoRegression !== undefined ? { autoRegression: file.autoRegression } : {}),
  }
  return `${JSON.stringify(out, null, 2)}\n`
}
