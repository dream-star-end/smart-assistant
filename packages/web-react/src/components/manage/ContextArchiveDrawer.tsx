import { Archive, Brain, RotateCcw, Sparkles } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, apiErrorMessage } from "../../lib/api";
import type { ArchivedMemoryEntry, ArchivedSkillEntry, AuthSession } from "../../lib/types";
import { formatRestoreOutcomeFeedback } from "./MemoryContextHealthCard";
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  ListGroup,
  ListRow,
  ListSkeleton,
  MetaLine,
  Modal,
  Tabs,
  TimeAgo,
  useToast,
} from "../ui";

const REASON_LABELS: Record<string, string> = {
  semantic_auto_merge: "已自动合并保留原件",
  expired: "到期自动收纳",
  manual_archive: "手动收纳",
  manual_slim: "手动整理收纳",
  cold_skill: "久未使用自动收纳",
  janitor_auto: "后台自动整理",
  janitor_manual: "手动整理",
};

function reasonLabel(reason: string): string {
  return REASON_LABELS[reason] ?? "已收纳";
}

function batchHeading(items: Array<{ reason: string }>, unit: string): string {
  const isSemanticMerge = items.some((i) => i.reason === "semantic_auto_merge");
  if (isSemanticMerge) return `自动合并相似记忆 · 原件 ${items.length} ${unit}`;
  const isCold = items.every((i) => i.reason === "cold_skill");
  if (isCold) return `久未使用自动收纳 · ${items.length} ${unit}`;
  const isExpired = items.every((i) => i.reason === "expired");
  if (isExpired) return `到期自动收纳 · ${items.length} ${unit}`;
  return `整理记录 · ${items.length} ${unit}`;
}

export type ContextArchiveDrawerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  auth: AuthSession;
  agentId: string;
  initialTab?: "memory" | "skills";
  onRestored: () => void;
};

/**
 * 「已收纳记录 · 随时可恢复」（React.lazy 独立分块，零首屏开销）。
 * 展示后台自动合并原件、到期收纳记忆与久未使用技能，支持单条「恢复原样」与整批「撤销本次自动整理」。
 */
