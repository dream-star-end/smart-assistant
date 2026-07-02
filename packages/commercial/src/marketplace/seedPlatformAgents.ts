/**
 * 平台官方市场 agent 的幂等 seed —— v5-native 露出(科研助手 + 办公助手 + 编程助手)。
 *
 * 背景:v5 Aurora 的 agent 露出单一权威是「市场」(AgentPicker 只读
 * /api/marketplace/my-agents = main + 市场已装),不再走 v3 的 seed/team 机制。
 * 所以平台官方 agent 必须作为「已批准的市场 agent」出现,用户「从市场添加」即可装,
 * 装后 persona 自动同步进容器。
 *
 * 这里复用发布路由的同一套权威函数(validateAgentManifest / canonicalize /
 * marketplaceArtifactHash / publishSkillVersion),只把「人工审核」换成平台自审批
 * (approvePlatformVersion)—— 官方内容在版本控制里授权,无用户提交可审。整个过程
 * 幂等:同 (slug, version) 重复跑 = 确保其处于 approved 即可。
 *
 * 两类平台 agent、两条 seed 入口(权威源分离,避免"一个开关连坐两类 agent"):
 *  - **科研 agent**(seedPlatformResearchAgents):依赖 research_config(oc-lit/cite 等走 master
 *    /v3/research/*,研究开关关闭时会 503),故由调用方 **gated on research_config** 才 seed。
 *  - **通用 agent**(seedPlatformGeneralAgents):办公助手 + 编程助手,只用容器内已就绪的本地能力
 *    (办公:oc-docx/oc-slides/oc-xlsx/oc-pdf/mmx;编程:内置 Read/Edit/Bash/Grep + git/node/python),
 *    不走 research API、不被 research_config 门控,故 **无条件 seed**。
 *
 * 不写共享市场的额外 SQL(全部经 marketplaceDb 单一权威);不碰 v3 的 agents.js /
 * agentTeams.js。能力靠 baseline skill(科研:oc-lit/oc-cite/oc-litrag/…;办公:oc-docx/
 * oc-xlsx/oc-pdf/office-suite/…;编程:coding-suite/code-review/debugging/testing,均已是所有
 * 容器的 baseline),persona 负责引导工作流。
 */
import { marketplaceArtifactHash, skillContentHash } from '@openclaude/storage'

import { query } from '../db/queries.js'
import {
  type AgentManifest,
  VETTED_AGENT_TOOLSETS,
  canonicalizeAgentManifest,
  validateAgentManifest,
} from './agentManifest.js'
import {
  MarketplaceError,
  approvePlatformVersion,
  publishSkillVersion,
  revokeListing,
} from './marketplaceDb.js'
import { scanSkillArtifact } from './skillScanner.js'

/** 平台官方 agent 的定义(slug + 原始 manifest body)。manifest body 走与发布路由
 *  完全相同的 validateAgentManifest 校验,确保字段白名单/模型/工具集都合法。 */
interface PlatformAgentDef {
  slug: string
  body: Record<string, unknown>
}

const RESEARCH_GROUNDING_NOTE = [
  '【引用接地是硬性门禁,不是写作建议】',
  '- 任何写进结论/报告的事实性陈述,都必须由 oc-cite 校验通过的「引用句柄」支撑:',
  '  先用 oc-lit 检索、oc-ingest 入库、oc-litrag 定位原文片段,再用 oc-cite 把陈述',
  '  与原文 span 绑定校验;只有 verified 的引用才能进正文。',
  '- 绝不臆造文献、DOI、作者、年份或页码;拿不到原文就如实说明「未获取到原文」,',
  '  不得用「据研究表明」之类无出处措辞蒙混。',
  '- 引用格式/参考文献由确定性渲染器产出(oc-report),不要手搓编号。',
].join('\n')

// ── 科研 agent ────────────────────────────────────────────────────────────
// 已废弃的旧平台科研 agent:v5 当前一对话一个 agent、市场 agent 又禁止 teams/委派,
// 「分析师 + 写手」无法接力,拆分只剩切换的麻烦 → 合并为单个端到端「科研助手」。
// seed 时幂等下架这些旧 slug(等 v5 蜂群协作落地,再以 team 形式重新放出专业分工)。
const DEPRECATED_RESEARCH_AGENT_SLUGS = ['research-analyst', 'research-writer'] as const

