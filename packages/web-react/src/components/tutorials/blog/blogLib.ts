import type { CommunityTutorialCategory, CommunityTutorialMine } from "../../../lib/types";

// 「经验分享」(OCV5-577) 的纯逻辑:分类配色、日期、头像色、图片压缩、Markdown 工具栏、本地草稿、
// 投稿状态。组件只负责渲染,这里的函数都可单测。

export const BLOG_CATEGORIES: Array<{ value: CommunityTutorialCategory; label: string }> = [
  { value: "coding", label: "编码" },
  { value: "research", label: "科研" },
  { value: "general", label: "通用" },
];

export function blogCategoryLabel(category: CommunityTutorialCategory): string {
  return BLOG_CATEGORIES.find((item) => item.value === category)?.label ?? "通用";
}

/** 没有封面图时的占位渐变(与设计稿同一组深色底)。 */
export const BLOG_PLACEHOLDER_GRADIENT: Record<CommunityTutorialCategory, string> = {
  coding: "linear-gradient(135deg,#3b1f6b,#2a2f6b)",
  research: "linear-gradient(135deg,#152442,#2a2f6b)",
  general: "linear-gradient(135deg,#102b29,#2a2f6b)",
};

/** 「10月21日」;跨年时带年份。 */
export function blogShortDate(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const md = `${date.getMonth() + 1}月${date.getDate()}日`;
  return date.getFullYear() === now.getFullYear() ? md : `${date.getFullYear()}年${md}`;
}

export function blogLongDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

export function blogClock(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** 中文约 400 字/分钟,至少 1 分钟(与后端 tutorialReadMinutes 同一口径)。 */
export function blogReadMinutes(text: string): number {
  return Math.max(1, Math.ceil([...text].length / 400));
}

const AVATAR_COLORS = ["#6d4af0", "#0a58d8", "#157044", "#bb202a", "#8a5511", "#7a3fb8", "#0f7b8a"];

export function blogAvatar(name: string): { initial: string; color: string } {
  const trimmed = name.trim() || "社";
  let hash = 0;
  for (const ch of trimmed) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return { initial: [...trimmed][0]!.toUpperCase(), color: AVATAR_COLORS[hash % AVATAR_COLORS.length]! };
}

export const BLOG_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const BLOG_IMAGE_MAX_PER_POST = 20;
export const BLOG_IMAGE_LONG_EDGE = 2560;
export const BLOG_IMAGE_QUALITY = 0.85;

const IMAGE_REF_RE = /!\[[^\]\n]*\]\(tutorial-blob:([a-f0-9]{64})[^)\n]*\)/g;

/** 正文里已插入的图片(去重)。 */
export function blogImageShas(markdown: string): string[] {
  const out: string[] = [];
  for (const match of markdown.matchAll(IMAGE_REF_RE)) {
    if (!out.includes(match[1]!)) out.push(match[1]!);
  }
  return out;
}

export function blogFirstImageSha(markdown: string): string | null {
  return blogImageShas(markdown)[0] ?? null;
}

/** 长边不超过 limit 的目标尺寸(只缩不放)。 */
export function fitLongEdge(width: number, height: number, limit = BLOG_IMAGE_LONG_EDGE) {
  const scale = Math.min(1, limit / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export type CompressDeps = {
  decode: (file: Blob) => Promise<{ width: number; height: number; draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void; close?: () => void }>;
  encode: (width: number, height: number, paint: (ctx: CanvasRenderingContext2D) => void, quality: number) => Promise<Blob>;
};

const defaultDeps: CompressDeps = {
  async decode(file) {
    const bitmap = await createImageBitmap(file);
    return {
      width: bitmap.width,
      height: bitmap.height,
      draw: (ctx, w, h) => ctx.drawImage(bitmap, 0, 0, w, h),
      close: () => bitmap.close(),
    };
  },
  async encode(width, height, paint, quality) {
    if (typeof OffscreenCanvas !== "undefined") {
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext("2d") as unknown as CanvasRenderingContext2D | null;
      if (!ctx) throw new Error("浏览器不支持图片压缩");
      paint(ctx);
      return canvas.convertToBlob({ type: "image/webp", quality });
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("浏览器不支持图片压缩");
    paint(ctx);
    return new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("图片压缩失败"))), "image/webp", quality),
    );
  },
};

export class BlogImageError extends Error {}

