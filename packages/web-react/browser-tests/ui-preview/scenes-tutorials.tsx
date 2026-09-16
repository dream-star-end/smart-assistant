/**
 * 教程中心（tutorials）审计场景：案例展厅 / 精选作品 / 公开数据实作 / 快速上手 / 功能参考 /
 * 帮助与创作下拉 / 案例脚本 / 教程工作室（目录 · 空态 · 错误 · 详情 · 会话快照 · 手写 · 我的发布 · 从会话生成）。
 *
 * - 面板挂在 Radix Dialog Portal 里，shoot.mjs 会裁到 [role=dialog]。
 * - 面板内的导航（案例展厅 / 快速上手 / 帮助与创作菜单 / 侧栏目录 / 搜索）走真实点击：
 *   `TutorialHost` 用本地 state 镜像 App.tsx 的接线，`AutoAct` 在挂载后按步骤点按钮 / 输入 / 滚动。
 * - 离线 harness 对一切非 harness 请求回 204：/tutorials/** 的封面、演示视频、iframe 都会走各组件的
 *   onError / 加载中兜底。截图记录的就是「资源不可达时用户看到什么」；资源本体是否存在另行在文档里核对。
 * - `CommunityTutorials` 走 `api.*`（api-stub 场景表），每个场景自带假数据，不改 api-stub.ts。
 * - AutoAct 的步骤总等待必须小于 shoot.mjs 的 OC_UI_SHOT_DELAY（默认 400ms），否则截图早于动作。
 */
import { type ReactNode, useEffect, useState } from 'react'
import { TutorialCenter } from '../../src/components/TutorialCenter'
import { createMemoryAuthSession } from '../../src/lib/authSession'
import type { ChatMessage } from '../../src/lib/chat/model'
import type { ProductCapability, ProductFeatureId } from '../../src/lib/productCapabilities'
import { type TutorialActionState, resolveTutorialAction } from '../../src/lib/tutorialActions'
import type { TutorialCaseId } from '../../src/lib/tutorialCaseId'
import type {
  CommunityTutorialDetail,
  CommunityTutorialMine,
  CommunityTutorialSummary,
  ProjectAsset,
} from '../../src/lib/types'
import type { Scene } from './types'

// ── 假数据 ──────────────────────────────────────────────────────────────────
const auth = createMemoryAuthSession(() => {}, 'tutorials-preview-token')
const SHA_A = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)

const communityList: CommunityTutorialSummary[] = [
  {
    id: 'tut-7',
    title: '用公开数据完成一份可复现的城市出行分析',
    summary: '面向第一次做数据分析的同学：从下载 UCI 数据集开始，到交付图表、报告与可复跑脚本，全程只用对话完成。',
    category: 'research',
    authorName: '林晚',
    publishedAt: '2026-08-20T08:00:00.000Z',
  },
  {
    id: 'snap-1',
    title: '一次真实修 Bug 会话：从复现到最小补丁',
    summary: '作者把一次修复递归覆盖错误的会话做成脱敏快照，保留了失败测试、根因定位和最终 diff。',
    category: 'coding',
    authorName: 'ruoxi',
    publishedAt: '2026-09-02T02:30:00.000Z',
    kind: 'snapshot',
  },
  {
    id: 'tut-9',
    title: '会议纪要一键变成责任清单：给行政与项目经理的三步法',
    summary:
      '这份教程适合每周要整理多场会议的人。你会学到：如何把纪要粘贴进对话并标注发言人；如何要求助手把每一项行动落到负责人、期限和原文出处；如何在下一次会议前用同一会话追踪完成情况，而不是重新交代背景。摘要故意写长一些，用来检查卡片的三行截断与阅读节奏。',
    category: 'general',
    authorName: '办公助手爱好者',
    publishedAt: '2026-09-10T12:00:00.000Z',
  },
]

