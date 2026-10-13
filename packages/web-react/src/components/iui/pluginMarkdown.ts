/**
 * 插件专属组件（OCV5-393）→ Markdown：复制、导出、组件关闭或渲染失败时用。
 */
import { type HotItem, type PluginSpec, countText, groupEventsByDay, hm, isCancelled } from "./pluginSchema";

function head(title: string | undefined, subtitle: string | undefined): string[] {
  return [...(title ? [`**${title}**`] : []), ...(subtitle ? [subtitle] : []), ...(title || subtitle ? [""] : [])];
}

function foot(source: string | undefined, note: string | undefined): string[] {
  return [...(note ? ["", `> ${note}`] : []), ...(source ? ["", `来源:${source}`] : [])];
}

function linked(text: string, url: string | undefined): string {
  return url ? `[${text}](${url})` : text;
}

function counts(items: [string, number | undefined][]): string {
  return items
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k} ${countText(v)}`)
    .join(" · ");
}

function hotLines(items: HotItem[], unit: string): string[] {
  return items.map((h) => {
    const extra = [h.label, h.hotValue !== undefined ? `${countText(h.hotValue)}${unit}` : undefined].filter(Boolean).join(" · ");
    return `${h.rank}. ${linked(h.title, h.url)}${extra ? `(${extra})` : ""}${h.excerpt ? ` —— ${h.excerpt}` : ""}`;
  });
}

function quoteLines(text: string): string[] {
  return text.split("\n").map((l) => `> ${l}`);
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
            `**${p.authorName ?? "微博用户"}**${p.createdAt ? ` · ${p.createdAt}` : ""}`,
            ...quoteLines(p.text),
            ...p.images.map((src, i) => `![配图 ${i + 1}](${src})`),
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
      return [
        ...head(spec.title, spec.subtitle),
        ...(q
          ? [
              `**${linked(q.title, q.url)}**`,
              ...(q.detail ? [q.detail] : []),
              ...(counts([
                ["回答", q.answerCount],
                ["关注", q.followerCount],
              ])
                ? [
                    counts([
                      ["回答", q.answerCount],
                      ["关注", q.followerCount],
                    ]),
                  ]
                : []),
              "",
            ]
          : []),
        ...spec.items.flatMap((a) => {
          const meta = counts([
            ["赞同", a.voteCount],
            ["评论", a.commentCount],
          ]);
          return [
            `**${a.authorName ?? "匿名用户"}**${a.headline ? ` · ${a.headline}` : ""}`,
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
              `- ${hm(e.startTime)}${e.endTime ? `–${hm(e.endTime)}` : ""} ${e.summary}${isCancelled(e.status) ? "(已取消)" : ""}${e.location ? ` · ${e.location}` : ""}`,
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
        ...(spec.subtitle ? [spec.subtitle] : []),
        ...(spec.updatedAt ? [`更新于 ${spec.updatedAt}`] : []),
        "",
        ...spec.points.map((p) => `- ${p}`),
        ...(spec.excerpt ? ["", ...quoteLines(spec.excerpt)] : []),
        ...foot(spec.source, spec.note),
      ]
        .join("\n")
        .trim();
  }
}
