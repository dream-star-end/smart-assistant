import { createHash, createHmac } from 'node:crypto'

import type { Pool, PoolClient } from 'pg'

import { writeAdminAudit } from '../admin/audit.js'
import type { SignalTrafficClass } from '../analytics/signalTraffic.js'

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
const DERIVED_CAPABILITY = /^auto_dream\.(platform|runtime|routing|integration)\.[0-9a-f]{32}$/
const SAFE_NIBBLE_ALPHABET = 'abcdefijmnqtuvwy'

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
    rawFindings?: unknown
    trafficClass?: SignalTrafficClass
    pseudonymKey: Uint8Array
  },
): Promise<{ accepted: number; rawAccepted: number }> {
  if (
    !/^[0-9a-f-]{36}$/.test(input.runId) ||
    !/^[0-9a-f]{64}$/.test(input.subjectHash) ||
    input.model.length > 64 ||
    input.pseudonymKey.length !== 32
  ) {
    throw new Error('AUTO_DREAM_INVALID_FINDING_ENVELOPE')
  }
  if (!Array.isArray(input.findings) || input.findings.length > 128) {
    throw new Error('AUTO_DREAM_INVALID_FINDINGS')
  }
  if (
    input.rawFindings !== undefined &&
    (!Array.isArray(input.rawFindings) || input.rawFindings.length > 128)
  ) {
    throw new Error('AUTO_DREAM_INVALID_RAW_FINDINGS')
  }
  const findings = input.findings.map((finding) => validateFinding(finding, input.pseudonymKey))
  const rawFindings = (input.rawFindings ?? []).map((finding) =>
    validateFinding(finding, input.pseudonymKey),
  )
  const trafficClass = input.trafficClass
  if (rawFindings.length > 0 && trafficClass === undefined) {
    throw new Error('AUTO_DREAM_RAW_FINDINGS_REQUIRE_TRAFFIC_CLASS')
  }
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    for (const finding of rawFindings) {
      await client.query(
        `INSERT INTO auto_dream_platform_raw_signals
           (subject_hash,run_id,agent_hash,evidence_hash,taxonomy,capability_id,severity,
            signal_count,model,traffic_class)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (subject_hash,run_id,agent_hash,evidence_hash) DO NOTHING`,
        [
          input.subjectHash,
          input.runId,
          hash(input.agentId),
          finding.evidenceHash,
          finding.taxonomy,
          finding.capabilityId,
          finding.severity,
          finding.signalCount,
          input.model,
          trafficClass!,
        ],
      )
    }
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
      if (trafficClass === undefined) {
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
      } else {
        await client.query(
          `INSERT INTO auto_dream_platform_finding_occurrences
             (finding_id,subject_hash,run_id,agent_hash,signal_count,evidence_hash,model,traffic_class)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (finding_id,subject_hash,run_id) DO NOTHING`,
          [
            findingId,
            input.subjectHash,
            input.runId,
            hash(input.agentId),
            finding.signalCount,
            finding.evidenceHash,
            input.model,
            trafficClass,
          ],
        )
      }
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
    return { accepted: findings.length, rawAccepted: rawFindings.length }
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
  input: {
    status?: string
    limit: number
    offset: number
    trafficClass: SignalTrafficClass | null
    model: 'current' | 'all' | string
    seenAfter?: Date | null
    minAffectedUsers?: number
    owner?: string | null
  },
): Promise<{ rows: Record<string, unknown>[]; total: number; model: string | null }> {
  const status = input.status && input.status !== 'all' ? input.status : null
  const currentModel =
    input.model === 'current'
      ? ((
          await pool.query<{ model: string }>(
            `SELECT value #>> '{}' AS model
               FROM system_settings
              WHERE key='auto_dream_model'`,
          )
        ).rows[0]?.model ?? null)
      : input.model === 'all'
        ? null
        : input.model
  const params = [
    status,
    input.trafficClass,
    currentModel,
    input.seenAfter?.toISOString() ?? null,
    input.minAffectedUsers ?? 0,
    input.owner ?? null,
    input.limit,
    input.offset,
  ]
  const evidenceCte = `
    WITH evidence AS (
      SELECT o.finding_id,
             SUM(o.signal_count)::text AS occurrence_count,
             COUNT(DISTINCT o.subject_hash)::text AS affected_user_count,
             COUNT(DISTINCT o.run_id)::text AS run_count,
             MAX(o.created_at) AS filtered_last_seen_at,
             MAX(o.model) AS filtered_last_model
        FROM auto_dream_platform_finding_occurrences o
       WHERE ($2::text IS NULL OR o.traffic_class=$2)
         AND ($3::text IS NULL OR o.model=$3)
         AND ($4::timestamptz IS NULL OR o.created_at >= $4)
       GROUP BY o.finding_id
    )
  `
  const [rows, count] = await Promise.all([
    pool.query(
      `${evidenceCte}
       SELECT f.id::text,f.fingerprint,f.taxonomy,f.capability_id,f.severity,f.title,f.problem,
              f.impact,f.recommendation,f.status,e.occurrence_count,e.affected_user_count,
              e.run_count,f.first_seen_at,e.filtered_last_seen_at AS last_seen_at,
              e.filtered_last_model AS last_model,f.last_run_id::text,f.updated_at,f.owner,
              CASE
                WHEN e.affected_user_count::bigint >= 2 AND e.run_count::bigint >= 2
                  THEN 'corroborated'
                ELSE 'single_source'
              END AS evidence_confidence
         FROM auto_dream_platform_findings f
         JOIN evidence e ON e.finding_id=f.id
        WHERE ($1::text IS NULL OR f.status=$1)
          AND e.affected_user_count::bigint >= $5::bigint
          AND ($6::text IS NULL OR f.owner=$6)
        ORDER BY e.affected_user_count::bigint DESC,
                 CASE f.severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
                 e.filtered_last_seen_at DESC
        LIMIT $7 OFFSET $8`,
      params,
    ),
    pool.query<{ count: string }>(
      `${evidenceCte}
       SELECT COUNT(*)::text AS count
         FROM auto_dream_platform_findings f
         JOIN evidence e ON e.finding_id=f.id
        WHERE ($1::text IS NULL OR f.status=$1)
          AND e.affected_user_count::bigint >= $5::bigint
          AND ($6::text IS NULL OR f.owner=$6)`,
      params.slice(0, 6),
    ),
  ])
  return {
    rows: rows.rows,
    total: Number(count.rows[0]?.count ?? 0),
    model: currentModel,
  }
}

