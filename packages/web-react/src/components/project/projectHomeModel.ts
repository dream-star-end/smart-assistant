import type { ProjectAsset, Session } from "../../lib/types";

/**
 * 项目主页的纯数据派生（不碰 React，单测直接打）。主页只用前端已有的数据：
 * App 的会话列表 + useProjectAssets 的资产列表；没有就不显示，不编造。
 */

/** 快捷开始：固定提示词，在本项目里开一个新会话并作为第一条消息发送。 */
export const PROJECT_RECIPES = [
  {
    key: "progress",
    label: "汇总最近进展",
    prompt:
      "请汇总这个项目最近的进展：已经完成了什么、正在进行什么、接下来要做什么，并列出需要我决定或确认的事项。",
  },
  {
    key: "weekly",
    label: "生成本周周报",
    prompt:
      "请根据这个项目本周的会话和文件，生成一份本周周报，包括：本周完成、进行中、风险与问题、下周计划。",
  },
] as const;

export type ProjectRecipeKey = (typeof PROJECT_RECIPES)[number]["key"];

/** 会话的最近活动时刻（服务端 lastAt 优先，缺省回落 updatedAt）。 */
export function sessionRecency(s: Pick<Session, "lastAt" | "updatedAt">): number {
  if (typeof s.lastAt === "number" && Number.isFinite(s.lastAt)) return s.lastAt;
  const t = Date.parse(s.updatedAt);
  return Number.isFinite(t) ? t : 0;
}

/** 该项目的会话，最近活动在前。`includeArchived` 缺省 false（概览、计数只看未归档）。 */
export function projectSessionsOf(
  sessions: readonly Session[],
  projectId: string,
  includeArchived = false,
): Session[] {
  return sessions
    .filter((s) => s.projectId === projectId && (includeArchived || !s.archived))
    .sort((a, b) => sessionRecency(b) - sessionRecency(a));
}

/** 标题筛选：去首尾空白、大小写不敏感的包含匹配；空查询返回原列表。 */
export function filterSessionsByTitle(sessions: readonly Session[], query: string): Session[] {
  const q = query.trim().toLowerCase();
  if (!q) return sessions.slice();
  return sessions.filter((s) => (s.title || "新对话").toLowerCase().includes(q));
}

/** 产出类型筛选。网页（html）归代码：产出页只给这五类，避免过细。 */
export type OutputKind = "doc" | "image" | "table" | "code" | "other";

export const OUTPUT_KIND_LABELS: Record<OutputKind, string> = {
  doc: "文档",
  image: "图片",
  table: "表格",
  code: "代码",
  other: "其他",
};

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "heic", "ico"]);
const TABLE_EXT = new Set(["csv", "tsv", "xls", "xlsx", "xlsm", "ods", "numbers"]);
const DOC_EXT = new Set([
  "md",
  "markdown",
  "txt",
  "pdf",
  "doc",
  "docx",
  "rtf",
  "odt",
  "ppt",
  "pptx",
  "odp",
  "key",
  "pages",
  "epub",
  "tex",
]);
const CODE_EXT = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "py",
  "go",
  "rs",
  "java",
  "kt",
  "c",
  "cc",
  "cpp",
  "h",
  "hpp",
  "cs",
  "rb",
  "php",
  "swift",
  "sh",
  "bash",
  "zsh",
  "sql",
  "json",
  "yaml",
  "yml",
  "toml",
  "xml",
  "html",
  "htm",
  "css",
  "scss",
  "vue",
  "svelte",
  "ipynb",
  "lua",
  "r",
  "dart",
  "scala",
]);

function extOf(name: string): string {
  const base = name.split("/").pop() ?? name;
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i + 1).toLowerCase() : "";
}

