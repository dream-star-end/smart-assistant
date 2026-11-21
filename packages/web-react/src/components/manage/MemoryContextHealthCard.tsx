import { Archive, ChevronRight, Gauge, RotateCcw, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { api, apiErrorMessage } from "../../lib/api";
import { formatBytes } from "../../lib/chat/download";
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

function projectMemoryTitle(slug: string): string {
  return slug.replace(/\.md$/i, "");
}

/** OCV5-840: 「常驻上下文体检卡」—— 健康指示点 + 4 格统计带 + 一键瘦身与归档箱入口。 */
export function ContextHealthSummaryCard({
  report,
  onOpenSlim,
  onOpenArchive,
}: {
  report: ContextHealthReport;
  onOpenSlim: () => void;
  onOpenArchive: () => void;
}) {
  const s = report.summary;
  const tone: "success" | "warning" | "danger" =
    report.status === "critical" ? "danger" : report.status === "warning" ? "warning" : "success";
  const statusText =
    report.status === "critical"
      ? "常驻底噪偏高，建议清理"
      : report.status === "warning"
        ? "发现可优化的常驻上下文"
        : "常驻上下文健康";
  const candidateCount = report.slimCandidates?.length ?? 0;
  const archiveTotal = (s.archivedMemoryCount ?? 0) + (s.archivedSkillCount ?? 0);
  const personaProfileBytes = (s.claudeMdBytes ?? 0) + (s.userMdBytes ?? 0);

  return (
    <section
      aria-label="常驻上下文体检"
      data-testid="context-health-summary-card"
      className="oc-surface-card overflow-hidden rounded-xl"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            className={cn(
              "oc-icon-badge size-7 shrink-0 rounded-lg",
              tone === "danger"
                ? "oc-icon-badge-danger"
                : tone === "warning"
                  ? "oc-icon-badge-warning"
                  : "oc-icon-badge-accent",
            )}
            aria-hidden="true"
          >
            <Gauge size={14} strokeWidth={1.8} />
          </span>
          <div className="min-w-0">
            <h4 className="flex items-center gap-2 text-section font-semibold leading-5 tracking-tight text-fg">
              <StatusDot tone={tone} className="shrink-0" />
              <span className="truncate">{statusText}</span>
            </h4>
            <p className="mt-0.5 text-caption tabular-nums text-muted">
              常驻总量 {formatBytes(report.totalBytes) || "0 B"}
              {report.reclaimableBytes > 0 && ` · 预计可释放 ${formatBytes(report.reclaimableBytes)}`}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            size="sm"
            variant={candidateCount > 0 ? "primary" : "secondary"}
            className={cn(
              "oc-btn-tactile gap-1.5",
              candidateCount > 0 ? "oc-btn-primary-craft" : "oc-btn-secondary-craft",
            )}
            onClick={onOpenSlim}
          >
            <Sparkles size={13} strokeWidth={1.8} aria-hidden="true" />
            查看瘦身建议{candidateCount > 0 ? `（${candidateCount}）` : ""}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            className="oc-btn-tactile oc-btn-secondary-craft gap-1.5"
            onClick={onOpenArchive}
          >
            <Archive size={13} strokeWidth={1.8} aria-hidden="true" />
            归档箱{archiveTotal > 0 ? `（${archiveTotal}）` : ""}
          </Button>
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-px border-t border-border/80 bg-border/80 lg:grid-cols-4">
        {[
          {
            label: "核心记忆",
            value: `${s.coreMemoryCount} 条`,
            sub: formatBytes(s.coreMemoryBytes) || "0 B",
            warn: s.expiredMemoryCount > 0 || s.oversizedMemoryCount > 0,
          },
          {
            label: "技能清单",
            value: `${s.activeSkillCount} 个`,
            sub: formatBytes(s.activeSkillBytes) || "0 B",
            warn: s.coldSkillCount > 0,
          },
          {
            label: "人格与画像",
            value: formatBytes(personaProfileBytes) || "0 B",
            sub: "CLAUDE + 画像",
            warn: personaProfileBytes > 8 * 1024,
          },
          {
            label: "可瘦身项",
            value: `${candidateCount} 项`,
            sub: report.reclaimableBytes > 0 ? `可省 ${formatBytes(report.reclaimableBytes)}` : "状态良好",
            warn: candidateCount > 0,
          },
        ].map((item) => (
          <div key={item.label} className="flex flex-col gap-0.5 bg-surface px-3.5 py-2.5">
            <dt className="text-caption text-faint">{item.label}</dt>
            <dd
              className={cn(
                "text-section font-semibold tabular-nums tracking-tight",
                item.warn ? "text-warning" : "text-fg",
              )}
            >
              {item.value}
            </dd>
            <span className="text-caption tabular-nums text-faint">{item.sub}</span>
          </div>
        ))}
      </dl>
    </section>
  );
}

/**
 * 自动整理记忆开关（OCV5-392）+ OCV5-840 确定性体检清理与撤销历史。
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
        if (alive) setFeature(extractAutoDreamFeature(snap));
      })
      .catch(() => {
        if (alive) setFeature(null);
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
          ? `已归档 ${archived} 条过期记忆${r?.bytesFreed ? `（释放 ${formatBytes(r.bytesFreed)}）` : ""}，可随时在归档箱还原`
          : "当前没有已过期记忆";
      toast(`过期记忆归档完成：${detail}`, "success");
      onChanged();
    } catch (e) {
      toast(apiErrorMessage(e, "归档过期记忆失败"), "error");
    } finally {
      setRunningHygiene(false);
    }
  };

  const undoBatch = async (batchId: string) => {
    if (undoingBatch) return;
    setUndoingBatch(batchId);
    try {
      await Promise.all([
        typeof api.restoreArchivedMemories === "function"
          ? api.restoreArchivedMemories(auth, agentId, { batchId }).catch(() => null)
          : Promise.resolve(null),
        typeof api.restoreArchivedSkills === "function"
          ? api.restoreArchivedSkills(auth, { batchId }).catch(() => null)
          : Promise.resolve(null),
      ]);
      toast("已撤销该批次归档，原记忆与技能已恢复", "success");
      onChanged();
    } catch (e) {
      toast(apiErrorMessage(e, "撤销失败"), "error");
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
              一键清理仅归档已过期记忆，可随时在归档箱还原；永久清理仅在「查看瘦身建议」中勾选确认。
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
                title="仅归档已过期记忆，可随时在归档箱还原；永久清理请在「查看瘦身建议」中勾选确认"
                loading={runningHygiene}
                disabled={runningHygiene}
                onClick={() => void runHygieneNow()}
              >
                <Sparkles size={12} strokeWidth={1.8} aria-hidden="true" />
                归档已过期记忆
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
              setFeature(extractAutoDreamFeature(snap));
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
            <p className="text-muted">还没有确定性清理记录。</p>
          ) : (
            <ul className="space-y-2">
              {displayedRuns.slice(0, 5).map((run) => (
                <li
                  key={run.runId}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-surface px-3 py-2"
                >
                  <div className="min-w-0 flex-1 text-muted">
                    <span className="font-medium text-fg">
                      {run.mode === "manual" ? "手动清理" : "定时清理"}
                    </span>
                    {" · "}
                    <TimeAgo value={run.finishedAt} className="text-faint" />
                    {" · "}
                    <span className="tabular-nums">
                      归档 {run.expiredMemoriesArchived} 条记忆 / {run.coldSkillsArchived} 个技能 · 释放{" "}
                      {formatBytes(run.bytesFreed) || "0 B"}
                    </span>
                  </div>
                  {run.batchId && (run.expiredMemoriesArchived > 0 || run.coldSkillsArchived > 0) && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 gap-1 px-2 text-caption text-accent"
                      loading={undoingBatch === run.batchId}
                      disabled={undoingBatch !== null}
                      onClick={() => void undoBatch(run.batchId!)}
                    >
                      <RotateCcw size={11} strokeWidth={1.8} aria-hidden="true" />
                      撤销本次整理
                    </Button>
                  )}
                </li>
              ))}
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
