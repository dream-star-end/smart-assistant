/**
 * SwarmBoardRows — Memoized row components for SwarmBoardDrawer.
 *
 * Extracted out of SwarmBoardDrawer.tsx to keep file sizes lean and prevent
 * full-tree re-renders on long swarms (80–120 Markdown posts):
 *  - `InteractivePostBody` / `PostRow` wrapped in `React.memo` with stable callbacks
 *    and `useEffect`-based DOM ref registration (no inline ref closure churn)
 *  - CSS `max-h` visual folding with gradient fade instead of hard 900-char slicing
 *    so Markdown code fences and tables never break mid-block
 *  - First-class semantic callout & badge treatment for `[done]`, `[stall]`,
 *    `[control:kill]`, and `[steer]` posts
 *  - `RosterMemberRow` wrapped in `React.memo` without concurrent `oc-live-status-shine`
 */
import type { SwarmBoardPost, SwarmMemberSnapshot } from "@openclaude/protocol/browser";
import {
  Activity,
  Check,
  Clock3,
  Copy,
  GitBranch,
  Hash,
  Quote,
  Wrench,
} from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../../lib/utils";
import { Markdown } from "../Markdown";
import { Badge, useToast } from "../ui";
import { ModelFamilyIcon } from "../ui/ModelFamilyIcons";
import {
  classifySwarmPost,
  collectSwarmCodeRanges,
  formatPostClock,
  formatTelemetryDuration,
  formatTelemetryTokens,
  hasMemberTelemetry,
  humanizeSwarmModel,
  memberInitial,
  swarmMemberStyle,
  swarmStatusLabel,
  swarmRoleLabel,
  swarmWorkspaceBadge,
  tokenizeSwarmInlineText,
} from "./swarmUtils";

export function hasRichMarkdown(text: string): boolean {
  return /(?:^|\n)(?:#{1,4}\s|```|~~~|[-*]\s|\d+\.\s|>\s|\|.*\|)|`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\)/.test(
    text,
  );
}

function linkifySwarmPlainSegment(segment: string): string {
  const LINK_RE = /(\[[^\]]*\]\([^)]+\))/g;
  const parts = segment.split(LINK_RE);
  return parts
    .map((part, idx) => {
      if (idx % 2 === 1) return part;
      return tokenizeSwarmInlineText(part)
        .map((tok) => {
          if (tok.kind === "mention") {
            if (tok.target === "all") return `[${tok.value}](#swarm-mention-all)`;
            return `[${tok.value}](#swarm-mention:${encodeURIComponent(tok.target)})`;
          }
          if (tok.kind === "channel_mention") {
            return `[${tok.value}](#swarm-channel:${encodeURIComponent(tok.channel)})`;
          }
          if (tok.kind === "seq") {
            return `[${tok.value}](#swarm-seq:${tok.seq})`;
          }
          return tok.value;
        })
        .join("");
    })
    .join("");
}

/**
 * 将富文本 Markdown 中非代码/非链接区域的 @member、@#channel、#seq 转为页内锚点链接，
 * 以便 Markdown 完整渲染的同时，仍然保持点击聚焦成员 / 切换频道 / 跳转序号的交互能力。
 * 先基于整文识别围栏代码块（``` 与 ~~~）及行内代码区间，再仅对非代码段做链接化。
 * `@all` 使用独立 `#swarm-mention-all` 锚点并禁用误点，与纯文本模式视觉完全一致。
 */
export function linkifySwarmMarkdownTokens(text: string): string {
  const codeRanges = collectSwarmCodeRanges(text);
  if (codeRanges.length === 0) return linkifySwarmPlainSegment(text);
  let out = "";
  let pos = 0;
  for (const [start, end] of codeRanges) {
    if (start > pos) out += linkifySwarmPlainSegment(text.slice(pos, start));
    out += text.slice(start, end);
    pos = end;
  }
  if (pos < text.length) out += linkifySwarmPlainSegment(text.slice(pos));
  return out;
}

