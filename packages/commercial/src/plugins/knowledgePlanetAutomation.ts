import type { Pool, PoolClient } from 'pg'

import { getPool } from '../db/index.js'
import { tx } from '../db/queries.js'
import { KNOWLEDGE_PLANET_PLUGIN_SLUG } from './knowledgePlanetContract.js'
import type { PluginRuntimeFacade } from './runtime.js'
import { managedPluginWritePolicy } from './writePolicy.js'

export const KNOWLEDGE_PLANET_AUTOMATION_DISCLAIMER_VERSION = 1
export const KNOWLEDGE_PLANET_AUTOMATION_DISCLAIMER =
  '无人值守自动回复会在你离线时，以当前登录的真实知识星球身份读取新主题，并调用 AI 自动生成、计费和发布评论。AI 可能误解上下文、产生事实错误、不当内容或重复回复；自动回复会对星球成员可见，并固定标注为 AI 自动生成。你应确保规则、回复范围和内容合法合规，拥有必要权限，并遵守知识星球及所在星球的规则。系统只允许文字评论或回复，不会自动发主题、上传媒体、点赞、编辑或删除；每个账号和规则均有限额、冷却时间和失败熔断。关闭开关会阻止尚未进入发送阶段的新回复，但已经进入发送阶段的回复仍可能完成。发送结果不明确时，系统会立即停用该账号的全部自动回复且绝不自动重试；请到知识星球核实后再决定是否恢复。启用即表示你理解并接受上述风险、模型费用和最终责任。'

const ID_RE = /^\d{1,16}$/
const GROUP_ID_RE = /^\d{6,32}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export class KnowledgePlanetAutomationError extends Error {
  readonly code:
    | 'BAD_REQUEST'
    | 'NOT_FOUND'
    | 'CONFLICT'
    | 'WRITE_DISABLED'
    | 'CONSENT_REQUIRED'
    | 'RUNTIME_UNAVAILABLE'

  constructor(code: KnowledgePlanetAutomationError['code'], message: string = code) {
    super(message)
    this.name = 'KnowledgePlanetAutomationError'
    this.code = code
  }
}

export interface KnowledgePlanetAutomationControlView {
  available: boolean
  enabled: boolean
  disclaimerVersion: number
  acceptedVersion: number | null
  acceptedAt: string | null
  disclaimerText: string
  accountDailyLimit: number
  pausedReason: string | null
}

export interface KnowledgePlanetAutomationRuleView {
  id: string
  groupId: string
  name: string
  instructions: string
  triggerKind: 'new_topic' | 'new_question'
  enabled: boolean
  dailyLimit: number
  cooldownMinutes: number
  maxReplyChars: number
  consecutiveFailures: number
  pausedReason: string | null
  lastCursorAt: string | null
  nextRunAt: string
  createdAt: string
  updatedAt: string
}

export interface KnowledgePlanetAutomationRunView {
  id: string
  ruleId: string
  sourceTopicId: string
  status:
    | 'reserved'
    | 'generating'
    | 'ready'
    | 'dispatching'
    | 'succeeded'
    | 'skipped'
    | 'failed'
    | 'unknown'
  reasonCode: string | null
  upstreamCommentId: string | null
  createdAt: string
  finishedAt: string | null
}

export interface KnowledgePlanetAutomationView {
  control: KnowledgePlanetAutomationControlView
  rules: KnowledgePlanetAutomationRuleView[]
  recentRuns: KnowledgePlanetAutomationRunView[]
}

interface AccountRow {
  id: string
  status: string
  revoked_at: Date | null
  provider: string
  plugin_write_enabled: boolean
  plugin_write_disclaimer_version: number | null
  plugin_write_disclaimer_accepted_at: Date | null
}

interface ControlRow {
  enabled: boolean
  disclaimer_version: number | null
  disclaimer_accepted_at: Date | null
  account_daily_limit: number
  paused_reason: string | null
}

interface RuleRow {
  id: string
  group_id: string
  name: string
  instructions: string
  trigger_kind: 'new_topic' | 'new_question'
  enabled: boolean
  cursor_created_at: Date | null
  next_run_at: Date
  daily_limit: number
  cooldown_minutes: number
  max_reply_chars: number
  consecutive_failures: number
  paused_reason: string | null
  created_at: Date
  updated_at: Date
}

