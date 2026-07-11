/**
 * 技能发布管线单一权威 —— 浏览器路由(marketplaceRoutes.handleMarketplacePublish)
 * 与容器内部代理(internalMarketplaceAgent.handlePublish 的 skill 分支)共用的
 * 校验/扫描/规范化核心。
 *
 * 历史根因:两条 publish 路径各自手写同一套逻辑,已经漂移 —— 内部路径长期缺
 * bundle(references/assets/evals/scripts)、benchmark、逐附属文件扫描,导致容器内
 * AI 只能发布单文件技能(2026-07-11 boss 实测暴露)。收口后能力差异只剩传输层
 * (鉴权方式、org 解析、响应信封),内容规则永远同源。
 *
 * 职责边界:
 *  - 管线管「内容」:字段校验、人向元数据、bundle/benchmark、静态安全扫描、
 *    canonical SKILL.md 重建、hash —— 返回可直接喂 publishSkillVersion 的参数。
 *  - 调用方管「身份与传输」:auth、ownerUserId/orgId 解析、把 reject 映射成各自
 *    响应信封。管线不碰 req/res,便于单测。
 */
import { marketplaceArtifactHash, skillContentHash } from '@openclaude/storage'

import {
  type BundleFiles,
  scanScriptContent,
  validateBenchmark,
  validateBundleFiles,
} from './bundle.js'
import {
  HumanMetaError,
  type HumanMeta,
  humanMetaScanBody,
  parseHumanMeta,
} from './marketplaceMeta.js'
import { type RiskFlag, scanSkillArtifact } from './skillScanner.js'

/** 正文(不含 frontmatter)上限 —— 与历史两处 MAX_BODY 同值,收口于此。 */
export const SKILL_BODY_MAX_BYTES = 64 * 1024

/**
 * 发布请求整体 body 上限。发布是唯一合法携带 bundle 的入口:正文 64KB +
 * bundle 总量 256KB + 富介绍 16KB + 元数据与 JSON 转义放大(中文 \uXXXX 最坏 ×6)。
 * 有界即可防 DoS;其余路由维持全局 64KB 默认,不放大攻击面。
 */
export const PUBLISH_MAX_REQUEST_BYTES = 2 * 1024 * 1024

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,63}$/
const VERSION_RE = /^\d+\.\d+\.\d+$/
// tags 会变成 canonical SKILL.md frontmatter 里的 YAML inline array;拒掉一切可能
// 破坏/注入 YAML 的字符(与历史两处 TAG_SAFE_RE 同值,收口于此)。
const TAG_SAFE_RE = /^[^,[\]"'<>\r\n]{1,64}$/
const MAX_TAGS = 16

export interface SkillPublishReject {
  ok: false
  /** 400=入参形态错;422=内容被规则/扫描拒绝(与既有两条路径的语义一致)。 */
  status: 400 | 422
  code: string
  message: string
  /** BAD_BUNDLE 时逐文件错误明细。 */
  errors?: string[]
  /** SCAN_BLOCKED 时命中的风险标记。 */
  riskFlags?: RiskFlag[]
}

export interface SkillPublishPrepared {
  ok: true
  slug: string
  version: string
  name: string
  description: string
  tags: string[]
  humanMeta: HumanMeta
  rawSkillMd: string
  artifactHash: string
  embeddingHash: string
  /** 正文扫描 flag + scripts 危险模式 warning flag(发布者与审核者看同一份)。 */
  riskFlags: RiskFlag[]
  policyVersion: number
  rawBundle: BundleFiles | null
  benchmark: { withPassRate: number; withoutPassRate: number; cases: number } | null
}

const reject = (
  status: 400 | 422,
  code: string,
  message: string,
  extra?: { errors?: string[]; riskFlags?: RiskFlag[] },
): SkillPublishReject => ({ ok: false, status, code, message, ...extra })

function strField(v: unknown, field: string, max: number): string | SkillPublishReject {
  if (typeof v !== 'string' || v.length === 0)
    return reject(400, 'BAD_REQUEST', `${field} required`)
  if (v.length > max) return reject(400, 'BAD_REQUEST', `${field} too long`)
  return v
}

function parseTags(v: unknown): string[] | SkillPublishReject {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v)) return reject(400, 'BAD_TAG', 'tags 须为字符串数组')
  const out: string[] = []
  for (const t of v) {
    if (typeof t !== 'string') return reject(400, 'BAD_TAG', 'tags 须为字符串数组')
    const tag = t.trim()
    if (!tag) continue
    if (!TAG_SAFE_RE.test(tag)) return reject(400, 'BAD_TAG', 'tag 含非法字符')
    out.push(tag)
  }
  return out.slice(0, MAX_TAGS)
}

/**
 * 校验 + 扫描 + 规范化一次发布请求;纯函数(不做 IO、不碰 req/res)。
 * 返回的 prepared 字段可直接展开进 publishSkillVersion(调用方补
 * ownerUserId/submittedBy/orgId/kind)。
 */
