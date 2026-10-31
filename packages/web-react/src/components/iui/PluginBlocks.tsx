/**
 * Intelligent UI —— 插件专属组件（OCV5-393）：微博动态 / 微博热搜、知乎回答 / 知乎热榜、飞书日程 / 飞书文档。
 *
 * - 数据全部来自块里的字段（模型照抄插件 JSON 结果）；组件不补数据，缺的字段就不显示。
 * - 每个插件一种强调色（--plg-accent），只用在品牌标记、名次和链接上，正文仍走主题色，明暗主题都可读。
 * - 手机优先：390px 宽下单列、图片 3 列九宫格、长文默认折叠；外链新窗口打开，不带来源页信息。
 */
import { type ReactNode, useState } from "react";
import { zonedDayIndex } from "../../lib/displayTime";
import { cn } from "../../lib/utils";
import {
  type FeishuDocSpec,
  type FeishuEventsSpec,
  type HotItem,
  type WeiboHotSpec,
  type WeiboPost,
  type WeiboPostsSpec,
  type ZhihuAnswersSpec,
  type ZhihuHotSpec,
  countText,
  endText,
  groupEventsByDay,
  hm,
  isCancelled,
} from "./pluginSchema";
import { Frame, Media } from "./shell";
import { specToMarkdown } from "./toMarkdown";

type BlockProps<S> = { spec: S; notes: string[]; streaming: boolean; nested?: boolean };

const COLLAPSED = 10;
const LONG_TEXT = 140;

