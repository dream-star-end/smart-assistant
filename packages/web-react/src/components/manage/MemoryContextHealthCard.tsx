import { Archive, ChevronRight, RotateCcw, Sparkles } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { api, apiErrorMessage } from "../../lib/api";
import { type AutoDreamFeatureView, extractAutoDreamFeature } from "../../lib/modelPreferences";
import { taskboardApi, type ProjectMemoryItem } from "../../lib/taskboard";
import type {
  AuthSession,
  ContextHealthReport,
  ContextHygieneRunRecord,
} from "../../lib/types";
import { cn } from "../../lib/utils";
import {
  Alert,
  Badge,
  Button,
  ListGroup,
  ListRow,
  ListSkeleton,
  StatusDot,
  Switch,
  TimeAgo,
  useToast,
} from "../ui";

/** 自动新增记忆的保留天数（storage AUTO_MEMORY_TTL_DAYS）。 */
const AUTO_MEMORY_TTL_DAYS = 30;

// ── W2: 同页内共享真实自动整理开关态，避免状态卡写死「运行中」 ─────────────────
let sharedAutoDreamRunning: boolean | null = null;
const autoDreamStateListeners = new Set<() => void>();

function publishAutoDreamRunning(next: boolean | null): void {
  if (sharedAutoDreamRunning === next) return;
  sharedAutoDreamRunning = next;
  for (const listener of autoDreamStateListeners) listener();
}

function subscribeAutoDreamRunning(listener: () => void): () => void {
  autoDreamStateListeners.add(listener);
  return () => {
    autoDreamStateListeners.delete(listener);
  };
}

function getAutoDreamRunningSnapshot(): boolean | null {
  return sharedAutoDreamRunning;
}

/** 仅单测隔离用：重置共享自动整理运行态。 */
export function _resetAutoDreamRunningForTest(): void {
  publishAutoDreamRunning(null);
}

export type RestoreOutcomePayload = {
  ok?: boolean;
  restored?: unknown[];
  skipped?: unknown[];
  preservedEditedFiles?: string[];
};

function classifySkippedEntry(entry: unknown): "protected" | "corrupted" {
  const raw =
    typeof entry === "string"
      ? entry.trim()
      : entry && typeof entry === "object" && typeof (entry as { reason?: unknown }).reason === "string"
        ? String((entry as { reason: string }).reason).trim()
        : "";
  if (/(?:^|:)target_exists$/i.test(raw)) return "protected";
  return "corrupted";
}

/**
 * W2: 诚实分类撤销/恢复结果，严格区隔「安全保留（人工修改/已存在）」与「归档缺失或损坏」，绝不吞错伪报成功。
 */
export function formatRestoreOutcomeFeedback(
  settled: ReadonlyArray<PromiseSettledResult<RestoreOutcomePayload | null>>,
): { message: string; tone: "success" | "info" | "error"; changed: boolean } {
  let restoredCount = 0;
  let protectedCount = 0;
  let corruptedCount = 0;
  let failedCount = 0;

  for (const item of settled) {
    if (item.status === "rejected") {
      failedCount += 1;
      continue;
    }
    const val = item.value;
    if (!val) continue;
    if (val.ok === false) failedCount += 1;
    restoredCount += Array.isArray(val.restored) ? val.restored.length : 0;
    protectedCount += Array.isArray(val.preservedEditedFiles) ? val.preservedEditedFiles.length : 0;
    if (Array.isArray(val.skipped)) {
      for (const skippedEntry of val.skipped) {
        if (classifySkippedEntry(skippedEntry) === "protected") protectedCount += 1;
        else corruptedCount += 1;
      }
    }
  }

  if (restoredCount === 0) {
    if (corruptedCount > 0 && protectedCount > 0) {
      return {
        message: `恢复未成功：${corruptedCount} 项未能恢复（归档文件缺失或损坏），另有 ${protectedCount} 项因含人工修改或已存在而安全保留`,
        tone: "error",
        changed: false,
      };
    }
    if (corruptedCount > 0) {
      return {
        message: `恢复未成功：${corruptedCount} 项未能恢复（归档文件缺失或损坏）`,
        tone: "error",
        changed: false,
      };
    }
    if (protectedCount > 0 && failedCount === 0) {
      return {
        message: `恢复未成功：${protectedCount} 项因含人工修改或已存在而安全保留`,
        tone: "error",
        changed: false,
      };
    }
    return {
      message: "恢复未成功，请稍后重试",
      tone: "error",
      changed: false,
    };
  }

  const notes: string[] = [];
  if (protectedCount > 0) {
    notes.push(`另有 ${protectedCount} 项因含人工修改或已存在而安全保留`);
  }
  if (corruptedCount > 0) {
    notes.push(`另有 ${corruptedCount} 项未能恢复（归档文件缺失或损坏）`);
  }
  if (failedCount > 0) {
    notes.push("部分内容恢复失败，请稍后重试");
  }
  if (notes.length > 0) {
    return {
      message: `已恢复 ${restoredCount} 项，${notes.join("，")}`,
      tone: "info",
      changed: true,
    };
  }
  return {
    message: `已恢复原样（共恢复 ${restoredCount} 项）`,
    tone: "success",
    changed: true,
  };
}