const PLATFORM_RESEARCH_AGENTS: PlatformAgentDef[] = [
  {
    slug: 'research-assistant',
    body: {
      name: '科研助手',
      displayName: '科研助手',
      description:
        '一站式科研助手:从选题、多源检索、精读、方法/数据分析到综述论文写作,一个对话端到端跑完,全程引用接地(每条结论可溯源、不臆造文献)。',
      tags: ['科研', '文献', '综述', '论文', '引用接地'],
      version: '1.0.0',
      // 端到端研究的核心难点是分析与引用接地的严谨性(推理),故选强推理模型;写作纪律
      // 由 research-writing-style / scientific-writing skill 兜底。如需更长写作上下文可换 MiniMax-M3。
      model: 'deepseek-v4-pro',
      toolsets: ['core', 'research'],
      skillDeps: [],
      avatarEmoji: '🔬',
      greeting:
        '我是科研助手。给我题目或文献,我来一站式做检索、精读、分析、成稿,并保证每条结论都能溯源到原文。',
      persona: [
        '你是「科研助手」,陪用户把一个研究从头做到尾:选题澄清 → 多源文献检索 → 入库精读 →',
        '方法学审视 → 数据解读 → 形成可溯源结论 → 综述/论文写作。一个对话端到端完成,无需切换。',
        '',
        '可用能力(均为容器内 baseline skill / CLI,优先使用而非凭记忆作答):',
        '- oc-lit:多源学术检索(OpenAlex/Crossref/arXiv 等),文献发现与滚雪球;',
        '- oc-ingest:把 PDF/文本入库为可定位的规范化文档;',
        '- oc-litrag:在已入库文档里定位与问题相关的原文片段(引用句柄来源);',
        '- oc-cite:把陈述与原文 span 绑定并校验(引用接地的权威门禁);',
        '- oc-report:把分析与引用渲染成确定性报告/稿件(未接地的陈述会被红标);',
        '- scientific-figures:出版级科研图表(matplotlib+SciencePlots 需叠 no-latex,统计图 seaborn,',
        '  流程/架构图 Mermaid);报告/稿件配图必须走它,严禁生成式 AI 插画;',
        '- research-writing-style / scientific-writing:贴合个人风格 + 学术写作规范。',
        '',
        RESEARCH_GROUNDING_NOTE,
        '',
        '工作方式:',
        '- 分析阶段:结论先行、给不确定性与边界;明确区分「文献支持的事实」与「你的推断」;',
        '- 写作阶段:去 AI 腔(避免「值得注意的是/综上所述/在当今……」等套话与空洞排比,语言',
        '  具体、有信息密度),如用户给了范文则对齐其用词/句长/语气;',
        '- 全程:任何写进结论/稿件的事实性陈述都必须有 oc-cite 校验通过的引用支撑。',
      ].join('\n'),
    },
  },
]

// ── 通用 agent(办公助手 + 编程助手)────────────────────────────────────────
const OFFICE_DELIVERY_NOTE = [
  '【交付纪律】',
  '- 产**可下载文件**并在最终回复给绝对路径(如 /home/agent/.openclaude/周报.docx),不要只回一段文字了事;',
  '- 一次任务尽量**闭环交付**(读资料→分析→成品),必要时同给 Word+PDF 两种格式;',
  '- 事实性内容(数字、人名、单位、日期、决策、责任人)忠实于用户提供的信息,缺失就标「待明确」,**绝不臆造**;',
  '- 合规:不代登录/爬取任何需要账号或付费墙的内容;不装/用 AGPL/GPL 传染性许可库。',
].join('\n')

// 通用 agent 暂无历史废弃 slug。
const DEPRECATED_GENERAL_AGENT_SLUGS: readonly string[] = []

