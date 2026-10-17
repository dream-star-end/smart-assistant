/**
 * Module-level helpers of App.tsx (FINDINGS §7.6 A1, OCV5-472), moved verbatim so App.tsx and the
 * app hooks share them without importing from App.tsx.
 */
import { lazy, useState } from 'react'
import { readNetworkInformation, shouldPrefetchCenters } from '../lib/prefetchPolicy'
import { Spinner } from '../components/ui'
import { BootSplash } from '../components/BootSplash'
import type { ChatMessage } from '../lib/chat/model'
import { TASKBOARD_ENABLED } from '../lib/taskboardFeature'

// 首屏瘦身:营销首页 + 设置/管理/市场/组织/教程中心按需异步加载,移出 entry chunk。
// 命名导出 → default 适配。渲染点各自套 LazyBoundary（= chunk 加载失败兜底 + Suspense：
// 对话框仅在 open 时挂载 → 首屏零下载,首次打开拉块时短暂显 loading；React.lazy 解析后模块
// 常驻,再次打开无回退闪烁。发新版后旧标签页拉不到旧 chunk 时由 ChunkErrorBoundary 兜底,
// 提示刷新而非白屏——见 components/ChunkErrorBoundary）。
export type PredictInput = typeof import('../lib/inputPrediction').predictInput

export const Landing = lazy(() =>
  import('../components/Landing').then((m) => ({ default: m.Landing })),
)

export const SettingsCenter = lazy(() =>
  import('../components/SettingsCenter').then((m) => ({ default: m.SettingsCenter })),
)

export const ManageCenter = lazy(() =>
  import('../components/ManageCenter').then((m) => ({ default: m.ManageCenter })),
)

export const MarketplaceCenter = lazy(() =>
  import('../components/MarketplaceCenter').then((m) => ({ default: m.MarketplaceCenter })),
)

// 企业版(P3.1)第四中心。仅 org owner/admin 有入口(成员在设置·账户页只读展示)。
export const OrgCenter = lazy(() =>
  import('../components/OrgCenter').then((m) => ({ default: m.OrgCenter })),
)

export const TutorialCenter = lazy(() =>
  import('../components/TutorialCenter').then((m) => ({ default: m.TutorialCenter })),
)

export const ContainerWebPreview = lazy(() =>
  import('../components/ContainerWebPreview').then((m) => ({ default: m.ContainerWebPreview })),
)

export const MediaTaskCenter = lazy(() =>
  import('../components/MediaTaskCenter').then((m) => ({ default: m.MediaTaskCenter })),
)

export const ChatGptProxyDialog = lazy(() =>
  import('../components/ChatGptProxyDialog').then((m) => ({ default: m.ChatGptProxyDialog })),
)

export const ShareDialog = lazy(() =>
  import('../components/ShareDialog').then((m) => ({ default: m.ShareDialog })),
)

export const TaskboardView = lazy(() =>
  import('../components/taskboard/TaskboardView').then((m) => ({ default: m.TaskboardView })),
)

// 2026-09-17 首屏体量门(first-screen-budget)超限修复:下列对话框/编辑器都是「点开才需要」的
// 覆盖层,此前静态 import 把它们(连同 ImageViewer 三模式、ProjectAssetsPanel 等)钉在入口静态
// 闭包里。改 React.lazy 后由渲染点的挂载闸(useMountedOnce / 条件挂载)控制首次下载;打开过
// 一次即常驻,状态保留与关闭语义与原先「始终挂载、按 open 显隐」一致。
export const ImageAnnotationEditor = lazy(() =>
  import('../components/ImageAnnotationEditor').then((m) => ({ default: m.ImageAnnotationEditor })),
)

export const GithubRepoModal = lazy(() =>
  import('../components/github/GithubRepoModal').then((m) => ({ default: m.GithubRepoModal })),
)

export const InboxDialog = lazy(() =>
  import('../components/InboxDialog').then((m) => ({ default: m.InboxDialog })),
)

export const MessageFeedbackDialog = lazy(() =>
  import('../components/chat/MessageFeedbackDialog').then((m) => ({
    default: m.MessageFeedbackDialog,
  })),
)

export const ProjectArchiveDialog = lazy(() =>
  import('../components/ProjectArchiveDialog').then((m) => ({ default: m.ProjectArchiveDialog })),
)

