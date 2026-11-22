/**
 * SwarmMemberProfileBar — Collapsible member telemetry & error dossier strip
 * rendered at the top of SwarmBoardDrawer's feed when a member is focused.
 */
import type { SwarmMemberSnapshot } from "@openclaude/protocol/browser";
import {
  Activity,
  AlertTriangle,
  ChevronDown,
  Clock3,
  Cpu,
  FolderGit2,
  GitBranch,
  Hash,
  Wrench,
} from "lucide-react";
import { memo, useState } from "react";
import { cn } from "../../lib/utils";
import { Badge } from "../ui";
import { ModelFamilyIcon } from "../ui/ModelFamilyIcons";
import {
  formatCompactTokenCount,
  formatTelemetryDuration,
  formatTelemetryTokens,
  humanizeSwarmModel,
  memberInitial,
  swarmMemberStyle,
  swarmRoleLabel,
  swarmStatusLabel,
  swarmWorkspaceBadge,
} from "./swarmUtils";

export const SwarmMemberProfileBar = memo(function SwarmMemberProfileBar({
  member,
  activeSwarm,
  onJumpSeq,
}: {
  member: SwarmMemberSnapshot;
  activeSwarm: boolean;
  onJumpSeq?: (seq: number) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const style = swarmMemberStyle(member.name, member.role);
  const working = member.status === "working" && activeSwarm;
  const modelText = humanizeSwarmModel(member.model);
  const wsBadge = swarmWorkspaceBadge(member.workspace);
  const elapsedText = formatTelemetryDuration(member.elapsedMs);
  const tokensText = formatTelemetryTokens(member.inputTokens, member.outputTokens);
  const approxPrefix = member.telemetryPartial ? "~" : "";

  const cacheRead =
    typeof member.cacheReadTokens === "number" && Number.isFinite(member.cacheReadTokens) && member.cacheReadTokens > 0
      ? member.cacheReadTokens
      : 0;
  const inputCount =
    typeof member.inputTokens === "number" && Number.isFinite(member.inputTokens) && member.inputTokens >= 0
      ? member.inputTokens
      : 0;
  const cacheRate =
    cacheRead > 0 && inputCount + cacheRead > 0
      ? Math.min(100, Math.round((cacheRead / (inputCount + cacheRead)) * 100))
      : null;
  const thinkingTokens =
    typeof member.thinkingTokens === "number" && Number.isFinite(member.thinkingTokens) && member.thinkingTokens > 0
      ? member.thinkingTokens
      : 0;

  const statusTone = member.failed
    ? "danger"
    : working
      ? "accent"
      : member.status === "killed"
        ? "neutral"
        : "success";

  return (
    <div
      data-testid="swarm-member-profile-bar"
      className="border-b border-border/70 bg-surface/75 px-3.5 py-2 sm:px-4"
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "flex size-6 shrink-0 items-center justify-center rounded-md text-caption font-semibold",
            style.avatar,
          )}
        >
          {memberInitial(member.name)}
        </span>
        <span className="truncate text-meta font-semibold text-fg">@{member.name}</span>
        <span className="shrink-0 rounded bg-hover px-1.5 py-0.5 text-micro text-muted">
          {swarmRoleLabel(member.role)}
        </span>
        <Badge tone={statusTone} size="sm" className="shrink-0">
          {member.failed ? "异常" : swarmStatusLabel(member.status)}
        </Badge>
        {modelText && (
          <span className="hidden min-w-0 items-center gap-1 truncate text-caption text-muted sm:inline-flex">
            <ModelFamilyIcon model={member.model ?? modelText} size={13} className="shrink-0" />
            <span className="truncate">{modelText}</span>
          </span>
        )}
        <button
          type="button"
          data-testid="swarm-member-profile-toggle"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((v) => !v)}
          className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-caption text-muted transition-colors hover:bg-hover hover:text-fg"
        >
          <span>{collapsed ? "展开档案" : "收起档案"}</span>
          <ChevronDown
            size={12}
            className={cn("transition-transform duration-150", !collapsed && "rotate-180")}
          />
        </button>
      </div>

      {!collapsed && (
        <div className="mt-2 space-y-2 text-caption">
          {/* Full untruncated error or activity */}
          {member.lastError && (
            <div
              data-testid="swarm-member-profile-error"
              className="oc-callout oc-callout-danger flex items-start gap-2 rounded-xl px-2.5 py-2 text-danger"
            >
              <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1 whitespace-pre-wrap break-words leading-relaxed">
                {member.lastError}
              </span>
            </div>
          )}

          {member.activity && (
            <p
              data-testid="swarm-member-profile-activity"
              className="whitespace-pre-wrap break-words leading-relaxed text-fg/90"
            >
              <span className="mr-1.5 text-faint">当前动作:</span>
              {member.activity}
            </p>
          )}

          {/* Metadata & telemetry chips */}
          <div className="flex flex-wrap items-center gap-1.5 text-micro text-muted">
            {modelText && (
              <span className="inline-flex items-center gap-1 rounded-md bg-hover px-2 py-0.5 sm:hidden">
                <ModelFamilyIcon model={member.model ?? modelText} size={11} className="shrink-0" />
                {modelText}
              </span>
            )}
            {(wsBadge || member.workspaceBranch || member.workspacePath) && (
              <span
                data-testid="swarm-member-profile-workspace"
                title={member.workspacePath || member.workspaceBranch || wsBadge?.title}
                className="inline-flex max-w-full items-center gap-1 rounded-md bg-info-soft px-2 py-0.5 font-mono text-info"
              >
                {member.workspacePath ? <FolderGit2 size={10} className="shrink-0" /> : <GitBranch size={10} className="shrink-0" />}
                <span className="truncate">
                  {member.workspaceBranch
                    ? `${wsBadge?.label ?? "worktree"} · ${member.workspaceBranch}`
                    : wsBadge?.label ?? member.workspacePath}
                </span>
              </span>
            )}
            {elapsedText && (
              <span className="inline-flex items-center gap-1 rounded-md bg-hover px-2 py-0.5 font-mono tabular-nums">
                <Clock3 size={10} aria-hidden className="text-faint" />
                {approxPrefix}
                {elapsedText}
              </span>
            )}
            {tokensText && (
              <span className="inline-flex items-center gap-1 rounded-md bg-hover px-2 py-0.5 font-mono tabular-nums">
                <Activity size={10} aria-hidden className="text-faint" />
                {approxPrefix}
                {tokensText}
              </span>
            )}
            {cacheRead > 0 && (
              <span
                data-testid="swarm-member-profile-cache"
                title={`缓存读取 ${formatCompactTokenCount(cacheRead)} tokens`}
                className="inline-flex items-center gap-1 rounded-md bg-hover px-2 py-0.5 font-mono tabular-nums"
              >
                缓存 {formatCompactTokenCount(cacheRead)}
                {cacheRate !== null ? ` (${cacheRate}%)` : ""}
              </span>
            )}
            {thinkingTokens > 0 && (
              <span
                title="思考过程 Token"
                className="inline-flex items-center gap-1 rounded-md bg-hover px-2 py-0.5 font-mono tabular-nums"
              >
                <Cpu size={10} aria-hidden className="text-faint" />
                思考 {formatCompactTokenCount(thinkingTokens)}
              </span>
            )}
            {typeof member.toolCalls === "number" && (
              <span className="inline-flex items-center gap-1 rounded-md bg-hover px-2 py-0.5 font-mono tabular-nums">
                <Wrench size={10} aria-hidden className="text-faint" />
                {approxPrefix}
                {member.toolCalls} 次工具
              </span>
            )}
            {member.stepCount > 0 && (
              <span className="inline-flex items-center gap-1 rounded-md bg-hover px-2 py-0.5 font-mono tabular-nums">
                {member.stepCount} 步
              </span>
            )}
            {member.lastPostSeq !== undefined && onJumpSeq && (
              <button
                type="button"
                onClick={() => onJumpSeq(member.lastPostSeq!)}
                className="inline-flex items-center gap-0.5 rounded-md bg-accent-soft px-2 py-0.5 font-mono font-medium text-accent transition-colors hover:bg-accent/20"
              >
                <Hash size={10} />
                最近讨论 #{member.lastPostSeq}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
});
