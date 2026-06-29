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
import {
  MarketplaceError,
  approvePlatformVersion,
  publishSkillVersion,
  revokeListing,
} from './marketplaceDb.js'
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

// 已废弃的旧平台科研 agent:v5 当前一对话一个 agent、市场 agent 又禁止 teams/委派,
// 「分析师 + 写手」无法接力,拆分只剩切换的麻烦 → 合并为单个端到端「科研助手」。
// seed 时幂等下架这些旧 slug(等 v5 蜂群协作落地,再以 team 形式重新放出专业分工)。
const DEPRECATED_PLATFORM_AGENT_SLUGS = ['research-analyst', 'research-writer'] as const

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
 * 幂等 seed 平台官方科研 agent 到市场。任何单个 agent 失败只记录、不抛(不阻断启动)。
 * 返回结果供调用方 log。
 */
export async function seedPlatformMarketplaceAgents(
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

  // 幂等下架已废弃的旧平台 agent(合并前的分析师/写手)。revokeListing 对已 revoked / 不存在
  // 的 slug 是无害幂等;仅平台 owner 持有这些 slug,不会误撤用户内容。单个失败只记录。
  const activeSlugs = new Set(PLATFORM_RESEARCH_AGENTS.map((a) => a.slug))
  for (const slug of DEPRECATED_PLATFORM_AGENT_SLUGS) {
    if (activeSlugs.has(slug)) continue // 防御:废弃集与在用集若重叠则跳过
    try {
      await revokeListing(slug, 'deprecated: 合并为单个「科研助手」端到端 agent')
      out.deprecated.push(slug)
    } catch (e) {
      out.errors.push({ slug, error: `revoke failed: ${e instanceof Error ? e.message : String(e)}` })
    }
  }

  return out
}