export const InteractivePostBody = memo(function InteractivePostBody({
  text,
  onMention,
  onChannel,
  onJumpSeq,
}: {
  text: string;
  onMention: (name: string) => void;
  onChannel: (ch: string) => void;
  onJumpSeq: (seq: number) => void;
}) {
  const rich = useMemo(() => hasRichMarkdown(text), [text]);
  const linkedMarkdown = useMemo(() => (rich ? linkifySwarmMarkdownTokens(text) : ""), [rich, text]);

  if (rich) {
    return (
      <div
        className={cn(
          "prose-sm max-w-none text-body leading-relaxed text-fg",
          "[&_a[href='#swarm-mention-all']]:pointer-events-none [&_a[href='#swarm-mention-all']]:mx-0.5 [&_a[href='#swarm-mention-all']]:inline-flex [&_a[href='#swarm-mention-all']]:cursor-default [&_a[href='#swarm-mention-all']]:items-center [&_a[href='#swarm-mention-all']]:rounded-md [&_a[href='#swarm-mention-all']]:border-0 [&_a[href='#swarm-mention-all']]:bg-warning-soft [&_a[href='#swarm-mention-all']]:px-1.5 [&_a[href='#swarm-mention-all']]:py-0.5 [&_a[href='#swarm-mention-all']]:text-caption [&_a[href='#swarm-mention-all']]:font-medium [&_a[href='#swarm-mention-all']]:text-warning [&_a[href='#swarm-mention-all']]:no-underline",
          "[&_a[href^='#swarm-mention:']]:mx-0.5 [&_a[href^='#swarm-mention:']]:inline-flex [&_a[href^='#swarm-mention:']]:items-center [&_a[href^='#swarm-mention:']]:rounded-md [&_a[href^='#swarm-mention:']]:border-0 [&_a[href^='#swarm-mention:']]:bg-accent-soft [&_a[href^='#swarm-mention:']]:px-1.5 [&_a[href^='#swarm-mention:']]:py-0.5 [&_a[href^='#swarm-mention:']]:text-caption [&_a[href^='#swarm-mention:']]:font-medium [&_a[href^='#swarm-mention:']]:text-accent",
          "[&_a[href^='#swarm-channel:']]:mx-0.5 [&_a[href^='#swarm-channel:']]:inline-flex [&_a[href^='#swarm-channel:']]:items-center [&_a[href^='#swarm-channel:']]:rounded-md [&_a[href^='#swarm-channel:']]:border-0 [&_a[href^='#swarm-channel:']]:bg-info-soft [&_a[href^='#swarm-channel:']]:px-1.5 [&_a[href^='#swarm-channel:']]:py-0.5 [&_a[href^='#swarm-channel:']]:text-caption [&_a[href^='#swarm-channel:']]:font-medium [&_a[href^='#swarm-channel:']]:text-info",
          "[&_a[href^='#swarm-seq:']]:mx-0.5 [&_a[href^='#swarm-seq:']]:inline-flex [&_a[href^='#swarm-seq:']]:items-center [&_a[href^='#swarm-seq:']]:rounded [&_a[href^='#swarm-seq:']]:border-0 [&_a[href^='#swarm-seq:']]:bg-hover [&_a[href^='#swarm-seq:']]:px-1.5 [&_a[href^='#swarm-seq:']]:py-0.5 [&_a[href^='#swarm-seq:']]:font-mono [&_a[href^='#swarm-seq:']]:text-caption [&_a[href^='#swarm-seq:']]:font-medium [&_a[href^='#swarm-seq:']]:text-muted",
        )}
        onClick={(e) => {
          const anchor = (e.target as HTMLElement | null)?.closest("a");
          const href = anchor?.getAttribute("href");
          if (!href || !href.startsWith("#swarm-")) return;
          e.preventDefault();
          if (href === "#swarm-mention-all") return;
          if (href.startsWith("#swarm-mention:")) {
            const target = decodeURIComponent(href.slice("#swarm-mention:".length));
            if (target && target !== "all") onMention(target);
          } else if (href.startsWith("#swarm-channel:")) {
            const ch = decodeURIComponent(href.slice("#swarm-channel:".length));
            if (ch) onChannel(ch);
          } else if (href.startsWith("#swarm-seq:")) {
            const seq = Number.parseInt(href.slice("#swarm-seq:".length), 10);
            if (Number.isFinite(seq) && seq > 0) onJumpSeq(seq);
          }
        }}
      >
        <Markdown>{linkedMarkdown}</Markdown>
      </div>
    );
  }

  const tokens = tokenizeSwarmInlineText(text);
  return (
    <p className="whitespace-pre-wrap break-words text-body leading-relaxed text-fg">
      {tokens.map((tok, idx) => {
        if (tok.kind === "mention") {
          if (tok.target === "all") {
            return (
              <span
                key={idx}
                data-swarm-mention="all"
                className="mx-0.5 inline-flex items-center rounded-md bg-warning-soft px-1.5 py-0.5 text-caption font-medium text-warning"
              >
                {tok.value}
              </span>
            );
          }
          return (
            <button
              key={idx}
              type="button"
              onClick={() => onMention(tok.target)}
              className="mx-0.5 inline-flex items-center rounded-md bg-accent-soft px-1.5 py-0.5 text-caption font-medium text-accent transition-colors hover:bg-accent/20"
            >
              {tok.value}
            </button>
          );
        }
        if (tok.kind === "channel_mention") {
          return (
            <button
              key={idx}
              type="button"
              onClick={() => onChannel(tok.channel)}
              className="mx-0.5 inline-flex items-center rounded-md bg-info-soft px-1.5 py-0.5 text-caption font-medium text-info transition-colors hover:bg-info/20"
            >
              {tok.value}
            </button>
          );
        }
        if (tok.kind === "seq") {
          return (
            <button
              key={idx}
              type="button"
              onClick={() => onJumpSeq(tok.seq)}
              className="mx-0.5 inline-flex items-center rounded bg-hover px-1.5 py-0.5 font-mono text-caption font-medium text-muted transition-colors hover:bg-active hover:text-fg"
            >
              {tok.value}
            </button>
          );
        }
        return <span key={idx}>{tok.value}</span>;
      })}
    </p>
  );
});