export function prepareSkillPublish(
  body: Record<string, unknown>,
): SkillPublishPrepared | SkillPublishReject {
  // 错误码契约(收口时显式统一;历史两条路径本就互相矛盾,不逐条迁就):
  //   slug 的一切问题 → BAD_SLUG;version 的一切问题 → BAD_VERSION;
  //   name/description/body 缺失或超长 → BAD_REQUEST;tags 非法 → BAD_TAG
  //   (tags: null 视同缺省 —— JSON 客户端的合法表达)。
  // Web PublishPanel 不依赖 400 级错误码细分(Codex R1 已核),改码零破坏面。
  const slugV = typeof body.slug === 'string' && SLUG_RE.test(body.slug) ? body.slug : null
  if (!slugV) return reject(400, 'BAD_SLUG', 'slug 须为小写字母数字连字符(2-64)')
  const versionV =
    typeof body.version === 'string' && body.version.length <= 16 && VERSION_RE.test(body.version)
      ? body.version
      : null
  if (!versionV) return reject(400, 'BAD_VERSION', 'version 须为 N.N.N')
  const nameV = strField(body.name, 'name', 64)
  if (typeof nameV !== 'string') return nameV
  const descriptionV = strField(body.description, 'description', 1024)
  if (typeof descriptionV !== 'string') return descriptionV
  const skillBodyV = strField(body.body, 'body', SKILL_BODY_MAX_BYTES)
  if (typeof skillBodyV !== 'string') return skillBodyV
  const tagsV = parseTags(body.tags)
  if (!Array.isArray(tagsV)) return tagsV

  // 人向商品层元数据(必填 category/useCases;单一校验权威 parseHumanMeta)。
  let humanMeta: HumanMeta
  try {
    humanMeta = parseHumanMeta(body)
  } catch (e) {
    if (e instanceof HumanMetaError) return reject(400, e.code, e.message)
    throw e
  }

  // 附属文件(references/assets/evals/scripts)+ 发布者自报评测摘要。
  const bundleV = validateBundleFiles(
    Array.isArray(body.files)
      ? (body.files as Array<{ path?: unknown; content?: unknown }>)
      : undefined,
  )
  if (!bundleV.ok)
    return reject(422, 'BAD_BUNDLE', '附属文件不合法,请按提示修正', { errors: bundleV.errors })
  const benchV = validateBenchmark(body.benchmark)
  if (!benchV.ok) return reject(422, 'BAD_BENCHMARK', benchV.error)

  // 正文/商品页文案/逐附属文件 —— 同一套静态安全扫描(密钥/注入/内网地址)。
  const scan = scanSkillArtifact({ name: nameV, description: descriptionV, tags: tagsV, body: skillBodyV })
  if (scan.blocked)
    return reject(422, 'SCAN_BLOCKED', '发布被静态安全扫描拦截,请修正后重试', {
      riskFlags: scan.flags,
    })
  const metaScan = scanSkillArtifact({
    name: nameV,
    description: '',
    tags: [],
    body: humanMetaScanBody(humanMeta),
  })
  if (metaScan.blocked)
    return reject(422, 'SCAN_BLOCKED', '商品页文案被静态安全扫描拦截,请修正后重试', {
      riskFlags: metaScan.flags,
    })
  // scripts/ 额外过危险模式扫描:毁灭性/远程管道执行直接拦,可疑模式作为
  // warning flag 随版本入库(审核页可见,人审判断)。
  const scriptFlags: RiskFlag[] = []
  if (bundleV.bundle) {
    for (const [path, content] of Object.entries(bundleV.bundle)) {
      const fscan = scanSkillArtifact({ name: slugV, description: path, tags: [], body: content })
      if (fscan.blocked)
        return reject(422, 'SCAN_BLOCKED', `附属文件 ${path} 被安全扫描拦截`, {
          riskFlags: fscan.flags,
        })
      if (path.startsWith('scripts/')) {
        const sflags = scanScriptContent(path, content)
        const blocked = sflags.filter((f) => f.block)
        if (blocked.length > 0)
          return reject(422, 'SCAN_BLOCKED', `脚本 ${path} 命中危险模式,发布被拦截`, {
            riskFlags: sflags,
          })
        scriptFlags.push(...sflags)
      }
    }
  }

  // Reconstruct a canonical SKILL.md so the stored artifact == what installs.
  // frontmatter `name` 用 slug(非展示名):运行时 overlay 按 frontmatter name 键
  // 技能、按目录名 resolve view(),hub 又按 slug 建目录 —— slug 保证 name===dir,
  // 装上后既可列出又可查看;人向展示名只进 DB 供商品页用。
  const fm = [
    '---',
    `name: ${slugV}`,
    `description: ${JSON.stringify(descriptionV)}`,
    ...(tagsV.length ? [`tags: [${tagsV.join(', ')}]`] : []),
    `version: ${versionV}`,
    '---',
    '',
  ].join('\n')
  const rawSkillMd = `${fm + skillBodyV.replace(/\r\n/g, '\n').trimEnd()}\n`

  return {
    ok: true,
    slug: slugV,
    version: versionV,
    name: nameV,
    description: descriptionV,
    tags: tagsV,
    humanMeta,
    rawSkillMd,
    artifactHash: marketplaceArtifactHash(rawSkillMd),
    embeddingHash: skillContentHash({
      name: nameV,
      description: descriptionV,
      tags: tagsV,
      use_cases: humanMeta.useCases,
    }),
    riskFlags: [...scan.flags, ...scriptFlags],
    policyVersion: scan.policyVersion,
    rawBundle: bundleV.bundle,
    benchmark: benchV.benchmark,
  }
}
