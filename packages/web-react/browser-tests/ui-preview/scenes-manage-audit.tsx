/**
 * 「管理中心」审计补充场景（2026-09 A·manage 审计 · 只增不改既有 scenes-manage.tsx）。
 *
 * 既有 scenes-manage.tsx 只覆盖六个 Tab 的首屏三态（有数据 / 空 / 错），且仅「记忆」「定时」
 * 给了移动端视口。本文件补三类缺口：
 *  1. **其余四个 Tab 的移动端视口**：直接复用既有场景对象派生（不复制 mock 数据）；
 *  2. **要点一下才能到达的二级状态**：技能工作台五个页签（含只读技能 / 训练草稿 diff）、
 *     记忆编辑器 / 新建 / 用户画像 / 用量 / 冷启动、定时新建 / 高级 cron 编辑、优化建议 Diff
 *     弹层、插件扫码授权中间态 / 过期态 / 写入免责确认；
 *  3. **工作项目作用域**下才出现的三块面板：项目专属技能、项目记忆、Agent 项目上下文预览，
 *     以及「未绑定聊天项目」下定时任务的 cronBlocked 分支。
 *
 * 二级状态靠 <AutoClick> 在挂载后按顺序模拟点击到达 —— 预览台是静态挂载，没有交互驱动。
 * 工作项目作用域的数据走 taskboardApi / identityCompatApi（原生 fetch，不经 api 代理），
 * 用 installBoardStub() 在场景 render 时接管这些路径；其余请求仍回落 harness 的 204。
 *
 * 时间字段沿用 scenes-manage.tsx 的约定：相对时间用「相对 now 的固定偏移」保证文案稳定。
 */
import { type ReactNode, useEffect } from 'react'

import { ManageCenter, type ManageTab } from '../../src/components/ManageCenter'
import { AgentProjectPreview } from '../../src/components/manage/AgentProjectPreview'
import { ProjectAssetsManagePanel } from '../../src/components/manage/ProjectAssetsManagePanel'
import { SkillEditor, type WorkbenchTab } from '../../src/components/manage/SkillEditor'
import { ProjectScopeProvider } from '../../src/hooks/useProjectScope'
import { ApiError } from '../../src/lib/api'
import { createMemoryAuthSession } from '../../src/lib/authSession'
import type {
  ConnectorsResponse,
  DeclarativeManagementResponse,
  KnowledgePlanetSetupView,
  PluginManagementResponse,
  RuntimePluginAccount,
} from '../../src/lib/connectors'
import type {
  AutoDreamOptimizerState,
  AutoDreamReportResponse,
  CronJob,
  MarketplaceMyAgent,
  MemoryDocResponse,
  MemoryIndexResponse,
  MemoryUsageDashboard,
  PublicModel,
  SkillDetail,
  SkillDraftDetail,
  SkillDraftSummary,
  SkillEvalRun,
  SkillSummary,
  SkillTrainRun,
} from '../../src/lib/types'

// 带扩展名：shoot.mjs 的 scene-groups 插件会把裸的 `./scenes-manage` 重定向到虚拟聚合模块，
// 这里要的是那份真实文件里导出的场景数组。
import { manageScenes } from './scenes-manage.tsx'
import type { ApiMockTable, Scene } from './types'

// ── 通用工具 ────────────────────────────────────────────────────────────────

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const NOW = Date.now()
const agoMs = (delta: number) => NOW - delta
const agoIso = (delta: number) => new Date(NOW - delta).toISOString()

const auth = createMemoryAuthSession(() => {}, 'preview-token')

const ok =
  <T,>(value: T) =>
  () =>
    Promise.resolve(value)

const fail = (status: number, message: string, code?: string) => () =>
  Promise.reject(new ApiError({ status, message, code, requestId: 'req_audit_7c1f9ae0' }))

/** 挂载后按顺序模拟点击（selector 或按钮文案子串），把静态预览台推进到二级状态。 */
type ClickStep = { selector?: string; text?: string; delay?: number }

function findClickTarget(step: ClickStep): HTMLElement | null {
  if (step.selector) return document.querySelector<HTMLElement>(step.selector)
  if (step.text) {
    for (const el of document.querySelectorAll<HTMLElement>(
      'button,[role="tab"],[role="switch"]',
    )) {
      if (el.textContent?.includes(step.text)) return el
    }
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
      at += step.delay ?? 140
      timers.push(
        window.setTimeout(() => {
          if (cancelled) return
          const target = findClickTarget(step)
          if (!target) console.warn('[audit-scene] 点击目标未找到', step)
          target?.click()
        }, at),
      )
    }
    return () => {
      cancelled = true
      for (const t of timers) window.clearTimeout(t)
    }
  }, [])
  return <>{children}</>
}

/**
 * 接管原生 fetch 的 /api/board/* 与 /api/agents（taskboardApi / identityCompatApi 不经 api 代理）。
 * 表按路径前缀匹配（先长后短）；未命中回落 harness 的 204。场景卸载时自动清表。
 */
type FetchTable = Record<string, unknown>
let boardTable: FetchTable | null = null
let boardStubInstalled = false

