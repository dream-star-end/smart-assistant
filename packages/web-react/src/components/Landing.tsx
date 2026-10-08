import {
  ArrowRight,
  ArrowUp,
  BrainCircuit,
  Building2,
  ChartColumn,
  Check,
  CircleCheckBig,
  Clock3,
  CodeXml,
  Cpu,
  FileCheck2,
  Gamepad2,
  Globe,
  Layers3,
  LoaderCircle,
  Menu,
  Network,
  Presentation,
  Puzzle,
  ReceiptText,
  Route,
  ShieldCheck,
  Sparkles,
  SquareTerminal,
  Users,
  Workflow,
  X,
  Zap,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react'
import type { Theme } from '../hooks/useTheme'
import { AGENTS } from '../lib/agents'
import { api } from '../lib/api'
import { BRAND } from '../lib/brand'
import { filedIcp } from '../lib/legal'
import { minSeatPriceYuan } from '../lib/orgBilling'
import { AgentAvatar } from './AgentAvatar'
import { BrandMark } from './BrandMark'
import { ThemeToggle } from './ThemeToggle'
import { DemoShowcase } from './landing/DemoShowcase'
import { Tutorials } from './landing/Tutorials'
import { Button, IconButton, buttonVariants } from './ui'

/** 顶部导航的分区锚点:桌面横排与窄屏折叠菜单共用同一份,保证两端跳得到的地方一致。 */
const NAV_LINKS = [
  { href: '#demo', label: '产品演示' },
  { href: '#capabilities', label: '核心能力' },
  { href: '#scenarios', label: '工作场景' },
  { href: '#agents', label: '智能体' },
  { href: '#enterprise', label: '团队版' },
] as const

/** 首页写下的任务最多带多长进工作区(防止把整篇粘贴塞进 sessionStorage)。 */
export const LANDING_PROMPT_MAX = 2000

/**
 * 「联系合作」只在品牌配置给了联系邮箱时渲染成 mailto 链接;没有就整项不出现 ——
 * 一个点了没反应的"链接"比没有更伤可信度。字段归 shell 的 brand.ts,这里只做前向兼容读取。
 */
function brandContactEmail(): string | undefined {
  const email = (BRAND as typeof BRAND & { contactEmail?: string }).contactEmail?.trim()
  return email || undefined
}

function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2.5" aria-label={`${BRAND.name} · ${BRAND.nameEn}`}>
      <BrandMark glow className={compact ? 'size-8' : 'size-8.5'} />
      <span className="flex flex-col leading-none">
        <span
          className={`font-semibold tracking-[-0.04em] text-[#f5f4ed] ${compact ? 'text-[17px]' : 'text-[18px]'}`}
        >
          {BRAND.name}
        </span>
        <span className="mt-1 text-[10px] font-medium uppercase tracking-[0.18em] text-[#8b9086]">
          {BRAND.nameEn}
        </span>
      </span>
    </div>
  )
}

/** 英雄区输入框下的示例:点一下把整句填进输入框,不直接提交 —— 用户还能改成自己的版本。 */
const HERO_EXAMPLES = [
  {
    icon: Globe,
    label: '深度调研',
    prompt: '调研 AI 编程工具过去 30 天的新变化，给我一份有来源、能直接汇报的结论。',
  },
  {
    icon: ChartColumn,
    label: '数据分析',
    prompt: '分析我上传的经营表，找出表现异常的门店并解释原因，最后出一份带图表的报告。',
  },
  {
    icon: Presentation,
    label: '做 PPT',
    prompt: '把这份季度复盘整理成 10 页左右的汇报 PPT，风格简洁专业。',
  },
  {
    icon: CodeXml,
    label: '写代码',
    prompt: '用 React 做一个番茄钟网页，支持自定义时长，并给我可以直接打开的预览。',
  },
  {
    icon: Gamepad2,
    label: '做小游戏',
    prompt: '做一个能直接在浏览器里玩的贪吃蛇小游戏，带计分和重新开始。',
  },
] as const

/** 成果跑马灯:只是"能交付什么"的视觉提示,读屏走同一份清单的 sr-only 文本。 */
const DELIVERABLES = [
  '研究报告',
  'Excel 表格',
  '汇报 PPT',
  '数据图表',
  '网页原型',
  '可运行代码',
  '浏览器小游戏',
  '竞品分析',
  '合同审阅',
  '产品方案',
  '周报月报',
  '学习笔记',
] as const

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
    icon: Globe,
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

