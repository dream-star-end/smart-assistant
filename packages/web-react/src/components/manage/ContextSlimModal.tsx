import { AlertTriangle, Archive, CheckCircle2, ShieldCheck, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, apiErrorMessage } from "../../lib/api";
import { formatBytes } from "../../lib/chat/download";
import type {
  AuthSession,
  ContextHealthReport,
  ContextHygieneRunOptions,
  ContextSlimCandidate,
  ContextSlimCandidateKind,
} from "../../lib/types";
import { cn } from "../../lib/utils";
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  EmptyState,
  ListGroup,
  ListRow,
  Modal,
  useToast,
} from "../ui";

const KIND_META: Record<
  ContextSlimCandidateKind,
  { title: string; badge: string; tone: "warning" | "info" | "neutral" | "accent" | "danger" }
> = {
  expired_memory: { title: "已过期记忆", badge: "已过期", tone: "warning" },
  oversized_memory: { title: "超大核心记忆", badge: "偏大", tone: "accent" },
  cold_skill: { title: "长期未用技能（60天+）", badge: "冷门", tone: "info" },
  oversized_skill: { title: "超大技能", badge: "偏大", tone: "accent" },
  skill_history: { title: "冗余技能历史快照", badge: "历史快照", tone: "neutral" },
  stale_archival: { title: "陈旧归档检索条目", badge: "陈旧归档", tone: "neutral" },
};

const REVERSIBLE_KIND_ORDER: ContextSlimCandidateKind[] = [
  "expired_memory",
  "cold_skill",
  "oversized_memory",
  "oversized_skill",
];

const PERMANENT_KIND_ORDER: ContextSlimCandidateKind[] = [
  "skill_history",
  "stale_archival",
];

/** 永久清理判定：后端显式标 `reversible: false` 或属于不可逆裁剪类别。 */
function isPermanentCandidate(item: ContextSlimCandidate): boolean {
  return item.reversible === false || item.kind === "skill_history" || item.kind === "stale_archival";
}

function extractSkillHistoryName(item: ContextSlimCandidate): string | null {
  const metaName = typeof item.meta?.name === "string" ? item.meta.name.trim() : "";
  if (metaName) return metaName;
  const normalized = item.target
    .trim()
    .replace(/^skills?\//, "")
    .replace(/\/history$/, "");
  if (normalized && normalized !== "*") return normalized;
  if (item.id.startsWith("skill_history:")) {
    const fromId = item.id.slice("skill_history:".length).trim();
    if (fromId) return fromId;
  }
  return null;
}

function extractArchivalIds(item: ContextSlimCandidate, agentId: string): string[] {
  const out: string[] = [];
  if (Array.isArray(item.meta?.ids)) {
    for (const raw of item.meta.ids) {
      if (typeof raw === "string" && raw.trim()) out.push(raw.trim());
    }
  }
  if (typeof item.meta?.id === "string" && item.meta.id.trim()) {
    out.push(item.meta.id.trim());
  }
  if (out.length === 0) {
    const rawTarget = item.target.trim();
    if (rawTarget.startsWith("archival/")) {
      const stripped = rawTarget.slice("archival/".length).trim();
      if (stripped && stripped !== "*") out.push(stripped);
    } else if (rawTarget && rawTarget !== "*" && rawTarget !== agentId) {
      out.push(rawTarget);
    }
  }
  return out;
}

function groupByKind(
  items: ContextSlimCandidate[],
  order: ContextSlimCandidateKind[],
): Array<{ kind: ContextSlimCandidateKind; items: ContextSlimCandidate[] }> {
  const byKind = new Map<ContextSlimCandidateKind, ContextSlimCandidate[]>();
  for (const c of items) {
    const list = byKind.get(c.kind) ?? [];
    list.push(c);
    byKind.set(c.kind, list);
  }
  const out: Array<{ kind: ContextSlimCandidateKind; items: ContextSlimCandidate[] }> = [];
  for (const kind of order) {
    const list = byKind.get(kind);
    if (list && list.length > 0) out.push({ kind, items: list });
  }
  for (const [kind, list] of byKind) {
    if (!order.includes(kind)) out.push({ kind, items: list });
  }
  return out;
}

function estimateTokens(bytes: number): string {
  const tokens = Math.max(0, Math.round(bytes / 3));
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(tokens);
}

export type ContextSlimModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  auth: AuthSession;
  agentId: string;
  report: ContextHealthReport | null;
  onSlimmed: () => void;
  onOpenArchive?: () => void;
};