function assertTargetId(value: string): void {
  if (!ID_RE.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0)
    throw new KnowledgePlanetAutomationError('BAD_REQUEST', 'Plugin account id is malformed')
}

function assertRuleId(value: string): void {
  if (!UUID_RE.test(value))
    throw new KnowledgePlanetAutomationError('BAD_REQUEST', 'Automation rule id is malformed')
}

function boundedString(value: unknown, min: number, max: number, label: string): string {
  if (typeof value !== 'string')
    throw new KnowledgePlanetAutomationError('BAD_REQUEST', `${label} must be text`)
  const normalized = value.trim()
  if (normalized.length < min || normalized.length > max || normalized.includes('\0'))
    throw new KnowledgePlanetAutomationError('BAD_REQUEST', `${label} is invalid`)
  return normalized
}

function boundedInteger(value: unknown, min: number, max: number, label: string): number {
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max)
    throw new KnowledgePlanetAutomationError('BAD_REQUEST', `${label} is invalid`)
  return Number(value)
}

function mapControl(
  row: ControlRow | undefined,
  available: boolean,
): KnowledgePlanetAutomationControlView {
  const acceptedVersion = row?.disclaimer_version ?? null
  const acceptedAt = row?.disclaimer_accepted_at?.toISOString() ?? null
  return {
    available,
    enabled:
      row?.enabled === true &&
      row.disclaimer_version === KNOWLEDGE_PLANET_AUTOMATION_DISCLAIMER_VERSION &&
      row.disclaimer_accepted_at instanceof Date &&
      row.paused_reason === null,
    disclaimerVersion: KNOWLEDGE_PLANET_AUTOMATION_DISCLAIMER_VERSION,
    acceptedVersion,
    acceptedAt,
    disclaimerText: KNOWLEDGE_PLANET_AUTOMATION_DISCLAIMER,
    accountDailyLimit: row?.account_daily_limit ?? 10,
    pausedReason: row?.paused_reason ?? null,
  }
}

