/**
 * 会话按轮切分(OCV5-372)。面板外壳(InspectorPanel,首屏)只需要这一小块来定位「哪一轮」;
 * 产出提取(workbench.ts)随产出页懒加载,不进首屏。
 *
 * user 消息开启新轮(与 collectPaneSteps 同口径),但**不**丢掉没有工具的轮:只回答了一段话的
 * 轮也是一轮,产出页要能翻到它。
 */
import type { ChatMessage } from "../../lib/chat/model";

export type WorkTurn = {
  /** 本轮 user 消息 id;会话开头没有 user 消息的那段为 "start"。 */
  key: string;
  title: string;
  /** 本轮 user 消息之后的全部行。 */
  rows: ChatMessage[];
  /** 本轮的顶层工具调用。 */
  steps: ChatMessage[];
  startedAt?: number;
};

export function collectWorkTurns(messages: readonly ChatMessage[]): WorkTurn[] {
  const turns: WorkTurn[] = [];
  let current: WorkTurn | null = null;
  for (const m of messages) {
    if (m.role === "user") {
      if (m.status === "queued") continue;
      current = { key: m.id, title: oneLine(m.text, 80) || "（无文字的消息）", rows: [], steps: [], startedAt: m.ts };
      turns.push(current);
      continue;
    }
    if (!current) {
      current = { key: "start", title: "会话开始", rows: [], steps: [] };
      turns.push(current);
    }
    current.rows.push(m);
    if (m.role === "tool") current.steps.push(m);
  }
  // 还没有任何回应的轮(刚发出)留着:运行中要能看到「这一轮」。开头那段只在有内容时才算。
  return turns.filter((t) => t.key !== "start" || t.rows.length > 0);
}

/** 含这条消息(按 id,回落引用)的那一轮;找不到 → -1。 */
export function turnIndexOf(turns: readonly WorkTurn[], message: { id?: string } | null | undefined): number {
  if (!message) return -1;
  const id = message.id;
  return turns.findIndex((t) => t.key === id || t.rows.some((r) => r === message || (!!id && r.id === id)));
}

function oneLine(text: string | undefined, max: number): string {
  const line = (text ?? "").replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}
