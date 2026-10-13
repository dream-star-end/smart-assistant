/**
 * 哔哩哔哩组件（OCV5-402）→ Markdown：复制、导出、组件关闭或渲染失败时用。
 *
 * 标题、评论、弹幕、字幕都是第三方文字，一律经 mdText 转义（规则见 pluginMarkdown.ts），链接经 mdUrl；
 * 原文里的 ``` 围栏、HTML、链接写法只能显示成文字。
 */
import { type BiliSpec, type BiliVideoItem, clock, peakOf, progressText } from "./biliSchema";
import { mdText, mdUrl } from "./pluginMarkdown";
import { countText } from "./pluginSchema";

function linked(text: string, url: string | undefined): string {
  return url ? `[${mdText(text)}](${mdUrl(url)})` : mdText(text);
}

function head(title: string | undefined, subtitle: string | undefined): string[] {
  return [...(title ? [`**${mdText(title)}**`] : []), ...(subtitle ? [mdText(subtitle)] : []), ...(title || subtitle ? [""] : [])];
}

function foot(source: string | undefined, note: string | undefined): string[] {
  return [...(note ? ["", `> ${mdText(note)}`] : []), ...(source ? ["", `来源:${mdText(source)}`] : [])];
}

function counts(items: [string, number | undefined][]): string {
  return items
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k} ${countText(v)}`)
    .join(" · ");
}

function videoMeta(v: BiliVideoItem): string {
  return [
    v.author ? `UP ${mdText(v.author)}` : undefined,
    counts([
      ["播放", v.play],
      ["弹幕", v.danmaku],
      ["点赞", v.likes],
    ]) || undefined,
    clock(v.durationSec),
    v.pubdate ? mdText(v.pubdate) : undefined,
    progressText(v),
    v.viewedAt ? `${mdText(v.viewedAt)} 看过` : undefined,
    v.favAt ? `${mdText(v.favAt)} 收藏` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}

function joinLines(lines: string[]): string {
  return lines.join("\n").trim();
}

export function biliToMarkdown(spec: BiliSpec): string {
  switch (spec.type) {
    case "bili_videos":
      return joinLines([
        ...head(spec.title ?? "B 站视频", spec.subtitle),
        ...spec.items.map((v, i) => {
          const meta = videoMeta(v);
          return `${i + 1}. ${linked(v.title, v.url)}${meta ? `(${meta})` : ""}`;
        }),
        ...foot(spec.source, spec.note),
      ]);
    case "bili_rank":
      return joinLines([
        ...head(spec.title ?? "B 站排行榜", spec.subtitle),
        ...spec.items.map((v) => {
          const meta = [v.author ? `UP ${mdText(v.author)}` : undefined, counts([["播放", v.play]]) || undefined, v.score !== undefined ? `综合分 ${countText(v.score)}` : undefined]
            .filter(Boolean)
            .join(" · ");
          return `${v.rank}. ${linked(v.title, v.url)}${meta ? `(${meta})` : ""}`;
        }),
        ...foot(spec.source, spec.note),
      ]);
    case "bili_video": {
      const st = spec.stats;
      const stat = counts([
        ["播放", st.view],
        ["弹幕", st.danmaku],
        ["评论", st.reply],
        ["收藏", st.favorite],
        ["投币", st.coin],
        ["分享", st.share],
        ["点赞", st.like],
      ]);
      const meta = [spec.author ? `UP ${mdText(spec.author)}` : undefined, spec.category ? mdText(spec.category) : undefined, clock(spec.durationSec), spec.pubdate ? mdText(spec.pubdate) : undefined]
        .filter(Boolean)
        .join(" · ");
      return joinLines([
        `**${linked(spec.title, spec.url)}**`,
        ...(spec.subtitle ? [mdText(spec.subtitle)] : []),
        ...(meta ? [meta] : []),
        ...(stat ? [stat] : []),
        ...(spec.desc ? ["", ...spec.desc.split("\n").map((l) => `> ${mdText(l)}`)] : []),
        ...(spec.pages.length > 1 ? ["", ...spec.pages.map((p) => `- P${p.page} ${mdText(p.part)}${p.durationSec !== undefined ? `(${clock(p.durationSec)})` : ""}`)] : []),
        ...foot(spec.source, spec.note),
      ]);
    }
    case "bili_comments":
      return joinLines([
        ...head(spec.title ?? (spec.total !== undefined ? `评论(共 ${countText(spec.total)} 条)` : "评论"), spec.subtitle),
        ...spec.items.flatMap((c) => {
          const meta = [counts([["赞", c.likes], ["回复", c.replies]]) || undefined, c.time ? mdText(c.time) : undefined].filter(Boolean).join(" · ");
          return [`**${mdText(c.user ?? "B 站用户")}**${c.level !== undefined ? ` Lv${c.level}` : ""}${meta ? ` · ${meta}` : ""}`, ...c.text.split("\n").map((l) => `> ${mdText(l)}`), ""];
        }),
        ...(spec.url ? [linked("在 B 站查看全部评论", spec.url)] : []),
        ...foot(spec.source, spec.note),
      ]);
    case "bili_danmaku": {
      const peak = peakOf(spec);
      const peakLine =
        peak?.fromSec !== undefined && peak.toSec !== undefined ? `弹幕最密集:${clock(peak.fromSec)}–${clock(peak.toSec)}` : undefined;
      return joinLines([
        ...head(spec.title ?? (spec.total !== undefined ? `弹幕(共 ${countText(spec.total)} 条)` : "弹幕"), spec.subtitle),
        ...(peakLine ? [peakLine, ""] : []),
        ...spec.items.map((d) => `- ${clock(d.t)} ${mdText(d.text)}`),
        ...foot(spec.source, spec.note),
      ]);
    }
    case "bili_subtitle":
      return joinLines([
        ...head(spec.title ?? `字幕${spec.lang ? `(${spec.lang})` : ""}`, spec.subtitle),
        ...spec.lines.map((l) => `${clock(l.from)} ${mdText(l.text)}`),
        ...(spec.url ? ["", linked("在 B 站观看", spec.url)] : []),
        ...foot(spec.source, spec.note),
      ]);
  }
}
