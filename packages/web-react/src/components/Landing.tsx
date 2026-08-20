import {
  ArrowRight,
  BrainCircuit,
  Building2,
  Check,
  CircleCheckBig,
  Clock3,
  FileCheck2,
  Globe2,
  Layers3,
  Network,
  Puzzle,
  ReceiptText,
  Route,
  ShieldCheck,
  Sparkles,
  Users,
  Workflow,
  Zap,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import type { Theme } from '../hooks/useTheme'
import { AGENTS } from '../lib/agents'
import { api } from '../lib/api'
import { BRAND } from '../lib/brand'
import { minSeatPriceYuan } from '../lib/orgBilling'
import { AgentAvatar } from './AgentAvatar'
import { DemoShowcase } from './landing/DemoShowcase'
import { ThemeToggle } from './ThemeToggle'
import { Button, buttonVariants } from './ui'

function BrandMark({ className = 'size-9' }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`${className} grid shrink-0 place-items-center rounded-[11px] bg-[#c7ff64] text-[19px] font-black leading-none text-[#0a0b09] shadow-[0_0_30px_rgba(199,255,100,0.16)]`}
    >
      从
    </span>
  )
}

function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2.5" aria-label={BRAND.name}>
      <BrandMark className={compact ? 'size-8' : 'size-9'} />
      <span className="text-[19px] font-semibold tracking-[-0.04em] text-[#f5f4ed]">
        {BRAND.name}
      </span>
    </div>
  )
}

const WORKFLOW_STEPS = [
  {
    n: '01',
    icon: BrainCircuit,
    title: '理解目标',
    body: '读懂背景、材料、限制和你真正想要的结果。',
  },
  { n: '02', icon: Route, title: '拆解计划', body: '把复杂任务拆成可执行步骤，明确依赖与验收。' },
  {
    n: '03',
    icon: Network,
    title: '调度执行',
    body: '调用合适的模型、智能体、工具与浏览器持续推进。',
  },
  {
    n: '04',
    icon: FileCheck2,
    title: '交付成果',
    body: '返回能继续编辑、分享和使用的文件、代码与结论。',
  },
] as const

const CAPABILITIES = [
  {
    icon: Users,
    eyebrow: 'MULTI-AGENT',
    title: '一个人发令，整支团队协作',
    body: '研究、写作、设计、开发等专业智能体按需协同。你只对目标负责，从简负责组织过程。',
    tags: ['自动拆分', '并行执行', '结果汇总'],
  },
  {
    icon: Workflow,
    eyebrow: 'LONG-RUNNING',
    title: '长任务不中断，回来继续推进',
    body: '计划、进度、工具记录和阶段成果持续保存。任务不是一次性聊天，而是一条能恢复的工作流。',
    tags: ['持续任务', '断点恢复', '过程透明'],
  },
  {
    icon: FileCheck2,
    eyebrow: 'REAL OUTPUTS',
    title: '不止回答，直接交付成品',
    body: '读 PDF、Excel、图片与网页，最终交回文档、表格、演示、图表、代码和可复用的项目资产。',
    tags: ['真实文件', '可下载', '可继续修改'],
  },
] as const

const SCENARIOS = [
  {
    icon: Globe2,
    label: '调研与决策',
    prompt: '调研这个行业过去 30 天的新变化，给我一份有来源、能汇报的结论。',
    outputs: ['证据地图', '研究报告', '引用来源'],
    accent: '#79d8ff',
  },
  {
    icon: Layers3,
    label: '数据与办公',
    prompt: '分析这份经营表，找出异常、解释原因，并整理成 Excel 和汇报 PPT。',
    outputs: ['清洗表格', '可视化图表', '演示文稿'],
    accent: '#c7ff64',
  },
  {
    icon: Zap,
    label: '开发与交付',
    prompt: '接入我的仓库，重构首页，跑完测试和构建，把可以验收的版本交给我。',
    outputs: ['代码改动', '测试证据', '运行预览'],
    accent: '#f6c66a',
  },
] as const