/**
 * 上下文瘦身向导（React.lazy 独立分块，零首屏开销）。
 * 严格区分「安全归档（可随时还原）」与「永久清理（不可撤销，默认不勾选）」，
 * 且按用户精确勾选集合提交目标，绝不误删未勾选项。
 */
export function ContextSlimModal({
  open,
  onOpenChange,
  auth,
  agentId,
  report,
  onSlimmed,
  onOpenArchive,
}: ContextSlimModalProps) {
  const toast = useToast();
  const candidates = useMemo(() => report?.slimCandidates ?? [], [report]);
  const actionable = useMemo(() => candidates.filter((c) => c.actionable), [candidates]);

  const reversibleCandidates = useMemo(
    () => candidates.filter((c) => !isPermanentCandidate(c)),
    [candidates],
  );
  const permanentCandidates = useMemo(
    () => candidates.filter((c) => isPermanentCandidate(c)),
    [candidates],
  );
  const reversibleActionable = useMemo(
    () => reversibleCandidates.filter((c) => c.actionable),
    [reversibleCandidates],
  );

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setErr(null);
    // 仅默认勾选低风险「可逆归档」项；永久清理项默认全部不勾选。
    const defaults = new Set<string>();
    for (const c of reversibleActionable) {
      if (c.kind === "expired_memory" || c.safeAutoArchive) {
        defaults.add(c.id);
      }
    }
    setSelectedIds(defaults);
  }, [open, reversibleActionable]);

  const reversibleGrouped = useMemo(
    () => groupByKind(reversibleCandidates, REVERSIBLE_KIND_ORDER),
    [reversibleCandidates],
  );
  const permanentGrouped = useMemo(
    () => groupByKind(permanentCandidates, PERMANENT_KIND_ORDER),
    [permanentCandidates],
  );

  const selectedList = useMemo(
    () => actionable.filter((c) => selectedIds.has(c.id)),
    [actionable, selectedIds],
  );
  const selectedReversibleCount = useMemo(
    () => selectedList.filter((c) => !isPermanentCandidate(c)).length,
    [selectedList],
  );
  const selectedPermanentCount = selectedList.length - selectedReversibleCount;
  const selectedBytes = useMemo(
    () => selectedList.reduce((sum, c) => sum + Math.max(0, c.bytes), 0),
    [selectedList],
  );

  const allReversibleSelected =
    reversibleActionable.length > 0 && reversibleActionable.every((c) => selectedIds.has(c.id));

  const toggle = (id: string, checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const toggleAllReversible = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allReversibleSelected) {
        for (const c of reversibleActionable) next.delete(c.id);
      } else {
        for (const c of reversibleActionable) next.add(c.id);
      }
      return next;
    });
  };

  const handleSlim = async () => {
    if (selectedList.length === 0 || submitting) return;
    setSubmitting(true);
    setErr(null);
    try {
      const memoryFiles: string[] = [];
      const skillNames: string[] = [];
      const pruneSkillHistoryNamesSet = new Set<string>();
      const pruneArchivalIdsSet = new Set<string>();
      let staleArchivalSelected = false;

      for (const item of selectedList) {
        if (item.kind === "expired_memory" || item.kind === "oversized_memory") {
          const file = item.target.replace(/^memory\//, "");
          if (file) memoryFiles.push(file);
        } else if (item.kind === "cold_skill" || item.kind === "oversized_skill") {
          const name = item.target.replace(/^skill\//, "");
          if (name) skillNames.push(name);
        } else if (item.kind === "skill_history") {
          const skillName = extractSkillHistoryName(item);
          if (skillName) pruneSkillHistoryNamesSet.add(skillName);
        } else if (item.kind === "stale_archival") {
          staleArchivalSelected = true;
          for (const id of extractArchivalIds(item, agentId)) pruneArchivalIdsSet.add(id);
        }
      }

      const pruneSkillHistoryNames = Array.from(pruneSkillHistoryNamesSet);
      const pruneArchivalIds = Array.from(pruneArchivalIdsSet);

      let totalSavedBytes = 0;
      let archivedCount = 0;
      let prunedCount = 0;

      if (memoryFiles.length > 0) {
        const res = await api.archiveMemoryFiles(auth, agentId, memoryFiles, "manual_slim");
        totalSavedBytes += res.bytesSaved ?? 0;
        archivedCount += res.archived?.length || memoryFiles.length;
      }

      for (const skillName of skillNames) {
        const res = await api.archiveSkill(auth, skillName, "manual_slim");
        if (res.entry) {
          totalSavedBytes += res.entry.bytes ?? 0;
          archivedCount += 1;
        }
      }

      if (pruneSkillHistoryNames.length > 0 || staleArchivalSelected) {
        const hygieneOptions: ContextHygieneRunOptions = {
          dryRun: false,
          archiveExpiredMemories: false,
          archiveColdSkills: false,
          pruneSkillHistory: pruneSkillHistoryNames.length > 0,
          ...(pruneSkillHistoryNames.length > 0 ? { pruneSkillHistoryNames } : {}),
          decayArchival: staleArchivalSelected,
          ...(staleArchivalSelected && pruneArchivalIds.length > 0 ? { pruneArchivalIds } : {}),
        };
        const res = await api.runContextHygiene(auth, agentId, hygieneOptions);
        totalSavedBytes += res.run?.bytesFreed ?? 0;
        const reportedPruned =
          (res.run?.skillHistoriesPruned ?? 0) + (res.run?.archivalCleaned ?? 0);
        prunedCount +=
          reportedPruned > 0
            ? reportedPruned
            : pruneSkillHistoryNames.length + (staleArchivalSelected ? Math.max(1, pruneArchivalIds.length) : 0);
      }

      const parts: string[] = [];
      if (archivedCount > 0) {
        parts.push(`已安全归档 ${archivedCount} 项（可随时在归档箱还原）`);
      }
      if (prunedCount > 0) {
        parts.push(`已永久清理 ${prunedCount} 项旧快照/过期归档`);
      }
      const savedSuffix = totalSavedBytes > 0 ? `，共释放 ${formatBytes(totalSavedBytes)}` : "";
      const summary = parts.length > 0 ? `${parts.join("；")}${savedSuffix}` : `已完成整理${savedSuffix}`;
      toast(summary, "success");
      onSlimmed();
      onOpenChange(false);
    } catch (e) {
      setErr(apiErrorMessage(e, "瘦身执行失败，请稍后重试"));
    } finally {
      setSubmitting(false);
    }
  };

  const submitLabel =
    selectedReversibleCount > 0 && selectedPermanentCount > 0
      ? `归档 ${selectedReversibleCount} 项并永久清理 ${selectedPermanentCount} 项`
      : selectedPermanentCount > 0
        ? `永久清理所选项（${selectedPermanentCount}）`
        : `一键安全归档（${selectedReversibleCount}）`;

  const renderCandidateRows = (
    groups: Array<{ kind: ContextSlimCandidateKind; items: ContextSlimCandidate[] }>,
    permanent: boolean,
  ) => (
    <div className="space-y-3">
      {groups.map(({ kind, items }) => {
        const meta = KIND_META[kind] ?? { title: kind, badge: kind, tone: "neutral" as const };
        return (
          <div key={kind} className="space-y-1.5">
            <div className="flex items-center gap-2 text-meta font-medium text-muted">
              <span>{meta.title}</span>
              <span className="oc-surface-recessed rounded-full px-1.5 py-0.5 text-caption font-medium tabular-nums text-faint">
                {items.length}
              </span>
            </div>
            <ListGroup>
              {items.map((item) => {
                const checked = selectedIds.has(item.id);
                return (
                  <ListRow
                    key={item.id}
                    className={cn(
                      "flex items-start gap-3 py-2.5 transition-colors",
                      item.actionable ? "hover:bg-hover/70" : "opacity-80",
                    )}
                  >
                    <div className="pt-0.5">
                      <Checkbox
                        checked={checked}
                        disabled={!item.actionable || submitting}
                        aria-label={`选择 ${item.label}`}
                        onChange={(e) => toggle(item.id, e.target.checked)}
                      />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="truncate text-body font-medium text-fg">{item.label}</span>
                        <Badge tone={meta.tone} size="sm" className="oc-badge-craft">
                          {meta.badge}
                        </Badge>
                        {permanent ? (
                          <Badge tone="danger" size="sm" className="oc-badge-craft">
                            不可撤销
                          </Badge>
                        ) : (
                          item.safeAutoArchive && (
                            <Badge tone="success" size="sm" className="oc-badge-craft">
                              推荐归档
                            </Badge>
                          )
                        )}
                      </div>
                      <p className="mt-0.5 text-caption text-muted">{item.reason}</p>
                    </div>
                    <span className="oc-surface-recessed shrink-0 rounded-md px-2 py-0.5 text-caption font-medium tabular-nums text-muted">
                      {formatBytes(item.bytes)}
                    </span>
                  </ListRow>
                );
              })}
            </ListGroup>
          </div>
        );
      })}
    </div>
  );

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!submitting) onOpenChange(next);
      }}
      size="lg"
      mobile="sheet"
      title={
        <span className="inline-flex items-center gap-2">
          <span className="oc-icon-badge oc-icon-badge-accent size-6 rounded-md" aria-hidden="true">
            <Sparkles size={13} strokeWidth={1.8} />
          </span>
          <span className="text-title font-semibold tracking-tight text-fg">上下文瘦身建议</span>
        </span>
      }
      className="oc-surface-popover bg-surface"
      footer={
        candidates.length > 0 ? (
          <div className="flex w-full flex-wrap items-center justify-between gap-3">
            <div className="min-w-0 text-caption tabular-nums text-muted">
              已选 <strong className="text-fg">{selectedList.length}</strong> 项 · 预计释放{" "}
              <strong className="text-fg">{formatBytes(selectedBytes) || "0 B"}</strong>
              {selectedBytes > 0 && <span className="text-faint">（约 {estimateTokens(selectedBytes)} tokens）</span>}
            </div>
            <div className="flex items-center gap-2">
              {onOpenArchive && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={submitting}
                  onClick={() => {
                    onOpenChange(false);
                    onOpenArchive();
                  }}
                >
                  查看归档箱
                </Button>
              )}
              <Button
                size="sm"
                variant="primary"
                className="oc-btn-tactile oc-btn-primary-craft gap-1.5"
                loading={submitting}
                disabled={selectedList.length === 0 || submitting}
                onClick={() => void handleSlim()}
              >
                <Archive size={14} strokeWidth={1.8} aria-hidden="true" />
                {submitLabel}
              </Button>
            </div>
          </div>
        ) : undefined
      }
    >
      <div className="space-y-4" data-testid="context-slim-modal">
        <div className="oc-callout oc-callout-info flex items-start gap-2.5 rounded-xl px-3.5 py-2.5 text-caption leading-relaxed text-muted">
          <ShieldCheck size={15} strokeWidth={1.8} className="mt-0.5 shrink-0 text-info" aria-hidden="true" />
          <span>
            <strong className="font-medium text-fg">安全归档</strong>项会移入
            <strong className="font-medium text-fg">可逆归档箱</strong>
            ，归档后不再占用每轮常驻上下文，随时可一键还原；
            {permanentCandidates.length > 0
              ? "下方的「永久清理」项不进归档箱且不可撤销，默认不勾选。"
              : "绝不硬删你的记忆与技能。"}
          </span>
        </div>

        {err && (
          <Alert tone="danger" density="compact" className="oc-callout oc-callout-danger rounded-xl">
            {err}
          </Alert>
        )}

        {candidates.length === 0 ? (
          <div className="oc-surface-card rounded-2xl">
            <EmptyState
              icon={CheckCircle2}
              title="常驻上下文非常干净"
              hint="目前没有发现过期记忆、超大条目或超过 60 天未用的冷门技能。"
            />
          </div>
        ) : (
          <div className="space-y-5">
            {reversibleGrouped.length > 0 && (
              <section aria-label="安全归档（可随时在归档箱还原）" className="space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-section font-semibold tracking-tight text-fg">
                    安全归档（可随时在归档箱还原）
                  </h3>
                  {reversibleActionable.length > 1 && (
                    <button
                      type="button"
                      onClick={toggleAllReversible}
                      className="text-caption font-medium text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {allReversibleSelected ? "取消全选归档项" : "全选可安全归档项"}
                    </button>
                  )}
                </div>
                {renderCandidateRows(reversibleGrouped, false)}
              </section>
            )}

            {permanentGrouped.length > 0 && (
              <section aria-label="永久清理（不可撤销，不进归档箱）" className="space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="flex items-center gap-1.5 text-section font-semibold tracking-tight text-fg">
                    <AlertTriangle size={14} strokeWidth={1.9} className="text-warning" aria-hidden="true" />
                    永久清理（不可撤销，不进归档箱）
                  </h3>
                </div>
                <div className="oc-callout oc-callout-warning rounded-xl px-3.5 py-2 text-caption leading-relaxed text-muted">
                  以下项目为旧历史快照或过期检索记录的永久裁剪，不会进入归档箱，执行后无法撤销，因此默认不勾选。
                </div>
                {renderCandidateRows(permanentGrouped, true)}
              </section>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

export default ContextSlimModal;