const markdownDetail: CommunityTutorialDetail = {
  ...communityList[0],
  bodyMarkdown: [
    '# 要解决的问题',
    '',
    '拿到一份原始 CSV，却不知道从哪一步开始，也不确定结果能不能被同事复现。',
    '',
    '## 准备',
    '',
    '- 下载 [UCI Bike Sharing](https://archive.ics.uci.edu/dataset/275) 数据集',
    '- 写清你想回答的 **三个问题**',
    '',
    '## 操作步骤',
    '',
    '1. 把 ZIP 拖进输入框，第一句只说「先检查数据质量」',
    '2. 确认字段含义后，再让它比较工作日 / 休息日的小时曲线',
    '3. 要求交付 `report.md` + `metrics.json` + 可复跑脚本',
    '',
    '```bash',
    'make reproduce   # 同事拿到工程后一条命令重跑',
    '```',
    '',
    '## 如何核对结果',
    '',
    '| 检查项 | 通过标准 |',
    '|---|---|',
    '| 缺失值 | 报告里写明 0 个缺失 |',
    '| 两次重跑 | 报告哈希一致 |',
    '',
    '![不会被加载的外链图片](https://example.com/should-be-blocked.png)',
  ].join('\n'),
}

const snapshotMessages: ChatMessage[] = [
  {
    id: 'tutorial-1',
    role: 'user',
    text: 'Astropy 的 separability_matrix 在嵌套 CompoundModel 时结果不对，请先复现再修。',
    ts: 1_756_780_000_000,
  } as ChatMessage,
  {
    id: 'tutorial-2',
    role: 'assistant',
    text: '我先在隔离 worktree 里写两个针对嵌套模型的回归测试，确认它们在基线上稳定失败，再沿 `_separable → _cstack` 定位。\n\n根因：`_cstack` 把右侧已有矩阵整块覆盖成 1。最小修复只改一行：把常量 `1` 改为 `right`。新增回归与邻近测试合计 13 项通过。',
    ts: 1_756_780_090_000,
  } as ChatMessage,
  {
    id: 'tutorial-3',
    role: 'user',
    text: '把根因报告和测试结果一起导出。',
    ts: 1_756_780_200_000,
  } as ChatMessage,
]

const snapshotDetail: CommunityTutorialDetail = {
  ...communityList[1],
  bodyMarkdown: '这次会话里我刻意先让测试变红，再去改代码。快照里保留了完整的失败输出。',
  snapshot: { schemaVersion: 1, messageCount: 3, messages: snapshotMessages },
  artifacts: [
    {
      sha256: SHA_A,
      name: 'root-cause.md',
      mime: 'text/markdown',
      bytes: 2048,
      downloadUrl: `/api/tutorial-blobs/${SHA_A}`,
      embedUrl: null,
    },
    {
      sha256: SHA_B,
      name: 'dashboard.html',
      mime: 'text/html',
      bytes: 18_042,
      downloadUrl: `/api/tutorial-blobs/${SHA_B}`,
      embedUrl: `/api/tutorial-embeds/${SHA_B}`,
    },
  ],
}

const mine: CommunityTutorialMine[] = [
  {
    id: 'mine-1',
    title: '用公开数据完成一份可复现的城市出行分析',
    summary: '面向第一次做数据分析的同学。',
    category: 'research',
    bodyMarkdown: '# 正文',
    status: 'approved',
    reviewNote: null,
    createdAt: '2026-08-18T09:12:00.000Z',
    reviewedAt: '2026-08-20T08:00:00.000Z',
    publishedAt: '2026-08-20T08:00:00.000Z',
  },
  {
    id: 'mine-2',
    title: '一次真实修 Bug 会话：从复现到最小补丁',
    summary: '脱敏快照，保留失败测试与最终 diff。',
    category: 'coding',
    bodyMarkdown: '',
    status: 'pending',
    reviewNote: null,
    createdAt: '2026-09-14T15:40:00.000Z',
    reviewedAt: null,
    publishedAt: null,
    kind: 'snapshot',
  },
  {
    id: 'mine-3',
    title: '三步做出周报自动化',
    summary: '定时任务 + 连接器。',
    category: 'general',
    bodyMarkdown: '# 正文',
    status: 'rejected',
    reviewNote: '第 2 步里贴了一段带真实企业微信 webhook 的配置，请脱敏后重新提交；另外「如何核对结果」一节缺失。',
    createdAt: '2026-09-11T03:05:00.000Z',
    reviewedAt: '2026-09-12T10:00:00.000Z',
    publishedAt: null,
  },
  {
    id: 'mine-4',
    title: '旧版：把会议纪要整理成行动项',
    summary: '已被新版取代。',
    category: 'general',
    bodyMarkdown: '# 正文',
    status: 'withdrawn',
    reviewNote: null,
    createdAt: '2026-07-30T06:00:00.000Z',
    reviewedAt: null,
    publishedAt: null,
  },
]