function installBoardStub(table: FetchTable) {
  boardTable = table
  if (boardStubInstalled) return
  boardStubInstalled = true
  const fallback = window.fetch
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0]
    if (boardTable) {
      const hit = Object.keys(boardTable)
        .sort((a, b) => b.length - a.length)
        .find((key) => path === key || path.startsWith(`${key}/`))
      if (hit) {
        return new Response(JSON.stringify(boardTable[hit]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
    }
    return fallback(input, init)
  }
}

function BoardStub({ table, children }: { table: FetchTable; children: ReactNode }) {
  installBoardStub(table)
  useEffect(
    () => () => {
      boardTable = null
    },
    [],
  )
  return <>{children}</>
}

// ── 共享基础数据 ────────────────────────────────────────────────────────────

const AGENTS: { id: string; name: string }[] = [
  { id: 'main', name: '全能助手' },
  { id: 'agent_xhs_mkt', name: '小红书内容运营' },
]

const MY_AGENTS: MarketplaceMyAgent[] = [
  {
    id: 'main',
    slug: 'main',
    name: '全能助手',
    description: '默认智能体，覆盖日常问答、检索、写作与工具调用。',
    installed: true,
    isDefault: true,
  },
  {
    id: 'agent_xhs_mkt',
    slug: 'xhs-content-ops',
    name: '小红书内容运营',
    description: '母婴科普选题、长图排版与发布队列管理。',
    avatarEmoji: '📕',
    installed: true,
    version: '0.9.7',
  },
]

const PUBLIC_MODELS: PublicModel[] = [
  {
    id: 'deepseek-v4-flash',
    display_name: 'DeepSeek V4 Flash',
    input_per_ktok_credits: 0.3,
    output_per_ktok_credits: 1.1,
  },
]

const BASE: ApiMockTable = {
  listMyAgents: ok(MY_AGENTS),
  getPublicModels: ok({ models: PUBLIC_MODELS, lockedModels: [] }),
  listCronChannels: ok([
    { value: 'webchat', available: true },
    { value: 'telegram', available: true },
    { value: 'local', available: true },
  ]),
}

function shell(tab: ManageTab): ReactNode {
  return (
    <ManageCenter
      open
      tab={tab}
      auth={auth}
      agentId="main"
      agents={AGENTS}
      onTabChange={() => {}}
      onClose={() => {}}
      onOpenMarketplace={() => {}}
    />
  )
}

/** 既有场景 → 仅移动端视口的派生副本（同一份 mock，不复制数据）。 */
function mobileOnly(id: string): Scene {
  const base = manageScenes.find((s) => s.id === id)
  if (!base) throw new Error(`scenes-manage-audit: 找不到既有场景 ${id}`)
  return { ...base, id: `${id}-mobile`, label: `${base.label}（移动端）`, viewports: ['mobile'] }
}

// ── 记忆 ────────────────────────────────────────────────────────────────────

const MEMORY_INDEX: MemoryIndexResponse = {
  kind: 'index',
  version: 'b71f0c2ad9e34556',
  text: [
    '<!-- openclaude-memory-index v2 -->',
    '# Memory Index',
    '',
    '- [沟通与协作偏好](user-preferences.md) — 默认中文、先结论后展开。',
    '- [小红书母婴号运营手册](xhs-muying-account.md) — 选题日历、20:00 自动发布。',
    '- [知识星球发布铁律](zsxq-publish-rules.md) — 富文本快捷键会吞正文。',
  ].join('\n'),
  files: [
    {
      file: 'user-preferences.md',
      name: '沟通与协作偏好',
      description: '默认中文回复；先给结论再展开论证；架构决策要给方案对比与显式权衡。',
      type: 'user',
      mtimeMs: agoMs(2 * HOUR),
      size: 1832,
    },
    {
      file: 'xhs-muying-account.md',
      name: '小红书母婴号运营手册',
      description: 'momo 号的选题日历、长图排版规范、每日 20:00 自动发布与队列补货规则。',
      type: 'project',
      mtimeMs: agoMs(28 * HOUR),
      size: 4417,
    },
    {
      file: 'zsxq-publish-rules.md',
      name: '知识星球发布铁律',
      description: '富文本快捷键会吞正文；发布前必须校验字数计数器。',
      type: 'reference',
      mtimeMs: agoMs(9 * DAY),
      size: 2054,
    },
  ],
}

const DREAM_IDLE: AutoDreamReportResponse = { status: 'idle', pendingSessions: 0 }

const USER_PROFILE: MemoryDocResponse = {
  target: 'user',
  version: '3f2f2ffd9c1a',
  limit: 4000,
  charCount: 286,
  text: [
    '## 基本情况',
    '- 称呼：boss。上海，作息偏晚，重要发布多在夜间窗口。',
    '',
    '## 沟通偏好',
    '- 默认中文；先给结论/建议，再展开论证，长回答带小标题。',
    '- 技术决策要站架构师视角：优先根治而非缝补。',
  ].join('\n'),
}

const MEMORY_USAGE: MemoryUsageDashboard = {
  window: { days: 30, from: agoIso(30 * DAY), to: agoIso(0) },
  totals: {
    events: 412,
    sessions: 57,
    hits: 233,
    noMatch: 61,
    errors: 2,
    denied: 0,
    freshnessGaps: 3,
  },
  byOperation: [
    {
      operation: 'index_injected',
      memoryType: 'core',
      events: 57,
      sessions: 57,
      hits: 57,
      noMatch: 0,
      p50Ms: 4,
      p95Ms: 11,
    },
    {
      operation: 'core_search',
      memoryType: 'core',
      events: 188,
      sessions: 51,
      hits: 141,
      noMatch: 47,
      p50Ms: 86,
      p95Ms: 240,
    },
    {
      operation: 'session_search',
      memoryType: 'session',
      events: 96,
      sessions: 33,
      hits: 78,
      noMatch: 14,
      p50Ms: 132,
      p95Ms: 410,
    },
    {
      operation: 'core_write',
      memoryType: 'core',
      events: 41,
      sessions: 26,
      hits: 41,
      noMatch: 0,
      p50Ms: 22,
      p95Ms: 60,
    },
    {
      operation: 'auto_add',
      memoryType: 'core',
      events: 30,
      sessions: 19,
      hits: 30,
      noMatch: 0,
      p50Ms: 18,
      p95Ms: 55,
    },
  ],
  recentSessions: [
    {
      sessionKey: 's_1',
      title: '小红书母婴号 9 月选题日历',
      lastAt: agoMs(3 * HOUR),
      events: 14,
      searches: 9,
      writes: 2,
      freshnessGaps: 1,
    },
    {
      sessionKey: 's_2',
      title: 'V5 商业版发布复盘',
      lastAt: agoMs(1 * DAY),
      events: 22,
      searches: 15,
      writes: 3,
      freshnessGaps: 0,
    },
    {
      sessionKey: 's_3',
      title: '知识星球周精选整理',
      lastAt: agoMs(2 * DAY),
      events: 9,
      searches: 6,
      writes: 1,
      freshnessGaps: 2,
    },
  ],
}

const memoryBase: ApiMockTable = {
  ...BASE,
  getMemoryIndex: ok(MEMORY_INDEX),
  getAutoDreamReport: ok(DREAM_IDLE),
  getMemory: ok(USER_PROFILE),
  getMemoryUsage: ok(MEMORY_USAGE),
  putMemory: ok({ ok: true, version: 'next', charCount: 300, limit: 4000 }),
  putMemoryFile: ok({ ok: true, version: 'next-file' }),
  deleteMemoryFile: ok(true),
  getMemoryFile: ok({
    content: [
      '---',
      'name: 沟通与协作偏好',
      'description: 默认中文回复；先给结论再展开论证；架构决策要给方案对比与显式权衡。',
      'type: user',
      '---',
      '',
      '- 默认中文，除非明确要求其他语言。',
      '- 先结论后论证；长回答用小标题分节。',
      '- 架构层面的妥协（语义不对称、权威源分裂）不算「过度工程」的约束范围，该重构就重构。',
      '',
    ].join('\n'),
    version: 'b71f0c2ad9e34556',
  }),
}

// ── 定时任务 ────────────────────────────────────────────────────────────────

const CRON_JOBS: CronJob[] = [
  {
    id: 'cron_7f21a3c9',
    label: '每日早报',
    schedule: '0 8 * * *',
    prompt: '汇总昨日 V5 线上告警、turn 失败率与积分消耗趋势，挑出异常项并给出处置建议。',
    deliver: 'webchat',
    enabled: true,
    oneshot: false,
    nextRunAt: agoIso(-9 * HOUR),
    lastRunAt: agoIso(15 * HOUR),
  },
  {
    id: 'cron_health_probe',
    label: '线上健康探针',
    schedule: '*/30 * * * *',
    prompt: '探测 /version、Caddy 与公网健康端点；连续两次失败即推送企微告警。',
    deliver: 'local',
    enabled: true,
    oneshot: false,
    heartbeat: true,
    nextRunAt: agoIso(-12 * MIN),
    lastRunAt: agoIso(18 * MIN),
  },
  {
    id: 'cron_weekly_report',
    label: '周报汇总（暂停中）',
    schedule: '0 18 * * 5',
    prompt: '把本周合并的 PR、已上线的 release 与下周计划整理成周报。',
    deliver: 'webchat',
    enabled: false,
    oneshot: false,
    lastRunAt: agoIso(9 * DAY),
  },
]

const cronBase: ApiMockTable = {
  ...BASE,
  listCron: ok(CRON_JOBS),
  createCron: ok({ id: 'cron_new' }),
  updateCron: ok({ ok: true }),
  deleteCron: ok({ ok: true }),
}

// ── 技能工作台 ──────────────────────────────────────────────────────────────

const SKILL_BODY = [
  '# v5 商业版上线',
  '',
  '## 1. 生效面矩阵',
  '改动落在 master / dist / runtime 三轴中的哪一条，决定要跑哪几步：',
  '- master：容器内源码走 release 轴，不再重建镜像。',
  '- dist：前端产物，必须 `--with-dist` 单次重启。',
  '- runtime：tuple / egress / env / 迁移，禁手改单键。',
  '',
  '## 2. 部署互斥',
  'deploy 全局 flock；锁被占时等待，勿 kill。',
  '',
  '## 3. Smoke fail-closed',
  '任一 smoke 失败立即回退，不允许「先观察一下」。',
].join('\n')

const SKILL_DETAIL: SkillDetail = {
  name: 'v5-commercial-deploy',
  description:
    'OpenClaude v5（Aurora 商业版）上线的权威流程：生效面矩阵分类 → deploy-v5.sh → 逐面执行 → smoke fail-closed。',
  version: '3.2.0',
  tags: ['部署', '运维', 'v5'],
  source: 'shared',
  layer: 'shared',
  writable: true,
  agentIds: ['main'],
  files: [
    'SKILL.md',
    'references/deploy-matrix.md',
    'references/rollback.md',
    'scripts/preflight.sh',
    'evals/evals.json',
    'history/3.1.0.md',
  ],
  body: SKILL_BODY,
}

const SKILL_DETAIL_READONLY: SkillDetail = {
  name: 'longform-infographic',
  description:
    '生成中文竖版长图信息图（观点图解 / 知识卡片 / 框架梳理），HTML+CSS 手写 → headless Chromium 截图。',
  version: '2.1.0',
  tags: ['长图', '设计'],
  source: 'hub',
  layer: 'hub',
  writable: false,
  agentIds: ['agent_xhs_mkt'],
  files: ['SKILL.md', 'assets/template.html'],
  body: [
    '# 长图信息图',
    '',
    '## 输入',
    '一段观点或一份提纲；输出 2160px 高清 PNG。',
    '',
    '## 步骤',
    '1. 拆成 5~7 张卡片；',
    '2. 用模板渲染 HTML；',
    '3. headless Chromium 截图并拼接。',
  ].join('\n'),
}

const EVAL_USAGE = {
  inputTokens: 48_120,
  outputTokens: 9_360,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  turns: 6,
}

const EVAL_LAST_RUN: SkillEvalRun = {
  runId: 'eval_run_0a1b',
  skillName: 'v5-commercial-deploy',
  mode: 'baseline',
  model: 'deepseek-v4-flash',
  status: 'done',
  progress: { done: 4, total: 4 },
  cases: [
    {
      id: 'dist-only',
      prompt: '只改了前端产物，如何上线？',
      assertions: ['提到 --with-dist', '不重建镜像'],
    },
    {
      id: 'lock-busy',
      prompt: 'deploy 提示锁被占，怎么办？',
      assertions: ['等待而不是 kill', '说明 flock 语义'],
    },
  ],
  results: [
    {
      caseId: 'dist-only',
      arm: 'without',
      output: '…',
      usage: EVAL_USAGE,
      assertions: [
        { text: '提到 --with-dist', passed: false, evidence: '输出建议重建镜像' },
        { text: '不重建镜像', passed: false, evidence: '' },
      ],
    },
    {
      caseId: 'dist-only',
      arm: 'with',
      output: '…',
      usage: EVAL_USAGE,
      assertions: [
        { text: '提到 --with-dist', passed: true, evidence: '「必须 --with-dist 单次重启」' },
        { text: '不重建镜像', passed: true, evidence: '' },
      ],
    },
    {
      caseId: 'lock-busy',
      arm: 'without',
      output: '…',
      usage: EVAL_USAGE,
      assertions: [
        { text: '等待而不是 kill', passed: true, evidence: '' },
        { text: '说明 flock 语义', passed: false, evidence: '' },
      ],
    },
    {
      caseId: 'lock-busy',
      arm: 'with',
      output: '…',
      usage: EVAL_USAGE,
      assertions: [
        { text: '等待而不是 kill', passed: true, evidence: '' },
        { text: '说明 flock 语义', passed: true, evidence: '' },
      ],
    },
  ],
  benchmark: {
    passRate: { with: 1, without: 0.25 },
    counts: { with: { passed: 4, total: 4 }, without: { passed: 1, total: 4 } },
    avgOutputTokens: { with: 1_320, without: 980 },
    verdict: '技能显著有效：有技能通过率 100%，无技能 25%',
  },
  usage: EVAL_USAGE,
  error: null,
  startedAt: agoMs(2 * DAY + 6 * MIN),
  finishedAt: agoMs(2 * DAY),
}

const TRAIN_RUN_DRAFT: SkillTrainRun = {
  runId: 'train_run_5d2e',
  skillName: 'v5-commercial-deploy',
  status: 'diff_ready',
  phase: 'diff_ready',
  proposalCount: 1,
  toolCalls: 23,
  usage: {
    inputTokens: 212_400,
    outputTokens: 14_800,
    cacheReadTokens: 40_000,
    cacheCreationTokens: 0,
    turns: 12,
  },
  autoEval: true,
  evalRunId: 'eval_run_draft_9c',
  error: null,
  summary:
    '近 14 天 3 次上线里有 2 次在 smoke 阶段犹豫是否回退；草稿把「任一 smoke 失败立即回退」写成硬规则并补了回退命令。',
  startedAt: agoMs(40 * MIN),
  finishedAt: agoMs(12 * MIN),
}

const TRAIN_DRAFT_SUMMARY: SkillDraftSummary = {
  name: 'v5-commercial-deploy',
  op: 'update',
  baseVersion: '3.2.0',
  rationale: '两次上线在 smoke 失败后拖延回退，说明现版第 3 节缺少可执行的回退命令与时限。',
  authoredBy: 'ai',
  updatedAt: agoIso(12 * MIN),
}

const TRAIN_DRAFT_DETAIL: SkillDraftDetail = {
  draft: {
    meta: {
      name: 'v5-commercial-deploy',
      description: SKILL_DETAIL.description ?? '',
      tags: SKILL_DETAIL.tags,
    },
    body: [
      '# v5 商业版上线',
      '',
      '## 1. 生效面矩阵',
      '改动落在 master / dist / runtime 三轴中的哪一条，决定要跑哪几步：',
      '- master：容器内源码走 release 轴，不再重建镜像。',
      '- dist：前端产物，必须 `--with-dist` 单次重启。',
      '- runtime：tuple / egress / env / 迁移，禁手改单键。',
      '',
      '## 2. 部署互斥',
      'deploy 全局 flock；锁被占时等待，勿 kill。',
      '',
      '## 3. Smoke fail-closed（硬规则）',
      '任一 smoke 失败 **60 秒内**执行 `deploy-v5.sh --rollback <prev-release>`，不允许「先观察一下」。',
      '回退完成后再排查；排查结论写进 incident 记录。',
      '',
      '## 4. 上线前检查清单',
      '- [ ] `scripts/preflight.sh` 全绿',
      '- [ ] 迁移已人工 apply 并记账',
    ].join('\n'),
    rawContent: '',
    evalsJson: undefined,
    record: { ...TRAIN_DRAFT_SUMMARY, runId: TRAIN_RUN_DRAFT.runId, createdAt: agoIso(12 * MIN) },
  },
  current: { body: SKILL_BODY, description: SKILL_DETAIL.description ?? '', version: '3.2.0' },
}

const EVAL_GATE_RUN: SkillEvalRun = {
  ...EVAL_LAST_RUN,
  runId: 'eval_run_draft_9c',
  mode: 'draft',
  trainRunId: TRAIN_RUN_DRAFT.runId,
  results: EVAL_LAST_RUN.results.map((r) => ({
    ...r,
    arm: r.arm === 'without' ? 'with' : 'draft',
  })),
  benchmark: {
    passRate: { with: 0.75, draft: 1 },
    counts: { with: { passed: 3, total: 4 }, draft: { passed: 4, total: 4 } },
    avgOutputTokens: { with: 1_320, draft: 1_410 },
    preference: { draft: 2, current: 0, tie: 0 },
    verdict: '草稿更好：草稿通过率 100%，现版 75%',
  },
  startedAt: agoMs(11 * MIN),
  finishedAt: agoMs(6 * MIN),
}

const skillBase: ApiMockTable = {
  ...BASE,
  getSkill: ok(SKILL_DETAIL),
  getSkillFile: ok({
    path: 'references/deploy-matrix.md',
    content: [
      '# 生效面矩阵',
      '',
      '| 改动 | 轴 | 动作 |',
      '|---|---|---|',
      '| 容器内源码 | master | release 轴，不重建镜像 |',
      '| 前端产物 | dist | `--with-dist` 单次重启 |',
      '| tuple / egress / env | runtime | 走迁移，禁手改单键 |',
    ].join('\n'),
  }),
  getSkillHistory: ok({
    history: [
      { version: '3.1.0', timestamp: agoIso(6 * DAY) },
      { version: '3.0.2', timestamp: agoIso(19 * DAY) },
      { version: '3.0.0', timestamp: agoIso(41 * DAY) },
    ],
    writable: true,
  }),
  getSkillEvals: ok({
    evals: { version: 1, cases: EVAL_LAST_RUN.cases, autoRegression: false },
    writable: true,
    lastRun: {
      runId: EVAL_LAST_RUN.runId,
      finishedAt: EVAL_LAST_RUN.finishedAt ?? agoMs(2 * DAY),
      benchmark: EVAL_LAST_RUN.benchmark,
      usage: EVAL_USAGE,
    },
  }),
  listSkillTrainRuns: ok([] as SkillTrainRun[]),
  updateSkill: ok({ ok: true }),
  putSkillFile: ok({ ok: true }),
  deleteSkillFile: ok({ ok: true }),
}

function workbench(tab: WorkbenchTab, extra: Partial<Record<string, unknown>> = {}): ReactNode {
  return (
    <SkillEditor
      auth={auth}
      skillName={(extra.skillName as string) ?? 'v5-commercial-deploy'}
      open
      initialTab={tab}
      rates={{
        modelId: 'deepseek-v4-flash',
        displayName: 'DeepSeek V4 Flash',
        inputPerKtok: 0.3,
        outputPerKtok: 1.1,
        cacheReadPerKtok: 0,
        cacheWritePerKtok: 0,
      }}
      onClose={() => {}}
      onChanged={() => {}}
    />
  )
}

// ── 全面优化 ────────────────────────────────────────────────────────────────

const OPTIMIZER_STATE: AutoDreamOptimizerState = {
  schemaVersion: 2,
  status: 'success',
  runId: 'run_0f1d5851c9',
  startedAt: agoIso(2 * DAY + 40 * MIN),
  finishedAt: agoIso(2 * DAY),
  lastSuccessAt: agoIso(2 * DAY),
  sessionsReviewed: 137,
  pagesReviewed: 42,
  summary:
    '本周共审计 137 个会话。你在「小红书母婴号」相关任务上重复交代了三次「医疗内容必须带权威源与免责声明」，建议固化为长期记忆。',
  proposals: [
    {
      id: 'prop_mem_muying_disclaimer',
      fingerprint: 'fp_a91c',
      category: 'memory',
      action: 'memory.upsert',
      title: '把「母婴医疗内容必须附权威源 + 免责声明」固化为长期记忆',
      reason: '近 30 天内你在 6 个不同会话里重复交代了同一条约束（3 次是在产出被退回后补充的）。',
      targetId: 'memory/xhs-muying-account.md',
      before:
        '---\nname: 小红书母婴号运营手册\ndescription: momo 号的选题、排版与发布节奏\ntype: project\n---\n\n每日 20:00（北京时间）自动发布，队列低于 3 条时补货。',
      after:
        '---\nname: 小红书母婴号运营手册\ndescription: momo 号的选题、排版、发布节奏与医疗内容合规红线\ntype: project\n---\n\n每日 20:00（北京时间）自动发布，队列低于 3 条时补货。\n\n## 医疗内容红线\n- 涉及用药、喂养量、发育指标的结论必须给出权威源（WHO / 中华医学会 / 国家卫健委）。\n- 每篇结尾附「本文不构成医疗建议，具体请遵医嘱」。',
      beforeFingerprint: 'fp_before_a91c',
      state: 'pending',
      createdAt: agoIso(2 * DAY),
    },
    {
      id: 'prop_profile_tone',
      fingerprint: 'fp_c73d',
      category: 'profile',
      action: 'profile.update',
      title: '更新用户画像中的沟通偏好：默认中文、先给结论',
      reason: '你在 21 次会话里显式要求「先给结论再展开」，当前画像里没有这条。',
      targetId: 'user.md',
      before: '## 沟通偏好\n- 默认中文回复。',
      after: '## 沟通偏好\n- 默认中文回复。\n- 先给结论 / 建议，再展开论证；长回答需要带小标题。',
      beforeFingerprint: 'fp_before_c73d',
      state: 'conflict',
      createdAt: agoIso(2 * DAY),
      error: '用户画像在生成建议后被改动过，应用前请确认最新内容。',
    },
  ],
}

const optimizationBase: ApiMockTable = {
  ...BASE,
  getAutoDreamOptimizer: ok(OPTIMIZER_STATE),
  runAutoDreamOptimizer: ok(OPTIMIZER_STATE),
  cancelAutoDreamOptimizer: ok(OPTIMIZER_STATE),
  mutateAutoDreamProposal: ok(OPTIMIZER_STATE),
}

// ── 插件账号（知识星球扫码授权） ────────────────────────────────────────────

const KP_CATALOG: PluginManagementResponse['catalog'][number] = {
  versionId: 'pv_kp_181',
  slug: 'knowledge-planet',
  pluginType: 'managed-browser',
  label: '知识星球',
  description: '在隔离浏览器中代你读取星球主题与提问，并可在你授权后发布带 AI 标识的文字评论。',
  accountMode: 'required',
  actions: [
    { id: 'topic.list', description: '读取星球主题列表', readOnly: true },
    { id: 'topic.get', description: '读取单条主题正文与评论', readOnly: true },
    { id: 'comment.create', description: '发布文字评论', readOnly: false },
  ],
  installed: true,
  installedVersion: '1.8.1',
  latestVersionId: 'pv_kp_181',
  latestVersion: '1.8.1',
  installedCurrent: true,
  updateAvailable: false,
  available: true,
}

const KP_ACCOUNT_WRITE_OFF: RuntimePluginAccount = {
  id: 'pacc_kp_1',
  provider: 'knowledge-planet',
  pluginType: 'managed-browser',
  displayName: 'momo 的知识星球',
  accountHint: '微信昵称：momo · 3 个星球',
  status: 'active',
  actions: [
    { id: 'topic.list', description: '读取星球主题列表', readOnly: true },
    { id: 'comment.create', description: '发布文字评论', readOnly: false },
  ],
  versionId: 'pv_kp_181',
  executable: true,
  writeControl: {
    available: true,
    enabled: false,
    disclaimerVersion: 3,
    acceptedVersion: null,
    acceptedAt: null,
    disclaimerText:
      '开启后，AI 可代你在知识星球发布文字评论。所有写入动作默认仍需你在对话中逐次确认；请确认你已理解由此产生的内容责任。',
    preapproval: {
      available: true,
      enabled: false,
      disclaimerVersion: 2,
      acceptedVersion: null,
      acceptedAt: null,
      disclaimerText:
        '开启「免逐次确认」后，Agent 可直接执行所有已开放的写入动作，不再展示确认卡。',
    },
  },
}

const EMPTY_CONNECTORS: ConnectorsResponse = { providers: [], connections: [] }
const EMPTY_DECL: DeclarativeManagementResponse = { connectors: [], connections: [] }

const KP_SETUP_WAITING: KnowledgePlanetSetupView = {
  sessionId: 'kps_2b7f',
  status: 'waiting_for_scan',
  phase: 'waiting_for_scan',
  qrReady: true,
  qrRevision: 1,
  createdAt: agoIso(5_000),
  expiresAt: agoIso(-4 * MIN),
}

const KP_SETUP_EXPIRED: KnowledgePlanetSetupView = {
  ...KP_SETUP_WAITING,
  status: 'expired',
  phase: 'expired',
  qrReady: false,
}

/** 伪二维码：确定性 21×21 点阵 SVG（<img> 走 blob URL，与真接口一致）。 */
function fakeQrBlob(): Blob {
  const n = 21
  const cell = 10
  let seed = 0x9e3779b9
  const rnd = () => {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return (seed >>> 0) / 0xffffffff
  }
  const rects: string[] = []
  const finder = (x: number, y: number) =>
    `<rect x="${x * cell}" y="${y * cell}" width="${7 * cell}" height="${7 * cell}" fill="#000"/>` +
    `<rect x="${(x + 1) * cell}" y="${(y + 1) * cell}" width="${5 * cell}" height="${5 * cell}" fill="#fff"/>` +
    `<rect x="${(x + 2) * cell}" y="${(y + 2) * cell}" width="${3 * cell}" height="${3 * cell}" fill="#000"/>`
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const inFinder = (x < 8 && y < 8) || (x >= n - 8 && y < 8) || (x < 8 && y >= n - 8)
      if (!inFinder && rnd() > 0.5) {
        rects.push(
          `<rect x="${x * cell}" y="${y * cell}" width="${cell}" height="${cell}" fill="#000"/>`,
        )
      }
    }
  }
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n * cell} ${n * cell}">` +
    `<rect width="100%" height="100%" fill="#fff"/>${finder(0, 0)}${finder(n - 7, 0)}${finder(0, n - 7)}${rects.join('')}</svg>`
  return new Blob([svg], { type: 'image/svg+xml' })
}

