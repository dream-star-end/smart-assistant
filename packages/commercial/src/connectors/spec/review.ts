/**
 * 连接器 Contract 内核 · 审核状态机 + 载入即验签 fail-closed(RFC §1.1/§6.1/§10.2)。
 *
 * 状态落在 marketplace_skill_versions 独立列(0132):security_review_state /
 * functional_verify_state / exec_revoked_at,不复用单一 status(避免各 handler 各自解释)。
 *
 * 合法迁移:
 *   draft
 *    →(securityApprove:**同事务**编译+签名+写 exec_contract/hash/sig) security_approved
 *        →(markFunctionalVerified) functional_verified
 *   exec_revoked_at 置位 = per-version kill(bind/execute 每次复核)。
 *
 * loadVerifiedContract = **载入即验**:状态 + 未 revoke + hash 自洽 + 验签 + policy≥当前,
 * 任一不满足 **抛 fail-closed 错误**,绝不返回可执行 contract。
 */

import { Value } from '@sinclair/typebox/value'
import type { Pool } from 'pg'
import { tx } from '../../db/queries.js'
import { canonicalSha256Hex } from './canonical.js'
import { COMPILER_VERSION, compileSpec } from './compiler.js'
import { signContract, verifyContract } from './signer.js'
import { ConnectorSpecError, ExecContract, type ExecContractT } from './types.js'

/**
 * 当前安全策略版本。升级 → 低于新版的旧 contract 载入时 POLICY_STALE(须重审,
 * 不自动继续信任,§1.1)。
 */
export const CURRENT_SECURITY_POLICY_VERSION = 1

export interface SecurityApproveInput {
  versionId: number
  reviewerUserId: number
  securityDecision: unknown
  /**
   * reviewer 实际看到并据以决策的 spec canonical hash。事务内 CAS 比对(封 TOCTOU,
   * P0-3):当前 raw_artifact 的编译 spec_hash 必须与之相等,否则拒。
   */
  expectedSpecHash: string
  pool: Pool
  env?: NodeJS.ProcessEnv
}

export interface ApprovedContract {
  execContract: ExecContractT
  specHash: string
  execContractHash: string
  policyVersion: number
  compilerVersion: number
}

/**
 * 安全审:**单事务**内
 *   ① join listing 读真实 kind,要求 == 'connector'(P0-2)
 *   ② version 存在且 draft
 *   ③ reviewer 是 admin+active(P0-3③)且 ≠ author
 *   ④ compile;spec_hash 与 version.artifact_hash 一致(封 raw 篡改)+ 与 expectedSpecHash
 *      一致(封 TOCTOU)+ spec.id == listing.slug
 *   ⑤ 用 **DB 读到的 kind** 签名(P0-2)
 *   ⑥ CAS 写 contract/hash/sig/state(WHERE 复核 draft + artifact_hash)
 * 任一失败整事务回滚。policyVersion **恒为** CURRENT_SECURITY_POLICY_VERSION(不接受 override,P0-1)。
 */
