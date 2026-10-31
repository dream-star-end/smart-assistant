/**
 * Intelligent UI —— 插件专属组件的 schema（OCV5-393）：微博、知乎、飞书。
 *
 * 这些组件的定义**不在**通用协议（系统提示里的 INTELLIGENT_UI 段）里：模型只有在加载对应插件、
 * 并读了该插件的组件定义文件后才会写它们（`@openclaude/protocol` 的 PLUGIN_UI_COMPONENTS 登记了
 * 类型 → 插件 → 定义文件；同花顺的行情组件见 marketSchema.ts，由它的 CLI 直接产出）。
 *
 * 字段名尽量沿用插件 JSON 结果里的名字（authorName / likeCount / hotValue / startTime …），
 * 模型照抄即可，不用改写数字。与 schema.ts 同一套原则：能修就修（丢非法行、数字字符串转数字），
 * 修过的记进 notes；修不了才降级。链接只接受 http(s)。
 */

import { formatZoned, zonedParts } from "../../lib/displayTime";

type Ctx = { notes: string[]; partial: boolean };
type Sub = { subtitle?: string };

export const PLUGIN_LIMITS = {
  posts: 20,
  postText: 2_000,
  postImages: 9,
  hotItems: 50,
  answers: 20,
  answerText: 1_200,
  events: 60,
  docPoints: 12,
} as const;

export type WeiboPost = {
  authorName?: string;
  verified?: boolean;
  createdAt?: string;
  text: string;
  images: string[];
  likeCount?: number;
  commentCount?: number;
  repostCount?: number;
  url?: string;
};
export type WeiboPostsSpec = Sub & { type: "weibo_posts"; title?: string; items: WeiboPost[]; source?: string; note?: string };

export type HotItem = { rank: number; title: string; url?: string; hotValue?: number; label?: string; excerpt?: string };
export type WeiboHotSpec = Sub & { type: "weibo_hot"; title?: string; items: HotItem[]; source?: string; note?: string };
export type ZhihuHotSpec = Sub & { type: "zhihu_hot"; title?: string; items: HotItem[]; source?: string; note?: string };

export type ZhihuAnswer = {
  authorName?: string;
  headline?: string;
  excerpt: string;
  voteCount?: number;
  commentCount?: number;
  url?: string;
};
export type ZhihuAnswersSpec = Sub & {
  type: "zhihu_answers";
  title?: string;
  question?: { title: string; url?: string; detail?: string; answerCount?: number; followerCount?: number };
  items: ZhihuAnswer[];
  source?: string;
  note?: string;
};

export type FeishuEvent = { summary: string; startTime: string; endTime?: string; status?: string; location?: string };
export type FeishuEventsSpec = Sub & { type: "feishu_events"; title?: string; items: FeishuEvent[]; source?: string; note?: string };

export type FeishuDocSpec = Sub & {
  type: "feishu_doc";
  title: string;
  docId?: string;
  url?: string;
  updatedAt?: string;
  points: string[];
  excerpt?: string;
  source?: string;
  note?: string;
};

export type PluginSpec = WeiboPostsSpec | WeiboHotSpec | ZhihuHotSpec | ZhihuAnswersSpec | FeishuEventsSpec | FeishuDocSpec;

// ── 小工具（与 marketSchema.ts 同语义；各自带一份，避免互相引用私有实现） ──

function s(v: unknown, max = 300): string | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return undefined;
  const t = v.replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** 正文：保留换行（微博、回答摘录是多段文字），只压缩行内空白。 */
function body(v: unknown, max: number, ctx: Ctx): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v
    .split("\n")
    .map((l) => l.replace(/[ \t　]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!t) return undefined;
  if (t.length <= max) return t;
  ctx.notes.push("长文已截断");
  return `${t.slice(0, max - 1)}…`;
}

/** 计数：接受数字或数字字符串（含千分位、「万」「亿」）。 */
function count(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined;
  if (typeof v !== "string") return undefined;
  const m = /^\s*([\d,.]+)\s*(万|亿)?\s*$/.exec(v);
  if (!m) return undefined;
  const x = Number(m[1]!.replace(/,/g, ""));
  if (!Number.isFinite(x) || x < 0) return undefined;
  return Math.round(x * (m[2] === "亿" ? 1e8 : m[2] === "万" ? 1e4 : 1));
}

function link(v: unknown): string | undefined {
  const t = s(v, 2048);
  return t && /^https?:\/\/[^\s]+$/i.test(t) ? t : undefined;
}

