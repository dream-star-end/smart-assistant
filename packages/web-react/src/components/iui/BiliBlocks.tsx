/**
 * Intelligent UI —— 哔哩哔哩插件专属组件（OCV5-402）：视频卡片列表、排行榜、视频详情、评论、弹幕、字幕。
 *
 * - 数据全部来自块里的字段（模型照抄 `oc-plugin call bili …` 的结果）；组件不补数据，缺的字段就不显示。
 * - 视觉沿用插件组件的公共样式（oc-plg-*），B 站用自己的强调色（.is-bili），明暗主题都只用 token。
 * - 手机优先：390px 宽下封面缩到 112px、元信息换行；长列表默认显示 10 条；外链新窗口打开、不带来源页。
 * - 封面走 Media（referrerPolicy=no-referrer，B 站图床允许空 Referer），失败时换成色块，不影响正文。
 */
import { useState } from "react";
import { cn } from "../../lib/utils";
import {
  type BiliCommentsSpec,
  type BiliDanmakuSpec,
  type BiliRankSpec,
  type BiliSubtitleSpec,
  type BiliVideoItem,
  type BiliVideoSpec,
  type BiliVideosSpec,
  clock,
  peakOf,
  progressText,
} from "./biliSchema";
import { Counts, ExtLink, FoldText, MoreButton } from "./PluginBlocks";
import { countText } from "./pluginSchema";
import { Frame, Media } from "./shell";
import { specToMarkdown } from "./toMarkdown";

type BlockProps<S> = { spec: S; notes: string[]; streaming: boolean; nested?: boolean };

const COLLAPSED = 10;
const LINES_COLLAPSED = 12;

function frameProps<S extends { title?: string; subtitle?: string; source?: string; note?: string }>(
  spec: S,
  kind: string,
  fallbackTitle: string | undefined,
  rest: Omit<BlockProps<S>, "spec">,
) {
  return {
    kind,
    title: spec.title ?? fallbackTitle,
    subtitle: spec.subtitle,
    nested: rest.nested,
    source: spec.source,
    note: spec.note,
    notes: rest.notes,
    streaming: rest.streaming,
    className: "oc-plg is-bili",
  };
}

function Cover({ v, className }: { v: Pick<BiliVideoItem, "cover" | "title" | "durationSec">; className?: string }) {
  const dur = clock(v.durationSec);
  return (
    <span className={cn("oc-bili-cover", className)}>
      <Media src={v.cover} alt={`${v.title} 的封面`} fallbackText="B" />
      {dur && <span className="oc-bili-duration tabular-nums">{dur}</span>}
    </span>
  );
}

function VideoRow({ v, rank }: { v: BiliVideoItem; rank?: number }) {
  const progress = progressText(v);
  const when = v.viewedAt ? `${v.viewedAt} 看过` : v.favAt ? `${v.favAt} 收藏` : v.pubdate;
  return (
    <li className="oc-bili-row">
      {rank !== undefined && (
        <span className={cn("oc-plg-rank tabular-nums", rank <= 3 && "is-top")} aria-label={`第 ${rank} 名`}>
          {rank}
        </span>
      )}
      <Cover v={v} />
      <span className="oc-bili-main">
        <ExtLink href={v.url} className="oc-bili-title">
          {v.title}
        </ExtLink>
        {v.author && <span className="oc-plg-meta oc-bili-up">UP {v.author}</span>}
        <span className="oc-bili-line">
          <Counts
            items={[
              ["播放", v.play],
              ["弹幕", v.danmaku],
              ["点赞", v.likes],
            ]}
          />
          {when && <span className="oc-plg-meta oc-bili-when">{when}</span>}
          {progress && <span className="oc-plg-tag">{progress}</span>}
        </span>
      </span>
    </li>
  );
}

export function BiliVideosBlock({ spec, ...rest }: BlockProps<BiliVideosSpec>) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? spec.items : spec.items.slice(0, COLLAPSED);
  return (
    <Frame {...frameProps(spec, "bili_videos", "B 站视频", rest)} copyText={() => specToMarkdown(spec)}>
      <ul className="oc-bili-list">
        {shown.map((v, i) => (
          <VideoRow key={`${v.bvid ?? v.title}:${i}`} v={v} />
        ))}
      </ul>
      <MoreButton total={spec.items.length} expanded={expanded} unit="个" onToggle={() => setExpanded((x) => !x)} />
    </Frame>
  );
}

