/**
 * SwarmInlineCard — In-timeline architectural overview card for Antigravity native swarms (OCV5-809).
 *
 * Crafted in Aurora design language: crisp hairline surface, luminous gradient crest when active,
 * interactive bento member telemetry grid (click any worker to inspect its board threads),
 * and live board pulse strip. Survives page refresh via persisted `SwarmBoard` tool rows.
 */
import type { SwarmMemberSnapshot, SwarmSnapshot } from "@openclaude/protocol/browser";
import {
  AlertTriangle,
  ArrowUpRight,
  ChevronRight,
  GitBranch,
  Hash,
  MessageSquare,
  Users,
} from "lucide-react";
import { memo, useEffect, useState } from "react";
import { cn } from "../../lib/utils";
import { Badge, Button, Spinner } from "../ui";
import { AtelierIcon } from "../ui/AtelierIcons";
import { ModelFamilyIcon } from "../ui/ModelFamilyIcons";
import "./liveActivity.css";
import {
  formatPostClock,
  formatSwarmElapsed,
  humanizeSwarmModel,
  isSwarmActive,
  memberInitial,
  summarizeSwarmCounts,
  swarmMemberStyle,
  swarmPhaseMeta,
  swarmRoleLabel,
  swarmStatusLabel,
  swarmWorkspaceBadge,
  tokenizeSwarmInlineText,
  type SwarmOpenRequest,
} from "./swarmUtils";

function InlineRichLine({
  text,
  onClickMember,
  onClickChannel,
}: {
  text: string;
  onClickMember?: (name: string) => void;
  onClickChannel?: (channel: string) => void;
}) {
  const firstLine = text.replace(/\s+/g, " ").trim().slice(0, 180);
  const tokens = tokenizeSwarmInlineText(firstLine);
  return (
    <span>
      {tokens.map((tok, idx) => {
        if (tok.kind === "mention") {
          return (
            <button
              key={idx}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                if (tok.target !== "all") onClickMember?.(tok.target);
              }}
              className="mx-0.5 inline-flex items-center rounded bg-accent-soft px-1 py-0 text-caption font-medium text-accent transition-colors hover:bg-accent/20"
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
              onClick={(e) => {
                e.stopPropagation();
                onClickChannel?.(tok.channel);
              }}
              className="mx-0.5 inline-flex items-center rounded bg-info-soft px-1 py-0 text-caption font-medium text-info transition-colors hover:bg-info/20"
            >
              {tok.value}
            </button>
          );
        }
        if (tok.kind === "seq") {
          return (
            <span
              key={idx}
              className="mx-0.5 inline-flex items-center rounded bg-hover px-1 py-0 font-mono text-caption text-muted"
            >
              {tok.value}
            </span>
          );
        }
        return <span key={idx}>{tok.value}</span>;
      })}
      {text.trim().length > 180 ? "…" : ""}
    </span>
  );
}