function mapRule(row: RuleRow): KnowledgePlanetAutomationRuleView {
  return {
    id: row.id,
    groupId: row.group_id,
    name: row.name,
    instructions: row.instructions,
    triggerKind: row.trigger_kind,
    enabled: row.enabled,
    dailyLimit: row.daily_limit,
    cooldownMinutes: row.cooldown_minutes,
    maxReplyChars: row.max_reply_chars,
    consecutiveFailures: row.consecutive_failures,
    pausedReason: row.paused_reason,
    lastCursorAt: row.cursor_created_at?.toISOString() ?? null,
    nextRunAt: row.next_run_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

async function lockAccount(
  client: PoolClient,
  userId: number,
  targetId: string,
  requireAvailable = true,
): Promise<AccountRow> {
  const result = await client.query<AccountRow>(
    `SELECT id::text AS id, status, revoked_at, provider,
            plugin_write_enabled, plugin_write_disclaimer_version,
            plugin_write_disclaimer_accepted_at
       FROM connections
      WHERE id = $1::bigint AND user_id = $2
      FOR UPDATE`,
    [targetId, userId],
  )
  const row = result.rows[0]
  if (!row || row.provider !== KNOWLEDGE_PLANET_PLUGIN_SLUG)
    throw new KnowledgePlanetAutomationError('NOT_FOUND', 'Knowledge Planet account not found')
  if (requireAvailable && (row.status !== 'active' || row.revoked_at !== null))
    throw new KnowledgePlanetAutomationError(
      'RUNTIME_UNAVAILABLE',
      'Knowledge Planet account unavailable',
    )
  return row
}

function assertManualWriteEnabled(row: AccountRow): void {
  const policy = managedPluginWritePolicy(KNOWLEDGE_PLANET_PLUGIN_SLUG)!
  if (
    row.plugin_write_enabled !== true ||
    row.plugin_write_disclaimer_version !== policy.version ||
    !(row.plugin_write_disclaimer_accepted_at instanceof Date)
  )
    throw new KnowledgePlanetAutomationError(
      'WRITE_DISABLED',
      'Manual Knowledge Planet writes must be enabled first',
    )
}

export class KnowledgePlanetAutomationService {
  private readonly pool: Pool

  constructor(
    private readonly runtime: PluginRuntimeFacade,
    opts: { pool?: Pool } = {},
  ) {
    this.pool = opts.pool ?? getPool()
  }

  private async assertExecutableAccount(userId: number, targetId: string): Promise<void> {
    const management = await this.runtime.management(userId)
    const account = management.accounts.find((candidate) => candidate.id === targetId)
    if (!account || account.provider !== KNOWLEDGE_PLANET_PLUGIN_SLUG)
      throw new KnowledgePlanetAutomationError('NOT_FOUND', 'Knowledge Planet account not found')
    if (!account.executable)
      throw new KnowledgePlanetAutomationError(
        'RUNTIME_UNAVAILABLE',
        'Knowledge Planet Plugin is not executable',
      )
  }

  async get(userId: number, targetId: string): Promise<KnowledgePlanetAutomationView> {
    assertTargetId(targetId)
    const account = await this.pool.query<Pick<AccountRow, 'status' | 'revoked_at' | 'provider'>>(
      `SELECT status, revoked_at, provider FROM connections
        WHERE id = $1::bigint AND user_id = $2`,
      [targetId, userId],
    )
    const accountRow = account.rows[0]
    if (!accountRow || accountRow.provider !== KNOWLEDGE_PLANET_PLUGIN_SLUG)
      throw new KnowledgePlanetAutomationError('NOT_FOUND', 'Knowledge Planet account not found')
    const [control, rules, runs] = await Promise.all([
      this.pool.query<ControlRow>(
        `SELECT enabled, disclaimer_version, disclaimer_accepted_at,
                account_daily_limit, paused_reason
           FROM plugin_automation_controls
          WHERE connection_id = $1::bigint AND user_id = $2`,
        [targetId, userId],
      ),
      this.pool.query<RuleRow>(
        `SELECT id::text AS id, group_id, name, instructions, trigger_kind, enabled,
                cursor_created_at, next_run_at, daily_limit, cooldown_minutes,
                max_reply_chars, consecutive_failures, paused_reason, created_at, updated_at
           FROM plugin_automation_rules
          WHERE connection_id = $1::bigint AND user_id = $2 AND deleted_at IS NULL
          ORDER BY created_at ASC, id ASC`,
        [targetId, userId],
      ),
      this.pool.query<{
        id: string
        rule_id: string
        source_topic_id: string
        status: KnowledgePlanetAutomationRunView['status']
        reason_code: string | null
        upstream_comment_id: string | null
        created_at: Date
        finished_at: Date | null
      }>(
        `SELECT id::text AS id, rule_id::text AS rule_id, source_topic_id, status,
                reason_code, upstream_comment_id, created_at, finished_at
           FROM plugin_automation_runs
          WHERE connection_id = $1::bigint AND user_id = $2
          ORDER BY created_at DESC, id DESC
          LIMIT 20`,
        [targetId, userId],
      ),
    ])
    const available = accountRow.status === 'active' && accountRow.revoked_at === null
    return {
      control: mapControl(control.rows[0], available),
      rules: rules.rows.map(mapRule),
      recentRuns: runs.rows.map((row) => ({
        id: row.id,
        ruleId: row.rule_id,
        sourceTopicId: row.source_topic_id,
        status: row.status,
        reasonCode: row.reason_code,
        upstreamCommentId: row.upstream_comment_id,
        createdAt: row.created_at.toISOString(),
        finishedAt: row.finished_at?.toISOString() ?? null,
      })),
    }
  }

  async setControl(input: {
    userId: number
    targetId: string
    enabled: boolean
    accountDailyLimit?: number
    accepted?: true
    disclaimerVersion?: number
  }): Promise<KnowledgePlanetAutomationControlView> {
    assertTargetId(input.targetId)
    if (typeof input.enabled !== 'boolean')
      throw new KnowledgePlanetAutomationError('BAD_REQUEST', 'enabled is invalid')
    if (input.enabled) await this.assertExecutableAccount(input.userId, input.targetId)
    const limit =
      input.accountDailyLimit === undefined
        ? undefined
        : boundedInteger(input.accountDailyLimit, 1, 30, 'accountDailyLimit')
    if (
      input.enabled &&
      (input.accepted !== true ||
        input.disclaimerVersion !== KNOWLEDGE_PLANET_AUTOMATION_DISCLAIMER_VERSION)
    )
      throw new KnowledgePlanetAutomationError('CONSENT_REQUIRED', 'Automation consent is required')

    const outcome = await tx(async (client) => {
      const account = await lockAccount(client, input.userId, input.targetId, input.enabled)
      if (input.enabled) assertManualWriteEnabled(account)
      const result = await client.query<ControlRow>(
        `INSERT INTO plugin_automation_controls
           (connection_id, user_id, enabled, disclaimer_version,
            disclaimer_accepted_at, account_daily_limit, paused_reason)
         VALUES ($1::bigint, $2, $3,
                 CASE WHEN $3::boolean THEN $4::integer ELSE NULL END,
                 CASE WHEN $3 THEN now() ELSE NULL END,
                 COALESCE($5::smallint, 10::smallint), NULL)
         ON CONFLICT (connection_id) DO UPDATE
           SET enabled = EXCLUDED.enabled,
               disclaimer_version = CASE WHEN EXCLUDED.enabled THEN EXCLUDED.disclaimer_version
                                         ELSE plugin_automation_controls.disclaimer_version END,
               disclaimer_accepted_at = CASE WHEN EXCLUDED.enabled THEN now()
                                             ELSE plugin_automation_controls.disclaimer_accepted_at END,
               account_daily_limit = COALESCE($5::smallint, plugin_automation_controls.account_daily_limit),
               paused_reason = NULL,
               revision = plugin_automation_controls.revision + 1,
               updated_at = now()
         WHERE plugin_automation_controls.user_id = EXCLUDED.user_id
         RETURNING enabled, disclaimer_version, disclaimer_accepted_at,
                   account_daily_limit, paused_reason`,
        [
          input.targetId,
          input.userId,
          input.enabled,
          KNOWLEDGE_PLANET_AUTOMATION_DISCLAIMER_VERSION,
          limit ?? null,
        ],
      )
      if ((result.rowCount ?? 0) !== 1)
        throw new KnowledgePlanetAutomationError('CONFLICT', 'Automation control changed')
      if (!input.enabled) {
        await client.query(
          `UPDATE plugin_automation_rules
              SET enabled = FALSE, lease_token = NULL, lease_until = NULL,
                  revision = revision + 1, updated_at = now()
            WHERE connection_id = $1::bigint AND user_id = $2 AND deleted_at IS NULL`,
          [input.targetId, input.userId],
        )
        await client.query(
          `UPDATE plugin_automation_runs
              SET status = 'skipped', reason_code = 'AUTOMATION_DISABLED',
                  reply_enc = NULL, reply_nonce = NULL, reply_hash = NULL,
                  dispatch_claim_token = NULL, dispatch_claim_until = NULL,
                  finished_at = now()
            WHERE connection_id = $1::bigint AND user_id = $2
              AND status IN ('reserved','generating','ready')`,
          [input.targetId, input.userId],
        )
      }
      return {
        row: result.rows[0]!,
        available: account.status === 'active' && account.revoked_at === null,
      }
    }, this.pool)
    return mapControl(outcome.row, outcome.available)
  }

  async createRule(input: {
    userId: number
    targetId: string
    groupId: string
    name: string
    instructions: string
    triggerKind?: 'new_topic' | 'new_question'
    dailyLimit?: number
    cooldownMinutes?: number
    maxReplyChars?: number
  }): Promise<KnowledgePlanetAutomationRuleView> {
    assertTargetId(input.targetId)
    if (!GROUP_ID_RE.test(input.groupId))
      throw new KnowledgePlanetAutomationError('BAD_REQUEST', 'groupId is invalid')
    const name = boundedString(input.name, 1, 100, 'name')
    const instructions = boundedString(input.instructions, 1, 4_000, 'instructions')
    const triggerKind = input.triggerKind ?? 'new_topic'
    if (!['new_topic', 'new_question'].includes(triggerKind))
      throw new KnowledgePlanetAutomationError('BAD_REQUEST', 'triggerKind is invalid')
    const dailyLimit = boundedInteger(input.dailyLimit ?? 5, 1, 10, 'dailyLimit')
    const cooldownMinutes = boundedInteger(input.cooldownMinutes ?? 15, 5, 1_440, 'cooldownMinutes')
    const maxReplyChars = boundedInteger(input.maxReplyChars ?? 800, 100, 1_200, 'maxReplyChars')
    await this.assertExecutableAccount(input.userId, input.targetId)
    const group = (await this.runtime.call({
      userId: input.userId,
      targetId: input.targetId,
      actionId: 'get_group',
      params: { groupId: input.groupId },
    })) as { group?: { id?: unknown } }
    if (group.group?.id !== input.groupId)
      throw new KnowledgePlanetAutomationError('BAD_REQUEST', 'Knowledge Planet group unavailable')

    const row = await tx(async (client) => {
      await lockAccount(client, input.userId, input.targetId)
      const control = await client.query(
        `SELECT connection_id FROM plugin_automation_controls
          WHERE connection_id = $1::bigint AND user_id = $2 FOR UPDATE`,
        [input.targetId, input.userId],
      )
      if ((control.rowCount ?? 0) !== 1)
        throw new KnowledgePlanetAutomationError(
          'CONSENT_REQUIRED',
          'Configure automation consent before adding rules',
        )
      const count = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM plugin_automation_rules
          WHERE connection_id = $1::bigint AND user_id = $2 AND deleted_at IS NULL`,
        [input.targetId, input.userId],
      )
      if (Number(count.rows[0]?.count ?? 0) >= 10)
        throw new KnowledgePlanetAutomationError('CONFLICT', 'Automation rule limit reached')
      try {
        const created = await client.query<RuleRow>(
          `INSERT INTO plugin_automation_rules
             (connection_id, user_id, group_id, name, instructions, trigger_kind,
              enabled, daily_limit, cooldown_minutes, max_reply_chars)
           VALUES ($1::bigint, $2, $3, $4, $5, $6, FALSE, $7, $8, $9)
           RETURNING id::text AS id, group_id, name, instructions, trigger_kind, enabled,
                     cursor_created_at, next_run_at, daily_limit, cooldown_minutes,
                     max_reply_chars, consecutive_failures, paused_reason, created_at, updated_at`,
          [
            input.targetId,
            input.userId,
            input.groupId,
            name,
            instructions,
            triggerKind,
            dailyLimit,
            cooldownMinutes,
            maxReplyChars,
          ],
        )
        return created.rows[0]!
      } catch (error) {
        if ((error as { code?: unknown })?.code === '23505')
          throw new KnowledgePlanetAutomationError(
            'CONFLICT',
            'Only one automation rule is allowed per group',
          )
        throw error
      }
    }, this.pool)
    return mapRule(row)
  }

  async patchRule(input: {
    userId: number
    targetId: string
    ruleId: string
    patch: Partial<{
      name: string
      instructions: string
      triggerKind: 'new_topic' | 'new_question'
      enabled: boolean
      dailyLimit: number
      cooldownMinutes: number
      maxReplyChars: number
    }>
  }): Promise<KnowledgePlanetAutomationRuleView> {
    assertTargetId(input.targetId)
    assertRuleId(input.ruleId)
    const patchKeys = Object.keys(input.patch)
    if (patchKeys.length === 0)
      throw new KnowledgePlanetAutomationError('BAD_REQUEST', 'Rule patch is empty')
    const allowedPatchKeys = new Set([
      'name',
      'instructions',
      'triggerKind',
      'enabled',
      'dailyLimit',
      'cooldownMinutes',
      'maxReplyChars',
    ])
    if (patchKeys.some((key) => !allowedPatchKeys.has(key)))
      throw new KnowledgePlanetAutomationError('BAD_REQUEST', 'Rule patch contains unknown fields')
    if (input.patch.enabled !== undefined && typeof input.patch.enabled !== 'boolean')
      throw new KnowledgePlanetAutomationError('BAD_REQUEST', 'enabled is invalid')
    if (input.patch.enabled === true)
      await this.assertExecutableAccount(input.userId, input.targetId)

    const name =
      input.patch.name === undefined ? undefined : boundedString(input.patch.name, 1, 100, 'name')
    const instructions =
      input.patch.instructions === undefined
        ? undefined
        : boundedString(input.patch.instructions, 1, 4_000, 'instructions')
    const triggerKind = input.patch.triggerKind
    if (triggerKind !== undefined && !['new_topic', 'new_question'].includes(triggerKind))
      throw new KnowledgePlanetAutomationError('BAD_REQUEST', 'triggerKind is invalid')
    const dailyLimit =
      input.patch.dailyLimit === undefined
        ? undefined
        : boundedInteger(input.patch.dailyLimit, 1, 10, 'dailyLimit')
    const cooldownMinutes =
      input.patch.cooldownMinutes === undefined
        ? undefined
        : boundedInteger(input.patch.cooldownMinutes, 5, 1_440, 'cooldownMinutes')
    const maxReplyChars =
      input.patch.maxReplyChars === undefined
        ? undefined
        : boundedInteger(input.patch.maxReplyChars, 100, 1_200, 'maxReplyChars')

    let newest: { id: string; createdAt: Date } | null | undefined
    if (input.patch.enabled === true) {
      const result = (await this.runtime.call({
        userId: input.userId,
        targetId: input.targetId,
        actionId: 'list_topics',
        params: {
          groupId: await this.ruleGroupId(input.userId, input.targetId, input.ruleId),
          count: 1,
        },
      })) as { topics?: Array<{ id?: unknown; createdAt?: unknown }> }
      const topic = result.topics?.[0]
      const createdAt = typeof topic?.createdAt === 'string' ? new Date(topic.createdAt) : null
      newest =
        typeof topic?.id === 'string' && createdAt && Number.isFinite(createdAt.getTime())
          ? { id: topic.id, createdAt }
          : null
    }

    const row = await tx(async (client) => {
      const account = await lockAccount(
        client,
        input.userId,
        input.targetId,
        input.patch.enabled === true,
      )
      const control = await client.query<ControlRow>(
        `SELECT enabled, disclaimer_version, disclaimer_accepted_at,
                account_daily_limit, paused_reason
           FROM plugin_automation_controls
          WHERE connection_id = $1::bigint AND user_id = $2 FOR UPDATE`,
        [input.targetId, input.userId],
      )
      const current = await client.query<RuleRow & { cursor_topic_id: string | null }>(
        `SELECT id::text AS id, group_id, name, instructions, trigger_kind, enabled,
                cursor_topic_id, cursor_created_at, next_run_at, daily_limit,
                cooldown_minutes, max_reply_chars, consecutive_failures, paused_reason,
                created_at, updated_at
           FROM plugin_automation_rules
          WHERE id = $1::uuid AND connection_id = $2::bigint AND user_id = $3
            AND deleted_at IS NULL
          FOR UPDATE`,
        [input.ruleId, input.targetId, input.userId],
      )
      const existing = current.rows[0]
      if (!existing)
        throw new KnowledgePlanetAutomationError('NOT_FOUND', 'Automation rule not found')
      if (input.patch.enabled === true) {
        assertManualWriteEnabled(account)
        const controlView = mapControl(control.rows[0], true)
        if (!controlView.enabled)
          throw new KnowledgePlanetAutomationError(
            'CONSENT_REQUIRED',
            'Unattended automation must be enabled first',
          )
      }
      const reseed = input.patch.enabled === true && existing.enabled !== true
      const updated = await client.query<RuleRow>(
        `UPDATE plugin_automation_rules
            SET name = COALESCE($4, name),
                instructions = COALESCE($5, instructions),
                trigger_kind = COALESCE($6, trigger_kind),
                enabled = COALESCE($7, enabled),
                daily_limit = COALESCE($8, daily_limit),
                cooldown_minutes = COALESCE($9, cooldown_minutes),
                max_reply_chars = COALESCE($10, max_reply_chars),
                cursor_topic_id = CASE WHEN $11 THEN $12 ELSE cursor_topic_id END,
                cursor_created_at = CASE WHEN $11 THEN $13 ELSE cursor_created_at END,
                next_run_at = CASE WHEN $11 THEN now() ELSE next_run_at END,
                paused_reason = CASE WHEN $7 IS NOT NULL THEN NULL ELSE paused_reason END,
                consecutive_failures = CASE WHEN $7 IS NOT NULL THEN 0 ELSE consecutive_failures END,
                lease_token = CASE WHEN $7 = FALSE THEN NULL ELSE lease_token END,
                lease_until = CASE WHEN $7 = FALSE THEN NULL ELSE lease_until END,
                revision = revision + 1, updated_at = now()
          WHERE id = $1::uuid AND connection_id = $2::bigint AND user_id = $3
            AND deleted_at IS NULL
          RETURNING id::text AS id, group_id, name, instructions, trigger_kind, enabled,
                    cursor_created_at, next_run_at, daily_limit, cooldown_minutes,
                    max_reply_chars, consecutive_failures, paused_reason, created_at, updated_at`,
        [
          input.ruleId,
          input.targetId,
          input.userId,
          name ?? null,
          instructions ?? null,
          triggerKind ?? null,
          input.patch.enabled ?? null,
          dailyLimit ?? null,
          cooldownMinutes ?? null,
          maxReplyChars ?? null,
          reseed,
          newest?.id ?? null,
          newest?.createdAt ?? new Date(),
        ],
      )
      const invalidatesPending =
        input.patch.enabled === false ||
        input.patch.instructions !== undefined ||
        input.patch.triggerKind !== undefined ||
        input.patch.dailyLimit !== undefined ||
        input.patch.cooldownMinutes !== undefined ||
        input.patch.maxReplyChars !== undefined
      if (invalidatesPending) {
        const reason = input.patch.enabled === false ? 'RULE_DISABLED' : 'RULE_CHANGED'
        await client.query(
          `UPDATE plugin_automation_runs
              SET status = 'skipped', reason_code = $2,
                  reply_enc = NULL, reply_nonce = NULL, reply_hash = NULL,
                  dispatch_claim_token = NULL, dispatch_claim_until = NULL,
                  finished_at = now()
            WHERE rule_id = $1::uuid AND status IN ('reserved','generating','ready')`,
          [input.ruleId, reason],
        )
      }
      return updated.rows[0]!
    }, this.pool)
    return mapRule(row)
  }

  private async ruleGroupId(userId: number, targetId: string, ruleId: string): Promise<string> {
    const result = await this.pool.query<{ group_id: string }>(
      `SELECT group_id FROM plugin_automation_rules
        WHERE id = $1::uuid AND connection_id = $2::bigint AND user_id = $3
          AND deleted_at IS NULL`,
      [ruleId, targetId, userId],
    )
    const groupId = result.rows[0]?.group_id
    if (!groupId) throw new KnowledgePlanetAutomationError('NOT_FOUND', 'Automation rule not found')
    return groupId
  }

  async deleteRule(userId: number, targetId: string, ruleId: string): Promise<void> {
    assertTargetId(targetId)
    assertRuleId(ruleId)
    const result = await tx(async (client) => {
      await lockAccount(client, userId, targetId, false)
      await client.query(
        `SELECT connection_id FROM plugin_automation_controls
          WHERE connection_id = $1::bigint AND user_id = $2 FOR UPDATE`,
        [targetId, userId],
      )
      await client.query(
        `SELECT id FROM plugin_automation_rules
          WHERE id = $1::uuid AND connection_id = $2::bigint AND user_id = $3
            AND deleted_at IS NULL FOR UPDATE`,
        [ruleId, targetId, userId],
      )
      const deleted = await client.query(
        `UPDATE plugin_automation_rules
            SET enabled = FALSE, deleted_at = now(), lease_token = NULL, lease_until = NULL,
                revision = revision + 1, updated_at = now()
          WHERE id = $1::uuid AND connection_id = $2::bigint AND user_id = $3
            AND deleted_at IS NULL`,
        [ruleId, targetId, userId],
      )
      if ((deleted.rowCount ?? 0) === 1) {
        await client.query(
          `UPDATE plugin_automation_runs
              SET status = 'skipped', reason_code = 'RULE_DELETED',
                  reply_enc = NULL, reply_nonce = NULL, reply_hash = NULL,
                  dispatch_claim_token = NULL, dispatch_claim_until = NULL,
                  finished_at = now()
            WHERE rule_id = $1::uuid AND status IN ('reserved','generating','ready')`,
          [ruleId],
        )
      }
      return deleted
    }, this.pool)
    if ((result.rowCount ?? 0) !== 1)
      throw new KnowledgePlanetAutomationError('NOT_FOUND', 'Automation rule not found')
  }
}