export async function securityApprove(input: SecurityApproveInput): Promise<ApprovedContract> {
  const policyVersion = CURRENT_SECURITY_POLICY_VERSION
  const env = input.env ?? process.env
  return tx(async (client) => {
    const r = await client.query<{
      slug: string
      submitted_by: string
      security_review_state: string
      raw_artifact: string
      artifact_hash: string
      kind: string
    }>(
      `SELECT v.slug, v.submitted_by, v.security_review_state, v.raw_artifact, v.artifact_hash,
              l.kind
         FROM marketplace_skill_versions v
         JOIN marketplace_skill_listings l ON l.slug = v.slug
        WHERE v.id = $1
          FOR UPDATE OF v`,
      [input.versionId],
    )
    const row = r.rows[0]
    if (!row) throw new ConnectorSpecError('VERSION_NOT_FOUND', `version ${input.versionId}`)
    // P0-2:kind 是 DB 事实,skill/agent version 调本函数必败。
    if (row.kind !== 'connector')
      throw new ConnectorSpecError('WRONG_ARTIFACT_KIND', `kind=${row.kind} is not connector`)
    if (row.security_review_state !== 'draft')
      throw new ConnectorSpecError('NOT_DRAFT', `state=${row.security_review_state}`)

    // P0-3③:reviewer 必须是 active admin(事务内,防越权签发)。
    const rev = await client.query<{ role: string; status: string }>(
      'SELECT role, status FROM users WHERE id = $1',
      [input.reviewerUserId],
    )
    const revRow = rev.rows[0]
    if (!revRow || revRow.role !== 'admin' || revRow.status !== 'active')
      throw new ConnectorSpecError('REVIEWER_NOT_ADMIN', 'reviewer must be an active admin')
    if (Number(row.submitted_by) === input.reviewerUserId)
      throw new ConnectorSpecError('REVIEWER_IS_AUTHOR', 'reviewer must differ from author')

    let rawSpec: unknown
    try {
      rawSpec = JSON.parse(row.raw_artifact)
    } catch {
      throw new ConnectorSpecError('SPEC_SCHEMA_INVALID', 'raw_artifact is not valid JSON')
    }

    // 同事务:编译 + 签名(§6.1 信任产物与状态迁移同事务)。
    const compiled = compileSpec(rawSpec, input.securityDecision)

    // P0-3①:artifact_hash 绑定 —— 编译 spec_hash 必须 == version.artifact_hash(封发布后改 raw)。
    if (compiled.specHash !== row.artifact_hash)
      throw new ConnectorSpecError(
        'ARTIFACT_HASH_MISMATCH',
        'compiled spec_hash != version.artifact_hash',
      )
    // P0-3②:TOCTOU —— 必须 == reviewer 看到的 expectedSpecHash。
    if (compiled.specHash !== input.expectedSpecHash)
      throw new ConnectorSpecError('SPEC_HASH_MISMATCH', 'spec changed since review (TOCTOU)')
    // spec.id 必须 == listing.slug(防挂靠他人 slug)。
    if ((rawSpec as { id?: unknown }).id !== row.slug)
      throw new ConnectorSpecError('SPEC_ID_MISMATCH', 'spec.id != listing slug')

    const sig = signContract(
      {
        listingSlug: row.slug,
        versionId: input.versionId,
        kind: row.kind, // P0-2:签 DB 读到的真实 kind
        specHash: compiled.specHash,
        execContractHash: compiled.execContractHash,
        compilerVersion: COMPILER_VERSION,
        policyVersion,
      },
      { env },
    )

    const upd = await client.query(
      `UPDATE marketplace_skill_versions
          SET exec_contract = $2,
              exec_contract_hash = $3,
              compiler_version = $4,
              security_policy_version = $5,
              signature = $6,
              key_id = $7,
              security_reviewed_by = $8,
              security_reviewed_at = now(),
              security_review_state = 'security_approved'
        WHERE id = $1 AND security_review_state = 'draft' AND artifact_hash = $9`,
      [
        input.versionId,
        JSON.stringify(compiled.execContract),
        Buffer.from(compiled.execContractHash, 'hex'),
        COMPILER_VERSION,
        policyVersion,
        Buffer.from(sig.signature, 'hex'),
        sig.keyId,
        input.reviewerUserId,
        row.artifact_hash,
      ],
    )
    // CAS:并发把它推离 draft / 改 artifact_hash → rowCount 0 → 回滚 fail-closed。
    if (upd.rowCount !== 1)
      throw new ConnectorSpecError('CAS_CONFLICT', 'version left draft concurrently')

    return {
      execContract: compiled.execContract,
      specHash: compiled.specHash,
      execContractHash: compiled.execContractHash,
      policyVersion,
      compilerVersion: COMPILER_VERSION,
    }
  }, input.pool)
}

/** security_approved → functional_verified(隔离测试 dry-run 通过,§1.1)。 */
export async function markFunctionalVerified(versionId: number, pool: Pool): Promise<void> {
  const r = await pool.query(
    `UPDATE marketplace_skill_versions
        SET functional_verify_state = 'verified'
      WHERE id = $1
        AND security_review_state = 'security_approved'
        AND functional_verify_state = 'unverified'
        AND exec_revoked_at IS NULL`,
    [versionId],
  )
  if (r.rowCount !== 1)
    throw new ConnectorSpecError('INVALID_STATE', 'cannot mark functional-verified')
}

/** per-version kill switch(§1.1):置 exec_revoked_at。幂等(已 revoke 视作成功)。 */
export async function revokeExecVersion(versionId: number, pool: Pool): Promise<void> {
  const r = await pool.query(
    `UPDATE marketplace_skill_versions
        SET exec_revoked_at = now()
      WHERE id = $1 AND exec_revoked_at IS NULL`,
    [versionId],
  )
  if (r.rowCount === 0) {
    const exists = await pool.query('SELECT 1 FROM marketplace_skill_versions WHERE id = $1', [
      versionId,
    ])
    if (exists.rowCount === 0)
      throw new ConnectorSpecError('VERSION_NOT_FOUND', `version ${versionId}`)
    // 已 revoke → 幂等成功
  }
}