function projectMemoryTitle(slug: string): string {
  return slug.replace(/\.md$/i, "");
}

function summarizeRecentAutoCare(report: ContextHealthReport, autoRunning: boolean | null): string {
  const runs = report.recentRuns ?? [];
  const latestSemantic = runs.find((r) => typeof r.semanticSummary === "string" && r.semanticSummary.trim());
  if (latestSemantic?.semanticSummary) {
    return latestSemantic.semanticSummary.trim();
  }
  const mergedGroups = runs.reduce((sum, r) => sum + (r.mergedMemoryGroups ?? 0), 0);
  const archivedMemories = runs.reduce((sum, r) => sum + (r.expiredMemoriesArchived ?? 0), 0);
  const archivedSkills = runs.reduce((sum, r) => sum + (r.coldSkillsArchived ?? 0), 0);
  const parts: string[] = [];
  if (mergedGroups > 0) parts.push(`合并了 ${mergedGroups} 组相似记忆`);
  if (archivedMemories > 0) parts.push(`收纳了 ${archivedMemories} 条过期记忆`);
  if (archivedSkills > 0) parts.push(`收纳了 ${archivedSkills} 个久未使用技能`);
  if (parts.length > 0) {
    return `近期后台已自动${parts.join("、")}，随时可在已收纳记录中恢复。`;
  }
  if (autoRunning === false) {
    return "自动整理当前已暂停，可在下方重新开启，或随时查看已收纳记录。";
  }
  return "过期记忆、重复内容与久未使用的技能会自动收纳，你无需手动管理。";
}

function describeHygieneRun(run: ContextHygieneRunRecord): string {
  if (typeof run.semanticSummary === "string" && run.semanticSummary.trim()) {
    return run.semanticSummary.trim();
  }
  const parts: string[] = [];
  if ((run.mergedMemoryGroups ?? 0) > 0) {
    parts.push(`合并 ${run.mergedMemoryGroups} 组相似记忆`);
  }
  if (run.expiredMemoriesArchived > 0) {
    parts.push(`收纳 ${run.expiredMemoriesArchived} 条过期记忆`);
  }
  if (run.coldSkillsArchived > 0) {
    parts.push(`收纳 ${run.coldSkillsArchived} 个久未使用技能`);
  }
  return parts.length > 0 ? parts.join(" · ") : "已自动检查，当前保持干净";
}

/**
 * OCV5-841: 「上下文自动整理」安心托管状态卡（Clarvy Atelier 暖色调）。
 * 状态徽标如实绑定真实自动整理开关态：开启且生效时显示「运行中」，关闭/暂停时显示「已暂停」。
 */
