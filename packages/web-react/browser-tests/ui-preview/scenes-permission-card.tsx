/**
 * permission-card 模块（会话内权限审批卡 `chat/PermissionCard.tsx`）的 UI 视觉预览场景。
 *
 * 直接给真实 MessageList 喂 reducer 已消化过的 ChatMessage[]（不经 ChatSocket），走生产同款链路：
 * 时间线卡由 MessageRenderer 以 renderMode="card" 渲染，弹框由 MessageList 内的 PermissionPromptHost 托管。
 * 覆盖审计关心的未决态全部分支：待决（卡 + 自动弹框）/ 关掉弹框后的待答入口 / 批准中 / 各种已结清 /
 * 已过期（历史只读 + 活提问 fail-safe）/ 多卡并发 / AskUserQuestion 与 ExitPlanMode 弹框 / 截断加载 / 临期倒计时。
 *
 * 弹窗协调器有跨挂载的进程内记忆（已展示 / 已关掉），每个 render() 开头都 reset 并给活提问一个新 requestId，
 * 否则第二个视口 / 主题再挂载时「已展示过」→ 不再自动弹。
 */
import { type ReactNode, useEffect } from 'react'
import { MessageList } from '../../src/components/MessageRenderer'
import { resetPermissionAutoOpenMemory } from '../../src/components/chat/PermissionCard'
import {
  type ResponseRatingCtx,
  ResponseRatingProvider,
} from '../../src/components/chat/ResponseRating'
import type { CardCallbacks } from '../../src/components/chat/cards'
import type { ChatMessage } from '../../src/lib/chat/model'
import { dismissPermissionUi } from '../../src/lib/chat/permissionPopupCoordinator'
import type { Scene } from './types'

// ── 假数据工厂 ────────────────────────────────────────────────────────────────
const NOW = Date.now()
let seq = 0
function resetClock(): void {
  seq = 0
}
function msg(partial: Partial<ChatMessage> & Pick<ChatMessage, 'role'>): ChatMessage {
  seq += 1
  return {
    id: partial.id ?? `m-${seq}`,
    text: '',
    ts: NOW - Math.max(1, 30 - seq) * 60_000,
    _source: 'server',
    ...partial,
  }
}

const noop = () => {}
const cb: CardCallbacks = {
  onRegenerate: noop,
  onContinue: noop,
  onTopUp: noop,
  onStartNewSession: noop,
  onFeedback: noop,
  onRetrySend: noop,
  onQuote: noop,
  onEditResend: noop,
  subscriptionPaid: false,
}
const ratingCtx: ResponseRatingCtx = {
  ratings: new Map(),
  submit: noop,
  sessionId: 'preview-session',
}

let liveSeq = 0
/** 每次 render() 都换新 id：协调器按 requestId 记「已展示 / 已关掉」，复用会让第二张图不弹。 */
function liveId(tag: string): string {
  liveSeq += 1
  return `req-${tag}-${Date.now()}-${liveSeq}`
}

const BASH_INPUT = {
  command: "sed -i 's/Install/安装/' README.md && git diff --stat",
  description: '把 README 安装小节改成中文并查看差异',
}
const EDIT_INPUT = {
  file_path: 'packages/web-react/src/components/chat/PermissionCard.tsx',
  old_string: 'statusText = "等待审批…"',
  new_string: 'statusText = "等待你的审批…"',
}
const MCP_INPUT = {
  url: 'https://example.com/pricing',
  action: 'navigate',
}

const AQ_SINGLE = {
  questions: [
    {
      question: '贡献指南里的 PR 模板要保留英文原文对照吗？',
      header: 'PR 模板',
      options: [
        { label: '保留英文对照', description: '中英双语，便于海外贡献者' },
        { label: '只保留中文', description: '更简洁，面向国内团队' },
      ],
    },
  ],
}
const AQ_MULTI = {
  questions: [
    {
      question: '这次要一并处理哪些文档？',
      header: '范围',
      multiSelect: true,
      options: [
        { label: 'README', description: '安装与快速开始' },
        { label: 'CONTRIBUTING', description: '贡献流程与 PR 模板' },
        { label: 'CHANGELOG', description: '只翻标题行' },
        { label: 'docs/', description: '全部指南页' },
      ],
    },
    {
      question: '术语「Install」统一译为？',
      header: '术语',
      options: [{ label: '安装' }, { label: '部署' }],
    },
    {
      question: '代码块里的英文注释怎么处理？',
      header: '注释',
      options: [
        { label: '保留原文', preview: '# Install dependencies\nnpm ci' },
        { label: '译为中文', preview: '# 安装依赖\nnpm ci' },
      ],
    },
  ],
}

