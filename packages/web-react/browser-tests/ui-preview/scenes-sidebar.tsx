/**
 * sidebar 模块审计场景（t-36 · A·sidebar）：侧栏全貌 / 空态 / 搜索态 / 多选态 / 最窄宽度 /
 * 移动端抽屉、项目设置与资产面板、站内信抽屉、GitHub 仓库绑定 modal、仓库状态横幅 + 仓库 pill。
 *
 * 不含 Dialog 的场景走整页截图；Dialog / Sheet 场景由 shoot.mjs 裁到 [role=dialog]。
 * 搜索 / 多选 / 选仓这类**组件内部态**没有 props 入口，用 AutoDrive 在挂载后驱动真实 DOM 事件
 * （React 受控输入需走原生 value setter + input 事件），把界面推到要评估的那一帧。
 */
import { type ReactNode, useEffect, useRef } from 'react'
import { InboxDialog } from '../../src/components/InboxDialog'
import { ProjectSettingsDialog } from '../../src/components/ProjectSettingsDialog'
import { Sidebar, type SidebarProps } from '../../src/components/Sidebar'
import { GithubRepoModal } from '../../src/components/github/GithubRepoModal'
import { RepoPill } from '../../src/components/github/RepoPill'
import { RepoStatusBanner } from '../../src/components/github/RepoStatusBanner'
import { Sheet } from '../../src/components/ui'
import { archivedExpandedStorageKey } from '../../src/hooks/useChatProjects'
import { createMemoryAuthSession } from '../../src/lib/authSession'
import type {
  ChatProject,
  GithubBranch,
  GithubRepo,
  InboxMessage,
  ProjectAsset,
  RepoSelection,
  Session,
  SessionSearchHit,
  User,
} from '../../src/lib/types'
import type { Scene } from './types'

const auth = createMemoryAuthSession(() => {}, 'preview-token')
const noop = () => {}
const asyncNoop = async () => {}

const NOW = Date.now()
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const iso = (ms: number) => new Date(ms).toISOString()

const user: User = {
  id: 'sidebar-preview',
  displayName: '审计预览',
  roles: ['user'],
  role: 'admin',
  credits: '1234567',
}

// ── 项目 / 会话假数据 ─────────────────────────────────────────────────────
const projects: ChatProject[] = [
  {
    id: 'p-web',
    name: '前端重构',
    color: 'accent',
    instructions: '回答尽量给出可直接落地的代码改动，附上受影响文件列表。',
    sortOrder: 0,
    createdAt: NOW - 30 * DAY,
    updatedAt: NOW - HOUR,
    sessionCount: 3,
  },
  {
    id: 'p-data',
    name: '数据分析',
    color: 'success',
    sortOrder: 1,
    createdAt: NOW - 20 * DAY,
    updatedAt: NOW - 2 * DAY,
    sessionCount: 0,
  },
  {
    id: 'p-docs',
    name: '文档与部署',
    color: null,
    sortOrder: 2,
    createdAt: NOW - 10 * DAY,
    updatedAt: NOW - 3 * HOUR,
    sessionCount: 2,
  },
]

function session(
  partial: Partial<Session> & { id: string; title: string; ageMs: number },
): Session {
  const { ageMs, ...rest } = partial
  const lastAt = NOW - ageMs
  return {
    ownerUserId: user.id,
    createdAt: lastAt - 25 * MIN,
    lastAt,
    updatedAt: iso(lastAt),
    messageCount: 6,
    pinned: false,
    projectId: null,
    runState: 'idle',
    lastOutcome: 'completed',
    lastErrorCode: null,
    ...rest,
  }
}