export function ContextHealthSummaryCard({
  report,
  autoEnabled,
  onOpenSlim,
  onOpenArchive,
}: {
  report: ContextHealthReport;
  /** 可选显式开关态；缺省时自动同步同页 AutoDreamToggleRow 的真实开关态。 */
  autoEnabled?: boolean | null;
  onOpenSlim: () => void;
  onOpenArchive: () => void;
}) {
  const sharedRunning = useSyncExternalStore(
    subscribeAutoDreamRunning,
    getAutoDreamRunningSnapshot,
    getAutoDreamRunningSnapshot,
  );
  const effectiveRunning = autoEnabled !== undefined ? autoEnabled : sharedRunning;

  const s = report.summary;
  const archiveTotal = (s.archivedMemoryCount ?? 0) + (s.archivedSkillCount ?? 0);
  const summaryLine = summarizeRecentAutoCare(report, effectiveRunning);

  const isRunning = effectiveRunning === true;
  const isPaused = effectiveRunning === false;

  return (
    <section
      aria-label="上下文自动整理状态"
      data-testid="context-health-summary-card"
      className="oc-surface-card overflow-hidden rounded-xl"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-3.5">
        <div className="flex min-w-0 items-start gap-3">
          <span
            className={cn(
              "oc-icon-badge mt-0.5 size-8 shrink-0 rounded-lg",
              isRunning && "oc-icon-badge-accent",
            )}
            aria-hidden="true"
          >
            <Sparkles size={15} strokeWidth={1.8} />
          </span>
          <div className="min-w-0">
            <h4 className="flex flex-wrap items-center gap-2 text-section font-semibold leading-5 tracking-tight text-fg">
              <StatusDot tone={isRunning ? "success" : "neutral"} className="shrink-0" />
              <span>{isRunning ? "上下文自动保持干净" : "上下文自动整理"}</span>
              {isRunning ? (
                <Badge tone="success" size="sm" className="oc-badge-craft">
                  运行中
                </Badge>
              ) : isPaused ? (
                <Badge tone="neutral" size="sm" className="oc-badge-craft">
                  已暂停
                </Badge>
              ) : null}
            </h4>
            <p className="mt-1 max-w-[66ch] text-caption leading-relaxed text-muted">
              {summaryLine}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            className="oc-btn-tactile oc-btn-secondary-craft gap-1.5"
            onClick={onOpenArchive}
          >
            <Archive size={13} strokeWidth={1.8} aria-hidden="true" />
            查看已收纳记录{archiveTotal > 0 ? `（${archiveTotal}）` : ""}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="px-2 text-caption font-normal text-muted hover:text-fg"
            onClick={onOpenSlim}
          >
            手动整理
          </Button>
        </div>
      </div>

      <dl className="grid grid-cols-3 gap-px border-t border-border/80 bg-border/80">
        {[
          {
            label: "长期记忆",
            value: `${s.coreMemoryCount} 条`,
            sub: "对话中自动参考",
          },
          {
            label: "已启用技能",
            value: `${s.activeSkillCount} 个`,
            sub: "按需自动调用",
          },
          {
            label: "已收纳记录",
            value: `${archiveTotal} 项`,
            sub: "随时可恢复原样",
          },
        ].map((item) => (
          <div key={item.label} className="flex flex-col gap-0.5 bg-surface px-3.5 py-2.5">
            <dt className="text-caption text-faint">{item.label}</dt>
            <dd className="text-section font-semibold tabular-nums tracking-tight text-fg">
              {item.value}
            </dd>
            <span className="text-caption text-faint">{item.sub}</span>
          </div>
        ))}
      </dl>
    </section>
  );
}

/**
 * 自动整理记忆开关（OCV5-392）+ OCV5-841 轻柔可逆一键整理与自动整理历史。
 * 只给能用的账号（订阅够、模型在线）和已经开着的账号显示；读偏好失败时不渲染，
 * 不阻断记忆列表。开 = 同时收回遗留的「全面优化」授权（后端 normalizeAutoDreamPreferencePatch）。
 */