export function ExtLink({ href, className, children }: { href?: string; className?: string; children: ReactNode }) {
  if (!href) return <span className={className}>{children}</span>;
  return (
    <a className={cn("oc-plg-link", className)} href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

export function Counts({ items }: { items: [string, number | undefined][] }) {
  const shown = items.filter(([, v]) => v !== undefined);
  if (shown.length === 0) return null;
  return (
    <span className="oc-plg-counts">
      {shown.map(([label, v]) => (
        <span key={label}>
          {label} <b className="tabular-nums">{countText(v)}</b>
        </span>
      ))}
    </span>
  );
}

export function FoldText({ text, className }: { text: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > LONG_TEXT;
  return (
    <div className={cn("oc-plg-text", className)}>
      <p className={cn(long && !open && "is-folded")}>{text}</p>
      {long && (
        <button type="button" className="oc-plg-fold" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? "收起" : "展开全文"}
        </button>
      )}
    </div>
  );
}

export function MoreButton({ total, expanded, unit, onToggle }: { total: number; expanded: boolean; unit: string; onToggle: () => void }) {
  if (total <= COLLAPSED) return null;
  return (
    <button type="button" className="oc-mkt-more" onClick={onToggle} aria-expanded={expanded}>
      {expanded ? "收起" : `显示全部 ${total} ${unit}`}
    </button>
  );
}

// ── 微博 ──────────────────────────────────────────────────────────────

function Post({ p }: { p: WeiboPost }) {
  const name = p.authorName ?? "微博用户";
  return (
    <li className="oc-plg-post">
      <div className="oc-plg-post-head">
        <span className="oc-plg-avatar" aria-hidden>
          {name.slice(0, 1)}
        </span>
        <span className="min-w-0">
          <span className="oc-plg-author">
            {name}
            {p.verified && (
              <span className="oc-plg-verified" title="已认证" role="img" aria-label="已认证">
                V
              </span>
            )}
          </span>
          {p.createdAt && <span className="oc-plg-meta">{p.createdAt}</span>}
        </span>
      </div>
      <FoldText text={p.text} />
      {p.images.length > 0 && (
        <div className={cn("oc-plg-images", p.images.length === 1 && "is-single")}>
          {p.images.map((src, i) => (
            <Media key={src} src={src} alt={`${name} 的配图 ${i + 1}`} className="oc-plg-image" />
          ))}
        </div>
      )}
      <div className="oc-plg-post-foot">
        <Counts
          items={[
            ["转发", p.repostCount],
            ["评论", p.commentCount],
            ["赞", p.likeCount],
          ]}
        />
        {p.url && (
          <ExtLink href={p.url} className="oc-plg-open">
            在微博打开
          </ExtLink>
        )}
      </div>
    </li>
  );
}

export function WeiboPostsBlock({ spec, notes, streaming, nested }: BlockProps<WeiboPostsSpec>) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? spec.items : spec.items.slice(0, COLLAPSED);
  return (
    <Frame
      kind="weibo_posts"
      title={spec.title ?? "微博"}
      subtitle={spec.subtitle}
      nested={nested}
      source={spec.source}
      note={spec.note}
      notes={notes}
      streaming={streaming}
      className="oc-plg is-weibo"
      copyText={() => specToMarkdown(spec)}
    >
      <ul className="oc-plg-posts">
        {shown.map((p, i) => (
          <Post key={`${p.url ?? ""}:${i}`} p={p} />
        ))}
      </ul>
      <MoreButton total={spec.items.length} expanded={expanded} unit="条" onToggle={() => setExpanded((v) => !v)} />
    </Frame>
  );
}

function HotList({ kind, brand, spec, notes, streaming, nested, unit }: BlockProps<WeiboHotSpec | ZhihuHotSpec> & { kind: string; brand: string; unit: string }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? spec.items : spec.items.slice(0, COLLAPSED);
  return (
    <Frame
      kind={kind}
      title={spec.title ?? (kind === "weibo_hot" ? "微博热搜" : "知乎热榜")}
      subtitle={spec.subtitle}
      nested={nested}
      source={spec.source}
      note={spec.note}
      notes={notes}
      streaming={streaming}
      className={cn("oc-plg", brand)}
      copyText={() => specToMarkdown(spec)}
    >
      <ol className="oc-plg-hot">
        {shown.map((h) => (
          <HotRow key={`${h.rank}:${h.title}`} h={h} unit={unit} />
        ))}
      </ol>
      <MoreButton total={spec.items.length} expanded={expanded} unit="条" onToggle={() => setExpanded((v) => !v)} />
    </Frame>
  );
}

function HotRow({ h, unit }: { h: HotItem; unit: string }) {
  return (
    <li className="oc-plg-hot-row">
      <span className={cn("oc-plg-rank tabular-nums", h.rank <= 3 && "is-top")} aria-label={`第 ${h.rank} 名`}>
        {h.rank}
      </span>
      <span className="oc-plg-hot-main">
        <ExtLink href={h.url} className="oc-plg-hot-title">
          {h.title}
        </ExtLink>
        {h.excerpt && <span className="oc-plg-meta oc-plg-hot-excerpt">{h.excerpt}</span>}
      </span>
      {h.label && <span className="oc-plg-tag">{h.label}</span>}
      {h.hotValue !== undefined && (
        <span className="oc-plg-heat tabular-nums">
          {countText(h.hotValue)}
          {unit}
        </span>
      )}
    </li>
  );
}

export function WeiboHotBlock(props: BlockProps<WeiboHotSpec>) {
  return <HotList {...props} kind="weibo_hot" brand="is-weibo" unit="" />;
}

// ── 知乎 ──────────────────────────────────────────────────────────────

export function ZhihuHotBlock(props: BlockProps<ZhihuHotSpec>) {
  return <HotList {...props} kind="zhihu_hot" brand="is-zhihu" unit=" 热度" />;
}

export function ZhihuAnswersBlock({ spec, notes, streaming, nested }: BlockProps<ZhihuAnswersSpec>) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? spec.items : spec.items.slice(0, COLLAPSED);
  const q = spec.question;
  return (
    <Frame
      kind="zhihu_answers"
      title={spec.title ?? (q ? undefined : "知乎回答")}
      subtitle={spec.subtitle}
      nested={nested}
      source={spec.source}
      note={spec.note}
      notes={notes}
      streaming={streaming}
      className="oc-plg is-zhihu"
      copyText={() => specToMarkdown(spec)}
    >
      {q && (
        <div className="oc-plg-question">
          <span className="oc-plg-brand" aria-hidden>
            知
          </span>
          <div className="min-w-0">
            <ExtLink href={q.url} className="oc-plg-question-title">
              {q.title}
            </ExtLink>
            {q.detail && <p className="oc-plg-meta">{q.detail}</p>}
            <Counts
              items={[
                ["回答", q.answerCount],
                ["关注", q.followerCount],
              ]}
            />
          </div>
        </div>
      )}
      <ul className="oc-plg-answers">
        {shown.map((a, i) => (
          <li key={`${a.url ?? ""}:${i}`} className="oc-plg-answer">
            <div className="oc-plg-post-head">
              <span className="oc-plg-avatar" aria-hidden>
                {(a.authorName ?? "匿").slice(0, 1)}
              </span>
              <span className="min-w-0">
                <span className="oc-plg-author">{a.authorName ?? "匿名用户"}</span>
                {a.headline && <span className="oc-plg-meta">{a.headline}</span>}
              </span>
            </div>
            <FoldText text={a.excerpt} />
            <div className="oc-plg-post-foot">
              {a.voteCount !== undefined && (
                <span className="oc-plg-vote tabular-nums">
                  <span aria-hidden>▲</span> 赞同 {countText(a.voteCount)}
                </span>
              )}
              <Counts items={[["评论", a.commentCount]]} />
              {a.url && (
                <ExtLink href={a.url} className="oc-plg-open">
                  阅读全文
                </ExtLink>
              )}
            </div>
          </li>
        ))}
      </ul>
      <MoreButton total={spec.items.length} expanded={expanded} unit="个回答" onToggle={() => setExpanded((v) => !v)} />
    </Frame>
  );
}

