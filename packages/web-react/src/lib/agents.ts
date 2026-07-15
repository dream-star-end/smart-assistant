import {
  Briefcase,
  Code2,
  GraduationCap,
  Languages,
  type LucideIcon,
  PenLine,
  Scale,
  Sparkles,
  Stethoscope,
  Telescope,
  Utensils,
} from 'lucide-react'

export type Agent = {
  id: string
  name: string
  /** lucide icon for built-in agents; market agents use avatarEmoji instead. */
  icon?: LucideIcon
  /** tailwind gradient stops, e.g. "from-emerald-500 to-teal-600" */
  grad?: string
  /** market agent avatar (emoji); falls back to icon/default when absent. */
  avatarEmoji?: string | null
  tagline?: string
  description: string
  category?: string
  starters?: string[]
  system?: string
  /** 平台预设(编程/办公/科研):开箱即用、不显示卸载语义。 */
  preset?: boolean
  /** marketplace provenance (B-positioning picker). */
  installed?: boolean
  isDefault?: boolean
  /** Required Skill/Plugin composition is executable for the current user. */
  ready?: boolean
  /** Required Plugins that still need an account authorization. */
  needsAuthorization?: string[]
}

/**
 * 【Landing 专用展示数据,非运行时权威源 —— 不是双入口】
 *
 * 这些"预设人设"(代码专家/学术研究/商业分析…)**只**被 Landing.tsx 用作首页
 * 「AI 市场 · 专业智能体(示例,陆续上新)」的营销示意卡:点击一律走 onStart 进入产品,
 * 不会作为可选 agent 进入运行时。运行时 agent 列表的唯一权威源是后端
 * /api/marketplace/my-agents(平台预设助手由 seedPlatformAgents / platformPresets 下发:
 * 编程助手、办公助手、科研助手 research-assistant);AgentPicker / App 完全数据驱动,
 * agentById 也刻意不解析本列表(见下)。因此这里的「学术研究」与市场的「科研助手」
 * 不会同时出现在选择器里。
 *
 * 维护约定:新增真实助手请改后端 platformPresets / 市场发布,不要往这里加;
 * 本列表仅营销文案,`system`/`starters` 是展示占位,不参与真实请求(见文件尾注释)。
 */
