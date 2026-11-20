/**
 * PinnedSwarmDock — Floating live HUD docked above the Composer while an Antigravity
 * native swarm is running (or freshly completed before dismiss) (OCV5-809).
 */
import type { SwarmSnapshot } from "@openclaude/protocol/browser";
import { ArrowUpRight, Hexagon, MessageSquare, X } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "../../lib/utils";
import { altKeyLabel } from "../ChatHeader";
import { Badge, Spinner } from "../ui";
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
  dismissed,
  onOpenBoard,
  onDismiss,
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

  if (!snapshot || (dismissed && !active)) return null;

  const counts = summarizeSwarmCounts(snapshot.members);
  const phase = swarmPhaseMeta(snapshot.phase);
  const latestPost = snapshot.posts[snapshot.posts.length - 1] ?? null;
  const elapsed = active ? formatSwarmElapsed(snapshot.startedAt, now) : "";
  const liveMembers = snapshot.members.filter((m) => m.status !== "killed").slice(0, 6);

  return (
    <div className="mx-auto mb-2 w-full max-w-3xl px-4" data-testid="pinned-swarm-dock">
      <div
        className={cn(
          "flex min-h-11 items-center gap-2.5 overflow-hidden rounded-xl border px-3 py-2 backdrop-blur-md transition-all",
          active
            ? "border-accent/35 bg-elevated/95 shadow-float"
            : "border-border bg-elevated/95 shadow-soft",
        )}
      >
        {/* Main clickable area opens the immersive Swarm Board */}
        <button
          type="button"
          onClick={() => onOpenBoard({ snapshot, cardId, blockId })}
          className="flex min-w-0 flex-1 items-center gap-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:rounded-lg"
        >
          <span
            className={cn(
              "relative flex size-6 shrink-0 items-center justify-center rounded-md text-white",
              active ? "bg-grad-cta" : "bg-primary text-primary-fg",
            )}
          >
            <Hexagon size={13} strokeWidth={2.2} />
            {active && (
              <span
                aria-hidden
                className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-brand ring-2 ring-elevated animate-pulse"
              />
            )}
          </span>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-meta font-semibold text-fg">
                {snapshot.title || "蜂群协作"}
              </span>
              <Badge tone={phase.tone} size="sm" className="shrink-0 gap-1 py-0 text-micro">
                {active && <Spinner size={8} />}
                {active
                  ? counts.working > 0
                    ? `${counts.working} 运行中`
                    : `${counts.live} 成员`
                  : phase.label}
              </Badge>
              {elapsed && (
                <span className="hidden shrink-0 font-mono text-micro text-faint tabular-nums sm:inline">
                  {elapsed}
                </span>
              )}
            </div>

            {latestPost ? (
              <div className="mt-0.5 flex items-center gap-1 truncate text-caption text-muted">
                <span className="shrink-0 font-mono text-micro text-faint">#{latestPost.seq}</span>
                <span className="shrink-0 font-medium text-fg/80">{latestPost.agent}:</span>
                <span className="min-w-0 truncate">{latestPost.text.replace(/\s+/g, " ").trim()}</span>
              </div>
            ) : (
              <div className="mt-0.5 truncate text-caption text-faint">
                {active ? "等待成员发布首条协作进展…" : "点击查看蜂群协作全过程"}
              </div>
            )}
          </div>

          {/* Mini member status stack on sm+ */}
          {liveMembers.length > 0 && (
            <div className="hidden shrink-0 items-center -space-x-1.5 sm:flex" aria-hidden>
              {liveMembers.map((m) => {
                const st = swarmMemberStyle(m.name, m.role);
                const isWorking = m.status === "working" && active;
                return (
                  <span
                    key={m.name}
                    title={`@${m.name} · ${swarmStatusLabel(m.status)}${m.activity ? ` · ${m.activity}` : ""}`}
                    className={cn(
                      "relative flex size-6 items-center justify-center rounded-full border-2 border-elevated text-micro font-semibold",
                      st.avatar,
                      isWorking && "ring-1 ring-accent/40",
                    )}
                  >
                    {memberInitial(m.name)}
                    {isWorking && (
                      <span className="absolute -bottom-0.5 -right-0.5 size-1.5 rounded-full bg-accent animate-pulse" />
                    )}
                  </span>
                );
              })}
            </div>
          )}

          {/* Post counter + shortcut cue */}
          <span className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-accent-soft px-2 py-1 text-caption font-medium text-accent transition-colors hover:bg-accent/15">
            <MessageSquare size={11} />
            <span className="tabular-nums">{snapshot.totalPosts}</span>
            <span className="hidden md:inline">看板</span>
            <kbd className="hidden rounded bg-surface/80 px-1 py-0 font-mono text-micro text-muted lg:inline">
              {altKeyLabel()}S
            </kbd>
            <ArrowUpRight size={11} />
          </span>
        </button>

        {!active && (
          <button
            type="button"
            onClick={onDismiss}
            aria-label="收起蜂群底栏"
            title="收起"
            className="flex size-7 shrink-0 items-center justify-center rounded-lg text-faint transition-colors hover:bg-hover hover:text-fg"
          >
            <X size={14} />
          </button>
        )}
      </div>
    </div>
  );
}
