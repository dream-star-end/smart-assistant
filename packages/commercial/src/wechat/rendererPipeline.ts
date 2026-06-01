/**
 * v3 commercial WeChat broker — outbound 渲染管线。
 *
 * 把 v3 master OutboundMessage 文本(可能是 markdown,可能含工具调用)
 * 渲染成微信能正确显示的 IlinkPart[]。三个 helper(`sanitizeForWechat`,
 * `splitText`,`friendlyToolName`)是 packages/channels/wechat/src/manager.ts
 * 私有实现的复制 — **故意复制不复用**:
 *
 *   - manager.ts 跑在 v3 master 进程外的 plugin host,broker 在 v3 master 进程内,
 *     依赖图不交叉(commercial 不该 import @openclaude/channels 实现)。
 *   - 三个函数都是 30 行内的纯字符串处理,fork 复用风险低于"为了 DRY 倒拉依赖"。
 *   - 若哪天行为分化(WeChat 端 markdown 处理升级),fork 副本无干扰彼此。
 *
 * P2/P3 扩 IlinkPart union(图片/语音/媒体)时,新增 composer 函数在本文件追加,不再
 * 反向 import manager.ts。
 */

import type { IlinkPart } from "./types.js"

/** iLink sendText 单条上限。略保守(实际允许更大),便于 WeChat 客户端连贯阅读。 */
export const WECHAT_MAX_TEXT = 1024

/**
 * 工具名 → 中文友好称呼。未匹配时返回 mcp__ 剥皮后的尾段或原样。
 * (复制自 packages/channels/wechat/src/manager.ts:259)
 */
export function friendlyToolName(raw: string): string {
  const n = raw.trim()
  const map: Record<string, string> = {
    Read: "读取文件",
    Write: "写入文件",
    Edit: "编辑文件",
    Bash: "执行命令",
    Glob: "查找文件",
    Grep: "搜索内容",
    WebSearch: "联网搜索",
    WebFetch: "抓取网页",
    Task: "调用子助手",
    TodoWrite: "规划任务",
    AskUserQuestion: "向你提问",
    NotebookEdit: "编辑 notebook",
  }
  if (map[n]) return map[n]
  if (/minimax-vision.*web_search/i.test(n)) return "联网搜索"
  if (/minimax-vision.*understand_image/i.test(n)) return "识别图片"
  if (/minimax.*text_to_image/i.test(n)) return "生成图片"
  if (/minimax.*text_to_audio/i.test(n)) return "生成语音"
  if (/minimax.*(generate_video|music)/i.test(n)) return "生成媒体"
  if (/browser_/i.test(n)) return "操作浏览器"
  if (/(memory|archival)/i.test(n)) return "访问记忆"
  if (/session_search/i.test(n)) return "搜索历史会话"
  if (/skill_(view|save|list|delete)/i.test(n)) return "查看/保存技能"
  if (/create_reminder|cron/i.test(n)) return "设置定时任务"
  if (/delegate_task|send_to_agent/i.test(n)) return "协作 agent"
  if (/ToolSearch/i.test(n)) return "查询工具"
  const m = n.match(/^mcp__[^_]+__(.+)$/)
  return m ? m[1] : n
}

/**
 * 剥 markdown 语法,使微信纯文本视图不出现裸 `**`、`#` 等字面字符。
 * 保留 URL(微信会把 `https://` 自动渲染成可点链接)与换行/项目符号。
 * (复制自 packages/channels/wechat/src/manager.ts:304)
 */