export const AGENTS: Agent[] = [
  {
    id: 'general',
    name: '全能助手',
    icon: Sparkles,
    grad: 'from-emerald-500 to-teal-600',
    tagline: '日常问答 · 有问必答',
    description: '通晓百科的贴心助理，写邮件、做规划、查资料、出主意，样样在行。',
    category: '通用',
    starters: [
      '帮我规划一次 5 天的云南旅行',
      '把这段话改得更礼貌专业',
      '用通俗的话解释什么是量子纠缠',
    ],
    system:
      '你是「全能助手」，一位博学、耐心、可靠的中文 AI 助理。回答要条理清晰、重点突出，必要时用列表与小标题。语气友好专业。',
  },
  {
    id: 'coder',
    name: '代码专家',
    icon: Code2,
    grad: 'from-sky-500 to-indigo-600',
    tagline: '编程 · 调试 · 架构',
    description: '资深全栈工程师，写代码、查 bug、做技术选型与架构评审，给出可运行的方案。',
    category: '开发',
    starters: [
      '用 Python 写一个并发爬虫并解释',
      '审查这段代码有没有性能问题',
      '帮我设计一个秒杀系统的架构',
    ],
    system:
      '你是「代码专家」，一位资深全栈工程师。给出准确、可运行的代码，配简明解释；指出边界情况与最佳实践。代码块标注语言。',
  },
  {
    id: 'writer',
    name: '文案创作',
    icon: PenLine,
    grad: 'from-rose-500 to-pink-600',
    tagline: '营销 · 文章 · 润色',
    description: '金牌文案与编辑，写公众号、小红书、广告语、产品文案，文字有温度也有转化力。',
    category: '创作',
    starters: [
      '给一款国货护肤品写小红书种草文',
      '写一条新品发布的朋友圈文案',
      '把这篇文章润色得更有感染力',
    ],
    system:
      '你是「文案创作」，一位擅长中文营销与内容创作的金牌文案。文字要有画面感与感染力，贴合平台调性（小红书/公众号/广告）。',
  },
  {
    id: 'research',
    name: '学术研究',
    icon: Telescope,
    grad: 'from-violet-500 to-purple-600',
    tagline: '文献 · 综述 · 严谨分析',
    description: '严谨的科研搭子，做文献综述、梳理研究脉络、辅助论文写作与方法论分析。',
    category: '研究',
    starters: [
      '综述锂金属负极枝晶抑制的研究进展',
      '帮我把研究问题拆成可验证的假设',
      '解释 Transformer 的注意力机制',
    ],
    system:
      '你是「学术研究」，一位治学严谨的研究助手。论述客观、结构化、有逻辑链；区分事实与推断；必要时给出研究方法与局限。',
  },
  {
    id: 'business',
    name: '商业分析',
    icon: Briefcase,
    grad: 'from-amber-500 to-orange-600',
    tagline: '市场 · 商业计划 · 洞察',
    description: '麦肯锡式的商业顾问，做市场分析、商业模式、竞品研究与数据洞察。',
    category: '商业',
    starters: [
      '帮我做一份新茶饮品牌的竞品分析',
      '为一个 SaaS 产品设计定价策略',
      '用 SWOT 分析这个创业方向',
    ],
    system:
      '你是「商业分析」，一位顶级战略顾问。用结构化框架（如 SWOT、波特五力、商业画布）拆解问题，给出可执行的洞察与建议。',
  },
  {
    id: 'translator',
    name: '翻译官',
    icon: Languages,
    grad: 'from-cyan-500 to-blue-600',
    tagline: '多语种 · 信达雅',
    description: '母语级译者，中英日韩法德多语互译，兼顾准确、地道与语气，也能润色外语写作。',
    category: '语言',
    starters: [
      '把这段中文翻译成地道商务英语',
      '帮我润色这封英文邮件',
      '把这首古诗译成英文并保留意境',
    ],
    system:
      '你是「翻译官」，一位母语级专业译者。翻译做到信达雅，保留语气与文化语境；可附简短说明关键译法。默认中英互译，按需切换语种。',
  },
  {
    id: 'tutor',
    name: '学习辅导',
    icon: GraduationCap,
    grad: 'from-teal-500 to-emerald-600',
    tagline: '讲解 · 答疑 · 因材施教',
    description: '耐心的全科老师，把复杂知识讲到你懂为止，数理化文史，循循善诱。',
    category: '教育',
    starters: [
      '用初中生能懂的方式讲解牛顿第二定律',
      '帮我梳理高考英语作文的提分技巧',
      '出 5 道导数练习题并给解析',
    ],
    system:
      '你是「学习辅导」，一位耐心的全科名师。讲解循序渐进、由浅入深，多用类比与例子；鼓励式语气，引导学生思考而非直接给答案。',
  },
  {
    id: 'legal',
    name: '法律顾问',
    icon: Scale,
    grad: 'from-slate-500 to-slate-700',
    tagline: '咨询 · 合同 · 普法',
    description: '懂法的咨询助手，解读法律问题、审阅合同要点、做普法科普（不构成正式法律意见）。',
    category: '法律',
    starters: [
      '租房合同里要注意哪些坑',
      '员工离职公司不发工资怎么办',
      '帮我看看这份协议有什么风险点',
    ],
    system:
      '你是「法律顾问」，一位严谨的中国法律咨询助手。引用相关法律精神，给出清晰建议；务必提示『本回答仅供参考，不构成正式法律意见，重大事项请咨询执业律师』。',
  },
  {
    id: 'life',
    name: '生活管家',
    icon: Utensils,
    grad: 'from-lime-500 to-green-600',
    tagline: '美食 · 健康 · 生活',
    description:
      '贴心生活管家，菜谱、营养、健身、收纳、养生，把日子过得更舒服（健康建议仅供参考）。',
    category: '生活',
    starters: ['用冰箱里的鸡蛋番茄做道菜', '给上班族设计一周健康午餐', '帮我做一个新手健身计划'],
    system:
      '你是「生活管家」，一位温暖实用的生活助手。给出具体、可操作的建议（菜谱列食材步骤、计划列清单）。健康相关务必提示『仅供参考，身体不适请就医』。',
  },
]

/**
 * The default agent (B-positioning): 全能助手, backend id `main`. This is the only
 * agent every user has by default; everything else is installed from the market.
 * (Unifies the old frontend `general` id with the backend `main` authority.)
 */
export const MAIN_AGENT: Agent = {
  id: 'main',
  name: '全能助手',
  icon: Sparkles,
  grad: 'from-emerald-500 to-teal-600',
  description: '通用全能智能体，内置工具齐全，可随时从市场加装技能与更多智能体。',
  isDefault: true,
  installed: true,
  ready: true,
}

export const DEFAULT_AGENT = MAIN_AGENT

export function agentById(_id?: string): Agent {
  // The picker is data-driven (/api/marketplace/my-agents); this legacy fallback
  // never resolves the Landing-only AGENTS list, so the old hardcoded agents can't
  // leak back into runtime selection. Any id → the default 全能助手.
  return MAIN_AGENT
}

/** Build a picker Agent from a /api/marketplace/my-agents row. */
export function agentFromApiRow(row: {
  id: string
  name: string
  description?: string
  avatarEmoji?: string | null
  installed?: boolean
  isDefault?: boolean
  preset?: boolean
  capabilityReadiness?: { ready: boolean; needsAuthorization?: string[] }
}): Agent {
  if (row.id === 'main' || row.isDefault) return MAIN_AGENT
  return {
    id: row.id,
    name: row.name,
    avatarEmoji: row.avatarEmoji ?? '🤖',
    grad: 'from-violet-500 to-fuchsia-600',
    description: row.description ?? '',
    installed: row.installed,
    preset: row.preset,
    ready: row.capabilityReadiness?.ready ?? true,
    needsAuthorization: row.capabilityReadiness?.needsAuthorization ?? [],
  }
}

// 注意：模型与人设(agent→model / persona)的唯一权威源在 v5 后端
// (packages/commercial，internalServerAuthored 等)。前端只发送 agentId、只做展示，
// 刻意不在此持有模型映射；上面的 `system` 字段仅为占位，不参与真实请求，避免两套权威源漂移。
