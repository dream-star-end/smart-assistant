/**
 * 连接器安装/绑定/执行授权的服务端单一权威。
 *
 * bind entitlement 钉死「当前可上架版本 + 用户精确安装 pin」；execution entitlement
 * 则允许已绑定连接继续使用自己的旧 pin，只要 listing 仍 active、该 pin 仍获批且用户仍
 * 安装了同一 market connector。默认连接器由后端白名单识别，永远不产生 per-user install。
 */
import type { QueryRunner } from '../db/queries.js'
import { isDefaultConnectorArtifact } from './defaults/index.js'
import { ConnectorError } from './errors.js'

interface EntitlementRow {
  slug: string
  kind: string
  version_status: string
  artifact_hash: string
  security_review_state: string
  functional_verify_state: string
  exec_revoked_at: Date | null
  listing_state: string
  current_approved_version_id: string | null
}

async function loadEntitlementRow(
  versionId: string | number,
  runner: QueryRunner,
): Promise<EntitlementRow | null> {
  const r = await runner.query<EntitlementRow>(
    `SELECT v.slug, l.kind, v.status AS version_status, v.artifact_hash,
            v.security_review_state, v.functional_verify_state, v.exec_revoked_at,
            l.state AS listing_state, l.current_approved_version_id::text
       FROM marketplace_skill_versions v
       JOIN marketplace_skill_listings l ON l.slug = v.slug
      WHERE v.id = $1`,
    [versionId],
  )
  return r.rows[0] ?? null
}

function assertExecutableState(row: EntitlementRow | null): asserts row is EntitlementRow {
  if (
    row == null ||
    row.kind !== 'connector' ||
    row.version_status !== 'approved' ||
    row.listing_state !== 'active' ||
    row.security_review_state !== 'security_approved' ||
    row.functional_verify_state !== 'verified' ||
    row.exec_revoked_at !== null
  ) {
    throw new ConnectorError('RELINK_REQUIRED', 'connector version is not executable')
  }
}

/** 新绑定/OAuth 起点及回调最终写入：market connector 必须精确安装当前 version+hash。 */
export async function assertConnectorBindEntitlement(
  userId: number,
  versionId: string | number,
  runner: QueryRunner,
): Promise<{ slug: string; artifactHash: string; official: boolean }> {
  const row = await loadEntitlementRow(versionId, runner)
  assertExecutableState(row)
  if (row.current_approved_version_id !== String(versionId))
    throw new ConnectorError('RELINK_REQUIRED', 'connector version is no longer current')

  const official = isDefaultConnectorArtifact(row.slug, row.artifact_hash)
  if (!official) {
    const installed = await runner.query(
      `SELECT 1
         FROM marketplace_installs
        WHERE user_id = $1 AND slug = $2 AND version_id = $3
          AND artifact_hash = $4 AND uninstalled_at IS NULL`,
      [userId, row.slug, versionId, row.artifact_hash],
    )
    if ((installed.rowCount ?? 0) === 0)
      throw new ConnectorError(
        'CONNECTOR_NOT_INSTALLED',
        'connector exact version is not installed',
      )
  }
  return { slug: row.slug, artifactHash: row.artifact_hash, official }
}

/** 已有连接执行：允许旧 pin，但 market connector 必须仍有同 slug 的活跃安装。 */
export async function assertConnectorExecutionEntitlement(
  userId: number,
  slug: string,
  versionId: string | number,
  runner: QueryRunner,
): Promise<void> {
  const row = await loadEntitlementRow(versionId, runner)
  assertExecutableState(row)
  if (row.slug !== slug)
    throw new ConnectorError('RELINK_REQUIRED', 'connection slug/version mismatch')
  if (isDefaultConnectorArtifact(slug, row.artifact_hash)) return

  const installed = await runner.query(
    `SELECT 1 FROM marketplace_installs
      WHERE user_id = $1 AND slug = $2 AND uninstalled_at IS NULL`,
    [userId, slug],
  )
  if ((installed.rowCount ?? 0) === 0)
    throw new ConnectorError('CONNECTOR_NOT_INSTALLED', 'connector is no longer installed')
}