export const RosterMemberRow = memo(function RosterMemberRow({
  member,
  activeSwarm,
  selected,
  onSelect,
}: {
  member: SwarmMemberSnapshot;
  activeSwarm: boolean;
  selected: boolean;
  onSelect: (memberName: string) => void;
}) {
  const style = swarmMemberStyle(member.name, member.role);
  const working = member.status === "working" && activeSwarm;
  const killed = member.status === "killed";
  const modelText = humanizeSwarmModel(member.model);
  const wsBadge = swarmWorkspaceBadge(member.workspace);
  const showTelemetry = hasMemberTelemetry(member);
  const elapsedText = formatTelemetryDuration(member.elapsedMs);
  const tokensText = formatTelemetryTokens(member.inputTokens, member.outputTokens);
  const approxPrefix = member.telemetryPartial ? "~" : "";

  return (
    <button
      type="button"
      onClick={() => onSelect(member.name)}
      aria-pressed={selected}
      className={cn(
        "oc-stagger-in oc-hover-lift oc-spring-press flex w-full items-start gap-2.5 rounded-xl border px-2.5 py-2 text-left transition-all duration-150",
        "outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected
          ? "border-accent/45 bg-accent-soft/60 shadow-soft"
          : killed
            ? "border-transparent opacity-60 hover:bg-hover/60"
            : "border-transparent hover:bg-hover/70",
      )}
    >
      <span
        className={cn(
          "relative mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg text-caption font-semibold",
          style.avatar,
        )}
      >
        {memberInitial(member.name)}
        <span
          title={swarmStatusLabel(member.status)}
          className={cn(
            "absolute -bottom-0.5 -right-0.5 size-2 rounded-full ring-2 ring-surface",
            member.failed
              ? "bg-danger"
              : working
                ? "bg-accent"
                : killed
                  ? "bg-faint"
                  : "bg-success",
          )}
        />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-meta font-semibold text-fg">@{member.name}</span>
          <span className="shrink-0 rounded bg-hover px-1 py-0 text-micro text-muted">
            {swarmRoleLabel(member.role)}
          </span>
          {wsBadge && (
            <span
              title={member.workspaceBranch ? `${wsBadge.title} · 分支 ${member.workspaceBranch}` : wsBadge.title}
              className="inline-flex shrink-0 items-center gap-0.5 rounded bg-info-soft px-1 py-0 text-micro font-medium text-info"
            >
              <GitBranch size={9} />
              {wsBadge.label}
            </span>
          )}
          {member.unreadCount > 0 && activeSwarm && (
            <span className="ml-auto shrink-0 rounded-full bg-accent-soft px-1.5 py-0 font-mono text-micro font-medium text-accent tabular-nums">
              +{member.unreadCount}
            </span>
          )}
        </div>
        <div
          className={cn(
            "mt-0.5 truncate text-caption",
            member.failed ? "text-danger" : working ? "font-medium text-accent" : "text-faint",
          )}
          title={member.lastError || member.activity || ""}
        >
          {member.failed
            ? member.lastError || "执行异常"
            : member.activity || swarmStatusLabel(member.status)}
        </div>
        <div className="mt-1 flex items-center gap-2 text-micro text-faint">
          {modelText && (
            <span className="inline-flex min-w-0 items-center gap-1 truncate">
              <ModelFamilyIcon model={member.model ?? modelText} size={13} className="shrink-0 text-muted" />
              <span className="truncate">{modelText}</span>
            </span>
          )}
          {member.stepCount > 0 && (
            <span className="shrink-0 font-mono tabular-nums">{member.stepCount} 步</span>
          )}
          {member.lastPostSeq !== undefined && (
            <span className="shrink-0 font-mono tabular-nums">最近 #{member.lastPostSeq}</span>
          )}
        </div>
        {showTelemetry && (
          <div
            className="mt-1.5 flex flex-wrap items-center gap-1 text-micro text-muted"
            data-testid={`swarm-member-telemetry-${member.name}`}
          >
            {elapsedText && (
              <span
                className="inline-flex items-center gap-0.5 rounded bg-hover px-1.5 py-0.5 font-mono tabular-nums"
                title="成员累计运行耗时"
              >
                <Clock3 size={9} aria-hidden className="text-faint" />
                {approxPrefix}
                {elapsedText}
              </span>
            )}
            {tokensText && (
              <span
                className="inline-flex items-center gap-0.5 rounded bg-hover px-1.5 py-0.5 font-mono tabular-nums"
                title="输入 / 输出 Token 用量"
              >
                <Activity size={9} aria-hidden className="text-faint" />
                {approxPrefix}
                {tokensText}
              </span>
            )}
            {typeof member.toolCalls === "number" && (
              <span
                className="inline-flex items-center gap-0.5 rounded bg-hover px-1.5 py-0.5 font-mono tabular-nums"
                title="工具调用次数"
              >
                <Wrench size={9} aria-hidden className="text-faint" />
                {approxPrefix}
                {member.toolCalls} 次
              </span>
            )}
          </div>
        )}
      </div>
    </button>
  );
});

