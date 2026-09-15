/**
 * composer 模块(输入区 / 会话头 / 模型 / 目标 / 智能体选择)的视觉审计场景。
 *
 * 文件名不含 manage/market,shoot.mjs 会把它并进 manage 组一起打包(只影响构建接线,
 * 场景归属看 Scene.group)。这里只渲染真实组件,不改业务代码。
 *
 * Composer 的正文与附件是组件内部状态,外部注入不了;正文走 sessionStorage 草稿
 * (useComposerDraft 挂载即读),附件 chip 直接渲染导出的 AttachChip 单看视觉。
 */
import type { GoalStateSnapshot } from '@openclaude/protocol/goalState'
import { AgentGate } from '../../src/components/AgentGate'
import { AgentPicker } from '../../src/components/AgentPicker'
import { AgentScopePicker, AgentScopeSummary } from '../../src/components/AgentScopePicker'
import { ChatHeader } from '../../src/components/ChatHeader'
import { AttachChip, Composer } from '../../src/components/Composer'
import { GoalDialog } from '../../src/components/GoalDialog'
import {
  LONG_CONTEXT_CONFIRM_TITLE,
  LongContextCostWarning,
} from '../../src/components/LongContextCostWarning'
import { MAIN_AGENT } from '../../src/lib/agents'
import { createMemoryAuthSession } from '../../src/lib/authSession'
import { writeDraft } from '../../src/lib/composerDraft'
import type { LockedPublicModel, MarketplaceMyAgent, PublicModel } from '../../src/lib/types'
import type { Scene } from './types'

const auth = createMemoryAuthSession(() => {}, 'preview-token')

const models: PublicModel[] = [
  { id: 'cursor-auto', display_name: 'Cursor Auto', engine: 'cursor', cost_x: 1 },
  { id: 'cursor-opus-5-medium', display_name: 'Opus 5 Medium', engine: 'cursor', cost_x: 7.5 },
  { id: 'cursor-opus-5-high', display_name: 'Opus 5 High', engine: 'cursor', cost_x: 9 },
  { id: 'cursor-composer-2.5', display_name: 'Composer 2.5', engine: 'cursor', cost_x: 1.2 },
  { id: 'gpt-6-astra', display_name: 'GPT-6-Astra', engine: 'codex', cost_x: 4 },
  { id: 'gpt-6-astra-1m', display_name: 'GPT-6-Astra 1M', engine: 'codex', cost_x: 6 },
  { id: 'gpt-5.6-terra', display_name: 'GPT-5.6-Terra', engine: 'codex', cost_x: 3 },
  { id: 'gpt-5.6-terra-1m', display_name: 'GPT-5.6-Terra 1M', engine: 'codex', cost_x: 4.5 },
  {
    id: 'deepseek-v4-flash',
    display_name: 'DeepSeek V4 Flash',
    engine: 'ccb',
    cost_x: 0.3,
    promo_label: '限时半价',
    supported_efforts: ['low', 'medium', 'high'],
  },
  { id: 'glm-5-air', display_name: 'GLM-5 Air', engine: 'ccb', cost_x: 0.5, degraded: true },
]

const lockedModels: LockedPublicModel[] = [
  {
    id: 'cursor-fable-5.1-xhigh',
    display_name: 'Fable 5.1 Extra High',
    min_plan_code: 'lite',
    min_plan_name: '轻享版',
    cost_x: 12,
  },
]

const activeGoal: GoalStateSnapshot = {
  sessionId: 's-preview',
  goalId: 'g-preview',
  objective: '把 v5 个人版输入区的全部交互面审一遍，并给出可落地的修复计划',
  status: 'active',
  tokenBudget: 200_000,
  creditBudget: '50000',
  tokensUsed: 172_400,
  creditsUsed: '43120',
  timeUsedSeconds: 4215,
  stateRevision: 7,
  snapshotRevision: 21,
  createdAt: new Date(Date.now() - 7200_000).toISOString(),
  updatedAt: new Date().toISOString(),
  statusChangedAt: new Date(Date.now() - 7200_000).toISOString(),
}

