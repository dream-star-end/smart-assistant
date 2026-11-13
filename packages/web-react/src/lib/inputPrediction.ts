/**
 * 输入预测(OCV5-375,个人版):输入框里用浅色字显示「用户接下来最可能输入的话」,Tab / → 采用。
 *
 * 预测由助手自己给:每条回答的最后写一个 ```ui {"type":"next","text":"…"} 块(提示词在 master
 * 按需 `system-assistant/references/input-prediction.md`)。这个块在聊天、复制、导出里都不出现
 * (IuiBlock / toMarkdown 见 isNextBlockCode),只在这里被读出来交给输入框。
 * 没写 next 块的回答退回到它的「接着问」(suggestions)第一条。
 * 输入中补全:当前正文是某个候选的开头 → 显示候选剩下的部分。候选 = 上面几条 + 本会话里
 * 用户自己发过的话。全部来自当前会话时间线,不额外请求模型,不落盘、不上传。
 *
 * 本模块由 App 按需加载(不进首屏包);输入框里的补全和类型在 ./inputCompletion。
 * 不引用 components/iui 的解析器和 schema(它们只在懒加载的 Markdown 块里),
 * 只认 next / suggestions 两种块。suggestions 的取值规则与 schema.ts 的
 * suggestions() 一致:`items`(或 `suggestions`)里的非空字符串 / 数字,含 followups / follow_up 别名。
 */

import type { InputPrediction } from "./inputCompletion";
import { normalizeInlineUiFences } from "./uiFence";

export { isNextBlockCode } from "./nextBlock";

export type { InputPrediction, InputPredictionSource } from "./inputCompletion";

type TimelineRow = { role: string; text: string; status?: string };

/** 一句预测的长度上限:更长的不像用户会直接输入的话,也会把输入框撑高。 */
const MAX_PREDICTION_CHARS = 80;
/** 本会话里参与补全的历史条数。 */
const MAX_HISTORY = 50;

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)/;
const NEXT_TYPES = new Set(["next", "prediction"]);
const SUGGESTION_TYPES = new Set(["suggestions", "followups", "follow_up"]);

/** 一个 ui 块 → 对象;解析不了 → null。容忍模型常见的尾逗号。 */
function parseBlock(code: string): Record<string, unknown> | null {
  let raw: unknown;
  try {
    raw = JSON.parse(code);
  } catch {
    try {
      raw = JSON.parse(code.replace(/,(\s*[}\]])/g, "$1"));
    } catch {
      return null;
    }
  }
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

function textOf(v: unknown): string {
  return typeof v === "number" && Number.isFinite(v) ? String(v) : typeof v === "string" ? v.trim() : "";
}

/** 回答里已闭合的 ```ui 块(按出现顺序);其它语言的围栏(含其中的 ```ui 字样)跳过。 */
function uiBlocksOf(text: string): Record<string, unknown>[] {
  if (!text.includes("```ui") && !text.includes("~~~ui")) return [];
  const lines = normalizeInlineUiFences(text).split("\n");
  const blocks: Record<string, unknown>[] = [];
  let i = 0;
  while (i < lines.length) {
    const m = FENCE_OPEN.exec(lines[i]!);
    if (!m) {
      i += 1;
      continue;
    }
    const fence = m[1]!;
    const closeRe = new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}[ \\t]*$`);
    let j = i + 1;
    while (j < lines.length && !closeRe.test(lines[j]!)) j += 1;
    if (m[2]!.toLowerCase() === "ui" && j < lines.length) {
      const block = parseBlock(lines.slice(i + 1, j).join("\n"));
      if (block) blocks.push(block);
    }
    i = j + 1;
  }
  return blocks;
}

function typeOf(block: Record<string, unknown>): string {
  return typeof block.type === "string" ? block.type.trim().toLowerCase() : "";
}

/** 助手写的输入预测(最后一个 next 块的 text);没有 → null。 */
export function nextPredictionOf(text: string): string | null {
  const blocks = uiBlocksOf(text).filter((b) => NEXT_TYPES.has(typeOf(b)));
  const last = blocks[blocks.length - 1];
  return last ? textOf(last.text) || null : null;
}

/** 回答里所有 suggestions 块的条目(最后一块在前)。 */
export function suggestionItemsOf(text: string): string[] {
  return uiBlocksOf(text)
    .filter((b) => SUGGESTION_TYPES.has(typeOf(b)))
    .reverse()
    .flatMap((b) => {
      const list = b.items ?? b.suggestions;
      return Array.isArray(list) ? list.map(textOf).filter(Boolean) : [];
    });
}

function usable(s: string | null): string | null {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t && t.length <= MAX_PREDICTION_CHARS ? t : null;
}

/**
 * 当前会话时间线 → 预测。只看最后一条用户消息之后的回答;用户刚发出、回答还没有内容时
 * 只给补全候选(上一轮的预测已经过期)。
 */
export function predictInput(rows: readonly TimelineRow[]): InputPrediction {
  let lastUser = -1;
  const history: string[] = [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!;
    if (r.role !== "user" || r.status === "queued") continue;
    if (lastUser < 0) lastUser = i;
    const t = !r.text.includes("\n") ? usable(r.text) : null;
    if (t && !history.includes(t) && history.length < MAX_HISTORY) history.push(t);
  }
  let answer = "";
  for (let i = rows.length - 1; i > lastUser; i--) {
    if (rows[i]!.role === "assistant" && rows[i]!.text.trim()) {
      answer = rows[i]!.text;
      break;
    }
  }
  const agent = answer ? usable(nextPredictionOf(answer)) : null;
  const suggestions = answer ? suggestionItemsOf(answer).map(usable).filter((s): s is string => !!s) : [];
  const next = agent
    ? { text: agent, source: "agent" as const }
    : suggestions[0]
      ? { text: suggestions[0], source: "suggestion" as const }
      : null;
  const candidates: string[] = [];
  for (const c of [...(agent ? [agent] : []), ...suggestions, ...history]) if (!candidates.includes(c)) candidates.push(c);
  return { next, candidates };
}
