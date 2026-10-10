/**
 * Intelligent UI 文字类组件(OCV5-361 第三轮):来源、大纲 / 思维导图、成稿。
 */
import { Check, ChevronRight, Copy, ExternalLink, Icon } from "lucide-react";
import { useMemo, useState } from "react";
import { cn } from "../../lib/utils";
import { countWords, diffText } from "./diff";
import { uiIcon } from "./icons";
import type { DraftSpec, OutlineNode, OutlineSpec, SourcesSpec } from "./schema";
import { Frame, Inline, Segmented } from "./shell";
import { specToMarkdown } from "./toMarkdown";

type BlockProps<S> = { spec: S; notes: string[]; streaming: boolean; nested?: boolean };

/** 站点名 → 固定的色调(同一站点每次同色),六种和方块网格共用。 */
function toneOf(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 6;
}

// ── 来源 ──────────────────────────────────────────────────────────────

const SOURCES_FOLD = 6;

export function SourcesBlock({ spec, notes, streaming, nested }: BlockProps<SourcesSpec>) {
  const [all, setAll] = useState(false);
  const fold = !streaming && spec.items.length > SOURCES_FOLD + 1;
  const shown = fold && !all ? spec.items.slice(0, SOURCES_FOLD - 1) : spec.items;
  return (
    <Frame
      kind="sources"
      title={spec.title ?? "参考来源"}
      subtitle={spec.subtitle}
      notes={notes}
      streaming={streaming}
      nested={nested}
      copyText={() => specToMarkdown(spec)}
    >
      <ol className="oc-iui-sources">
        {shown.map((s, i) => {
          const site = s.site ?? s.title;
          const body = (
            <>
              <span className="oc-iui-source-num" aria-hidden>
                {i + 1}
              </span>
              <span className="oc-iui-source-main">
                <span className="oc-iui-source-title">
                  <span>{s.title}</span>
                  {s.url && <ExternalLink size={13} aria-hidden className="oc-iui-source-ext" />}
                </span>
                {(s.site || s.date) && (
                  <span className="oc-iui-source-meta">
                    <span className={cn("oc-iui-source-avatar", `is-tone-${toneOf(site)}`)} aria-hidden>
                      {Array.from(site)[0]?.toUpperCase()}
                    </span>
                    {[s.site, s.date].filter(Boolean).join(" · ")}
                  </span>
                )}
                {s.note && (
                  <span className="oc-iui-source-note">
                    <Inline text={s.note} />
                  </span>
                )}
              </span>
            </>
          );
          return (
            <li key={`${i}:${s.url ?? s.title}`}>
              {s.url ? (
                <a className="oc-iui-source is-link" href={s.url} target="_blank" rel="noreferrer noopener" aria-label={`${i + 1}. ${s.title}${s.site ? `(${s.site})` : ""},在新标签页打开`}>
                  {body}
                </a>
              ) : (
                <div className="oc-iui-source">{body}</div>
              )}
            </li>
          );
        })}
      </ol>
      {fold && (
        <div className="oc-iui-more">
          <button type="button" className="oc-iui-disclosure" aria-expanded={all} onClick={() => setAll((v) => !v)}>
            {all ? "收起" : `显示全部 ${spec.items.length} 个来源`}
          </button>
        </div>
      )}
    </Frame>
  );
}

// ── 大纲 / 思维导图 ───────────────────────────────────────────────────

function countNodes(nodes: OutlineNode[]): number {
  return nodes.reduce((n, x) => n + 1 + countNodes(x.children), 0);
}

/** 节点较多时,第三层及以下默认收起(第一眼看结构,不被细节淹没)。 */
function initialCollapsed(items: OutlineNode[]): Set<string> {
  const out = new Set<string>();
  if (countNodes(items) <= 30) return out;
  const walk = (nodes: OutlineNode[], path: string, depth: number) =>
    nodes.forEach((n, i) => {
      const p = `${path}${i}.`;
      if (depth >= 1 && n.children.length > 0) out.add(p);
      walk(n.children, p, depth + 1);
    });
  walk(items, "", 0);
  return out;
}

function allPaths(items: OutlineNode[]): string[] {
  const out: string[] = [];
  const walk = (nodes: OutlineNode[], path: string) =>
    nodes.forEach((n, i) => {
      const p = `${path}${i}.`;
      if (n.children.length > 0) out.push(p);
      walk(n.children, p);
    });
  walk(items, "");
  return out;
}

