/**
 * SwarmBoardDrawer — Immersive Studio Workspace for Antigravity native swarms (OCV5-809).
 *
 * Lazy-loaded (zero first-screen gzip cost). Features:
 *  - Split-pane desktop layout (Roster & Live Telemetry rail + Chronological Collaboration Board)
 *    with smooth mobile tab switcher and collapsible Member Profile Bar
 *  - Channel tabs (`#main`, `#parser`, ...), member focus filter, instant search,
 *    and first-class `[stall]` / failed-member alert banner with one-click focus
 *  - Isolated `<SwarmElapsedTicker />` leaf & memoized rows (zero 1s full-tree re-renders)
 *  - Interactive `@mention`, `@#channel`, `#seq` navigation, scroll-fence follow-latest
 *    with unread counter, and active/read-only SwarmCommandBar
 */
import * as RD from "@radix-ui/react-dialog";
import type { SwarmBoardPost, SwarmSnapshot } from "@openclaude/protocol/browser";
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ChevronRight,
  Hash,
  MessageSquare,
  OctagonX,
  Search,
  ShieldAlert,
  Users,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOptionalAuth } from "../../hooks/useProjectScope";
import type { AuthSession } from "../../lib/types";
import { cn } from "../../lib/utils";
import { Badge, Button, IconButton, Spinner, useToast } from "../ui";
import { AtelierIcon } from "../ui/AtelierIcons";
import { PostRow, RosterMemberRow } from "./SwarmBoardRows";
import { SwarmCommandBar } from "./SwarmCommandBar";
import { SwarmElapsedTicker } from "./SwarmElapsedTicker";
import { SwarmMemberProfileBar } from "./SwarmMemberProfileBar";
import {
  detectSwarmAlerts,
  formatTelemetryTokens,
  isSwarmActive,
  memberInitial,
  postMatchesMember,
  summarizeSwarmCounts,
  summarizeSwarmTelemetry,
  swarmMemberStyle,
  swarmPhaseMeta,
} from "./swarmUtils";

export { hasRichMarkdown, linkifySwarmMarkdownTokens } from "./SwarmBoardRows";

