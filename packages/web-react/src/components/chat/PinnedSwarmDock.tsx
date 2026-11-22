/**
 * PinnedSwarmDock — Floating live HUD docked above the Composer while an Antigravity
 * native swarm is actively running (OCV5-809). Auto-hides once the swarm completes
 * so it never duplicates the in-timeline SwarmInlineCard.
 */
import type { SwarmSnapshot } from "@openclaude/protocol/browser";
import { ArrowUpRight, MessageSquare } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "../../lib/utils";
import { altKeyLabel } from "../ChatHeader";
import { Badge } from "../ui";
import { AtelierIcon } from "../ui/AtelierIcons";
import "./liveActivity.css";
import {
  formatSwarmElapsed,
  isSwarmActive,
  memberInitial,
  summarizeSwarmCounts,
  swarmMemberStyle,
  swarmPhaseMeta,
  swarmStatusLabel,
  type SwarmOpenRequest,
} from "./swarmUtils";

export function PinnedSwarmDock({
  snapshot,
  cardId,
  blockId,
  onOpenBoard,
}: {
  snapshot: SwarmSnapshot | null;
  cardId?: string;
  blockId?: string;
  dismissed: boolean;
  onOpenBoard: (req: SwarmOpenRequest) => void;
  onDismiss: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const active = snapshot ? isSwarmActive(snapshot.phase) : false;

  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);

  if (!snapshot || !active) return null;

  const counts = summarizeSwarmCounts(snapshot.members);
  const phase = swarmPhaseMeta(snapshot.phase);
  const latestPost = snapshot.posts[snapshot.posts.length - 1] ?? null;
  const elapsed = formatSwarmElapsed(snapshot.startedAt, now);
  const liveMembers = snapshot.members.filter((m) => m.status !== "killed").slice(0, 6);

  return (
    <div className="mx-auto mb-2 w-full min-w-0 max-w-3xl px-4" data-testid="pinned-swarm-dock">
      <div className="oc-surface-glass oc-border-breathe oc-hover-lift flex min-h-11 min-w-0 max-w-full items-center gap-2 overflow-hidden rounded-2xl px-3 py-2 transition-all">
        {/* Main clickable area opens the immersive Swarm Board */}
        <button
          type="button"
          onClick={() => onOpenBoard({ snapshot, cardId, blockId })}
          className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:rounded-lg"
        >
          <span className="oc-icon-badge oc-icon-badge-accent relative size-6 shrink-0 rounded-md">
            <AtelierIcon name="swarm" size={14} />
          </span>

          <div className="min-w-0 flex-1 overflow-hidden">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="min-w-0 flex-1 truncate text-meta font-semibold text-fg">
                {snapshot.title || "蜂群协作"}
              </span>
              <Badge tone={phase.tone} size="sm" className="shrink-0 gap-1 py-0 text-micro">
                {counts.working > 0 ? `${counts.working} 运行中` : `${counts.live} 成员`}
              </Badge>
              {elapsed && (
                <span className="hidden shrink-0 font-mono text-micro text-faint tabular-nums sm:inline">
                  {elapsed}
                </span>
              )}
            </div>

            {latestPost ? (
              <div className="mt-0.5 flex min-w-0 items-center gap-1 overflow-hidden text-caption text-muted">
                <span className="shrink-0 font-mono text-micro text-faint">#{latestPost.seq}</span>
                <span className="shrink-0 font-medium text-fg/80">{latestPost.agent}:</span>
                <span className="min-w-0 flex-1 truncate">{latestPost.text.replace(/\s+/g, " ").trim()}</span>
              </div>
            ) : (
              <div className="mt-0.5 truncate text-caption text-faint">
                等待成员发布首条协作进展…
              </div>
            )}
          </div>

          {/* Mini member status stack on sm+ */}
          {liveMembers.length > 0 && (
            <div className="hidden shrink-0 items-center -space-x-1.5 sm:flex" aria-hidden>
              {liveMembers.map((m) => {
                const st = swarmMemberStyle(m.name, m.role);
                const isWorking = m.status === "working";
                return (
                  <span
                    key={m.name}
                    title={`@${m.name} · ${swarmStatusLabel(m.status)}${m.activity ? ` · ${m.activity}` : ""}`}
                    className={cn(
                      "relative flex size-6 items-center justify-center rounded-full border-2 border-elevated text-micro font-semibold",
                      st.avatar,
                      isWorking && "ring-1 ring-accent/45",
                    )}
                  >
                    {memberInitial(m.name)}
                    {isWorking && (
                      <span
                        className="absolute -bottom-0.5 -right-0.5 size-1.5 rounded-full bg-accent ring-2 ring-elevated"
                      />
                    )}
                  </span>
                );
              })}
            </div>
          )}

          {/* Post counter + shortcut cue */}
          <span className="oc-btn-tactile oc-spring-press oc-shimmer-sheen inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-accent/25 bg-accent-soft px-2.5 py-1 text-caption font-medium text-accent transition-colors hover:bg-accent/15">
            <MessageSquare size={11} strokeWidth={1.75} className="shrink-0" />
            <span className="tabular-nums">{snapshot.totalPosts}</span>
            <span className="hidden md:inline">看板</span>
            <kbd className="oc-kbd hidden px-1 py-0 text-micro lg:inline">
              {altKeyLabel()}S
            </kbd>
            <ArrowUpRight size={11} strokeWidth={1.75} className="shrink-0" />
          </span>
        </button>
      </div>
    </div>
  );
}