function TreeList({
  nodes,
  path,
  depth,
  collapsed,
  toggle,
}: {
  nodes: OutlineNode[];
  path: string;
  depth: number;
  collapsed: Set<string>;
  toggle: (p: string) => void;
}) {
  return (
    <ul className={cn("oc-iui-tree", depth === 0 && "is-root")}>
      {nodes.map((n, i) => {
        const p = `${path}${i}.`;
        const kids = n.children.length > 0;
        const open = kids && !collapsed.has(p);
        const label = (
          <span className="oc-iui-tree-text">
            <span className="oc-iui-tree-title">
              <Inline text={n.title} />
              {kids && !open && <span className="oc-iui-tree-count">{countNodes(n.children)}</span>}
            </span>
            {n.detail && (
              <span className="oc-iui-tree-detail">
                <Inline text={n.detail} />
              </span>
            )}
          </span>
        );
        return (
          <li key={p} className={cn(`is-depth-${Math.min(depth, 3)}`, open && "is-open")}>
            {kids ? (
              <button type="button" className="oc-iui-tree-row" aria-expanded={open} onClick={() => toggle(p)}>
                <ChevronRight size={14} aria-hidden className="oc-iui-tree-chevron" />
                {depth === 0 && <span className="oc-iui-tree-num">{i + 1}</span>}
                {label}
              </button>
            ) : (
              <div className="oc-iui-tree-row">
                <span className="oc-iui-tree-dot" aria-hidden />
                {depth === 0 && <span className="oc-iui-tree-num">{i + 1}</span>}
                {label}
              </div>
            )}
            {open && <TreeList nodes={n.children} path={p} depth={depth + 1} collapsed={collapsed} toggle={toggle} />}
          </li>
        );
      })}
    </ul>
  );
}

