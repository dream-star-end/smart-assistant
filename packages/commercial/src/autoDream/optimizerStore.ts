import { createHash } from 'node:crypto'

import type { Pool, PoolClient } from 'pg'

import { writeAdminAudit } from '../admin/audit.js'

const TAXONOMY = new Set([
  'capability_gap',
  'usability_friction',
  'reliability',
  'performance',
  'privacy',
  'billing',
  'documentation',
  'skill_quality',
  'plugin_ecosystem',
])
const PREFERENCE_KEYS = new Set([
  'theme',
  'default_effort',
  'notify_email',
  'notify_telegram',
  'qq_proactive_push',
  'wechat_show_tool_calls',
  'wechat_proactive_push',
  'hotkeys',
])

export interface PlatformFindingInput {
  taxonomy: string
  capabilityId: string
  severity: 'low' | 'medium' | 'high'
  title: string
  problem: string
  impact: string
  recommendation: string
  signalCount: number
  evidenceHash: string
}

export async function reportAutoDreamPlatformFindings(
  pool: Pool,
  input: {
    subjectHash: string
    agentId: string
    runId: string
    model: string
    findings: unknown
  },
): Promise<{ accepted: number }> {
  if (
    !/^[0-9a-f-]{36}$/.test(input.runId) ||
    !/^[0-9a-f]{64}$/.test(input.subjectHash) ||
    input.model.length > 64
  ) {
    throw new Error('AUTO_DREAM_INVALID_FINDING_ENVELOPE')
  }
  if (!Array.isArray(input.findings) || input.findings.length > 128) {
    throw new Error('AUTO_DREAM_INVALID_FINDINGS')
  }
  const findings = input.findings.map(validateFinding)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    for (const finding of findings) {
      const fingerprint = hash(
        `${finding.taxonomy}\0${finding.capabilityId}\0${finding.title}\0${finding.problem}\0${finding.impact}\0${finding.recommendation}`,
      )
      if (finding.evidenceHash !== fingerprint) {
        throw new Error('AUTO_DREAM_INVALID_FINDING_HASH')
      }
      const upsert = await client.query<{ id: string }>(
        `INSERT INTO auto_dream_platform_findings
           (fingerprint,taxonomy,capability_id,severity,title,problem,impact,recommendation,
            occurrence_count,affected_user_count,last_model,last_run_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$11)
         ON CONFLICT (fingerprint) DO UPDATE
           SET severity = CASE
                 WHEN EXCLUDED.severity='high' THEN 'high'
                 WHEN EXCLUDED.severity='medium' AND auto_dream_platform_findings.severity='low'
                   THEN 'medium'
                 ELSE auto_dream_platform_findings.severity
               END,
               last_seen_at=NOW(),last_model=EXCLUDED.last_model,last_run_id=EXCLUDED.last_run_id,
               updated_at=NOW()
         RETURNING id::text`,
        [
          fingerprint,
          finding.taxonomy,
          finding.capabilityId,
          finding.severity,
          finding.title,
          finding.problem,
          finding.impact,
          finding.recommendation,
          finding.signalCount,
          input.model,
          input.runId,
        ],
      )
      const findingId = upsert.rows[0]!.id
      await client.query(
        `INSERT INTO auto_dream_platform_finding_occurrences
           (finding_id,subject_hash,run_id,agent_hash,signal_count,evidence_hash)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (finding_id,subject_hash,run_id) DO NOTHING`,
        [
          findingId,
          input.subjectHash,
          input.runId,
          hash(input.agentId),
          finding.signalCount,
          finding.evidenceHash,
        ],
      )
      await client.query(
        `UPDATE auto_dream_platform_findings f
            SET occurrence_count=(
                  SELECT COALESCE(SUM(o.signal_count), 0)
                    FROM auto_dream_platform_finding_occurrences o
                   WHERE o.finding_id=f.id
                ),
                affected_user_count=(
                  SELECT COUNT(DISTINCT o.subject_hash)
                    FROM auto_dream_platform_finding_occurrences o
                   WHERE o.finding_id=f.id
                ),
                updated_at=NOW()
          WHERE f.id=$1`,
        [findingId],
      )
    }
    await client.query('COMMIT')
    return { accepted: findings.length }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

export async function applyAutoDreamPreferenceAction(
  pool: Pool,
  input: {
    userId: number
    proposalId: string
    targetId: string
    beforeFingerprint: string
    after: string
  },
): Promise<{ ok: true; result: string } | { ok: false; conflict: string }> {
  if (
    !/^[0-9a-f]{32}$/.test(input.proposalId) ||
    !/^[0-9a-f]{64}$/.test(input.beforeFingerprint) ||
    !input.targetId.startsWith('preferences.')
  ) {
    throw new Error('AUTO_DREAM_INVALID_ACTION')
  }
  const key = input.targetId.slice('preferences.'.length)
  if (!PREFERENCE_KEYS.has(key)) throw new Error('AUTO_DREAM_INVALID_PREFERENCE_KEY')
  let desired: unknown
  try {
    desired = JSON.parse(input.after)
  } catch {
    throw new Error('AUTO_DREAM_INVALID_PREFERENCE_VALUE')
  }
  validatePreferenceValue(key, desired)
  const actionHash = hash(`${input.targetId}\0${input.beforeFingerprint}\0${input.after}`)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const prior = await client.query<{ action_hash: string; state: string; result: unknown }>(
      `SELECT action_hash,state,result
         FROM auto_dream_action_receipts
        WHERE user_id=$1 AND proposal_id=$2
        FOR UPDATE`,
      [input.userId, input.proposalId],
    )
    const receipt = prior.rows[0]
    if (receipt) {
      if (receipt.action_hash !== actionHash) throw new Error('AUTO_DREAM_ACTION_ID_REUSED')
      if (receipt.state === 'applied') {
        await client.query('COMMIT')
        return { ok: true, result: 'already applied' }
      }
    } else {
      await client.query(
        `INSERT INTO auto_dream_action_receipts(user_id,proposal_id,action_hash,state)
         VALUES ($1,$2,$3,'prepared')`,
        [input.userId, input.proposalId, actionHash],
      )
    }
    const row = await client.query<{ prefs: Record<string, unknown> }>(
      'SELECT prefs FROM user_preferences WHERE user_id=$1 FOR UPDATE',
      [input.userId],
    )
    const prefs = row.rows[0]?.prefs ?? {}
    const current = Object.prototype.hasOwnProperty.call(prefs, key) ? prefs[key] : null
    const currentFingerprint = hash(JSON.stringify(current))
    if (currentFingerprint !== input.beforeFingerprint) {
      await markConflict(client, input.userId, input.proposalId, 'setting changed since audit')
      await client.query('COMMIT')
      return { ok: false, conflict: '设置已在审计后发生变化，请重新审计后再应用。' }
    }
    const next = { ...prefs }
    if (desired === null) delete next[key]
    else next[key] = desired
    await client.query(
      `INSERT INTO user_preferences(user_id,prefs,updated_at)
       VALUES ($1,$2::jsonb,NOW())
       ON CONFLICT(user_id) DO UPDATE SET prefs=EXCLUDED.prefs,updated_at=NOW()`,
      [input.userId, JSON.stringify(next)],
    )
    await client.query(
      `UPDATE auto_dream_action_receipts
          SET state='applied',result=$3::jsonb,updated_at=NOW()
        WHERE user_id=$1 AND proposal_id=$2`,
      [input.userId, input.proposalId, JSON.stringify({ key })],
    )
    await client.query('COMMIT')
    return { ok: true, result: 'setting applied' }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

export async function listAutoDreamPlatformFindings(
  pool: Pool,
  input: { status?: string; limit: number; offset: number },
): Promise<{ rows: Record<string, unknown>[]; total: number }> {
  const status = input.status && input.status !== 'all' ? input.status : null
  const [rows, count] = await Promise.all([
    pool.query(
      `SELECT id::text,fingerprint,taxonomy,capability_id,severity,title,problem,impact,
              recommendation,status,occurrence_count::text,affected_user_count::text,
              first_seen_at,last_seen_at,last_model,last_run_id::text,updated_at
         FROM auto_dream_platform_findings
        WHERE ($1::text IS NULL OR status=$1)
        ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
                 last_seen_at DESC
        LIMIT $2 OFFSET $3`,
      [status, input.limit, input.offset],
    ),
    pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM auto_dream_platform_findings
        WHERE ($1::text IS NULL OR status=$1)`,
      [status],
    ),
  ])
  return { rows: rows.rows, total: Number(count.rows[0]?.count ?? 0) }
}

export async function updateAutoDreamPlatformFindingStatus(
  pool: Pool,
  input: {
    id: string
    status: string
    adminId: bigint | number | string
    ip?: string | null
    userAgent?: string | null
  },
): Promise<boolean> {
  if (
    !/^\d+$/.test(input.id) ||
    !['new', 'triaged', 'planned', 'resolved', 'dismissed'].includes(input.status)
  ) {
    throw new Error('AUTO_DREAM_INVALID_FINDING_STATUS')
  }
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const prior = await client.query<{ status: string }>(
      'SELECT status FROM auto_dream_platform_findings WHERE id=$1 FOR UPDATE',
      [input.id],
    )
    const before = prior.rows[0]?.status
    if (!before) {
      await client.query('ROLLBACK')
      return false
    }
    await client.query(
      'UPDATE auto_dream_platform_findings SET status=$2,updated_at=NOW() WHERE id=$1',
      [input.id, input.status],
    )
    await writeAdminAudit(client, {
      adminId: input.adminId,
      action: 'auto_dream_finding.status',
      target: `auto_dream_finding:${input.id}`,
      before: { status: before },
      after: { status: input.status },
      ip: input.ip,
      userAgent: input.userAgent,
    })
    await client.query('COMMIT')
    return true
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

async function markConflict(
  client: PoolClient,
  userId: number,
  proposalId: string,
  reason: string,
): Promise<void> {
  await client.query(
    `UPDATE auto_dream_action_receipts
        SET state='conflict',result=$3::jsonb,updated_at=NOW()
      WHERE user_id=$1 AND proposal_id=$2`,
    [userId, proposalId, JSON.stringify({ reason })],
  )
}

function validateFinding(raw: unknown): PlatformFindingInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('AUTO_DREAM_INVALID_FINDING')
  }
  const row = raw as Record<string, unknown>
  const text = (key: string, max: number): string => {
    const value = row[key]
    if (typeof value !== 'string' || value.length < 1 || value.length > max) {
      throw new Error('AUTO_DREAM_INVALID_FINDING')
    }
    if (containsSensitive(value)) throw new Error('AUTO_DREAM_INVALID_FINDING_SENSITIVE')
    return value
  }
  const taxonomy = text('taxonomy', 40)
  const capabilityId = text('capabilityId', 96)
  const severity = text('severity', 10)
  const evidenceHash = text('evidenceHash', 64)
  if (
    !TAXONOMY.has(taxonomy) ||
    !/^[a-z0-9][a-z0-9._-]{0,95}$/.test(capabilityId) ||
    !['low', 'medium', 'high'].includes(severity) ||
    !/^[0-9a-f]{64}$/.test(evidenceHash) ||
    typeof row.signalCount !== 'number' ||
    !Number.isInteger(row.signalCount) ||
    row.signalCount < 1 ||
    row.signalCount > 1_000_000
  ) {
    throw new Error('AUTO_DREAM_INVALID_FINDING')
  }
  return {
    taxonomy,
    capabilityId,
    severity: severity as PlatformFindingInput['severity'],
    title: text('title', 160),
    problem: text('problem', 500),
    impact: text('impact', 500),
    recommendation: text('recommendation', 500),
    signalCount: row.signalCount,
    evidenceHash,
  }
}

function containsSensitive(value: string): boolean {
  return (
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(value) ||
    /(?:\+?86[- ]?)?1[3-9]\d{9}/.test(value) ||
    /\b(?:sk|pk|rk|ghp|xox[baprs])[-_A-Za-z0-9]{12,}\b/.test(value) ||
    /\bBearer\s+[A-Za-z0-9._~+/-]+=*\b/i.test(value) ||
    /(?:完整会话|原始日志|工具参数|提示词全文|身份证|银行卡|access[_ -]?token|refresh[_ -]?token)/i.test(
      value,
    )
  )
}

function validatePreferenceValue(key: string, value: unknown): void {
  if (value === null) return
  if (key === 'theme' && !['light', 'dark', 'auto'].includes(String(value))) {
    throw new Error('AUTO_DREAM_INVALID_PREFERENCE_VALUE')
  }
  if (
    key === 'default_effort' &&
    !['low', 'medium', 'high', 'xhigh', 'max'].includes(String(value))
  ) {
    throw new Error('AUTO_DREAM_INVALID_PREFERENCE_VALUE')
  }
  if (
    [
      'notify_email',
      'notify_telegram',
      'qq_proactive_push',
      'wechat_show_tool_calls',
      'wechat_proactive_push',
    ].includes(key) &&
    typeof value !== 'boolean'
  ) {
    throw new Error('AUTO_DREAM_INVALID_PREFERENCE_VALUE')
  }
  if (
    key === 'hotkeys' &&
    (!value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).length > 32 ||
      Object.entries(value).some(
        ([hotkey, action]) =>
          hotkey.length < 1 ||
          hotkey.length > 64 ||
          typeof action !== 'string' ||
          action.length < 1 ||
          action.length > 64,
      ))
  ) {
    throw new Error('AUTO_DREAM_INVALID_PREFERENCE_VALUE')
  }
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