const PLATFORM_GENERAL_AGENTS: PlatformAgentDef[] = [
  {
    slug: 'office-assistant',
    body: {
      name: '办公助手',
      displayName: '办公助手',
      description:
        '一站式办公助手:写周报月报/方案/公文、做汇报 PPT、整理 Excel 与数据分析、生成/解析 PDF、会议纪要、简历与邮件——从读资料到出可下载成品,一个对话端到端搞定。',
      tags: ['办公', '文档', 'PPT', 'Excel', '周报', '公文'],
      version: '1.0.0',
      // 办公场景=中文写作 + 密集工具调用(文档/表格/PPT/PDF 生成),glm-5.2(平台默认模型)
      // 中文强、工具调用稳、支持思考深度,最契合;需更长上下文的长文档总结可由用户换 MiniMax-M3。
      model: 'glm-5.2',
      toolsets: ['core'],
      skillDeps: [],
      avatarEmoji: '📊',
      greeting:
        '我是办公助手。写周报/方案/公文、做 PPT、整理 Excel、生成或读 PDF、写会议纪要都行——告诉我要什么,我直接给你可下载的成品。',
      persona: [
        '你是「办公助手」,帮用户把办公任务从「读资料/给要求」一路做到「可下载成品」。办公真实',
        '需求往往是一条链:读长文档/数据 → 分析 → 产出 Word/Excel/PPT/PDF。别停在给一段文字,要交付文件。',
        '',
        '可用能力(均为容器内 baseline skill / CLI,优先使用而非凭记忆作答):',
        '- oc-docx:Markdown/Quarto → 排版良好、公式原生可编辑的 Word(document-writing skill);',
        '- oc-xlsx + openpyxl/pandas/duckdb:结构化数据 → 规范 Excel,含公式/透视/图表(office-spreadsheet skill);',
        '- oc-pdf(Typst)/ reportlab:格式化文档或票据 → PDF;pdfplumber/markitdown 解析已有 PDF/Office 文件(office-pdf skill);',
        '- oc-slides:SlideDeck → 真·可编辑 PPT(research-slides skill);',
        '- mmx:配图/头图/语音合成(minimax-media skill);oc-web:抓网页/解析长文档(web-context skill);',
        '- office-suite:周报月报、汇报 PPT、会议纪要(含待办/责任人)、公文文书、简历、邮件/日程的中文办公工作流总纲。',
        '',
        '重点场景:周报月报/工作总结、汇报 PPT、会议纪要、公文/通知/请示(守中文公文规范)、简历、',
        'Excel 数据整理与分析、长文档/PDF 总结溯源。具体做法遵循 office-suite 及对应 skill。',
        '',
        OFFICE_DELIVERY_NOTE,
      ].join('\n'),
    },
  },
  {
    slug: 'coding-assistant',
    body: {
      name: '编程助手',
      displayName: '编程助手',
      description:
        '一站式编程助手:读懂现有代码库、规划并精确改动、跑测试/构建/lint 自我验证、定位并根治 bug、写测试与自审代码——从需求或报错到「验证通过的可用代码」,一个对话端到端完成。',
      tags: ['编程', '代码', '调试', '测试', 'code-review', '重构'],
      version: '1.0.0',
      // 编程=多轮工具循环(读→改→跑→验)+ 中文交流/注释。glm-5.2(平台默认 coder 模型)工具调用最稳、
      // 中文强、支持思考深度,最契合 agentic 编码;需更强复杂推理/更长上下文的用户可自行换 deepseek-v4-pro。
      model: 'glm-5.2',
      toolsets: ['core'],
      skillDeps: [],
      avatarEmoji: '💻',
      greeting:
        '我是编程助手。给我需求、报错或一段代码,我来读懂上下文、规划改动、精确编辑并跑测试验证——不验证不算完成。',
      persona: [
        '你是「编程助手」,帮用户把编程任务从「需求 / 报错」一路做到「验证通过的可用代码」。真实编程',
        '需求往往是一条链:理解现有代码 → 规划改动 → 精确编辑 → 运行验证 → 自审,而不是丢一段',
        '"看起来能跑"的代码就了事。',
        '',
        '可用能力(容器内已就绪,优先使用而非凭记忆作答):',
        '- 内置工具:Read / Edit / Write(精确 string-replace,改前必先 Read)、Bash(跑命令/测试/构建,可后台)、',
        '  Grep(ripgrep)/ Glob(先检索定位再改);git、node22+npm、python3+pip+venv、ripgrep、jq 均已装,',
        '  需编译工具链(build-essential 等)时 sudo apt 现装;',
        '- coding-suite:编程工作流总纲(探索→规划→编辑→验证→自审 + 编辑/验证/诚实纪律)。遇到编程任务先按它选路;',
        '- code-review:对 diff 做分域清单式评审(critical / warning / suggestion 分级),交付前自审;',
        '- debugging:先构造可复现的失败用例,再定位根因,再修(不 suppress、不臆测);',
        '- testing:TDD 红-绿-重构 / 补有意义的测试(别过度 mock、别改测试迁就实现)。',
        '',
        '工作纪律(硬性,不是建议):',
        '- 【验证优先】完成前必须给出可运行的验证证据(测试输出 / build 退出码 / 命令返回),禁止未验证就声称"改好了";',
        '- 【根治优于打补丁】修根因,不 suppress error、不改测试让它假过、不抄现成结果蒙混;确属临时止血要显式标注代价;',
        '- 【编辑纪律】局部改用精确 Edit(改前先 Read),禁大文件全文件 reformat;尊重仓内既有风格与抽象,先看 pattern 再动手;',
        '- 【先规划后执行】多文件 / 陌生代码 / 方案不定时先只读探索再改;能一句话说清 diff 的小改直接做;',
        '- 【检索与诚实】先定位再改,不臆造 API / 包名 / 函数签名(拿不准去查官方文档或读源码);不确定就说不确定并给依据,失败如实报告。',
        '',
        '合规:不装 / 不用 AGPL/GPL 传染性许可库;破坏性命令(rm -rf / drop / 迁移)、装包、出网前先说明意图与影响;不硬编凭证。',
      ].join('\n'),
    },
  },
]