const sessions: Session[] = [
  session({
    id: 's-pin-1',
    title: '部署脚本排错：K8s 探针超时',
    ageMs: 2 * HOUR,
    pinned: true,
    unread: true,
  }),
  session({
    id: 's-web-1',
    title: '重构侧栏虚拟列表',
    ageMs: 0,
    projectId: 'p-web',
    runState: 'running',
    lastOutcome: null,
  }),
  session({
    id: 's-web-2',
    title: '补齐 ProjectRow 单测',
    ageMs: 40 * MIN,
    projectId: 'p-web',
    unread: true,
  }),
  session({
    id: 's-web-3',
    title: 'CI 报错排查 · biome 规则',
    ageMs: 5 * HOUR,
    projectId: 'p-web',
    lastOutcome: 'crashed',
    lastErrorCode: 'tool_crash',
  }),
  session({
    id: 's-doc-1',
    title: '整理 v5 个人版部署文档（自托管 Docker Compose + Nginx 反向代理 + 证书续期）',
    ageMs: 0,
    projectId: 'p-docs',
    runState: 'running',
    lastOutcome: null,
  }),
  session({ id: 's-doc-2', title: '翻译 README', ageMs: 3 * HOUR, projectId: 'p-docs' }),
  session({
    id: 's-un-1',
    title: '服务重启后继续',
    ageMs: 20 * MIN,
    lastOutcome: 'crashed',
    lastErrorCode: 'service_restart',
  }),
  session({ id: 's-un-2', title: '对比模型报价', ageMs: 26 * HOUR, lastOutcome: 'interrupted' }),
  session({ id: 's-un-3', title: '周报生成', ageMs: 3 * DAY, createdAt: undefined }),
  session({ id: 's-un-4', title: '', ageMs: 9 * DAY, lastOutcome: null }),
  session({ id: 's-arc-1', title: '旧需求讨论', ageMs: 40 * DAY, archived: true }),
  session({ id: 's-arc-2', title: '已完成的迁移', ageMs: 60 * DAY, archived: true }),
]

const unreadIds = new Set(['s-pin-1', 's-web-2'])
const collapsedProjectIds = new Set(['p-docs'])

const searchHits: SessionSearchHit[] = [
  {
    sessionId: 's-web-1',
    title: '重构侧栏虚拟列表',
    projectId: 'p-web',
    snippet: '…先把部署脚本里的 readinessProbe 超时从 3s 提到 10s，再看侧栏首屏…',
    matchedAt: NOW - HOUR,
    kind: 'message',
  },
  {
    sessionId: 's-un-2',
    title: '对比模型报价',
    snippet: '部署到自托管环境时按 token 计费，不再收席位费。',
    matchedAt: NOW - 2 * HOUR,
    kind: 'message',
    unread: true,
  },
]

/** 侧栏公共 props：镜像 App.tsx 的 sidebarProps，回调全部空实现。 */
const baseSidebarProps: SidebarProps = {
  sessions,
  activeId: 's-web-2',
  user,
  credits: user.credits,
  optimizerPending: 2,
  onSelect: noop,
  onNew: noop,
  onNewWithAgent: noop,
  onNewInProject: noop,
  onRename: noop,
  onDelete: noop,
  onTogglePin: noop,
  onMoveToProject: noop,
  onArchive: noop,
  onBatch: noop,
  projects,
  collapsedProjectIds,
  onToggleProjectCollapsed: noop,
  onCreateProject: noop,
  onRenameProject: noop,
  onDeleteProject: noop,
  onOpenProjectSettings: noop,
  onOpenProjectAssets: noop,
  onReorderProjects: noop,
  isSending: () => false,
  onCollapse: noop,
  onLogout: noop,
  onOpenAccount: noop,
  onOpenFeedback: noop,
  onOpenManage: noop,
  onOpenMarketplace: noop,
  onOpenTutorial: noop,
  onOpenOrg: noop,
  onOpenBoard: noop,
  onOpenMediaTasks: noop,
  onOpenApiAccess: noop,
  boardActive: false,
  showAdmin: true,
  theme: 'light',
  onCycleTheme: noop,
  unreadIds,
  onMarkRead: noop,
  width: 268,
  onResizeStart: noop,
  resizing: false,
  onLoadMore: noop,
  hasMore: true,
  loadingMore: false,
  onLoadArchived: noop,
  loadingArchived: false,
  onSearchMessages: async () => searchHits,
}