const connectorsKpBase: ApiMockTable = {
  ...BASE,
  getConnectors: ok(EMPTY_CONNECTORS),
  getDeclarativeManagement: ok(EMPTY_DECL),
  getPluginManagement: ok({ catalog: [KP_CATALOG], accounts: [] } as PluginManagementResponse),
  startKnowledgePlanetSetup: ok(KP_SETUP_WAITING),
  getKnowledgePlanetSetup: ok(KP_SETUP_WAITING),
  getKnowledgePlanetSetupQr: () => Promise.resolve(fakeQrBlob()),
  cancelKnowledgePlanetSetup: ok({ ok: true }),
}

// ── 工作项目作用域（taskboardApi 走原生 fetch） ─────────────────────────────

const WORK_PROJECT = {
  id: 'wp_muying_2026',
  key: 'MY',
  name: '小红书母婴号运营',
  description: null,
  workspace: null,
  labels: [],
  archivedAt: null,
  createdAt: agoMs(60 * DAY),
  updatedAt: agoMs(2 * DAY),
}

const SKILLS_FOR_OVERLAY: SkillSummary[] = [
  {
    name: 'zsxq-publish',
    description: '知识星球网页版内容发布与管理的完整规程。',
    version: '1.7.3',
    tags: ['发布'],
    source: 'shared',
    layer: 'shared',
    writable: true,
    agentIds: ['main', 'agent_xhs_mkt'],
  },
  {
    name: 'muying-content-calendar',
    description: '母婴科普 30 天选题日历维护与补货。',
    version: '0.9.1',
    tags: ['母婴'],
    source: 'shared',
    layer: 'shared',
    writable: true,
    agentIds: ['agent_xhs_mkt'],
  },
  {
    name: 'longform-infographic',
    description: '生成中文竖版长图信息图。',
    version: '2.1.0',
    tags: ['长图'],
    source: 'hub',
    layer: 'hub',
    writable: false,
    agentIds: ['agent_xhs_mkt'],
  },
  {
    name: 'v5-selfhost-cursor-key-rotation',
    description: '密钥轮换 SOP。',
    version: '1.0.0',
    tags: [],
    source: 'shared',
    layer: 'shared',
    writable: true,
    agentIds: ['main'],
  },
]

