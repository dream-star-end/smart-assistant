/**
 * 「知识星球自动回复」面板（settings/KnowledgePlanetAutomationPanel）的视觉预览场景
 * （2026-09 kp-automation 审计 · t-838 / G-3）。
 *
 * 面板在生产里从「管理中心 → 插件账号 Tab → 账号行」外提到一个贴底 Sheet（ConnectorsTab
 * 的 automationAccount 抽屉）；这里按同一份壳（标题 + 账号 + 关闭 + 滚动区）把面板原样包起来，
 * 只在 api 边界打桩，不动 ConnectorsTab。二级状态（同意弹层 / 新建 / 编辑 / 星球选择器 /
 * 校验 / 删除确认 / 展开运行记录）靠挂载后按序模拟点击到达。
 */
import { X } from 'lucide-react'
import { type ReactNode, useEffect } from 'react'

import { KnowledgePlanetAutomationPanel } from '../../src/components/settings/KnowledgePlanetAutomationPanel'
import { IconButton, Sheet } from '../../src/components/ui'
import { createMemoryAuthSession } from '../../src/lib/authSession'
import type {
  KnowledgePlanetAutomationGroup,
  KnowledgePlanetAutomationRule,
  KnowledgePlanetAutomationRun,
  KnowledgePlanetAutomationView,
  RuntimePluginAccount,
} from '../../src/lib/connectors'
import { ApiError } from './api-stub'
import type { ApiMockTable, Scene } from './types'

// ── 通用工具 ────────────────────────────────────────────────────────────────

const auth = createMemoryAuthSession(() => {}, 'preview-token')

function ok<T>(value: T): (...args: unknown[]) => Promise<T> {
  return async () => structuredClone(value)
}
function pending(): (...args: unknown[]) => Promise<never> {
  return () => new Promise<never>(() => {})
}
const fail = (status: number, message: string, code?: string) => () =>
  Promise.reject(new ApiError({ status, message, code, requestId: 'req_kp_audit_5e21c0' }))

/** 挂载后按顺序模拟点击（selector 或按钮 / summary 文案），把静态预览台推进到二级状态。 */
type ClickStep = { selector?: string; text?: string; delay?: number }

function findClickTarget(step: ClickStep): HTMLElement | null {
  if (step.selector) return document.querySelector<HTMLElement>(step.selector)
  if (step.text) {
    const candidates = [
      ...document.querySelectorAll<HTMLElement>('button,[role="switch"],summary,label'),
    ]
    return (
      candidates.find((el) => el.textContent?.trim() === step.text) ??
      candidates.find((el) => el.textContent?.includes(step.text ?? '')) ??
      null
    )
  }
  return null
}

function AutoClick({ steps, children }: { steps: ClickStep[]; children: ReactNode }) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: 步骤表是场景常量，只在挂载时跑一次
  useEffect(() => {
    let cancelled = false
    const timers: number[] = []
    let at = 0
    for (const step of steps) {
      at += step.delay ?? 260
      const scheduled = at
      const poll = (round: number) => {
        if (cancelled) return
        const target = findClickTarget(step)
        if (target) {
          target.click()
          return
        }
        if (round < 60) timers.push(window.setTimeout(() => poll(round + 1), 50))
        else console.warn('[kp-automation-scene] 点击目标未找到', step)
      }
      timers.push(window.setTimeout(() => poll(0), scheduled))
    }
    return () => {
      cancelled = true
      for (const t of timers) window.clearTimeout(t)
    }
  }, [])
  return <>{children}</>
}

// ── 假数据 ──────────────────────────────────────────────────────────────────

const DISCLAIMER =
  '开启后，AI 会以你的知识星球账号身份、在你不在场时自动生成并发布带「AI 回复」标识的文字评论。' +
  '内容由模型生成，可能出错；每条回复都会消耗你的模型额度。由此产生的社区争议、账号风控与费用由账号持有人自行承担，平台仅提供工具。' +
  '你可以随时关闭本开关；已进入发送阶段的回复无法撤回。'

const WRITE_CONTROL: NonNullable<RuntimePluginAccount['writeControl']> = {
  available: true,
  enabled: true,
  disclaimerVersion: 3,
  acceptedVersion: 3,
  acceptedAt: '2026-08-20T02:10:00.000Z',
  disclaimerText: '手动写入免责声明（略）。',
}