function list(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function opt<K extends string, V>(k: K, v: V | undefined): { [P in K]?: V } {
  return (v === undefined ? {} : { [k]: v }) as { [P in K]?: V };
}

function capList<T>(items: T[], max: number, ctx: Ctx, unit: string): T[] {
  if (items.length <= max) return items;
  ctx.notes.push(`只显示前 ${max} ${unit}`);
  return items.slice(0, max);
}

function common(raw: Record<string, unknown>) {
  return { ...opt("title", s(raw.title, 120)), ...opt("source", s(raw.source, 200)), ...opt("note", s(raw.note, 300)) };
}

/** ISO 时间或常见的「2026-10-13 09:30」写法 → 能被 Date 解析的字符串；解析不了的丢掉。 */
function when(v: unknown): string | undefined {
  const t = s(v, 64);
  if (!t) return undefined;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(t) ? t.replace(" ", "T") : t;
  return Number.isNaN(new Date(iso).getTime()) ? undefined : iso;
}

// ── 微博 ──────────────────────────────────────────────────────────────

export function weiboPosts(raw: Record<string, unknown>, ctx: Ctx): WeiboPostsSpec | null {
  const items: WeiboPost[] = [];
  for (const it of list(raw.items ?? raw.posts)) {
    const o = obj(it);
    if (!o) continue;
    const text = body(o.text, PLUGIN_LIMITS.postText, ctx);
    if (!text) continue;
    const images: string[] = [];
    for (const im of list(o.images)) {
      const u = link(typeof im === "string" ? im : obj(im)?.url);
      if (u && !images.includes(u)) images.push(u);
    }
    if (images.length > PLUGIN_LIMITS.postImages) ctx.notes.push(`每条最多显示 ${PLUGIN_LIMITS.postImages} 张图`);
    items.push({
      ...opt("authorName", s(o.authorName ?? o.author ?? o.user, 60)),
      ...opt("verified", typeof o.verified === "boolean" ? o.verified : undefined),
      ...opt("createdAt", s(o.createdAt ?? o.time, 40)),
      text,
      images: images.slice(0, PLUGIN_LIMITS.postImages),
      ...opt("likeCount", count(o.likeCount ?? o.likes)),
      ...opt("commentCount", count(o.commentCount ?? o.comments)),
      ...opt("repostCount", count(o.repostCount ?? o.reposts)),
      ...opt("url", link(o.url)),
    });
  }
  if (items.length === 0 && !ctx.partial) return null;
  return { type: "weibo_posts", ...common(raw), items: capList(items, PLUGIN_LIMITS.posts, ctx, "条") };
}

function hotItems(raw: Record<string, unknown>, ctx: Ctx, titleKeys: string[]): HotItem[] {
  const items: HotItem[] = [];
  for (const [i, it] of list(raw.items ?? raw.searches).entries()) {
    const o = obj(it);
    if (!o) continue;
    const title = s(titleKeys.map((k) => o[k]).find((v) => typeof v === "string"), 200);
    if (!title) continue;
    const rank = count(o.rank);
    items.push({
      rank: rank && rank > 0 ? rank : i + 1,
      title,
      ...opt("url", link(o.url)),
      ...opt("hotValue", count(o.hotValue ?? o.hot)),
      ...opt("label", s(o.label ?? o.tag, 8)),
      ...opt("excerpt", s(o.excerpt, 200)),
    });
  }
  return capList(items, PLUGIN_LIMITS.hotItems, ctx, "条");
}

export function weiboHot(raw: Record<string, unknown>, ctx: Ctx): WeiboHotSpec | null {
  const items = hotItems(raw, ctx, ["keyword", "title", "word"]);
  if (items.length === 0 && !ctx.partial) return null;
  return { type: "weibo_hot", ...common(raw), items };
}

// ── 知乎 ──────────────────────────────────────────────────────────────

export function zhihuHot(raw: Record<string, unknown>, ctx: Ctx): ZhihuHotSpec | null {
  const items = hotItems(raw, ctx, ["title", "keyword"]);
  if (items.length === 0 && !ctx.partial) return null;
  return { type: "zhihu_hot", ...common(raw), items };
}

export function zhihuAnswers(raw: Record<string, unknown>, ctx: Ctx): ZhihuAnswersSpec | null {
  const q = obj(raw.question);
  const qTitle = q ? s(q.title, 200) : undefined;
  const items: ZhihuAnswer[] = [];
  for (const it of list(raw.items ?? raw.answers)) {
    const o = obj(it);
    if (!o) continue;
    const excerpt = body(o.excerpt ?? o.text, PLUGIN_LIMITS.answerText, ctx);
    if (!excerpt) continue;
    items.push({
      ...opt("authorName", s(o.authorName ?? o.author, 60)),
      ...opt("headline", s(o.headline, 120)),
      excerpt,
      ...opt("voteCount", count(o.voteCount ?? o.votes)),
      ...opt("commentCount", count(o.commentCount ?? o.comments)),
      ...opt("url", link(o.url)),
    });
  }
  if (items.length === 0 && !qTitle && !ctx.partial) return null;
  return {
    type: "zhihu_answers",
    ...common(raw),
    ...opt(
      "question",
      q && qTitle
        ? {
            title: qTitle,
            ...opt("url", link(q.url)),
            ...opt("detail", s(q.detail, 400)),
            ...opt("answerCount", count(q.answerCount)),
            ...opt("followerCount", count(q.followerCount)),
          }
        : undefined,
    ),
    items: capList(items, PLUGIN_LIMITS.answers, ctx, "个回答"),
  };
}

// ── 飞书 ──────────────────────────────────────────────────────────────

export function feishuEvents(raw: Record<string, unknown>, ctx: Ctx): FeishuEventsSpec | null {
  const items: FeishuEvent[] = [];
  for (const it of list(raw.items ?? raw.events)) {
    const o = obj(it);
    if (!o) continue;
    const startTime = when(o.startTime ?? o.start);
    if (!startTime) continue;
    items.push({
      summary: s(o.summary ?? o.title, 200) ?? "（无标题）",
      startTime,
      ...opt("endTime", when(o.endTime ?? o.end)),
      ...opt("status", s(o.status, 20)),
      ...opt("location", s(o.location, 120)),
    });
  }
  if (items.length === 0 && !ctx.partial) return null;
  items.sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
  return { type: "feishu_events", ...common(raw), items: capList(items, PLUGIN_LIMITS.events, ctx, "个日程") };
}

export function feishuDoc(raw: Record<string, unknown>, ctx: Ctx): FeishuDocSpec | null {
  const title = s(raw.title, 200);
  if (!title) return null;
  const points: string[] = [];
  for (const p of list(raw.points ?? raw.outline)) {
    const t = s(p, 200);
    if (t) points.push(t);
  }
  return {
    type: "feishu_doc",
    ...common(raw),
    title,
    ...opt("docId", s(raw.docId, 128)),
    ...opt("url", link(raw.url)),
    ...opt("updatedAt", s(raw.updatedAt, 40)),
    points: capList(points, PLUGIN_LIMITS.docPoints, ctx, "条要点"),
    ...opt("excerpt", body(raw.excerpt, 600, ctx)),
  };
}

export const PLUGIN_VALIDATORS = {
  weibo_posts: weiboPosts,
  weibo_hot: weiboHot,
  zhihu_hot: zhihuHot,
  zhihu_answers: zhihuAnswers,
  feishu_events: feishuEvents,
  feishu_doc: feishuDoc,
} as const;

/** 只收不会和通用组件撞名的别名（通用组件的别名在 schema.ts）。 */
export const PLUGIN_ALIASES: Record<string, keyof typeof PLUGIN_VALIDATORS> = {
  weibo: "weibo_posts",
  weibo_feed: "weibo_posts",
  weibo_hot_search: "weibo_hot",
  weibo_hotsearch: "weibo_hot",
  zhihu_hot_list: "zhihu_hot",
  zhihu_question: "zhihu_answers",
  feishu_calendar: "feishu_events",
  feishu_agenda: "feishu_events",
  feishu_document: "feishu_doc",
};

// ── 显示用 ────────────────────────────────────────────────────────────

/** 中文计数：9876 → 9876；12345 → 1.2万；1.5e8 → 1.5亿。 */
export function countText(v: number | undefined): string | undefined {
  if (v === undefined) return undefined;
  if (v >= 1e8) return `${trim1(v / 1e8)}亿`;
  if (v >= 1e4) return `${trim1(v / 1e4)}万`;
  return String(v);
}

function trim1(x: number): string {
  return x.toFixed(1).replace(/\.0$/, "");
}

/** 日程按显示时区的公历日分组。 */
export function groupEventsByDay(items: readonly FeishuEvent[]): { day: string; items: FeishuEvent[] }[] {
  const out: { day: string; items: FeishuEvent[] }[] = [];
  for (const e of items) {
    const d = new Date(e.startTime);
    const day = Number.isNaN(d.getTime()) ? "" : formatZoned(d, "date");
    const last = out[out.length - 1];
    if (last && last.day === day) last.items.push(e);
    else out.push({ day, items: [e] });
  }
  return out;
}

export function hm(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return formatZoned(d, "time");
}

/** 结束时间：与开始在同一天只写时分；跨天写上日期（「10月15日 11:00」），不把多日日程显示成当天。 */
export function endText(startIso: string, endIso: string): string {
  const s = new Date(startIso);
  const e = new Date(endIso);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return hm(endIso);
  const sp = zonedParts(s);
  const ep = zonedParts(e);
  const sameDay = sp.year === ep.year && sp.month === ep.month && sp.day === ep.day;
  return sameDay ? hm(endIso) : `${ep.month}月${ep.day}日 ${hm(endIso)}`;
}

export function isCancelled(status: string | undefined): boolean {
  return !!status && /cancel|取消/i.test(status);
}
