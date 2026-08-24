import { useEffect, useState } from "react";
import { apiErrorMessage } from "../../lib/api";
import { isWorkScope } from "../../lib/projectScope";
import { taskboardApi } from "../../lib/taskboard";
import type { AuthSession } from "../../lib/types";
import { useProjectScope } from "../../hooks/useProjectScope";
import { ListSkeleton, PanelHeader, useToast } from "../ui";

export function AgentProjectPreview({ auth, agentId }: { auth: AuthSession; agentId: string }) {
  const { scope } = useProjectScope();
  const toast = useToast();
  const workId = scope.workProject?.id;
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!workId) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void taskboardApi
      .previewProjectContext(auth, workId)
      .then((res) => {
        if (!cancelled) setPreview(res);
      })
      .catch((e) => {
        if (!cancelled) toast(apiErrorMessage(e, "预览失败"), "error");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [auth, workId, agentId, toast]);

  if (!isWorkScope(scope) || !workId) return null;

  const slots = Array.isArray(preview?.slots)
    ? (preview?.slots as Array<{ name: string; bytes: number; redacted?: boolean }>)
    : [];
  const enabled = preview?.enabled !== false;

  return (
    <div data-testid="agent-project-preview" className="border-t border-border">
      <PanelHeader
        title="该 Agent 将看到的项目上下文"
        hint="只读 preview API。不可逐字重放。"
      />
      {loading ? (
        <ListSkeleton rows={3} />
      ) : !enabled ? (
        <p className="px-4 py-3 text-caption text-muted">项目上下文未启用。</p>
      ) : (
        <ul className="px-4 py-3 text-caption text-muted">
          {slots.map((s) => (
            <li key={s.name}>
              {s.name} · {s.bytes}B{s.redacted ? " · 已脱敏" : ""}
            </li>
          ))}
          {slots.length === 0 ? <li>暂无注入槽</li> : null}
        </ul>
      )}
    </div>
  );
}