const ACCOUNT: RuntimePluginAccount = {
  id: 'acc_kp_7f21',
  provider: 'knowledge-planet',
  pluginType: 'managed-browser',
  displayName: '星球主理人 · 小林',
  accountHint: '微信 wx_****5188',
  status: 'active',
  actions: [
    { id: 'listTopics', description: '读取主题列表', readOnly: true },
    { id: 'createComment', description: '发布评论', readOnly: false },
  ],
  versionId: 'ver_kp_plugin_140',
  executable: true,
  writeControl: WRITE_CONTROL,
}

/** 写入能力还没开：面板顶部要出「请先开启写入能力」的提示，总开关不可点。 */
const ACCOUNT_NO_WRITE: RuntimePluginAccount = {
  ...ACCOUNT,
  writeControl: { ...WRITE_CONTROL, enabled: false, acceptedVersion: null, acceptedAt: null },
}

const GROUPS: KnowledgePlanetAutomationGroup[] = [
  { id: '15528844121234', name: 'AI 产品经理成长营', memberCount: 1284 },
  { id: '28815524488271', name: '独立开发者出海圈', memberCount: 466 },
  { id: '48815521144282', name: '知识星球运营实战（付费）', memberCount: 3120 },
  { id: '51122448855183', name: '周报写作陪跑', memberCount: 98 },
  { id: '88815522211184', name: '数据分析师进阶', memberCount: null },
  { id: '92211558844185', name: '投研笔记 · 内部', memberCount: 37 },
]

const RULES: KnowledgePlanetAutomationRule[] = [
  {
    id: 'rule_01',
    groupId: '15528844121234',
    name: '产品经理营 · 新提问自动答疑',
    instructions:
      '只回答与产品方法论、需求分析、PRD 写作直接相关的提问；语气专业、克制，先给结论再给两条依据；涉及具体公司内部数据、薪资、法律问题一律跳过。',
    triggerKind: 'new_question',
    enabled: true,
    dailyLimit: 5,
    cooldownMinutes: 15,
    maxReplyChars: 600,
    consecutiveFailures: 0,
    pausedReason: null,
    lastCursorAt: '2026-09-16T12:40:00.000Z',
    nextRunAt: '2026-09-16T13:10:00.000Z',
    createdAt: '2026-08-21T03:00:00.000Z',
    updatedAt: '2026-09-10T08:12:00.000Z',
  },
  {
    id: 'rule_02',
    groupId: '28815524488271',
    name: '出海圈 · 新主题欢迎与补充资料',
    instructions: '对新发布的主题给出一条补充资料或延伸阅读；不评价作者观点。',
    triggerKind: 'new_topic',
    enabled: false,
    dailyLimit: 3,
    cooldownMinutes: 60,
    maxReplyChars: 400,
    consecutiveFailures: 0,
    pausedReason: null,
    lastCursorAt: '2026-09-15T22:00:00.000Z',
    nextRunAt: '2026-09-16T14:00:00.000Z',
    createdAt: '2026-08-25T06:30:00.000Z',
    updatedAt: '2026-09-12T01:00:00.000Z',
  },
  {
    id: 'rule_03',
    groupId: '48815521144282',
    name: '运营实战 · 常见问题',
    instructions: '按置顶 FAQ 回答重复问题；非 FAQ 范围不回复。',
    triggerKind: 'new_question',
    enabled: true,
    dailyLimit: 8,
    cooldownMinutes: 30,
    maxReplyChars: 800,
    consecutiveFailures: 3,
    pausedReason: 'CURSOR_NOT_FOUND',
    lastCursorAt: '2026-09-14T09:00:00.000Z',
    nextRunAt: '2026-09-16T15:00:00.000Z',
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-14T09:05:00.000Z',
  },
]