export async function updateAutoDreamPlatformFindings(
  pool: Pool,
  input: {
    ids: string[]
    status?: string
    owner?: string | null
    adminId: bigint | number | string
    ip?: string | null
    userAgent?: string | null
  },
): Promise<number> {
  if (
    input.ids.length < 1 ||
    input.ids.length > 200 ||
    input.ids.some((id) => !/^\d+$/.test(id)) ||
    (input.status !== undefined &&
      !['new', 'triaged', 'planned', 'resolved', 'dismissed'].includes(input.status)) ||
    (input.owner !== undefined && input.owner !== null &&
      (input.owner.trim().length < 1 || input.owner.length > 128)) ||
    (input.status === undefined && input.owner === undefined)
  ) {
    throw new Error('AUTO_DREAM_INVALID_FINDING_UPDATE')
  }
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const prior = await client.query<{ id: string; status: string; owner: string | null }>(
      `SELECT id::text,status,owner FROM auto_dream_platform_findings
        WHERE id=ANY($1::bigint[]) ORDER BY id FOR UPDATE`,
      [input.ids],
    )
    if (prior.rows.length === 0) {
      await client.query('ROLLBACK')
      return 0
    }
    const statusProvided = input.status !== undefined
    const ownerProvided = input.owner !== undefined
    await client.query(
      `UPDATE auto_dream_platform_findings
          SET status=CASE WHEN $2::boolean THEN $3 ELSE status END,
              owner=CASE WHEN $4::boolean THEN $5 ELSE owner END,
              updated_at=NOW()
        WHERE id=ANY($1::bigint[])`,
      [input.ids, statusProvided, input.status ?? null, ownerProvided, input.owner ?? null],
    )
    await writeAdminAudit(client, {
      adminId: input.adminId,
      action: input.ids.length === 1
        ? statusProvided && ownerProvided
          ? 'auto_dream_finding.update'
          : statusProvided
            ? 'auto_dream_finding.status'
            : 'auto_dream_finding.owner'
        : 'auto_dream_finding.batch',
      target: input.ids.length === 1
        ? `auto_dream_finding:${input.ids[0]}`
        : `auto_dream_finding_batch:${input.ids.length}`,
      before: { rows: prior.rows },
      after: { ids: prior.rows.map((row) => row.id), status: input.status, owner: input.owner },
      ip: input.ip,
      userAgent: input.userAgent,
    })
    await client.query('COMMIT')
    return prior.rows.length
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
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

function validateFinding(raw: unknown, pseudonymKey: Uint8Array): PlatformFindingInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('AUTO_DREAM_INVALID_FINDING')
  }
  const row = raw as Record<string, unknown>
  const text = (key: string, max: number): string => {
    const value = row[key]
    if (typeof value !== 'string' || value.length < 1 || value.length > max) {
      throw new Error('AUTO_DREAM_INVALID_FINDING')
    }
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
  const original: PlatformFindingInput = {
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
  if (findingHash(original) !== evidenceHash) {
    throw new Error('AUTO_DREAM_INVALID_FINDING_HASH')
  }

  const alias = capabilityAlias(capabilityId, pseudonymKey)
  const finding =
    alias === capabilityId
      ? original
      : {
          ...original,
          capabilityId: alias,
          title: replaceCapability(original.title, capabilityId, alias),
          problem: replaceCapability(original.problem, capabilityId, alias),
          impact: replaceCapability(original.impact, capabilityId, alias),
          recommendation: replaceCapability(original.recommendation, capabilityId, alias),
          evidenceHash: '',
        }
  if (
    [
      finding.capabilityId,
      finding.title,
      finding.problem,
      finding.impact,
      finding.recommendation,
    ].some(containsSensitive)
  ) {
    throw new Error('AUTO_DREAM_INVALID_FINDING_SENSITIVE')
  }
  finding.evidenceHash = findingHash(finding)
  return finding
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

function capabilityAlias(capabilityId: string, key: Uint8Array): string {
  const derived = DERIVED_CAPABILITY.exec(capabilityId)
  if (!derived && !containsSensitive(capabilityId)) return capabilityId
  const digest = createHmac('sha256', key)
    .update('auto-dream-capability-v1\0')
    .update(capabilityId)
    .digest('hex')
  const safe = digest
    .slice(0, 32)
    .split('')
    .map((nibble) => SAFE_NIBBLE_ALPHABET[Number.parseInt(nibble, 16)])
    .join('')
  return derived ? `auto_dream.${derived[1]}.${safe}` : `auto_dream.finding.${safe}`
}

function replaceCapability(value: string, capabilityId: string, alias: string): string {
  return value.split(capabilityId).join(alias)
}

function findingHash(finding: Omit<PlatformFindingInput, 'signalCount' | 'evidenceHash'>): string {
  return hash(
    `${finding.taxonomy}\0${finding.capabilityId}\0${finding.title}\0${finding.problem}\0${finding.impact}\0${finding.recommendation}`,
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
