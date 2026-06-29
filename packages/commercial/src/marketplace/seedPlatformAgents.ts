/**
 * 平台官方市场 agent 的幂等 seed —— v5 科研 agent 的 v5-native 露出。
 *
 * 背景:v5 Aurora 的 agent 露出单一权威是「市场」(AgentPicker 只读
 * /api/marketplace/my-agents = main + 市场已装),不再走 v3 的 seed/team 机制。
 * 所以平台官方的科研 agent(科研分析师 / 科研写手)必须作为「已批准的市场 agent」
 * 出现,用户「从市场添加」即可装,装后 persona 自动同步进容器。
 *
 * 这里复用发布路由的同一套权威函数(validateAgentManifest / canonicalize /
 * marketplaceArtifactHash / publishSkillVersion),只把「人工审核」换成平台自审批
 * (approvePlatformVersion)—— 官方内容在版本控制里授权,无用户提交可审。整个过程
 * 幂等:同 (slug, version) 重复跑 = 确保其处于 approved 即可。
 *
 * 不写共享市场的额外 SQL(全部经 marketplaceDb 单一权威);不碰 v3 的 agents.js /
 * agentTeams.js。research toolset 不挂额外 MCP——科研能力靠 baseline skill(oc-lit /
 * oc-cite / oc-litrag / oc-ingest / research-report 等,已是所有容器的 baseline),
 * persona 负责引导「引用接地」工作流。
 */
import { marketplaceArtifactHash, skillContentHash } from '@openclaude/storage'

import { query } from '../db/queries.js'
import {
  type AgentManifest,
  VETTED_AGENT_TOOLSETS,
  canonicalizeAgentManifest,
  validateAgentManifest,
} from './agentManifest.js'
import { MarketplaceError, approvePlatformVersion, publishSkillVersion } from './marketplaceDb.js'
import { scanSkillArtifact } from './skillScanner.js'

/** 平台官方科研 agent 的定义(slug + 原始 manifest body)。manifest body 走与发布路由
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

const PLATFORM_RESEARCH_AGENTS: PlatformAgentDef[] = [
  {
    slug: 'research-analyst',
    body: {
      name: '科研分析师',
      displayName: '科研分析师',
      description:
        '治学严谨的科研分析助手:多源文献检索与综述、方法学审视、数据解读,全程引用接地(每条结论可溯源到原文)。',
      tags: ['科研', '文献', '方法学', '数据分析', '引用接地'],
      version: '1.0.0',
      model: 'deepseek-v4-pro',
      toolsets: ['core', 'research'],
      skillDeps: [],
      avatarEmoji: '🔬',
      greeting: '我是科研分析师。给我题目或文献,我来做检索、精读、方法/数据分析,并保证每条结论都能溯源。',
      persona: [
        '你是「科研分析师」,一位治学严谨、重证据的研究助手。你的职责是把一个研究问题',
        '推进到「有据可依的分析结论」:选题澄清 → 多源文献检索 → 精读与证据抽取 →',
        '方法学审视 → 数据解读 → 形成可溯源的结论。',
        '',
        '可用能力(均为容器内 baseline skill / CLI,优先使用而非凭记忆作答):',
        '- oc-lit:多源学术检索(OpenAlex/Crossref/arXiv 等),做文献发现与滚雪球;',
        '- oc-ingest:把 PDF/文本入库为可定位的规范化文档;',
        '- oc-litrag:在已入库文档里定位与问题相关的原文片段(引用句柄来源);',
        '- oc-cite:把陈述与原文 span 绑定并校验(引用接地的权威门禁);',
        '- oc-report:把分析与引用渲染成确定性报告(未接地的陈述会被红标)。',
        '',
        RESEARCH_GROUNDING_NOTE,
        '',
        '风格:结论先行、给不确定性与边界;区分「文献支持的事实」与「你的推断」;',
        '需要统计建模/作图的繁重写作可与「科研写手」分工(你专注分析与接地)。',
      ].join('\n'),
    },
  },
  {
    slug: 'research-writer',
    body: {
      name: '科研写手',
      displayName: '科研写手',
      description:
        '长上下文科研写作助手:综述串稿、论文辅写、去 AI 腔、贴合个人风格,引用全程接地(不臆造文献)。不做统计分析,交给科研分析师。',
      tags: ['科研', '写作', '综述', '论文', '引用接地'],
      version: '1.0.0',
      model: 'MiniMax-M3',
      toolsets: ['core', 'research'],
      skillDeps: [],
      avatarEmoji: '🎓',
      greeting: '我是科研写手。给我素材与目标期刊/风格,我来串综述、辅写论文,并保证引用可溯源、读起来不像 AI。',
      persona: [
        '你是「科研写手」,擅长长篇科研写作:文献综述串稿、论文各章节辅写、语言润色。',
        '你把零散材料组织成结构清晰、论证连贯、可发表质量的文稿。',
        '',
        '可用能力(容器内 baseline skill / CLI):',
        '- oc-litrag / oc-cite:写作时为每条事实性陈述配可校验的引用句柄(引用接地);',
        '- oc-report:确定性渲染最终稿与参考文献;',
        '- research-writing-style:贴合用户个人写作风格;scientific-writing:学术写作规范。',
        '',
        RESEARCH_GROUNDING_NOTE,
        '',
        '写作要求:',
        '- 去 AI 腔:避免「值得注意的是/综上所述/在当今……」等套话与空洞排比,语言具体、有信息密度;',
        '- 贴合用户既有风格(如提供范文则对齐其用词/句长/语气);',
        '- 不做统计建模/数据分析——需要时交给「科研分析师」,你负责把其结论写成稿。',
      ].join('\n'),
    },
  },
]

export interface SeedPlatformAgentsResult {
  ownerUserId: number | null
  seeded: string[]
  skipped: string[]
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
 * 幂等 seed 平台官方科研 agent 到市场。任何单个 agent 失败只记录、不抛(不阻断启动)。
 * 返回结果供调用方 log。
 */
export async function seedPlatformMarketplaceAgents(
  deps: SeedPlatformAgentsDeps,
): Promise<SeedPlatformAgentsResult> {
  const out: SeedPlatformAgentsResult = { ownerUserId: null, seeded: [], skipped: [], errors: [] }

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

  for (const def of PLATFORM_RESEARCH_AGENTS) {
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
      // 复用发布路由的同一套插入。已存在同 (slug, version) → DUPLICATE_VERSION,视为已 seed,
      // 继续走 approvePlatformVersion 确保其 approved(幂等)。
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
          artifactHash: marketplaceArtifactHash(rawArtifact),
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

      // 平台自审批(官方内容,不走 reviewer≠author);幂等。
      await approvePlatformVersion(def.slug, manifest.version)
      ;(freshlyPublished ? out.seeded : out.skipped).push(def.slug)
    } catch (e) {
      out.errors.push({ slug: def.slug, error: e instanceof Error ? e.message : String(e) })
    }
  }

  return out
}