export function sanitizeForWechat(s: string): string {
  if (!s) return ""
  let out = s
  out = out.replace(/```[a-zA-Z0-9_+-]*\n?/g, "").replace(/```/g, "")
  out = out.replace(/`([^`\n]+)`/g, "$1")
  out = out.replace(/\*\*([^*\n]+)\*\*/g, "$1")
  out = out.replace(/__([^_\n]+)__/g, "$1")
  out = out.replace(/(?<![A-Za-z0-9_])\*([^*\n]+)\*(?![A-Za-z0-9_])/g, "$1")
  out = out.replace(/(?<![A-Za-z0-9_])_([^_\n]+)_(?![A-Za-z0-9_])/g, "$1")
  out = out.replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, "$1 ($2)")
  out = out.replace(/^\s{0,3}#{1,6}\s+/gm, "")
  out = out.replace(/^\s*>\s?/gm, "")
  out = out.replace(/^\s*[-*_]{3,}\s*$/gm, "")
  return out
}

/**
 * 将 CCB / 上游 API 的原始错误压成微信用户能理解的短文案。
 *
 * 只在 WeChat 出站渲染层使用:网页端仍保留完整错误和 request_id 便于排查;
 * 微信聊天里不应把 JSON / request_id / provider 细节直接甩给用户。
 */
export function friendlyProviderErrorForWechat(raw: string): string | null {
  const text = raw.trim()
  if (!text) return null

  const modelUnavailable =
    /UNKNOWN_MODEL[\s\S]*?model ['"]([^'"]{1,80})['"] not enabled/i.exec(text) ??
    /model ['"]([^'"]{1,80})['"] not enabled[\s\S]*?UNKNOWN_MODEL/i.exec(text)
  if (modelUnavailable) {
    const model = safeModelNameForWechat(modelUnavailable[1])
    return (
      `这个模型${model ? `（${model}）` : ""}当前不可用。\n` +
      "请在网页端切换到可用模型后再试；也可以发送 /model 查看微信里的模型说明。"
    )
  }

  if (/^API Error:\s*(?:502|503|504|529)\b|rate[ _-]?limit|overloaded/i.test(text)) {
    return "模型服务暂时繁忙，请稍后再发一次。"
  }

  if (/^API Error:\s*(?:401|403)\b|Failed to authenticate|run \/login|invalid api key/i.test(text)) {
    return "账号认证暂时不可用，系统会尝试刷新凭据；如果仍失败，请稍后再试或联系管理员。"
  }

  if (/^API Error:\s*\d{3}\b/i.test(text) && /[{}]\s*|request_id|"error"/i.test(text)) {
    return "模型请求没有成功。请稍后重试；如果连续失败，请在网页端切换模型或联系管理员。"
  }

  return null
}

function safeModelNameForWechat(raw: string | undefined): string {
  const model = (raw ?? "").trim()
  return /^[A-Za-z0-9._:-]{1,80}$/.test(model) ? model : ""
}

/**
 * 按 max 长度硬切分;不考虑 word boundary 因为微信主流是 CJK,空格分词无意义。
 * (复制自 packages/channels/wechat/src/manager.ts:327)
 */
export function splitText(text: string, max: number): string[] {
  if (max <= 0) throw new Error(`splitText: max must be > 0, got ${max}`)
  const out: string[] = []
  let buf = text
  while (buf.length > max) {
    out.push(buf.slice(0, max))
    buf = buf.slice(max)
  }
  if (buf) out.push(buf)
  return out
}

export function splitTextForWechatPages(text: string, max: number): string[] {
  const firstPass = splitText(text, max)
  if (firstPass.length <= 1) return firstPass

  let total = firstPass.length
  for (;;) {
    const reserve = pagePrefix(total, total).length
    if (reserve >= max) throw new Error(`splitTextForWechatPages: page prefix exceeds max=${max}`)
    const chunks = splitText(text, max - reserve)
    if (chunks.length === total) {
      return chunks.map((chunk, idx) => `${pagePrefix(idx + 1, total)}${chunk}`)
    }
    total = chunks.length
  }
}

function pagePrefix(page: number, total: number): string {
  return `（${page}/${total}）\n`
}

/**
 * 把 raw assistant 文本(markdown)渲染成 IlinkPart[]。空串/null/undefined 返回 []。
 *
 * 签名故意接受 `null | undefined`:v3 OutboundMessage.text 历史允许 undefined,worker
 * drain 时不需要二次 coalesce/cast(Codex slice 2 review non-blocking 建议)。
 *
 * P1 流程:sanitize → split(WECHAT_MAX_TEXT)→ 每段一个 text part。
 * P2 引入图片时,会在此追加附件 part(图片优先,再追加文字)。
 */
export function renderAssistantText(rawMarkdown: string | null | undefined): IlinkPart[] {
  const raw = rawMarkdown ?? ""
  const displayText = friendlyProviderErrorForWechat(raw) ?? raw
  const cleaned = sanitizeForWechat(displayText)
  if (cleaned.length === 0) return []
  return splitTextForWechatPages(cleaned, WECHAT_MAX_TEXT).map((text) => ({ type: "text", text }))
}

export interface ToolAnnouncementDetails {
  summary?: string
  inputPreview?: string
  inputJson?: unknown
}

const MAX_TOOL_DETAIL_CHARS = 300

/**
 * 工具调用预告气泡:发给 WeChat 让用户知道 agent 正在做事(防止"长时间没反应"焦虑)。
 *
 * 对 Bash 等高频工具,同时展示一个有上限的参数摘要。网页端完整工具卡仍是
 * 权威视图;微信端只给用户判断"具体在做什么",避免"只显示执行命令"但不知道
 * 命令内容。
 */
export function renderToolAnnouncement(
  toolName: string,
  details: ToolAnnouncementDetails = {},
): IlinkPart[] {
  const friendly = friendlyToolName(toolName)
  const detail = deriveToolAnnouncementDetail(toolName, details)
  const suffix = detail ? `\n${detail.label}：${detail.text}` : ""
  return [{ type: "text", text: `🔧 ${friendly}…${suffix}` }]
}

function deriveToolAnnouncementDetail(
  toolName: string,
  details: ToolAnnouncementDetails,
): { label: string; text: string } | null {
  const summary = cleanToolDetail(details.summary)
  if (summary) return { label: "详情", text: summary }

  const inputObj = objectRecord(details.inputJson) ?? parsePreviewObject(details.inputPreview)
  if (inputObj) {
    const picked = pickToolInputDetail(toolName, inputObj)
    if (picked) return picked
  }

  const preview = cleanToolDetail(details.inputPreview)
  if (preview) return { label: "参数", text: preview }
  return null
}

function pickToolInputDetail(
  toolName: string,
  input: Record<string, unknown>,
): { label: string; text: string } | null {
  const n = toolName.trim()

  if (n === "Bash") {
    return fieldDetail("命令", input, ["command", "cmd", "script"])
  }
  if (n === "Read" || n === "Write" || n === "Edit" || n === "NotebookEdit") {
    return fieldDetail("文件", input, ["file_path", "path", "notebook_path"])
  }
  if (n === "Grep") {
    return joinedDetail("搜索", [scalar(input.pattern), scalar(input.query)], scalar(input.path))
  }
  if (n === "Glob") {
    return joinedDetail("匹配", [scalar(input.pattern)], scalar(input.path))
  }
  if (n === "WebSearch") {
    return fieldDetail("搜索", input, ["query"])
  }
  if (n === "WebFetch") {
    return fieldDetail("网页", input, ["url"])
  }
  if (n === "Task") {
    return fieldDetail("任务", input, ["description", "prompt"])
  }

  return fieldDetail("参数", input, [
    "command",
    "file_path",
    "path",
    "pattern",
    "query",
    "url",
    "description",
    "prompt",
  ])
}

function fieldDetail(
  label: string,
  input: Record<string, unknown>,
  keys: string[],
): { label: string; text: string } | null {
  for (const key of keys) {
    const text = cleanToolDetail(scalar(input[key]))
    if (text) return { label, text }
  }
  return null
}

function joinedDetail(
  label: string,
  mainCandidates: Array<string | undefined>,
  scope: string | undefined,
): { label: string; text: string } | null {
  const main = mainCandidates.map((s) => cleanToolDetail(s)).find((s) => s.length > 0)
  if (!main) return null
  const cleanScope = cleanToolDetail(scope)
  return { label, text: cleanScope ? `${main} @ ${cleanScope}` : main }
}

function cleanToolDetail(value: string | undefined): string {
  const cleaned = sanitizeForWechat(value ?? "").trim()
  if (!cleaned) return ""
  if (cleaned.length <= MAX_TOOL_DETAIL_CHARS) return cleaned
  return `${cleaned.slice(0, MAX_TOOL_DETAIL_CHARS)}…`
}

function scalar(value: unknown): string | undefined {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return undefined
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function parsePreviewObject(preview: string | undefined): Record<string, unknown> | null {
  if (!preview) return null
  try {
    return objectRecord(JSON.parse(preview))
  } catch {
    return null
  }
}
