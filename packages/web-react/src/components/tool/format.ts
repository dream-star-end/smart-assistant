/**
 * 工具卡格式化与输入解析的纯函数集（无 React，可单测）。
 * 端口自现网 messages.js 的 `_safeInput` / `_shortPath` / `_formatValue` 语义。
 */
import type { BashTail } from "../../lib/chat/model";
import { parsePartialJson } from "./partialJson";

/**
 * 工具卡消费的最小 tool 形态。`tool` ChatMessage（role==='tool'）与 agent-group 的
 * ChildBlock 都**结构兼容**此类型——ToolCard 因此能同时服务主流 tool 行与子块 tool。
 * 这是 ToolCard 对外的唯一数据契约入口（见 ToolCard.tsx props 约定）。
 */
export type ToolLike = {
  toolName?: string;
  inputJson?: unknown;
  partialJson?: string;
  inputPreview?: string;
  _partial?: boolean;
  _completed?: boolean;
  output?: string | null;
  error?: boolean;
  bashTail?: BashTail;
};

export type ToolInput = Record<string, unknown> | null;

/**
 * 解析工具输入。优先级与现网 `_safeInput` 一致：
 *   1. 最终 inputJson（对象，非数组）
 *   2. 容错解析的 partialJson（流式累加器，驱动 Edit/Write 边流边渲）
 *   3. legacy inputPreview 的 JSON.parse 兜底
 */
export function resolveToolInput(tool: ToolLike): ToolInput {
  const j = tool.inputJson;
  if (j && typeof j === "object" && !Array.isArray(j)) return j as Record<string, unknown>;
  if (typeof tool.partialJson === "string" && tool.partialJson.length > 0) {
    return parsePartialJson(tool.partialJson);
  }
  if (tool.inputPreview) {
    try {
      const p = JSON.parse(tool.inputPreview);
      return p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** 取末 2-3 段路径（过长时 `…/a/b/c`）。 */
export function shortPath(p: unknown): string {
  if (!p || typeof p !== "string") return "";
  const parts = p.replace(/\\/g, "/").split("/");
  return parts.length > 3 ? "…/" + parts.slice(-3).join("/") : p;
}

/** 安全字符串取值（非字符串 → ""）。*/
export function asStr(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** 安全数组取值（非数组 → []）。*/
export function asArr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export function isSafeHttpUrl(s: unknown): s is string {
  return typeof s === "string" && /^https?:\/\//i.test(s);
}

/**
 * 紧凑值格式化。数组/对象做摘要而非全量序列化，避免流式工具块多次重建时的二次方
 * stringify 成本。端口自 `_formatValue`。
 */
export function formatValue(v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    if (v.length <= 3 && v.every((x) => x == null || typeof x !== "object")) {
      try {
        return JSON.stringify(v);
      } catch {
        return `Array(${v.length})`;
      }
    }
    return `Array(${v.length})`;
  }
  if (typeof v === "object") {
    const keys = Object.keys(v as object);
    if (keys.length === 0) return "{}";
    if (keys.length <= 3 && keys.every((k) => (v as Record<string, unknown>)[k] == null || typeof (v as Record<string, unknown>)[k] !== "object")) {
      try {
        return JSON.stringify(v);
      } catch {
        return `{${keys.length} 字段}`;
      }
    }
    const head = keys.slice(0, 3).join(", ");
    return keys.length > 3 ? `{${head}, …+${keys.length - 3}}` : `{${head}}`;
  }
  return String(v);
}

/** 字符串夹断（超出 max 加省略号）。*/
export function clampStr(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}
