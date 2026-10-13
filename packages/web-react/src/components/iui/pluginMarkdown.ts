/**
 * 插件专属组件（OCV5-393）→ Markdown：复制、导出、组件关闭或渲染失败时用。
 *
 * 这些组件的文字来自第三方（微博正文、知乎回答、飞书文档……），转 Markdown 时**一律转义**：
 * 原文里的 ``` 围栏、HTML 标签、链接写法都只能显示成文字，不能变成可执行的 htmlpreview / mermaid 块或链接。
 * 链接地址已由 schema 限定为 http(s) 且不含空白；这里再把括号和尖括号编码掉，不让它截断 Markdown 链接。
 */
import { type HotItem, type PluginSpec, countText, endText, groupEventsByDay, hm, isCancelled } from "./pluginSchema";

/**
 * CommonMark 允许反斜杠转义任意 ASCII 标点；把会改变结构的那些都转义。
 * 例外：方括号写成 HTML 实体、圆括号不转义——聊天渲染会把 \\( \\) \\[ \\] 当成公式定界符
 * （mathDelimiters.ts），方括号转义后也就组不成链接，圆括号单独出现不构成任何结构。
 * $ 也转义：remark-math 会把一对 $ 当成行内公式。
 */
export function mdText(s: string): string {
  return s.replace(/[\\`*_{}<>#+\-.!|~=:$]/g, "\\$&").replace(/\[/g, "&#91;").replace(/\]/g, "&#93;");
}

const URL_ESCAPES: Record<string, string> = { "(": "%28", ")": "%29", "<": "%3C", ">": "%3E" };

function mdUrl(u: string): string {
  // encodeURIComponent 不编码括号，所以显式映射。
  return u.replace(/[()<>]/g, (c) => URL_ESCAPES[c]!).replace(/\s/g, (c) => encodeURIComponent(c));
}

function head(title: string | undefined, subtitle: string | undefined): string[] {
  return [...(title ? [`**${mdText(title)}**`] : []), ...(subtitle ? [mdText(subtitle)] : []), ...(title || subtitle ? [""] : [])];
}

function foot(source: string | undefined, note: string | undefined): string[] {
  return [...(note ? ["", `> ${mdText(note)}`] : []), ...(source ? ["", `来源:${mdText(source)}`] : [])];
}

function linked(text: string, url: string | undefined): string {
  return url ? `[${mdText(text)}](${mdUrl(url)})` : mdText(text);
}

function counts(items: [string, number | undefined][]): string {
  return items
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k} ${countText(v)}`)
    .join(" · ");
}

function hotLines(items: HotItem[], unit: string): string[] {
  return items.map((h) => {
    const extra = [h.label ? mdText(h.label) : undefined, h.hotValue !== undefined ? `${countText(h.hotValue)}${unit}` : undefined].filter(Boolean).join(" · ");
    return `${h.rank}. ${linked(h.title, h.url)}${extra ? `(${extra})` : ""}${h.excerpt ? ` —— ${mdText(h.excerpt)}` : ""}`;
  });
}

function quoteLines(text: string): string[] {
  return text.split("\n").map((l) => `> ${mdText(l)}`);
}

export function pluginToMarkdown(spec: PluginSpec): string {
  switch (spec.type) {
    case "weibo_posts":
      return [
        ...head(spec.title ?? "微博", spec.subtitle),
        ...spec.items.flatMap((p) => {
          const meta = counts([
            ["转发", p.repostCount],
            ["评论", p.commentCount],
            ["赞", p.likeCount],
          ]);
          return [
            `**${mdText(p.authorName ?? "微博用户")}**${p.createdAt ? ` · ${mdText(p.createdAt)}` : ""}`,
            ...quoteLines(p.text),
            ...p.images.map((src, i) => `![配图 ${i + 1}](${mdUrl(src)})`),
            ...(meta || p.url ? [[meta, p.url ? linked("原文", p.url) : ""].filter(Boolean).join(" · ")] : []),
            "",
          ];
        }),
        ...foot(spec.source, spec.note),
      ]
        .join("\n")
        .trim();
    case "weibo_hot":
      return [...head(spec.title ?? "微博热搜", spec.subtitle), ...hotLines(spec.items, ""), ...foot(spec.source, spec.note)].join("\n");
    case "zhihu_hot":
      return [...head(spec.title ?? "知乎热榜", spec.subtitle), ...hotLines(spec.items, " 热度"), ...foot(spec.source, spec.note)].join("\n");
    case "zhihu_answers": {
      const q = spec.question;
      const qMeta = q
        ? counts([
            ["回答", q.answerCount],
            ["关注", q.followerCount],
          ])
        : "";
      return [
        ...head(spec.title, spec.subtitle),
        ...(q ? [`**${linked(q.title, q.url)}**`, ...(q.detail ? [mdText(q.detail)] : []), ...(qMeta ? [qMeta] : []), ""] : []),
        ...spec.items.flatMap((a) => {
          const meta = counts([
            ["赞同", a.voteCount],
            ["评论", a.commentCount],
          ]);
          return [
            `**${mdText(a.authorName ?? "匿名用户")}**${a.headline ? ` · ${mdText(a.headline)}` : ""}`,
            ...quoteLines(a.excerpt),
            ...(meta || a.url ? [[meta, a.url ? linked("阅读全文", a.url) : ""].filter(Boolean).join(" · ")] : []),
            "",
          ];
        }),
        ...foot(spec.source, spec.note),
      ]
        .join("\n")
        .trim();
    }
    case "feishu_events":
      return [
        ...head(spec.title ?? "飞书日程", spec.subtitle),
        ...groupEventsByDay(spec.items).flatMap((g) => [
          `**${g.day}**`,
          ...g.items.map(
            (e) =>
              `- ${hm(e.startTime)}${e.endTime ? `–${endText(e.startTime, e.endTime)}` : ""} ${mdText(e.summary)}${isCancelled(e.status) ? "(已取消)" : ""}${e.location ? ` · ${mdText(e.location)}` : ""}`,
          ),
          "",
        ]),
        ...foot(spec.source, spec.note),
      ]
        .join("\n")
        .trim();
    case "feishu_doc":
      return [
        `**${linked(spec.title, spec.url)}**`,
        ...(spec.subtitle ? [mdText(spec.subtitle)] : []),
        ...(spec.updatedAt ? [`更新于 ${mdText(spec.updatedAt)}`] : []),
        "",
        ...spec.points.map((p) => `- ${mdText(p)}`),
        ...(spec.excerpt ? ["", ...quoteLines(spec.excerpt)] : []),
        ...foot(spec.source, spec.note),
      ]
        .join("\n")
        .trim();
  }
}