const PLAN_MD = `## 目标

把 \`docs/\` 下 12 篇英文指南翻成中文，并保持代码块与链接不变。

## 步骤

1. 先跑 \`scripts/list-docs.ts\` 列出全部待翻文件，按体量排序；
2. 逐篇翻译正文，术语表见 \`docs/GLOSSARY.md\`（**Install → 安装**，**Deploy → 部署**）；
3. 每篇翻完跑一次 \`npm run docs:lint\`，链接与锚点必须全部通过；
4. 最后更新 \`docs/README.md\` 的目录与语言切换入口。

## 风险

- 图片里的英文文字不在本次范围；
- 代码注释按你刚确认的口径：**保留原文**。

> 预计改动 12 个文件、约 3,800 行，全部为 Markdown。`

// ── 时间线工厂 ────────────────────────────────────────────────────────────────

/** 开场对话：让权限卡出现在真实上下文里，而不是孤零零一张。 */
function prelude(): ChatMessage[] {
  return [
    msg({ id: 'u-1', role: 'user', text: '把 README 里的安装步骤改成中文。', status: 'replied' }),
    msg({
      id: 'a-1',
      role: 'assistant',
      text: '好的，我先看一下当前 README 的安装小节，然后用 sed 批量替换。',
      _clientMessageId: 'u-1',
    }),
  ]
}

function pendingGeneric(requestId: string, over: Partial<ChatMessage> = {}): ChatMessage {
  return msg({
    id: `perm-${requestId}`,
    role: 'permission',
    text: 'Bash',
    toolName: 'Bash',
    requestId,
    ts: NOW,
    inputJson: BASH_INPUT,
    inputPreview: JSON.stringify(BASH_INPUT),
    _source: 'local',
    ...over,
  })
}

/** 待决：活提问，自动弹出普通审批框（桌面居中 / 窄屏贴底）。 */
function livePendingTimeline(requestId: string): ChatMessage[] {
  resetClock()
  return [...prelude(), pendingGeneric(requestId)]
}

/** 关掉弹框后：时间线卡 + Host 的「智能体在等你确认」待答入口。 */
function dismissedTimeline(requestId: string): ChatMessage[] {
  resetClock()
  return [...prelude(), pendingGeneric(requestId)]
}

/** 批准中：本地已点允许、等 Master 回执（_controlPending）。 */
function approvingTimeline(): ChatMessage[] {
  resetClock()
  return [
    ...prelude(),
    pendingGeneric('req-approving', { _controlPending: true }),
  ]
}

/** 已结清的各种形态：允许 / 拒绝 / 超时 / 断连 / 崩溃 / 本轮停止 / 问答已提交 / 问答跳过 / 计划已确认。 */
function settledTimeline(): ChatMessage[] {
  resetClock()
  const base = prelude()
  return [
    ...base,
    msg({
      id: 'perm-allow',
      role: 'permission',
      text: 'Bash',
      toolName: 'Bash',
      requestId: 'req-allow',
      inputJson: BASH_INPUT,
      _resolved: true,
      _behavior: 'allow',
    }),
    msg({
      id: 'perm-deny',
      role: 'permission',
      text: 'Edit',
      toolName: 'Edit',
      requestId: 'req-deny',
      inputJson: EDIT_INPUT,
      _resolved: true,
      _behavior: 'deny',
    }),
    msg({
      id: 'perm-timeout',
      role: 'permission',
      text: 'Bash',
      toolName: 'Bash',
      requestId: 'req-timeout',
      inputJson: { command: 'rm -rf dist && npm run build' },
      _resolved: true,
      _behavior: 'deny',
      _settledReason: 'timeout',
    }),
    msg({
      id: 'perm-disconnect',
      role: 'permission',
      text: 'mcp__browser__navigate',
      toolName: 'mcp__browser__navigate',
      requestId: 'req-disconnect',
      inputJson: MCP_INPUT,
      _resolved: true,
      _behavior: 'deny',
      _settledReason: 'disconnect',
    }),
    msg({
      id: 'perm-crashed',
      role: 'permission',
      text: 'Bash',
      toolName: 'Bash',
      requestId: 'req-crashed',
      inputJson: { command: 'npm test' },
      _resolved: true,
      _behavior: 'deny',
      _settledReason: 'crashed',
    }),
    msg({
      id: 'perm-user-stop',
      role: 'permission',
      text: 'AskUserQuestion',
      toolName: 'AskUserQuestion',
      requestId: 'req-user-stop',
      inputJson: AQ_SINGLE,
      _resolved: true,
      _behavior: 'deny',
      _settledReason: 'user_stop',
    }),
    msg({
      id: 'perm-aq-done',
      role: 'permission',
      text: 'AskUserQuestion',
      toolName: 'AskUserQuestion',
      requestId: 'req-aq-done',
      inputJson: AQ_MULTI,
      _resolved: true,
      _behavior: 'allow',
      _answers: {
        '这次要一并处理哪些文档？': 'README, CONTRIBUTING',
        '术语「Install」统一译为？': '安装',
        '代码块里的英文注释怎么处理？': '保留原文',
      },
    }),
    msg({
      id: 'perm-aq-skip',
      role: 'permission',
      text: 'AskUserQuestion',
      toolName: 'AskUserQuestion',
      requestId: 'req-aq-skip',
      inputJson: AQ_SINGLE,
      _resolved: true,
      _behavior: 'deny',
    }),
    msg({
      id: 'perm-plan-done',
      role: 'permission',
      text: 'ExitPlanMode',
      toolName: 'ExitPlanMode',
      requestId: 'req-plan-done',
      inputJson: { plan: PLAN_MD, planFilePath: '.claude/plans/translate-docs.md' },
      _resolved: true,
      _behavior: 'allow',
    }),
    msg({
      id: 'perm-accepted',
      role: 'permission',
      text: 'Bash',
      toolName: 'Bash',
      requestId: 'req-accepted',
      inputJson: { command: 'npm run docs:lint' },
      _resolved: true,
      _settledReason: 'accepted',
    }),
    msg({ id: 'a-2', role: 'assistant', text: '以上审批已全部处理完，继续执行。', _clientMessageId: 'u-1' }),
  ]
}