const sessionMessages: ChatMessage[] = [
  { id: 'msg-1', role: 'user', text: '把这份季度数据做成一页汇报。', ts: 1_757_000_000_000 } as ChatMessage,
  {
    id: 'msg-2',
    role: 'assistant',
    text: '先确认口径：按地区汇总、剔除测试订单。我会输出一页 PDF 和一份可编辑的 Markdown。',
    ts: 1_757_000_060_000,
  } as ChatMessage,
  { id: 'msg-3', role: 'system', text: '内部角色，不应出现在公开预览。', ts: 1_757_000_061_000 } as ChatMessage,
]

const sessionAssets: ProjectAsset[] = [
  {
    id: 'asset-1',
    projectId: 'proj-1',
    source: 'output',
    sessionId: 's-1',
    name: 'quarter-brief.md',
    url: null,
    containerPath: '/workspace/output/quarter-brief.md',
    mime: 'text/markdown',
    sizeBytes: 5_320,
    excerpt: null,
    pinned: false,
    createdAt: 1_757_000_100_000,
    updatedAt: 1_757_000_100_000,
  },
  {
    id: 'asset-2',
    projectId: 'proj-1',
    source: 'output',
    sessionId: 's-1',
    name: 'chart-regions.png',
    url: null,
    containerPath: '/workspace/output/chart-regions.png',
    mime: 'image/png',
    sizeBytes: 812_000,
    excerpt: null,
    pinned: false,
    createdAt: 1_757_000_110_000,
    updatedAt: 1_757_000_110_000,
  },
  {
    id: 'asset-3',
    projectId: 'proj-1',
    source: 'upload',
    sessionId: 's-1',
    name: '季度数据.xlsx',
    url: null,
    containerPath: '/workspace/input/季度数据.xlsx',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    sizeBytes: 220_000,
    excerpt: null,
    pinned: false,
    createdAt: 1_756_999_000_000,
    updatedAt: 1_756_999_000_000,
  },
]

const communityApi = {
  listCommunityTutorials: async () => ({ tutorials: communityList, nextCursor: 'cursor-2' }),
  getCommunityTutorial: async (id: string) => (id === 'snap-1' ? snapshotDetail : markdownDetail),
  listMyCommunityTutorials: async () => ({ tutorials: mine, nextCursor: null }),
  listProjectAssets: async () => sessionAssets,
}

// ── 工作区内的 CTA 可用性：镜像 App.tsx 的 tutorialActionContext（未开 Image 2、无麦克风、非组织管理员） ──
const workspaceActionState = (feature: ProductCapability): TutorialActionState =>
  resolveTutorialAction(feature, {
    authenticated: true,
    featureImage2: false,
    microphone: false,
    orgRole: 'member',
  })

// ── 自动操作：挂载后按步骤点按钮 / 输入 / 滚动，模拟用户在面板内导航 ─────────────
// `scroll` 把首个文本命中的标题 / 段落滚到详情区顶部：截图只裁到对话框视口，
// 折叠区、页尾 CTA 这类首屏之外的证据必须先滚进来才拍得到。
// 只滚 main.tutorial-detail 自己，不用 scrollIntoView：后者会连 Dialog.Content 一起滚
// （它被逃出 main 的 sr-only 节点撑出了隐藏溢出，见 docs/audit/tutorials.md TU-23），
// 会把 header / nav 顶出截图。
type Step = {
  click?: string
  type?: { placeholder: string; value: string }
  scroll?: string
  wait?: number
}