const RUNS: KnowledgePlanetAutomationRun[] = [
  {
    id: 'run_11',
    ruleId: 'rule_01',
    sourceTopicId: '5885212288411',
    status: 'succeeded',
    reasonCode: null,
    upstreamCommentId: 'cmt_9911',
    createdAt: '2026-09-16T12:31:00.000Z',
    finishedAt: '2026-09-16T12:31:40.000Z',
  },
  {
    id: 'run_10',
    ruleId: 'rule_01',
    sourceTopicId: '5885212288390',
    status: 'skipped',
    reasonCode: 'MODEL_SKIPPED',
    upstreamCommentId: null,
    createdAt: '2026-09-16T11:02:00.000Z',
    finishedAt: '2026-09-16T11:02:12.000Z',
  },
  {
    id: 'run_09',
    ruleId: 'rule_03',
    sourceTopicId: '5885212288102',
    status: 'failed',
    reasonCode: 'CURSOR_NOT_FOUND',
    upstreamCommentId: null,
    createdAt: '2026-09-14T09:00:00.000Z',
    finishedAt: '2026-09-14T09:00:05.000Z',
  },
  {
    id: 'run_08',
    ruleId: 'rule_01',
    sourceTopicId: '5885212287944',
    status: 'unknown',
    reasonCode: 'STALE_DISPATCH',
    upstreamCommentId: null,
    createdAt: '2026-09-13T15:20:00.000Z',
    finishedAt: null,
  },
  {
    id: 'run_07',
    ruleId: 'rule_01',
    sourceTopicId: '5885212287801',
    status: 'skipped',
    reasonCode: 'DAILY_LIMIT',
    upstreamCommentId: null,
    createdAt: '2026-09-13T12:00:00.000Z',
    finishedAt: '2026-09-13T12:00:01.000Z',
  },
  {
    id: 'run_06',
    ruleId: 'rule_01',
    sourceTopicId: '5885212287655',
    status: 'generating',
    reasonCode: null,
    upstreamCommentId: null,
    createdAt: '2026-09-16T12:58:00.000Z',
    finishedAt: null,
  },
]

function view(over: Partial<KnowledgePlanetAutomationView['control']> = {}, rules = RULES, runs = RUNS) {
  const value: KnowledgePlanetAutomationView = {
    control: {
      available: true,
      enabled: true,
      disclaimerVersion: 2,
      acceptedVersion: 2,
      acceptedAt: '2026-08-21T02:55:00.000Z',
      disclaimerText: DISCLAIMER,
      accountDailyLimit: 10,
      pausedReason: null,
      ...over,
    },
    rules,
    recentRuns: runs,
  }
  return value
}

const writeApi: ApiMockTable = {
  setKnowledgePlanetAutomation: ok(view().control),
  createKnowledgePlanetAutomationRulesBatch: ok(RULES.slice(0, 1)),
  patchKnowledgePlanetAutomationRule: ok(RULES[0]),
  deleteKnowledgePlanetAutomationRule: ok(undefined),
}

const panelApi = (
  current: KnowledgePlanetAutomationView | null,
  overrides: ApiMockTable = {},
): ApiMockTable => ({
  ...writeApi,
  getKnowledgePlanetAutomation: current ? ok(current) : pending(),
  listKnowledgePlanetAutomationGroups: ok(GROUPS),
  ...overrides,
})

// ── 渲染壳：照 ConnectorsTab 的 automationAccount 贴底抽屉 ────────────────────

function AutomationSheet({ account = ACCOUNT }: { account?: RuntimePluginAccount }) {
  return (
    <Sheet open onOpenChange={() => {}} side="bottom" srTitle="知识星球自动回复设置">
      <div className="flex items-start justify-between gap-3 px-4 pb-2 pt-3">
        <div className="min-w-0">
          <h3 className="text-title font-semibold text-fg">知识星球自动回复设置</h3>
          <p className="mt-0.5 truncate text-caption text-muted">账号：{account.displayName}</p>
        </div>
        <IconButton aria-label="关闭自动回复设置" size="sm">
          <X size={16} />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        <KnowledgePlanetAutomationPanel auth={auth} account={account} />
      </div>
    </Sheet>
  )
}

/**
 * 弹层场景不套 Sheet：shoot.mjs 把截图 clip 到 DOM 里**第一个** [role=dialog]，而贴底 Sheet 的
 * 高度按内容自适应（桌面端只有三百多像素、贴在视口底部），居中的 Modal 大半落在 clip 之外。
 * 弹层场景直接把面板铺在页面里，让 Modal 成为唯一的 dialog，截到的就是完整弹层。
 */
function AutomationPlain({ account = ACCOUNT }: { account?: RuntimePluginAccount }) {
  return (
    <div className="mx-auto max-w-3xl px-4 py-4">
      <KnowledgePlanetAutomationPanel auth={auth} account={account} />
    </div>
  )
}

function scene(
  id: string,
  label: string,
  api: ApiMockTable,
  over: { steps?: ClickStep[]; account?: RuntimePluginAccount; shell?: 'sheet' | 'plain' } = {},
): Scene {
  const Shell = over.shell === 'plain' ? AutomationPlain : AutomationSheet
  return {
    id,
    label,
    group: '管理中心',
    viewports: ['desktop', 'mobile'],
    api,
    render: () =>
      over.steps ? (
        <AutoClick steps={over.steps}>
          <Shell account={over.account} />
        </AutoClick>
      ) : (
        <Shell account={over.account} />
      ),
  }
}

