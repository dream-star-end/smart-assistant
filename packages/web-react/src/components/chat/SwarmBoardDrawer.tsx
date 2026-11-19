/**
 * SwarmBoardDrawer — Immersive Studio Workspace for Antigravity native swarms (OCV5-809).
 *
 * Lazy-loaded (zero first-screen gzip cost). Features:
 *  - Split-pane desktop layout (Roster & Live Telemetry rail + Chronological Collaboration Board)
 *    with smooth mobile tab switcher
 *  - Channel tabs (`#main`, `#parser`, ...), member focus filter (posts by or @mentioning member),
 *    and instant full-text search
 *  - Interactive `@mention`, `@#channel`, and `#seq` jump-and-flash tokens
 *  - Markdown rendering for structured posts, copy button, follow-latest auto-scroll,
 *    and keyboard navigation (`Esc`, `[`, `]`)
 */
import * as RD from "@radix-ui/react-dialog";
import type { SwarmBoardPost, SwarmMemberSnapshot, SwarmSnapshot } from "@openclaude/protocol/browser";
import {
  AlertTriangle,
  ArrowDown,
  Check,
  Copy,
  Hash,
  Hexagon,
  MessageSquare,
  Search,
  Users,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../../lib/utils";
import { Markdown } from "../Markdown";
import { Badge, Button, IconButton, Spinner } from "../ui";
import {
  formatPostClock,
  formatSwarmElapsed,
  humanizeSwarmModel,
  isSwarmActive,
  memberInitial,
  postMatchesMember,
  summarizeSwarmCounts,
  swarmMemberStyle,
  swarmPhaseMeta,
  swarmRoleLabel,
  swarmStatusLabel,
  tokenizeSwarmInlineText,
} from "./swarmUtils";

function hasRichMarkdown(text: string): boolean {
  return /(?:^|\n)(?:#{1,4}\s|```|[-*]\s|\d+\.\s|\|.*\|)|`[^`]+`|\*\*[^*]+\*\*/.test(text);
}

function InteractivePostBody({
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
  if (hasRichMarkdown(text)) {
    return (
      <div className="prose-sm max-w-none text-body leading-relaxed text-fg">
        <Markdown>{text}</Markdown>
      </div>
    );
  }
  const tokens = tokenizeSwarmInlineText(text);
  return (
    <p className="whitespace-pre-wrap break-words text-body leading-relaxed text-fg">
      {tokens.map((tok, idx) => {
        if (tok.kind === "mention") {
          return (
            <button
              key={idx}
              type="button"
              onClick={() => tok.target !== "all" && onMention(tok.target)}
              className={cn(
                "mx-0.5 inline-flex items-center rounded-md px-1.5 py-0.5 text-caption font-medium transition-colors",
                tok.target === "all"
                  ? "bg-warning-soft text-warning"
                  : "bg-accent-soft text-accent hover:bg-accent/20",
              )}
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
}

function RosterMemberRow({
  member,
  activeSwarm,
  selected,
  onSelect,
}: {
  member: SwarmMemberSnapshot;
  activeSwarm: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const style = swarmMemberStyle(member.name, member.role);
  const working = member.status === "working" && activeSwarm;
  const killed = member.status === "killed";
  const modelText = humanizeSwarmModel(member.model);

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "flex w-full items-start gap-2.5 rounded-xl border px-2.5 py-2 text-left transition-all duration-150",
        "outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected
          ? "border-accent/45 bg-accent-soft/60 shadow-soft"
          : killed
            ? "border-transparent opacity-55 hover:bg-hover/60"
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
                ? "bg-accent animate-pulse"
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
          {member.unreadCount > 0 && activeSwarm && (
            <span className="ml-auto shrink-0 rounded-full bg-accent-soft px-1.5 py-0 font-mono text-micro font-medium text-accent tabular-nums">
              +{member.unreadCount}
            </span>
          )}
        </div>
        <div
          className={cn(
            "mt-0.5 truncate text-caption",
            member.failed
              ? "text-danger"
              : working
                ? "text-muted oc-live-status-shine"
                : "text-faint",
          )}
          title={member.lastError || member.activity || ""}
        >
          {member.failed
            ? member.lastError || "执行异常"
            : member.activity || swarmStatusLabel(member.status)}
        </div>
        <div className="mt-1 flex items-center gap-2 text-micro text-faint">
          {modelText && <span className="truncate">{modelText}</span>}
          {member.stepCount > 0 && (
            <span className="shrink-0 font-mono tabular-nums">{member.stepCount} 步</span>
          )}
          {member.lastPostSeq !== undefined && (
            <span className="shrink-0 font-mono tabular-nums">最近 #{member.lastPostSeq}</span>
          )}
        </div>
      </div>
    </button>
  );
}

function PostRow({
  post,
  highlighted,
  onMention,
  onChannel,
  onJumpSeq,
  setRowRef,
}: {
  post: SwarmBoardPost;
  highlighted: boolean;
  onMention: (name: string) => void;
  onChannel: (ch: string) => void;
  onJumpSeq: (seq: number) => void;
  setRowRef: (seq: number, el: HTMLDivElement | null) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const style = swarmMemberStyle(post.agent);
  const clock = formatPostClock(post.time);
  const isDoneMarker = post.text.trimStart().startsWith("[done]");
  const isLong = post.text.length > 900;
  const shownText = isLong && !expanded ? `${post.text.slice(0, 900)}…` : post.text;

  const copy = () => {
    void navigator.clipboard?.writeText(post.text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div
      ref={(el) => setRowRef(post.seq, el)}
      data-swarm-post-seq={post.seq}
      className={cn(
        "group rounded-2xl border px-3.5 py-3 transition-all duration-200",
        highlighted
          ? "border-accent bg-accent-soft/40 ring-2 ring-accent/30"
          : isDoneMarker
            ? "border-success/35 bg-success-soft/25"
            : "border-border/80 bg-surface hover:border-border-strong",
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
        {isDoneMarker && <Badge tone="success">阶段完结</Badge>}
        <div className="ml-auto flex items-center gap-1.5">
          {clock && <span className="font-mono text-micro text-faint tabular-nums">{clock}</span>}
          <button
            type="button"
            onClick={copy}
            aria-label="复制讨论内容"
            title="复制"
            className="flex size-6 items-center justify-center rounded-md text-faint opacity-0 transition-all hover:bg-hover hover:text-fg group-hover:opacity-100 focus-visible:opacity-100"
          >
            {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
          </button>
        </div>
      </div>

      <InteractivePostBody
        text={shownText}
        onMention={onMention}
        onChannel={onChannel}
        onJumpSeq={onJumpSeq}
      />

      {isLong && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-2 text-caption font-medium text-accent hover:underline"
        >
          {expanded ? "收起长文" : `展开完整内容（共 ${post.text.length} 字）`}
        </button>
      )}
    </div>
  );
}

export function SwarmBoardDrawer({
  open,
  onOpenChange,
  snapshot,
  initialFocusMember = null,
  initialFocusChannel = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  snapshot: SwarmSnapshot | null;
  initialFocusMember?: string | null;
  initialFocusChannel?: string | null;
}) {
  const [selectedMember, setSelectedMember] = useState<string | null>(initialFocusMember);
  const [selectedChannel, setSelectedChannel] = useState<string | null>(initialFocusChannel);
  const [search, setSearch] = useState("");
  const [followLatest, setFollowLatest] = useState(true);
  const [mobileTab, setMobileTab] = useState<"board" | "roster">("board");
  const [highlightedSeq, setHighlightedSeq] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const feedRef = useRef<HTMLDivElement>(null);
  const postRefs = useRef(new Map<number, HTMLDivElement>());
  const highlightTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!open) return;
    setSelectedMember(initialFocusMember ?? null);
    setSelectedChannel(initialFocusChannel ?? null);
    setSearch("");
    setMobileTab("board");
  }, [open, initialFocusMember, initialFocusChannel]);

  const active = snapshot ? isSwarmActive(snapshot.phase) : false;

  useEffect(() => {
    if (!open || !active) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [open, active]);

  useEffect(() => {
    return () => {
      if (highlightTimerRef.current !== null) window.clearTimeout(highlightTimerRef.current);
    };
  }, []);

  const filteredPosts = useMemo(() => {
    if (!snapshot) return [];
    const q = search.trim().toLowerCase();
    return snapshot.posts.filter((post) => {
      if (selectedChannel && (post.channel || "main") !== selectedChannel) return false;
      if (selectedMember && !postMatchesMember(post, selectedMember)) return false;
      if (q) {
        const hay = `#${post.seq} @${post.agent} ${post.channel ?? ""} ${post.text}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [snapshot, selectedChannel, selectedMember, search]);

  // Auto-follow newest board posts when enabled.
  const latestPostSeq = filteredPosts[filteredPosts.length - 1]?.seq ?? 0;
  useEffect(() => {
    if (!open || !followLatest || !feedRef.current) return;
    feedRef.current.scrollTop = feedRef.current.scrollHeight;
  }, [open, followLatest, latestPostSeq]);

  const setRowRef = useCallback((seq: number, el: HTMLDivElement | null) => {
    if (el) postRefs.current.set(seq, el);
    else postRefs.current.delete(seq);
  }, []);

  const jumpToSeq = useCallback((seq: number) => {
    setSelectedMember(null);
    setSelectedChannel(null);
    setSearch("");
    setFollowLatest(false);
    setMobileTab("board");
    setHighlightedSeq(seq);
    if (highlightTimerRef.current !== null) window.clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = window.setTimeout(() => setHighlightedSeq(null), 2200);
    requestAnimationFrame(() => {
      const target = postRefs.current.get(seq);
      target?.scrollIntoView?.({ behavior: "smooth", block: "center" });
    });
  }, []);

  // `[` / `]` keyboard stepping across posts when not typing in search input.
  useEffect(() => {
    if (!open || filteredPosts.length === 0) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key !== "[" && e.key !== "]") return;
      e.preventDefault();
      const idx =
        highlightedSeq !== null
          ? filteredPosts.findIndex((p) => p.seq === highlightedSeq)
          : filteredPosts.length - 1;
      const nextIdx =
        e.key === "["
          ? Math.max(0, (idx <= 0 ? 0 : idx - 1))
          : Math.min(filteredPosts.length - 1, idx < 0 ? 0 : idx + 1);
      const target = filteredPosts[nextIdx];
      if (target) jumpToSeq(target.seq);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, filteredPosts, highlightedSeq, jumpToSeq]);

  if (!snapshot) return null;

  const phase = swarmPhaseMeta(snapshot.phase);
  const counts = summarizeSwarmCounts(snapshot.members);
  const elapsed = active ? formatSwarmElapsed(snapshot.startedAt, now) : "";

  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className="fixed inset-0 z-50 bg-black/45 backdrop-blur-[3px] animate-in" />
        <RD.Content
          data-testid="swarm-board-drawer"
          aria-describedby={undefined}
          className={cn(
            "fixed left-1/2 top-1/2 z-50 flex -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden",
            "h-[90vh] w-[calc(100vw-1rem)] max-w-5xl rounded-2xl border border-border bg-bg shadow-pop outline-none sm:h-[84vh] sm:w-[calc(100vw-2.5rem)]",
          )}
        >
          {/* Top accent ribbon */}
          <div
            aria-hidden
            className={cn("h-[2px] w-full shrink-0", active ? "bg-grad-cta" : "bg-border")}
          />

          {/* Command Header */}
          <div className="flex flex-wrap items-center gap-2.5 border-b border-border bg-surface px-4 py-3">
            <span
              className={cn(
                "relative flex size-8 shrink-0 items-center justify-center rounded-xl text-white shadow-soft",
                active ? "bg-grad-cta" : "bg-primary text-primary-fg",
              )}
            >
              <Hexagon size={16} strokeWidth={2.2} />
            </span>

            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <RD.Title className="truncate text-title font-semibold tracking-[-0.015em] text-fg">
                  {snapshot.title || "蜂群协作看板"}
                </RD.Title>
                <Badge tone={phase.tone}>
                  {active && <Spinner size={9} className="mr-1" />}
                  {phase.label}
                </Badge>
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-caption text-faint">
                <span className="tabular-nums">
                  {counts.working > 0
                    ? `${counts.working} 运行中 · ${counts.waiting} 待命`
                    : `${counts.live} 名成员`}
                  {counts.killed > 0 ? ` · ${counts.killed} 已回收` : ""}
                </span>
                <span className="tabular-nums">{snapshot.totalPosts} 条讨论</span>
                {elapsed && <span className="font-mono tabular-nums text-muted">{elapsed}</span>}
                {counts.failed > 0 && (
                  <span className="inline-flex items-center gap-1 text-danger">
                    <AlertTriangle size={11} />
                    {counts.failed} 成员异常
                  </span>
                )}
              </div>
            </div>

            {/* Search & Controls */}
            <div className="flex w-full items-center gap-1.5 sm:w-auto">
              <div className="relative flex-1 sm:w-52">
                <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="搜索讨论、@成员或 #序号"
                  aria-label="搜索蜂群讨论"
                  className="h-8 w-full rounded-lg border border-border bg-bg pl-8 pr-2.5 text-meta text-fg outline-none transition-colors placeholder:text-faint focus:border-accent"
                />
              </div>
              <Button
                type="button"
                variant={followLatest ? "secondary" : "ghost"}
                size="sm"
                onClick={() => setFollowLatest((v) => !v)}
                className={cn(
                  "h-8 shrink-0 gap-1 px-2 text-caption",
                  followLatest && "text-accent",
                )}
                title="自动滚动到最新讨论"
              >
                <ArrowDown size={12} />
                <span className="hidden md:inline">跟随</span>
              </Button>
              <IconButton
                onClick={() => onOpenChange(false)}
                aria-label="关闭蜂群看板"
                shape="square"
                className="size-8 shrink-0"
              >
                <X size={16} />
              </IconButton>
            </div>
          </div>

          {/* Channel Bar & Mobile Tab Bar */}
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/80 bg-surface/60 px-4 py-2">
            <div className="flex items-center gap-1 overflow-x-auto">
              <button
                type="button"
                onClick={() => setSelectedChannel(null)}
                className={cn(
                  "shrink-0 rounded-lg px-2.5 py-1 text-caption font-medium transition-colors",
                  selectedChannel === null
                    ? "bg-accent-soft text-accent"
                    : "text-muted hover:bg-hover hover:text-fg",
                )}
              >
                全部频道 ({snapshot.totalPosts})
              </button>
              {snapshot.channels.map((ch) => (
                <button
                  key={ch.name}
                  type="button"
                  onClick={() => setSelectedChannel(selectedChannel === ch.name ? null : ch.name)}
                  className={cn(
                    "inline-flex shrink-0 items-center gap-1 rounded-lg px-2.5 py-1 text-caption font-medium transition-colors",
                    selectedChannel === ch.name
                      ? "bg-info-soft text-info"
                      : "text-muted hover:bg-hover hover:text-fg",
                    ch.archived && "opacity-60",
                  )}
                  title={ch.topic || `#${ch.name}`}
                >
                  <Hash size={11} />
                  <span>{ch.name}</span>
                  <span className="font-mono text-micro opacity-75 tabular-nums">{ch.postCount}</span>
                </button>
              ))}
            </div>

            {/* Mobile Roster / Board tab switcher */}
            <div className="flex shrink-0 items-center rounded-lg border border-border bg-bg p-0.5 md:hidden">
              <button
                type="button"
                onClick={() => setMobileTab("board")}
                className={cn(
                  "flex items-center gap-1 rounded-md px-2.5 py-1 text-caption font-medium",
                  mobileTab === "board" ? "bg-surface text-fg shadow-soft" : "text-muted",
                )}
              >
                <MessageSquare size={11} /> 讨论 ({filteredPosts.length})
              </button>
              <button
                type="button"
                onClick={() => setMobileTab("roster")}
                className={cn(
                  "flex items-center gap-1 rounded-md px-2.5 py-1 text-caption font-medium",
                  mobileTab === "roster" ? "bg-surface text-fg shadow-soft" : "text-muted",
                )}
              >
                <Users size={11} /> 成员 ({snapshot.members.length})
              </button>
            </div>
          </div>

          {/* Main Split Workspace */}
          <div className="flex min-h-0 flex-1 overflow-hidden">
            {/* Left Rail: Roster */}
            <aside
              className={cn(
                "w-full shrink-0 flex-col overflow-y-auto border-r border-border bg-surface/50 p-3 md:flex md:w-72",
                mobileTab === "roster" ? "flex" : "hidden",
              )}
              data-testid="swarm-roster-rail"
            >
              <div className="mb-2 flex items-center justify-between px-1">
                <span className="text-caption font-semibold uppercase tracking-wider text-faint">
                  蜂群花名册 · {snapshot.members.length}
                </span>
                {selectedMember && (
                  <button
                    type="button"
                    onClick={() => setSelectedMember(null)}
                    className="text-caption font-medium text-accent hover:underline"
                  >
                    重置筛选
                  </button>
                )}
              </div>

              <div className="space-y-1">
                {snapshot.members.map((member) => (
                  <RosterMemberRow
                    key={member.name}
                    member={member}
                    activeSwarm={active}
                    selected={selectedMember?.toLowerCase() === member.name.toLowerCase()}
                    onSelect={() => {
                      setSelectedMember((prev) =>
                        prev?.toLowerCase() === member.name.toLowerCase() ? null : member.name,
                      );
                      setMobileTab("board");
                    }}
                  />
                ))}
              </div>
            </aside>

            {/* Right Stage: Board Feed */}
            <section
              className={cn(
                "min-w-0 flex-1 flex-col overflow-hidden md:flex",
                mobileTab === "board" ? "flex" : "hidden",
              )}
            >
              {(selectedMember || selectedChannel || search.trim()) && (
                <div className="flex flex-wrap items-center gap-1.5 border-b border-border/60 bg-surface/40 px-4 py-2 text-caption">
                  <span className="text-faint">当前筛选：</span>
                  {selectedMember && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 font-medium text-accent">
                      @{selectedMember}
                      <button
                        type="button"
                        aria-label="取消成员筛选"
                        onClick={() => setSelectedMember(null)}
                        className="hover:opacity-75"
                      >
                        <X size={11} />
                      </button>
                    </span>
                  )}
                  {selectedChannel && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-info-soft px-2 py-0.5 font-medium text-info">
                      #{selectedChannel}
                      <button
                        type="button"
                        aria-label="取消频道筛选"
                        onClick={() => setSelectedChannel(null)}
                        className="hover:opacity-75"
                      >
                        <X size={11} />
                      </button>
                    </span>
                  )}
                  {search.trim() && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-hover px-2 py-0.5 text-fg">
                      “{search.trim()}”
                      <button
                        type="button"
                        aria-label="清空搜索"
                        onClick={() => setSearch("")}
                        className="hover:opacity-75"
                      >
                        <X size={11} />
                      </button>
                    </span>
                  )}
                  <span className="ml-auto font-mono text-micro text-faint tabular-nums">
                    命中 {filteredPosts.length} / {snapshot.posts.length} 条
                  </span>
                </div>
              )}

              <div
                ref={feedRef}
                onScroll={(e) => {
                  const el = e.currentTarget;
                  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
                  if (!nearBottom && followLatest) setFollowLatest(false);
                }}
                className="flex-1 space-y-2.5 overflow-y-auto px-4 py-3.5"
                data-testid="swarm-board-feed"
              >
                {snapshot.truncatedPosts && snapshot.truncatedPosts > 0 && (
                  <div className="rounded-xl border border-dashed border-border bg-surface/60 px-3 py-2 text-center text-caption text-faint">
                    已省略较早的 {snapshot.truncatedPosts} 条历史记录，仅展示最近 {snapshot.posts.length} 条
                  </div>
                )}

                {filteredPosts.length === 0 ? (
                  <div className="flex h-48 flex-col items-center justify-center gap-2 text-center">
                    <span className="flex size-10 items-center justify-center rounded-2xl bg-accent-soft text-accent">
                      <Hexagon size={20} />
                    </span>
                    <p className="text-body font-medium text-fg">
                      {snapshot.posts.length === 0
                        ? "蜂群讨论板尚未产生消息"
                        : "当前筛选条件下暂无匹配讨论"}
                    </p>
                    <p className="text-caption text-faint">
                      {snapshot.posts.length === 0
                        ? "协调者完成分工后，各成员的汇报与互审会在此实时呈现"
                        : "尝试切换频道、取消成员聚焦或清空关键词"}
                    </p>
                  </div>
                ) : (
                  filteredPosts.map((post) => (
                    <PostRow
                      key={post.seq}
                      post={post}
                      highlighted={highlightedSeq === post.seq}
                      onMention={(name) => setSelectedMember(name)}
                      onChannel={(ch) => setSelectedChannel(ch)}
                      onJumpSeq={jumpToSeq}
                      setRowRef={setRowRef}
                    />
                  ))
                )}
              </div>

              {/* Subtle keyboard legend footer */}
              <div className="hidden items-center justify-between border-t border-border/70 bg-surface/50 px-4 py-1.5 text-micro text-faint sm:flex">
                <span>点击 @成员 可聚焦协作流 · 点击 #序号 快速定位引用</span>
                <span className="font-mono">[ / ] 上下条 · Esc 关闭</span>
              </div>
            </section>
          </div>
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}