/** 已过期：历史会话里的孤儿卡（服务端早已 force-deny）+ 带绝对到期时间的问答卡。 */
function expiredTimeline(): ChatMessage[] {
  resetClock()
  return [
    ...prelude(),
    pendingGeneric('req-expired-ttl', { ts: NOW - 45 * 60_000 }),
    msg({
      id: 'perm-expired-abs',
      role: 'permission',
      text: 'AskUserQuestion',
      toolName: 'AskUserQuestion',
      requestId: 'req-expired-abs',
      ts: NOW - 5 * 60_000,
      _askUserExpiresAt: NOW - 60_000,
      inputJson: AQ_SINGLE,
    }),
    msg({ id: 'u-2', role: 'user', text: '刚才那两条不用管了，继续。', status: 'replied' }),
    msg({ id: 'a-3', role: 'assistant', text: '收到，跳过这两项。', _clientMessageId: 'u-2' }),
  ]
}

/** 活提问的过期 fail-safe（PC-03）：本机时钟看已过 TTL，但轮次仍在跑 —— 卡头「已过期」+ 说明行 + 仍可点的「审批」。 */
function expiredLiveTimeline(requestId: string): ChatMessage[] {
  resetClock()
  return [...prelude(), pendingGeneric(requestId, { ts: NOW - 45 * 60_000 })]
}

/** 多卡并发：同一活跃轮里三张未决卡（Bash / 问答 / 计划），Host 只开一个弹框。 */
function multiPendingTimeline(ids: { bash: string; aq: string; plan: string }): ChatMessage[] {
  resetClock()
  return [
    ...prelude(),
    pendingGeneric(ids.bash),
    msg({
      id: `perm-${ids.aq}`,
      role: 'permission',
      text: 'AskUserQuestion',
      toolName: 'AskUserQuestion',
      requestId: ids.aq,
      ts: NOW,
      _askUserExpiresAt: NOW + 20 * 60_000,
      _source: 'local',
      inputJson: AQ_SINGLE,
    }),
    msg({
      id: `perm-${ids.plan}`,
      role: 'permission',
      text: 'ExitPlanMode',
      toolName: 'ExitPlanMode',
      requestId: ids.plan,
      ts: NOW,
      _source: 'local',
      inputJson: { plan: PLAN_MD, planFilePath: '.claude/plans/translate-docs.md' },
    }),
  ]
}

function askQuestionTimeline(requestId: string, input: unknown): ChatMessage[] {
  resetClock()
  return [
    ...prelude(),
    msg({
      id: `perm-${requestId}`,
      role: 'permission',
      text: 'AskUserQuestion',
      toolName: 'AskUserQuestion',
      requestId,
      ts: NOW,
      _askUserExpiresAt: NOW + 20 * 60_000,
      _source: 'local',
      inputJson: input,
    }),
  ]
}

