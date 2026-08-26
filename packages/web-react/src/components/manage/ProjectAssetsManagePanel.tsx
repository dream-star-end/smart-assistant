import { isWorkScope } from "../../lib/projectScope";
import type { AuthSession } from "../../lib/types";
import { useProjectScope } from "../../hooks/useProjectScope";
import { Folder } from "lucide-react";
import { ProjectAssetsPanel } from "../ProjectAssetsPanel";
import { EmptyState, PanelHeader } from "../ui";

export function ProjectAssetsManagePanel({ auth }: { auth: AuthSession }) {
  const { scope } = useProjectScope();
  const chatId = scope.chatProject?.id ?? null;

  if (!isWorkScope(scope) && scope.kind !== "chat") return null;

  return (
    <div data-testid="project-assets-manage" className="border-t border-border">
      <PanelHeader
        title="项目资产"
        hint="上传、删除、固定/取消固定走既有 /api/project-assets。按 digest 去重；文件名含密钥/二维码等会标敏感。"
      />
      {!chatId ? (
        <EmptyState
          icon={Folder}
          title="未绑定聊天项目"
          hint="绑定聊天 facade 后即可管理该工作项目的资产。"
        />
      ) : (
        <div className="px-4 py-3">
          <ProjectAssetsPanel projectId={chatId} auth={auth} authSession={auth} />
        </div>
      )}
    </div>
  );
}
