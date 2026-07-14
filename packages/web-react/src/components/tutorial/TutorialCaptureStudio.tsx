/**
 * 仅供 `npm run tutorials:media` 使用的确定性截图舞台。
 *
 * 它复用生产 Sidebar / ChatHeader / Composer / AgentPicker / RepoPill / Tabs 等真实组件，
 * 再用静态 fixture 隔离网络和用户数据。tutorial-capture.html 不在生产 Vite input 中，
 * 不进入线上 dist；生成脚本逐帧传入 step，得到可复现的本地 WebP + VP8 WebM。
 */
import {
  Bell,
  BookOpen,
  Bot,
  Brain,
  Building2,
  CalendarClock,
  Check,
  CircleDollarSign,
  Cloud,
  FileSpreadsheet,
  FileText,
  GitBranch,
  KeyRound,
  Library,
  type LucideIcon,
  Mail,
  MessageCircle,
  Plug,
  Search,
  ShieldCheck,
  Sparkles,
  Store,
  Upload,
  UserPlus,
  Users,
  WandSparkles,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { DEFAULT_AGENT } from '../../lib/agents'
import { PRODUCT_CAPABILITIES, type ProductFeatureId } from '../../lib/productCapabilities'
import type { PublicModel, RepoSelection, Session, User } from '../../lib/types'
import { AgentPicker } from '../AgentPicker'
import { ChatHeader } from '../ChatHeader'
import { Composer } from '../Composer'
import { Sidebar } from '../Sidebar'
import { RepoPill } from '../github/RepoPill'
import { Badge, Button, Tabs } from '../ui'

const SCENES = [
  'workspace',
  'composer',
  'research',
  'agents',
  'manage',
  'market',
  'settings',
  'organization',
  'github',
] as const
type Scene = (typeof SCENES)[number]

const MODELS: PublicModel[] = [
  { id: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol', supported_efforts: ['low', 'medium', 'high'] },
  { id: 'deepseek-v4', display_name: 'DeepSeek V4', supported_efforts: ['medium', 'high'] },
]

const USER: User = {
  id: 'tutorial-user',
  displayName: '林晓',
  email: 'lin@example.com',
  roles: ['user'],
  role: 'user',
  credits: '1280',
  org: {
    id: 'org-demo',
    name: '星河产品组',
    role: 'owner',
    status: 'active',
    billing_enabled: true,
  },
}

const SESSIONS: Session[] = [
  {
    id: 's1',
    title: '季度经营复盘',
    ownerUserId: USER.id,
    updatedAt: new Date().toISOString(),
    messageCount: 18,
  },
  {
    id: 's2',
    title: '移动端体验优化',
    ownerUserId: USER.id,
    updatedAt: new Date(Date.now() - 86_400_000).toISOString(),
    messageCount: 12,
  },
  {
    id: 's3',
    title: '竞品与行业调研',
    ownerUserId: USER.id,
    updatedAt: new Date(Date.now() - 172_800_000).toISOString(),
    messageCount: 27,
  },
]

function asScene(value: string): Scene {
  return (SCENES as readonly string[]).includes(value) ? (value as Scene) : 'workspace'
}

function clampStep(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(12, Math.round(value))) : 0
}

export function TutorialCaptureStudio({
  scene: rawScene,
  step: rawStep,
}: { scene: string; step: number }) {
  const scene = asScene(rawScene)
  const step = clampStep(rawStep)
  const phase = Math.min(2, Math.floor(step / 4))
  return (
    <div
      data-tutorial-capture
      className="relative h-[540px] w-[960px] overflow-hidden bg-bg text-fg"
    >
      <style>{`
        [data-tutorial-capture] *,
        [data-tutorial-capture] *::before,
        [data-tutorial-capture] *::after {
          animation: none !important;
          transition: none !important;
          caret-color: transparent !important;
        }
      `}</style>
      {scene === 'workspace' && <WorkspaceScene step={step} />}
      {scene === 'composer' && <ComposerScene step={step} phase={phase} />}
      {scene === 'agents' && <AgentScene step={step} phase={phase} />}
      {scene === 'github' && <GithubScene step={step} phase={phase} />}
      {scene === 'manage' && <CenterScene kind="manage" step={step} phase={phase} />}
      {scene === 'research' && <CenterScene kind="research" step={step} phase={phase} />}
      {scene === 'market' && <CenterScene kind="market" step={step} phase={phase} />}
      {scene === 'settings' && <CenterScene kind="settings" step={step} phase={phase} />}
      {scene === 'organization' && <CenterScene kind="organization" step={step} phase={phase} />}
      <CaptureLabel scene={scene} step={step} />
    </div>
  )
}

function WorkspaceChrome({
  children,
  teamMode = false,
}: { children: ReactNode; teamMode?: boolean }) {
  return (
    <div className="flex h-full bg-bg">
      <Sidebar
        sessions={SESSIONS}
        activeId="s1"
        user={USER}
        credits={USER.credits}
        onSelect={() => {}}
        onNew={() => {}}
        onRename={() => {}}
        onDelete={() => {}}
        onCollapse={() => {}}
        onLogout={() => {}}
        onOpenAccount={() => {}}
        onOpenManage={() => {}}
        onOpenMarketplace={() => {}}
        onOpenTutorial={() => {}}
        onOpenOrg={() => {}}
      />
      <main className="flex min-w-0 flex-1 flex-col bg-bg">
        <ChatHeader
          agent={DEFAULT_AGENT}
          onAgentClick={() => {}}
          models={MODELS}
          selectedModelId="gpt-5.6-sol"
          onSelectModel={() => {}}
          teamModeActive={teamMode}
          onDisableTeamMode={() => {}}
          credits={USER.credits}
          onOpenBilling={() => {}}
          onNew={() => {}}
          onOpenInbox={() => {}}
          onOpenTutorial={() => {}}
          unreadCount={2}
          theme="light"
          onCycleTheme={() => {}}
        />
        {children}
      </main>
    </div>
  )
}

function WorkspaceScene({ step }: { step: number }) {
  const answerVisible = step >= 7
  return (
    <WorkspaceChrome>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex-1 overflow-hidden px-10 pt-12">
          <div className="mx-auto max-w-2xl">
            <p className="ml-auto w-fit max-w-[75%] rounded-2xl rounded-br-md bg-bubble px-4 py-3 text-[14px] leading-6">
              把这份季度数据整理成给管理层看的复盘，先给结论，再给三项行动建议。
            </p>
            <div className="mt-6 flex gap-3">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-grad-cta text-white">
                <Sparkles size={16} />
              </span>
              <div className="min-w-0 flex-1 text-[14px] leading-6 text-muted">
                {answerVisible ? (
                  <div className="animate-in">
                    <p className="font-semibold text-fg">经营复盘已整理完成</p>
                    <div className="mt-3 grid grid-cols-3 gap-2">
                      {[
                        ['营收', '+18.6%'],
                        ['续费率', '91.2%'],
                        ['新增客户', '47'],
                      ].map(([label, value]) => (
                        <div
                          key={label}
                          className="rounded-xl border border-border bg-surface p-3 shadow-sm"
                        >
                          <p className="text-[11px] text-faint">{label}</p>
                          <p className="mt-1 text-[18px] font-semibold text-fg">{value}</p>
                        </div>
                      ))}
                    </div>
                    <p className="mt-3">已生成完整报告与行动清单，可继续修改或下载。</p>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 rounded-xl border border-border bg-surface px-4 py-3 shadow-sm">
                    <span className="size-2 rounded-full bg-accent" /> 正在读取数据并组织复盘结构…
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
        <div className="pb-5">
          <Composer
            onSend={() => {}}
            onUpload={async () => ({
              kind: 'file',
              path: '/demo.xlsx',
              name: '季度数据.xlsx',
              mime: 'application/vnd.ms-excel',
              size: 1024,
            })}
            getVoiceToken={() => 'demo'}
          />
        </div>
      </div>
      <CapturePointer
        x={step < 4 ? 490 : step < 8 ? 660 : 810}
        y={step < 4 ? 475 : step < 8 ? 90 : 300}
      />
    </WorkspaceChrome>
  )
}

function ComposerScene({ step, phase }: { step: number; phase: number }) {
  const prompt =
    phase === 0
      ? '分析附件里的销售数据，找出异常变化'
      : phase === 1
        ? '分析附件里的销售数据，按地区生成对比图，并把异常订单单独列出'
        : '分析附件里的销售数据，按地区生成对比图，并交付一份可下载的 Excel 报告'
  const repo: RepoSelection = { selected: false }
  return (
    <WorkspaceChrome>
      <div className="flex flex-1 flex-col justify-center px-10 pb-12">
        <div className="mx-auto mb-8 w-full max-w-3xl">
          <Badge tone="accent">输入材料与要求</Badge>
          <h1 className="mt-3 text-[27px] font-bold tracking-tight">
            把文件、图片和语音一起交给 AI
          </h1>
          <p className="mt-2 text-[14px] text-muted">
            附件是材料，输入框里写目标、范围和交付格式；发送前都可以继续修改。
          </p>
          <div className="mt-5 flex gap-3">
            {[
              [FileSpreadsheet, '销售明细.xlsx', phase >= 1],
              [FileText, '产品说明.pdf', phase >= 2],
            ].map(([Icon, label, active]) => {
              const ItemIcon = Icon as LucideIcon
              return (
                <div
                  key={String(label)}
                  className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-[12px] ${active ? 'border-accent/40 bg-accent-soft text-accent' : 'border-border bg-surface text-muted'}`}
                >
                  <ItemIcon size={15} />
                  {String(label)}
                  {active && <Check size={13} />}
                </div>
              )
            })}
          </div>
        </div>
        <Composer
          onSend={() => {}}
          onUpload={async (file) => ({
            kind: 'file',
            path: `/demo/${file.name}`,
            name: file.name,
            mime: file.type,
            size: file.size,
          })}
          getVoiceToken={() => 'demo'}
          prefill={{ text: prompt, nonce: step }}
          repoSelection={repo}
          onOpenRepo={() => {}}
        />
      </div>
      <CapturePointer x={phase === 0 ? 366 : phase === 1 ? 585 : 830} y={phase === 0 ? 426 : 426} />
    </WorkspaceChrome>
  )
}

function AgentScene({ step, phase }: { step: number; phase: number }) {
  return (
    <WorkspaceChrome teamMode={phase >= 2}>
      <div className="flex flex-1 items-center justify-center text-muted">
        选择专属智能体，或让团队模式自动分工。
      </div>
      <AgentPicker
        open
        current={DEFAULT_AGENT}
        auth={null}
        teamMode={phase >= 2}
        onClose={() => {}}
        onPick={() => {}}
        onAddFromMarket={() => {}}
        onToggleTeamMode={() => {}}
      />
      <CapturePointer x={phase < 2 ? 585 : 676} y={phase < 2 ? 240 : 341} />
    </WorkspaceChrome>
  )
}

function GithubScene({ step, phase }: { step: number; phase: number }) {
  const selection: RepoSelection | null =
    phase === 0
      ? null
      : {
          selected: true,
          owner: 'aurora-labs',
          repo: 'product-web',
          branch: phase === 1 ? 'main' : 'fix/mobile-nav',
          status: phase === 1 ? 'cloning' : 'ready',
          selection_version: 1,
        }
  return (
    <WorkspaceChrome>
      <div className="flex flex-1 flex-col items-center justify-center px-10 pb-8">
        <div className="w-[560px] rounded-2xl border border-border bg-surface p-5 shadow-float">
          <div className="flex items-center gap-3">
            <span className="flex size-10 items-center justify-center rounded-xl bg-[#181717] text-white">
              <GitBranch size={20} />
            </span>
            <div>
              <h2 className="text-[16px] font-semibold">连接 GitHub 仓库</h2>
              <p className="text-[12px] text-muted">当前会话独立绑定，不影响其他项目</p>
            </div>
          </div>
          <div className="mt-5 grid grid-cols-2 gap-3">
            <DemoField
              label="仓库"
              value={phase === 0 ? '搜索 owner/repo' : 'aurora-labs/product-web'}
              active={phase === 0}
            />
            <DemoField
              label="工作分支"
              value={phase < 2 ? 'main' : 'fix/mobile-nav'}
              active={phase === 1}
            />
          </div>
          <div className="mt-4 flex items-center justify-between rounded-xl bg-hover px-4 py-3 text-[12px]">
            <span className="text-muted">
              {phase < 2 ? '先授权，再确认仓库与分支' : '仓库已就绪，可以读取、测试与提交代码'}
            </span>
            <Button size="sm" variant="primary">
              {phase === 0 ? '连接 GitHub' : phase === 1 ? '正在准备…' : '开始编程'}
            </Button>
          </div>
        </div>
        <div className="mt-5 w-[560px] rounded-xl border border-border bg-surface px-4 py-3">
          <RepoPill selection={selection} onClick={() => {}} />
        </div>
      </div>
      <CapturePointer
        x={phase === 0 ? 720 : phase === 1 ? 625 : 515}
        y={phase === 0 ? 333 : phase === 1 ? 265 : 400}
      />
    </WorkspaceChrome>
  )
}

type CenterKind = 'manage' | 'research' | 'market' | 'settings' | 'organization'

const CENTER_META: Record<CenterKind, { title: string; subtitle: string; icon: LucideIcon }> = {
  manage: { title: '管理中心', subtitle: '管理会长期复用的能力与自动化', icon: Brain },
  research: { title: '文献库', subtitle: '沉淀可重复引用的研究材料', icon: Library },
  market: { title: 'AI 市场', subtitle: '发现、安装并发布专业能力', icon: Store },
  settings: { title: '设置', subtitle: '账户、用量、偏好与反馈', icon: CircleDollarSign },
  organization: { title: '星河产品组', subtitle: '成员、共享额度、报表与发票', icon: Building2 },
}

function CenterScene({ kind, step, phase }: { kind: CenterKind; step: number; phase: number }) {
  const meta = CENTER_META[kind]
  const Icon = meta.icon
  const config = centerConfig(kind, phase)
  return (
    <WorkspaceChrome>
      <div className="absolute inset-0 bg-black/25 backdrop-blur-[1px]" />
      <div className="absolute left-[310px] right-[42px] top-[42px] bottom-[36px] flex flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-float">
        <header className="flex items-center gap-3 px-6 py-4">
          <span className="flex size-10 items-center justify-center rounded-xl bg-accent-soft text-accent">
            <Icon size={19} />
          </span>
          <div>
            <h1 className="text-[16px] font-semibold">{meta.title}</h1>
            <p className="text-[12px] text-faint">{meta.subtitle}</p>
          </div>
          <Badge tone="accent" className="ml-auto">
            真实功能演示
          </Badge>
        </header>
        <div className="border-b border-border px-5 pb-3">
          <Tabs
            value={config.tabs[phase].value}
            onValueChange={() => {}}
            items={config.tabs}
            aria-label={`${meta.title}分区`}
          />
        </div>
        <div className="min-h-0 flex-1 overflow-hidden bg-bg/60 p-5">
          <div className="grid h-full grid-cols-[1.35fr_.85fr] gap-4">
            <section className="rounded-2xl border border-border bg-surface p-5 shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-[11px] font-medium uppercase tracking-[.12em] text-accent">
                    {config.eyebrow}
                  </p>
                  <h2 className="mt-1 text-[20px] font-semibold tracking-tight">
                    {config.headings[phase]}
                  </h2>
                </div>
                <Button size="sm" variant="primary">
                  <config.actionIcon size={14} />
                  {config.actions[phase]}
                </Button>
              </div>
              <p className="mt-2 text-[13px] leading-5 text-muted">{config.descriptions[phase]}</p>
              <div className="mt-5 flex flex-col gap-2.5">
                {config.rows[phase].map((row, index) => (
                  <DemoRow
                    key={row.title}
                    {...row}
                    active={index === step % rowModulo(config.rows[phase].length)}
                  />
                ))}
              </div>
            </section>
            <aside className="flex flex-col gap-3">
              {config.metrics.map((metric, index) => (
                <div
                  key={metric.label}
                  className={`rounded-2xl border bg-surface p-4 transition-colors ${index === phase ? 'border-accent/40 shadow-sm' : 'border-border'}`}
                >
                  <p className="text-[11px] text-faint">{metric.label}</p>
                  <p className="mt-1 text-[22px] font-semibold tracking-tight">{metric.value}</p>
                  <p className="mt-1 text-[11px] text-muted">{metric.note}</p>
                </div>
              ))}
            </aside>
          </div>
        </div>
      </div>
      <CapturePointer
        x={phase === 0 ? 420 : phase === 1 ? 555 : 690}
        y={phase === 0 ? 119 : phase === 1 ? 119 : 119}
      />
    </WorkspaceChrome>
  )
}

type DemoRowData = { icon: LucideIcon; title: string; detail: string; badge?: string }

function centerConfig(
  kind: CenterKind,
  phase: number,
): {
  tabs: { value: string; label: string; featureId?: ProductFeatureId }[]
  eyebrow: string
  headings: [string, string, string]
  descriptions: [string, string, string]
  actions: [string, string, string]
  actionIcon: LucideIcon
  rows: [DemoRowData[], DemoRowData[], DemoRowData[]]
  metrics: { label: string; value: string; note: string }[]
} {
  if (kind === 'manage')
    return {
      tabs: [
        { value: 'memory', label: '记忆', featureId: PRODUCT_CAPABILITIES.memory.id },
        { value: 'cron', label: '定时任务', featureId: PRODUCT_CAPABILITIES.schedules.id },
        { value: 'skills', label: '技能', featureId: PRODUCT_CAPABILITIES.skills.id },
      ],
      eyebrow: '自动化与复用',
      headings: ['长期记忆', '定时任务', '技能与训练'],
      descriptions: [
        '查看助手记住的偏好和项目事实，并随时校正。',
        '让智能体按一次性或周期计划自动执行任务。',
        '把成功做法固化为技能，并用评测持续优化。',
      ],
      actions: ['新增记忆', '创建任务', '运行评测'],
      actionIcon: phase === 1 ? CalendarClock : WandSparkles,
      rows: [
        [
          { icon: Brain, title: '沟通偏好', detail: '优先结论与可量化指标', badge: '用户偏好' },
          {
            icon: FileText,
            title: 'Aurora v5 项目',
            detail: '移动优先 · 保持测试覆盖',
            badge: '项目',
          },
          {
            icon: Sparkles,
            title: 'Auto-Dream 报告',
            detail: '昨晚整理 3 条，待审阅',
            badge: '新',
          },
        ],
        [
          {
            icon: CalendarClock,
            title: '工作日经营摘要',
            detail: '下次：今天 17:30',
            badge: '运行中',
          },
          { icon: Bell, title: '周一项目风险提醒', detail: '下次：周一 09:00' },
          { icon: Mail, title: '月度客户回访清单', detail: '每月 1 日 10:00' },
        ],
        [
          {
            icon: WandSparkles,
            title: '经营复盘生成器',
            detail: '评测 18/20 通过',
            badge: '可优化',
          },
          { icon: FileSpreadsheet, title: 'Excel 异常分析', detail: '评测 12/12 通过' },
          { icon: Bot, title: '版本发布检查', detail: '最近运行：2 小时前' },
        ],
      ],
      metrics: [
        { label: '长期记忆', value: '36', note: '4 类可逐条管理' },
        { label: '活动任务', value: '8', note: '失败会进入站内信' },
        { label: '个人技能', value: '12', note: '3 个有训练草稿' },
      ],
    }
  if (kind === 'research')
    return {
      tabs: [
        { value: 'library', label: '文献库', featureId: PRODUCT_CAPABILITIES.research.id },
        { value: 'search', label: '联网调研', featureId: PRODUCT_CAPABILITIES.research.id },
        { value: 'export', label: '引用导出', featureId: PRODUCT_CAPABILITIES.artifacts.id },
      ],
      eyebrow: '证据链',
      headings: ['权威资料库', '联网检索与核对', '导出研究成果'],
      descriptions: [
        '上传论文和报告，保留来源、页码与结构化大纲。',
        '优先查官方和一手来源，并区分事实与推断。',
        '把引用、BibTeX 和完整报告交付为可下载文件。',
      ],
      actions: ['上传文档', '开始调研', '导出报告'],
      actionIcon: phase === 0 ? Upload : phase === 1 ? Search : FileText,
      rows: [
        [
          {
            icon: FileText,
            title: '2026 AI 办公趋势白皮书.pdf',
            detail: '48 页 · 已建立大纲',
            badge: '已解析',
          },
          { icon: Library, title: '企业知识助手评测方法.pdf', detail: '论文 · 22 个引用' },
          { icon: FileSpreadsheet, title: '竞品功能矩阵.xlsx', detail: '更新于今天' },
        ],
        [
          { icon: ShieldCheck, title: '官方产品公告', detail: '12 个一手来源', badge: '优先' },
          { icon: Cloud, title: '行业新闻与访谈', detail: '已交叉核对发布时间' },
          { icon: Search, title: '关键结论', detail: '事实 18 条 · 推断 4 条' },
        ],
        [
          {
            icon: FileText,
            title: '竞品调研报告.docx',
            detail: '含结论、表格与引用',
            badge: '可下载',
          },
          { icon: Library, title: 'references.bib', detail: '32 条 BibTeX' },
          { icon: FileSpreadsheet, title: 'source-matrix.xlsx', detail: '来源与主张映射' },
        ],
      ],
      metrics: [
        { label: '库内文档', value: '42', note: '可在后续会话复用' },
        { label: '有效来源', value: '32', note: '已去重并标日期' },
        { label: '引用覆盖', value: '96%', note: '关键结论可回查' },
      ],
    }
  if (kind === 'market')
    return {
      tabs: [
        { value: 'browse', label: '发现', featureId: PRODUCT_CAPABILITIES.marketplace.id },
        { value: 'installed', label: '已安装', featureId: PRODUCT_CAPABILITIES.marketplace.id },
        { value: 'publish', label: '发布', featureId: PRODUCT_CAPABILITIES.publish.id },
      ],
      eyebrow: '扩展能力',
      headings: ['为任务找到专业能力', '维护已安装能力', '创建并发布作品'],
      descriptions: [
        '按技能、智能体和连接器筛选，先看场景、权限与评测。',
        '集中更新、配置和卸载，让选择列表保持清晰。',
        '版本化提交作品，查看自动审核状态与改进理由。',
      ],
      actions: ['AI 帮我找', '检查更新', '创建作品'],
      actionIcon: phase === 0 ? Search : phase === 1 ? WandSparkles : Upload,
      rows: [
        [
          {
            icon: FileSpreadsheet,
            title: '数据分析工作流',
            detail: '输入表格，交付图表与异常清单',
            badge: '官方',
          },
          { icon: Bot, title: '产品经理智能体', detail: '需求、竞品与路线图' },
          { icon: Plug, title: 'Notion 连接器', detail: '读取页面 · 写入需确认' },
        ],
        [
          { icon: Check, title: '版本发布检查', detail: 'v2.4 · 已是最新版', badge: '已安装' },
          { icon: Bot, title: '科研助手', detail: 'v1.8 → v1.9 可更新' },
          { icon: Plug, title: 'WebDAV', detail: '已绑定：工作资料库' },
        ],
        [
          { icon: WandSparkles, title: '经营复盘生成器', detail: '草稿 · 评测 18/20' },
          { icon: Bot, title: '客户成功助手', detail: '审核中', badge: '待审核' },
          { icon: Plug, title: '内部 CRM', detail: '需补充域名与写操作说明' },
        ],
      ],
      metrics: [
        { label: '精选能力', value: '128', note: '技能、智能体、连接器' },
        { label: '已安装', value: '17', note: '2 个有更新' },
        { label: '我的发布', value: '6', note: '状态持续可见' },
      ],
    }
  if (kind === 'settings')
    return {
      tabs: [
        { value: 'account', label: '账户与计费', featureId: PRODUCT_CAPABILITIES.billing.id },
        { value: 'usage', label: '用量', featureId: PRODUCT_CAPABILITIES.billing.id },
        { value: 'preferences', label: '偏好', featureId: PRODUCT_CAPABILITIES.preferences.id },
      ],
      eyebrow: '账户与体验',
      headings: ['积分与套餐', '看懂每一笔用量', '设置默认工作方式'],
      descriptions: [
        '区分套餐期内积分与长期钱包，安全管理充值和 API Key。',
        '按时间、模型和会话拆解 Token、缓存与积分消耗。',
        '同步主题、默认模型、思考深度、通知和 Auto-Dream。',
      ],
      actions: ['管理套餐', '查看明细', '保存偏好'],
      actionIcon: phase === 0 ? CircleDollarSign : phase === 1 ? FileSpreadsheet : Check,
      rows: [
        [
          {
            icon: CircleDollarSign,
            title: '本期积分',
            detail: '1,280 · 8 月 1 日重置',
            badge: '优先消耗',
          },
          { icon: KeyRound, title: 'API Key', detail: '2 个有效 · 可随时撤销' },
          { icon: FileText, title: '订单与流水', detail: '最近到账：¥50.00' },
        ],
        [
          { icon: Sparkles, title: 'GPT-5.6-Sol', detail: '本周 426 积分', badge: '52%' },
          { icon: Bot, title: 'DeepSeek V4', detail: '本周 221 积分' },
          { icon: MessageCircle, title: '季度经营复盘', detail: '86 积分 · 缓存命中 71%' },
        ],
        [
          { icon: Sparkles, title: '默认模型', detail: 'GPT-5.6-Sol · 中等思考' },
          { icon: Cloud, title: '外观', detail: '跟随系统' },
          { icon: Bell, title: '通知', detail: '任务送达与余额提醒' },
        ],
      ],
      metrics: [
        { label: '可用积分', value: '1,280', note: '长期钱包另有 500' },
        { label: '近 7 天', value: '647', note: '较上周下降 12%' },
        { label: '缓存命中', value: '68%', note: '长上下文复用' },
      ],
    }
  return {
    tabs: [
      { value: 'overview', label: '概览', featureId: PRODUCT_CAPABILITIES.organization.id },
      { value: 'members', label: '成员', featureId: PRODUCT_CAPABILITIES.organization.id },
      { value: 'reports', label: '报表', featureId: PRODUCT_CAPABILITIES.organization.id },
    ],
    eyebrow: '企业协作',
    headings: ['组织共享权益', '成员、角色与限额', '团队用量与发票'],
    descriptions: [
      '统一管理席位、组织积分池和企业套餐状态。',
      '按最小权限邀请成员，并为每人设置月度预算。',
      '按成员和模型核对消耗，再对符合条件的订单申请开票。',
    ],
    actions: ['增加席位', '邀请成员', '导出报表'],
    actionIcon: phase === 0 ? CircleDollarSign : phase === 1 ? UserPlus : FileSpreadsheet,
    rows: [
      [
        { icon: Users, title: '企业专业版', detail: '8 / 10 席位', badge: '有效' },
        { icon: CircleDollarSign, title: '组织积分池', detail: '12,480 积分' },
        { icon: WandSparkles, title: '组织技能', detail: '9 个成员共享' },
      ],
      [
        { icon: ShieldCheck, title: '林晓', detail: '拥有者 · 本月 842 积分', badge: '管理员' },
        { icon: Users, title: '陈雨', detail: '成员 · 限额 1,500' },
        { icon: Users, title: '周航', detail: '成员 · 限额 1,000' },
      ],
      [
        {
          icon: FileSpreadsheet,
          title: '7 月组织用量',
          detail: '6,482 积分 · 8 名成员',
          badge: '可导出',
        },
        { icon: CircleDollarSign, title: '企业专业版订单', detail: '¥2,980.00 · 可开票' },
        { icon: FileText, title: '发票抬头', detail: '江西星河智能科技有限公司' },
      ],
    ],
    metrics: [
      { label: '有效成员', value: '8', note: '剩余 2 个席位' },
      { label: '共享积分', value: '12,480', note: '按成员限额结算' },
      { label: '本月消耗', value: '6,482', note: '报表可导出' },
    ],
  }
}

function rowModulo(length: number): number {
  return Math.max(1, length)
}

function DemoRow({ icon: Icon, title, detail, badge, active }: DemoRowData & { active?: boolean }) {
  return (
    <div
      className={`flex items-center gap-3 rounded-xl border px-3 py-2.5 transition-colors ${active ? 'border-accent/40 bg-accent-soft' : 'border-border bg-bg'}`}
    >
      <span className="flex size-8 items-center justify-center rounded-lg bg-surface text-accent shadow-sm">
        <Icon size={15} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium">{title}</p>
        <p className="truncate text-[11px] text-faint">{detail}</p>
      </div>
      {badge && <Badge tone="accent">{badge}</Badge>}
    </div>
  )
}

function DemoField({ label, value, active }: { label: string; value: string; active?: boolean }) {
  return (
    <div
      className={`rounded-xl border px-3 py-2.5 ${active ? 'border-accent bg-accent-soft' : 'border-border bg-bg'}`}
    >
      <p className="text-[10px] text-faint">{label}</p>
      <p className="mt-1 truncate text-[12px] font-medium">{value}</p>
    </div>
  )
}

function CapturePointer({ x, y }: { x: number; y: number }) {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute z-[100] block size-7 rounded-full border-2 border-white bg-accent/80 shadow-[0_0_0_5px_rgba(110,86,240,.2),0_5px_16px_rgba(0,0,0,.28)]"
      style={{ left: x, top: y }}
    >
      <span className="absolute left-2 top-2 size-2 rounded-full bg-white" />
    </span>
  )
}

function CaptureLabel({ scene, step }: { scene: Scene; step: number }) {
  const labels: Record<Scene, string> = {
    workspace: '工作区',
    composer: '输入与附件',
    research: '联网研究',
    agents: '智能体与团队',
    manage: '管理中心',
    market: 'AI 市场',
    settings: '设置与用量',
    organization: '组织管理',
    github: 'GitHub 仓库',
  }
  return (
    <div className="pointer-events-none absolute bottom-3 right-3 z-[120] flex items-center gap-2 rounded-full border border-white/70 bg-white/90 px-3 py-1.5 text-[11px] font-medium text-[#27272f] shadow-soft backdrop-blur">
      <BookOpen size={12} className="text-[#6e56f0]" />
      {labels[scene]}
      <span className="h-3 w-px bg-[#d9d9e1]" />
      <span className="tabular-nums text-[#8b8b97]">{step + 1}/13</span>
    </div>
  )
}
