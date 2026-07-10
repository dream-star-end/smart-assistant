/**
 * list_reminders 输出文本的纯拼装逻辑:标题压平 + 系统任务友好名 + 逐行格式契约。
 *
 * 抽成无副作用纯函数(与 delegateFanout.ts 同范式),因为 index.ts 是带顶层 await +
 * stdio server.connect 的入口模块,不适合被单测直接 import。前端(web-react)的
 * parseReminderListOutput 解析器严格依赖这里产出的**逐行格式契约**,故此处单测把格式钉死;
 * 两侧(server 拼装 / 前端解析)共用同一份格式约定,天然对称。
 */

/**
 * 系统自省 cron 任务 ID → 中文友好名(展示层)。
 *
 * 权威源(系统 job 的 seed 定义 + 判定逻辑)在 packages/gateway/src/cron.ts:
 *   - `DEFAULT_JOBS`(seed:daily-reflection / weekly-curation / skill-check / heartbeat)
 *   - `isUserInitiatedCronJob`(封闭的系统 job 集合,反向排除法)
 * mcp-memory 不依赖 @openclaude/gateway(跨层,且本包在容器内以 stdio 子进程运行),
 * 故此处维护一份「已知系统任务 → 友好名」的镜像常量;gateway 侧新增系统 job 时需同步这里。
 * heartbeat 有独立 UI 处理(job.heartbeat 徽标),不在此友好名映射内。
 */
export const SYSTEM_REMINDER_LABELS: Record<string, string> = {
  'daily-reflection': '记忆日结',
  'weekly-curation': '记忆周整理',
  'skill-check': '技能沉淀巡检',
}

/** 非系统任务用 prompt 兜底标题时的截断长度(压平后计数)。 */
const REMINDER_PROMPT_TITLE_MAX = 40

/** list_reminders 渲染所需的任务字段(gateway /api/cron 返回体的子集)。 */
export interface ReminderJobView {
  id: string
  schedule: string
  label?: string
  prompt?: string
  enabled?: boolean
  oneshot?: boolean
  deliver?: string
  nextRunAt?: string
}

/** 空白压平:连续空白/换行/制表符 → 单个空格,并去首尾。行式输出的第一道防线。 */
function flattenWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/**
 * 计算单行标题 + 是否系统任务。
 *  - 系统任务(SYSTEM_REMINDER_LABELS 命中):用中文友好名,标 isSystem。
 *  - 其余:label 优先(压平,不截断,与现网一致),否则 prompt(压平后截断 + 省略号,
 *    与现网一致),否则 id 兜底。**先压平再处理** —— 现网 weekly-curation 的 prompt
 *    内嵌 `\n\n` 会把行式输出拆碎、击穿前端逐行解析器(本批现网 bug),压平在此根治;
 *    用户自设 label 内嵌换行同样受益。
 */
export function reminderTitle(job: ReminderJobView): { title: string; isSystem: boolean } {
  const sys = SYSTEM_REMINDER_LABELS[job.id]
  if (sys) return { title: sys, isSystem: true }
  if (job.label) return { title: flattenWhitespace(String(job.label)) || job.id, isSystem: false }
  if (job.prompt) {
    const flat = flattenWhitespace(String(job.prompt))
    return { title: `${flat.slice(0, REMINDER_PROMPT_TITLE_MAX)}…`, isSystem: false }
  }
  return { title: job.id, isSystem: false }
}

/** deliver 字段 → 中文标签(与现网映射一致)。 */
function deliverLabel(deliver: string | undefined): string {
  if (deliver === 'local') return '仅记录'
  if (deliver === 'telegram') return 'Telegram'
  return '推送对话'
}

/**
 * 单条任务行。**格式契约**(前端 parseReminderListOutput 严格依赖,勿改分隔符/顺序):
 *
 *   `- **{单行标题}** (ID: \`{id}\`) — \`{cron}\` · {重复|一次性} · {启用中|已停用} · {deliver}[ · 系统][ · 下次 {ISO}]`
 *
 * 系统任务在 deliver 之后、`下次` 之前多一个 `系统` 位;非系统任务输出与现网逐字一致。
 * 标题已在 reminderTitle 里压平,故整行必为单行(前端逐行解析不会被击穿)。
 */
export function formatReminderLine(job: ReminderJobView): string {
  const { title, isSystem } = reminderTitle(job)
  const bits = [
    `\`${job.schedule}\``,
    job.oneshot ? '一次性' : '重复',
    job.enabled === false ? '已停用' : '启用中',
    deliverLabel(job.deliver),
  ]
  if (isSystem) bits.push('系统')
  if (job.nextRunAt) bits.push(`下次 ${job.nextRunAt}`)
  return `- **${title}** (ID: \`${job.id}\`) — ${bits.join(' · ')}`
}

/**
 * 完整 list_reminders 输出:首行计数 + 每任务一行。空列表由调用方(index.ts)另行处理
 * (返回「当前没有任何定时提醒/任务」),不进本函数。
 */
export function formatReminderList(jobs: ReminderJobView[]): string {
  const lines = jobs.map(formatReminderLine)
  return `共 ${jobs.length} 个定时提醒/任务:\n${lines.join('\n')}`
}
