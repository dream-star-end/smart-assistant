import { uiPlainText } from "../../components/iui/plainText";
import { formatZoned } from "../displayTime";
import type { ChatMessage } from "./model";

import { selectExportMessages } from "./shareSelection";
import { publicArtifactText } from "./publicArtifactText";

/** 显示时区的 YYYY-MM-DD HH:mm:ss；非法 ts 返回空串。 */
export function formatExportTime(ts: number): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return formatZoned(d, "full");
}

function headingFor(role: ChatMessage["role"]): string {
  if (role === "user") return "用户";
  if (role === "assistant") return "助手";
  return "工具";
}

/**
 * 把当前内存窗消息编成会话导出 Markdown。
 * 收真实提问和最终回答；可见的进行中或失败前部分正文标记未完成后保留，工具和思考不导出。
 * 异步:助手正文含 ```ui 组件时要等组件转换器的懒块加载。
 */
export async function exportSessionMarkdown(messages: readonly ChatMessage[], sending = false): Promise<string> {
  const blocks: string[] = [];
  for (const m of selectExportMessages(messages, sending)) {
    const lines = [`## ${headingFor(m.role)}${m.exportIncomplete ? "（未完成）" : ""}`];
    const when = formatExportTime(m.ts);
    if (when) lines.push(when);
    // Intelligent UI(OCV5-361):助手正文里的 ```ui 组件导出为等价 Markdown。
    lines.push(m.role === "assistant" ? await publicArtifactText(await uiPlainText(m.text ?? "")) : m.text ?? "");
    blocks.push(lines.join("\n"));
  }
  return blocks.length ? `${blocks.join("\n\n")}\n` : "";
}

export { sessionExportFilename } from "./exportFilename";