export function BiliRankBlock({ spec, ...rest }: BlockProps<BiliRankSpec>) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? spec.items : spec.items.slice(0, COLLAPSED);
  return (
    <Frame {...frameProps(spec, "bili_rank", "B 站排行榜", rest)} copyText={() => specToMarkdown(spec)}>
      <ol className="oc-bili-list is-rank">
        {shown.map((v) => (
          <VideoRow key={`${v.rank}:${v.bvid ?? v.title}`} v={v} rank={v.rank} />
        ))}
      </ol>
      <MoreButton total={spec.items.length} expanded={expanded} unit="名" onToggle={() => setExpanded((x) => !x)} />
    </Frame>
  );
}

const STAT_LABELS: [keyof BiliVideoSpec["stats"], string][] = [
  ["view", "播放"],
  ["danmaku", "弹幕"],
  ["reply", "评论"],
  ["like", "点赞"],
  ["coin", "投币"],
  ["favorite", "收藏"],
  ["share", "分享"],
];

export function BiliVideoBlock({ spec, ...rest }: BlockProps<BiliVideoSpec>) {
  const [allPages, setAllPages] = useState(false);
  const stats = STAT_LABELS.filter(([k]) => spec.stats[k] !== undefined);
  const pages = allPages ? spec.pages : spec.pages.slice(0, COLLAPSED);
  return (
    <Frame {...frameProps({ ...spec, title: undefined }, "bili_video", undefined, rest)} copyText={() => specToMarkdown(spec)}>
      <div className="oc-bili-hero">
        <Cover v={spec} className="is-hero" />
        <div className="oc-bili-hero-main">
          <ExtLink href={spec.url} className="oc-bili-hero-title">
            {spec.title}
          </ExtLink>
          <span className="oc-plg-meta">
            {[spec.author ? `UP ${spec.author}` : undefined, spec.category, spec.pubdate].filter(Boolean).join(" · ")}
          </span>
          {spec.url && (
            <ExtLink href={spec.url} className="oc-plg-open">
              在 B 站观看
            </ExtLink>
          )}
        </div>
      </div>
      {stats.length > 0 && (
        <dl className="oc-bili-stats">
          {stats.map(([k, label]) => (
            <div key={k}>
              <dt>{label}</dt>
              <dd className="tabular-nums">{countText(spec.stats[k])}</dd>
            </div>
          ))}
        </dl>
      )}
      {spec.desc && <FoldText text={spec.desc} className="oc-bili-desc" />}
      {spec.pages.length > 1 && (
        <>
          <ol className="oc-bili-pages">
            {pages.map((p) => (
              <li key={p.page}>
                <span className="oc-plg-meta tabular-nums">P{p.page}</span>
                <span className="oc-bili-part">{p.part}</span>
                {p.durationSec !== undefined && <span className="oc-plg-meta tabular-nums">{clock(p.durationSec)}</span>}
              </li>
            ))}
          </ol>
          <MoreButton total={spec.pages.length} expanded={allPages} unit="个分 P" onToggle={() => setAllPages((x) => !x)} />
        </>
      )}
    </Frame>
  );
}

export function BiliCommentsBlock({ spec, ...rest }: BlockProps<BiliCommentsSpec>) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? spec.items : spec.items.slice(0, COLLAPSED);
  const fallback = spec.total !== undefined ? `评论 · 共 ${countText(spec.total)} 条` : "评论";
  return (
    <Frame {...frameProps(spec, "bili_comments", fallback, rest)} copyText={() => specToMarkdown(spec)}>
      <ul className="oc-plg-answers">
        {shown.map((c) => {
          const name = c.user ?? "B 站用户";
          return (
            <li key={`${name}:${c.time ?? ""}:${c.text.slice(0, 32)}`} className="oc-plg-answer">
              <div className="oc-plg-post-head">
                <span className="oc-plg-avatar" aria-hidden>
                  {name.slice(0, 1)}
                </span>
                <span className="min-w-0">
                  <span className="oc-plg-author">
                    {name}
                    {c.level !== undefined && <span className="oc-bili-level">Lv{c.level}</span>}
                  </span>
                  {c.time && <span className="oc-plg-meta">{c.time}</span>}
                </span>
              </div>
              <FoldText text={c.text} />
              <div className="oc-plg-post-foot">
                <Counts
                  items={[
                    ["赞", c.likes],
                    ["回复", c.replies],
                  ]}
                />
              </div>
            </li>
          );
        })}
      </ul>
      <MoreButton total={spec.items.length} expanded={expanded} unit="条" onToggle={() => setExpanded((x) => !x)} />
      {spec.url && (
        <div className="oc-bili-foot-link">
          <ExtLink href={spec.url} className="oc-plg-open">
            在 B 站查看全部评论
          </ExtLink>
        </div>
      )}
    </Frame>
  );
}

