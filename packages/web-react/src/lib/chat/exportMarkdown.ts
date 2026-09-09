import type { ChatMessage } from "./model";

const EXPORT_ROLES = new Set<ChatMessage["role"]>(["user", "assistant", "tool"]);

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** 本地时间 YYYY-MM-DD HH:mm:ss；非法 ts 返回空串。 */
export function formatExportTime(ts: number): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function headingFor(role: ChatMessage["role"]): string {
  if (role === "user") return "用户";
  if (role === "assistant") return "助手";
  return "工具";
}

function toolSummary(m: ChatMessage): string {
  const name = (m.toolName ?? "").trim() || "tool";
  const preview = (m.inputPreview ?? "").trim();
  return preview ? `${name} ${preview}` : name;
}

/**
 * 把当前内存窗消息编成会话导出 Markdown。
 * 只收 user / assistant / tool；thinking、过程卡等跳过。
 */
export function exportSessionMarkdown(messages: readonly ChatMessage[]): string {
  const blocks: string[] = [];
  for (const m of messages) {
    if (!EXPORT_ROLES.has(m.role)) continue;
    const lines = [`## ${headingFor(m.role)}`];
    const when = formatExportTime(m.ts);
    if (when) lines.push(when);
    lines.push(m.role === "tool" ? toolSummary(m) : m.text ?? "");
    blocks.push(lines.join("\n"));
  }
  return blocks.length ? `${blocks.join("\n\n")}\n` : "";
}

/** `<会话标题>.md`；空标题回落「新对话」，去掉路径分隔符。 */
export function sessionExportFilename(title: string | null | undefined): string {
  const raw = (title ?? "").trim() || "新对话";
  const safe = raw.replace(/[\\/]/g, "_");
  return `${safe}.md`;
}
