// Skill-eval 用例「AI 生成」的纯逻辑层:素材裁剪 + prompt 构造 + 宽容 JSON 解析 +
// id 归一化 + 提示语。无 I/O、无 session/WS 依赖,便于单测。
//
// 分工:执行编排(起隔离 turn / 落盘 / 计费)在 server.ts(_runSkillEvalGen);素材的
// 实际 DB 读取(sessionsDb.searchSessions / loadSessionTurns)也在 server.ts —— 本模块
// 只把读来的原始 turns 裁成 prompt 素材,并把模型输出解析/归一化/过格式权威校验。
//
// 格式权威唯一:生成结果最终必须过 parseSkillEvalsJson(与手写用例、PUT 保存同一校验源),
// 坏格式一律判失败带原因,绝不放行半成品用例。

import {
  MAX_EVAL_ASSERTIONS,
  MAX_EVAL_CASES,
  parseSkillEvalsJson,
  type SkillEvalCase,
} from '@openclaude/storage'

/** 素材上限(成本/prompt 体积双约束)。 */
export const MAX_SESSION_EXCERPTS = 5
export const SESSION_EXCERPT_MAX_CHARS = 1500
/** 只取近 30 天的真实使用会话(有明确时间戳时才据此过滤)。 */
export const SESSION_RECENCY_MS = 30 * 24 * 60 * 60 * 1000
/** 采集时排除评测/训练/生成自身产生的会话 —— 那不是"真实使用"。 */
export const EXCLUDED_SESSION_CHANNELS: ReadonlySet<string> = new Set([
  'skill-eval',
  'skill-train',
  'skill-eval-gen',
])

const SKILL_MD_MAX_CHARS = 6000

// ── 素材:会话检索 query ───────────────────────────────────────────────────

/**
 * 从技能名 + 描述提炼 FTS 关键词,` OR ` 连接扩大召回(unicode61 对 CJK 分词弱,
 * 故原始名/短语一并塞入兜底)。返回空串 = 无可用关键词(调用方跳过检索)。
 * 大小写:关键词统一小写(unicode61 remove_diacritics 亦小写化),operator OR 保持大写。
 */
export function buildSessionSearchQuery(name: string, description: string): string {
  const operators = new Set(['or', 'and', 'not', 'near'])
  const seen = new Set<string>()
  const kws: string[] = []
  const push = (s: string): void => {
    const t = s.trim().toLowerCase()
    if (t.length < 2) return
    if (operators.has(t)) return // 别把关键词误当 FTS 运算符
    if (seen.has(t)) return
    seen.add(t)
    kws.push(t)
  }
  push(name)
  for (const p of name.split(/[-_]/)) push(p)
  for (const p of description.split(/[\s,，、。;；:：!！?？()（）/\\|]+/)) push(p)
  return kws.slice(0, 10).join(' OR ')
}

export interface UsageSessionHit {
  sessionId: string
  channel: string
  title: string
  lastAt: number
}

/**
 * 从 FTS 命中里筛出"真实使用会话":近 30 天(仅在有明确 lastAt 时才据此过滤,0=未知不排)
 * + 排除评测/训练/生成自身通道,按命中顺序取至多 max 个。纯函数,便于单测。
 */
export function selectUsageSessionHits<T extends UsageSessionHit>(
  hits: readonly T[],
  now: number,
  max: number = MAX_SESSION_EXCERPTS,
): T[] {
  const cutoff = now - SESSION_RECENCY_MS
  const out: T[] = []
  for (const h of hits) {
    if (out.length >= max) break
    if (h.lastAt > 0 && h.lastAt < cutoff) continue
    if (EXCLUDED_SESSION_CHANNELS.has(h.channel)) continue
    out.push(h)
  }
  return out
}

// ── 素材:单会话摘录 ───────────────────────────────────────────────────────

/**
 * 把一个会话的 turns 裁成 ≤maxChars 的可读摘录。turns 由调用方传入(loadSessionTurns
 * 按 turn_idx 倒序,即最近在前);逐条 `角色: 内容` 拼接,超额尾条截断。
 */