export interface LoadContractOptions {
  /**
   * 复核策略下限。**只能抬高、不能降低**(P0-1):实际下限 =
   * max(CURRENT_SECURITY_POLICY_VERSION, minPolicyVersion ?? 0)。传 0 无法绕过 stale 闸;
   * 传 >CURRENT 可模拟"策略升级后旧 contract 须重审"。
   */
  minPolicyVersion?: number
  env?: NodeJS.ProcessEnv
}

/**
 * 载入即验:kind=='connector'(join listing,P0-2) + security_review_state='security_approved'
 * + 未 revoke + contract/sig 齐全 + hash 自洽 + 验签通过(kind 用 DB 事实)+
 * security_policy_version ≥ 策略下限 → 返回 ExecContract;任一不满足 → 抛 fail-closed 错误。
 */
export async function loadVerifiedContract(
  versionId: number,
  pool: Pool,
  opts: LoadContractOptions = {},
): Promise<ExecContractT> {
  // P0-1:下限只能抬高,传入值绝不能把它压到 CURRENT 以下。
  const policyFloor = Math.max(CURRENT_SECURITY_POLICY_VERSION, opts.minPolicyVersion ?? 0)
  const env = opts.env ?? process.env
  const r = await pool.query<{
    slug: string
    kind: string
    security_review_state: string
    exec_revoked_at: Date | null
    exec_contract: unknown
    exec_contract_hash: Buffer | null
    compiler_version: number | null
    security_policy_version: number | null
    signature: Buffer | null
    key_id: string | null
  }>(
    `SELECT v.slug, l.kind, v.security_review_state, v.exec_revoked_at, v.exec_contract,
            v.exec_contract_hash, v.compiler_version, v.security_policy_version, v.signature, v.key_id
       FROM marketplace_skill_versions v
       JOIN marketplace_skill_listings l ON l.slug = v.slug
      WHERE v.id = $1`,
    [versionId],
  )
  const row = r.rows[0]
  if (!row) throw new ConnectorSpecError('VERSION_NOT_FOUND', `version ${versionId}`)
  // P0-2:kind 是 DB 事实;非 connector(含被篡改成 skill/agent)→ fail-closed。
  if (row.kind !== 'connector')
    throw new ConnectorSpecError('WRONG_ARTIFACT_KIND', `kind=${row.kind} is not connector`)
  if (row.security_review_state !== 'security_approved')
    throw new ConnectorSpecError('NOT_SECURITY_APPROVED', `state=${row.security_review_state}`)
  if (row.exec_revoked_at !== null)
    throw new ConnectorSpecError('EXEC_REVOKED', 'exec version revoked')
  if (
    row.exec_contract == null ||
    row.exec_contract_hash == null ||
    row.signature == null ||
    row.key_id == null ||
    row.compiler_version == null ||
    row.security_policy_version == null
  )
    throw new ConnectorSpecError('CONTRACT_MISSING', 'signed contract columns incomplete')

  if (Number(row.security_policy_version) < policyFloor)
    throw new ConnectorSpecError(
      'POLICY_STALE',
      `policy ${row.security_policy_version} < floor ${policyFloor}`,
    )

  // contract 结构自校验。
  const execContract = row.exec_contract
  if (!Value.Check(ExecContract, execContract))
    throw new ConnectorSpecError('EXEC_CONTRACT_INVALID', 'stored exec_contract invalid')

  // hash 自洽:从载入的 contract 重算,与存列对比(JSONB 被篡改 → 不符)。
  const recomputedHash = canonicalSha256Hex(execContract)
  const storedHashHex = Buffer.from(row.exec_contract_hash).toString('hex')
  if (recomputedHash !== storedHashHex)
    throw new ConnectorSpecError('HASH_MISMATCH', 'exec_contract_hash mismatch')

  // 验签:覆盖字段(含 DB 读到的 kind)与存储一致(任一字节篡改 → false)。
  const ok = verifyContract(
    {
      listingSlug: row.slug,
      versionId,
      kind: row.kind,
      specHash: (execContract as ExecContractT).spec_hash,
      execContractHash: recomputedHash,
      compilerVersion: Number(row.compiler_version),
      policyVersion: Number(row.security_policy_version),
    },
    Buffer.from(row.signature).toString('hex'),
    row.key_id,
    env,
  )
  if (!ok)
    throw new ConnectorSpecError('SIGNATURE_INVALID', 'contract signature verification failed')

  return execContract as ExecContractT
}