export function AutoDreamToggleRow({
  auth,
  agentId,
  recentHygieneRuns,
  onChanged,
}: {
  auth: AuthSession;
  agentId: string;
  recentHygieneRuns?: ContextHygieneRunRecord[];
  onChanged: () => void;
}) {
  const [feature, setFeature] = useState<AutoDreamFeatureView | null>(null);
  const [saving, setSaving] = useState(false);
  const [runningHygiene, setRunningHygiene] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [runs, setRuns] = useState<ContextHygieneRunRecord[] | null>(null);
  const [undoingBatch, setUndoingBatch] = useState<string | null>(null);
  const toast = useToast();

  useEffect(() => {
    let alive = true;
    api
      .getPreferences(auth)
      .then((snap) => {
        if (!alive) return;
        const parsed = extractAutoDreamFeature(snap);
        setFeature(parsed);
        publishAutoDreamRunning(parsed ? parsed.legacy_enabled === true && parsed.effective !== false : false);
      })
      .catch(() => {
        if (!alive) return;
        setFeature(null);
        publishAutoDreamRunning(null);
      });
    return () => {
      alive = false;
    };
  }, [auth]);

  useEffect(() => {
    if (!historyOpen || typeof api.getContextHygieneHistory !== "function") return;
    let alive = true;
    api
      .getContextHygieneHistory(auth, agentId, 10)
      .then((res) => {
        if (alive) setRuns(res.runs ?? []);
      })
      .catch(() => {
        if (alive) setRuns(recentHygieneRuns ?? []);
      });
    return () => {
      alive = false;
    };
  }, [historyOpen, auth, agentId, recentHygieneRuns]);

  const runHygieneNow = async () => {
    if (runningHygiene || typeof api.runContextHygiene !== "function") return;
    setRunningHygiene(true);
    try {
      // B2 安全边界：快捷按钮只执行纯可逆的过期记忆收纳，绝不触发不可逆永久裁剪。
      const res = await api.runContextHygiene(auth, agentId, {
        dryRun: false,
        archiveExpiredMemories: true,
        archiveColdSkills: false,
        pruneSkillHistory: false,
        decayArchival: false,
      });
      const r = res.run;
      const archived = r?.expiredMemoriesArchived ?? 0;
      const detail =
        archived > 0
          ? `已收纳 ${archived} 条过期记忆，随时可在「已收纳记录」中恢复原样`
          : "当前记忆很干净，无需额外收纳";
      toast(`自动整理完成：${detail}`, "success");
      onChanged();
    } catch (e) {
      toast(apiErrorMessage(e, "自动整理失败，请稍后重试"), "error");
    } finally {
      setRunningHygiene(false);
    }
  };

  const undoBatch = async (batchId: string) => {
    if (undoingBatch) return;
    setUndoingBatch(batchId);
    try {
      const tasks: Array<Promise<RestoreOutcomePayload | null>> = [];
      if (typeof api.restoreArchivedMemories === "function") {
        tasks.push(api.restoreArchivedMemories(auth, agentId, { batchId }));
      }
      if (typeof api.restoreArchivedSkills === "function") {
        tasks.push(api.restoreArchivedSkills(auth, { batchId }));
      }
      if (tasks.length === 0) {
        toast("恢复未成功，请稍后重试", "error");
        return;
      }
      const settled = await Promise.allSettled(tasks);
      const outcome = formatRestoreOutcomeFeedback(settled);
      toast(outcome.message, outcome.tone);
      if (outcome.changed) onChanged();
    } finally {
      setUndoingBatch(null);
    }
  };

  if (!feature) return null;
  const on = feature.legacy_enabled === true;
  if (!on && !(feature.eligible && feature.available)) return null;
  const displayedRuns = runs ?? recentHygieneRuns ?? [];

  return (
    <section
      aria-label="自动整理记忆"
      className="oc-surface-card overflow-hidden rounded-xl"
    >
      <div className="flex items-start justify-between gap-4 px-4 py-3.5">
        <div className="flex min-w-0 items-start gap-3">
          <span
            className={cn(
              "oc-icon-badge mt-0.5 size-8 shrink-0 rounded-lg",
              on && "oc-icon-badge-accent",
            )}
            aria-hidden="true"
          >
            <Sparkles size={15} strokeWidth={1.75} />
          </span>
          <div className="min-w-0">
            <h4 className="text-section font-semibold leading-5 tracking-tight text-fg">自动整理记忆</h4>
            <p className="mt-1 max-w-[68ch] text-body tabular-nums text-muted">
              自动新增提炼：每 {feature.min_interval_hours} 小时最多一次，累计 {feature.min_new_sessions}{" "}
              个新会话后从近期对话提炼长期信息（只新增，不改、不删已有记忆，保留 {AUTO_MEMORY_TTL_DAYS} 天，按实际用量扣积分）。
              过期记忆、重复内容与久未使用的技能会自动收纳到已收纳记录，随时可恢复原样。
            </p>
            {on && !feature.effective && (
              <p className="mt-1.5 flex items-center gap-1.5 text-meta text-warning">
                <StatusDot tone="warning" />
                <span>当前暂不可用，整理已安全暂停。</span>
              </p>
            )}
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                className="oc-btn-tactile oc-btn-secondary-craft h-7 gap-1.5 px-2.5 text-caption"
                title="仅收纳已过期记忆，随时可在「已收纳记录」中恢复原样"
                loading={runningHygiene}
                disabled={runningHygiene}
                onClick={() => void runHygieneNow()}
              >
                <Sparkles size={12} strokeWidth={1.8} aria-hidden="true" />
                立即自动整理一次
              </Button>
              <Button
                size="sm"
                variant="ghost"
                aria-expanded={historyOpen}
                className="h-7 gap-1 px-2 text-caption font-normal text-muted"
                onClick={() => setHistoryOpen((v) => !v)}
              >
                <ChevronRight
                  size={12}
                  aria-hidden="true"
                  className={cn("transition-transform", historyOpen && "rotate-90")}
                />
                最近整理记录
              </Button>
            </div>
          </div>
        </div>
        <Switch
          aria-label="自动整理记忆"
          className="mt-0.5 shrink-0"
          checked={on}
          disabled={saving}
          onCheckedChange={async (checked) => {
            setSaving(true);
            try {
              const snap = await api.patchPreferences(auth, { auto_dream_enabled: checked });
              const parsed = extractAutoDreamFeature(snap);
              setFeature(parsed);
              publishAutoDreamRunning(parsed ? parsed.legacy_enabled === true && parsed.effective !== false : false);
              toast(checked ? "已开启自动整理记忆" : "已关闭自动整理记忆", "success");
              onChanged();
            } catch (e) {
              toast(apiErrorMessage(e, checked ? "开启失败" : "关闭失败"), "error");
            } finally {
              setSaving(false);
            }
          }}
        />
      </div>
      {historyOpen && (
        <div className="border-t border-border/80 bg-bg/40 px-4 py-3 text-caption">
          {displayedRuns.length === 0 ? (
            <p className="text-muted">还没有自动整理记录。</p>
          ) : (
            <ul className="space-y-2">
              {displayedRuns.slice(0, 5).map((run) => {
                const canUndo = Boolean(
                  run.batchId &&
                    (run.expiredMemoriesArchived > 0 ||
                      run.coldSkillsArchived > 0 ||
                      (run.mergedMemoryGroups ?? 0) > 0),
                );
                return (
                  <li
                    key={run.runId}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-surface px-3 py-2"
                  >
                    <div className="min-w-0 flex-1 text-muted">
                      <span className="font-medium text-fg">
                        {run.mode === "manual" ? "手动触发" : "后台自动整理"}
                      </span>
                      {" · "}
                      <TimeAgo value={run.finishedAt} className="text-faint" />
                      {" · "}
                      <span>{describeHygieneRun(run)}</span>
                    </div>
                    {canUndo && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 gap-1 px-2 text-caption text-accent"
                        loading={undoingBatch === run.batchId}
                        disabled={undoingBatch !== null}
                        onClick={() => void undoBatch(run.batchId!)}
                      >
                        <RotateCcw size={11} strokeWidth={1.8} aria-hidden="true" />
                        撤销本次自动整理
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

/** OCV5-840: 已废弃项目记忆的按需折叠视图，支持一键恢复，消解「只进不出」的不可逆焦虑。 */
export function DeprecatedProjectMemoryDisclosure({
  auth,
  projectId,
  onRestored,
}: {
  auth: AuthSession;
  projectId: string;
  onRestored: () => void;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<ProjectMemoryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    void tick;
    if (!open || !projectId) return;
    let alive = true;
    setLoading(true);
    setErr(null);
    void taskboardApi
      .listProjectMemories(auth, projectId, "deprecated")
      .then((res) => {
        if (alive) setItems((res.official ?? []).filter((o) => o.deprecated));
      })
      .catch((e) => {
        if (alive) setErr(apiErrorMessage(e, "加载已废弃记忆失败"));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open, auth, projectId, tick]);

  const restore = async (item: ProjectMemoryItem) => {
    setBusySlug(item.slug);
    try {
      await taskboardApi.restoreProjectMemory(auth, projectId, item.slug);
      toast(`已恢复「${projectMemoryTitle(item.slug)}」`, "success");
      setTick((t) => t + 1);
      onRestored();
    } catch (e) {
      toast(apiErrorMessage(e, "恢复失败"), "error");
    } finally {
      setBusySlug(null);
    }
  };

  return (
    <div className="pt-1">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="-ml-3 gap-1 font-normal text-muted"
      >
        <ChevronRight size={13} aria-hidden="true" className={cn("transition-transform", open && "rotate-90")} />
        查看已废弃的项目记忆
      </Button>
      {open && (
        <div className="mt-2">
          {loading ? (
            <ListSkeleton rows={2} />
          ) : err ? (
            <Alert tone="danger" density="compact" className="oc-callout oc-callout-danger rounded-xl">
              {err}
            </Alert>
          ) : items.length === 0 ? (
            <p className="oc-surface-recessed rounded-xl px-3.5 py-2.5 text-caption text-muted">
              没有已废弃的项目记忆。
            </p>
          ) : (
            <ListGroup aria-label="已废弃的项目记忆">
              {items.map((item) => (
                <ListRow
                  key={item.slug}
                  className="flex items-center justify-between gap-3 py-2.5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-body font-medium text-muted">
                      {projectMemoryTitle(item.slug)}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    className="oc-btn-tactile oc-btn-secondary-craft shrink-0 gap-1"
                    loading={busySlug === item.slug}
                    disabled={busySlug !== null}
                    onClick={() => void restore(item)}
                  >
                    <RotateCcw size={12} strokeWidth={1.8} aria-hidden="true" />
                    恢复
                  </Button>
                </ListRow>
              ))}
            </ListGroup>
          )}
        </div>
      )}
    </div>
  );
}