/** 「已归档」展开态按用户维度落 localStorage；每个场景显式写死，避免跨场景串态。 */
function setArchivedExpanded(expanded: boolean) {
  try {
    localStorage.setItem(archivedExpandedStorageKey(user.id), expanded ? '1' : '0')
  } catch {
    /* private mode */
  }
}

// ── 交互驱动 ─────────────────────────────────────────────────────────────
function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function clickByText(text: string, root: ParentNode = document) {
  const el = Array.from(root.querySelectorAll<HTMLElement>('button')).find(
    (b) => b.textContent?.trim() === text,
  )
  el?.click()
}

/** 挂载后按 60ms 间隔依次执行 steps，把组件内部态推到目标截图态。 */
function AutoDrive({ steps, children }: { steps: Array<() => void>; children: ReactNode }) {
  const stepsRef = useRef(steps)
  const ranRef = useRef(false)
  useEffect(() => {
    if (ranRef.current) return
    ranRef.current = true
    const timers = stepsRef.current.map((step, i) => window.setTimeout(step, 60 * (i + 1)))
    return () => {
      for (const t of timers) window.clearTimeout(t)
    }
  }, [])
  return <>{children}</>
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-screen bg-bg text-fg">
      {children}
      <main className="flex min-w-0 flex-1 flex-col items-center justify-center gap-1 text-faint">
        <p className="text-body">主区域占位</p>
        <p className="text-caption">sidebar 审计场景 · 只看左侧</p>
      </main>
    </div>
  )
}

// ── 项目资产 / 站内信 / GitHub 假数据 ────────────────────────────────────
const assets: ProjectAsset[] = [
  {
    id: 'a-1',
    projectId: null,
    source: 'upload',
    sessionId: null,
    name: '自托管部署手册 v5.pdf',
    url: '/api/files/a-1.pdf',
    containerPath: null,
    mime: 'application/pdf',
    sizeBytes: 2_345_678,
    excerpt: null,
    pinned: true,
    createdAt: NOW - 2 * DAY,
    updatedAt: NOW - DAY,
  },
  {
    id: 'a-2',
    projectId: null,
    source: 'output',
    sessionId: 's-web-1',
    name: 'sidebar-virtual-list-benchmark.png',
    url: '/api/files/a-2.png',
    containerPath: null,
    mime: 'image/png',
    sizeBytes: 412_000,
    excerpt: null,
    pinned: false,
    createdAt: NOW - 3 * HOUR,
    updatedAt: NOW - 3 * HOUR,
  },
  {
    id: 'a-3',
    projectId: null,
    source: 'upload',
    sessionId: null,
    name: 'release-notes-2026-09.zip',
    url: '/api/files/a-3.zip',
    containerPath: null,
    mime: 'application/zip',
    sizeBytes: 9_800_000,
    excerpt: null,
    pinned: false,
    createdAt: NOW - 5 * DAY,
    updatedAt: NOW - 5 * DAY,
  },
  {
    id: 'a-4',
    projectId: null,
    source: 'output',
    sessionId: 's-un-3',
    name: '周报-第37周.md',
    url: null,
    containerPath: '/workspace/out/weekly-37.md',
    mime: 'text/markdown',
    sizeBytes: null,
    excerpt: null,
    pinned: false,
    createdAt: NOW - 3 * DAY,
    updatedAt: NOW - 3 * DAY,
  },
]