/** 分区标题:kicker + 大标题(+ 可选导语)。各分区节奏一致,只在对齐方式上区分。 */
function SectionHeading({
  kicker,
  icon: Icon,
  title,
  lead,
  center = false,
}: {
  kicker: string
  icon: LucideIcon
  title: ReactNode
  lead?: string
  center?: boolean
}) {
  return (
    <div className={center ? 'mx-auto max-w-3xl text-center' : 'max-w-3xl'}>
      <span className="congjian-kicker">
        <Icon size={14} /> {kicker}
      </span>
      <h2 className="mt-5 text-balance text-[34px] font-semibold leading-[1.08] tracking-[-0.045em] text-[#f5f4ed] md:text-[52px]">
        {title}
      </h2>
      {lead && (
        <p
          className={`mt-5 max-w-2xl text-pretty text-[16px] leading-7 text-[#a3a79d] ${center ? 'mx-auto' : ''}`}
        >
          {lead}
        </p>
      )}
    </div>
  )
}

/**
 * 英雄区的任务输入框(prompt-first):写下目标 → 「免费开始」把这句话带进注册 / 登录,
 * 进入工作区后预填进输入框(不自动发送,见 App 的 oc_v5_pending_case 消费)。
 * Enter 提交、Shift+Enter 换行;输入法组字中的 Enter 只是选词,不提交。
 */
function HeroPrompt({ onStart }: { onStart: (prompt?: string) => void }) {
  const [text, setText] = useState('')
  const [placeholderIdx, setPlaceholderIdx] = useState(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    // 占位文案轮播只在输入框为空时才有意义;减少动效偏好下停在第一句。
    if (text) return
    if (
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    )
      return
    const id = window.setInterval(
      () => setPlaceholderIdx((i) => (i + 1) % HERO_EXAMPLES.length),
      4200,
    )
    return () => window.clearInterval(id)
  }, [text])

  const submit = () => {
    const prompt = text.trim().slice(0, LANDING_PROMPT_MAX)
    onStart(prompt || undefined)
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    submit()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey) return
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    e.preventDefault()
    submit()
  }

  return (
    <form onSubmit={onSubmit} className="mx-auto mt-10 w-full max-w-3xl text-left animate-in">
      <div className="cj-prompt rounded-[26px] p-px">
        <div className="rounded-[25px] bg-[#0f110e]/95 backdrop-blur-xl">
          <label htmlFor="landing-prompt" className="sr-only">
            描述你想完成的任务
          </label>
          <textarea
            id="landing-prompt"
            ref={textareaRef}
            rows={3}
            value={text}
            maxLength={LANDING_PROMPT_MAX}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={`例如：${HERO_EXAMPLES[placeholderIdx].prompt}`}
            className="block max-h-[220px] min-h-[104px] w-full resize-none bg-transparent px-5 pt-5 text-[16px] leading-7 text-[#f5f4ed] outline-none placeholder:text-[#7f8479] sm:px-6"
          />
          <div className="flex items-center justify-between gap-3 px-3 pb-3 pt-1 sm:px-4">
            <span className="inline-flex min-w-0 items-center gap-1.5 truncate pl-2 text-[12px] text-[#8b9086]">
              <Sparkles size={13} className="shrink-0 text-[#c7ff64]" aria-hidden />
              <span className="truncate">
                自动选择模型与智能体<span className="hidden sm:inline"> · 登录后不会自动发送</span>
              </span>
            </span>
            <Button
              type="submit"
              variant="primary"
              shape="pill"
              className="group shrink-0 gap-1.5 pr-3.5"
            >
              免费开始
              <ArrowUp
                size={16}
                aria-hidden
                className="transition-transform group-hover:-translate-y-0.5"
              />
            </Button>
          </div>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap justify-center gap-2" aria-label="任务示例">
        {HERO_EXAMPLES.map((example) => {
          const Icon = example.icon
          return (
            <button
              key={example.label}
              type="button"
              onClick={() => {
                setText(example.prompt)
                textareaRef.current?.focus()
              }}
              className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-3.5 text-[13px] text-[#c9cbc3] outline-none backdrop-blur transition-colors hover:border-white/20 hover:bg-white/[0.07] hover:text-white focus-visible:ring-2 focus-visible:ring-[#c7ff64] [@media(hover:none)]:min-h-11"
            >
              <Icon size={14} aria-hidden className="text-[#c7ff64]" />
              {example.label}
            </button>
          )
        })}
      </div>
    </form>
  )
}