/**
 * 上传前压缩:长边限制 2560、转 webp(质量 0.85)。压完仍超过 10MB 拒绝。
 * 浏览器不认 webp 编码(toBlob 退回 png)时用返回的实际类型,服务端按魔数复核。
 */
export async function compressBlogImage(file: Blob, deps: CompressDeps = defaultDeps): Promise<Blob> {
  if (!/^image\/(png|jpe?g|webp|gif|bmp|avif|heic|heif)$/i.test(file.type)) {
    throw new BlogImageError("只支持图片文件");
  }
  let decoded: Awaited<ReturnType<CompressDeps["decode"]>>;
  try {
    decoded = await deps.decode(file);
  } catch {
    throw new BlogImageError("图片无法读取，可能已损坏");
  }
  try {
    const size = fitLongEdge(decoded.width, decoded.height);
    const blob = await deps.encode(size.width, size.height, (ctx) => decoded.draw(ctx, size.width, size.height), BLOG_IMAGE_QUALITY);
    if (blob.size > BLOG_IMAGE_MAX_BYTES) throw new BlogImageError("压缩后仍超过 10MB，请换一张小一点的图");
    return blob;
  } finally {
    decoded.close?.();
  }
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

/** 文件名 → 图片说明(去扩展名、去方括号)。 */
export function imageAltFromName(name: string): string {
  return (name.replace(/\.[^.]+$/, "").replace(/[[\]\n]/g, " ").trim() || "图片").slice(0, 60);
}

// ── Markdown 工具栏 ────────────────────────────────────────────────────

export type TextEdit = { value: string; selectionStart: number; selectionEnd: number };
export type ToolbarAction = "heading" | "bold" | "list" | "ordered" | "quote" | "code" | "link";

function lineBounds(value: string, start: number, end: number) {
  const lineStart = value.lastIndexOf("\n", start - 1) + 1;
  const nl = value.indexOf("\n", end);
  return { lineStart, lineEnd: nl < 0 ? value.length : nl };
}

/** 对当前选区应用一个工具栏动作,返回新文本与选区。 */
export function applyToolbar(edit: TextEdit, action: ToolbarAction): TextEdit {
  const { value, selectionStart: s, selectionEnd: e } = edit;
  const selected = value.slice(s, e);
  const wrap = (before: string, after: string, placeholder: string) => {
    const inner = selected || placeholder;
    const next = value.slice(0, s) + before + inner + after + value.slice(e);
    return { value: next, selectionStart: s + before.length, selectionEnd: s + before.length + inner.length };
  };
  if (action === "bold") return wrap("**", "**", "加粗文字");
  if (action === "code") return selected.includes("\n") ? wrap("```\n", "\n```", "代码") : wrap("`", "`", "代码");
  if (action === "link") {
    const inner = selected || "链接文字";
    const next = `${value.slice(0, s)}[${inner}](https://)${value.slice(e)}`;
    const urlStart = s + inner.length + 3;
    return { value: next, selectionStart: urlStart, selectionEnd: urlStart + 8 };
  }
  const { lineStart, lineEnd } = lineBounds(value, s, e);
  const lines = value.slice(lineStart, lineEnd).split("\n");
  const prefixed = lines.map((line, index) => {
    if (action === "heading") return `## ${line.replace(/^#{1,6}\s*/, "")}`;
    if (action === "list") return `- ${line}`;
    if (action === "ordered") return `${index + 1}. ${line}`;
    return `> ${line}`;
  });
  const block = prefixed.join("\n");
  const next = value.slice(0, lineStart) + block + value.slice(lineEnd);
  return { value: next, selectionStart: lineStart, selectionEnd: lineStart + block.length };
}

/** 在光标处插入一段(独占一段,前后空行)。 */
export function insertBlock(edit: TextEdit, block: string): TextEdit {
  const { value, selectionStart: s, selectionEnd: e } = edit;
  const before = value.slice(0, s);
  const after = value.slice(e);
  const lead = before === "" || before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  const tail = after === "" || after.startsWith("\n\n") ? "" : after.startsWith("\n") ? "\n" : "\n\n";
  const next = before + lead + block + tail + after;
  const caret = before.length + lead.length + block.length;
  return { value: next, selectionStart: caret, selectionEnd: caret };
}

// ── 本地草稿 ────────────────────────────────────────────────────────────

export type BlogDraft = {
  title: string;
  summary: string;
  category: CommunityTutorialCategory;
  bodyMarkdown: string;
};

export const EMPTY_BLOG_DRAFT: BlogDraft = { title: "", summary: "", category: "general", bodyMarkdown: "" };

export function blogDraftKey(): string {
  return "oc:blog-draft";
}

export function loadBlogDraft(key: string): (BlogDraft & { savedAt: number }) | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<BlogDraft> & { savedAt?: number };
    if (typeof parsed.bodyMarkdown !== "string") return null;
    return {
      title: typeof parsed.title === "string" ? parsed.title : "",
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
      category: BLOG_CATEGORIES.some((c) => c.value === parsed.category) ? (parsed.category as CommunityTutorialCategory) : "general",
      bodyMarkdown: parsed.bodyMarkdown,
      savedAt: typeof parsed.savedAt === "number" ? parsed.savedAt : Date.now(),
    };
  } catch {
    return null;
  }
}

