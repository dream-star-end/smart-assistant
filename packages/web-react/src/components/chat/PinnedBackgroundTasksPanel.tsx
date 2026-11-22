import type { MediaGenerationJob } from "@openclaude/protocol/mediaGeneration";
import {
  Check,
  Clock,
  Film,
  Image as ImageIcon,
  LoaderCircle,
  Pause,
  Play,
  Trash2,
  X,
} from "lucide-react";
import { useState } from "react";
import { cronHuman } from "../../lib/cron";
import {
  firstLinePreview,
  formatCompactElapsed,
  formatCountdown,
  isTerminalMediaJobStatus,
  isTerminalMuseJobStatus,
  type SessionBgCommandItem,
  type SessionCronItem,
  type SessionMuseJobItem,
} from "../../lib/chat/sessionBackgroundTasks";
import { cn } from "../../lib/utils";
import { Button } from "../ui";
import { AtelierIcon } from "../ui/AtelierIcons";

export type PinnedBackgroundTasksPanelProps = {
  museJobs: SessionMuseJobItem[];
  mediaJobs: MediaGenerationJob[];
  bgCommands: SessionBgCommandItem[];
  sessionCrons: SessionCronItem[];
  now: number;
  onCancelMuseJob?: (jobId: string) => Promise<boolean>;
  onDismissMuseJob?: (jobId: string) => void;
  onCancelMediaJob?: (jobId: string) => Promise<boolean>;
  onCancelBgCommand?: (entryId: string) => Promise<boolean>;
  onToggleSessionCron?: (cronId: string, enabled: boolean) => Promise<boolean>;
  onDeleteSessionCron?: (cronId: string) => Promise<boolean>;
};

function museStatusBadge(job: SessionMuseJobItem): {
  label: string;
  tone: "accent" | "success" | "danger" | "muted";
} {
  switch (job.status) {
    case "queued":
      if (job.queuePosition && job.queuePosition > 0) {
        return {
          label: job.queueLength
            ? `排队第 ${job.queuePosition}/${job.queueLength} 位`
            : `排队第 ${job.queuePosition} 位`,
          tone: "muted",
        };
      }
      return { label: "排队中", tone: "muted" };
    case "running":
      return { label: "生成中", tone: "accent" };
    case "succeeded":
      return { label: "已完成", tone: "success" };
    case "failed":
      return { label: "生成失败", tone: "danger" };
    case "cancelled":
      return { label: "已取消", tone: "muted" };
  }
}

function mediaJobStatusBadge(job: MediaGenerationJob): {
  label: string;
  tone: "accent" | "success" | "danger" | "muted";
} {
  switch (job.status) {
    case "queued":
    case "dispatching":
      return {
        label:
          job.queuePosition && job.queuePosition > 0
            ? `排队第 ${job.queuePosition} 位`
            : "排队中",
        tone: "muted",
      };
    case "running":
      if (job.currentStep != null && job.totalSteps && job.totalSteps > 0) {
        return { label: `生成中 ${job.currentStep}/${job.totalSteps}`, tone: "accent" };
      }
      return { label: "生成中", tone: "accent" };
    case "reconnecting":
      return { label: "重连中", tone: "accent" };
    case "completed":
      return { label: "已完成", tone: "success" };
    case "failed":
      return { label: "生成失败", tone: "danger" };
    case "canceled":
      return { label: "已取消", tone: "muted" };
  }
}

function StatusPill({
  label,
  tone,
}: {
  label: string;
  tone: "accent" | "success" | "danger" | "muted";
}) {
  return (
    <span
      className={cn(
        "oc-bg-tasks-pill shrink-0",
        tone === "accent" && "oc-bg-tasks-pill-accent",
        tone === "success" && "oc-bg-tasks-pill-success",
        tone === "danger" && "oc-bg-tasks-pill-danger",
        tone === "muted" && "oc-bg-tasks-pill-muted",
      )}
    >
      {label}
    </span>
  );
}