export function buildSessionExcerpt(
  turns: ReadonlyArray<{ role: string; content: string }>,
  maxChars: number = SESSION_EXCERPT_MAX_CHARS,
): string {
  const parts: string[] = []
  let len = 0
  for (const t of turns) {
    const content = (t.content ?? '').replace(/\s+/g, ' ').trim()
    if (!content) continue
    const label = t.role === 'user' ? '用户' : '助手'
    const line = `${label}: ${content}`
    if (len + line.length > maxChars) {
      const remain = maxChars - len
      if (remain > 40) parts.push(`${line.slice(0, remain)}…`)
      break
    }
    parts.push(line)
    len += line.length + 1
  }
  return parts.join('\n')
}

// ── prompt 构造 ────────────────────────────────────────────────────────────

export interface GenSessionExcerpt {
  title: string
  text: string
}

export interface GenMaterials {
  skillName: string
  description: string
  /** 技能 SKILL.md 全文(过长会截断)。 */
  skillMd: string
  /** 技能已有的用例(用于"补充不重复"约束)。 */
  existingCases: readonly SkillEvalCase[]
  /** 真实使用会话摘录(可为空 → prompt 里说明按声明场景推导)。 */
  excerpts: readonly GenSessionExcerpt[]
}

/** 生成 turn 的 prompt:据技能内容 + 真实使用摘录起草 3-5 个可判定用例,严格 JSON 输出。 */
export function buildGeneratePrompt(m: GenMaterials): string {
  const existing = m.existingCases.length
    ? `\n## 该技能已有的评测用例(务必生成与这些**场景不重复**的新用例)\n${m.existingCases
        .map((c, i) => `${i + 1}. ${truncate(c.prompt, 300)}`)
        .join('\n')}\n`
    : ''
  const usage = m.excerpts.length
    ? `\n## 该技能的真实使用会话摘录(据此提炼贴近真实的任务)\n${m.excerpts
        .map(
          (e, i) =>
            `### 摘录 ${i + 1}${e.title ? `(${truncate(e.title, 60)})` : ''}\n${e.text}`,
        )
        .join('\n\n')}\n`
    : '\n## 真实使用记录\n(无真实使用记录 —— 请从技能声明的适用场景推导有代表性的任务。)\n'

  return `你是评测用例设计专家。请为下面这个技能起草评测用例(eval cases):用例用来验收"启用该技能后模型是否把这类任务做对"。

## 技能:${m.skillName}
${m.description ? `描述:${m.description}\n` : ''}
## 技能内容(SKILL.md)
${truncate(m.skillMd, SKILL_MD_MAX_CHARS)}
${existing}${usage}
## 你的任务
生成 3-5 个评测用例。每个用例:
- prompt:一句到一段的真实任务措辞(像用户真会这么说),必要时含最小上下文;不要提"技能/评测"字样。
- assertions:2-6 条可**客观判定**的验收断言,每条能独立判 PASS/FAIL,且 PASS 必须能在输出里找到具体证据;避免"看起来不错/质量高"这类主观词。
- expectedOutput(可选):简短的参考答案要点,作为软参照。
覆盖不同场景/难度,彼此不重复${m.existingCases.length ? ',且与上面"已有用例"不重复' : ''}。

## 输出格式(严格 JSON,只输出这一个对象,不要任何其它文字或围栏)
{"cases":[{"prompt":"…","assertions":["断言1","断言2"],"expectedOutput":"…"}]}
(id 由系统分配,你无需提供;expectedOutput 可省略。)`
}

// ── 模型输出:宽容解析 + id 归一化 + 过格式权威 ─────────────────────────────

export interface RawGeneratedCase {
  id?: unknown
  prompt?: unknown
  assertions?: unknown
  expectedOutput?: unknown
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** 从文本抓第一个平衡闭合的 open..close 片段(字符串内的括号不计)。对齐 parseGraderJson。 */
function extractFirstBalanced(text: string, open: string, close: string): string | null {
  const start = text.indexOf(open)
  if (start < 0) return null
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
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
    if (ch === open) depth++
    else if (ch === close) {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

/**
 * 宽容解析生成 turn 输出:剥 ```json 围栏/前后杂文,优先取 `{cases:[…]}`,退化支持
 * 裸数组 `[…]`。返回原始 case 对象数组(未归一化);无法解析 → null。
 */