/** 多智能体协作示意:中心是从简,四个专业智能体围绕它。纯装饰,读屏跳过。 */
function OrbitIllustration() {
  const nodes = [
    { label: '调研', x: 16, y: 22 },
    { label: '写作', x: 84, y: 22 },
    { label: '设计', x: 16, y: 78 },
    { label: '开发', x: 84, y: 78 },
  ]
  return (
    <div
      aria-hidden
      className="relative mt-8 h-[190px] overflow-hidden rounded-2xl border border-white/8 bg-[#0b0d0a]"
    >
      <div className="cj-dot-grid absolute inset-0 opacity-70" />
      <svg
        aria-hidden="true"
        className="absolute inset-0 size-full"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
      >
        {nodes.map((n) => (
          <line
            key={n.label}
            x1="50"
            y1="50"
            x2={n.x}
            y2={n.y}
            stroke="rgba(199,255,100,0.35)"
            strokeWidth="0.4"
            strokeDasharray="1.6 1.4"
            vectorEffect="non-scaling-stroke"
            className="cj-flow"
          />
        ))}
      </svg>
      <div className="absolute left-1/2 top-1/2 grid -translate-x-1/2 -translate-y-1/2 place-items-center">
        <span className="cj-pulse absolute size-16 rounded-full bg-[#c7ff64]/15" />
        <BrandMark glow className="relative size-11" />
      </div>
      {nodes.map((n) => (
        <span
          key={n.label}
          className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/12 bg-[#151812] px-3 py-1 text-[12px] font-medium text-[#d9dbd3] shadow-[0_8px_24px_rgba(0,0,0,0.4)]"
          style={{ left: `${n.x}%`, top: `${n.y}%` }}
        >
          {n.label}智能体
        </span>
      ))}
    </div>
  )
}

/** 长任务进度示意。 */
function TimelineIllustration() {
  const steps = [
    { label: '收集 42 份资料', state: 'done' },
    { label: '对比 6 家竞品', state: 'done' },
    { label: '生成图表与结论', state: 'run' },
    { label: '导出汇报 PPT', state: 'todo' },
  ] as const
  return (
    <ol aria-hidden className="mt-7 space-y-2.5">
      {steps.map((s) => (
        <li
          key={s.label}
          className="flex items-center gap-3 rounded-xl border border-white/8 bg-white/[0.025] px-3.5 py-2.5 text-[13px]"
        >
          {s.state === 'done' ? (
            <CircleCheckBig size={15} className="shrink-0 text-[#c7ff64]" />
          ) : s.state === 'run' ? (
            <LoaderCircle size={15} className="shrink-0 text-[#79d8ff] motion-safe:animate-spin" />
          ) : (
            <span className="ml-0.5 size-3 shrink-0 rounded-full border border-white/20" />
          )}
          <span className={s.state === 'todo' ? 'text-[#7f8479]' : 'text-[#d9dbd3]'}>
            {s.label}
          </span>
        </li>
      ))}
    </ol>
  )
}

/** 交付文件示意。 */
function FilesIllustration() {
  const files = [
    { name: '门店诊断.xlsx', tone: '#8de68f' },
    { name: '季度汇报.pptx', tone: '#f6c66a' },
    { name: '调研报告.pdf', tone: '#ff8d80' },
    { name: 'App.tsx', tone: '#79d8ff' },
  ]
  return (
    <div aria-hidden className="mt-7 grid grid-cols-2 gap-2">
      {files.map((f) => (
        <div
          key={f.name}
          className="flex items-center gap-2 rounded-xl border border-white/8 bg-white/[0.025] px-3 py-2.5"
        >
          <span className="size-2 shrink-0 rounded-full" style={{ background: f.tone }} />
          <span className="truncate text-[12.5px] text-[#d9dbd3]">{f.name}</span>
        </div>
      ))}
    </div>
  )
}

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
        // 公开档位不可用时不显示价格(写死的兜底价会在调价后变成错误报价),只保留「随需加席」,不阻断营销首页。
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
    <section id="enterprise" className="congjian-section relative overflow-hidden">
      <div className="mx-auto grid max-w-6xl gap-12 px-5 py-24 md:py-28 lg:grid-cols-[0.9fr_1.1fr] lg:items-center">
        <div>
          <span className="congjian-kicker">
            <Building2 size={14} /> 团队与企业
          </span>
          <h2 className="mt-5 max-w-xl text-[34px] font-semibold leading-[1.1] tracking-[-0.045em] text-[#f5f4ed] md:text-[50px]">
            一个人用得顺手，
            <br />
            一支团队也用得清楚。
          </h2>
          <p className="mt-5 max-w-xl text-[16px] leading-7 text-[#a3a79d]">
            共享额度、成员角色、用量限额、组织资产与报表放在同一处。团队把 AI
            用进日常工作，也始终保有边界和秩序。
          </p>

          <div className="mt-8 grid gap-3 sm:grid-cols-2">
            {ENTERPRISE_SELLING.map((item) => {
              const Icon = item.icon
              return (
                <div key={item.title} className="cj-card rounded-2xl p-4">
                  <span className="grid size-8 place-items-center rounded-lg bg-[#c7ff64]/10 text-[#c7ff64]">
                    <Icon size={16} />
                  </span>
                  <div className="mt-3 text-[14px] font-semibold text-[#f5f4ed]">{item.title}</div>
                  <p className="mt-1 text-[12.5px] leading-5 text-[#8b9086]">{item.body}</p>
                </div>
              )
            })}
          </div>

          <div className="mt-8 flex flex-wrap items-center gap-4">
            <Button variant="primary" shape="pill" size="lg" onClick={onCreateOrg}>
              创建组织 <ArrowRight size={16} />
            </Button>
            <span className="text-[14px] text-[#8e9388]">
              {anchor && (
                <strong className="mr-1.5 text-[18px] font-semibold text-[#f5f4ed]">
                  {anchor}
                </strong>
              )}
              {anchor ? '随需加席' : '按席位计费，随需加席'}
            </span>
          </div>
        </div>

        <div className="congjian-shell overflow-hidden rounded-[28px] border border-white/10 bg-[#111410] p-3 shadow-[0_32px_100px_rgba(0,0,0,0.42)]">
          <div className="rounded-[20px] border border-white/8 bg-[#0a0c09] p-5 sm:p-6">
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-[12px] font-medium uppercase tracking-[0.16em] text-[#8b9086]">
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
                        <span className="block truncate text-[11.5px] text-[#8b9086]">
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
                      className="h-full rounded-full bg-gradient-to-r from-[#8de68f] to-[#c7ff64]"
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

/** 页脚文字链接:桌面 18.8px 行高照旧,触屏撑到 44px 命中(a11y-B landing#2)。 */
const FOOTER_LINK_CLS =
  'text-[#8b9086] hover:text-white [@media(hover:none)]:flex [@media(hover:none)]:min-h-11 [@media(hover:none)]:items-center'

export function Landing(props: {
  /** prompt:英雄区 / 场景卡带过来的任务原文(已 trim、限长);其余入口不带。 */
  onStart: (prompt?: string) => void
  onLogin: () => void
  onCreateOrg: () => void
  theme: Theme
  onCycleTheme: () => void
}) {
  const { onStart, onLogin, onCreateOrg, theme, onCycleTheme } = props
  // 窄屏(<md)顶部导航折叠成菜单;点任一锚点 / 按 Esc 收起。桌面端零变化。
  const [menuOpen, setMenuOpen] = useState(false)
  // 页面滚离顶部后浮动导航加深底色,首屏保持通透。
  const [scrolled, setScrolled] = useState(false)
  // Esc 收起折叠导航时把焦点还给菜单按钮(a11y-B landing#1):<nav> 直接卸载,焦点在菜单链接上会掉到 body。
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const icp = filedIcp(BRAND.icp)
  const contactEmail = brandContactEmail()

  useEffect(() => {
    if (!menuOpen) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setMenuOpen(false)
      menuButtonRef.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [menuOpen])

  return (
    <div
      className="congjian-landing h-full overflow-y-auto bg-[#090a08] text-[#f5f4ed]"
      onScroll={(e) => {
        const next = e.currentTarget.scrollTop > 12
        if (next !== scrolled) setScrolled(next)
      }}
    >
      <header className="landing-safe-t sticky top-0 z-40 px-3 pt-3 sm:px-4">
        <div
          data-scrolled={scrolled || menuOpen ? 'true' : undefined}
          className="cj-nav mx-auto max-w-6xl rounded-[22px] border border-white/10 bg-[#0c0e0b]/60 backdrop-blur-2xl transition-[background-color,box-shadow,border-color] duration-300"
        >
          <div className="flex h-14 items-center justify-between gap-3 pl-3.5 pr-2 sm:pl-4">
            <Logo />
            <nav
              className="hidden items-center gap-1 text-[13.5px] text-[#a3a79d] md:flex"
              aria-label="首页导航"
            >
              {NAV_LINKS.map((link) => (
                <a
                  key={link.href}
                  href={link.href}
                  className="rounded-full px-3 py-1.5 outline-none transition-colors hover:bg-white/[0.06] hover:text-white focus-visible:ring-2 focus-visible:ring-[#c7ff64]"
                >
                  {link.label}
                </a>
              ))}
            </nav>
            <div className="flex shrink-0 items-center gap-1">
              {/* 首页固定深色,这里切的主题只会带进登录页/工作区。桌面端保留(hover 有 title 说明 +
                  切换 toast);窄屏收起 —— 触屏看不到 title,按了页面又不变,只剩困惑,登录页有同一枚开关。 */}
              <div className="hidden md:block">
                <ThemeToggle theme={theme} onCycle={onCycleTheme} titleHint="影响登录后的界面" />
              </div>
              <Button
                variant="ghost"
                shape="pill"
                onClick={onLogin}
                className="text-[#c4c7bf] hover:bg-white/8 hover:text-white"
              >
                登录
              </Button>
              <Button variant="primary" shape="pill" onClick={() => onStart()}>
                免费开始
              </Button>
              <IconButton
                ref={menuButtonRef}
                aria-label={menuOpen ? '收起导航' : '打开导航'}
                aria-expanded={menuOpen}
                aria-controls={menuOpen ? 'landing-mobile-nav' : undefined}
                onClick={() => setMenuOpen((open) => !open)}
                className="text-[#b7bbb2] hover:bg-white/8 hover:text-white md:hidden"
              >
                {menuOpen ? <X size={20} /> : <Menu size={20} />}
              </IconButton>
            </div>
          </div>
          {menuOpen && (
            <nav
              id="landing-mobile-nav"
              aria-label="首页导航（折叠菜单）"
              className="border-t border-white/8 md:hidden"
            >
              <ul className="flex flex-col px-2 py-2">
                {NAV_LINKS.map((link) => (
                  <li key={link.href}>
                    <a
                      href={link.href}
                      onClick={() => setMenuOpen(false)}
                      className="flex min-h-11 items-center rounded-xl px-3 text-[15px] text-[#d8d9d2] outline-none transition-colors hover:bg-white/[0.06] hover:text-white focus-visible:ring-2 focus-visible:ring-[#c7ff64]"
                    >
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          )}
        </div>
      </header>

      <main className="-mt-[68px]">
        <section className="relative overflow-hidden">
          {/* 极光背景:三团径向光只做 transform 漂移(合成层,不触发布局);减少动效时静止。 */}
          <div
            aria-hidden
            className="cj-aurora pointer-events-none absolute inset-x-0 top-0 h-[980px]"
          >
            <span />
            <span />
            <span />
          </div>
          <div
            aria-hidden
            className="cj-grid-fade pointer-events-none absolute inset-x-0 top-0 h-[820px]"
          />

          <div className="relative mx-auto max-w-6xl px-5 pb-14 pt-[148px] text-center sm:pt-[176px] md:pb-20">
            <span className="congjian-kicker animate-in">
              <span className="size-1.5 rounded-full bg-[#c7ff64] shadow-[0_0_12px_#c7ff64]" />
              全能 Agent 工作台 · 多模型协作
            </span>
            <h1 className="mx-auto mt-7 max-w-5xl text-balance text-[54px] font-semibold leading-[0.98] tracking-[-0.065em] text-[#f5f4ed] sm:text-[72px] md:text-[100px] animate-in">
              让复杂，<span className="congjian-hero-word">从简。</span>
            </h1>
            <p className="mx-auto mt-6 max-w-2xl text-pretty text-[17px] leading-7 text-[#aeb1a8] md:text-[19px] md:leading-8 animate-in">
              说出你的目标。从简拆解任务、调动模型与智能体、用工具持续执行，直到交回能直接用的文档、表格、演示和代码。
            </p>

            <HeroPrompt onStart={onStart} />

            {/* 小字一律 #8b9086(对 #090a08 约 5.9:1);原 #74797x 系在玻璃底上只有 4.3–4.6:1,卡在 AA 门槛。 */}
            <div className="mx-auto mt-8 flex max-w-3xl flex-wrap items-center justify-center gap-x-6 gap-y-2 text-[12.5px] text-[#8b9086]">
              {['多模型按任务切换', '智能体协同执行', '过程持续可追踪', '成果直接可使用'].map(
                (item) => (
                  <span key={item} className="inline-flex items-center gap-1.5">
                    <Check size={13} className="text-[#c7ff64]" /> {item}
                  </span>
                ),
              )}
            </div>
            {/* 次要入口降权重:文字链接,不与输入框里的主按钮抢焦点。 */}
            <a
              href="#demo"
              className={`${buttonVariants({ variant: 'ghost', shape: 'pill', size: 'sm' })} mt-5 text-[#aeb1a8] hover:bg-white/[0.06] hover:text-[#f5f4ed]`}
            >
              看一个真实任务 <ArrowRight size={14} aria-hidden className="rotate-90" />
            </a>
          </div>

          <div
            id="demo"
            className="relative mx-auto max-w-6xl scroll-mt-24 px-3 pb-20 sm:px-5 md:pb-24"
          >
            <div
              aria-hidden
              className="cj-demo-halo pointer-events-none absolute inset-x-10 top-10 bottom-24"
            />
            <div className="relative mb-4 flex items-center justify-between px-2 text-[11.5px] uppercase tracking-[0.16em] text-[#8b9086]">
              <span>Product workspace</span>
              <span className="inline-flex items-center gap-1.5 normal-case tracking-normal">
                <span className="size-1.5 rounded-full bg-[#c7ff64]" /> 产品能力演示
              </span>
            </div>
            <div className="congjian-shell relative rounded-[28px] border border-white/12 bg-[#10120f]/95 p-2.5 shadow-[0_48px_140px_rgba(0,0,0,0.6)] sm:p-4">
              <div className="mb-3 flex items-center gap-1.5 px-1.5 pt-0.5" aria-hidden>
                <span className="size-2.5 rounded-full bg-[#ff6b66]" />
                <span className="size-2.5 rounded-full bg-[#f6c65c]" />
                <span className="size-2.5 rounded-full bg-[#72d277]" />
                <span className="ml-3 flex h-5 flex-1 items-center justify-center rounded-md border border-white/6 bg-white/[0.025] text-[10.5px] tracking-normal text-[#6f746a]">
                  {BRAND.nameEn.toLowerCase()} · workspace
                </span>
              </div>
              <DemoShowcase onTry={() => onStart()} initialScenarioId="analysis" />
            </div>
          </div>
        </section>

        <section
          aria-label="从简能交付的成果"
          className="border-y border-white/8 bg-[#0b0c0a] py-7"
        >
          <p className="sr-only">可交付的成果包括：{DELIVERABLES.join('、')}。</p>
          <div aria-hidden className="cj-marquee">
            <div className="cj-marquee-track">
              {[...DELIVERABLES, ...DELIVERABLES].map((item, i) => (
                <span
                  // biome-ignore lint/suspicious/noArrayIndexKey: 跑马灯两份相同清单,下标就是唯一身份
                  key={i}
                  className="mr-3 inline-flex items-center gap-2 whitespace-nowrap rounded-full border border-white/8 bg-white/[0.025] px-4 py-2 text-[14px] text-[#b9bcb3]"
                >
                  <span className="size-1.5 rounded-full bg-[#c7ff64]/70" />
                  {item}
                </span>
              ))}
            </div>
          </div>
        </section>

        <Tutorials />

        <section id="workflow" className="congjian-section border-b border-white/8 bg-[#0c0e0b]">
          <div className="mx-auto max-w-6xl px-5 py-24 md:py-28">
            <div className="grid gap-8 lg:grid-cols-[0.8fr_1.2fr] lg:items-end">
              <div>
                <span className="congjian-kicker">
                  <Workflow size={14} /> 工作方式
                </span>
                <h2 className="mt-5 text-[34px] font-semibold leading-[1.08] tracking-[-0.045em] md:text-[52px]">
                  你给目标，
                  <br />
                  从简负责过程。
                </h2>
              </div>
              <p className="max-w-2xl text-[16px] leading-7 text-[#a3a79d] lg:justify-self-end">
                不需要先研究模型、提示词和工作流。每一个任务都沿着同一条清晰路径推进：理解、计划、执行、交付；你随时能看到它做到哪一步。
              </p>
            </div>

            <ol className="relative mt-14 grid gap-4 md:grid-cols-4">
              <span
                aria-hidden
                className="cj-track pointer-events-none absolute left-6 right-6 top-[27px] hidden h-px md:block"
              />
              {WORKFLOW_STEPS.map((step) => {
                const Icon = step.icon
                return (
                  <li key={step.n} className="relative">
                    <span className="relative z-10 grid size-14 place-items-center rounded-2xl border border-white/12 bg-[#141712] text-[#c7ff64] shadow-[0_0_0_6px_#0c0e0b]">
                      <Icon size={22} />
                    </span>
                    <div className="mt-5 font-mono text-[11.5px] tracking-[0.14em] text-[#8b9086]">
                      STEP {step.n}
                    </div>
                    <h3 className="mt-2 text-[19px] font-semibold">{step.title}</h3>
                    <p className="mt-2 max-w-[240px] text-[13.5px] leading-6 text-[#8b9086]">
                      {step.body}
                    </p>
                  </li>
                )
              })}
            </ol>
          </div>
        </section>

        <section id="capabilities" className="congjian-section border-b border-white/8">
          <div className="mx-auto max-w-6xl px-5 py-24 md:py-28">
            <SectionHeading
              kicker="核心能力"
              icon={Sparkles}
              title={
                <>
                  不是“问一句，答一句”。
                  <br />
                  而是把一件事做完。
                </>
              }
            />

            {/* Bento:一张宽卡讲协作,一张高卡讲长任务,下排交付 + 两个补充能力。 */}
            <div className="mt-14 grid gap-4 lg:grid-cols-6">
              {CAPABILITIES.map((capability, index) => {
                const Icon = capability.icon
                const span = index === 0 ? 'lg:col-span-4' : 'lg:col-span-2'
                return (
                  <article
                    key={capability.title}
                    className={`cj-card group relative overflow-hidden rounded-[24px] p-6 ${span}`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-[10.5px] tracking-[0.15em] text-[#8b9086]">
                        {capability.eyebrow}
                      </span>
                      <span className="grid size-10 place-items-center rounded-xl border border-white/8 bg-white/[0.035] text-[#c7ff64]">
                        <Icon size={19} />
                      </span>
                    </div>
                    <h3 className="mt-6 text-[22px] font-semibold leading-[1.2] tracking-[-0.025em]">
                      {capability.title}
                    </h3>
                    <p className="mt-3 max-w-xl text-[14px] leading-6 text-[#979b91]">
                      {capability.body}
                    </p>
                    <div className="mt-5 flex flex-wrap gap-2">
                      {capability.tags.map((tag) => (
                        <span
                          key={tag}
                          className="rounded-full border border-white/8 bg-white/[0.025] px-2.5 py-1 text-[11px] text-[#8b9086]"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                    {index === 0 && <OrbitIllustration />}
                    {index === 1 && <TimelineIllustration />}
                    {index === 2 && <FilesIllustration />}
                  </article>
                )
              })}
              <article className="cj-card rounded-[24px] p-6 lg:col-span-2">
                <span className="grid size-10 place-items-center rounded-xl border border-white/8 bg-white/[0.035] text-[#79d8ff]">
                  <Cpu size={19} />
                </span>
                <h3 className="mt-6 text-[20px] font-semibold leading-[1.25] tracking-[-0.02em]">
                  多模型，按任务切换
                </h3>
                <p className="mt-3 text-[14px] leading-6 text-[#979b91]">
                  推理、写作、编程、视觉各取所长。你不必先研究该选哪个模型，也可以随时手动指定。
                </p>
              </article>
              <article className="cj-card rounded-[24px] p-6 lg:col-span-2">
                <span className="grid size-10 place-items-center rounded-xl border border-white/8 bg-white/[0.035] text-[#f6c66a]">
                  <SquareTerminal size={19} />
                </span>
                <h3 className="mt-6 text-[20px] font-semibold leading-[1.25] tracking-[-0.02em]">
                  会用工具，也会上网
                </h3>
                <p className="mt-3 text-[14px] leading-6 text-[#979b91]">
                  浏览网页、读写文件、运行代码，在你的专属工作空间里把事情真正做完。
                </p>
              </article>
            </div>
          </div>
        </section>

        <section id="scenarios" className="congjian-section border-b border-white/8 bg-[#0c0e0b]">
          <div className="mx-auto max-w-6xl px-5 py-24 md:py-28">
            <SectionHeading
              center
              kicker="工作场景"
              icon={Zap}
              title="把真实工作，直接交出去。"
              lead="从一句自然语言开始，跨越调研、分析、创作和开发，最终停在一份可以验收的成果上。"
            />

            <div className="mt-14 grid gap-4 lg:grid-cols-3">
              {SCENARIOS.map((scenario) => {
                const Icon = scenario.icon
                return (
                  <button
                    key={scenario.label}
                    type="button"
                    onClick={() => onStart(scenario.prompt)}
                    style={{ ['--cj-accent' as string]: scenario.accent }}
                    className="cj-card cj-scenario group flex min-h-[340px] flex-col rounded-[24px] p-6 text-left outline-none transition-[transform,border-color] duration-300 hover:-translate-y-1 focus-visible:ring-2 focus-visible:ring-[#c7ff64]"
                  >
                    <span className="flex items-center gap-3">
                      <span
                        className="grid size-10 place-items-center rounded-xl border border-white/8 bg-white/[0.035]"
                        style={{ color: scenario.accent }}
                      >
                        <Icon size={19} />
                      </span>
                      <span
                        className="text-[14px] font-semibold"
                        style={{ color: scenario.accent }}
                      >
                        {scenario.label}
                      </span>
                    </span>
                    <span className="mt-6 block rounded-2xl rounded-tl-md border border-white/8 bg-white/[0.04] px-4 py-3.5 text-[16px] leading-7 text-[#e5e5de]">
                      “{scenario.prompt}”
                    </span>
                    <span className="mt-auto pt-7">
                      <span className="mb-3 block text-[10.5px] uppercase tracking-[0.14em] text-[#8b9086]">
                        Deliverables
                      </span>
                      <span className="flex flex-wrap gap-2">
                        {scenario.outputs.map((output) => (
                          <span
                            key={output}
                            className="inline-flex items-center gap-1 rounded-full border border-white/8 bg-white/[0.025] px-2.5 py-1 text-[11.5px] text-[#a3a79d]"
                          >
                            <Check size={11} aria-hidden style={{ color: scenario.accent }} />
                            {output}
                          </span>
                        ))}
                      </span>
                    </span>
                    <span className="mt-5 inline-flex items-center gap-1.5 text-[12.5px] font-medium text-[#c7ff64]">
                      用这句话开始{' '}
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
          <div className="mx-auto max-w-6xl px-5 py-24 md:py-28">
            <div className="grid gap-12 lg:grid-cols-[0.85fr_1.15fr] lg:items-center">
              <div>
                <span className="congjian-kicker">
                  <Puzzle size={14} /> 智能体与技能
                </span>
                <h2 className="mt-5 text-[34px] font-semibold leading-[1.08] tracking-[-0.045em] md:text-[52px]">
                  一个入口，
                  <br />
                  调动整支 AI 团队。
                </h2>
                <p className="mt-5 max-w-xl text-[16px] leading-7 text-[#a3a79d]">
                  默认从一位全能助手开始。遇到专业任务，再从市场安装智能体与技能；每一种能力都围绕同一个目标协同，而不是散落在不同工具里。
                </p>
                <Button
                  variant="secondary"
                  shape="pill"
                  size="lg"
                  onClick={() => onStart()}
                  className="mt-8"
                >
                  {/* onStart 落在开始使用 / 登录,不直达市场 —— 文案说实话,不许诺点了就到市场。 */}
                  开始使用，再去市场安装 <ArrowRight size={16} />
                </Button>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                {AGENTS.slice(0, 4).map((agent, index) => (
                  <button
                    key={agent.id}
                    type="button"
                    onClick={() => onStart()}
                    className={`group rounded-[22px] border p-5 text-left outline-none transition-[transform,border-color,background-color] duration-300 hover:-translate-y-1 focus-visible:ring-2 focus-visible:ring-[#c7ff64] ${index === 0 ? 'border-[#c7ff64]/25 bg-[linear-gradient(160deg,rgba(199,255,100,0.12),rgba(199,255,100,0.03))]' : 'cj-card'}`}
                  >
                    <div className="flex items-start justify-between gap-4">
                      <AgentAvatar agent={agent} className="size-11 rounded-[14px]" iconSize={21} />
                      <span className="rounded-full border border-white/8 px-2 py-0.5 text-[10px] text-[#8b9086]">
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

        <section id="faq" className="congjian-section border-y border-white/8 bg-[#0c0e0b]">
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
              <div className="space-y-3">
                {FAQS.map((faq) => (
                  <details key={faq.q} className="cj-card group rounded-2xl px-5 py-4 open:pb-5">
                    <summary className="flex cursor-pointer list-none items-center justify-between gap-5 text-[15px] font-medium text-[#e7e7e0] outline-none focus-visible:ring-2 focus-visible:ring-[#c7ff64] [@media(hover:none)]:min-h-11">
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

        <section className="relative px-3 py-20 sm:px-5 md:py-28">
          <div className="cj-cta relative mx-auto max-w-6xl overflow-hidden rounded-[32px] border border-white/10 px-5 py-20 text-center md:py-28">
            <div
              aria-hidden
              className="cj-aurora cj-aurora-soft pointer-events-none absolute inset-0"
            >
              <span />
              <span />
              <span />
            </div>
            <div className="relative">
              <BrandMark glow className="mx-auto size-14" />
              <h2 className="mx-auto mt-7 max-w-3xl text-balance text-[40px] font-semibold leading-[1.02] tracking-[-0.055em] md:text-[68px]">
                现在，把复杂交给<span className="congjian-hero-word">从简</span>。
              </h2>
              <p className="mx-auto mt-5 max-w-xl text-[16px] leading-7 text-[#a3a79d]">
                从一个真实任务开始。无需配置模型，也无需先学会如何使用 AI。
              </p>
              <Button
                variant="primary"
                shape="pill"
                size="lg"
                onClick={() => onStart()}
                className="group mt-8"
              >
                免费开始
                <ArrowRight
                  size={17}
                  className="transition-transform group-hover:translate-x-0.5"
                />
              </Button>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-white/8 bg-[#080907]">
        <div className="mx-auto max-w-6xl px-5 py-10">
          <div className="flex flex-col justify-between gap-8 md:flex-row md:items-start">
            <div>
              <Logo compact />
              <p className="mt-4 max-w-sm text-[13px] leading-6 text-[#8b9086]">{BRAND.intro}</p>
            </div>
            {/* 页脚链接触屏撑到 44px(a11y-B landing#2):列间距在 hover:none 下收掉,行高由链接自己撑。 */}
            <div className="flex flex-wrap gap-x-12 gap-y-5 text-[12.5px]">
              <div className="flex flex-col gap-2.5 [@media(hover:none)]:gap-0">
                <span className="font-medium text-[#d8d9d2]">产品</span>
                <a href="#demo" className={FOOTER_LINK_CLS}>
                  产品演示
                </a>
                <a href="#capabilities" className={FOOTER_LINK_CLS}>
                  核心能力
                </a>
                <a href="#enterprise" className={FOOTER_LINK_CLS}>
                  团队版
                </a>
              </div>
              <div className="flex flex-col gap-2.5 [@media(hover:none)]:gap-0">
                <span className="font-medium text-[#d8d9d2]">条款</span>
                <a href="/terms" className={FOOTER_LINK_CLS}>
                  用户协议
                </a>
                <a href="/privacy" className={FOOTER_LINK_CLS}>
                  隐私政策
                </a>
                {contactEmail && (
                  <a href={`mailto:${contactEmail}`} className={FOOTER_LINK_CLS}>
                    联系合作
                  </a>
                )}
              </div>
            </div>
          </div>
          <div className="mt-10 flex flex-col justify-between gap-2 border-t border-white/8 pt-6 text-[11.5px] text-[#8b9086] sm:flex-row">
            <span>
              © {BRAND.year} {BRAND.company} 版权所有
            </span>
            {/* 备案位只在拿到真实备案号后出现(并按工信部要求外链备案系统);占位文案不上页脚。 */}
            {icp && (
              <a
                href="https://beian.miit.gov.cn/"
                target="_blank"
                rel="noreferrer"
                className="hover:text-white [@media(hover:none)]:flex [@media(hover:none)]:min-h-11 [@media(hover:none)]:items-center"
              >
                {icp}
              </a>
            )}
          </div>
        </div>
      </footer>
    </div>
  )
}