function clickByText(label: string): boolean {
  // [role=menuitem]：DropdownMenu 的菜单项是 div，不是 button（TU-03 之后「案例脚本 / 教程工作室」都在菜单里）。
  const nodes = Array.from(document.querySelectorAll<HTMLElement>('button, summary, a[href], [role="menuitem"]'))
  const target = nodes.find((node) => (node.textContent ?? '').replace(/\s+/g, ' ').trim().includes(label))
  if (!target) {
    console.warn('[tutorials-scene] 找不到可点击元素：', label)
    return false
  }
  // Radix DropdownMenu 的触发器在 pointerdown 开启（click 不够）；先发一次 pointerdown 再 click，
  // 对普通按钮无副作用（阶段 B 把「帮助与创作」换成了 DropdownMenu，TU-03）。
  target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }))
  target.click()
  return true
}

function scrollToText(label: string): void {
  const nodes = Array.from(
    document.querySelectorAll<HTMLElement>('h1, h2, h3, h4, p, summary, strong, button'),
  )
  const target = nodes.find((node) => (node.textContent ?? '').replace(/\s+/g, ' ').trim().includes(label))
  const main = document.querySelector<HTMLElement>('main.tutorial-detail')
  if (!target || !main) {
    console.warn('[tutorials-scene] 找不到要滚动到的元素：', label)
    return
  }
  main.scrollTop += target.getBoundingClientRect().top - main.getBoundingClientRect().top - 12
}

