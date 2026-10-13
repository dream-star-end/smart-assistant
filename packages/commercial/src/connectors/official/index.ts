/**
 * 平台官方的**市场**连接器(OCV5-402)。与 `../defaults/`(预装)不同:这里的条目只上 AI 市场,
 * 用户自己安装,目录/授权都按普通市场条目走;唯一的特权是可以用 authMode `none` 和平台 builtin。
 *
 * 官方身份 = 保留 slug + 代码内置工件的精确 hash(同 `isDefaultConnectorArtifact`)。spec 改一个字,
 * hash 就变,旧 hash 立即失去特权 —— 所以改 spec 必须同时升版本并重新走审核 seed。
 */

import { canonicalSha256Hex } from '../spec/canonical.js'
import type { ConnectorSpecT, ExecContractT, SecurityDecisionT } from '../spec/types.js'
import {
  BILI_CONNECTOR_SLUG,
  BILI_CONNECTOR_VERSION,
  BILI_LISTING,
  biliConnectorDecision,
  biliConnectorSpec,
} from './bili.js'

export interface OfficialMarketConnector {
  slug: string
  version: string
  spec: ConnectorSpecT
  decision: SecurityDecisionT
  listing: {
    name: string
    description: string
    tags: readonly string[]
    category: string
    useCases: readonly string[]
    outcomeExamples: readonly string[]
    humanMd: string
  }
}

export const OFFICIAL_MARKET_CONNECTORS: readonly OfficialMarketConnector[] = [
  {
    slug: BILI_CONNECTOR_SLUG,
    version: BILI_CONNECTOR_VERSION,
    spec: biliConnectorSpec,
    decision: biliConnectorDecision,
    listing: BILI_LISTING,
  },
]

export const OFFICIAL_MARKET_CONNECTOR_SLUGS: readonly string[] = OFFICIAL_MARKET_CONNECTORS.map(
  (c) => c.slug,
)

const OFFICIAL_ARTIFACTS: ReadonlyMap<string, string> = new Map(
  OFFICIAL_MARKET_CONNECTORS.map((c) => [c.slug, canonicalSha256Hex(c.spec)]),
)

export function isOfficialMarketConnectorSlug(slug: string): boolean {
  return OFFICIAL_ARTIFACTS.has(slug)
}

/** 官方身份必须同时匹配保留 slug 与代码内置工件 hash。 */
export function isOfficialConnectorArtifact(slug: string, artifactHash: string): boolean {
  return OFFICIAL_ARTIFACTS.get(slug) === artifactHash
}

/** 契约用到了只有官方工件才能用的能力(authMode none 或任何 builtin)。 */
export function contractNeedsOfficialArtifact(contract: ExecContractT): boolean {
  return (
    contract.authMode === 'none' ||
    contract.actions.some(
      (a) => a.requestTransform !== undefined || a.resultTransform !== undefined,
    )
  )
}