const inboxMessages: InboxMessage[] = [
  {
    id: 'm-1',
    audience: 'all',
    user_id: null,
    title: 'v5 个人版 9 月更新：侧栏支持项目分组与批量归档',
    body_md:
      '## 本次更新\n\n- 侧栏新增 **项目分组**，可拖拽会话到项目\n- 支持多选后批量归档 / 移动\n- 站内信改为右侧抽屉\n\n![更新截图](/api/inbox-assets/2026-09-sidebar.png)\n\n<!-- ob:release-2026-09 -->',
    level: 'notice',
    created_by: 'system',
    created_at: iso(NOW - 25 * MIN),
    expires_at: null,
    read: false,
  },
  {
    id: 'm-2',
    audience: 'user',
    user_id: user.id,
    title: '你的 GitHub 授权将在 3 天后过期',
    body_md: '请在「关联 GitHub 仓库」里重新授权，否则已绑定仓库的会话将无法拉取最新分支。',
    level: 'warning',
    created_by: 'system',
    created_at: iso(NOW - 5 * HOUR),
    expires_at: iso(NOW + 3 * DAY),
    read: false,
  },
  {
    id: 'm-3',
    audience: 'all',
    user_id: null,
    title: '限时活动：邀请好友各得 500 积分',
    body_md: '活动截止 9 月 30 日。邀请链接在「设置 → 账户」。',
    level: 'promo',
    created_by: 'ops',
    created_at: iso(NOW - DAY - 2 * HOUR),
    expires_at: null,
    read: false,
  },
  {
    id: 'm-4',
    audience: 'user',
    user_id: user.id,
    title: '上周用量周报',
    body_md:
      '上周共消耗 12,340 积分，较前一周 **-8%**。\n\n```chart\n{"type":"bar","data":{"labels":["一","二","三"],"datasets":[{"data":[3,5,2]}]}}\n```',
    level: 'info',
    created_by: 'system',
    created_at: iso(NOW - 3 * DAY),
    expires_at: null,
    read: true,
  },
  {
    id: 'm-5',
    audience: 'all',
    user_id: null,
    title: '计划维护：9 月 20 日 02:00–03:00 服务短暂不可用',
    body_md: '维护期间已有会话不受影响，新建会话可能失败，请提前保存。',
    level: 'notice',
    created_by: 'system',
    created_at: iso(NOW - 12 * DAY),
    expires_at: null,
    read: true,
  },
]

const repos: GithubRepo[] = [
  {
    owner: { login: 'dream-star-end' },
    name: 'openclaude',
    full_name: 'dream-star-end/openclaude',
    default_branch: 'main',
    private: true,
  },
  {
    owner: { login: 'dream-star-end' },
    name: 'v5-selfhost-docs',
    full_name: 'dream-star-end/v5-selfhost-docs',
    default_branch: 'main',
    private: false,
  },
  {
    owner: { login: 'dream-star-end' },
    name: 'infra-compose',
    full_name: 'dream-star-end/infra-compose',
    default_branch: 'master',
    private: true,
  },
  {
    owner: { login: 'dream-star-end' },
    name: 'weekly-report-bot',
    full_name: 'dream-star-end/weekly-report-bot',
    default_branch: 'main',
    private: false,
  },
  {
    owner: { login: 'dream-star-end' },
    name: 'a-very-long-repository-name-to-check-truncation-behaviour',
    full_name: 'dream-star-end/a-very-long-repository-name-to-check-truncation-behaviour',
    default_branch: 'develop',
    private: true,
  },
]

const branches: GithubBranch[] = [
  { name: 'feat/v5-selfhost-audit-sidebar', commit: { sha: '210b996' } },
  { name: 'main', commit: { sha: 'aaa1111' } },
  { name: 'feat/v5-selfhost', commit: { sha: 'bbb2222' } },
  { name: 'release/2026-09', commit: { sha: 'ccc3333' } },
]

const readySelection: RepoSelection = {
  selected: true,
  owner: 'dream-star-end',
  repo: 'openclaude',
  branch: 'feat/v5-selfhost',
  default_branch: 'main',
  status: 'ready',
  head_sha: '210b9967',
  selection_version: 3,
}
const cloningSelection: RepoSelection = {
  ...readySelection,
  status: 'cloning',
  head_sha: undefined,
}
const pendingSelection: RepoSelection = {
  ...readySelection,
  status: 'pending',
  head_sha: undefined,
}
const failedSelection: RepoSelection = {
  ...readySelection,
  status: 'failed',
  error_code: 'clone_failed',
  error_message:
    "fatal: could not read Username for 'https://github.com': terminal prompts disabled (token 已失效或仓库权限不足，请重新授权后重试)",
}