/** 按扩展名优先、mime 兜底归类（服务端 mime 常是 application/octet-stream，扩展名更可靠）。 */
export function outputKind(a: Pick<ProjectAsset, "name" | "mime">): OutputKind {
  const ext = extOf(a.name);
  if (IMAGE_EXT.has(ext)) return "image";
  if (TABLE_EXT.has(ext)) return "table";
  if (DOC_EXT.has(ext)) return "doc";
  if (CODE_EXT.has(ext)) return "code";
  const mime = (a.mime ?? "").toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.includes("spreadsheet") || mime.includes("excel") || mime === "text/csv") return "table";
  if (
    mime === "application/pdf" ||
    mime === "text/plain" ||
    mime === "text/markdown" ||
    mime.includes("wordprocessing") ||
    mime.includes("msword") ||
    mime.includes("presentation")
  ) {
    return "doc";
  }
  if (
    mime.startsWith("text/x-") ||
    mime === "application/json" ||
    mime === "application/javascript" ||
    mime === "text/javascript" ||
    mime === "text/html" ||
    mime === "text/css"
  ) {
    return "code";
  }
  return "other";
}

/** 产出 = source 为 output 的资产，最新在前。 */
export function outputsOf(assets: readonly ProjectAsset[]): ProjectAsset[] {
  return assets
    .filter((a) => a.source === "output")
    .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
}

/** 常用文件 = 设为常用（pinned）的资产，保持列表顺序。 */
export function pinnedOf(assets: readonly ProjectAsset[]): ProjectAsset[] {
  return assets.filter((a) => a.pinned);
}

/** 摘要行：只拼确实有的数据（指令 / 常用文件 / 会话数）；资产未加载时不报常用文件数。 */
export function projectSummary(input: {
  hasInstructions: boolean;
  pinnedCount: number | null;
  sessionCount: number;
}): string {
  const parts: string[] = [];
  if (input.hasInstructions) parts.push("已设项目指令");
  if (input.pinnedCount !== null && input.pinnedCount > 0) {
    parts.push(`${input.pinnedCount} 份常用文件`);
  }
  parts.push(input.sessionCount > 0 ? `${input.sessionCount} 个会话` : "还没有会话");
  return parts.join(" · ");
}

/** 「最近活动」里的一条：会话、看板任务或定时任务（只用已有接口的数据）。 */
export type ActivityItem =
  | { kind: "chat"; id: string; at: number; title: string; session: Session }
  | { kind: "ticket"; id: string; at: number; title: string; identifier: string; status: string }
  | { kind: "cron"; id: string; at: number; title: string; enabled: boolean };

export type ActivityTicket = { id: string; identifier: string; title: string; status: string; updatedAt?: number | string };
export type ActivityCron = {
  id: string;
  label?: string;
  prompt?: string;
  enabled?: boolean;
  lastRunAt?: string | number | null;
};

function toMs(v: string | number | null | undefined): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : 0;
  }
  return 0;
}

/**
 * 会话 + 看板任务 + 定时任务（只算跑过的）按时间合并，最新在前。
 * 没有时间的条目不进列表（不编造时间）。
 */
export function mergeActivity(input: {
  sessions: readonly Session[];
  tickets?: readonly ActivityTicket[];
  cron?: readonly ActivityCron[];
  limit: number;
}): ActivityItem[] {
  const items: ActivityItem[] = [];
  for (const s of input.sessions) {
    const at = sessionRecency(s);
    if (at > 0) items.push({ kind: "chat", id: s.id, at, title: s.title || "新对话", session: s });
  }
  for (const t of input.tickets ?? []) {
    const at = toMs(t.updatedAt);
    if (at > 0) items.push({ kind: "ticket", id: t.id, at, title: t.title, identifier: t.identifier, status: t.status });
  }
  for (const j of input.cron ?? []) {
    const at = toMs(j.lastRunAt);
    if (at > 0) {
      const title = (j.label || j.prompt || "定时任务").trim().slice(0, 60);
      items.push({ kind: "cron", id: j.id, at, title, enabled: j.enabled !== false });
    }
  }
  return items.sort((a, b) => b.at - a.at).slice(0, input.limit);
}