const LONG_DRAFT = `帮我把这份审计报告整理成可执行的修复计划：\n${'先按模块列出问题，再按严重度排序，最后给出每条问题的改动文件、做法与验证方式。'.repeat(
  26,
)}`

/** AgentScopePicker（技能/连接器「适用智能体」多选）用的已安装智能体列表。 */
const scopeAgents: MarketplaceMyAgent[] = [
  {
    id: 'main',
    slug: 'main',
    name: '全能助手',
    description: '通用全能智能体',
    installed: true,
    isDefault: true,
  },
  {
    id: 'coding-assistant',
    slug: 'coding-assistant',
    name: '编程助手',
    description: '读仓库、定位报错、补测试。',
    avatarEmoji: '🧑‍💻',
    installed: true,
    preset: true,
  },
  {
    id: 'office-assistant',
    slug: 'office-assistant',
    name: '办公助手',
    description: '周报、纪要、汇报大纲。',
    avatarEmoji: '📄',
    installed: true,
    preset: true,
  },
  {
    id: 'legal-advisor-long-name-for-wrapping',
    slug: 'legal-advisor',
    name: '合同合规与法律顾问助手（名字很长）',
    description: '合同审阅与合规问答。',
    avatarEmoji: '⚖️',
    installed: true,
  },
]

function headerProps() {
  return {
    agent: MAIN_AGENT,
    onAgentClick: () => {},
    models,
    lockedModels,
    selectedModelId: 'cursor-opus-5-high',
    onSelectModel: () => {},
    onLockedSelect: () => {},
    contextTier: '300k' as const,
    onSelectContextTier: () => {},
    credits: '128900',
    onOpenBilling: () => {},
    onNew: () => {},
    onOpenMobileNav: () => {},
    onOpenInbox: () => {},
    onOpenFind: () => {},
    onExport: () => {},
    unreadCount: 3,
    sessionUnreadCount: 12,
    projectBreadcrumb: { workName: '个人版审计', chatName: 'composer 模块' },
    onOpenProjectScope: () => {},
  }
}

/** 会话页的真实纵向结构：顶栏 + 空对话区 + 底部输入区。 */
function ChatShell({ children, header }: { children: React.ReactNode; header?: React.ReactNode }) {
  return (
    <div className="flex h-screen flex-col bg-bg text-fg">
      {header}
      <div className="min-h-0 flex-1" />
      <div className="pb-4">{children}</div>
    </div>
  )
}