export const CreateProjectDialog = lazy(() =>
  import('../components/CreateProjectDialog').then((m) => ({ default: m.CreateProjectDialog })),
)

export const ProjectSettingsDialog = lazy(() =>
  import('../components/ProjectSettingsDialog').then((m) => ({ default: m.ProjectSettingsDialog })),
)

// Ctrl/⌘K palette: lazy, mounted on first open (first-screen budget).
export const CommandPalette = lazy(() =>
  import('../components/CommandPalette').then((m) => ({ default: m.CommandPalette })),
)

// 项目主页(/p/<id>)是并列工作区,点开项目才需要;带着 ProjectAssetsPanel,不能进入口闭包。
export const ProjectHome = lazy(() =>
  import('../components/project/ProjectHome').then((m) => ({ default: m.ProjectHome })),
)

// P5b「记住这条 / 存为项目技能」弹窗：点了才下载（带 lib/taskboard）。
export const SaveToProjectDialog = lazy(() =>
  import('../components/project/SaveToProjectDialog').then((m) => ({
    default: m.SaveToProjectDialog,
  })),
)

// UX 体验对冲（红线:优化不得降低体验）:懒加载省首屏,但慢网下首开中心会多一个
// loading 瞬间。首屏渲染完成后在浏览器空闲期预取这些懒块——Vite 对同一 specifier
// 的动态 import 去重,预取后 React.lazy 解析即命中,首开零延迟;弱网下预取失败静默,
// 行为退化为按需加载,不比没有预取更差。
export function prefetchLazyCentersOnIdle(): void {
  const prefetch = () => {
    // 省流量模式 / 2G 下不在后台下完全部中心(shell 审计 S-16);API 缺席的浏览器照常预取。
    if (!shouldPrefetchCenters(readNetworkInformation())) return
    void import('../components/Landing').catch(() => {})
    void import('../components/SettingsCenter').catch(() => {})
    void import('../components/ManageCenter').catch(() => {})
    void import('../components/MarketplaceCenter').catch(() => {})
    void import('../components/OrgCenter').catch(() => {})
    void import('../components/TutorialCenter').catch(() => {})
    void import('../components/MediaTaskCenter').catch(() => {})
    // 全屏图片查看器(含圈选编辑/评论/调整大小)也是懒块:时间线里点图即开,预热后首开零延迟。
    void import('../components/ImageViewer').catch(() => {})
    if (TASKBOARD_ENABLED) {
      void import('../components/taskboard/TaskboardView').catch(() => {})
    }
  }
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(prefetch, { timeout: 8000 })
  } else {
    setTimeout(prefetch, 3000)
  }
}

/** 全屏懒块加载态（营销首页 chunk 下载期）——与启动续期 splash 同视觉,不割裂。*/
export function SplashFallback() {
  return <BootSplash />
}

/** 对话框懒块加载态——铺一层与 Dialog.Overlay 同款的半透明遮罩 + 居中 spinner,
 *  首次打开拉块的短暂空窗内给出「正在打开」的视觉,避免点击后无反馈。
 *  role=status + aria-live 让读屏用户也收到「正在加载」而非静默黑屏。*/
export function DialogFallback() {
  return (
    // biome-ignore lint/a11y/useSemanticElements: <output> 语义是"表单计算结果",这里是全屏加载遮罩,保留 div+role=status
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
    >
      <Spinner size={22} />
      <span className="sr-only">加载中</span>
    </div>
  )
}

/** 懒加载对话框的挂载闸:首次 open 之前不挂载(不下载 chunk);打开过一次后常驻返回 true,
 *  保持与原先「始终挂载、按 open 显隐」相同的状态保留/关闭语义。渲染期 setState 是 React
 *  认可的「由 props 派生状态」写法,只在 open 首次翻真时触发一次。 */
export function useMountedOnce(open: boolean): boolean {
  const [mounted, setMounted] = useState(open)
  if (open && !mounted) setMounted(true)
  return mounted || open
}

export const EMPTY_WS_MESSAGES: ChatMessage[] = []

export function replyQuoteText(message: ChatMessage): string {
  if (message.text.trim()) return message.text
  const media = message._media ?? []
  if (media.some((item) => item.kind === 'image'))
    return media.length > 1 ? `[${media.length} 张图片]` : '[图片]'
  const first = media[0]
  if (first?.filename) return `[文件：${first.filename}]`
  return media.length > 0 ? '[附件]' : ''
}