// ── 飞书 ──────────────────────────────────────────────────────────────

const WEEKDAY = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function dayLabel(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  if (!y || !m || !d) return day;
  const civil = Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
  const diff = civil - zonedDayIndex(new Date());
  const rel = diff === 0 ? "今天" : diff === 1 ? "明天" : diff === -1 ? "昨天" : undefined;
  const wd = WEEKDAY[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${m}月${d}日 ${wd}${rel ? ` · ${rel}` : ""}`;
}

export function FeishuEventsBlock({ spec, notes, streaming, nested }: BlockProps<FeishuEventsSpec>) {
  const days = groupEventsByDay(spec.items);
  return (
    <Frame
      kind="feishu_events"
      title={spec.title ?? "飞书日程"}
      subtitle={spec.subtitle ?? `${spec.items.length} 个日程`}
      nested={nested}
      source={spec.source}
      note={spec.note}
      notes={notes}
      streaming={streaming}
      className="oc-plg is-feishu"
      copyText={() => specToMarkdown(spec)}
    >
      <div className="oc-plg-agenda">
        {days.map((g) => (
          <section key={g.day} className="oc-plg-day">
            <h4 className="oc-plg-day-label">{dayLabel(g.day)}</h4>
            <ul>
              {g.items.map((e, i) => {
                const cancelled = isCancelled(e.status);
                return (
                  <li key={`${e.startTime}:${i}`} className={cn("oc-plg-event", cancelled && "is-cancelled")}>
                    <span className="oc-plg-event-time tabular-nums">
                      {hm(e.startTime)}
                      {e.endTime && <span className="oc-plg-meta"> – {endText(e.startTime, e.endTime)}</span>}
                    </span>
                    <span className="oc-plg-event-bar" aria-hidden />
                    <span className="min-w-0">
                      <span className="oc-plg-event-title">{e.summary}</span>
                      {(e.location || cancelled) && (
                        <span className="oc-plg-meta">{[cancelled ? "已取消" : undefined, e.location].filter(Boolean).join(" · ")}</span>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </Frame>
  );
}

export function FeishuDocBlock({ spec, notes, streaming, nested }: BlockProps<FeishuDocSpec>) {
  return (
    <Frame
      kind="feishu_doc"
      subtitle={spec.subtitle}
      nested={nested}
      source={spec.source}
      note={spec.note}
      notes={notes}
      streaming={streaming}
      className="oc-plg is-feishu"
      copyText={() => specToMarkdown(spec)}
    >
      <div className="oc-plg-doc">
        <span className="oc-plg-brand" aria-hidden>
          文
        </span>
        <div className="min-w-0">
          <ExtLink href={spec.url} className="oc-plg-doc-title">
            {spec.title}
          </ExtLink>
          <span className="oc-plg-meta">{["飞书文档", spec.updatedAt ? `更新于 ${spec.updatedAt}` : undefined].filter(Boolean).join(" · ")}</span>
        </div>
      </div>
      {spec.points.length > 0 && (
        <ul className="oc-plg-points">
          {spec.points.map((p, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 要点可能重复,按位置区分
            <li key={i}>{p}</li>
          ))}
        </ul>
      )}
      {spec.excerpt && <FoldText text={spec.excerpt} className="oc-plg-doc-excerpt" />}
    </Frame>
  );
}