export const composerScenes: Scene[] = [
  {
    id: 'composer-idle',
    label: '输入区 · 空闲态（顶栏 + 输入框 + 仓库入口）',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: {},
    render: () => {
      writeDraft('preview-idle', '')
      return (
        <ChatShell header={<ChatHeader {...headerProps()} />}>
          <Composer
            draftKey="preview-idle"
            onSend={() => {}}
            onUpload={async () => ({ kind: 'image', url: '/api/media/x' })}
            getVoiceToken={() => 'preview-token'}
            onOpenRepo={() => {}}
            repoSelection={null}
            goal={null}
            onSetGoal={async () => {}}
            onGoalAction={async () => {}}
            lastUserText="上一条消息"
          />
        </ChatShell>
      )
    },
  },
  {
    id: 'composer-loaded',
    label: '输入区 · 长草稿 + 引用 + 目标徽标 + 环境准备条',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: {},
    render: () => {
      writeDraft('preview-loaded', LONG_DRAFT)
      return (
        <ChatShell
          header={
            <ChatHeader
              {...headerProps()}
              teamModeActive
              advisorModeActive
              advisorModelLabel="Opus 5 High"
            />
          }
        >
          <Composer
            draftKey="preview-loaded"
            onSend={() => {}}
            onUpload={async () => ({ kind: 'image', url: '/api/media/x' })}
            getVoiceToken={() => 'preview-token'}
            onOpenRepo={() => {}}
            repoSelection={null}
            environmentPreparing
            goal={activeGoal}
            onSetGoal={async () => {}}
            onGoalAction={async () => {}}
            replyTo={{
              messageId: 'm-1',
              role: 'assistant',
              text: '我已经把输入区的附件、语音、草稿、快捷键与发送态都过了一遍，下面是发现的问题清单。',
            }}
            onCancelReply={() => {}}
          />
        </ChatShell>
      )
    },
  },
  {
    id: 'composer-busy',
    label: '输入区 · 生成中（发送键变停止）与禁用态',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: {},
    render: () => {
      writeDraft(
        'preview-busy',
        '这条消息是在上一轮还在生成时敲进去的，按 Enter 会排队、点按钮却会停止。',
      )
      return (
        <ChatShell>
          <div className="space-y-6 pt-6">
            <Composer
              draftKey="preview-busy"
              busy
              onSend={() => {}}
              onStop={() => {}}
              onUpload={async () => ({ kind: 'image', url: '/api/media/x' })}
              getVoiceToken={() => 'preview-token'}
              onOpenRepo={() => {}}
              goal={activeGoal}
              onSetGoal={async () => {}}
              onGoalAction={async () => {}}
            />
            <Composer
              draftKey="preview-stopping"
              busy
              stopping
              onSend={() => {}}
              onStop={() => {}}
              placeholder="正在停止…"
            />
            <Composer
              draftKey="preview-disabled"
              disabled
              onSend={() => {}}
              placeholder="容器未就绪，输入区禁用"
            />
          </div>
        </ChatShell>
      )
    },
  },
  {
    id: 'composer-attach-chips',
    label: '输入区 · 附件 chip 四态（上传中/成功/失败重试/可编辑）',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: {},
    render: () => (
      <div className="min-h-screen bg-bg p-6 text-fg">
        <div className="mx-auto flex w-full max-w-3xl flex-wrap gap-2 rounded-[26px] border border-border-control bg-surface p-4">
          <AttachChip
            a={{ id: '1', name: '需求稿-v3.pdf', size: 820_000, kind: 'file', status: 'uploading' }}
            onRemove={() => {}}
          />
          <AttachChip
            a={{ id: '2', name: '首屏截图.png', size: 240_000, kind: 'file', status: 'done' }}
            onRemove={() => {}}
          />
          <AttachChip
            a={{
              id: '3',
              name: '一个名字特别长的设计稿文件名称最终版.png',
              size: 3_400_000,
              kind: 'file',
              status: 'error',
              error: '上传失败：网络中断',
            }}
            onRemove={() => {}}
            onRetry={() => {}}
          />
          <AttachChip
            a={{ id: '4', name: '配图.png', size: 120_000, kind: 'image', status: 'done' }}
            onRemove={() => {}}
            onPreview={() => {}}
            onAnnotate={() => {}}
          />
          <AttachChip
            a={{ id: '5', name: '不可编辑图.png', size: 90_000, kind: 'image', status: 'done' }}
            onRemove={() => {}}
            onPreview={() => {}}
            annotateDisabledReason="当前模型不支持图片编辑"
          />
        </div>
      </div>
    ),
  },
  {
    id: 'composer-model-menu',
    label: '模型选择器 · 展开态（家族/锁定/降级/折叠组/思考档/上下文）',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: {},
    render: () => (
      <div className="min-h-screen bg-bg pt-2 text-fg">
        <ChatHeader {...headerProps()} modelPickerOpen onModelPickerOpenChange={() => {}} />
      </div>
    ),
  },
  {
    id: 'composer-goal-dialog',
    label: '会话目标 · 已启用且接近预算',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: {},
    render: () => (
      <div className="min-h-screen bg-bg text-fg">
        <GoalDialog
          open
          onOpenChange={() => {}}
          goal={activeGoal}
          onSet={async () => {}}
          onAction={async () => {}}
        />
      </div>
    ),
  },
  {
    id: 'composer-agent-picker',
    label: '智能体选择 · 协作方式三选一 + 顾问型号',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: {
      listMyAgents: async () => [
        {
          id: 'main',
          slug: 'main',
          name: '全能助手',
          description: '通用全能智能体',
          installed: true,
          isDefault: true,
        },
        {
          id: 'coding-assistant',
          slug: 'coding-assistant',
          name: '编程助手',
          description: '读仓库、定位报错、补测试，交付可运行的改动。',
          avatarEmoji: '🧑‍💻',
          installed: true,
          preset: true,
        },
        {
          id: 'office-assistant',
          slug: 'office-assistant',
          name: '办公助手',
          description: '周报、纪要、汇报大纲，一次成稿。',
          avatarEmoji: '📄',
          installed: true,
          preset: true,
        },
        {
          id: 'crawler-agent',
          slug: 'crawler-agent',
          name: '数据采集助手',
          description: '定时抓取站点并整理成表，需要浏览器插件授权。',
          avatarEmoji: '🕸️',
          installed: true,
          capabilityReadiness: { ready: false, needsAuthorization: ['browser-plugin'] },
        },
      ],
    },
    render: () => (
      <div className="min-h-screen bg-bg text-fg">
        <AgentPicker
          open
          current={MAIN_AGENT}
          auth={auth}
          collabMode="advisor"
          advisorModels={[{ id: 'advisor-opus-5', label: 'Opus 5 顾问', engine: 'cursor' }]}
          advisorModel="advisor-opus-5"
          advisorConsultAllowed
          advisorConsultParents={['ccb']}
          parentEngine="ccb"
          asDefault
          onAsDefaultChange={() => {}}
          onClose={() => {}}
          onPick={() => {}}
          onAddFromMarket={() => {}}
          onCollabModeChange={() => {}}
          onAdvisorModelChange={() => {}}
        />
      </div>
    ),
  },
  {
    id: 'composer-agent-gate',
    label: '对话前置门 · 余额不足',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: {},
    render: () => (
      <div className="h-screen bg-bg text-fg">
        <AgentGate
          phase={{ kind: 'insufficient', shortfall: '12000' }}
          onOpen={() => {}}
          onRetry={() => {}}
          onTopUp={() => {}}
        />
      </div>
    ),
  },
  {
    id: 'composer-agent-gate-phases',
    label: '对话前置门 · 引导开通 / 运行时未就绪 / 出错（带追踪号）',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: {},
    render: () => (
      <div className="min-h-screen bg-bg text-fg [&>div]:min-h-0 [&>div]:py-8">
        <AgentGate
          phase={{ kind: 'unsubscribed' }}
          onOpen={() => {}}
          onRetry={() => {}}
          onTopUp={() => {}}
        />
        <AgentGate
          phase={{ kind: 'runtime-unavailable' }}
          onOpen={() => {}}
          onRetry={() => {}}
          onTopUp={() => {}}
        />
        <AgentGate
          phase={{
            kind: 'error',
            message: '容器开机失败，请稍后重试或联系支持。',
            requestId: 'req_01J8Z1X2Y3K4M5N6P7Q8R9S0T',
          }}
          onOpen={() => {}}
          onRetry={() => {}}
          onTopUp={() => {}}
        />
      </div>
    ),
  },
  {
    id: 'composer-scope-picker',
    label: '适用智能体多选 + 摘要徽章 + 1M 上下文费用提示正文',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: {},
    render: () => (
      <div className="min-h-screen bg-bg p-6 text-fg">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-5">
          <AgentScopePicker
            agents={scopeAgents}
            selectedIds={['main', 'legal-advisor-long-name-for-wrapping', 'ghost-agent-removed']}
            onChange={() => {}}
          />
          <AgentScopePicker
            agents={scopeAgents}
            selectedIds={['main']}
            disabled
            title="适用智能体（只读）"
          />
          <div className="flex flex-wrap items-center gap-3 text-sm text-muted">
            <span>摘要：</span>
            <AgentScopeSummary agentIds={['main', 'coding-assistant']} agents={scopeAgents} />
            <AgentScopeSummary agentIds={[]} agents={scopeAgents} />
          </div>
          <div className="rounded-xl border border-border bg-surface p-4">
            <div className="mb-2 text-base font-semibold text-fg">{LONG_CONTEXT_CONFIRM_TITLE}</div>
            <LongContextCostWarning />
          </div>
        </div>
      </div>
    ),
  },
]