const LONG_POST_CHAR_THRESHOLD = 720;
const LONG_POST_LINE_THRESHOLD = 14;

export const PostRow = memo(function PostRow({
  post,
  highlighted,
  optimistic = false,
  onMention,
  onChannel,
  onJumpSeq,
  onQuote,
  registerRowRef,
}: {
  post: SwarmBoardPost;
  highlighted: boolean;
  optimistic?: boolean;
  onMention: (name: string) => void;
  onChannel: (ch: string) => void;
  onJumpSeq: (seq: number) => void;
  onQuote?: (post: SwarmBoardPost) => void;
  registerRowRef: (seq: number, el: HTMLDivElement | null) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const toast = useToast();

  useEffect(() => {
    registerRowRef(post.seq, rowRef.current);
    return () => registerRowRef(post.seq, null);
  }, [post.seq, registerRowRef]);

  const style = swarmMemberStyle(post.agent);
  const clock = formatPostClock(post.time);
  const semantic = useMemo(() => classifySwarmPost(post), [post]);
  const isLong = useMemo(() => {
    if (post.text.length > LONG_POST_CHAR_THRESHOLD) return true;
    let lines = 1;
    for (let i = 0; i < post.text.length; i += 1) {
      if (post.text.charCodeAt(i) === 10) {
        lines += 1;
        if (lines > LONG_POST_LINE_THRESHOLD) return true;
      }
    }
    return false;
  }, [post.text]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(post.text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast("复制失败，请手动选中文本复制", "error");
    }
  };

  return (
    <div
      ref={rowRef}
      data-swarm-post-seq={post.seq}
      data-swarm-post-kind={semantic?.kind ?? undefined}
      data-swarm-optimistic={optimistic ? "true" : undefined}
      className={cn(
        "oc-surface-card oc-stagger-in oc-hover-lift group rounded-2xl px-3.5 py-3 transition-all duration-200",
        highlighted
          ? "border-accent bg-accent-soft/40 ring-2 ring-accent/30"
          : semantic
            ? semantic.calloutClass
            : "hover:border-border-strong",
      )}
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="rounded-md bg-hover px-1.5 py-0.5 font-mono text-caption font-semibold text-muted tabular-nums">
          #{post.seq}
        </span>
        <button
          type="button"
          onClick={() => onMention(post.agent)}
          className={cn(
            "inline-flex items-center gap-1 rounded-lg border px-2 py-0.5 text-caption font-semibold transition-opacity hover:opacity-85",
            style.badge,
          )}
        >
          <span>@{post.agent}</span>
        </button>
        {post.channel && post.channel !== "main" && (
          <button
            type="button"
            onClick={() => onChannel(post.channel!)}
            className="inline-flex items-center gap-0.5 rounded-md bg-info-soft px-1.5 py-0.5 text-caption font-medium text-info hover:bg-info/20"
          >
            <Hash size={10} />
            {post.channel}
          </button>
        )}
        {semantic && <Badge tone={semantic.tone}>{semantic.label}</Badge>}
        {optimistic && (
          <Badge tone="info" data-testid={`swarm-post-delivered-${post.seq}`}>
            已投递
          </Badge>
        )}
        <div className="ml-auto flex items-center gap-1">
          {clock && <span className="font-mono text-micro text-faint tabular-nums">{clock}</span>}
          {onQuote && (
            <button
              type="button"
              onClick={() => onQuote(post)}
              aria-label={`引用 #${post.seq} 到主线`}
              title="引用到主输入框"
              data-testid={`swarm-quote-post-${post.seq}`}
              className="flex size-7 items-center justify-center rounded-md text-faint opacity-0 transition-all hover:bg-hover hover:text-fg group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:size-11 [@media(hover:none)]:opacity-100"
            >
              <Quote size={12} />
            </button>
          )}
          <button
            type="button"
            onClick={() => void copy()}
            aria-label="复制讨论内容"
            title="复制"
            className="flex size-7 items-center justify-center rounded-md text-faint opacity-0 transition-all hover:bg-hover hover:text-fg group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:size-11 [@media(hover:none)]:opacity-100"
          >
            {copied ? <Check size={12} className="oc-check-pop text-success" /> : <Copy size={12} />}
          </button>
        </div>
      </div>

      {/* Render complete valid Markdown always; fold visually via CSS max-h + gradient mask */}
      <div
        data-testid={isLong && !expanded ? `swarm-post-folded-${post.seq}` : undefined}
        className={cn("relative", isLong && !expanded && "max-h-72 overflow-hidden")}
      >
        <InteractivePostBody
          text={post.text}
          onMention={onMention}
          onChannel={onChannel}
          onJumpSeq={onJumpSeq}
        />
        {isLong && !expanded && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-surface via-surface/85 to-transparent"
          />
        )}
      </div>

      {isLong && (
        <button
          type="button"
          data-testid={`swarm-post-expand-${post.seq}`}
          onClick={() => setExpanded((v) => !v)}
          className="mt-2 text-caption font-medium text-accent hover:underline"
        >
          {expanded ? "收起长文" : `展开全文（共 ${post.text.length} 字）`}
        </button>
      )}
    </div>
  );
});
