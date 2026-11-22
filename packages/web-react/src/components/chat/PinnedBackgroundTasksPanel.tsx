import type { MediaGenerationJob } from "@openclaude/protocol/mediaGeneration";
import {
  Check,
  ChevronDown,
  ChevronUp,
  Clock,
  Film,
  Image as ImageIcon,
  LoaderCircle,
  Pause,
  Play,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
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

/** 成功终态条目短暂展示后自动静默收起，不再强迫用户手动点「知道了」。 */
export const AUTO_DISMISS_SUCCEEDED_MS = 4_000;

export type PinnedBackgroundTasksPanelProps = {
  museJobs: SessionMuseJobItem[];
  mediaJobs: MediaGenerationJob[];
  bgCommands: SessionBgCommandItem[];
  sessionCrons: SessionCronItem[];
  now: number;
  /** 为 false 时由外层容器（如 LiveAgentCapsule）统一管理成功终态自动收起，避免重复计时。 */
  autoDismissSucceeded?: boolean;
  onCancelMuseJob?: (jobId: string) => Promise<boolean>;
  onDismissMuseJob?: (jobId: string) => void;
  onCancelMediaJob?: (jobId: string) => Promise<boolean>;
  onCancelBgCommand?: (entryId: string) => Promise<boolean>;
  onToggleSessionCron?: (cronId: string, enabled: boolean) => Promise<boolean>;
  onDeleteSessionCron?: (cronId: string) => Promise<boolean>;
};

const MEDIA_ERROR_LABEL: Record<string, string> = {
  worker_lost: "生成服务意外断开，请稍后重试",
  worker_unreachable: "生成服务暂时不可用，请稍后重试",
  invalid_job_contract: "任务参数无法处理，请重新发起",
  worker_contract_mismatch: "生成结果异常，请稍后重试",
  media_job_execution_failed: "生成过程中出错，请稍后重试",
  upstream_failed: "生成服务暂时出错，请稍后重试",
  generation_failed: "生成失败，请稍后重试",
  h3_oom: "资源不足，请缩短时长或降低分辨率后重试",
  oom: "资源不足，请缩短时长或降低分辨率后重试",
  out_of_memory: "资源不足，请缩短时长或降低分辨率后重试",
  timeout: "生成超时，请稍后重试",
  upstream_timeout: "生成超时，请稍后重试",
  timed_out: "生成超时，请稍后重试",
  invalid_input: "输入素材无法处理，请调整后重试",
  content_policy: "内容不符合生成规范，请调整描述后重试",
  safety_blocked: "内容不符合生成规范，请调整描述后重试",
  policy_violation: "内容不符合生成规范，请调整描述后重试",
  quota_exceeded: "额度不足，请稍后重试",
  insufficient_credits: "积分不足，请充值后重试",
  rate_limited: "请求过于频繁，请稍后重试",
  canceled: "任务已取消",
  cancelled: "任务已取消",
};

/** 把底层 errorCode / 技术堆栈翻译成用户能理解的中文提示，绝不透出裸错误码。 */
export function humanizeMediaError(
  errorCode?: string | null,
  errorMessage?: string | null,
): string | null {
  const code = (errorCode ?? "").trim();
  const message = (errorMessage ?? "").trim();
  if (!code && !message) return null;
  if (code) {
    const mapped = MEDIA_ERROR_LABEL[code.toLowerCase()];
    if (mapped) return mapped;
  }
  if (message) {
    const line = firstLinePreview(message);
    const hasCjk = /[\u4e00-\u9fff]/.test(line);
    const looksTechnical =
      /\b(cuda|oom|econn|etimedout|err_|http\s*\d{3}|stack|exception|traceback|errno)\b/i.test(line) ||
      /^[A-Z0-9_:-]{3,}$/.test(line);
    if (hasCjk && !looksTechnical) return line;
  }
  return "生成失败，请稍后重试";
}

/** 将原始 Shell 命令归类为干净的人话任务标签，主视图彻底隐藏原始命令、环境变量、路径与 jobId。 */
export function summarizeBgCommand(cmd: Pick<SessionBgCommandItem, "commandPreview">): string {
  const raw = (cmd.commandPreview ?? "").trim();
  if (!raw) return "独立后台任务";
  // 去掉行首环境变量赋值（如 HOST_WT="/var/lib/..." FOO=1），只基于实际动作分类
  const normalized = raw
    .replace(/^(?:\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s;]+)\s*;?\s*)+/, "")
    .toLowerCase();
  const text = normalized || raw.toLowerCase();
  if (
    /\b(vitest|pytest|jest|playwright|mocha|ava|unittest|rspec|cypress)\b/.test(text) ||
    /\b(npm|pnpm|yarn|bun|cargo|go|uv)\s+(run\s+)?test\b/.test(text)
  ) {
    return "测试任务";
  }
  if (
    /\b(tsc|vite\s+build|webpack|next\s+build|esbuild|rollup|turbo\s+build|docker\s+build|make|cmake|gradle|mvn)\b/.test(text) ||
    /\b(npm|pnpm|yarn|bun|cargo|go)\s+(run\s+)?(build|typecheck|check)\b/.test(text)
  ) {
    return "构建检查";
  }
  if (
    /\b(eslint|biome|ruff|prettier|flake8|mypy|pyright|clippy|gofmt|golangci-lint)\b/.test(text) ||
    /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(lint|format)\b/.test(text)
  ) {
    return "代码检查";
  }
  if (
    /\b(npm|pnpm|yarn|bun)\s+(install|ci|add|update)\b/.test(text) ||
    /\b(pip|pip3|uv)\s+(install|sync)\b/.test(text) ||
    /\b(apt|apt-get|brew|apk)\s+install\b/.test(text)
  ) {
    return "依赖安装";
  }
  if (/\b(git\s+(clone|fetch|pull|push)|rsync|scp|curl|wget)\b/.test(text)) {
    return "数据同步";
  }
  if (
    /\b(uvicorn|gunicorn|next\s+dev|vite(\s|$)|webpack-dev-server|flask\s+run|manage\.py\s+runserver)\b/.test(text) ||
    /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start|preview|serve)\b/.test(text)
  ) {
    return "后台服务";
  }
  return "独立后台任务";
}

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
      return { label: "恢复中", tone: "accent" };
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
  autoDismissSucceeded = true,
  onCancelMuseJob,
  onDismissMuseJob,
  onCancelMediaJob,
  onCancelBgCommand,
  onToggleSessionCron,
  onDeleteSessionCron,
}: PinnedBackgroundTasksPanelProps) {
  const [busyKeys, setBusyKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [autoHiddenIds, setAutoHiddenIds] = useState<ReadonlySet<string>>(() => new Set());
  const [expandedDetails, setExpandedDetails] = useState<ReadonlySet<string>>(() => new Set());
  const dismissTimersRef = useRef(new Map<string, number>());
  const onDismissMuseJobRef = useRef(onDismissMuseJob);
  onDismissMuseJobRef.current = onDismissMuseJob;

  useEffect(() => {
    const timers = dismissTimersRef.current;
    if (!autoDismissSucceeded) {
      for (const timer of timers.values()) window.clearTimeout(timer);
      timers.clear();
      return;
    }
    const succeededIds = new Set<string>();
    for (const job of museJobs) {
      if (job.status === "succeeded") succeededIds.add(job.id);
    }
    for (const job of mediaJobs) {
      if (job.status === "completed") succeededIds.add(job.id);
    }
    for (const [id, timer] of timers) {
      if (!succeededIds.has(id)) {
        window.clearTimeout(timer);
        timers.delete(id);
      }
    }
    for (const id of succeededIds) {
      if (autoHiddenIds.has(id) || timers.has(id)) continue;
      const timer = window.setTimeout(() => {
        timers.delete(id);
        setAutoHiddenIds((prev) => {
          if (prev.has(id)) return prev;
          const next = new Set(prev);
          next.add(id);
          return next;
        });
        onDismissMuseJobRef.current?.(id);
      }, AUTO_DISMISS_SUCCEEDED_MS);
      timers.set(id, timer);
    }
  }, [autoDismissSucceeded, museJobs, mediaJobs, autoHiddenIds]);

  useEffect(
    () => () => {
      for (const timer of dismissTimersRef.current.values()) window.clearTimeout(timer);
      dismissTimersRef.current.clear();
    },
    [],
  );

  const visibleMuseJobs = museJobs.filter((j) => !(j.status === "succeeded" && autoHiddenIds.has(j.id)));
  const visibleMediaJobs = mediaJobs.filter((j) => !(j.status === "completed" && autoHiddenIds.has(j.id)));

  const hasMedia = visibleMuseJobs.length > 0 || visibleMediaJobs.length > 0;
  const hasCmds = bgCommands.length > 0;
  const hasCrons = sessionCrons.length > 0;

  if (!hasMedia && !hasCmds && !hasCrons) return null;

  const toggleDetails = (id: string) => {
    setExpandedDetails((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

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
                {visibleMuseJobs.length + visibleMediaJobs.length}
              </span>
            </div>
            <div className="flex flex-col gap-1.5">
              {visibleMuseJobs.map((job) => {
                const terminal = isTerminalMuseJobStatus(job.status);
                const succeeded = job.status === "succeeded";
                const badge = museStatusBadge(job);
                const anchor = job.startedAt ?? job.queuedAt;
                const elapsed =
                  !terminal && anchor > 0 ? formatCompactElapsed(Math.max(0, now - anchor)) : "";
                const busy = busyKeys.has(`muse:${job.id}`);
                const prompt = firstLinePreview(job.promptPreview) || (job.kind === "video" ? "视频生成" : "图片生成");
                const errorText = job.status === "failed" ? humanizeMediaError(job.errorCode) : null;
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
                        {errorText ? (
                          <span className="truncate text-caption text-danger" title={errorText}>
                            {errorText}
                          </span>
                        ) : null}
                      </div>
                    </div>
                    {terminal ? (
                      !succeeded && onDismissMuseJob ? (
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

              {visibleMediaJobs.map((job) => {
                const terminal = isTerminalMediaJobStatus(job.status);
                const succeeded = job.status === "completed";
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
                const errorText =
                  job.status === "failed" ? humanizeMediaError(job.errorCode, job.errorMessage) : null;
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
                        {errorText ? (
                          <span className="truncate text-caption text-danger" title={errorText}>
                            {errorText}
                          </span>
                        ) : null}
                      </div>
                    </div>
                    {terminal ? (
                      !succeeded && onDismissMuseJob ? (
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
          <section className="oc-bg-tasks-section" aria-label="后台任务">
            <div className="oc-bg-tasks-section-head">
              <span className="oc-bg-tasks-section-title">后台任务</span>
              <span className="oc-bg-tasks-section-count">{bgCommands.length}</span>
            </div>
            <div className="flex flex-col gap-1.5">
              {bgCommands.map((cmd) => {
                const elapsed =
                  cmd.startedAt > 0
                    ? formatCompactElapsed(Math.max(0, now - cmd.startedAt))
                    : "";
                const busy = busyKeys.has(`cmd:${cmd.id}`);
                const summary = summarizeBgCommand(cmd);
                const hasTechDetails = Boolean(cmd.commandPreview || cmd.cwd || cmd.jobId);
                const detailsOpen = expandedDetails.has(cmd.id);
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
                      <div className="truncate text-body text-fg">{summary}</div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-2 text-caption text-faint">
                        <StatusPill label="运行中" tone="accent" />
                        {elapsed ? (
                          <span className="font-mono tabular-nums">{elapsed}</span>
                        ) : null}
                        {hasTechDetails ? (
                          <button
                            type="button"
                            data-testid={`bg-cmd-details-toggle-${cmd.id}`}
                            aria-expanded={detailsOpen}
                            onClick={() => toggleDetails(cmd.id)}
                            className="inline-flex items-center gap-0.5 text-caption text-muted underline-offset-2 hover:text-fg hover:underline"
                          >
                            <span>技术详情</span>
                            {detailsOpen ? (
                              <ChevronUp className="size-3" aria-hidden />
                            ) : (
                              <ChevronDown className="size-3" aria-hidden />
                            )}
                          </button>
                        ) : null}
                      </div>
                      {detailsOpen && hasTechDetails ? (
                        <div
                          data-testid={`bg-cmd-details-${cmd.id}`}
                          className="oc-surface-recessed mt-1.5 space-y-1 rounded-md px-2.5 py-1.5 font-mono text-caption text-muted"
                        >
                          {cmd.commandPreview ? (
                            <div className="break-all">
                              <span className="text-faint">命令：</span>
                              {cmd.commandPreview}
                            </div>
                          ) : null}
                          {cmd.cwd ? (
                            <div className="break-all">
                              <span className="text-faint">目录：</span>
                              {cmd.cwd}
                            </div>
                          ) : null}
                          {cmd.jobId ? (
                            <div className="break-all">
                              <span className="text-faint">编号：</span>
                              {cmd.jobId}
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                    {onCancelBgCommand ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        aria-label={`终止后台任务：${summary}`}
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
