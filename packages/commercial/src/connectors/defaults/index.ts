/**
 * 默认连接器注册表(seed 源)。boss 默认集:Notion 已就绪(static-token);飞书/企微/钉钉
 * (token-exchange)、GitHub、QQ邮箱(imap-smtp)、WPS(hmac)随各自引擎能力就绪逐个加入。
 *
 * seed 机制(declarativeSeed.ts)遍历本表 → 建 listing+version → reviewer 编译签名成 exec_contract。
 */

import { feishuDefault } from './feishu.js'
import { githubDefault } from './github.js'
import { notionDefault } from './notion.js'
import { canonicalSha256Hex } from '../spec/canonical.js'
import type { DefaultConnector } from './types.js'

export const DEFAULT_CONNECTORS: readonly DefaultConnector[] = [
  notionDefault,
  feishuDefault,
  githubDefault,
]

/** 官方预装身份的服务端单一权威；前端只读响应字段，绝不自行按 slug 推断。 */
export const DEFAULT_CONNECTOR_SLUGS = DEFAULT_CONNECTORS.map((d) => d.spec.id)
export const DEFAULT_CONNECTOR_ARTIFACT_HASHES = DEFAULT_CONNECTORS.map((d) =>
  canonicalSha256Hex(d.spec),
)
export const DEFAULT_CONNECTOR_SLUG_SET: ReadonlySet<string> = new Set(DEFAULT_CONNECTOR_SLUGS)
const DEFAULT_CONNECTOR_ARTIFACTS: ReadonlyMap<string, string> = new Map(
  DEFAULT_CONNECTORS.map((d) => [d.spec.id, canonicalSha256Hex(d.spec)]),
)

export function isDefaultConnectorSlug(slug: string): boolean {
  return DEFAULT_CONNECTOR_SLUG_SET.has(slug)
}

/** 官方身份必须同时匹配保留 slug 与代码内置工件 hash，seed 冲突时宁可 fail-closed。 */
export function isDefaultConnectorArtifact(slug: string, artifactHash: string): boolean {
  return DEFAULT_CONNECTOR_ARTIFACTS.get(slug) === artifactHash
}

export type { DefaultConnector } from './types.js'