// ── 场景 ────────────────────────────────────────────────────────────────────

export const kpAutomationScenes: Scene[] = [
  // 一级状态
  scene('kp-automation-list', '自动回复 · 已开启（3 条规则：启用 / 停用 / 已暂停 + 运行记录）', panelApi(view())),
  scene('kp-automation-empty', '自动回复 · 已开启但尚无规则（空态）', panelApi(view({}, [], []))),
  scene(
    'kp-automation-off',
    '自动回复 · 关闭中（写入能力未开：总开关不可点 + 引导提示）',
    panelApi(view({ enabled: false, acceptedVersion: null, acceptedAt: null }, [], [])),
    { account: ACCOUNT_NO_WRITE },
  ),
  scene(
    'kp-automation-paused',
    '自动回复 · 被安全停用（DISPATCH_UNKNOWN）',
    panelApi(view({ enabled: false, pausedReason: 'DISPATCH_UNKNOWN' })),
  ),
  scene('kp-automation-loading', '自动回复 · 加载中', panelApi(null)),
  scene(
    'kp-automation-error',
    '自动回复 · 加载失败',
    panelApi(view(), {
      getKnowledgePlanetAutomation: fail(503, '插件运行时暂时不可用，请稍后重试', 'PLUGIN_RUNTIME_UNAVAILABLE'),
    }),
  ),

  // 二级状态
  scene(
    'kp-automation-runs',
    '自动回复 · 展开「最近执行记录」',
    panelApi(view()),
    { steps: [{ text: '最近执行记录', delay: 600 }] },
  ),
  scene(
    'kp-automation-consent',
    '自动回复 · 点总开关 → 免责声明与同意弹层',
    panelApi(view({ enabled: false, acceptedVersion: null, acceptedAt: null }, [], [])),
    {
      shell: 'plain',
      steps: [{ selector: '[role="switch"][aria-label="知识星球无人值守自动回复"]', delay: 600 }],
    },
  ),
  scene('kp-automation-new', '自动回复 · 点「添加规则」→ 批量新建弹层', panelApi(view()), {
    shell: 'plain',
    steps: [{ text: '添加规则', delay: 600 }],
  }),
  scene(
    'kp-automation-new-picker',
    '自动回复 · 新建弹层里打开星球选择器（含已配置项）',
    panelApi(view()),
    {
      shell: 'plain',
      steps: [
        { text: '添加规则', delay: 400 },
        { text: '从当前账号已加入的星球中选择', delay: 400 },
      ],
    },
  ),
  scene(
    'kp-automation-new-groups-error',
    '自动回复 · 星球列表读取失败（选择器内报错 + 重试）',
    panelApi(view(), {
      listKnowledgePlanetAutomationGroups: fail(502, '知识星球接口超时', 'UPSTREAM_TIMEOUT'),
    }),
    {
      shell: 'plain',
      steps: [
        { text: '添加规则', delay: 400 },
        { text: '从当前账号已加入的星球中选择', delay: 400 },
      ],
    },
  ),
  // 多步场景的总时长必须压在 OC_UI_SHOT_DELAY 之内（shoot.mjs 在 fonts.ready + SHOT_DELAY 后
  // 就按快门）；本组场景跑截图请用 OC_UI_SHOT_DELAY=1800。
  scene(
    'kp-automation-validation',
    '自动回复 · 选了星球但没填名称就保存 → 校验报错',
    panelApi(view()),
    {
      shell: 'plain',
      steps: [
        { text: '添加规则', delay: 400 },
        { text: '从当前账号已加入的星球中选择', delay: 400 },
        { text: '周报写作陪跑', delay: 300 },
        // 关掉选择器（再点一次触发器）再点保存
        { text: '已选择 1 个星球', delay: 250 },
        { text: '保存并启用 1 条规则', delay: 250 },
      ],
    },
  ),
  scene('kp-automation-edit', '自动回复 · 编辑一条规则', panelApi(view()), {
    shell: 'plain',
    steps: [{ text: '编辑', delay: 600 }],
  }),
  scene('kp-automation-delete', '自动回复 · 删除规则的确认框', panelApi(view()), {
    shell: 'plain',
    steps: [{ text: '删除', delay: 600 }],
  }),
]