export const SwarmInlineCard = memo(function SwarmInlineCard({
  snapshot,
  cardId,
  blockId,
  onOpenBoard,
}: {
  snapshot: SwarmSnapshot;
  cardId?: string;
  blockId?: string;
  onOpenBoard?: (req: SwarmOpenRequest) => void;
}) {
  const openWith = (extra?: { focusMember?: string | null; focusChannel?: string | null; focusSeq?: number | null }) =>
    onOpenBoard?.({ snapshot, cardId, blockId, ...extra });
  const active = isSwarmActive(snapshot.phase);
  const phase = swarmPhaseMeta(snapshot.phase);
  const counts = summarizeSwarmCounts(snapshot.members);
  const visibleChannels = snapshot.channels.filter((c) => !c.archived);
  const recentPosts = snapshot.posts.slice(-3);
  const liveMembers = snapshot.members.filter((m) => m.status !== "killed");
  const killedMembers = snapshot.members.filter((m) => m.status === "killed");

  const [everActive, setEverActive] = useState(active);
  const [userCollapsed, setUserCollapsed] = useState<boolean | null>(null);
  const [showKilled, setShowKilled] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (active) setEverActive(true);
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);

  const collapsed = userCollapsed ?? (!active && !everActive);
  const elapsed = active ? formatSwarmElapsed(snapshot.startedAt, now) : "";
  const iconBadgeTone = active
    ? "oc-icon-badge-accent"
    : snapshot.phase === "completed"
      ? "oc-icon-badge-success"
      : snapshot.phase === "error"
        ? "oc-icon-badge-danger"
        : "oc-icon-badge-warning";

  const renderMemberCard = (member: SwarmMemberSnapshot) => {
    const style = swarmMemberStyle(member.name, member.role);
    const working = member.status === "working" && active;
    const killed = member.status === "killed";
    const modelText = humanizeSwarmModel(member.model);
    const wsBadge = swarmWorkspaceBadge(member.workspace);
    return (
      <button
        key={member.name}
        type="button"
        onClick={() => openWith({ focusMember: member.name })}
        disabled={!onOpenBoard}
        className={cn(
          "oc-surface-card oc-surface-card-hover oc-stagger-in oc-hover-lift oc-spring-press flex flex-col gap-1.5 rounded-xl p-2.5 text-left transition-all duration-150",
          "outline-none focus-visible:ring-2 focus-visible:ring-ring",
          working
            ? "border-accent/35 ring-1 ring-accent/15 hover:border-accent/55"
            : killed
              ? "opacity-70 hover:opacity-95"
              : "",
        )}
      >
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "relative flex size-6 shrink-0 items-center justify-center rounded-md text-caption font-semibold",
              style.avatar,
            )}
          >
            {memberInitial(member.name)}
            <span
              aria-label={swarmStatusLabel(member.status)}
              title={swarmStatusLabel(member.status)}
              data-testid={`swarm-member-dot-${member.name}`}
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
              <span className="truncate text-meta font-semibold text-fg">
                @{member.name}
              </span>
              <span className="shrink-0 rounded bg-hover px-1 py-0 text-micro text-muted">
                {swarmRoleLabel(member.role)}
              </span>
              {wsBadge && (
                <span
                  title={wsBadge.title}
                  className="inline-flex shrink-0 items-center gap-0.5 rounded bg-info-soft px-1 py-0 text-micro font-medium text-info"
                >
                  <GitBranch size={9} />
                  {wsBadge.label}
                </span>
              )}
            </div>
            {(modelText || (member.stepCount > 0 && !killed)) && (
              <div className="flex items-center gap-1 truncate text-micro text-faint">
                {modelText && (
                  <span className="inline-flex min-w-0 items-center gap-1 truncate">
                    <ModelFamilyIcon model={member.model ?? modelText} size={13} className="shrink-0 text-muted" />
                    <span className="truncate">{modelText}</span>
                  </span>
                )}
                {member.stepCount > 0 && !killed && (
                  <span className="hidden shrink-0 font-mono text-faint/70 tabular-nums sm:inline">
                    {modelText ? "· " : ""}
                    {member.stepCount} 步
                  </span>
                )}
              </div>
            )}
          </div>
          {member.unreadCount > 0 && active && (
            <span
              title={`${member.unreadCount} 条未读讨论`}
              className="shrink-0 rounded-full bg-accent-soft px-1.5 py-0.5 font-mono text-micro font-medium text-accent tabular-nums"
            >
              +{member.unreadCount}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 text-caption">
          <span
            className={cn(
              "min-w-0 flex-1 truncate",
              member.failed
                ? "text-danger"
                : working
                  ? "text-fg/85 oc-live-status-shine"
                  : "text-muted",
            )}
            title={member.lastError || member.activity || ""}
          >
            {member.failed
              ? member.lastError || "执行异常"
              : member.activity || swarmStatusLabel(member.status)}
          </span>
        </div>
      </button>
    );
  };

  return (
    <div
      data-testid="swarm-inline-card"
      data-swarm-id={snapshot.swarmId}
      data-active={active ? "true" : undefined}
      className={cn(
        "oc-surface-card group relative overflow-hidden rounded-2xl transition-all duration-200",
        active
          ? "oc-border-breathe"
          : "animate-in hover:border-border-strong",
      )}
    >
      {/* Top luminous aurora hairline when swarm is actively coordinating */}
      <div
        aria-hidden
        className={cn(
          "h-[2px] w-full transition-opacity duration-300",
          active ? "bg-grad-cta opacity-100" : "bg-border/60 opacity-40",
        )}
      />

      {/* Header bar: Row 1 gives the title full readable width; Row 2 separates stats+fold from primary CTA */}
      <div className="flex flex-col gap-2 px-3.5 py-2.5">
        <button
          type="button"
          onClick={() => setUserCollapsed(!collapsed)}
          aria-expanded={!collapsed}
          data-testid="swarm-collapse-toggle"
          className="flex min-w-0 items-center gap-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:rounded-lg"
        >
          <span
            data-testid="swarm-header-icon"
            className={cn(
              "oc-icon-badge relative size-7 shrink-0 rounded-lg",
              iconBadgeTone,
            )}
          >
            <AtelierIcon name="swarm" size={15} />
          </span>
          <span className="min-w-0 flex-1 truncate text-section font-semibold tracking-[-0.01em] text-fg">
            {snapshot.title || "蜂群协作"}
          </span>
          <Badge tone={phase.tone} className="shrink-0">
            {phase.label}
          </Badge>
        </button>

        <div className="flex items-center justify-between gap-2 sm:pl-9">
          <button
            type="button"
            onClick={() => setUserCollapsed(!collapsed)}
            aria-expanded={!collapsed}
            className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2.5 gap-y-0.5 text-left text-caption text-faint outline-none transition-colors hover:text-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:rounded"
          >
            <span className="inline-flex items-center gap-1 tabular-nums">
              <Users size={11} />
              {counts.working > 0
                ? `${counts.working} 运行中 / ${counts.live} 活跃`
                : counts.live > 0
                  ? `${counts.live} 名成员`
                  : `${counts.total} 名成员`}
            </span>
            {visibleChannels.length > 1 && (
              <span className="inline-flex items-center gap-0.5 tabular-nums">
                <Hash size={11} />
                {visibleChannels.length} 频道
              </span>
            )}
            <span className="inline-flex items-center gap-1 tabular-nums">
              <MessageSquare size={11} />
              {snapshot.totalPosts} 条讨论
            </span>
            {counts.isolatedWorktrees > 0 && (
              <span
                className="inline-flex items-center gap-0.5 text-info tabular-nums"
                title="成员使用独立 git worktree 隔离修改，收尾前需确认已合入主工作区"
              >
                <GitBranch size={11} />
                {counts.isolatedWorktrees} 独立 worktree
              </span>
            )}
            {elapsed && <span className="font-mono tabular-nums text-muted">{elapsed}</span>}
            {counts.failed > 0 && (
              <span className="inline-flex items-center gap-0.5 text-danger">
                <AlertTriangle size={11} />
                {counts.failed} 异常
              </span>
            )}
            <span className="inline-flex shrink-0 items-center gap-0.5 font-medium text-muted">
              <span>{collapsed ? "展开" : "收起"}</span>
              <ChevronRight
                size={12}
                className={cn(
                  "shrink-0 transition-transform duration-200",
                  collapsed ? "rotate-90" : "-rotate-90",
                )}
              />
            </span>
          </button>

          {onOpenBoard && (
            <Button
              type="button"
              variant={active ? "accent" : "ghost"}
              size="sm"
              onClick={() => openWith()}
              className={cn(
                "oc-btn-tactile oc-spring-press shrink-0 gap-1 rounded-lg px-2.5 text-caption font-semibold",
                active
                  ? "oc-btn-accent-craft oc-shimmer-sheen text-accent-fg"
                  : "border border-accent/25 bg-accent-soft text-accent hover:bg-accent/15",
              )}
              data-testid="swarm-open-board-btn"
            >
              <AtelierIcon name="sparkles" size={13} />
              <span>沉浸看板</span>
              <ArrowUpRight size={12} strokeWidth={1.75} />
            </Button>
          )}
        </div>
      </div>

      {/* Expanded body: Bento Member Grid + Folded Killed Members + Live Board Pulse */}
      {!collapsed && (
        <div className="oc-surface-recessed space-y-3 border-t border-border/80 px-3.5 py-3">
          {/* Member Matrix */}
          {snapshot.members.length > 0 ? (
            <div className="space-y-2">
              {liveMembers.length > 0 && (
                <div
                  className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3"
                  data-testid="swarm-member-grid"
                >
                  {liveMembers.map(renderMemberCard)}
                </div>
              )}

              {killedMembers.length > 0 && (
                <div className="space-y-2" data-testid="swarm-killed-section">
                  <button
                    type="button"
                    data-testid="swarm-killed-toggle"
                    aria-expanded={showKilled}
                    onClick={() => setShowKilled((v) => !v)}
                    className="oc-surface-card oc-spring-press flex w-full items-center gap-2 rounded-xl px-2.5 py-1.5 text-left text-caption text-muted transition-colors hover:border-border-strong hover:text-fg outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
                    <span className="shrink-0 text-micro text-faint">
                      {showKilled ? "收起" : "展开"}
                    </span>
                    <ChevronRight
                      size={13}
                      className={cn(
                        "shrink-0 text-faint transition-transform duration-150",
                        showKilled && "rotate-90",
                      )}
                    />
                  </button>
                  {showKilled && (
                    <div
                      className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3"
                      data-testid="swarm-killed-grid"
                    >
                      {killedMembers.map(renderMemberCard)}
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-2 rounded-xl border border-dashed border-border bg-surface px-3 py-2.5 text-meta text-muted">
              <Spinner size={12} />
              <span>协调者正在拆分任务并招募蜂群成员…</span>
            </div>
          )}

          {/* Live Board Pulse Strip */}
          {recentPosts.length > 0 && (
            <div className="oc-surface-card overflow-hidden rounded-xl">
              <div className="flex items-center justify-between border-b border-border/60 px-3 py-1.5">
                <span className="flex items-center gap-1.5 text-caption font-medium text-muted">
                  <span className="oc-icon-badge oc-icon-badge-accent flex size-4 items-center justify-center rounded-xs">
                    <MessageSquare size={10} strokeWidth={1.75} />
                  </span>
                  实时协作讨论板
                </span>
                {onOpenBoard && snapshot.totalPosts > recentPosts.length && (
                  <button
                    type="button"
                    onClick={() => openWith()}
                    className="text-caption font-medium text-accent transition-opacity hover:opacity-80"
                  >
                    查看全部 {snapshot.totalPosts} 条 →
                  </button>
                )}
              </div>
              <div className="divide-y divide-border/50">
                {recentPosts.map((post) => {
                  const style = swarmMemberStyle(post.agent);
                  const clock = formatPostClock(post.time);
                  return (
                    <div
                      key={post.seq}
                      onClick={() => openWith({ focusChannel: post.channel, focusSeq: post.seq })}
                      className={cn(
                        "flex items-start gap-2 px-3 py-2 text-meta transition-colors",
                        onOpenBoard && "cursor-pointer hover:bg-hover/60",
                      )}
                    >
                      <span className="mt-0.5 shrink-0 font-mono text-micro text-faint tabular-nums">
                        #{post.seq}
                      </span>
                      <span
                        className={cn(
                          "shrink-0 rounded-md border px-1.5 py-0 text-caption font-medium",
                          style.badge,
                        )}
                      >
                        {post.agent}
                      </span>
                      {post.channel && post.channel !== "main" && (
                        <span className="shrink-0 rounded bg-hover px-1 py-0 text-micro text-muted">
                          #{post.channel}
                        </span>
                      )}
                      <span className="min-w-0 flex-1 text-fg/90 leading-snug">
                        <InlineRichLine
                          text={post.text}
                          onClickMember={(name) => openWith({ focusMember: name })}
                          onClickChannel={(ch) => openWith({ focusChannel: ch })}
                        />
                      </span>
                      {clock && (
                        <span className="hidden shrink-0 font-mono text-micro text-faint tabular-nums sm:inline">
                          {clock}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
});
