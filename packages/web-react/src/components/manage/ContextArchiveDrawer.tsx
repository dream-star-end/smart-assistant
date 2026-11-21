import { Archive, Brain, RotateCcw, Sparkles } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, apiErrorMessage } from "../../lib/api";
import { formatBytes } from "../../lib/chat/download";
import type { ArchivedMemoryEntry, ArchivedSkillEntry, AuthSession } from "../../lib/types";
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
  expired: "自动过期归档",
  manual_archive: "手动归档",
  manual_slim: "一键瘦身归档",
  cold_skill: "超过60天未用",
  janitor_auto: "后台定时整理",
  janitor_manual: "手动体检整理",
};

function reasonLabel(reason: string): string {
  return REASON_LABELS[reason] ?? reason;
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
 * 统一「上下文归档箱」（React.lazy 独立分块，零首屏开销）。
 * 展示已归档的核心记忆与技能，支持单条「一键还原」与按批次「撤销本次整理」。
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
        if (alive) setErr(apiErrorMessage(e, "加载归档箱失败"));
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
        const res = await api.restoreArchivedMemories(auth, agentId, {
          ...(opts.id ? { id: opts.id } : {}),
          ...(opts.batchId ? { batchId: opts.batchId } : {}),
        });
        const count = res.restored?.length ?? 0;
        toast(count > 0 ? `已还原 ${opts.label}` : "未找到可还原的条目（可能已存在同名文件）", count > 0 ? "success" : "info");
        setReloadKey((k) => k + 1);
        onRestored();
      } catch (e) {
        toast(apiErrorMessage(e, "还原失败"), "error");
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
        const res = await api.restoreArchivedSkills(auth, {
          ...(opts.id ? { id: opts.id } : {}),
          ...(opts.name ? { name: opts.name } : {}),
          ...(opts.batchId ? { batchId: opts.batchId } : {}),
        });
        const count = res.restored?.length ?? 0;
        toast(count > 0 ? `已还原技能 ${opts.label}` : "未找到可还原的技能（可能已存在同名技能）", count > 0 ? "success" : "info");
        setReloadKey((k) => k + 1);
        onRestored();
      } catch (e) {
        toast(apiErrorMessage(e, "还原技能失败"), "error");
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
          <span className="oc-icon-badge size-6 rounded-md" aria-hidden="true">
            <Archive size={13} strokeWidth={1.8} />
          </span>
          <span className="text-title font-semibold tracking-tight text-fg">上下文归档箱</span>
        </span>
      }
      className="oc-surface-popover bg-surface"
    >
      <div className="space-y-4" data-testid="context-archive-drawer">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Tabs
            aria-label="归档分类"
            idBase="context-archive-tab"
            value={tab}
            onValueChange={(v) => setTab(v === "skills" ? "skills" : "memory")}
            className="oc-surface-recessed"
            items={[
              { value: "memory", label: `核心记忆（${memories.length}）` },
              { value: "skills", label: `技能（${skills.length}）` },
            ]}
          />
          <p className="text-caption text-faint">归档内容不占常驻上下文，可随时一键还原。</p>
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
                title="暂无已归档的核心记忆"
                hint="通过一键瘦身、自动整理或手动归档移出的记忆会安全保存在这里。"
              />
            </div>
          ) : (
            <div className="space-y-4">
              {memoryBatches.map(([batchId, items]) => (
                <section key={batchId} className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-caption font-medium text-muted">
                      批次 <code className="font-mono text-faint">{batchId.slice(0, 18)}</code> · {items.length} 条
                    </span>
                    {items.length > 1 && (
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
                        撤销本次整理
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
                              <Badge tone="neutral" size="sm" className="oc-badge-craft">
                                {reasonLabel(entry.reason)}
                              </Badge>
                            </div>
                            <MetaLine className="mt-1">
                              <span>{formatBytes(entry.bytes)}</span>
                              <span>
                                归档于 <TimeAgo value={entry.archivedAt} className="text-meta text-faint" />
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
                            一键还原
                          </Button>
                        </ListRow>
                      );
                    })}
                  </ListGroup>
                </section>
              ))}
            </div>
          )
        ) : skills.length === 0 ? (
          <div className="oc-surface-card rounded-2xl">
            <EmptyState
              icon={Sparkles}
              title="暂无已归档的技能"
              hint="长期未用的冷门技能或你手动归档的技能会保存在这里，随时可恢复启用。"
            />
          </div>
        ) : (
          <div className="space-y-4">
            {skillBatches.map(([batchId, items]) => (
              <section key={batchId} className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-caption font-medium text-muted">
                    批次 <code className="font-mono text-faint">{batchId.slice(0, 18)}</code> · {items.length} 个技能
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
                      撤销本次整理
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
                          <span>{formatBytes(entry.bytes)}</span>
                          <span>
                            归档于 <TimeAgo value={entry.archivedAt} className="text-meta text-faint" />
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
                        一键还原
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