const FAQS = [
  {
    q: '从简和普通 AI 聊天有什么不同？',
    a: '普通聊天通常停在回答；从简会围绕目标建立计划、调用工具、持续执行，并交付可直接使用的成果。',
  },
  {
    q: '需要学习提示词或配置模型吗？',
    a: '不用。像给同事派活一样说清目标、材料和交付格式即可；从简会为任务选择合适的执行方式。',
  },
  {
    q: '可以处理文件和长期项目吗？',
    a: '可以。支持文档、表格、图片、代码与网页等材料，也会持续保存项目上下文、任务进度与产出物。',
  },
  {
    q: '我的数据如何管理？',
    a: '文件与任务资料进入你的专属工作空间，仅用于完成已授权的任务；你可以随时查看和删除。',
  },
] as const

const ENTERPRISE_SELLING = [
  { icon: Layers3, title: '共享积分池', body: '团队统一额度，闲置资源自动共享。' },
  { icon: Users, title: '成员与角色', body: '按成员设置角色、权限和月度限额。' },
  { icon: ReceiptText, title: '用量与发票', body: '按成员、模型查看报表并自助开票。' },
  { icon: ShieldCheck, title: '组织级管理', body: '任务、资产和协作过程在组织内沉淀。' },
] as const

function EnterpriseSection({ onCreateOrg }: { onCreateOrg: () => void }) {
  const [anchor, setAnchor] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    api
      .listOrgPlansPublic()
      .then((plans) => {
        if (!alive) return
        const yuan = minSeatPriceYuan(plans)
        if (yuan) setAnchor(`¥${yuan}/席起`)
      })
      .catch(() => {
        // 公开档位不可用时使用下方静态锚点，不阻断营销首页。
      })
    return () => {
      alive = false
    }
  }, [])

  const members = [
    { name: '市场研究', role: '调研智能体', value: 78 },
    { name: '产品方案', role: '产品智能体', value: 62 },
    { name: '交付检查', role: '审查智能体', value: 46 },
  ] as const

  return (
    <section id="enterprise" className="congjian-section border-y border-white/8 bg-[#0d0f0c]">
      <div className="mx-auto grid max-w-6xl gap-12 px-5 py-24 lg:grid-cols-[0.9fr_1.1fr] lg:items-center">
        <div>
          <span className="congjian-kicker">
            <Building2 size={14} /> 团队与企业
          </span>
          <h2 className="mt-5 max-w-xl text-[34px] font-semibold leading-[1.12] tracking-[-0.045em] text-[#f5f4ed] md:text-[48px]">
            一个人用得顺手，
            <br />
            一支团队也用得清楚。
          </h2>
          <p className="mt-5 max-w-xl text-[16px] leading-7 text-[#aeb1a8]">
            共享额度、成员角色、用量限额、组织资产与报表放在同一处。团队把 AI
            用进日常工作，也始终保有边界和秩序。
          </p>

          <div className="mt-8 grid gap-3 sm:grid-cols-2">
            {ENTERPRISE_SELLING.map((item) => {
              const Icon = item.icon
              return (
                <div
                  key={item.title}
                  className="rounded-2xl border border-white/8 bg-white/[0.025] p-4"
                >
                  <Icon size={17} className="text-[#c7ff64]" />
                  <div className="mt-3 text-[14px] font-semibold text-[#f5f4ed]">{item.title}</div>
                  <p className="mt-1 text-[12.5px] leading-5 text-[#858a80]">{item.body}</p>
                </div>
              )
            })}
          </div>

          <div className="mt-8 flex flex-wrap items-center gap-4">
            <Button variant="primary" shape="pill" size="lg" onClick={onCreateOrg}>
              创建组织 <ArrowRight size={16} />
            </Button>
            <span className="text-[14px] text-[#8e9388]">
              <strong className="mr-1.5 text-[18px] font-semibold text-[#f5f4ed]">
                {anchor ?? '¥88/席起'}
              </strong>
              随需加席
            </span>
          </div>
        </div>

        <div className="congjian-shell overflow-hidden rounded-[28px] border border-white/10 bg-[#111410] p-3 shadow-[0_32px_100px_rgba(0,0,0,0.42)]">
          <div className="rounded-[20px] border border-white/8 bg-[#0a0c09] p-5 sm:p-6">
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-[12px] font-medium uppercase tracking-[0.16em] text-[#747a70]">
                  Team workspace
                </div>
                <h3 className="mt-1 text-[18px] font-semibold text-[#f5f4ed]">
                  增长项目 · 智能体协作
                </h3>
              </div>
              <span className="rounded-full border border-[#c7ff64]/25 bg-[#c7ff64]/10 px-2.5 py-1 text-[11px] font-medium text-[#c7ff64]">
                3 个任务运行中
              </span>
            </div>

            <div className="mt-6 space-y-3">
              {members.map((member) => (
                <div
                  key={member.name}
                  className="rounded-2xl border border-white/8 bg-white/[0.025] p-4"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-white/[0.06] text-[#c7ff64]">
                        <Sparkles size={15} />
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-[13.5px] font-medium text-[#f5f4ed]">
                          {member.name}
                        </span>
                        <span className="block truncate text-[11.5px] text-[#777d73]">
                          {member.role}
                        </span>
                      </span>
                    </div>
                    <span className="text-[12px] tabular-nums text-[#8f948a]">{member.value}%</span>
                  </div>
                  <div
                    className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/[0.06]"
                    aria-hidden
                  >
                    <div
                      className="h-full rounded-full bg-[#c7ff64]"
                      style={{ width: `${member.value}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-4 flex items-center gap-2 rounded-xl border border-white/8 bg-white/[0.025] px-3.5 py-3 text-[12px] text-[#8f948a]">
              <CircleCheckBig size={15} className="text-[#c7ff64]" />
              任务过程、成果和用量都在组织内持续沉淀
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

export function Landing(props: {
  onStart: () => void
  onLogin: () => void
  onCreateOrg: () => void
  theme: Theme
  onCycleTheme: () => void
}) {
  const { onStart, onLogin, onCreateOrg, theme, onCycleTheme } = props

  return (
    <div className="congjian-landing h-full overflow-y-auto bg-[#090a08] text-[#f5f4ed]">
      <header className="landing-safe-t sticky top-0 z-40 border-b border-white/8 bg-[#090a08]/82 backdrop-blur-2xl">
        <div className="mx-auto flex h-[68px] max-w-6xl items-center justify-between px-4 sm:px-5">
          <Logo />
          <nav
            className="hidden items-center gap-7 text-[13.5px] text-[#9da197] md:flex"
            aria-label="首页导航"
          >
            <a href="#demo" className="transition-colors hover:text-white">
              产品演示
            </a>
            <a href="#capabilities" className="transition-colors hover:text-white">
              核心能力
            </a>
            <a href="#scenarios" className="transition-colors hover:text-white">
              工作场景
            </a>
            <a href="#agents" className="transition-colors hover:text-white">
              智能体
            </a>
            <a href="#enterprise" className="transition-colors hover:text-white">
              团队版
            </a>
          </nav>
          <div className="flex shrink-0 items-center gap-1.5">
            <ThemeToggle theme={theme} onCycle={onCycleTheme} />
            <Button
              variant="ghost"
              shape="pill"
              onClick={onLogin}
              className="text-[#b7bbb2] hover:bg-white/8 hover:text-white"
            >
              登录
            </Button>
            <Button variant="primary" shape="pill" onClick={onStart}>
              免费开始
            </Button>
          </div>
        </div>
      </header>

      <main>
        <section className="congjian-grid relative overflow-hidden border-b border-white/8">
          <div aria-hidden className="congjian-hero-glow pointer-events-none absolute inset-0" />
          <div className="relative mx-auto max-w-6xl px-5 pb-12 pt-20 text-center sm:pt-28 md:pb-16">
            <span className="congjian-kicker animate-in">
              <span className="size-1.5 rounded-full bg-[#c7ff64] shadow-[0_0_12px_#c7ff64]" />
              全能 Agent 工作台 · 多模型协作
            </span>
            <h1 className="mx-auto mt-7 max-w-5xl text-balance text-[52px] font-semibold leading-[0.98] tracking-[-0.065em] text-[#f5f4ed] sm:text-[68px] md:text-[92px] animate-in">
              让复杂，<span className="congjian-hero-word">从简。</span>
            </h1>
            <p className="mx-auto mt-7 max-w-3xl text-pretty text-[17px] leading-7 text-[#aeb1a8] md:text-[19px] md:leading-8 animate-in">
              你只管说清目标。从简会拆解任务、调动合适的模型与智能体、调用工具持续执行，直到交付真正能用的文档、表格、演示、代码和结果。
            </p>
            <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row animate-in">
              <Button
                variant="primary"
                shape="pill"
                size="lg"
                onClick={onStart}
                className="group min-w-[172px]"
              >
                开始使用从简
                <ArrowRight
                  size={17}
                  className="transition-transform group-hover:translate-x-0.5"
                />
              </Button>
              <a
                href="#demo"
                className={buttonVariants({ variant: 'secondary', shape: 'pill', size: 'lg' })}
              >
                看一个真实任务
              </a>
            </div>
            <div className="mx-auto mt-8 flex max-w-3xl flex-wrap items-center justify-center gap-x-6 gap-y-2 text-[12.5px] text-[#747970]">
              {['多模型按任务切换', '智能体协同执行', '过程持续可追踪', '成果直接可使用'].map(
                (item) => (
                  <span key={item} className="inline-flex items-center gap-1.5">
                    <Check size={13} className="text-[#c7ff64]" /> {item}
                  </span>
                ),
              )}
            </div>
          </div>

          <div
            id="demo"
            className="relative mx-auto max-w-6xl scroll-mt-24 px-3 pb-20 sm:px-5 md:pb-28"
          >
            <div className="mb-4 flex items-center justify-between px-2 text-[11.5px] uppercase tracking-[0.16em] text-[#777d73]">
              <span>Product workspace</span>
              <span className="inline-flex items-center gap-1.5 normal-case tracking-normal">
                <span className="size-1.5 rounded-full bg-[#c7ff64]" /> 产品能力演示
              </span>
            </div>
            <div className="congjian-shell rounded-[28px] border border-white/12 bg-[#10120f] p-2.5 shadow-[0_48px_140px_rgba(0,0,0,0.55)] sm:p-4">
              <div className="mb-3 flex items-center gap-1.5 px-1.5 pt-0.5" aria-hidden>
                <span className="size-2.5 rounded-full bg-[#ff6b66]" />
                <span className="size-2.5 rounded-full bg-[#f6c65c]" />
                <span className="size-2.5 rounded-full bg-[#72d277]" />
                <span className="ml-3 h-5 flex-1 rounded-md border border-white/6 bg-white/[0.025]" />
              </div>
              <DemoShowcase onTry={onStart} initialScenarioId="analysis" />
            </div>
          </div>
        </section>

        <section className="congjian-section border-b border-white/8 bg-[#0c0e0b]">
          <div className="mx-auto max-w-6xl px-5 py-24">
            <div className="grid gap-12 lg:grid-cols-[0.8fr_1.2fr] lg:items-end">
              <div>
                <span className="congjian-kicker">
                  <Workflow size={14} /> 工作方式
                </span>
                <h2 className="mt-5 text-[34px] font-semibold leading-[1.1] tracking-[-0.045em] md:text-[50px]">
                  你给目标，
                  <br />
                  从简负责过程。
                </h2>
              </div>
              <p className="max-w-2xl text-[16px] leading-7 text-[#9da197] lg:justify-self-end">
                不需要先研究模型、提示词和工作流。每一个任务都沿着同一条清晰路径推进：理解、计划、执行、交付；你随时能看到它做到哪一步。
              </p>
            </div>

            <div className="mt-14 grid gap-px overflow-hidden rounded-[24px] border border-white/8 bg-white/8 md:grid-cols-4">
              {WORKFLOW_STEPS.map((step) => {
                const Icon = step.icon
                return (
                  <div key={step.n} className="relative bg-[#10120f] p-6 md:min-h-[220px]">
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-[11px] tracking-[0.14em] text-[#777d73]">
                        {step.n}
                      </span>
                      <Icon size={19} className="text-[#c7ff64]" />
                    </div>
                    <h3 className="mt-14 text-[18px] font-semibold">{step.title}</h3>
                    <p className="mt-2 text-[13.5px] leading-6 text-[#858a80]">{step.body}</p>
                  </div>
                )
              })}
            </div>
          </div>
        </section>

        <section id="capabilities" className="congjian-section border-b border-white/8">
          <div className="mx-auto max-w-6xl px-5 py-24">
            <div className="max-w-3xl">
              <span className="congjian-kicker">
                <Sparkles size={14} /> 核心能力
              </span>
              <h2 className="mt-5 text-[34px] font-semibold leading-[1.1] tracking-[-0.045em] md:text-[50px]">
                不是“问一句，答一句”。
                <br />
                而是把一件事做完。
              </h2>
            </div>

            <div className="mt-14 grid gap-4 lg:grid-cols-3">
              {CAPABILITIES.map((capability, index) => {
                const Icon = capability.icon
                return (
                  <article
                    key={capability.title}
                    className={`group relative overflow-hidden rounded-[24px] border border-white/9 bg-[#111310] p-6 transition-transform duration-300 hover:-translate-y-1 ${index === 1 ? 'lg:translate-y-8 lg:hover:translate-y-7' : ''}`}
                  >
                    <div
                      aria-hidden
                      className="absolute -right-14 -top-14 size-36 rounded-full bg-[#c7ff64]/5 blur-3xl"
                    />
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-[10.5px] tracking-[0.15em] text-[#777d73]">
                        {capability.eyebrow}
                      </span>
                      <span className="grid size-10 place-items-center rounded-xl border border-white/8 bg-white/[0.035] text-[#c7ff64]">
                        <Icon size={19} />
                      </span>
                    </div>
                    <h3 className="mt-16 text-[22px] font-semibold leading-[1.2] tracking-[-0.025em]">
                      {capability.title}
                    </h3>
                    <p className="mt-3 text-[14px] leading-6 text-[#93988f]">{capability.body}</p>
                    <div className="mt-7 flex flex-wrap gap-2">
                      {capability.tags.map((tag) => (
                        <span
                          key={tag}
                          className="rounded-full border border-white/8 bg-white/[0.025] px-2.5 py-1 text-[11px] text-[#858a80]"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  </article>
                )
              })}
            </div>
          </div>
        </section>

        <section id="scenarios" className="congjian-section border-b border-white/8 bg-[#0d0f0c]">
          <div className="mx-auto max-w-6xl px-5 py-24">
            <div className="text-center">
              <span className="congjian-kicker">
                <Zap size={14} /> 工作场景
              </span>
              <h2 className="mx-auto mt-5 max-w-3xl text-[34px] font-semibold leading-[1.1] tracking-[-0.045em] md:text-[50px]">
                把真实工作，直接交出去。
              </h2>
              <p className="mx-auto mt-4 max-w-2xl text-[16px] leading-7 text-[#999e95]">
                从一句自然语言开始，跨越调研、分析、创作和开发，最终停在一份可以验收的成果上。
              </p>
            </div>

            <div className="mt-14 grid gap-4 lg:grid-cols-3">
              {SCENARIOS.map((scenario) => {
                const Icon = scenario.icon
                return (
                  <button
                    key={scenario.label}
                    type="button"
                    onClick={onStart}
                    className="group flex min-h-[330px] flex-col rounded-[24px] border border-white/9 bg-[#111310] p-6 text-left outline-none transition-[transform,border-color] duration-300 hover:-translate-y-1 hover:border-white/18 focus-visible:ring-2 focus-visible:ring-[#c7ff64]"
                  >
                    <span
                      className="grid size-11 place-items-center rounded-2xl border border-white/8 bg-white/[0.035]"
                      style={{ color: scenario.accent }}
                    >
                      <Icon size={20} />
                    </span>
                    <span
                      className="mt-6 text-[13px] font-semibold"
                      style={{ color: scenario.accent }}
                    >
                      {scenario.label}
                    </span>
                    <span className="mt-3 block text-[18px] leading-8 text-[#e5e5de]">
                      “{scenario.prompt}”
                    </span>
                    <span className="mt-auto pt-8">
                      <span className="mb-3 block text-[10.5px] uppercase tracking-[0.14em] text-[#777d73]">
                        Deliverables
                      </span>
                      <span className="flex flex-wrap gap-2">
                        {scenario.outputs.map((output) => (
                          <span
                            key={output}
                            className="rounded-full border border-white/8 bg-white/[0.025] px-2.5 py-1 text-[11px] text-[#91968d]"
                          >
                            {output}
                          </span>
                        ))}
                      </span>
                    </span>
                    <span className="mt-5 inline-flex items-center gap-1.5 text-[12px] font-medium text-[#c7ff64]">
                      用我的任务试试{' '}
                      <ArrowRight
                        size={13}
                        className="transition-transform group-hover:translate-x-0.5"
                      />
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        </section>

        <section id="agents" className="congjian-section border-b border-white/8">
          <div className="mx-auto max-w-6xl px-5 py-24">
            <div className="grid gap-12 lg:grid-cols-[0.85fr_1.15fr] lg:items-center">
              <div>
                <span className="congjian-kicker">
                  <Puzzle size={14} /> 智能体与技能
                </span>
                <h2 className="mt-5 text-[34px] font-semibold leading-[1.1] tracking-[-0.045em] md:text-[50px]">
                  一个入口，
                  <br />
                  调动整支 AI 团队。
                </h2>
                <p className="mt-5 max-w-xl text-[16px] leading-7 text-[#999e95]">
                  默认从一位全能助手开始。遇到专业任务，再从市场安装智能体与技能；每一种能力都围绕同一个目标协同，而不是散落在不同工具里。
                </p>
                <Button
                  variant="secondary"
                  shape="pill"
                  size="lg"
                  onClick={onStart}
                  className="mt-8"
                >
                  浏览智能体市场 <ArrowRight size={16} />
                </Button>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                {AGENTS.slice(0, 4).map((agent, index) => (
                  <button
                    key={agent.id}
                    type="button"
                    onClick={onStart}
                    className={`group rounded-[22px] border p-5 text-left outline-none transition-[transform,border-color,background-color] duration-300 hover:-translate-y-1 focus-visible:ring-2 focus-visible:ring-[#c7ff64] ${index === 0 ? 'border-[#c7ff64]/25 bg-[#c7ff64]/8' : 'border-white/9 bg-[#111310] hover:border-white/18'}`}
                  >
                    <div className="flex items-start justify-between gap-4">
                      <AgentAvatar agent={agent} className="size-11 rounded-[14px]" iconSize={21} />
                      <span className="rounded-full border border-white/8 px-2 py-0.5 text-[10px] text-[#777d73]">
                        {index === 0 ? '默认配备' : '市场安装'}
                      </span>
                    </div>
                    <div className="mt-6 text-[17px] font-semibold">{agent.name}</div>
                    <div className="mt-1 text-[12px] font-medium text-[#c7ff64]">
                      {agent.tagline}
                    </div>
                    <p className="mt-2 line-clamp-3 text-[13px] leading-5 text-[#8e9389]">
                      {agent.description}
                    </p>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </section>

        <EnterpriseSection onCreateOrg={onCreateOrg} />

        <section id="faq" className="congjian-section border-b border-white/8">
          <div className="mx-auto max-w-6xl px-5 py-24">
            <div className="grid gap-12 lg:grid-cols-[0.7fr_1.3fr]">
              <div>
                <span className="congjian-kicker">
                  <Clock3 size={14} /> 常见问题
                </span>
                <h2 className="mt-5 text-[34px] font-semibold leading-[1.1] tracking-[-0.045em] md:text-[46px]">
                  开始之前，
                  <br />
                  你可能想知道。
                </h2>
              </div>
              <div className="divide-y divide-white/8 border-y border-white/8">
                {FAQS.map((faq) => (
                  <details key={faq.q} className="group py-5 open:pb-6">
                    <summary className="flex cursor-pointer list-none items-center justify-between gap-5 text-[15px] font-medium text-[#e7e7e0] outline-none focus-visible:ring-2 focus-visible:ring-[#c7ff64]">
                      {faq.q}
                      <span className="grid size-7 shrink-0 place-items-center rounded-full border border-white/10 text-[#8f948a] transition-transform group-open:rotate-45">
                        +
                      </span>
                    </summary>
                    <p className="max-w-2xl pr-12 pt-3 text-[13.5px] leading-6 text-[#8f948a]">
                      {faq.a}
                    </p>
                  </details>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="congjian-grid relative overflow-hidden">
          <div aria-hidden className="congjian-cta-glow pointer-events-none absolute inset-0" />
          <div className="relative mx-auto max-w-5xl px-5 py-28 text-center md:py-36">
            <BrandMark className="mx-auto size-14" />
            <h2 className="mt-7 text-[42px] font-semibold leading-[1.02] tracking-[-0.055em] md:text-[68px]">
              现在，把复杂交给从简。
            </h2>
            <p className="mx-auto mt-5 max-w-xl text-[16px] leading-7 text-[#9da197]">
              从一个真实任务开始。无需配置模型，也无需先学会如何使用 AI。
            </p>
            <Button
              variant="primary"
              shape="pill"
              size="lg"
              onClick={onStart}
              className="mt-8 group"
            >
              免费开始使用
              <ArrowRight size={17} className="transition-transform group-hover:translate-x-0.5" />
            </Button>
          </div>
        </section>
      </main>

      <footer className="border-t border-white/8 bg-[#080907]">
        <div className="mx-auto max-w-6xl px-5 py-10">
          <div className="flex flex-col justify-between gap-8 md:flex-row md:items-start">
            <div>
              <Logo compact />
              <p className="mt-4 max-w-sm text-[13px] leading-6 text-[#777d73]">{BRAND.intro}</p>
            </div>
            <div className="flex flex-wrap gap-x-12 gap-y-5 text-[12.5px]">
              <div className="flex flex-col gap-2.5">
                <span className="font-medium text-[#d8d9d2]">产品</span>
                <a href="#demo" className="text-[#777d73] hover:text-white">
                  产品演示
                </a>
                <a href="#capabilities" className="text-[#777d73] hover:text-white">
                  核心能力
                </a>
                <a href="#enterprise" className="text-[#777d73] hover:text-white">
                  团队版
                </a>
              </div>
              <div className="flex flex-col gap-2.5">
                <span className="font-medium text-[#d8d9d2]">条款</span>
                <a href="/terms" className="text-[#777d73] hover:text-white">
                  用户协议
                </a>
                <a href="/privacy" className="text-[#777d73] hover:text-white">
                  隐私政策
                </a>
                <span className="text-[#777d73]">联系合作</span>
              </div>
            </div>
          </div>
          <div className="mt-10 flex flex-col justify-between gap-2 border-t border-white/8 pt-6 text-[11.5px] text-[#777d73] sm:flex-row">
            <span>
              © {BRAND.year} {BRAND.company} 版权所有
            </span>
            <span>{BRAND.icp}</span>
          </div>
        </div>
      </footer>
    </div>
  )
}