export function parseGeneratedCasesJson(text: string): RawGeneratedCase[] | null {
  const cleaned = text.replace(/```json\s*/gi, '').replace(/```/g, '')
  const objText = extractFirstBalanced(cleaned, '{', '}')
  if (objText) {
    try {
      const obj = JSON.parse(objText) as unknown
      if (isPlainObject(obj) && Array.isArray(obj.cases)) {
        return (obj.cases as unknown[]).filter(isPlainObject) as RawGeneratedCase[]
      }
    } catch {
      /* fall through 到裸数组尝试 */
    }
  }
  const arrText = extractFirstBalanced(cleaned, '[', ']')
  if (arrText) {
    try {
      const arr = JSON.parse(arrText) as unknown
      if (Array.isArray(arr)) return arr.filter(isPlainObject) as RawGeneratedCase[]
    } catch {
      /* ignore */
    }
  }
  return null
}

/**
 * 归一化生成用例:服务端强制分配 `gen-1..n` 的 id(跳过与现有用例/已分配冲突的),
 * 丢弃缺 prompt / 缺断言的条目,断言/用例数封顶。**忽略模型自带 id**(避免与现有冲突)。
 */
export function normalizeGeneratedCases(
  raw: readonly RawGeneratedCase[],
  existingIds: readonly string[],
): SkillEvalCase[] {
  const used = new Set(existingIds)
  const out: SkillEvalCase[] = []
  let n = 0
  for (const rc of raw) {
    if (out.length >= MAX_EVAL_CASES) break
    const prompt = typeof rc.prompt === 'string' ? rc.prompt.trim() : ''
    if (!prompt) continue
    const assertions = Array.isArray(rc.assertions)
      ? (rc.assertions as unknown[])
          .map((a) => (typeof a === 'string' ? a.trim() : ''))
          .filter((a) => a.length > 0)
          .slice(0, MAX_EVAL_ASSERTIONS)
      : []
    if (assertions.length === 0) continue
    let id = ''
    do {
      n++
      id = `gen-${n}`
    } while (used.has(id))
    used.add(id)
    const expected =
      typeof rc.expectedOutput === 'string' && rc.expectedOutput.trim()
        ? rc.expectedOutput
        : undefined
    out.push({ id, prompt, assertions, ...(expected ? { expectedOutput: expected } : {}) })
  }
  return out
}

/**
 * 生成 turn 输出 → 最终草稿用例的单一入口:宽容解析 → id 归一化 → **过 parseSkillEvalsJson
 * 格式权威**。任一环节坏掉即返回失败原因(供 job failed 的 note)。返回的 cases 只含本次
 * 新生成的草稿(不含现有用例;合并/去重由前端编辑器 + 保存时的 PUT 校验负责)。
 */
export function finalizeGeneratedCases(
  modelText: string,
  existingCases: readonly SkillEvalCase[],
): { ok: true; cases: SkillEvalCase[] } | { ok: false; error: string } {
  const raw = parseGeneratedCasesJson(modelText)
  if (!raw || raw.length === 0) {
    return { ok: false, error: '生成结果无法解析为用例 JSON(需 {"cases":[…]} 结构)' }
  }
  const normalized = normalizeGeneratedCases(
    raw,
    existingCases.map((c) => c.id),
  )
  if (normalized.length === 0) {
    return { ok: false, error: '生成结果中没有可用用例(条目缺 prompt 或断言)' }
  }
  const parsed = parseSkillEvalsJson(JSON.stringify({ version: 1, cases: normalized }))
  if (!parsed.ok) {
    return { ok: false, error: `生成用例未通过校验: ${parsed.errors.join('; ')}` }
  }
  return { ok: true, cases: parsed.file.cases }
}

// ── 成功提示语(note)──────────────────────────────────────────────────────

/** 生成成功后给用户的提示条文案(素材来源 + 合并上限提醒)。 */
export function buildGenerationNote(input: {
  excerptCount: number
  existingCount: number
  generatedCount: number
}): string {
  const src =
    input.excerptCount > 0
      ? `已参考 ${input.excerptCount} 段真实使用记录起草 ${input.generatedCount} 个草稿用例。`
      : `未找到该技能的真实使用记录,已按技能声明的场景推导起草 ${input.generatedCount} 个草稿用例。`
  const merge =
    input.existingCount > 0 && input.existingCount + input.generatedCount > MAX_EVAL_CASES
      ? `已有 ${input.existingCount} 个用例,与草稿合计超过上限 ${MAX_EVAL_CASES},保存时请酌情删减。`
      : ''
  return [src, '请审阅、修改后保存。', merge].filter(Boolean).join(' ')
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}\n…(截断)` : s
}
