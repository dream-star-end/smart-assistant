// Taskboard 巡检提示词模板渲染。
//
// 设计意图:
//   stage.promptTemplate 是给人配的,占位符在跑之前由引擎填好。渲染结果必须
//   带上 exit checklist 与「怎样算做完」的产出格式,否则 agent 不知道收口标准。
//
// 未知占位符策略(冻结):
//   **原样保留** `{{foo}}`,不报错、不留空。理由:用户手改模板时多写一个占位
//   不该让整张卡停转;留空会让 agent 以为字段就是空的,原样留下至少能被看见。
//   已知占位一律替换(缺值用空串)。只认双花括号 + 点分路径,不支持空格变体
//   以外的语法(`{{ ticket.title }}` 可以,`{ticket.title}` 不行)。
//
// 坑:
//   - {{comments}} 可能极长,必须截断,否则一次巡检就能把上下文窗口打满。
//   - 截断保留**最近**若干条(人打回的意见通常在末尾),并标注省略了多少。
//   - ticket.body 本身可能含 `{{...}}`,替换时按占位符扫描模板,不要二次扫描
//     已插入的 body,否则用户正文里的花括号会被误伤。所以用 match + 查表,
//     不要对 replacement 再跑一遍。

import type { PipelineStage, Ticket, TicketComment, TicketRun } from './domain.js'

/** 已登记的占位符。新增必须同步改 renderPrompt 的 values 与本集合。 */
export const PROMPT_PLACEHOLDERS = [
  'ticket.identifier',
  'ticket.title',
  'ticket.body',
  'last_run.summary',
  'comments',
  'stage.exit_checklist',
] as const

export type PromptPlaceholder = (typeof PROMPT_PLACEHOLDERS)[number]

const PLACEHOLDER_SET = new Set<string>(PROMPT_PLACEHOLDERS)

/** 评论拼进提示词的硬上限(字符)。超出丢最早的,留最近的。 */
export const COMMENTS_CHAR_BUDGET = 4000

/** 最多保留的最近评论条数(即使总长未超预算也截)。 */
export const COMMENTS_MAX_ITEMS = 12

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g

export interface PromptRenderInput {
  template: string | null | undefined
  ticket: Pick<Ticket, 'identifier' | 'title' | 'body'>
  stage: Pick<PipelineStage, 'name' | 'exitChecklist'>
  lastRun?: Pick<TicketRun, 'summary'> | null
  comments?: readonly TicketComment[]
}

export interface PromptRenderResult {
  prompt: string
  /** 模板里出现过、但不在 PROMPT_PLACEHOLDERS 里的名字(已原样保留)。 */
  unknownPlaceholders: string[]
}

export function formatCommentsForPrompt(
  comments: readonly TicketComment[],
  budget = COMMENTS_CHAR_BUDGET,
  maxItems = COMMENTS_MAX_ITEMS,
): string {
  if (comments.length === 0) return '（暂无评论）'
  const recent = comments.slice(-maxItems)
  const omittedItems = comments.length - recent.length
  const chunks: string[] = []
  let used = 0
  let omittedByBudget = 0
  // 从最近往回装,再正序拼,保证「最近优先」且阅读顺序仍是时间升序。
  const accepted: string[] = []
  for (let i = recent.length - 1; i >= 0; i--) {
    const c = recent[i]
    const line = `- [${c.authorKind}/${c.author}] ${c.body.trim()}`
    if (used + line.length + 1 > budget) {
      omittedByBudget += 1
      continue
    }
    accepted.push(line)
    used += line.length + 1
  }
  accepted.reverse()
  const omitted = omittedItems + omittedByBudget
  if (omitted > 0) {
    chunks.push(`（已省略较早的 ${omitted} 条评论，仅保留最近 ${accepted.length} 条）`)
  }
  chunks.push(...accepted)
  return chunks.join('\n')
}

function defaultTemplate(stageName: string): string {
  return [
    `你正在处理任务面板的「${stageName}」阶段。`,
    '单据 {{ticket.identifier}}：{{ticket.title}}',
    '',
    '## 描述',
    '{{ticket.body}}',
    '',
    '## 上次结论',
    '{{last_run.summary}}',
    '',
    '## 评论',
    '{{comments}}',
    '',
  ].join('\n')
}

const OUTPUT_CONTRACT = `
## 产出格式要求（系统附加,必须遵守）
1. 用 Markdown 写完整产出。先给 3–8 句结论摘要,再给证据与细节。
2. 必须对照上面的 exit checklist 逐条自检:已完成的写证据,未完成的明确写缺口。
3. 不要声称「已完成」除非 checklist 每条都有对应证据。
4. 大产物(完整代码/长文档)写入文件,正文只留路径 + 摘要。
`.trim()

/**
 * 渲染巡检提示词。未知 `{{...}}` 原样保留(见文件头)。
 * 无论模板是否已写 checklist,渲染结果末尾都会再附一份 exit checklist
 * 与产出格式,避免用户删掉模板占位后 agent 丢标准。
 */
export function renderPrompt(input: PromptRenderInput): PromptRenderResult {
  const template = (input.template ?? '').trim() || defaultTemplate(input.stage.name)
  const comments = formatCommentsForPrompt(input.comments ?? [])
  const values: Record<PromptPlaceholder, string> = {
    'ticket.identifier': input.ticket.identifier,
    'ticket.title': input.ticket.title,
    'ticket.body': input.ticket.body,
    'last_run.summary': input.lastRun?.summary ?? '（尚无上次 run）',
    comments,
    'stage.exit_checklist': input.stage.exitChecklist ?? '（本阶段未配置 exit checklist）',
  }

  const unknown: string[] = []
  const seenUnknown = new Set<string>()
  const body = template.replace(PLACEHOLDER_RE, (raw, name: string) => {
    if (PLACEHOLDER_SET.has(name)) {
      return values[name as PromptPlaceholder]
    }
    if (!seenUnknown.has(name)) {
      seenUnknown.add(name)
      unknown.push(name)
    }
    return raw
  })

  const checklist = input.stage.exitChecklist?.trim()
    ? input.stage.exitChecklist.trim()
    : '（本阶段未配置 exit checklist）'

  const prompt = [
    body.trim(),
    '',
    '## 本阶段 exit checklist（系统附加）',
    checklist,
    '',
    OUTPUT_CONTRACT,
  ].join('\n')

  return { prompt, unknownPlaceholders: unknown }
}