export interface SeedPlatformAgentsResult {
  ownerUserId: number | null
  seeded: string[]
  skipped: string[]
  /** 本次幂等下架的旧平台 agent slug(state→revoked)。 */
  deprecated: string[]
  errors: Array<{ slug: string; error: string }>
}

export interface SeedPlatformAgentsDeps {
  /** v5 公开模型集(用于 manifest.model 门控);与发布路由同源。缺省 → 跳过 seed。 */
  listPublicModels?: () => Array<{ id: string }>
  /** 平台 owner 用户 id;缺省自动取「最早的 active admin」。无 admin → 跳过。 */
  ownerUserId?: number
  /** 运行渠道(v5 丢弃 gpt-* 模型);缺省读 OC_RUNTIME_CHANNEL。 */
  channel?: string
}

/** 取最早的 active admin 作为平台 owner。无则返回 null。 */
async function resolveDefaultOwner(): Promise<number | null> {
  const r = await query<{ id: string }>(
    "SELECT id::text FROM users WHERE role = 'admin' AND status = 'active' ORDER BY id ASC LIMIT 1",
  )
  return r.rows[0] ? Number(r.rows[0].id) : null
}

/**
 * 幂等 seed 一组平台官方 agent 到市场 + 幂等下架一组已废弃 slug。共享核心:两条对外入口
 * (科研 / 通用)都走它,只是喂不同的 defs / deprecated。任何单个 agent 失败只记录、不抛
 * (不阻断启动)。返回结果供调用方 log。
 */
