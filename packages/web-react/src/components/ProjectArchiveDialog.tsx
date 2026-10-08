import { Archive, RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { ChatProject, DeletedChatProject } from "../lib/types";
import { Button, EmptyState, Modal } from "./ui";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 已归档的项目(可取消归档)和 30 天内删除的项目(可恢复)。
 * 删除的列表在打开时现取;恢复/取消归档由调用方完成(含定时任务与看板的连带处理)。
 */
export function ProjectArchiveDialog({
  open,
  onOpenChange,
  archived,
  loadDeleted,
  onUnarchive,
  onRestore,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  archived: ChatProject[];
  loadDeleted: () => Promise<DeletedChatProject[]>;
  onUnarchive: (p: ChatProject) => Promise<void>;
  onRestore: (id: string) => Promise<boolean>;
}) {
  const [deleted, setDeleted] = useState<DeletedChatProject[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setDeleted(null);
    void loadDeleted().then((rows) => {
      if (alive) setDeleted(rows);
    });
    return () => {
      alive = false;
    };
  }, [open, loadDeleted]);

  const daysLeft = (deletedAt: number) => Math.max(0, Math.ceil((deletedAt + 30 * DAY_MS - Date.now()) / DAY_MS));

  return (
    <Modal open={open} onOpenChange={onOpenChange} title="已归档和最近删除的项目" size="md">
      <div className="flex flex-col gap-5">
        <section aria-label="已归档的项目">
          <h3 className="mb-2 flex items-center gap-1.5 text-meta font-medium text-muted">
            <Archive size={14} aria-hidden /> 已归档
          </h3>
          {archived.length === 0 ? (
            <p className="text-caption text-faint">没有归档的项目。项目菜单里的「归档」会把它收到这里。</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {archived.map((p) => (
                <li key={p.id} className="flex min-h-11 items-center gap-2 rounded-md px-2 hover:bg-hover">
                  <span className="min-w-0 flex-1 truncate text-body">{p.name}</span>
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={busy === p.id}
                    onClick={async () => {
                      setBusy(p.id);
                      try {
                        await onUnarchive(p);
                      } finally {
                        setBusy(null);
                      }
                    }}
                  >
                    取消归档
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section aria-label="最近删除的项目">
          <h3 className="mb-2 flex items-center gap-1.5 text-meta font-medium text-muted">
            <Trash2 size={14} aria-hidden /> 最近删除（30 天内可恢复）
          </h3>
          {deleted === null ? (
            <p className="text-caption text-faint">正在加载…</p>
          ) : deleted.length === 0 ? (
            <EmptyState icon={Trash2} title="没有最近删除的项目" />
          ) : (
            <ul className="flex flex-col gap-1">
              {deleted.map((d) => (
                <li key={d.id} className="flex min-h-11 items-center gap-2 rounded-md px-2 hover:bg-hover">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body">{d.name}</span>
                    <span className="block text-caption text-faint">
                      {d.sessionCount} 个会话 · 还剩 {daysLeft(d.deletedAt)} 天
                    </span>
                  </span>
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={busy === d.id}
                    onClick={async () => {
                      setBusy(d.id);
                      try {
                        if (await onRestore(d.id)) setDeleted((cur) => (cur ?? []).filter((x) => x.id !== d.id));
                      } finally {
                        setBusy(null);
                      }
                    }}
                  >
                    <RotateCcw size={14} aria-hidden /> 恢复
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Modal>
  );
}