export function SwarmBoardDrawer({
  open,
  onOpenChange,
  snapshot,
  sessionId = null,
  auth: authProp,
  initialFocusMember = null,
  initialFocusChannel = null,
  initialFocusSeq = null,
  syncStale = false,
  onStopSwarm,
  onQuoteToComposer,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  snapshot: SwarmSnapshot | null;
  sessionId?: string | null;
  auth?: AuthSession | null;
  initialFocusMember?: string | null;
  initialFocusChannel?: string | null;
  initialFocusSeq?: number | null;
  syncStale?: boolean;
  onStopSwarm?: () => void;
  onQuoteToComposer?: (text: string) => void;
}) {
  const ctxAuth = useOptionalAuth();
  const effectiveAuth = authProp !== undefined ? authProp : ctxAuth;
  const [selectedMember, setSelectedMember] = useState<string | null>(initialFocusMember);
  const [selectedChannel, setSelectedChannel] = useState<string | null>(initialFocusChannel);
  const [search, setSearch] = useState("");
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const [showKilledRoster, setShowKilledRoster] = useState(false);
  const [followLatest, setFollowLatest] = useState(true);
  const [isNearBottom, setIsNearBottom] = useState(true);
  const [unreadNewCount, setUnreadNewCount] = useState(0);
  const [mobileTab, setMobileTab] = useState<"board" | "roster">("board");
  const [highlightedSeq, setHighlightedSeq] = useState<number | null>(null);
  const [confirmAbort, setConfirmAbort] = useState(false);
  const [optimisticPosts, setOptimisticPosts] = useState<SwarmBoardPost[]>([]);
  const toast = useToast();

  const contentRef = useRef<HTMLDivElement>(null);
  const mobileSearchInputRef = useRef<HTMLInputElement>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  const postRefs = useRef(new Map<number, HTMLDivElement>());
  const highlightTimerRef = useRef<number | null>(null);
  const pendingJumpSeqRef = useRef<number | null>(null);
  const programmaticScrollRef = useRef(false);
  const programmaticScrollTimerRef = useRef<number | null>(null);
  const lastSeenSeqRef = useRef<number>(0);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;

  // Clear optimistic posts when switching to a different swarm or closing drawer.
  const currentSwarmId = snapshot?.swarmId ?? null;
  useEffect(() => {
    setOptimisticPosts([]);
    setConfirmAbort(false);
  }, [currentSwarmId]);

  useEffect(() => {
    if (!open) {
      setConfirmAbort(false);
      return;
    }
    const snap = snapshotRef.current;
    const targetPost =
      typeof initialFocusSeq === "number" && initialFocusSeq > 0
        ? snap?.posts.find((p) => p.seq === initialFocusSeq)
        : undefined;

    // Guarantee target post visibility when jumping into a specific #seq across channels/members.
    const nextChannel = targetPost
      ? initialFocusChannel && (targetPost.channel || "main") === initialFocusChannel
        ? initialFocusChannel
        : null
      : (initialFocusChannel ?? null);
    const nextMember = targetPost
      ? initialFocusMember && postMatchesMember(targetPost, initialFocusMember)
        ? initialFocusMember
        : null
      : (initialFocusMember ?? null);

    setSelectedMember(nextMember);
    setSelectedChannel(nextChannel);
    setSearch("");
    setMobileSearchOpen(false);
    setMobileTab("board");
    setUnreadNewCount(0);
    const focusedIsKilled = Boolean(
      nextMember &&
        snap?.members.some(
          (m) => m.status === "killed" && m.name.toLowerCase() === nextMember.toLowerCase(),
        ),
    );
    setShowKilledRoster(focusedIsKilled);
    const headSeq = snap?.posts[snap.posts.length - 1]?.seq ?? 0;
    lastSeenSeqRef.current = headSeq;

    if (typeof initialFocusSeq === "number" && initialFocusSeq > 0) {
      pendingJumpSeqRef.current = initialFocusSeq;
      setFollowLatest(false);
      setIsNearBottom(false);
      setHighlightedSeq(initialFocusSeq);
      if (highlightTimerRef.current !== null) window.clearTimeout(highlightTimerRef.current);
      highlightTimerRef.current = window.setTimeout(() => setHighlightedSeq(null), 2200);
    } else {
      pendingJumpSeqRef.current = null;
      setFollowLatest(true);
      setIsNearBottom(true);
    }
  }, [open, initialFocusMember, initialFocusChannel, initialFocusSeq]);

  useEffect(() => {
    if (!mobileSearchOpen) return;
    mobileSearchInputRef.current?.focus();
  }, [mobileSearchOpen]);

  const active = snapshot ? isSwarmActive(snapshot.phase) : false;

  useEffect(() => {
    if (!active && confirmAbort) setConfirmAbort(false);
  }, [active, confirmAbort]);

  useEffect(() => {
    return () => {
      if (highlightTimerRef.current !== null) window.clearTimeout(highlightTimerRef.current);
      if (programmaticScrollTimerRef.current !== null) {
        window.clearTimeout(programmaticScrollTimerRef.current);
      }
    };
  }, []);

  // Merge confirmed snapshot posts with any pending optimistic steer posts (auto-deduplicated by seq).
  const { mergedPosts, optimisticSeqSet } = useMemo(() => {
    if (!snapshot) return { mergedPosts: [] as SwarmBoardPost[], optimisticSeqSet: new Set<number>() };
    if (optimisticPosts.length === 0) {
      return { mergedPosts: snapshot.posts, optimisticSeqSet: new Set<number>() };
    }
    const confirmedSeqs = new Set(snapshot.posts.map((p) => p.seq));
    const pending = optimisticPosts.filter((p) => !confirmedSeqs.has(p.seq));
    if (pending.length === 0) {
      return { mergedPosts: snapshot.posts, optimisticSeqSet: new Set<number>() };
    }
    const merged = [...snapshot.posts, ...pending].sort((a, b) => a.seq - b.seq);
    return { mergedPosts: merged, optimisticSeqSet: new Set(pending.map((p) => p.seq)) };
  }, [snapshot, optimisticPosts]);

  // Drop confirmed optimistic posts so memory stays clean.
  useEffect(() => {
    if (!snapshot || optimisticPosts.length === 0) return;
    const confirmedSeqs = new Set(snapshot.posts.map((p) => p.seq));
    if (optimisticPosts.some((p) => confirmedSeqs.has(p.seq))) {
      setOptimisticPosts((prev) => prev.filter((p) => !confirmedSeqs.has(p.seq)));
    }
  }, [snapshot, optimisticPosts]);

  const filteredPosts = useMemo(() => {
    if (!snapshot) return [];
    const q = search.trim().toLowerCase();
    return mergedPosts.filter((post) => {
      if (selectedChannel && (post.channel || "main") !== selectedChannel) return false;
      if (selectedMember && !postMatchesMember(post, selectedMember)) return false;
      if (q) {
        const hay = `#${post.seq} @${post.agent} ${post.channel ?? ""} ${post.text}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [snapshot, mergedPosts, selectedChannel, selectedMember, search]);

  const armProgrammaticScrollFence = useCallback((durationMs: number) => {
    programmaticScrollRef.current = true;
    if (programmaticScrollTimerRef.current !== null) {
      window.clearTimeout(programmaticScrollTimerRef.current);
    }
    programmaticScrollTimerRef.current = window.setTimeout(() => {
      programmaticScrollRef.current = false;
      programmaticScrollTimerRef.current = null;
    }, durationMs);
  }, []);

  // Single helper for scrolling feed to bottom (strictly respects UI-SCROLL-SINGLE-WRITER budget).
  const scrollFeedToBottom = useCallback(
    (smooth: boolean) => {
      const el = feedRef.current;
      if (!el) return;
      armProgrammaticScrollFence(smooth ? 420 : 80);
      if (smooth && typeof el.scrollTo === "function") {
        el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      } else {
        el.scrollTop = el.scrollHeight;
      }
    },
    [armProgrammaticScrollFence],
  );

  // Auto-follow newest board posts when enabled; accumulate unread count while paused.
  const latestPostSeq = filteredPosts[filteredPosts.length - 1]?.seq ?? 0;
  useEffect(() => {
    if (!open) return;
    if (followLatest) {
      lastSeenSeqRef.current = Math.max(lastSeenSeqRef.current, latestPostSeq);
      setUnreadNewCount(0);
      scrollFeedToBottom(false);
    } else if (latestPostSeq > lastSeenSeqRef.current) {
      const unseen = filteredPosts.filter((p) => p.seq > lastSeenSeqRef.current).length;
      setUnreadNewCount(unseen);
    }
  }, [open, followLatest, latestPostSeq, filteredPosts, scrollFeedToBottom]);

  // Recalculate overflow when filter narrows results so the jump-to-bottom pill hides on <=1 screen.
  useEffect(() => {
    if (!open) return;
    const el = feedRef.current;
    if (!el) return;
    const noOverflow = el.scrollHeight - el.clientHeight <= 48;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    if (noOverflow || nearBottom) {
      setIsNearBottom(true);
      setUnreadNewCount(0);
      lastSeenSeqRef.current = Math.max(lastSeenSeqRef.current, latestPostSeq);
    }
  }, [open, filteredPosts.length, selectedChannel, selectedMember, search, latestPostSeq]);

  const registerRowRef = useCallback((seq: number, el: HTMLDivElement | null) => {
    if (el) postRefs.current.set(seq, el);
    else postRefs.current.delete(seq);
  }, []);

  const handleMention = useCallback((name: string) => {
    setSelectedMember(name);
    setMobileTab("board");
  }, []);

  const handleChannel = useCallback((ch: string) => {
    setSelectedChannel(ch);
  }, []);

  const handleSelectRosterMember = useCallback((memberName: string) => {
    setSelectedMember((prev) =>
      prev?.toLowerCase() === memberName.toLowerCase() ? null : memberName,
    );
    setMobileTab("board");
  }, []);

  const handleOptimisticSteer = useCallback((post: SwarmBoardPost) => {
    setOptimisticPosts((prev) => {
      if (prev.some((p) => p.seq === post.seq)) return prev;
      return [...prev, post];
    });
  }, []);

  const jumpToSeq = useCallback(
    (seq: number) => {
      const targetPost = mergedPosts.find((p) => p.seq === seq);
      if (!targetPost) {
        toast(`#${seq} 属于更早的历史记录，当前窗口未保留`, "info");
        return;
      }
      // Preserve active filters when the target #seq is already visible; only clear conflicting ones.
      const visibleNow = filteredPosts.some((p) => p.seq === seq);
      if (!visibleNow) {
        if (selectedChannel && (targetPost.channel || "main") !== selectedChannel) {
          setSelectedChannel(null);
        }
        if (selectedMember && !postMatchesMember(targetPost, selectedMember)) {
          setSelectedMember(null);
        }
        const q = search.trim().toLowerCase();
        if (q) {
          const hay = `#${targetPost.seq} @${targetPost.agent} ${targetPost.channel ?? ""} ${targetPost.text}`.toLowerCase();
          if (!hay.includes(q)) setSearch("");
        }
      }
      pendingJumpSeqRef.current = seq;
      setFollowLatest(false);
      setMobileTab("board");
      setHighlightedSeq(seq);
      if (highlightTimerRef.current !== null) window.clearTimeout(highlightTimerRef.current);
      highlightTimerRef.current = window.setTimeout(() => setHighlightedSeq(null), 2200);
    },
    [mergedPosts, filteredPosts, selectedChannel, selectedMember, search, toast],
  );

  useEffect(() => {
    const seq = pendingJumpSeqRef.current;
    if (!open || seq === null) return;
    const target = postRefs.current.get(seq);
    if (!target) return;
    pendingJumpSeqRef.current = null;
    armProgrammaticScrollFence(420);
    target.scrollIntoView?.({ behavior: "smooth", block: "center" });
  }, [open, filteredPosts, highlightedSeq, armProgrammaticScrollFence]);

  const quotePostToMainline = useCallback(
    (post: SwarmBoardPost) => {
      if (!onQuoteToComposer) return;
      const snippet = post.text.trim().slice(0, 600);
      const quote = `> [蜂群讨论 #${post.seq} @${post.agent}]\n> ${snippet.replace(/\n/g, "\n> ")}`;
      onQuoteToComposer(quote);
      onOpenChange(false);
      toast(`已引用 #${post.seq} 到主输入框`, "success");
    },
    [onQuoteToComposer, onOpenChange, toast],
  );

  const followUpSummaryToMainline = useCallback(() => {
    if (!onQuoteToComposer || !snapshot) return;
    const tail = mergedPosts[mergedPosts.length - 1];
    if (tail) {
      quotePostToMainline(tail);
      return;
    }
    onQuoteToComposer(`> [蜂群协作「${snapshot.title || "蜂群协作"}」]\n> 请基于上述协作结果继续：`);
    onOpenChange(false);
    toast("已引用蜂群上下文到主输入框", "success");
  }, [onQuoteToComposer, snapshot, mergedPosts, quotePostToMainline, onOpenChange, toast]);

  // `[` / `]` keyboard stepping across currently filtered posts when not typing in inputs.
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
          ? Math.max(0, idx <= 0 ? 0 : idx - 1)
          : Math.min(filteredPosts.length - 1, idx < 0 ? 0 : idx + 1);
      const target = filteredPosts[nextIdx];
      if (target) jumpToSeq(target.seq);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, filteredPosts, highlightedSeq, jumpToSeq]);

  const liveMembers = useMemo(
    () => (snapshot ? snapshot.members.filter((m) => m.status !== "killed") : []),
    [snapshot],
  );
  const killedMembers = useMemo(
    () => (snapshot ? snapshot.members.filter((m) => m.status === "killed") : []),
    [snapshot],
  );
  const selectedMemberObj = useMemo(() => {
    if (!snapshot || !selectedMember) return null;
    const key = selectedMember.toLowerCase();
    return snapshot.members.find((m) => m.name.toLowerCase() === key) ?? null;
  }, [snapshot, selectedMember]);

  const telemetrySummary = useMemo(
    () => (snapshot ? summarizeSwarmTelemetry(snapshot.members) : null),
    [snapshot],
  );
  const alerts = useMemo(() => (snapshot ? detectSwarmAlerts(snapshot) : null), [snapshot]);

  if (!snapshot) return null;

  const phase = swarmPhaseMeta(snapshot.phase);
  const counts = summarizeSwarmCounts(snapshot.members);
  const showChannelBar = snapshot.channels.length > 1;
  const trimmedSearch = search.trim();
  const totalTokensLabel = telemetrySummary?.hasTokens
    ? `${telemetrySummary.partial ? "~" : ""}${formatTelemetryTokens(
        telemetrySummary.inputTokens,
        telemetrySummary.outputTokens,
      )}`
    : "";

  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className="fixed inset-0 z-[var(--z-drawer)] bg-black/35 backdrop-blur-sm data-[state=open]:animate-fade" />
        <RD.Content
          ref={contentRef}
          tabIndex={-1}
          data-testid="swarm-board-drawer"
          data-swarm-active={active ? "true" : undefined}
          aria-describedby={undefined}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            contentRef.current?.focus({ preventScroll: true });
          }}
          className={cn(
            "oc-surface-popover fixed inset-x-0 bottom-0 top-auto z-[var(--z-drawer)] flex translate-x-0 translate-y-0 flex-col overflow-hidden text-fg outline-none",
            "h-[92dvh] max-h-[min(92dvh,calc(var(--oc-visual-height,100dvh)-1rem))] w-full rounded-t-2xl rounded-b-none pb-[env(safe-area-inset-bottom,0px)] oc-sheet-in-bottom",
            "sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2",
            "sm:h-[84dvh] sm:max-h-[min(84dvh,calc(var(--oc-visual-height,100dvh)-2rem))] sm:w-[calc(100vw-2.5rem)] sm:max-w-5xl sm:rounded-2xl sm:animate-in",
          )}
        >
          {/* Top accent ribbon */}
          <div
            aria-hidden
            className={cn("h-[2px] w-full shrink-0", active ? "bg-grad-cta" : "bg-border")}
          />

          {/* Mobile sheet grabber */}
          <div aria-hidden className="flex justify-center bg-surface pt-2 pb-0.5 sm:hidden">
            <span className="h-1 w-9 rounded-full bg-border-strong/70" />
          </div>

          {/* Row 1: Command Header */}
          <div className="flex items-center gap-2 border-b border-border/80 bg-surface px-3.5 py-2 sm:gap-2.5 sm:px-4 sm:py-3">
            <span
              data-testid="swarm-drawer-icon"
              className={cn(
                "oc-icon-badge relative size-7 shrink-0 rounded-xl sm:size-8",
                active
                  ? "oc-icon-badge-accent"
                  : snapshot.phase === "completed"
                    ? "oc-icon-badge-success"
                    : snapshot.phase === "error"
                      ? "oc-icon-badge-danger"
                      : "oc-icon-badge-warning",
              )}
            >
              <AtelierIcon name="swarm" size={16} />
            </span>

            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-1.5 sm:gap-2">
                <RD.Title className="min-w-0 truncate text-section font-semibold tracking-[-0.015em] text-fg sm:text-title">
                  {snapshot.title || "蜂群协作看板"}
                </RD.Title>
                <Badge tone={phase.tone} className="shrink-0">
                  {phase.label}
                </Badge>
                {syncStale && (
                  <span
                    data-testid="swarm-sync-reconnecting"
                    className="inline-flex shrink-0 items-center gap-1 rounded-full bg-warning-soft px-2 py-0.5 text-micro font-medium text-warning"
                  >
                    <Spinner size={10} />
                    同步重连中
                  </span>
                )}
              </div>
              <div className="mt-0.5 hidden flex-wrap items-center gap-x-3 gap-y-0.5 text-caption text-faint sm:flex">
                <span className="tabular-nums">
                  {counts.working > 0
                    ? `${counts.working} 运行中 · ${counts.waiting} 待命`
                    : `${counts.live} 名成员`}
                  {counts.killed > 0 ? ` · ${counts.killed} 已回收` : ""}
                </span>
                <span className="tabular-nums">{snapshot.totalPosts} 条讨论</span>
                <SwarmElapsedTicker
                  startedAt={snapshot.startedAt}
                  endedAt={snapshot.updatedAt}
                  active={active}
                  prefix={active ? undefined : "总耗时 "}
                  data-testid="swarm-drawer-elapsed"
                  className="font-mono tabular-nums text-muted"
                />
                {totalTokensLabel && (
                  <span
                    data-testid="swarm-drawer-total-tokens"
                    title={
                      telemetrySummary?.cacheHitRatePct != null
                        ? `整群总 Token · 缓存命中率 ${telemetrySummary.cacheHitRatePct}%`
                        : "整群输入 / 输出 Token 汇总"
                    }
                    className="inline-flex items-center gap-1 font-mono tabular-nums text-muted"
                  >
                    <Activity size={11} aria-hidden className="text-faint" />
                    <span>{totalTokensLabel}</span>
                    {telemetrySummary?.cacheHitRatePct != null && (
                      <span className="rounded bg-hover px-1 py-0 text-micro text-muted">
                        缓存 {telemetrySummary.cacheHitRatePct}%
                      </span>
                    )}
                  </span>
                )}
                {counts.failed > 0 && (
                  <span className="inline-flex items-center gap-1 text-danger">
                    <AlertTriangle size={11} />
                    {counts.failed} 成员异常
                  </span>
                )}
              </div>
            </div>

            {/* Desktop inline search (sm+) + Abort swarm + Mobile search toggle + Close */}
            <div className="flex shrink-0 items-center gap-1 sm:gap-1.5">
              {active && onStopSwarm && (
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  data-testid="swarm-abort-trigger"
                  onClick={() => setConfirmAbort((v) => !v)}
                  title="中止整轮蜂群协作"
                  className={cn(
                    "oc-spring-press min-h-11 shrink-0 text-danger sm:min-h-8",
                    confirmAbort && "ring-2 ring-ring",
                  )}
                >
                  <OctagonX size={13} aria-hidden />
                  <span className="hidden sm:inline">中止蜂群</span>
                </Button>
              )}
              <div className="relative hidden sm:block sm:w-48 lg:w-52">
                <Search
                  size={13}
                  strokeWidth={1.75}
                  className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint"
                />
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="搜索讨论、@成员或 #序号"
                  aria-label="搜索蜂群讨论"
                  className="oc-field-control h-8 w-full rounded-lg border border-border-control/60 pl-8 pr-2.5 text-base text-fg outline-none transition-colors placeholder:text-faint focus:border-accent focus-visible:ring-2 focus-visible:ring-ring md:text-meta"
                />
              </div>
              <IconButton
                onClick={() => {
                  if (mobileSearchOpen) {
                    setSearch("");
                    setMobileSearchOpen(false);
                  } else {
                    setMobileSearchOpen(true);
                  }
                }}
                aria-label="搜索讨论"
                aria-expanded={mobileSearchOpen}
                data-testid="swarm-mobile-search-toggle"
                shape="square"
                className={cn(
                  "oc-spring-press min-h-11 min-w-11 shrink-0 sm:hidden",
                  (mobileSearchOpen || Boolean(trimmedSearch)) && "bg-accent-soft text-accent",
                )}
              >
                <Search size={15} strokeWidth={1.75} />
              </IconButton>
              <IconButton
                onClick={() => onOpenChange(false)}
                aria-label="关闭蜂群看板"
                shape="square"
                className="oc-spring-press min-h-11 min-w-11 shrink-0 sm:min-h-0 sm:min-w-0 sm:size-8"
              >
                <X size={16} strokeWidth={1.75} />
              </IconButton>
            </div>
          </div>

          {/* Two-step abort entire swarm confirmation bar */}
          {active && confirmAbort && onStopSwarm && (
            <div
              data-testid="swarm-abort-confirm"
              className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-danger-soft/50 px-3.5 py-2 sm:px-4"
            >
              <span className="inline-flex items-center gap-1.5 text-caption font-semibold text-danger">
                <ShieldAlert size={14} aria-hidden />
                确认中止整轮蜂群协作？正在运行的成员将被中断，已产出的讨论记录会保留。
              </span>
              <div className="flex shrink-0 items-center gap-1.5">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setConfirmAbort(false)}
                  className="min-h-11 sm:min-h-8"
                >
                  取消
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="danger"
                  data-testid="swarm-abort-confirm-btn"
                  onClick={() => {
                    setConfirmAbort(false);
                    onStopSwarm();
                    toast("已请求中止整轮蜂群协作", "info");
                  }}
                  className="min-h-11 sm:min-h-8"
                >
                  <OctagonX size={12} aria-hidden />
                  确认中止
                </Button>
              </div>
            </div>
          )}

          {/* Restrained stall / failed-member alert strip with one-click focus */}
          {alerts?.hasAlert && (
            <div
              data-testid="swarm-alert-banner"
              className={cn(
                "flex flex-wrap items-center justify-between gap-2 border-b border-border/80 px-3.5 py-1.5 text-caption sm:px-4",
                alerts.failedMembers.length > 0
                  ? "oc-callout-danger bg-danger-soft/35 text-danger"
                  : "oc-callout-warning bg-warning-soft/45 text-warning",
              )}
            >
              <span className="inline-flex min-w-0 items-center gap-1.5 font-medium">
                <AlertTriangle size={13} aria-hidden className="shrink-0" />
                <span className="truncate">{alerts.summary}</span>
              </span>
              {(alerts.primaryFocusMember || alerts.primaryFocusSeq) && (
                <button
                  type="button"
                  data-testid="swarm-alert-focus-btn"
                  onClick={() => {
                    if (alerts.primaryFocusMember) {
                      setSelectedMember(alerts.primaryFocusMember);
                      setMobileTab("board");
                    }
                    if (alerts.primaryFocusSeq) {
                      jumpToSeq(alerts.primaryFocusSeq);
                    }
                  }}
                  className="oc-spring-press shrink-0 rounded-md bg-surface/85 px-2 py-0.5 text-caption font-semibold text-fg transition-colors hover:bg-surface"
                >
                  {alerts.primaryFocusMember ? `聚焦 @${alerts.primaryFocusMember}` : "查看预警"}
                </button>
              )}
            </div>
          )}

          {/* Expandable Mobile Search Bar (<640px only, collapsed by default) */}
          {mobileSearchOpen && (
            <div
              data-testid="swarm-mobile-search-bar"
              className="flex items-center gap-1.5 border-b border-border/70 bg-surface/90 px-3.5 py-2 sm:hidden"
            >
              <div className="relative min-w-0 flex-1">
                <Search
                  size={14}
                  strokeWidth={1.75}
                  className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint"
                />
                <input
                  ref={mobileSearchInputRef}
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="搜索讨论、@成员或 #序号"
                  aria-label="输入关键词搜索讨论"
                  data-testid="swarm-mobile-search-input"
                  className="oc-field-control h-9 w-full rounded-lg border border-border-control/60 pl-8 pr-2.5 text-base text-fg outline-none transition-colors placeholder:text-faint focus:border-accent focus-visible:ring-2 focus-visible:ring-ring"
                />
              </div>
              <button
                type="button"
                onClick={() => {
                  setSearch("");
                  setMobileSearchOpen(false);
                }}
                aria-label="收起搜索"
                data-testid="swarm-mobile-search-close"
                className="oc-spring-press min-h-11 shrink-0 rounded-lg px-2.5 py-1.5 text-caption font-medium text-muted transition-colors hover:bg-hover hover:text-fg"
              >
                取消
              </button>
            </div>
          )}

          {/* Row 2: Mobile segmented switcher + conditional multi-channel strip */}
          <div
            data-testid="swarm-subbar"
            className={cn(
              "flex items-center gap-2 border-b border-border/70 bg-surface/60 px-3.5 py-1.5 sm:px-4",
              !showChannelBar && "md:hidden",
            )}
          >
            {/* Mobile Roster / Board tab switcher */}
            <div className="oc-surface-recessed flex shrink-0 items-center rounded-lg border border-border p-0.5 md:hidden">
              <button
                type="button"
                onClick={() => setMobileTab("board")}
                className={cn(
                  "oc-spring-press flex items-center gap-1 rounded-md px-2.5 py-1 text-caption font-medium transition-all",
                  mobileTab === "board" ? "oc-segmented-thumb text-fg" : "text-muted",
                )}
              >
                <MessageSquare size={11} strokeWidth={1.75} />
                <span className="tabular-nums">讨论 {filteredPosts.length}</span>
              </button>
              <button
                type="button"
                onClick={() => setMobileTab("roster")}
                className={cn(
                  "oc-spring-press flex items-center gap-1 rounded-md px-2.5 py-1 text-caption font-medium transition-all",
                  mobileTab === "roster" ? "oc-segmented-thumb text-fg" : "text-muted",
                )}
              >
                <Users size={11} strokeWidth={1.75} />
                <span className="tabular-nums">成员 {snapshot.members.length}</span>
              </button>
            </div>

            {showChannelBar ? (
              <div
                data-testid="swarm-channel-bar"
                className="no-scrollbar flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
              >
                <button
                  type="button"
                  onClick={() => setSelectedChannel(null)}
                  className={cn(
                    "oc-spring-press shrink-0 rounded-lg px-2 py-1 text-caption font-medium transition-colors",
                    selectedChannel === null
                      ? "bg-accent-soft text-accent"
                      : "text-muted hover:bg-hover hover:text-fg",
                  )}
                >
                  全部 ({snapshot.totalPosts})
                </button>
                {snapshot.channels.map((ch) => (
                  <button
                    key={ch.name}
                    type="button"
                    onClick={() => setSelectedChannel(selectedChannel === ch.name ? null : ch.name)}
                    className={cn(
                      "oc-spring-press inline-flex shrink-0 items-center gap-0.5 rounded-lg px-2 py-1 text-caption font-medium transition-colors",
                      selectedChannel === ch.name
                        ? "bg-info-soft text-info"
                        : "text-muted hover:bg-hover hover:text-fg",
                      ch.archived && "opacity-60",
                    )}
                    title={ch.topic || `#${ch.name}`}
                  >
                    <Hash size={10} />
                    <span>{ch.name}</span>
                    <span className="font-mono text-micro opacity-75 tabular-nums">{ch.postCount}</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="ml-auto flex items-center gap-2 text-micro text-faint tabular-nums md:hidden">
                {counts.working > 0 ? (
                  <span>{counts.working} 运行中</span>
                ) : (
                  <span>{counts.live} 活跃</span>
                )}
                <SwarmElapsedTicker
                  startedAt={snapshot.startedAt}
                  endedAt={snapshot.updatedAt}
                  active={active}
                  className="font-mono text-muted"
                />
              </div>
            )}
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

              {liveMembers.length > 0 && (
                <div className="space-y-1" data-testid="swarm-roster-live-list">
                  {liveMembers.map((member) => (
                    <RosterMemberRow
                      key={member.name}
                      member={member}
                      activeSwarm={active}
                      selected={selectedMember?.toLowerCase() === member.name.toLowerCase()}
                      onSelect={handleSelectRosterMember}
                    />
                  ))}
                </div>
              )}

              {killedMembers.length > 0 && (
                <div className={cn("space-y-1", liveMembers.length > 0 && "mt-2")} data-testid="swarm-roster-killed-section">
                  <button
                    type="button"
                    data-testid="swarm-roster-killed-toggle"
                    aria-expanded={showKilledRoster}
                    onClick={() => setShowKilledRoster((v) => !v)}
                    className="oc-spring-press flex w-full items-center gap-2 rounded-xl border border-border/70 bg-surface/75 px-2.5 py-1.5 text-left text-caption text-muted outline-none transition-colors hover:border-border-strong hover:text-fg focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="flex shrink-0 items-center -space-x-1.5" aria-hidden>
                      {killedMembers.slice(0, 4).map((m) => {
                        const st = swarmMemberStyle(m.name, m.role);
                        return (
                          <span
                            key={m.name}
                            className={cn(
                              "flex size-5 items-center justify-center rounded-full text-micro font-semibold ring-2 ring-surface opacity-75",
                              st.avatar,
                            )}
                          >
                            {memberInitial(m.name)}
                          </span>
                        );
                      })}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-medium">
                      已回收 {killedMembers.length} 名成员
                    </span>
                    <ChevronRight
                      size={13}
                      className={cn(
                        "shrink-0 text-faint transition-transform duration-150",
                        showKilledRoster && "rotate-90",
                      )}
                    />
                  </button>
                  {showKilledRoster && (
                    <div className="space-y-1" data-testid="swarm-roster-killed-list">
                      {killedMembers.map((member) => (
                        <RosterMemberRow
                          key={member.name}
                          member={member}
                          activeSwarm={active}
                          selected={selectedMember?.toLowerCase() === member.name.toLowerCase()}
                          onSelect={handleSelectRosterMember}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}
            </aside>

            {/* Right Stage: Board Feed */}
            <section
              className={cn(
                "relative min-w-0 flex-1 flex-col overflow-hidden md:flex",
                mobileTab === "board" ? "flex" : "hidden",
              )}
            >
              {(selectedMember || selectedChannel || trimmedSearch) && (
                <div className="flex flex-wrap items-center gap-1.5 border-b border-border/60 bg-surface/40 px-3.5 py-1.5 text-caption sm:px-4">
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
                  {trimmedSearch && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-hover px-2 py-0.5 text-fg">
                      “{trimmedSearch}”
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
                  {trimmedSearch && (
                    <span
                      data-testid="swarm-search-hit-count"
                      className="ml-auto shrink-0 font-mono text-micro text-faint tabular-nums"
                    >
                      找到 {filteredPosts.length} 条
                    </span>
                  )}
                </div>
              )}

              {/* Collapsible Member Profile Dossier when a member is selected */}
              {selectedMemberObj && (
                <SwarmMemberProfileBar
                  member={selectedMemberObj}
                  activeSwarm={active}
                  onJumpSeq={jumpToSeq}
                />
              )}

              <div className="relative flex min-h-0 flex-1 flex-col">
                <div
                  ref={feedRef}
                  onScroll={(e) => {
                    const el = e.currentTarget;
                    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
                    if (programmaticScrollRef.current) {
                      if (nearBottom) {
                        programmaticScrollRef.current = false;
                        setIsNearBottom(true);
                        setUnreadNewCount(0);
                        lastSeenSeqRef.current = Math.max(lastSeenSeqRef.current, latestPostSeq);
                      }
                      return;
                    }
                    setIsNearBottom(nearBottom);
                    if (!nearBottom && followLatest) {
                      setFollowLatest(false);
                      lastSeenSeqRef.current = Math.max(lastSeenSeqRef.current, latestPostSeq);
                    } else if (nearBottom && !followLatest) {
                      setFollowLatest(true);
                      setUnreadNewCount(0);
                      lastSeenSeqRef.current = Math.max(lastSeenSeqRef.current, latestPostSeq);
                    }
                  }}
                  className="flex-1 space-y-2.5 overflow-y-auto px-3.5 py-3 sm:px-4 sm:py-3.5"
                  data-testid="swarm-board-feed"
                >
                  {snapshot.truncatedPosts && snapshot.truncatedPosts > 0 && (
                    <div className="rounded-xl border border-dashed border-border bg-surface/60 px-3 py-2 text-center text-caption text-faint">
                      已省略较早的 {snapshot.truncatedPosts} 条历史记录，仅展示最近 {snapshot.posts.length} 条
                    </div>
                  )}

                  {filteredPosts.length === 0 ? (
                    <div className="flex h-48 flex-col items-center justify-center gap-2 text-center">
                      <span className="oc-icon-badge oc-icon-badge-accent flex size-10 items-center justify-center rounded-2xl">
                        <AtelierIcon name="swarm" size={20} />
                      </span>
                      <p className="text-body font-medium text-fg">
                        {mergedPosts.length === 0
                          ? "蜂群讨论板尚未产生消息"
                          : "当前筛选条件下暂无匹配讨论"}
                      </p>
                      <p className="text-caption text-faint">
                        {mergedPosts.length === 0
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
                        optimistic={optimisticSeqSet.has(post.seq)}
                        onMention={handleMention}
                        onChannel={handleChannel}
                        onJumpSeq={jumpToSeq}
                        onQuote={onQuoteToComposer ? quotePostToMainline : undefined}
                        registerRowRef={registerRowRef}
                      />
                    ))
                  )}
                </div>

                {/* Floating jump-to-bottom micro button when scrolled away from bottom */}
                {!isNearBottom && filteredPosts.length > 0 && (
                  <button
                    type="button"
                    data-testid="swarm-scroll-bottom-btn"
                    aria-label="回到底部最新讨论"
                    onClick={() => {
                      setFollowLatest(true);
                      setIsNearBottom(true);
                      setUnreadNewCount(0);
                      lastSeenSeqRef.current = Math.max(lastSeenSeqRef.current, latestPostSeq);
                      scrollFeedToBottom(true);
                    }}
                    className="oc-surface-glass oc-spring-press oc-hover-lift absolute bottom-3 right-3 z-10 inline-flex min-h-11 items-center gap-1 rounded-full border border-border-strong/70 px-3 py-1.5 text-caption font-medium text-fg shadow-float sm:bottom-3.5 sm:right-4 sm:min-h-0 sm:px-2.5"
                  >
                    <ArrowDown size={13} strokeWidth={2} className="text-accent" />
                    <span>
                      {unreadNewCount > 0 ? `${unreadNewCount} 条新讨论` : "回到底部"}
                    </span>
                  </button>
                )}
              </div>

              {/* Interactive Swarm Command Console */}
              <SwarmCommandBar
                sessionId={sessionId}
                auth={effectiveAuth}
                members={snapshot.members}
                selectedMember={selectedMember}
                selectedChannel={selectedChannel}
                active={active}
                onFollowUpToComposer={onQuoteToComposer ? followUpSummaryToMainline : undefined}
                onOptimisticSteer={handleOptimisticSteer}
              />

              {/* Subtle keyboard legend footer */}
              <div className="hidden items-center justify-between border-t border-border/70 bg-surface/60 px-4 py-2 text-micro text-faint sm:flex">
                <span>点击 @成员 可聚焦协作流 · 点击 #序号 快速定位引用</span>
                <span className="inline-flex items-center gap-1.5">
                  <kbd className="oc-kbd px-1 py-0 text-micro">[</kbd>
                  <kbd className="oc-kbd px-1 py-0 text-micro">]</kbd>
                  <span>上下条</span>
                  <span aria-hidden="true">·</span>
                  <kbd className="oc-kbd px-1 py-0 text-micro">Esc</kbd>
                  <span>关闭</span>
                </span>
              </div>
            </section>
          </div>
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}