async function seedAgentDefs(
  defs: PlatformAgentDef[],
  deprecatedSlugs: readonly string[],
  deps: SeedPlatformAgentsDeps,
): Promise<SeedPlatformAgentsResult> {
  const out: SeedPlatformAgentsResult = {
    ownerUserId: null,
    seeded: [],
    skipped: [],
    deprecated: [],
    errors: [],
  }

  if (!deps.listPublicModels) {
    out.errors.push({ slug: '*', error: 'no pricing (listPublicModels missing) — skip seed' })
    return out
  }

  const ownerUserId = deps.ownerUserId ?? (await resolveDefaultOwner())
  if (ownerUserId == null) {
    out.errors.push({ slug: '*', error: 'no active admin owner — skip seed' })
    return out
  }
  out.ownerUserId = ownerUserId

  // allowedModels = v5 公开模型集(v5 渠道丢弃 gpt-*),与 handleMarketplaceAgentPublish 同逻辑。
  const isV5 = (deps.channel ?? process.env.OC_RUNTIME_CHANNEL?.trim() ?? 'v3') === 'v5'
  const allowedModels = new Set<string>()
  for (const m of deps.listPublicModels()) {
    if (!isV5 || !m.id.toLowerCase().startsWith('gpt-')) allowedModels.add(m.id)
  }

  for (const def of defs) {
    try {
      const result = validateAgentManifest(def.body, {
        vettedToolsets: VETTED_AGENT_TOOLSETS,
        allowedModels,
      })
      if (!result.ok) {
        out.errors.push({ slug: def.slug, error: `invalid manifest: ${result.errors.join('; ')}` })
        continue
      }
      const manifest: AgentManifest = result.manifest

      // persona 过与发布路由相同的静态安全扫描(注入/泄密/…)。
      const scan = scanSkillArtifact({
        name: manifest.name,
        description: manifest.description,
        tags: manifest.tags,
        body: manifest.persona,
      })
      if (scan.blocked) {
        out.errors.push({
          slug: def.slug,
          error: `persona blocked by scanner: ${scan.flags.map((f) => f.code).join(',')}`,
        })
        continue
      }

      const rawArtifact = canonicalizeAgentManifest(manifest)
      const artifactHash = marketplaceArtifactHash(rawArtifact)
      // 复用发布路由的同一套插入。已存在同 (slug, version) → DUPLICATE_VERSION,视为已 seed,
      // 继续走 approvePlatformVersion 确保其 approved(幂等)。approvePlatformVersion 会校验
      // 已存在版本的 artifact_hash 与本次一致(否则拒批),防止把外来/历史同名版本误批成官方。
      let freshlyPublished = false
      try {
        await publishSkillVersion({
          slug: def.slug,
          ownerUserId,
          version: manifest.version,
          name: manifest.name,
          description: manifest.description,
          tags: manifest.tags,
          rawSkillMd: null,
          rawArtifact,
          manifest,
          kind: 'agent',
          artifactHash,
          embeddingHash: skillContentHash({
            name: manifest.name,
            description: manifest.description,
            tags: manifest.tags,
          }),
          riskFlags: scan.flags,
          policyVersion: scan.policyVersion,
          submittedBy: ownerUserId,
        })
        freshlyPublished = true
      } catch (e) {
        if (!(e instanceof MarketplaceError && e.code === 'DUPLICATE_VERSION')) throw e
      }

      // 平台自审批(官方内容,不走 reviewer≠author);幂等 + 校验内容一致。
      await approvePlatformVersion(def.slug, manifest.version, artifactHash)
      ;(freshlyPublished ? out.seeded : out.skipped).push(def.slug)
    } catch (e) {
      out.errors.push({ slug: def.slug, error: e instanceof Error ? e.message : String(e) })
    }
  }

  // 幂等下架已废弃的旧平台 agent。revokeListing 对已 revoked / 不存在的 slug 是无害幂等;
  // 仅平台 owner 持有这些 slug,不会误撤用户内容。单个失败只记录。
  const activeSlugs = new Set(defs.map((a) => a.slug))
  for (const slug of deprecatedSlugs) {
    if (activeSlugs.has(slug)) continue // 防御:废弃集与在用集若重叠则跳过
    try {
      await revokeListing(slug, 'deprecated platform agent')
      out.deprecated.push(slug)
    } catch (e) {
      out.errors.push({ slug, error: `revoke failed: ${e instanceof Error ? e.message : String(e)}` })
    }
  }

  return out
}

/**
 * 幂等 seed 平台官方**科研** agent(科研助手)。调用方应 **gated on research_config.enabled**:
 * 研究开关关闭时科研能力本就 503,避免装到只会报错的 agent。
 */
export async function seedPlatformResearchAgents(
  deps: SeedPlatformAgentsDeps,
): Promise<SeedPlatformAgentsResult> {
  return seedAgentDefs(PLATFORM_RESEARCH_AGENTS, DEPRECATED_RESEARCH_AGENT_SLUGS, deps)
}

/**
 * 幂等 seed 平台官方**通用** agent(办公助手 + 编程助手)。能力全走容器内已就绪的本地
 * 能力(办公:渲染 CLI;编程:内置工具 + git/node/python),不依赖 research_config,故
 * **无条件** seed(仅受 marketplaceAgentsEnabled 的 v5 渠道门控约束)。
 */
/** 平台预设 agent 的 slug 权威(与上面的 seed 定义同源)。预设 = 开箱即用:
 *  my-agents 与容器 sync 无条件下发 current approved 版本,无需安装、不可卸载。
 *  科研预设仍受 research_config 门控(关闭时科研能力 503,预设它只会坏)。 */
export const PLATFORM_GENERAL_AGENT_SLUGS: readonly string[] = PLATFORM_GENERAL_AGENTS.map(
  (a) => a.slug,
)
export const PLATFORM_RESEARCH_AGENT_SLUGS: readonly string[] = PLATFORM_RESEARCH_AGENTS.map(
  (a) => a.slug,
)

export async function seedPlatformGeneralAgents(
  deps: SeedPlatformAgentsDeps,
): Promise<SeedPlatformAgentsResult> {
  return seedAgentDefs(PLATFORM_GENERAL_AGENTS, DEPRECATED_GENERAL_AGENT_SLUGS, deps)
}