const BOARD_WORK: FetchTable = {
  '/api/agents': {},
  '/api/board/projects': { items: [WORK_PROJECT] },
  [`/api/board/projects/${WORK_PROJECT.id}`]: { project: WORK_PROJECT },
  [`/api/board/projects/${WORK_PROJECT.id}/context`]: {
    version: 3,
    instructions: null,
    skillOverlay: ['zsxq-publish'],
  },
  [`/api/board/projects/${WORK_PROJECT.id}/context/preview`]: {
    enabled: true,
    slots: [
      { name: 'instructions', bytes: 1_240 },
      { name: 'memories', bytes: 3_812, redacted: true },
      { name: 'skills', bytes: 620 },
    ],
  },
  [`/api/board/projects/${WORK_PROJECT.id}/memories`]: {
    projectId: WORK_PROJECT.id,
    official: [
      { projectId: WORK_PROJECT.id, slug: 'publish-cadence.md', contentSha256: 'a1', version: 2 },
      {
        projectId: WORK_PROJECT.id,
        slug: 'medical-redline.md',
        contentSha256: 'b2',
        version: 1,
        tampered: true,
      },
    ],
    candidates: [
      {
        id: 'cand_1',
        projectId: WORK_PROJECT.id,
        slug: 'supplier-list.md',
        contentSha256: 'c3',
        version: 1,
        status: 'pending',
        content:
          '长图素材供应商：坚果云 dav.jianguoyun.com/dav/openclaude-assets；备用 OSS bucket momo-assets。',
      },
    ],
  },
}

