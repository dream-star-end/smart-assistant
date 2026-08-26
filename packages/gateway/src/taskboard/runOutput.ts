// 巡检 run 产出整理：评论要结论、失败要归并。
//
// 设计意图:
//   面板是人看的唯一入口。agent 常把「我先读规则…」写在开头,真正交付在文末
//   或 generated/ 里。评论必须是结论,不能是过程流水。
//   上游连错时同一句 API Error 会被无分隔拼接成上千行,截成 400 字后只剩
//   `API …`,人看不出发生了什么。评论侧归并重复,run.outputMd 保留原文。

export const SUMMARY_MAX = 1500
export const COMMENT_MAX = 4000
export const UNSTRUCTURED_TAIL_MARK = '（未结构化输出，截取尾部）'

const CONCLUSION_HEADING_RE =
  /^(#{1,3})\s*(本阶段结论|本阶段摘要|结论|交付物|交付|摘要|Conclusion)\s*$/i
const CONCLUSION_FENCE_RE = /```(?:conclusion|结论)\s*\n([\s\S]*?)```/i
const API_ERROR_SPLIT_RE = /(?=API Error:)/

export function clip(text: string, max: number): string {
  const trimmed = text.trim()
  if (trimmed.length <= max) return trimmed
  return `${trimmed.slice(0, Math.max(0, max - 1))}…`
}

/**
 * 归并重复错误。行级相同连续行,以及无换行拼接的 `API Error:` 块,
 * 都收成「原文 + 同一错误重复 N 次」。
 */
export function collapseRepeatedOutput(text: string): string {
  if (!text) return text
  return collapseInlineRepeats(collapseDuplicateLines(text))
}

function collapseDuplicateLines(text: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    let n = 1
    while (i + n < lines.length && lines[i + n] === line) n += 1
    if (n >= 2 && line.trim()) {
      out.push(line)
      out.push(`（同一错误重复 ${n} 次）`)
    } else {
      out.push(line)
    }
    i += n
  }
  return out.join('\n')
}

function collapseInlineRepeats(text: string): string {
  if (text.includes('API Error:')) {
    const parts = text.split(API_ERROR_SPLIT_RE).filter((p) => p.length > 0)
    if (parts.length >= 2) return collapseEqualChunks(parts)
  }
  return collapseRepeatingUnit(text)
}

function collapseEqualChunks(parts: string[]): string {
  const groups: { text: string; n: number }[] = []
  for (const part of parts) {
    const last = groups[groups.length - 1]
    if (last && last.text === part) last.n += 1
    else groups.push({ text: part, n: 1 })
  }
  return groups
    .map((g) => (g.n >= 2 ? `${g.text.trimEnd()}\n（同一错误重复 ${g.n} 次）` : g.text))
    .join('')
}

function collapseRepeatingUnit(text: string): string {
  if (text.length < 80) return text
  const sample = text.length > 50_000 ? text.slice(0, 50_000) : text
  const maxUnit = Math.min(400, Math.floor(sample.length / 2))
  for (let len = 40; len <= maxUnit; len++) {
    const unit = sample.slice(0, len)
    let n = 0
    let pos = 0
    while (pos + len <= sample.length && sample.slice(pos, pos + len) === unit) {
      n += 1
      pos += len
    }
    if (n >= 3 && pos >= sample.length * 0.9) {
      const rest = text.slice(pos)
      return `${unit}\n（同一错误重复 ${n} 次）${rest}`
    }
  }
  return text
}

export interface ExtractedConclusion {
  text: string
  structured: boolean
}

/**
 * 从 agent 产出里抽结论。优先 `## 结论` / `## 交付` 等标题(取最后一次),
 * 其次 fenced ` ```conclusion `;都没有则取文末两段,并标明未结构化。
 */
export function extractConclusion(output: string, maxChars = COMMENT_MAX): ExtractedConclusion {
  const trimmed = output.trim()
  if (!trimmed) return { text: '（无文本产出）', structured: false }

  const lines = trimmed.split('\n')
  let headingIdx = -1
  let headingLevel = 0
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].trim().match(CONCLUSION_HEADING_RE)
    if (m) {
      headingIdx = i
      headingLevel = m[1].length
    }
  }
  if (headingIdx >= 0) {
    const body: string[] = []
    for (let i = headingIdx + 1; i < lines.length; i++) {
      const m = lines[i].trim().match(/^(#{1,3})\s+\S/)
      if (m && m[1].length <= headingLevel) break
      body.push(lines[i])
    }
    const text = body.join('\n').trim()
    if (text) return { text: clip(text, maxChars), structured: true }
  }

  const fence = trimmed.match(CONCLUSION_FENCE_RE)
  if (fence?.[1]?.trim()) {
    return { text: clip(fence[1].trim(), maxChars), structured: true }
  }

  const paras = trimmed
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
  const tail = paras.slice(-2).join('\n\n')
  return {
    text: clip(`${UNSTRUCTURED_TAIL_MARK}\n${tail}`, maxChars),
    structured: false,
  }
}

export interface RunOutputSummary {
  /** 卡片 / run.summary,短。 */
  summary: string
  /** 写进评论的正文。 */
  commentBody: string
  /** 归并后的全文(失败时评论用这个);原文仍由调用方写入 outputMd。 */
  collapsed: string
  structured: boolean
}

export function summarizeRunOutput(
  output: string,
  opts: { failed?: boolean; error?: string | null; summaryMax?: number; commentMax?: number } = {},
): RunOutputSummary {
  const summaryMax = opts.summaryMax ?? SUMMARY_MAX
  const commentMax = opts.commentMax ?? COMMENT_MAX
  const raw = output.trim() ? output : (opts.error ?? '')
  const collapsed = collapseRepeatedOutput(raw)
  const source = collapsed.trim() ? collapsed : raw

  if (opts.failed) {
    const body = clip(source.trim() || '（无文本产出）', commentMax)
    return {
      summary: clip(body.replace(/\s+/g, ' '), summaryMax),
      commentBody: body,
      collapsed: source,
      structured: false,
    }
  }

  const extracted = extractConclusion(source, commentMax)
  return {
    summary: clip(extracted.text.replace(/\s+/g, ' '), summaryMax),
    commentBody: extracted.text,
    collapsed: source,
    structured: extracted.structured,
  }
}
