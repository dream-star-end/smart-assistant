import { useEffect, useMemo, useState } from "react";
import { api, apiErrorMessage } from "../../lib/api";
import { isWorkScope } from "../../lib/projectScope";
import type { AuthSession, ProjectAsset } from "../../lib/types";
import { useProjectScope } from "../../hooks/useProjectScope";
import { Folder } from "lucide-react";
import { EmptyState, ListSkeleton, PanelHeader, useToast } from "../ui";

const SENSITIVE_RE = /qr|login|password|secret|apikey|ssh|private[_\-]?key/i;

export function ProjectAssetsManagePanel({ auth }: { auth: AuthSession }) {
  const { scope } = useProjectScope();
  const toast = useToast();
  const chatId = scope.chatProject?.id ?? null;
  const [assets, setAssets] = useState<ProjectAsset[] | null>(null);

  useEffect(() => {
    if (!chatId) {
      setAssets([]);
      return;
    }
    let cancelled = false;
    void api
      .listProjectAssets(auth, chatId)
      .then((rows) => {
        if (!cancelled) setAssets(rows);
      })
      .catch((e) => {
        if (!cancelled) toast(apiErrorMessage(e, "加载项目资产失败"), "error");
      });
    return () => {
      cancelled = true;
    };
  }, [auth, chatId, toast]);

  const deduped = useMemo(() => {
    const seen = new Set<string>();
    const out: ProjectAsset[] = [];
    for (const a of assets ?? []) {
      const digest = "digest" in a && typeof (a as { digest?: string }).digest === "string"
        ? (a as { digest: string }).digest
        : "";
    const key = (digest || a.url || a.containerPath || a.id).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(a);
    }
    return out;
  }, [assets]);

  if (!isWorkScope(scope) && scope.kind !== "chat") return null;

  return (
    <div data-testid="project-assets-manage" className="border-t border-border">
      <PanelHeader title="项目资产" hint="只显示 project_assets 权威索引，不扫描 generated/uploads。" />
      {!chatId ? (
        <p className="px-4 py-3 text-caption text-muted">绑定聊天 facade 后可看该项目资产。</p>
      ) : assets === null ? (
        <ListSkeleton rows={3} />
      ) : deduped.length === 0 ? (
        <EmptyState icon={Folder} title="没有项目资产" hint="会话附件需经 POST /api/project-assets 入库。" />
      ) : (
        <ul className="flex flex-col gap-2 px-4 py-3">
          {deduped.map((a) => {
            const sensitive = SENSITIVE_RE.test(a.name) || SENSITIVE_RE.test(a.containerPath ?? "");
            const missing = !a.containerPath && !a.url;
            const digest =
              "digest" in a && typeof (a as { digest?: string }).digest === "string"
                ? (a as { digest: string }).digest
                : "";
            return (
              <li key={a.id} className="rounded-lg border border-border px-3 py-2 text-body" data-testid={`project-asset-${a.id}`}>
                <div className="font-medium">{a.name}</div>
                <div className="text-caption text-muted">
                  来源会话 {a.sessionId ?? "—"} · {a.source}
                  {digest ? ` · ${digest.slice(0, 12)}` : ""}
                  {sensitive ? " · 敏感" : ""}
                  {missing ? " · 缺失路径" : ""}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