const CHAT_UNBOUND = { id: 'chat_unbound_01', name: 'momo 号日常', boardProjectId: null }
/**
 * 绑定到工作项目的聊天项目。作用域 token 必须用**它的 id**而不是工作项目 id：
 * ProjectScopeProvider 挂载后先读 localStorage 的 token，再异步拉工作项目列表；列表未到时
 * 工作项目 id 解析为 invalid → provider 立刻把 token 重置回 "all"（并写回 localStorage）。
 * 走「已绑定的聊天项目 id」在列表未到时解析成 chat 作用域（合法），列表到达后自动升格为 work。
 * ——这条竞态本身是 hooks/useProjectScope（sidebar 归属）的问题，已在审计文档「跨模块发现」记录。
 */
const CHAT_BOUND = { id: 'chat_muying_0001', name: 'momo 号运营', boardProjectId: WORK_PROJECT.id }

/** 只压掉 /api/agents 的 204（identityCompat 读失败会在记忆面板顶部落一条 warning）。 */
const QUIET: FetchTable = { '/api/agents': {} }

/** 用 ProjectScopeProvider 包壳并把作用域 token 预写进 localStorage（provider 挂载时读取）。 */
function scoped(
  token: string,
  chatProjects: { id: string; name: string; boardProjectId?: string | null }[],
  table: FetchTable,
  node: ReactNode,
): ReactNode {
  try {
    localStorage.setItem('oc_v5_project_scope:preview-user', token)
    // URL 里的 ?project= 优先级高于 localStorage；上一个作用域场景会把自己的 token 留在 URL 上
    //（provider 的 replaceProjectQuery），这里必须同步覆写，否则串场景。
    history.replaceState({}, '', `${location.pathname}?project=${encodeURIComponent(token)}`)
  } catch {}
  return (
    <BoardStub table={table}>
      <ProjectScopeProvider auth={auth} chatProjects={chatProjects} userId="preview-user">
        {node}
      </ProjectScopeProvider>
    </BoardStub>
  )
}