export function saveBlogDraft(key: string, draft: BlogDraft, now = Date.now()): boolean {
  try {
    window.localStorage.setItem(key, JSON.stringify({ ...draft, savedAt: now }));
    return true;
  } catch {
    return false;
  }
}

export function clearBlogDraft(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // 无痕模式等:草稿只是便利,删不掉不影响投稿。
  }
}

export function isEmptyDraft(draft: BlogDraft): boolean {
  return !draft.title.trim() && !draft.summary.trim() && !draft.bodyMarkdown.trim();
}

// ── 我的投稿状态 ────────────────────────────────────────────────────────

export type BlogMineStage = "ai" | "human" | "published" | "rejected" | "withdrawn" | "takedown" | "draft";

export function blogMineStage(item: Pick<CommunityTutorialMine, "status" | "needsHuman">): BlogMineStage {
  if (item.status === "pending") return item.needsHuman === false ? "ai" : "human";
  if (item.status === "approved") return "published";
  if (item.status === "rejected") return "rejected";
  if (item.status === "takedown") return "takedown";
  if (item.status === "draft") return "draft";
  return "withdrawn";
}

/** 轮询期间状态变化 → toast 文案;没有变化返回 null。 */
export function blogStageChangeMessage(title: string, before: BlogMineStage, after: BlogMineStage): string | null {
  if (before === after) return null;
  if (after === "published") return `「${title}」已通过审核并发布`;
  if (after === "rejected") return `「${title}」未通过审核，可以查看原因`;
  if (after === "human" && before === "ai") return `「${title}」已转人工复核`;
  return null;
}

/** 已发布帖的修改在哪一步:AI 审核中 / 转人工 / 没通过;没有在审或没通过的修改为 null。 */
export type BlogEditStage = "ai" | "human" | "rejected";

export function blogEditStage(item: Pick<CommunityTutorialMine, "status" | "edit">): BlogEditStage | null {
  const edit = item.edit;
  if (item.status !== "approved" || !edit) return null;
  if (edit.status === "rejected") return "rejected";
  return edit.needsHuman ? "human" : "ai";
}

/** 轮询期间修改的审核结果出来了 → toast 文案(修改通过时 edit 变成 null)。 */
export function blogEditChangeMessage(title: string, before: BlogEditStage | null, after: BlogEditStage | null): string | null {
  if (before === after || before === null || before === "rejected") return null;
  if (after === null) return `「${title}」的修改已通过，线上已换成新版本`;
  if (after === "rejected") return `「${title}」的修改未通过，线上仍是原版`;
  if (after === "human" && before === "ai") return `「${title}」的修改已转人工复核`;
  return null;
}

/** 这篇投稿能不能由作者修改(快照教程、已撤回、被下架的不行)。 */
export function blogCanEdit(item: Pick<CommunityTutorialMine, "status" | "kind">): boolean {
  if (item.kind === "snapshot") return false;
  return item.status === "pending" || item.status === "rejected" || item.status === "approved";
}

/** 打开编辑器修改时的起点:已发布帖有没通过 / 在审的修改,就从那一版接着改。 */
export function blogEditSeed(item: CommunityTutorialMine): BlogDraft {
  const from = item.status === "approved" && item.edit ? item.edit : item;
  return { title: from.title, summary: from.summary, category: from.category, bodyMarkdown: from.bodyMarkdown };
}

/** 修改模式的本机草稿单独存,不覆盖「写一篇经验」的新稿草稿。 */
export function blogEditDraftKey(id: string): string {
  return `oc:blog-edit:${id}`;
}
