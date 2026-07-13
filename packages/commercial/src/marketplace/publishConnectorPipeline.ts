/**
 * 连接器发布内容管线单一权威。
 *
 * 浏览器发布与容器内 AI 发布只在鉴权、org 解析和响应信封上不同；ConnectorSpec、
 * publisher-proposed SecurityDecision、BYOA、identity、扫描与 hash 规则全部在这里
 * 校验，避免两条入口漂移。
 */
import { skillContentHash } from '@openclaude/storage'

import { requiredBindSources } from '../connectors/engine/credentialBag.js'
import { canonicalBytes } from '../connectors/spec/canonical.js'
import { compileSpec } from '../connectors/spec/compiler.js'
import { ConnectorSpecError } from '../connectors/spec/types.js'
import {
  type HumanMeta,
  HumanMetaError,
  humanMetaScanBody,
  parseHumanMeta,
} from './marketplaceMeta.js'
import { type RiskFlag, scanSkillArtifact } from './skillScanner.js'

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,63}$/
const VERSION_RE = /^\d+\.\d+\.\d+$/

export interface ConnectorPublishReject {
  ok: false
  status: 400 | 422
  code: string
  message: string
  riskFlags?: RiskFlag[]
}

export interface ConnectorPublishPrepared {
  ok: true
  slug: string
  version: string
  name: string
  description: string
  tags: string[]
  humanMeta: HumanMeta
  rawArtifact: string
  artifactHash: string
  embeddingHash: string
  riskFlags: RiskFlag[]
  policyVersion: number
  proposedSecurityDecision: unknown
}

const reject = (
  status: 400 | 422,
  code: string,
  message: string,
  riskFlags?: RiskFlag[],
): ConnectorPublishReject => ({
  ok: false,
  status,
  code,
  message,
  ...(riskFlags ? { riskFlags } : {}),
})

export function prepareConnectorPublish(
  body: Record<string, unknown>,
): ConnectorPublishPrepared | ConnectorPublishReject {
  const version = body.version
  if (typeof version !== 'string' || version.length > 32 || !VERSION_RE.test(version))
    return reject(400, 'BAD_VERSION', 'version 须为 x.y.z')

  const specInput = body.spec
  if (!specInput || typeof specInput !== 'object' || Array.isArray(specInput))
    return reject(400, 'BAD_REQUEST', 'spec must be a ConnectorSpec JSON object')
  const spec = specInput as Record<string, unknown>
  const slug = typeof spec.id === 'string' ? spec.id : ''
  if (!SLUG_RE.test(slug)) return reject(400, 'BAD_SLUG', 'spec.id 须为小写字母数字连字符(2-64)')
  if (!spec.identity || typeof spec.identity !== 'object' || Array.isArray(spec.identity))
    return reject(422, 'IDENTITY_REQUIRED', '连接器必须声明 identity probe 才能绑定账号')

  const proposedSecurityDecision = body.securityDecision
  let compiled: ReturnType<typeof compileSpec>
  try {
    compiled = compileSpec(specInput, proposedSecurityDecision)
    requiredBindSources(compiled.execContract)
  } catch (e) {
    if (e instanceof ConnectorSpecError) return reject(422, e.code, e.code)
    throw e
  }
  if (
    compiled.execContract.authMode === 'oauth2-auth-code' &&
    compiled.execContract.oauth2?.clientProvisioning !== 'byoa'
  ) {
    return reject(
      422,
      'PLATFORM_OAUTH_RESERVED',
      '社区 OAuth2 连接器必须使用 BYOA；平台代管应用仅限官方预装连接器',
    )
  }

  const name = typeof spec.label === 'string' ? spec.label : slug
  const description = typeof spec.description === 'string' ? spec.description : ''
  const tags = Array.isArray(body.tags)
    ? body.tags
        .filter((x): x is string => typeof x === 'string')
        .map((x) => x.trim())
        .filter(Boolean)
        .slice(0, 20)
    : ['连接器']

  let humanMeta: HumanMeta
  try {
    humanMeta = parseHumanMeta(body)
  } catch (e) {
    if (e instanceof HumanMetaError) return reject(400, e.code, e.message)
    throw e
  }

  const rawArtifact = canonicalBytes(specInput).toString('utf8')
  const scan = scanSkillArtifact({ name, description, tags, body: rawArtifact })
  if (scan.blocked)
    return reject(422, 'SCAN_BLOCKED', '连接器声明被静态安全扫描拦截,请修正后重试', scan.flags)
  const metaScan = scanSkillArtifact({
    name,
    description: '',
    tags: [],
    body: humanMetaScanBody(humanMeta),
  })
  if (metaScan.blocked)
    return reject(422, 'SCAN_BLOCKED', '商品页文案被静态安全扫描拦截,请修正后重试', metaScan.flags)

  return {
    ok: true,
    slug,
    version,
    name,
    description,
    tags,
    humanMeta,
    rawArtifact,
    artifactHash: compiled.specHash,
    embeddingHash: skillContentHash({
      name,
      description,
      tags,
      use_cases: humanMeta.useCases,
    }),
    // 两次扫描都属于同一投稿；元数据里的注入/密钥信号不能在进入 AI 审核时丢失。
    riskFlags: [...scan.flags, ...metaScan.flags],
    policyVersion: scan.policyVersion,
    proposedSecurityDecision,
  }
}