function quiet(node: ReactNode): ReactNode {
  return <BoardStub table={QUIET}>{node}</BoardStub>
}

// ── 场景 ────────────────────────────────────────────────────────────────────

export const manageAuditScenes: Scene[] = [
  // ── 移动端视口补齐（复用既有 mock） ──
  mobileOnly('manage-skills'),
  mobileOnly('manage-connectors'),
  mobileOnly('manage-library'),
  mobileOnly('manage-optimization'),
  mobileOnly('manage-skills-empty'),

  // ── 记忆二级状态 ──
  {
    id: 'manage-memory-usage',
    label: '记忆 · 用量页签（未定义 token 类：text-body-sm / text-foreground / bg-surface-subtle）',
    group: '管理中心',
    viewports: ['desktop', 'mobile'],
    api: memoryBase,
    render: () =>
      quiet(
        <AutoClick steps={[{ selector: '#memory-section-tab-usage' }]}>
          {shell('memory')}
        </AutoClick>,
      ),
  },
  {
    id: 'manage-memory-profile',
    label: '记忆 · 用户画像页签',
    group: '管理中心',
    viewports: ['desktop', 'mobile'],
    api: memoryBase,
    render: () =>
      quiet(
        <AutoClick steps={[{ selector: '#memory-section-tab-profile' }]}>
          {shell('memory')}
        </AutoClick>,
      ),
  },
  {
    id: 'manage-memory-editor',
    label: '记忆 · 打开一条记忆的编辑器',
    group: '管理中心',
    viewports: ['desktop', 'mobile'],
    api: memoryBase,
    render: () =>
      quiet(
        <AutoClick steps={[{ selector: '#memory-section-panel-core ul li button' }]}>
          {shell('memory')}
        </AutoClick>,
      ),
  },
  {
    id: 'manage-memory-new',
    label: '记忆 · 新建记忆弹层',
    group: '管理中心',
    api: memoryBase,
    render: () => quiet(<AutoClick steps={[{ text: '新建记忆' }]}>{shell('memory')}</AutoClick>),
  },
  {
    id: 'manage-memory-coldstart',
    label: '记忆 · 容器冷启动（503 → 唤醒提示 + 骨架）',
    group: '管理中心',
    api: {
      ...BASE,
      getMemoryIndex: fail(503, 'container warming'),
      getAutoDreamReport: fail(503, 'container warming'),
      getMemory: fail(503, 'container warming'),
    },
    render: () => shell('memory'),
  },

  // ── 定时任务二级状态 ──
  {
    id: 'manage-cron-create',
    label: '定时任务 · 新建表单',
    group: '管理中心',
    viewports: ['desktop', 'mobile'],
    api: cronBase,
    render: () => <AutoClick steps={[{ text: '新建' }]}>{shell('cron')}</AutoClick>,
  },
  {
    id: 'manage-cron-edit-advanced',
    label: '定时任务 · 编辑无法还原成友好预设的任务（*/30 → 高级 Cron）',
    group: '管理中心',
    viewports: ['desktop', 'mobile'],
    api: cronBase,
    render: () => (
      <AutoClick steps={[{ selector: '[aria-label="编辑「线上健康探针」"]' }]}>
        {shell('cron')}
      </AutoClick>
    ),
  },
  {
    id: 'manage-cron-range',
    label: '定时任务 · 区间排程可读（*/30 9-19 * * 1-5 → 每周一至五 9–19 点每 30 分钟，X-03）',
    group: '管理中心',
    viewports: ['desktop', 'mobile'],
    api: {
      ...cronBase,
      listCron: ok([
        ...CRON_JOBS,
        {
          id: 'cron_patrol_workdays',
          label: '工作日巡检',
          schedule: '*/30 9-19 * * 1-5',
          prompt: '工作时间内每半小时巡检一次看板阻塞项，有超时未处理的单据就催办。',
          deliver: 'webchat',
          enabled: true,
          oneshot: false,
          nextRunAt: agoIso(-20 * MIN),
          lastRunAt: agoIso(10 * MIN),
        },
      ]),
    },
    render: () => shell('cron'),
  },

  // ── 技能工作台五页签 ──
  {
    id: 'manage-skill-workbench-body',
    label: '技能工作台 · 正文页签（可写）',
    group: '管理中心',
    viewports: ['desktop', 'mobile'],
    api: skillBase,
    render: () => workbench('body'),
  },
  {
    id: 'manage-skill-workbench-readonly',
    label: '技能工作台 · 只读技能（disabled Textarea 50% 透明）',
    group: '管理中心',
    viewports: ['desktop', 'mobile'],
    api: {
      ...skillBase,
      getSkill: ok(SKILL_DETAIL_READONLY),
      getSkillHistory: ok({ history: [], writable: false }),
    },
    render: () => workbench('body', { skillName: 'longform-infographic' }),
  },
  {
    id: 'manage-skill-workbench-files',
    label: '技能工作台 · 文件页签（选中一个辅助文件）',
    group: '管理中心',
    viewports: ['desktop', 'mobile'],
    api: skillBase,
    render: () => (
      <AutoClick steps={[{ selector: '#skill-workbench-panel-files button.font-mono' }]}>
        {workbench('files')}
      </AutoClick>
    ),
  },
  {
    id: 'manage-skill-workbench-evals',
    label: '技能工作台 · 评测页签（2 个用例 + 上次结果）',
    group: '管理中心',
    viewports: ['desktop', 'mobile'],
    api: skillBase,
    render: () => workbench('evals'),
  },
  {
    id: 'manage-skill-workbench-train-draft',
    label: '技能工作台 · 训练优化（草稿就绪 · 行级 diff + 评测门）',
    group: '管理中心',
    viewports: ['desktop', 'mobile'],
    api: {
      ...skillBase,
      listSkillTrainRuns: ok([TRAIN_RUN_DRAFT]),
      getSkillTrainRun: ok(TRAIN_RUN_DRAFT),
      listSkillDrafts: ok([TRAIN_DRAFT_SUMMARY]),
      getSkillDraft: ok(TRAIN_DRAFT_DETAIL),
      getSkillEvalRun: ok(EVAL_GATE_RUN),
    },
    render: () => workbench('train'),
  },
  {
    id: 'manage-skill-workbench-history',
    label: '技能工作台 · 历史页签',
    group: '管理中心',
    api: skillBase,
    render: () => workbench('history'),
  },

  // ── 全面优化二级状态 ──
  {
    id: 'manage-optimization-diff',
    label: '全面优化 · 建议 Diff 弹层',
    group: '管理中心',
    viewports: ['desktop', 'mobile'],
    api: optimizationBase,
    render: () => (
      <AutoClick steps={[{ text: '把「母婴医疗内容必须附权威源' }]}>
        {shell('optimization')}
      </AutoClick>
    ),
  },
  {
    id: 'manage-optimization-conflict',
    label: '全面优化 · 有冲突的建议弹层',
    group: '管理中心',
    api: optimizationBase,
    render: () => (
      <AutoClick steps={[{ text: '更新用户画像中的沟通偏好' }]}>{shell('optimization')}</AutoClick>
    ),
  },

  // ── 插件账号：扫码授权中间态 / 失败态 / 写入免责确认 ──
  {
    id: 'manage-connectors-qr-waiting',
    label: '插件账号 · 知识星球扫码授权（等待扫码）',
    group: '管理中心',
    viewports: ['desktop', 'mobile'],
    api: connectorsKpBase,
    render: () => (
      <AutoClick steps={[{ text: '微信扫码授权' }, { text: '同意并生成二维码', delay: 260 }]}>
        {shell('connectors')}
      </AutoClick>
    ),
  },
  {
    id: 'manage-connectors-qr-expired',
    label: '插件账号 · 扫码授权失败（二维码过期）',
    group: '管理中心',
    api: {
      ...connectorsKpBase,
      startKnowledgePlanetSetup: ok(KP_SETUP_EXPIRED),
      getKnowledgePlanetSetup: ok(KP_SETUP_EXPIRED),
    },
    render: () => (
      <AutoClick steps={[{ text: '微信扫码授权' }, { text: '同意并生成二维码', delay: 260 }]}>
        {shell('connectors')}
      </AutoClick>
    ),
  },
  {
    id: 'manage-connectors-write-consent',
    label: '插件账号 · 开启写入能力的免责确认弹层',
    group: '管理中心',
    viewports: ['desktop', 'mobile'],
    api: {
      ...connectorsKpBase,
      getPluginManagement: ok({
        catalog: [KP_CATALOG],
        accounts: [KP_ACCOUNT_WRITE_OFF],
      } as PluginManagementResponse),
    },
    render: () => (
      <AutoClick steps={[{ selector: '[role="switch"][aria-label$="写入能力"]' }]}>
        {shell('connectors')}
      </AutoClick>
    ),
  },

  // ── 工作项目作用域 ──
  {
    id: 'manage-skills-workscope',
    label: '技能 · 工作项目作用域（项目专属技能勾选块）',
    group: '管理中心',
    viewports: ['desktop', 'mobile'],
    api: {
      ...skillBase,
      listSkills: ok(SKILLS_FOR_OVERLAY),
      getSkillEvals: ok({ evals: { version: 1, cases: [] }, writable: true, lastRun: null }),
    },
    render: () => scoped(CHAT_BOUND.id, [CHAT_BOUND], BOARD_WORK, shell('skills')),
  },
  {
    // B 阶段（M-06）后该块默认折叠成一行摘要；这条把它点开，看清单的 after 形态。
    id: 'manage-skills-workscope-open',
    label: '技能 · 工作项目作用域（项目专属技能块展开：Switch + 展示名 + 密钥类徽章）',
    group: '管理中心',
    viewports: ['desktop', 'mobile'],
    api: {
      ...skillBase,
      listSkills: ok(SKILLS_FOR_OVERLAY),
      getSkillEvals: ok({ evals: { version: 1, cases: [] }, writable: true, lastRun: null }),
    },
    render: () =>
      scoped(
        CHAT_BOUND.id,
        [CHAT_BOUND],
        BOARD_WORK,
        <AutoClick
          steps={[{ selector: '[data-testid="project-skill-overlay-toggle"]', delay: 420 }]}
        >
          {shell('skills')}
        </AutoClick>,
      ),
  },
  {
    id: 'manage-memory-workscope',
    label:
      '记忆 · 工作项目作用域（追加项目资产 + Agent 项目上下文预览；核心记忆置空好让追加块进视口）',
    group: '管理中心',
    viewports: ['desktop', 'mobile'],
    api: {
      ...memoryBase,
      getMemoryIndex: ok({
        kind: 'index',
        version: '',
        text: '',
        files: [],
      } as MemoryIndexResponse),
    },
    render: () => scoped(CHAT_BOUND.id, [CHAT_BOUND], BOARD_WORK, shell('memory')),
  },
  {
    id: 'manage-memory-workscope-project',
    label: '记忆 · 项目记忆页签（生效中 + 早前待确认）',
    group: '管理中心',
    api: memoryBase,
    render: () =>
      scoped(
        CHAT_BOUND.id,
        [CHAT_BOUND],
        BOARD_WORK,
        <AutoClick steps={[{ selector: '#memory-section-tab-project', delay: 320 }]}>
          {shell('memory')}
        </AutoClick>,
      ),
  },
  {
    id: 'manage-memory-workscope-appendix',
    label:
      '记忆 · 工作项目作用域下追加的两块面板（项目资产 / Agent 项目上下文预览，单独铺开看文案）',
    group: '管理中心',
    viewports: ['desktop', 'mobile'],
    api: memoryBase,
    render: () =>
      scoped(
        CHAT_BOUND.id,
        [CHAT_BOUND],
        BOARD_WORK,
        // 这两块在真实壳里挂在核心记忆列表之后（定高壳内要滚一屏才看得到），这里裸铺出来。
        <div className="mx-auto max-w-2xl bg-surface p-4 text-fg">
          <ProjectAssetsManagePanel auth={auth} />
          <AgentProjectPreview auth={auth} agentId="main" />
        </div>,
      ),
  },
  {
    id: 'manage-cron-chatscope',
    label: '定时任务 · 未绑定聊天项目（cronBlocked 分支：提示未渲染，落成空态）',
    group: '管理中心',
    api: cronBase,
    render: () =>
      scoped(
        CHAT_UNBOUND.id,
        [CHAT_UNBOUND],
        { ...QUIET, '/api/board/projects': { items: [] } },
        shell('cron'),
      ),
  },
]