function MediaStatusIcon({ status }: { status: string }) {
  if (status === "succeeded" || status === "completed") {
    return <Check className="size-3.5 shrink-0 text-success" aria-hidden />;
  }
  if (status === "failed" || status === "cancelled" || status === "canceled") {
    return <X className="size-3.5 shrink-0 text-danger" aria-hidden />;
  }
  if (status === "queued" || status === "dispatching") {
    return <Clock className="size-3.5 shrink-0 text-faint" aria-hidden />;
  }
  return <LoaderCircle className="size-3.5 shrink-0 animate-spin text-accent" aria-hidden />;
}

function parseIsoMs(iso: string | undefined): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

export function PinnedBackgroundTasksPanel({
  museJobs,
  mediaJobs,
  bgCommands,
  sessionCrons,
  now,
  onCancelMuseJob,
  onDismissMuseJob,
  onCancelMediaJob,
  onCancelBgCommand,
  onToggleSessionCron,
  onDeleteSessionCron,
}: PinnedBackgroundTasksPanelProps) {
  const [busyKeys, setBusyKeys] = useState<ReadonlySet<string>>(() => new Set());

  const hasMedia = museJobs.length > 0 || mediaJobs.length > 0;
  const hasCmds = bgCommands.length > 0;
  const hasCrons = sessionCrons.length > 0;

  if (!hasMedia && !hasCmds && !hasCrons) return null;

  const runAction = async (key: string, fn: () => Promise<unknown> | void) => {
    if (busyKeys.has(key)) return;
    setBusyKeys((prev) => new Set(prev).add(key));
    try {
      await fn();
    } finally {
      setBusyKeys((prev) => {
        if (!prev.has(key)) return prev;
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  return (
    <div
      className="mx-auto mb-2 w-full max-w-3xl px-4"
      data-testid="pinned-background-tasks-panel"
    >
      <div className="oc-surface-glass oc-bg-tasks-panel overflow-hidden rounded-xl shadow-soft">
        {hasMedia && (
          <section className="oc-bg-tasks-section" aria-label="异步媒体任务">
            <div className="oc-bg-tasks-section-head">
              <span className="oc-bg-tasks-section-title">异步媒体</span>
              <span className="oc-bg-tasks-section-count">
                {museJobs.length + mediaJobs.length}
              </span>
            </div>
            <div className="flex flex-col gap-1.5">
              {museJobs.map((job) => {
                const terminal = isTerminalMuseJobStatus(job.status);
                const badge = museStatusBadge(job);
                const anchor = job.startedAt ?? job.queuedAt;
                const elapsed =
                  !terminal && anchor > 0 ? formatCompactElapsed(Math.max(0, now - anchor)) : "";
                const busy = busyKeys.has(`muse:${job.id}`);
                const prompt = firstLinePreview(job.promptPreview) || (job.kind === "video" ? "视频生成" : "图片生成");
                return (
                  <div
                    key={job.id}
                    className="oc-bg-tasks-row"
                    data-testid={`bg-muse-row-${job.id}`}
                  >
                    <span className="mt-0.5 shrink-0">
                      <MediaStatusIcon status={job.status} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span className="inline-flex shrink-0 items-center gap-1 text-caption text-muted">
                          {job.kind === "video" ? (
                            <Film className="size-3" aria-hidden />
                          ) : (
                            <ImageIcon className="size-3" aria-hidden />
                          )}
                          {job.kind === "video" ? "视频" : "图片"}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-body text-fg" title={job.promptPreview || prompt}>
                          {prompt}
                        </span>
                      </div>
                      <div className="mt-0.5 flex items-center gap-2">
                        <StatusPill label={badge.label} tone={badge.tone} />
                        {elapsed ? (
                          <span className="font-mono text-caption tabular-nums text-faint">
                            {elapsed}
                          </span>
                        ) : null}
                        {job.errorCode ? (
                          <span className="truncate text-caption text-danger" title={job.errorCode}>
                            {job.errorCode}
                          </span>
                        ) : null}
                      </div>
                    </div>
                    {terminal ? (
                      onDismissMuseJob ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="shrink-0"
                          onClick={() => onDismissMuseJob(job.id)}
                        >
                          知道了
                        </Button>
                      ) : null
                    ) : onCancelMuseJob ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        aria-label={`取消媒体任务：${prompt}`}
                        className="shrink-0 text-muted hover:bg-danger/10 hover:text-danger"
                        onClick={() => void runAction(`muse:${job.id}`, () => onCancelMuseJob(job.id))}
                      >
                        {busy ? "取消中…" : "取消"}
                      </Button>
                    ) : null}
                  </div>
                );
              })}

              {mediaJobs.map((job) => {
                const terminal = isTerminalMediaJobStatus(job.status);
                const badge = mediaJobStatusBadge(job);
                const createdMs = parseIsoMs(job.createdAt);
                const elapsed =
                  !terminal && createdMs > 0
                    ? formatCompactElapsed(Math.max(0, now - createdMs))
                    : "";
                const busy = busyKeys.has(`media:${job.id}`);
                const prompt =
                  firstLinePreview(job.prompt ?? "") ||
                  (job.kind === "video_compose" ? "视频合成" : "视频生成");
                return (
                  <div
                    key={job.id}
                    className="oc-bg-tasks-row"
                    data-testid={`bg-media-row-${job.id}`}
                  >
                    <span className="mt-0.5 shrink-0">
                      <MediaStatusIcon status={job.status} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span className="inline-flex shrink-0 items-center gap-1 text-caption text-muted">
                          <Film className="size-3" aria-hidden />
                          {job.kind === "video_compose" ? "合成" : "视频"}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-body text-fg" title={job.prompt || prompt}>
                          {prompt}
                        </span>
                      </div>
                      <div className="mt-0.5 flex items-center gap-2">
                        <StatusPill label={badge.label} tone={badge.tone} />
                        {elapsed ? (
                          <span className="font-mono text-caption tabular-nums text-faint">
                            {elapsed}
                          </span>
                        ) : null}
                        {job.errorMessage ? (
                          <span className="truncate text-caption text-danger" title={job.errorMessage}>
                            {firstLinePreview(job.errorMessage)}
                          </span>
                        ) : null}
                      </div>
                    </div>
                    {terminal ? (
                      onDismissMuseJob ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="shrink-0"
                          onClick={() => onDismissMuseJob(job.id)}
                        >
                          知道了
                        </Button>
                      ) : null
                    ) : onCancelMediaJob ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        aria-label={`取消媒体任务：${prompt}`}
                        className="shrink-0 text-muted hover:bg-danger/10 hover:text-danger"
                        onClick={() =>
                          void runAction(`media:${job.id}`, () => onCancelMediaJob(job.id))
                        }
                      >
                        {busy ? "取消中…" : "取消"}
                      </Button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {hasCmds && (
          <section className="oc-bg-tasks-section" aria-label="后台命令">
            <div className="oc-bg-tasks-section-head">
              <span className="oc-bg-tasks-section-title">后台命令</span>
              <span className="oc-bg-tasks-section-count">{bgCommands.length}</span>
            </div>
            <div className="flex flex-col gap-1.5">
              {bgCommands.map((cmd) => {
                const elapsed =
                  cmd.startedAt > 0
                    ? formatCompactElapsed(Math.max(0, now - cmd.startedAt))
                    : "";
                const busy = busyKeys.has(`cmd:${cmd.id}`);
                const preview = firstLinePreview(cmd.commandPreview) || cmd.jobId;
                return (
                  <div
                    key={cmd.id}
                    className="oc-bg-tasks-row"
                    data-testid={`bg-cmd-row-${cmd.id}`}
                  >
                    <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center text-accent">
                      <AtelierIcon name="terminal" size={14} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div
                        className="truncate font-mono text-meta text-fg"
                        title={cmd.commandPreview}
                      >
                        {preview}
                      </div>
                      <div className="mt-0.5 flex items-center gap-2 text-caption text-faint">
                        <StatusPill label="运行中" tone="accent" />
                        {elapsed ? (
                          <span className="font-mono tabular-nums">{elapsed}</span>
                        ) : null}
                        {cmd.cwd ? (
                          <span className="hidden truncate sm:inline" title={cmd.cwd}>
                            {cmd.cwd}
                          </span>
                        ) : null}
                      </div>
                    </div>
                    {onCancelBgCommand ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        aria-label={`终止后台命令：${preview}`}
                        className="shrink-0 text-muted hover:bg-danger/10 hover:text-danger"
                        onClick={() =>
                          void runAction(`cmd:${cmd.id}`, () => onCancelBgCommand(cmd.id))
                        }
                      >
                        {busy ? "终止中…" : "终止"}
                      </Button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {hasCrons && (
          <section className="oc-bg-tasks-section" aria-label="定时续跑">
            <div className="oc-bg-tasks-section-head">
              <span className="oc-bg-tasks-section-title">定时续跑</span>
              <span className="oc-bg-tasks-section-count">{sessionCrons.length}</span>
            </div>
            <div className="flex flex-col gap-1.5">
              {sessionCrons.map((cron) => {
                const countdown = cron.enabled ? formatCountdown(cron.nextRunAt, now) : "";
                const scheduleText = cron.schedule ? cronHuman(cron.schedule) : "";
                const toggleBusy = busyKeys.has(`cron-toggle:${cron.id}`);
                const deleteBusy = busyKeys.has(`cron-del:${cron.id}`);
                const anyBusy = toggleBusy || deleteBusy;
                return (
                  <div
                    key={cron.id}
                    className="oc-bg-tasks-row"
                    data-testid={`bg-cron-row-${cron.id}`}
                  >
                    <Clock
                      className={cn(
                        "mt-0.5 size-3.5 shrink-0",
                        cron.enabled ? "text-accent" : "text-faint",
                      )}
                      aria-hidden
                    />
                    <div className="min-w-0 flex-1">
                      <div
                        className={cn(
                          "truncate text-body",
                          cron.enabled ? "text-fg" : "text-muted",
                        )}
                        title={cron.prompt || cron.name}
                      >
                        {cron.name}
                      </div>
                      <div className="mt-0.5 flex items-center gap-2 text-caption text-faint">
                        {cron.enabled ? (
                          <StatusPill label={countdown || "待触发"} tone="accent" />
                        ) : (
                          <StatusPill label="已暂停" tone="muted" />
                        )}
                        {scheduleText ? (
                          <span className="truncate" title={cron.schedule}>
                            {scheduleText}
                          </span>
                        ) : null}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {onToggleSessionCron ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={anyBusy}
                          aria-label={
                            cron.enabled
                              ? `暂停定时续跑：${cron.name}`
                              : `恢复定时续跑：${cron.name}`
                          }
                          className="gap-1 text-muted hover:text-fg"
                          onClick={() =>
                            void runAction(`cron-toggle:${cron.id}`, () =>
                              onToggleSessionCron(cron.id, !cron.enabled),
                            )
                          }
                        >
                          {cron.enabled ? (
                            <>
                              <Pause className="size-3" aria-hidden />
                              <span>{toggleBusy ? "处理中…" : "暂停"}</span>
                            </>
                          ) : (
                            <>
                              <Play className="size-3" aria-hidden />
                              <span>{toggleBusy ? "处理中…" : "恢复"}</span>
                            </>
                          )}
                        </Button>
                      ) : null}
                      {onDeleteSessionCron ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={anyBusy}
                          aria-label={`删除定时续跑：${cron.name}`}
                          className="text-muted hover:bg-danger/10 hover:text-danger"
                          onClick={() =>
                            void runAction(`cron-del:${cron.id}`, () =>
                              onDeleteSessionCron(cron.id),
                            )
                          }
                        >
                          <Trash2 className="size-3.5" aria-hidden />
                          <span className="sr-only">删除</span>
                        </Button>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