function typeByPlaceholder(placeholder: string, value: string): void {
  const input = document.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`)
  if (!input) {
    console.warn('[tutorials-scene] 找不到输入框：', placeholder)
    return
  }
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function AutoAct({ steps, children }: { steps: Step[]; children: ReactNode }) {
  // 步骤只在挂载时执行一次；场景数组是字面量常量，不需要跟随重渲染。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 见上一行
  useEffect(() => {
    let cancelled = false
    const run = async () => {
      for (const step of steps) {
        await new Promise((resolve) => setTimeout(resolve, step.wait ?? 80))
        if (cancelled) return
        if (step.click) clickByText(step.click)
        if (step.type) typeByPlaceholder(step.type.placeholder, step.type.value)
        if (step.scroll) scrollToText(step.scroll)
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [])
  return <>{children}</>
}

// ── 宿主：镜像 App.tsx 对 TutorialCenter 的接线，让面板内导航真正生效 ──────────
function TutorialHost({
  topic = null,
  caseId = null,
  communityId = null,
  authed = false,
  session = null,
  actionState,
}: {
  topic?: ProductFeatureId | null
  caseId?: TutorialCaseId | null
  communityId?: string | null
  authed?: boolean
  session?: { id: string; title: string; projectId: string | null; messages: ChatMessage[] } | null
  actionState?: (feature: ProductCapability) => TutorialActionState
}) {
  const [topicId, setTopicId] = useState<ProductFeatureId | null>(topic)
  const [selectedCase, setSelectedCase] = useState<TutorialCaseId | null>(caseId)
  const [community, setCommunity] = useState<string | null>(communityId)
  return (
    <TutorialCenter
      open
      topicId={topicId}
      caseId={selectedCase}
      communityId={community}
      onTopicChange={(id) => {
        setTopicId(id)
        setSelectedCase(null)
        setCommunity(null)
      }}
      onCaseChange={(id) => {
        setSelectedCase(id)
        setTopicId(null)
        setCommunity(null)
      }}
      onShowCaseGallery={() => {
        setSelectedCase(null)
        setTopicId(null)
        setCommunity(null)
      }}
      onCommunityChange={(id) => {
        setCommunity(id)
        if (id) {
          setTopicId(null)
          setSelectedCase(null)
        }
      }}
      caseActionLabel={authed ? '带着指令去对话' : '登录后试用'}
      onRunCase={() => {}}
      onClose={() => {}}
      actionState={actionState ?? (authed ? workspaceActionState : () => ({ enabled: true, label: '登录后试用' }))}
      onRunAction={() => {}}
      auth={authed ? auth : null}
      onRequireLogin={() => {}}
      activeSessionId={session?.id ?? null}
      sessionMessages={session?.messages ?? []}
      sending={false}
      sessionTitle={session?.title ?? ''}
      sessionProjectId={session?.projectId ?? null}
    />
  )
}

const activeSession = {
  id: 's-1',
  title: '季度汇报一页纸',
  projectId: 'proj-1',
  messages: sessionMessages,
}

const both: Scene['viewports'] = ['desktop', 'mobile']

export const tutorialScenes: Scene[] = [
  // ── 案例展厅（默认视图） ──
  {
    id: 'tutorials-showroom',
    label: '教程中心 · 案例展厅默认视图（精选作品 + 公开数据实作）',
    group: '工作区',
    viewports: both,
    api: {},
    render: () => <TutorialHost />,
  },
  {
    id: 'tutorials-signature-detail',
    label: '教程中心 · 精选作品详情（iframe 加载中态）',
    group: '工作区',
    viewports: both,
    api: {},
    render: () => (
      <AutoAct steps={[{ click: '探索这颗星球', wait: 200 }]}>
        <TutorialHost />
      </AutoAct>
    ),
  },
  {
    id: 'tutorials-showcase-detail',
    label: '教程中心 · 公开数据实作详情（封面兜底 + 下载区）',
    group: '工作区',
    viewports: both,
    api: {},
    render: () => <TutorialHost caseId="research-bike-demand" />,
  },
  {
    id: 'tutorials-showcase-detail-preview',
    label: '教程中心 · 公开数据实作 · 打开交互看板（加载中）',
    group: '工作区',
    viewports: both,
    api: {},
    render: () => (
      <AutoAct steps={[{ click: '打开交互看板', wait: 200 }]}>
        <TutorialHost caseId="research-bike-demand" />
      </AutoAct>
    ),
  },
  // ── 快速上手 ──
  {
    id: 'tutorials-quickstart',
    label: '教程中心 · 快速上手（10 分钟主线）',
    group: '工作区',
    viewports: both,
    api: {},
    render: () => (
      <AutoAct steps={[{ click: '快速上手', wait: 200 }]}>
        <TutorialHost />
      </AutoAct>
    ),
  },
  // ── 功能参考 ──
  {
    id: 'tutorials-feature-detail',
    label: '教程中心 · 功能参考详情（对话入门，含侧栏目录 / 移动端分类与下拉）',
    group: '工作区',
    viewports: both,
    api: {},
    render: () => <TutorialHost topic="chat-basics" authed />,
  },
  {
    id: 'tutorials-feature-cta-disabled',
    label: '教程中心 · 功能参考 · CTA 不可用（组织中心，非管理员；滚到页尾 CTA）',
    group: '工作区',
    viewports: both,
    api: {},
    render: () => (
      <AutoAct steps={[{ scroll: '现在去真实功能里试一遍', wait: 200 }]}>
        <TutorialHost topic="organization" authed />
      </AutoAct>
    ),
  },
  {
    id: 'tutorials-help-menu-open',
    label: '教程中心 · 「帮助与创作」下拉展开态（阶段 B 起为 DropdownMenu：Esc / 外点可关闭）',
    group: '工作区',
    viewports: both,
    api: {},
    render: () => (
      <AutoAct steps={[{ click: '帮助与创作', wait: 200 }]}>
        <TutorialHost />
      </AutoAct>
    ),
  },
  {
    id: 'tutorials-feature-search-hit',
    label: '教程中心 · 功能参考 · 搜索命中（GitHub）',
    group: '工作区',
    viewports: both,
    api: {},
    render: () => (
      <AutoAct steps={[{ type: { placeholder: '搜索功能、场景或关键词', value: 'GitHub' }, wait: 200 }]}>
        <TutorialHost topic="chat-basics" authed />
      </AutoAct>
    ),
  },
  {
    id: 'tutorials-feature-search-empty',
    label: '教程中心 · 功能参考 · 搜索无结果',
    group: '工作区',
    viewports: both,
    api: {},
    render: () => (
      <AutoAct steps={[{ type: { placeholder: '搜索功能、场景或关键词', value: '量子计算' }, wait: 200 }]}>
        <TutorialHost topic="chat-basics" authed />
      </AutoAct>
    ),
  },
  {
    id: 'tutorials-feature-category',
    label: '教程中心 · 功能参考 · 按分类筛选（账户与团队）',
    group: '工作区',
    viewports: both,
    api: {},
    render: () => (
      <AutoAct steps={[{ click: '账户与团队', wait: 200 }]}>
        <TutorialHost topic="chat-basics" authed />
      </AutoAct>
    ),
  },
  // ── 案例脚本（帮助与创作菜单） ──
  {
    id: 'tutorials-case-gallery',
    label: '教程中心 · 案例脚本总览（12 条待采集脚本）',
    group: '工作区',
    viewports: both,
    api: {},
    render: () => (
      <AutoAct steps={[{ click: '帮助与创作', wait: 150 }, { click: '案例脚本', wait: 150 }]}>
        <TutorialHost />
      </AutoAct>
    ),
  },
  {
    id: 'tutorials-case-detail',
    label: '教程中心 · 案例脚本详情（编码 · SWE-bench 修复）',
    group: '工作区',
    viewports: both,
    api: {},
    render: () => <TutorialHost caseId="coding-swe-bench-fix" authed />,
  },
  {
    id: 'tutorials-case-detail-research',
    label: '教程中心 · 案例脚本详情（科研 · 证据图谱，未登录）',
    group: '工作区',
    viewports: both,
    api: {},
    render: () => <TutorialHost caseId="research-evidence-map" />,
  },
  {
    id: 'tutorials-case-detail-artifacts',
    label: '教程中心 · 案例脚本详情 · 滚到「先看成品」示意预览',
    group: '工作区',
    viewports: both,
    api: {},
    render: () => (
      <AutoAct steps={[{ scroll: '先看成品', wait: 200 }]}>
        <TutorialHost caseId="research-evidence-map" authed />
      </AutoAct>
    ),
  },
  {
    id: 'tutorials-case-detail-methods',
    label: '教程中心 · 案例脚本详情 · 展开「案例资料与方法」并滚到该区',
    group: '工作区',
    viewports: both,
    api: {},
    render: () => (
      <AutoAct steps={[{ click: '案例资料与方法', wait: 150 }, { scroll: '案例资料与方法', wait: 150 }]}>
        <TutorialHost caseId="coding-swe-bench-fix" authed />
      </AutoAct>
    ),
  },
  {
    id: 'tutorials-case-detail-replay',
    label: '教程中心 · 案例脚本详情 · 展开后滚到「运行过程回放」（待采集态）',
    group: '工作区',
    viewports: both,
    api: {},
    render: () => (
      <AutoAct steps={[{ click: '案例资料与方法', wait: 150 }, { scroll: '运行过程回放', wait: 150 }]}>
        <TutorialHost caseId="coding-swe-bench-fix" authed />
      </AutoAct>
    ),
  },
  // ── 教程工作室 ──
  {
    id: 'tutorials-studio-catalog',
    label: '教程中心 · 教程工作室目录（3 条 + 加载更多，未登录）',
    group: '工作区',
    viewports: both,
    api: communityApi,
    render: () => (
      <AutoAct steps={[{ click: '帮助与创作', wait: 150 }, { click: '教程工作室', wait: 150 }]}>
        <TutorialHost />
      </AutoAct>
    ),
  },
  {
    id: 'tutorials-studio-empty',
    label: '教程中心 · 教程工作室 · 目录空态',
    group: '工作区',
    viewports: both,
    api: {
      ...communityApi,
      listCommunityTutorials: async () => ({ tutorials: [], nextCursor: null }),
    },
    render: () => (
      <AutoAct steps={[{ click: '帮助与创作', wait: 150 }, { click: '教程工作室', wait: 150 }]}>
        <TutorialHost />
      </AutoAct>
    ),
  },
  {
    id: 'tutorials-studio-error',
    label: '教程中心 · 教程工作室 · 目录加载失败',
    group: '工作区',
    viewports: both,
    api: {
      ...communityApi,
      listCommunityTutorials: async () => {
        throw new Error('upstream 502')
      },
    },
    render: () => (
      <AutoAct steps={[{ click: '帮助与创作', wait: 150 }, { click: '教程工作室', wait: 150 }]}>
        <TutorialHost />
      </AutoAct>
    ),
  },
  {
    id: 'tutorials-studio-detail',
    label: '教程中心 · 教程工作室 · Markdown 教程详情（深链）',
    group: '工作区',
    viewports: both,
    api: communityApi,
    render: () => <TutorialHost communityId="tut-7" />,
  },
  {
    id: 'tutorials-studio-snapshot',
    label: '教程中心 · 教程工作室 · 会话快照详情（轨迹 + 成果）',
    group: '工作区',
    viewports: both,
    api: communityApi,
    render: () => <TutorialHost communityId="snap-1" authed />,
  },
  {
    id: 'tutorials-studio-snapshot-artifacts',
    label: '教程中心 · 教程工作室 · 会话快照 · 滚到「成果」区（字节数原样、内嵌 iframe）',
    group: '工作区',
    viewports: both,
    api: communityApi,
    render: () => (
      <AutoAct steps={[{ scroll: 'root-cause.md', wait: 250 }]}>
        <TutorialHost communityId="snap-1" authed />
      </AutoAct>
    ),
  },
  {
    id: 'tutorials-studio-submit',
    label: '教程中心 · 教程工作室 · 手写教程表单',
    group: '工作区',
    viewports: both,
    api: communityApi,
    render: () => (
      <AutoAct
        steps={[
          { click: '帮助与创作', wait: 100 },
          { click: '教程工作室', wait: 100 },
          { click: '手写教程', wait: 100 },
        ]}
      >
        <TutorialHost authed />
      </AutoAct>
    ),
  },
  {
    id: 'tutorials-studio-mine',
    label: '教程中心 · 教程工作室 · 我的发布（四种状态）',
    group: '工作区',
    viewports: both,
    api: communityApi,
    render: () => (
      <AutoAct
        steps={[
          { click: '帮助与创作', wait: 100 },
          { click: '教程工作室', wait: 100 },
          { click: '我的发布', wait: 100 },
        ]}
      >
        <TutorialHost authed />
      </AutoAct>
    ),
  },
  {
    id: 'tutorials-studio-publish-dialog',
    label: '教程中心 · 教程工作室 · 从当前会话生成（发布对话框）',
    group: '工作区',
    viewports: both,
    api: communityApi,
    render: () => (
      <AutoAct
        steps={[
          { click: '帮助与创作', wait: 100 },
          { click: '教程工作室', wait: 100 },
          { click: '从当前会话生成', wait: 150 },
        ]}
      >
        <TutorialHost authed session={activeSession} />
      </AutoAct>
    ),
  },
  {
    id: 'tutorials-studio-gate-notice',
    label: '教程中心 · 教程工作室 · 会话为空时点「从当前会话生成」',
    group: '工作区',
    viewports: both,
    api: communityApi,
    render: () => (
      <AutoAct
        steps={[
          { click: '帮助与创作', wait: 100 },
          { click: '教程工作室', wait: 100 },
          { click: '从当前会话生成', wait: 100 },
        ]}
      >
        <TutorialHost authed session={{ ...activeSession, messages: [] }} />
      </AutoAct>
    ),
  },
]
