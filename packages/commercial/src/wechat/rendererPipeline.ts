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
  const cleaned = sanitizeForWechat(rawMarkdown ?? "")
  if (cleaned.length === 0) return []
  return splitText(cleaned, WECHAT_MAX_TEXT).map((text) => ({ type: "text", text }))
}

/**
 * 工具调用预告气泡:发给 WeChat 让用户知道 agent 正在做事(防止"长时间没反应"焦虑)。
 */
export function renderToolAnnouncement(toolName: string): IlinkPart[] {
  const friendly = friendlyToolName(toolName)
  return [{ type: "text", text: `🔧 ${friendly}…` }]
}