function exitPlanTimeline(requestId: string): ChatMessage[] {
  resetClock()
  return [
    ...prelude(),
    msg({
      id: `perm-${requestId}`,
      role: 'permission',
      text: 'ExitPlanMode',
      toolName: 'ExitPlanMode',
      requestId,
      ts: NOW,
      _source: 'local',
      inputJson: { plan: PLAN_MD, planFilePath: '.claude/plans/translate-docs.md' },
    }),
  ]
}

/** 截断加载：inputJson 被服务端截断，取回完整参数前不能作答。 */
function truncatedTimeline(): ChatMessage[] {
  resetClock()
  return [
    ...prelude(),
    msg({
      id: 'perm-truncated',
      role: 'permission',
      text: 'AskUserQuestion',
      toolName: 'AskUserQuestion',
      requestId: 'req-truncated',
      ts: NOW,
      _source: 'local',
      _inputTruncated: true,
      inputJson: { questions: [{ question: '（题干被截断，正在取回完整问题）', options: [] }] },
    }),
  ]
}

/** 与 PermissionCard.PENDING_PERMISSION_TTL_MS 同值（30 分钟）；这里只用来造「剩 90 秒」的 ts。 */
const PENDING_TTL_MS = 30 * 60_000

/** 临期：剩余不足 2 分钟，倒计时转 warning 色。 */
function urgentTimeline(): ChatMessage[] {
  resetClock()
  return [
    ...prelude(),
    pendingGeneric('req-urgent', { ts: NOW - PENDING_TTL_MS + 90_000 }),
  ]
}

// ── 页面壳 ────────────────────────────────────────────────────────────────────

/** 让页面按内容自然长高（shoot.mjs 拍整页），并撤掉 #root 的定位约束。 */
function Page({ children }: { children: ReactNode }) {
  useEffect(() => {
    const html = document.documentElement
    const body = document.body
    const root = document.getElementById('root')
    const prev = [html.style.height, body.style.height, body.style.overflow]
    const prevRoot = root ? [root.style.position, root.style.height, root.style.overflow] : null
    html.style.height = 'auto'
    body.style.height = 'auto'
    body.style.overflow = 'visible'
    if (root) {
      root.style.position = 'static'
      root.style.height = 'auto'
      root.style.overflow = 'visible'
    }
    return () => {
      ;[html.style.height, body.style.height, body.style.overflow] = prev
      if (root && prevRoot) [root.style.position, root.style.height, root.style.overflow] = prevRoot
    }
  }, [])
  return (
    <div className="min-h-screen bg-bg text-fg">
      {/* 生产里待答入口挂在 App 顶栏下的插槽；这里给同名插槽，让 Host 的 bar 落到时间线上方而不是行内。 */}
      <div id="pending-approval-bar-slot" className="sticky top-0 z-30 px-3 pt-2" />
      <div className="mx-auto w-full max-w-3xl px-3 pb-6">{children}</div>
    </div>
  )
}

function Timeline({ messages, sending }: { messages: ChatMessage[]; sending: boolean }) {
  return (
    <Page>
      <ResponseRatingProvider value={ratingCtx}>
        <MessageList
          messages={messages}
          sending={sending}
          cb={cb}
          onRespondPermission={noop}
          sessionId="preview-session"
        />
      </ResponseRatingProvider>
    </Page>
  )
}

// ── 场景 ──────────────────────────────────────────────────────────────────────
const VIEWPORTS: Scene['viewports'] = ['desktop', 'mobile']