function DensityBars({ spec }: { spec: BiliDanmakuSpec }) {
  if (spec.density.length === 0) return null;
  const max = Math.max(1, ...spec.density);
  const peak = peakOf(spec);
  const peakText = peak?.fromSec !== undefined && peak.toSec !== undefined ? `${clock(peak.fromSec)}–${clock(peak.toSec)}` : undefined;
  return (
    <div className="oc-bili-density-wrap">
      <div
        className="oc-bili-density"
        role="img"
        aria-label={`弹幕密度分布，共 ${spec.density.length} 段${peakText ? `，最密集在 ${peakText}` : ""}`}
      >
        {spec.density.map((n, i) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: 固定顺序的时间分段
            key={i}
            className={cn("oc-bili-bar", i === peak?.index && "is-peak")}
            style={{ height: `${Math.max(4, Math.round((n / max) * 100))}%` }}
          />
        ))}
      </div>
      <div className="oc-bili-axis oc-plg-meta tabular-nums">
        <span>0:00</span>
        {peakText && <span className="oc-bili-peak">高能 {peakText}</span>}
        <span>{clock(spec.maxT) ?? ""}</span>
      </div>
    </div>
  );
}

export function BiliDanmakuBlock({ spec, ...rest }: BlockProps<BiliDanmakuSpec>) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? spec.items : spec.items.slice(0, LINES_COLLAPSED);
  const fallback = spec.total !== undefined ? `弹幕 · 共 ${countText(spec.total)} 条` : "弹幕";
  return (
    <Frame {...frameProps(spec, "bili_danmaku", fallback, rest)} copyText={() => specToMarkdown(spec)}>
      <DensityBars spec={spec} />
      {shown.length > 0 && (
        <ul className="oc-bili-lines">
          {shown.map((d, i) => (
            <li key={`${d.t}:${i}`}>
              <span className="oc-plg-meta tabular-nums">{clock(d.t)}</span>
              <span>{d.text}</span>
            </li>
          ))}
        </ul>
      )}
      {spec.items.length > LINES_COLLAPSED && (
        <button type="button" className="oc-mkt-more" onClick={() => setExpanded((x) => !x)} aria-expanded={expanded}>
          {expanded ? "收起" : `显示全部 ${spec.items.length} 条`}
        </button>
      )}
    </Frame>
  );
}

export function BiliSubtitleBlock({ spec, ...rest }: BlockProps<BiliSubtitleSpec>) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? spec.lines : spec.lines.slice(0, LINES_COLLAPSED);
  return (
    <Frame {...frameProps(spec, "bili_subtitle", `字幕${spec.lang ? ` · ${spec.lang}` : ""}`, rest)} copyText={() => specToMarkdown(spec)}>
      <ul className="oc-bili-lines">
        {shown.map((l, i) => (
          <li key={`${l.from}:${i}`}>
            <span className="oc-plg-meta tabular-nums">{clock(l.from)}</span>
            <span>{l.text}</span>
          </li>
        ))}
      </ul>
      {spec.lines.length > LINES_COLLAPSED && (
        <button type="button" className="oc-mkt-more" onClick={() => setExpanded((x) => !x)} aria-expanded={expanded}>
          {expanded ? "收起" : `显示全部 ${spec.lines.length} 行`}
        </button>
      )}
      {spec.url && (
        <div className="oc-bili-foot-link">
          <ExtLink href={spec.url} className="oc-plg-open">
            在 B 站观看
          </ExtLink>
        </div>
      )}
    </Frame>
  );
}