// ── 场景 ─────────────────────────────────────────────────────────────────
export const sidebarScenes: Scene[] = [
  {
    id: 'sidebar-overview',
    label: '侧栏 · 置顶/项目/运行中/未读/已归档全貌（桌面）',
    group: '工作区',
    viewports: ['desktop'],
    api: {},
    render: () => {
      setArchivedExpanded(true)
      return (
        <Frame>
          <Sidebar {...baseSidebarProps} />
        </Frame>
      )
    },
  },
  {
    id: 'sidebar-mobile-drawer',
    label: '侧栏 · 移动端抽屉（Sheet 内联侧栏）',
    group: '工作区',
    viewports: ['mobile'],
    api: {},
    render: () => {
      setArchivedExpanded(true)
      return (
        <Sheet
          open
          onOpenChange={noop}
          side="left"
          srTitle="会话导航"
          className="w-[268px] max-w-[82vw]"
        >
          <Sidebar
            {...baseSidebarProps}
            width={undefined}
            onResizeStart={undefined}
            resizing={false}
          />
        </Sheet>
      )
    },
  },
  {
    id: 'sidebar-empty',
    label: '侧栏 · 新用户空态（无会话无项目）',
    group: '工作区',
    viewports: ['desktop'],
    api: {},
    render: () => {
      setArchivedExpanded(false)
      return (
        <Frame>
          <Sidebar
            {...baseSidebarProps}
            sessions={[]}
            projects={[]}
            activeId={undefined}
            unreadIds={new Set()}
            hasMore={false}
            credits={null}
          />
        </Frame>
      )
    },
  },
  {
    id: 'sidebar-search',
    label: '侧栏 · 搜索态（标题命中 + 消息内容匹配）',
    group: '工作区',
    viewports: ['desktop'],
    api: {},
    render: () => {
      setArchivedExpanded(false)
      return (
        <AutoDrive
          steps={[
            () => {
              const input = document.querySelector<HTMLInputElement>('input[data-sidebar-search]')
              if (input) setInputValue(input, '部署')
            },
          ]}
        >
          <Frame>
            <Sidebar {...baseSidebarProps} />
          </Frame>
        </AutoDrive>
      )
    },
  },
  {
    id: 'sidebar-multiselect',
    label: '侧栏 · 多选态（BatchBar + 复选框）',
    group: '工作区',
    viewports: ['desktop'],
    api: {},
    render: () => {
      setArchivedExpanded(false)
      return (
        <AutoDrive
          steps={[
            () => clickByText('多选'),
            () => {
              const boxes = document.querySelectorAll<HTMLInputElement>(
                'input[type="checkbox"][aria-label^="选择 "]',
              )
              boxes[1]?.click()
              boxes[2]?.click()
            },
          ]}
        >
          <Frame>
            <Sidebar {...baseSidebarProps} />
          </Frame>
        </AutoDrive>
      )
    },
  },
  {
    id: 'sidebar-narrow-min',
    label: '侧栏 · 最窄宽度 220px + 多选条换行',
    group: '工作区',
    viewports: ['desktop'],
    api: {},
    render: () => {
      setArchivedExpanded(false)
      return (
        <AutoDrive steps={[() => clickByText('多选')]}>
          <Frame>
            <Sidebar {...baseSidebarProps} width={220} />
          </Frame>
        </AutoDrive>
      )
    },
  },
  {
    id: 'sidebar-project-settings',
    label: '项目设置 · 名称/颜色/看板绑定/自定义指令',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: {},
    render: () => (
      <ProjectSettingsDialog
        open
        project={projects[0]}
        onClose={noop}
        onSave={asyncNoop}
        demo={false}
        auth={null}
        sessions={sessions}
      />
    ),
  },
  {
    id: 'sidebar-project-assets',
    label: '项目资产 · 未分组资产面板（上传区 + 列表）',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: {
      listProjectAssets: async () => assets,
    },
    render: () => (
      <ProjectSettingsDialog
        open
        project={null}
        assetsOnly
        onClose={noop}
        onSave={asyncNoop}
        demo={false}
        auth={auth}
        authSession={auth}
        sessions={sessions}
        onOpenSession={noop}
      />
    ),
  },
  {
    id: 'sidebar-inbox',
    label: '站内信 · 右侧抽屉（含展开一条 + 各级别）',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: {
      listInboxMessages: async () => ({ messages: inboxMessages, unread_count: 3 }),
      markInboxRead: async () => ({ ok: true, already: false }),
      markAllInboxRead: async () => ({ ok: true, inserted: 3 }),
    },
    render: () => (
      <AutoDrive
        steps={[
          () => {
            const first = document.querySelector<HTMLElement>(
              '[role="dialog"] li button[aria-expanded]',
            )
            first?.click()
          },
        ]}
      >
        <InboxDialog open auth={auth} onClose={noop} onUnreadChange={noop} />
      </AutoDrive>
    ),
  },
  {
    id: 'sidebar-github-linked',
    label: 'GitHub 绑定 · 已关联账号 + 选仓 + 分支',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: {
      getGithubLink: async () => ({
        linked: true,
        login: 'dream-star-end',
        scopes: 'repo,read:user',
      }),
      listGithubRepos: async () => repos,
      listGithubBranches: async () => branches,
    },
    render: () => (
      <AutoDrive
        steps={[
          () => {
            const first = document.querySelector<HTMLElement>('[role="dialog"] ul li button')
            first?.click()
          },
        ]}
      >
        <GithubRepoModal
          open
          auth={auth}
          sessionId="s-web-1"
          selection={readySelection}
          onClose={noop}
          onConfirm={asyncNoop}
          onUnbind={asyncNoop}
          toast={noop}
        />
      </AutoDrive>
    ),
  },
  {
    id: 'sidebar-github-unlinked',
    label: 'GitHub 绑定 · 未关联账号',
    group: '工作区',
    viewports: ['desktop'],
    api: {
      getGithubLink: async () => ({ linked: false }),
    },
    render: () => (
      <GithubRepoModal
        open
        auth={auth}
        sessionId="s-web-1"
        selection={null}
        onClose={noop}
        onConfirm={asyncNoop}
        onUnbind={asyncNoop}
        toast={noop}
      />
    ),
  },
  {
    id: 'sidebar-repo-banner',
    label: '仓库状态横幅 4 态 + 仓库 pill 4 态',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: {},
    render: () => (
      <div className="flex min-h-screen flex-col gap-6 bg-bg p-4 text-fg">
        <section className="flex flex-col gap-2">
          <h2 className="px-4 text-caption font-medium uppercase tracking-wide text-faint">
            RepoStatusBanner
          </h2>
          <RepoStatusBanner selection={pendingSelection} progressPct={12} onDismiss={noop} />
          <RepoStatusBanner selection={cloningSelection} progressPct={64} onDismiss={noop} />
          <RepoStatusBanner selection={readySelection} progressPct={100} onDismiss={noop} />
          <RepoStatusBanner
            selection={failedSelection}
            progressPct={0}
            onDismiss={noop}
            onRetry={noop}
          />
        </section>
        <section className="flex flex-col gap-2">
          <h2 className="px-4 text-caption font-medium uppercase tracking-wide text-faint">
            RepoPill
          </h2>
          <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-3 px-4">
            <RepoPill selection={null} onClick={noop} />
            <RepoPill selection={readySelection} onClick={noop} />
            <RepoPill selection={cloningSelection} onClick={noop} />
            <RepoPill selection={failedSelection} onClick={noop} />
          </div>
        </section>
      </div>
    ),
  },
]