export const permissionCardScenes: Scene[] = [
  {
    id: 'permission-card-pending-modal',
    label: '权限卡 · 待决活提问自动弹出普通审批框（Bash）',
    group: '工作区',
    viewports: VIEWPORTS,
    api: {},
    render: () => {
      resetPermissionAutoOpenMemory()
      return <Timeline messages={livePendingTimeline(liveId('bash'))} sending />
    },
  },
  {
    id: 'permission-card-pending-dismissed',
    label: '权限卡 · 关掉弹框后：时间线卡（审批 / 拒绝 + 倒计时）+ 顶部待答入口',
    group: '工作区',
    viewports: VIEWPORTS,
    api: {},
    render: () => {
      resetPermissionAutoOpenMemory()
      const id = liveId('dismissed')
      dismissPermissionUi(id)
      return <Timeline messages={dismissedTimeline(id)} sending />
    },
  },
  {
    id: 'permission-card-approving',
    label: '权限卡 · 批准中（本地已点允许，等 Master 回执）',
    group: '工作区',
    viewports: VIEWPORTS,
    api: {},
    render: () => {
      resetPermissionAutoOpenMemory()
      return <Timeline messages={approvingTimeline()} sending />
    },
  },
  {
    id: 'permission-card-settled',
    label: '权限卡 · 已结清各形态（允许 / 拒绝 / 超时 / 断连 / 崩溃 / 本轮停止 / 问答已提交 / 跳过 / 计划已确认 / 已受理）',
    group: '工作区',
    viewports: VIEWPORTS,
    api: {},
    render: () => {
      resetPermissionAutoOpenMemory()
      return <Timeline messages={settledTimeline()} sending={false} />
    },
  },
  {
    id: 'permission-card-expired',
    label: '权限卡 · 历史会话里的过期卡（TTL 孤儿 + 绝对到期）',
    group: '工作区',
    viewports: VIEWPORTS,
    api: {},
    render: () => {
      resetPermissionAutoOpenMemory()
      return <Timeline messages={expiredTimeline()} sending={false} />
    },
  },
  {
    id: 'permission-card-expired-live',
    label: '权限卡 · 活提问按本机时钟已过期（fail-safe：说明行 + 仍可审批，不自动弹）',
    group: '工作区',
    viewports: VIEWPORTS,
    api: {},
    render: () => {
      resetPermissionAutoOpenMemory()
      return <Timeline messages={expiredLiveTimeline(liveId('exp-live'))} sending />
    },
  },
  {
    id: 'permission-card-multi-pending-modal',
    label: '权限卡 · 三张未决卡并发：Host 只开第一张的弹框',
    group: '工作区',
    viewports: VIEWPORTS,
    api: {},
    render: () => {
      resetPermissionAutoOpenMemory()
      return (
        <Timeline
          messages={multiPendingTimeline({ bash: liveId('mb'), aq: liveId('maq'), plan: liveId('mplan') })}
          sending
        />
      )
    },
  },
  {
    id: 'permission-card-multi-pending-cards',
    label: '权限卡 · 三张未决卡并发（全部关掉弹框后）：时间线三张卡 + 待答入口',
    group: '工作区',
    viewports: VIEWPORTS,
    api: {},
    render: () => {
      resetPermissionAutoOpenMemory()
      const ids = { bash: liveId('cb'), aq: liveId('caq'), plan: liveId('cplan') }
      dismissPermissionUi(ids.bash)
      dismissPermissionUi(ids.aq)
      dismissPermissionUi(ids.plan)
      return <Timeline messages={multiPendingTimeline(ids)} sending />
    },
  },
  {
    id: 'permission-card-ask-single',
    label: '权限卡 · AskUserQuestion 单选 + 其他（自行输入）',
    group: '工作区',
    viewports: VIEWPORTS,
    api: {},
    render: () => {
      resetPermissionAutoOpenMemory()
      return <Timeline messages={askQuestionTimeline(liveId('aq1'), AQ_SINGLE)} sending />
    },
  },
  {
    id: 'permission-card-ask-multi',
    label: '权限卡 · AskUserQuestion 三题：多选 / 单选 / 带预览',
    group: '工作区',
    viewports: VIEWPORTS,
    api: {},
    render: () => {
      resetPermissionAutoOpenMemory()
      return <Timeline messages={askQuestionTimeline(liveId('aq3'), AQ_MULTI)} sending />
    },
  },
  {
    id: 'permission-card-exit-plan',
    label: '权限卡 · ExitPlanMode 计划确认框（长 Markdown 计划书）',
    group: '工作区',
    viewports: VIEWPORTS,
    api: {},
    render: () => {
      resetPermissionAutoOpenMemory()
      return <Timeline messages={exitPlanTimeline(liveId('plan'))} sending />
    },
  },
  {
    id: 'permission-card-input-loading',
    label: '权限卡 · 题干被截断，正在取回完整问题（不能提交）',
    group: '工作区',
    viewports: VIEWPORTS,
    api: {},
    render: () => {
      resetPermissionAutoOpenMemory()
      return <Timeline messages={truncatedTimeline()} sending />
    },
  },
  {
    id: 'permission-card-urgent',
    label: '权限卡 · 临期倒计时（剩余不足 2 分钟，warning 色）',
    group: '工作区',
    viewports: VIEWPORTS,
    api: {},
    render: () => {
      resetPermissionAutoOpenMemory()
      // 关掉弹框只为让时间线卡露出来；倒计时在卡头。
      dismissPermissionUi('req-urgent')
      return <Timeline messages={urgentTimeline()} sending />
    },
  },
]