export function ContextArchiveDrawer({
  open,
  onOpenChange,
  auth,
  agentId,
  initialTab = "memory",
  onRestored,
}: ContextArchiveDrawerProps) {
  const toast = useToast();
  const [tab, setTab] = useState<"memory" | "skills">(initialTab);
  const [memories, setMemories] = useState<ArchivedMemoryEntry[]>([]);
  const [skills, setSkills] = useState<ArchivedSkillEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (open) setTab(initialTab);
  }, [open, initialTab]);

  useEffect(() => {
    void reloadKey;
    if (!open) return;
    let alive = true;
    setLoading(true);
    setErr(null);
    Promise.all([
      api.listArchivedMemories(auth, agentId).then((r) => r.items ?? []),
      api.listArchivedSkills(auth).then((r) => r.items ?? []),
    ])
      .then(([m, s]) => {
        if (!alive) return;
        setMemories(m);
        setSkills(s);
      })
      .catch((e) => {
        if (alive) setErr(apiErrorMessage(e, "加载已收纳记录失败"));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open, auth, agentId, reloadKey]);

  const memoryBatches = useMemo(() => {
    const map = new Map<string, ArchivedMemoryEntry[]>();
    for (const item of memories) {
      const list = map.get(item.batchId) ?? [];
      list.push(item);
      map.set(item.batchId, list);
    }
    return [...map.entries()];
  }, [memories]);

  const skillBatches = useMemo(() => {
    const map = new Map<string, ArchivedSkillEntry[]>();
    for (const item of skills) {
      const list = map.get(item.batchId) ?? [];
      list.push(item);
      map.set(item.batchId, list);
    }
    return [...map.entries()];
  }, [skills]);

  const restoreMemory = useCallback(
    async (opts: { id?: string; batchId?: string; label: string }) => {
      const key = `mem:${opts.id ?? opts.batchId}`;
      setBusyKey(key);
      try {
        const settled = await Promise.allSettled([
          api.restoreArchivedMemories(auth, agentId, {
            ...(opts.id ? { id: opts.id } : {}),
            ...(opts.batchId ? { batchId: opts.batchId } : {}),
          }),
        ]);
        const outcome = formatRestoreOutcomeFeedback(settled);
        toast(outcome.message, outcome.tone);
        if (outcome.changed) {
          setReloadKey((k) => k + 1);
          onRestored();
        }
      } finally {
        setBusyKey(null);
      }
    },
    [auth, agentId, onRestored, toast],
  );

  const restoreSkill = useCallback(
    async (opts: { id?: string; name?: string; batchId?: string; label: string }) => {
      const key = `skill:${opts.id ?? opts.name ?? opts.batchId}`;
      setBusyKey(key);
      try {
        const settled = await Promise.allSettled([
          api.restoreArchivedSkills(auth, {
            ...(opts.id ? { id: opts.id } : {}),
            ...(opts.name ? { name: opts.name } : {}),
            ...(opts.batchId ? { batchId: opts.batchId } : {}),
          }),
        ]);
        const outcome = formatRestoreOutcomeFeedback(settled);
        toast(outcome.message, outcome.tone);
        if (outcome.changed) {
          setReloadKey((k) => k + 1);
          onRestored();
        }
      } finally {
        setBusyKey(null);
      }
    },
    [auth, onRestored, toast],
  );

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      mobile="sheet"
      title={
        <span className="inline-flex items-center gap-2">
          <span className="oc-icon-badge oc-icon-badge-accent size-6 rounded-md" aria-hidden="true">
            <Archive size={13} strokeWidth={1.8} />
          </span>
          <span className="text-title font-semibold tracking-tight text-fg">已收纳记录 · 随时可恢复</span>
        </span>
      }
      className="oc-surface-popover bg-surface"
    >
      <div className="space-y-4" data-testid="context-archive-drawer">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Tabs
            aria-label="已收纳分类"
            idBase="context-archive-tab"
            value={tab}
            onValueChange={(v) => setTab(v === "skills" ? "skills" : "memory")}
            className="oc-surface-recessed"
            items={[
              { value: "memory", label: `长期记忆（${memories.length}）` },
              { value: "skills", label: `技能（${skills.length}）` },
            ]}
          />
          <p className="text-caption text-faint">已收纳的内容不会打扰日常对话，需要时随时可以恢复原样。</p>
        </div>

        {err && (
          <Alert
            tone="danger"
            density="compact"
            className="oc-callout oc-callout-danger rounded-xl"
            action={
              <Button size="sm" variant="secondary" onClick={() => setReloadKey((k) => k + 1)}>
                重试
              </Button>
            }
          >
            {err}
          </Alert>
        )}

        {loading ? (
          <ListSkeleton rows={3} />
        ) : tab === "memory" ? (
          memories.length === 0 ? (
            <div className="oc-surface-card rounded-2xl">
              <EmptyState
                icon={Brain}
                title="暂无已收纳的长期记忆"
                hint="后台自动合并的原始记忆、到期记忆或你手动收纳的内容都会安全保存在这里。"
              />
            </div>
          ) : (
            <div className="space-y-4">
              {memoryBatches.map(([batchId, items]) => {
                const isSemanticMerge = items.some((i) => i.reason === "semantic_auto_merge");
                return (
                  <section key={batchId} className="space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-caption font-medium text-muted">
                        {batchHeading(items, "条")}
                      </span>
                      {(items.length > 1 || isSemanticMerge) && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 gap-1 px-2 text-caption text-accent"
                          loading={busyKey === `mem:${batchId}`}
                          disabled={busyKey !== null}
                          onClick={() =>
                            void restoreMemory({ batchId, label: `整批 ${items.length} 条记忆` })
                          }
                        >
                          <RotateCcw size={12} strokeWidth={1.8} aria-hidden="true" />
                          撤销本次自动整理
                        </Button>
                      )}
                    </div>
                    <ListGroup>
                      {items.map((entry) => {
                        const title = entry.title?.trim() || entry.slug || entry.file.replace(/\.md$/i, "");
                        return (
                          <ListRow
                            key={entry.id}
                            className="flex items-center justify-between gap-3 py-2.5"
                          >
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <span className="truncate text-body font-medium text-fg">{title}</span>
                                <Badge
                                  tone={entry.reason === "semantic_auto_merge" ? "accent" : "neutral"}
                                  size="sm"
                                  className="oc-badge-craft"
                                >
                                  {reasonLabel(entry.reason)}
                                </Badge>
                              </div>
                              <MetaLine className="mt-1">
                                <span>
                                  收纳于 <TimeAgo value={entry.archivedAt} className="text-meta text-faint" />
                                </span>
                              </MetaLine>
                            </div>
                            <Button
                              size="sm"
                              variant="secondary"
                              className="oc-btn-tactile oc-btn-secondary-craft shrink-0 gap-1"
                              loading={busyKey === `mem:${entry.id}`}
                              disabled={busyKey !== null}
                              onClick={() => void restoreMemory({ id: entry.id, label: `「${title}」` })}
                            >
                              <RotateCcw size={12} strokeWidth={1.8} aria-hidden="true" />
                              恢复原样
                            </Button>
                          </ListRow>
                        );
                      })}
                    </ListGroup>
                  </section>
                );
              })}
            </div>
          )
        ) : skills.length === 0 ? (
          <div className="oc-surface-card rounded-2xl">
            <EmptyState
              icon={Sparkles}
              title="暂无已收纳的技能"
              hint="久未使用的技能或你手动收纳的技能会保存在这里，随时可以重新启用。"
            />
          </div>
        ) : (
          <div className="space-y-4">
            {skillBatches.map(([batchId, items]) => (
              <section key={batchId} className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-caption font-medium text-muted">
                    {batchHeading(items, "个技能")}
                  </span>
                  {items.length > 1 && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 gap-1 px-2 text-caption text-accent"
                      loading={busyKey === `skill:${batchId}`}
                      disabled={busyKey !== null}
                      onClick={() =>
                        void restoreSkill({ batchId, label: `整批 ${items.length} 个技能` })
                      }
                    >
                      <RotateCcw size={12} strokeWidth={1.8} aria-hidden="true" />
                      撤销本次自动整理
                    </Button>
                  )}
                </div>
                <ListGroup>
                  {items.map((entry) => (
                    <ListRow
                      key={entry.id}
                      className="flex items-center justify-between gap-3 py-2.5"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="truncate text-body font-medium text-fg">{entry.name}</span>
                          <Badge tone="info" size="sm" className="oc-badge-craft">
                            {reasonLabel(entry.reason)}
                          </Badge>
                        </div>
                        {entry.description && (
                          <p className="mt-0.5 line-clamp-1 text-caption text-muted">{entry.description}</p>
                        )}
                        <MetaLine className="mt-1">
                          <span>
                            收纳于 <TimeAgo value={entry.archivedAt} className="text-meta text-faint" />
                          </span>
                        </MetaLine>
                      </div>
                      <Button
                        size="sm"
                        variant="secondary"
                        className="oc-btn-tactile oc-btn-secondary-craft shrink-0 gap-1"
                        loading={busyKey === `skill:${entry.id}`}
                        disabled={busyKey !== null}
                        onClick={() =>
                          void restoreSkill({ id: entry.id, name: entry.name, label: `「${entry.name}」` })
                        }
                      >
                        <RotateCcw size={12} strokeWidth={1.8} aria-hidden="true" />
                        恢复原样
                      </Button>
                    </ListRow>
                  ))}
                </ListGroup>
              </section>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}

export default ContextArchiveDrawer;