function MindMap({ spec }: { spec: OutlineSpec }) {
  return (
    <div className="oc-iui-mind">
      <div className="oc-iui-mind-root">
        <span>{spec.title ?? "主题"}</span>
      </div>
      <div className="oc-iui-mind-branches" data-count={spec.items.length}>
        {spec.items.map((b, i) => (
          <section key={`${i}:${b.title}`} className={cn("oc-iui-mind-branch", `is-tone-${i % 6}`)} aria-label={b.title}>
            <h5 className="oc-iui-mind-head">
              <Inline text={b.title} />
            </h5>
            {b.detail && (
              <p className="oc-iui-mind-detail">
                <Inline text={b.detail} />
              </p>
            )}
            {b.children.length > 0 && (
              <ul className="oc-iui-mind-list">
                {b.children.map((c, j) => (
                  <li key={`${j}:${c.title}`}>
                    <span className="oc-iui-mind-item">
                      <Inline text={c.title} />
                    </span>
                    {c.children.length > 0 && (
                      <span className="oc-iui-mind-sub">
                        {c.children.map((g) => g.title).join(" · ")}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}

const VIEWS = ["tree", "map"] as const;

export function OutlineBlock({ spec, notes, streaming, nested }: BlockProps<OutlineSpec>) {
  const [view, setView] = useState<OutlineSpec["view"]>(spec.view);
  const [collapsed, setCollapsed] = useState(() => initialCollapsed(spec.items));
  const paths = useMemo(() => allPaths(spec.items), [spec.items]);
  const toggle = (p: string) =>
    setCollapsed((s) => {
      const next = new Set(s);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  const anyOpen = paths.some((p) => !collapsed.has(p));
  // 导图只画两层半(第三层并成一行);只有一层时没有可导图的结构,不给切换。
  const canMap = spec.items.length >= 2 && spec.items.some((n) => n.children.length > 0);
  const shownView = canMap ? view : "tree";
  return (
    <Frame
      kind="outline"
      title={spec.title}
      subtitle={spec.subtitle}
      notes={notes}
      streaming={streaming}
      nested={nested}
      copyText={() => specToMarkdown(spec)}
      actions={
        streaming ? undefined : (
          <>
            {shownView === "tree" && paths.length > 1 && (
              <button type="button" className="oc-iui-text-btn" onClick={() => setCollapsed(anyOpen ? new Set(paths) : new Set())}>
                {anyOpen ? "全部收起" : "全部展开"}
              </button>
            )}
            {canMap && (
              <Segmented
                role="radiogroup"
                items={["大纲", "导图"]}
                value={VIEWS.indexOf(shownView)}
                onChange={(i) => setView(VIEWS[i]!)}
                label="显示方式"
                className="is-compact"
              />
            )}
          </>
        )
      }
    >
      {shownView === "map" ? (
        <MindMap spec={spec} />
      ) : (
        <div className="oc-iui-tree-wrap">
          <TreeList nodes={spec.items} path="" depth={0} collapsed={streaming ? new Set() : collapsed} toggle={toggle} />
        </div>
      )}
    </Frame>
  );
}

// ── 成稿 ──────────────────────────────────────────────────────────────

const KIND_LABEL = { email: "邮件", message: "消息", post: "帖子", doc: "文档" } as const;

function CopyTextButton({ getText, label, disabled, primary }: { getText: () => string; label: string; disabled?: boolean; primary?: boolean }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={cn(primary ? "oc-iui-btn is-primary" : "oc-iui-icon-btn")}
      disabled={disabled}
      aria-label={done ? "已复制" : label}
      title={done ? "已复制" : label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(getText());
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* 剪贴板不可用(非安全上下文):静默 */
        }
      }}
    >
      {done ? <Check size={primary ? 15 : 14} aria-hidden /> : <Copy size={primary ? 15 : 14} aria-hidden />}
      {primary && <span>{done ? "已复制" : label}</span>}
    </button>
  );
}

function DiffView({ before, after }: { before: string; after: string }) {
  const segs = useMemo(() => diffText(before, after), [before, after]);
  if (!segs) return <p className="oc-iui-hint">改动太多,无法逐字对比;下面是改后的全文。</p>;
  const added = segs.filter((s) => s.op === "add").reduce((n, s) => n + countWords(s.text), 0);
  const removed = segs.filter((s) => s.op === "del").reduce((n, s) => n + countWords(s.text), 0);
  return (
    <>
      <p className="oc-iui-diff-legend">
        <span className="is-del">删 {removed} 字</span>
        <span className="is-add">增 {added} 字</span>
      </p>
      <div className="oc-iui-draft-text oc-iui-diff">
        {segs.map((s, i) =>
          s.op === "eq" ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: 片段位置即身份
            <span key={i}>{s.text}</span>
          ) : s.op === "add" ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: 片段位置即身份
            <ins key={i}>{s.text}</ins>
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: 片段位置即身份
            <del key={i}>{s.text}</del>
          ),
        )}
      </div>
    </>
  );
}

export function DraftBlock({ spec, notes, streaming, nested }: BlockProps<DraftSpec>) {
  const [active, setActive] = useState(0);
  const [showDiff, setShowDiff] = useState(false);
  const cur = spec.variants[Math.min(active, Math.max(0, spec.variants.length - 1))];
  const words = cur ? countWords(cur.text) : 0;
  const diffing = showDiff && !!spec.original && !streaming && !!cur;
  return (
    <Frame
      kind="draft"
      title={spec.title}
      subtitle={spec.subtitle}
      note={spec.note}
      notes={notes}
      streaming={streaming}
      nested={nested}
      actions={spec.kind ? <span className="oc-iui-chip">{KIND_LABEL[spec.kind]}</span> : undefined}
    >
      {spec.variants.length > 1 && (
        <div className="oc-iui-tabbar">
          <Segmented items={spec.variants.map((v) => v.label)} value={active} onChange={setActive} label="版本" role="radiogroup" />
        </div>
      )}
      {cur && (
        <div className="oc-iui-draft-paper">
          {cur.subject && (
            <div className="oc-iui-draft-subject">
              <span className="oc-iui-draft-subject-label">主题</span>
              <span className="oc-iui-draft-subject-text">{cur.subject}</span>
              {!streaming && <CopyTextButton getText={() => cur.subject ?? ""} label="复制主题" />}
            </div>
          )}
          {diffing ? <DiffView before={spec.original!} after={cur.text} /> : <div className="oc-iui-draft-text">{cur.text}</div>}
        </div>
      )}
      <div className="oc-iui-draft-bar">
        <span className="oc-iui-draft-count" aria-live="polite">
          约 {words} 字
        </span>
        <span className="oc-iui-draft-actions">
          {spec.original && (
            <button type="button" className="oc-iui-text-btn" aria-pressed={showDiff} disabled={streaming} onClick={() => setShowDiff((v) => !v)}>
              <Icon iconNode={uiIcon("diff")} size={14} aria-hidden />
              对比原文
            </button>
          )}
          <CopyTextButton getText={() => cur?.text ?? ""} label="复制全文" disabled={streaming || !cur} primary />
        </span>
      </div>
    </Frame>
  );
}
