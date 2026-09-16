import { Folder } from 'lucide-react'
import { useProjectScope } from '../../hooks/useProjectScope'
import { isWorkScope } from '../../lib/projectScope'
import type { AuthSession } from '../../lib/types'
import { ProjectAssetsPanel } from '../ProjectAssetsPanel'
import { EmptyState, PanelHeader } from '../ui'

/**
 * 工作项目作用域下的「项目资产」入口（复用侧栏的 ProjectAssetsPanel）。
 * 文案面向用户：不提 API 路径、digest、facade 这些实现词（M-07）。
 */
export function ProjectAssetsManagePanel({ auth }: { auth: AuthSession }) {
  const { scope } = useProjectScope()
  const chatId = scope.chatProject?.id ?? null

  if (!isWorkScope(scope) && scope.kind !== 'chat') return null

  return (
    <div data-testid="project-assets-manage" className="border-t border-border">
      <PanelHeader
        title="项目资产"
        hint="上传给这个项目的参考文件；重复文件只保留一份，含密钥或二维码的文件会标记为敏感。"
      />
      {!chatId ? (
        <EmptyState
          icon={Folder}
          title="这个工作项目还没有绑定会话组"
          hint="把一个会话组绑定到这个工作项目后，就能在这里管理它的文件。"
        />
      ) : (
        <div className="px-4 py-3">
          <ProjectAssetsPanel projectId={chatId} auth={auth} authSession={auth} />
        </div>
      )}
    </div>
  )
}
