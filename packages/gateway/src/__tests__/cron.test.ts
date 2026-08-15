// Set OPENCLAUDE_HOME to an isolated temp dir BEFORE importing cron.ts —
// `paths.cronYaml` snapshots HOME at module load time, so this must run first.
import { mkdtempSync, rmSync, existsSync, unlinkSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ORIGINAL_OPENCLAUDE_HOME = process.env.OPENCLAUDE_HOME
const ORIGINAL_SEED_DEFAULT_CRON = process.env.OC_SEED_DEFAULT_CRON

const TEST_HOME = mkdtempSync(join(tmpdir(), 'oc-cron-test-'))
process.env.OPENCLAUDE_HOME = TEST_HOME

import { describe, it, before, after, beforeEach, afterEach } from 'node:test'
import * as assert from 'node:assert/strict'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

const {
  ensureCronFile,
  isUntouchedDefaultCronJob,
  isUserInitiatedCronJob,
  validateCronSchedule,
  resolveDueMinute,
  resolveCronOccurrence,
  getCatchupMinutes,
  getMaxJobs,
  getMaxPerHour,
  countMinuteHitsPerHour,
  frequencyQuotaError,
  deriveCronIndexPayload,
  catalogRejectOutcome,
  planCronRetry,
  deliveryFailureOutcome,
  cronDeliveryId,
  deliverCronViaAdapter,
  classifyCronOccurrenceRecovery,
  cronExecutionTapeIsReplaySafe,
  CRON_MAX_ATTEMPTS,
  CronScheduler,
} = await import('../cron.js')

const NOOP_CRON_DURABILITY = {
  consumeOccurrence: async () => {},
  stageDelivery: async () => {},
}
const { paths } = await import('@openclaude/storage')
const { setHostStaticProviderKeys } = await import('../hostStaticProviders.js')

describe('ensureCronFile — OC_SEED_DEFAULT_CRON gate', () => {
  before(() => {
    // sanity: paths.cronYaml must point under our temp HOME
    assert.ok(
      paths.cronYaml.startsWith(TEST_HOME),
      `paths.cronYaml=${paths.cronYaml} did not honor OPENCLAUDE_HOME=${TEST_HOME}`,
    )
  })

  beforeEach(() => {
    // Each case manages its own env value; reset to clean state up-front.
    delete process.env.OC_SEED_DEFAULT_CRON
    if (existsSync(paths.cronYaml)) unlinkSync(paths.cronYaml)
  })

  after(() => {
    if (ORIGINAL_SEED_DEFAULT_CRON === undefined) delete process.env.OC_SEED_DEFAULT_CRON
    else process.env.OC_SEED_DEFAULT_CRON = ORIGINAL_SEED_DEFAULT_CRON
    if (ORIGINAL_OPENCLAUDE_HOME === undefined) delete process.env.OPENCLAUDE_HOME
    else process.env.OPENCLAUDE_HOME = ORIGINAL_OPENCLAUDE_HOME
    rmSync(TEST_HOME, { recursive: true, force: true })
  })

  it('seeds DEFAULT_JOBS when env is unset (personal-version default)', async () => {
    const file = await ensureCronFile()
    assert.equal(file.jobs.length, 4, 'expected 4 default jobs (personal version)')
    const ids = file.jobs.map((j) => j.id).sort()
    assert.deepEqual(ids, ['daily-reflection', 'heartbeat', 'skill-check', 'weekly-curation'])
    // Verify on-disk too — the gate path actually writes.
    const onDisk = parseYaml(readFileSync(paths.cronYaml, 'utf-8')) as { jobs: unknown[] }
    assert.equal(onDisk.jobs.length, 4)
  })

  it('writes empty jobs when env=0 (commercial container)', async () => {
    process.env.OC_SEED_DEFAULT_CRON = '0'
    const file = await ensureCronFile()
    assert.equal(file.jobs.length, 0, 'expected zero jobs (commercial container)')
    const onDisk = parseYaml(readFileSync(paths.cronYaml, 'utf-8')) as { jobs: unknown[] }
    assert.equal(onDisk.jobs.length, 0)
  })

  it('seeds DEFAULT_JOBS when env is any other value (only "0" is the gate)', async () => {
    process.env.OC_SEED_DEFAULT_CRON = '1'
    const file = await ensureCronFile()
    assert.equal(file.jobs.length, 4)
  })

  it('does not overwrite an existing cron.yaml (gate only fires on bootstrap)', async () => {
    // First call seeds with env=0 → empty
    process.env.OC_SEED_DEFAULT_CRON = '0'
    await ensureCronFile()
    // Second call with env unset would seed defaults if file were missing,
    // but the file now exists → ensureCronFile must just read it back.
    delete process.env.OC_SEED_DEFAULT_CRON
    const file = await ensureCronFile()
    assert.equal(file.jobs.length, 0, 'existing cron.yaml must be preserved regardless of env')
  })

  it('commercial startup removes only exact untouched legacy seeds and preserves edits/user jobs', async () => {
    delete process.env.OC_SEED_DEFAULT_CRON
    const seeded = await ensureCronFile()
    const edited = { ...structuredClone(seeded.jobs[0]), schedule: '18 3 * * *' }
    const user = {
      id: 'remind-product-review', schedule: '0 9 * * 1', agent: 'main',
      prompt: 'Review the product metrics', enabled: true, deliver: 'webchat',
      createdAt: Date.now(),
    }
    writeFileSync(paths.cronYaml, stringifyYaml({ jobs: [...seeded.jobs, edited, user] }))

    process.env.OC_SEED_DEFAULT_CRON = '0'
    const file = await ensureCronFile()
    assert.deepEqual(file.jobs.map((j) => j.id), [edited.id, user.id])
    assert.equal(file.jobs[0].schedule, '18 3 * * *', 'a one-field user edit must never be scrubbed')
    const onDisk = parseYaml(readFileSync(paths.cronYaml, 'utf8')) as { jobs: Array<{ id: string }> }
    assert.deepEqual(onDisk.jobs.map((j) => j.id), [edited.id, user.id])
  })

  it('recognizes shipped 80697968/pre-806 seeds but preserves every field edit or addition', () => {
    const cliSeed = {
      id: 'daily-reflection', schedule: '17 3 * * *', agent: 'main', enabled: true, deliver: 'local' as const,
      prompt: `You are doing a DAILY REFLECTION pass. It is currently early morning.

1. Run \`oc-memory session-search "<query>"\` in the shell with query terms that cover yesterday's activity (e.g. the current date, common topics).
2. Review the last 5-10 turns you find.
3. Extract durable facts, user preferences, and patterns that should persist across sessions.
4. Run \`oc-memory memory --action add --target <memory|user> --content "..."\` to add new entries — "memory" (your observations) or "user" (what you know about the user). Be selective — only things that will actually help next time.
5. If you notice a pattern of tasks that could be reused, use \`skill_save\` to distill it into a reusable skill.
6. IMPORTANT: 重点检查今天是否有超过 3 次工具调用的复杂任务。如果有且没有对应 skill,立即用 skill_save 创建。
7. 如果 MEMORY.md 中有冗长条目,考虑用 \`oc-memory archival-add "..."\` 迁移到归档记忆,然后 \`oc-memory memory --action remove --target memory --needle "..."\` 从 Core 删除。
8. Write a SHORT summary of what you learned today (max 200 words).
9. If you learned nothing significant, reply with exactly "[SILENT]" and nothing else.`,
    }
    const mcpSeed = {
      id: 'daily-reflection', schedule: '17 3 * * *', agent: 'main', enabled: true, deliver: 'local' as const,
      prompt: `You are doing a DAILY REFLECTION pass. It is currently early morning.

1. Call \`session_search\` with query terms that cover yesterday's activity (e.g. the current date, common topics).
2. Review the last 5-10 turns you find.
3. Extract durable facts, user preferences, and patterns that should persist across sessions.
4. Use the \`memory\` tool to \`add\` new entries to either "memory" (your observations) or "user" (what you know about the user). Be selective — only things that will actually help next time.
5. If you notice a pattern of tasks that could be reused, use \`skill_save\` to distill it into a reusable skill.
6. IMPORTANT: 重点检查今天是否有超过 3 次工具调用的复杂任务。如果有且没有对应 skill,立即用 skill_save 创建。
7. 如果 MEMORY.md 中有冗长条目,考虑用 archival_add 迁移到归档记忆,然后从 Core 中 remove。
8. Write a SHORT summary of what you learned today (max 200 words).
9. If you learned nothing significant, reply with exactly "[SILENT]" and nothing else.`,
    }
    assert.equal(isUntouchedDefaultCronJob(cliSeed), true, '80697968 CLI seed must be scrubbed')
    assert.equal(isUntouchedDefaultCronJob(mcpSeed), true, 'pre-806 production seed must be scrubbed')

    const variants = [
      { ...cliSeed, id: 'daily-reflection-user' },
      { ...cliSeed, schedule: '18 3 * * *' },
      { ...cliSeed, agent: 'researcher' },
      { ...cliSeed, prompt: `${cliSeed.prompt}\nuser note` },
      { ...cliSeed, deliver: 'webchat' },
      { ...cliSeed, enabled: false },
      { ...cliSeed, heartbeat: true },
      { ...cliSeed, createdAt: 1 },
      { ...cliSeed, label: '我的复盘' },
      { ...cliSeed, oneshot: true },
      { ...cliSeed, deliverTarget: { channel: 'webchat', peerId: 'mine' } },
      { ...cliSeed, userExtension: 'preserve-me' },
    ]
    for (const variant of variants) {
      assert.equal(isUntouchedDefaultCronJob(variant as any), false)
    }
  })
})

describe('catalogRejectOutcome — retry contract', () => {
  it('only catalog unavailability is retryable; policy/model rejects consume the run', () => {
    assert.deepEqual(catalogRejectOutcome('MODEL_CATALOG_UNAVAILABLE'), {
      kind: 'retryable_failure', code: 'MODEL_CATALOG_UNAVAILABLE',
    })
    assert.deepEqual(catalogRejectOutcome('MODEL_NOT_AVAILABLE'), {
      kind: 'terminal_failure', code: 'MODEL_NOT_AVAILABLE',
    })
  })
})

describe('cron retry occurrence + delivery contract', () => {
  it('only a prepared occurrence is safe to execute again after restart', () => {
    assert.equal(classifyCronOccurrenceRecovery({ state: 'prepared' }), 'rerun')
    assert.equal(
      classifyCronOccurrenceRecovery({ state: 'executing', tapeEvents: 0 }),
      'unknown',
      'an empty tape cannot prove submit performed no side effects',
    )
    assert.equal(
      classifyCronOccurrenceRecovery({ state: 'completed', outputFile: 'done.md' }),
      'deliver_only',
    )
    const safeTape = [
      { kind: 'block', block: { kind: 'tool_use', blockId: 'read-1', toolName: 'Read' } },
      { kind: 'block', block: { kind: 'tool_result', toolUseBlockId: 'read-1', toolName: 'Read' } },
    ]
    assert.equal(cronExecutionTapeIsReplaySafe(safeTape), true)
    assert.equal(
      classifyCronOccurrenceRecovery({ state: 'executing', tapeEvents: 2 }, safeTape),
      'rerun',
    )
    assert.equal(cronExecutionTapeIsReplaySafe([]), false)
    assert.equal(cronExecutionTapeIsReplaySafe([
      { kind: 'block', block: { kind: 'tool_use', blockId: 'write-1', toolName: 'Write' } },
      { kind: 'block', block: { kind: 'tool_result', toolUseBlockId: 'write-1', toolName: 'Write' } },
    ]), false)
  })

  it('binds execution retries to the original due minute and treats consumed execution as stale', () => {
    const now = at(9, 30)
    const retry = {
      dueMinuteKey: mk(at(9, 0)), schedule: '*/5 * * * *', failures: 2,
      nextAttemptAt: now.getTime() - 1, code: 'DELIVERY_TRANSIENT', phase: 'execution' as const,
    }
    assert.equal(
      resolveCronOccurrence(
        { id: 'r', schedule: '*/5 * * * *' }, {}, retry,
        now.getTime(), now, 15,
      ),
      mk(at(9, 0)),
      'the 09:30 occurrence must not replace the still-pending 09:00 delivery',
    )
    assert.equal(
      resolveCronOccurrence(
        { id: 'r', schedule: '*/5 * * * *' }, { r: mk(at(9, 0)) }, retry,
        now.getTime(), now, 15,
      ),
      null,
      'a retry left after last-run persistence is stale and cannot replay',
    )
  })

  it('drains a delivery outbox even though model/tool execution was already consumed', () => {
    const now = at(9, 30)
    const dueMinuteKey = mk(at(9, 0))
    const outbox = {
      dueMinuteKey, schedule: '*/5 * * * *', failures: 0,
      nextAttemptAt: now.getTime() - 1, code: 'DELIVERY_PENDING',
      phase: 'delivery' as const, outputFile: 'reminder.md',
    }
    assert.equal(resolveCronOccurrence(
      { id: 'r', schedule: '*/5 * * * *' }, { r: dueMinuteKey }, outbox,
      now.getTime(), now, 15,
    ), dueMinuteKey)
  })

  it('uses bounded delays and turns the fourth failed attempt into explicit exhaustion', () => {
    const args = { dueMinuteKey: 100, schedule: '0 9 * * *', nowEpoch: 1_000, code: 'EXECUTION_ERROR' }
    const first = planCronRetry(undefined, args)
    assert.equal(first.kind, 'retry')
    if (first.kind !== 'retry') return
    assert.equal(first.entry.failures, 1)
    const second = planCronRetry(first.entry, { ...args, nowEpoch: 61_000 })
    assert.equal(second.kind, 'retry')
    if (second.kind !== 'retry') return
    const third = planCronRetry(second.entry, { ...args, nowEpoch: 181_000 })
    assert.equal(third.kind, 'retry')
    if (third.kind !== 'retry') return
    const exhausted = planCronRetry(third.entry, { ...args, nowEpoch: 481_000 })
    assert.deepEqual(exhausted, { kind: 'exhausted', attempts: CRON_MAX_ATTEMPTS })
    const newer = planCronRetry(third.entry, { ...args, dueMinuteKey: 101 })
    assert.equal(newer.kind, 'retry')
    if (newer.kind === 'retry') assert.equal(newer.entry.failures, 1, 'new occurrence never inherits old failures')
  })

  it('keeps delivery retryable without re-running the Agent after the execution limit', () => {
    const previous = {
      dueMinuteKey: 100, schedule: '0 9 * * *', failures: 20,
      nextAttemptAt: 0, code: 'DELIVERY_TRANSIENT', phase: 'delivery' as const,
      outputFile: 'result.md', deliveryId: cronDeliveryId('r', 100),
    }
    const planned = planCronRetry(previous, {
      dueMinuteKey: 100, schedule: previous.schedule, nowEpoch: 1_000,
      code: 'DELIVERY_TRANSIENT', phase: 'delivery', outputFile: previous.outputFile,
      deliveryId: previous.deliveryId,
    })
    assert.equal(planned.kind, 'retry')
    if (planned.kind === 'retry') assert.equal(planned.entry.failures, 21)
  })

  it('treats unknown delivery exceptions as transient; only explicit stable tags are permanent', () => {
    assert.deepEqual(deliveryFailureOutcome(new Error('socket detail must stay private')), {
      kind: 'retryable_failure', code: 'DELIVERY_TRANSIENT',
    })
    assert.deepEqual(deliveryFailureOutcome({ code: 'TARGET_REJECTED', retryable: false }), {
      kind: 'terminal_failure', code: 'TARGET_REJECTED',
    })
  })

  it('production adapter boundary awaits and propagates sink rejection', async () => {
    let completed = false
    await assert.rejects(
      () => deliverCronViaAdapter({
        send: async () => {
          await Promise.resolve()
          throw new Error('adapter rejected')
        },
      }, { text: 'archived output' }),
      /adapter rejected/,
    )
    assert.equal(completed, false)
  })
})

describe('isUserInitiatedCronJob — proactive wechat eligibility', () => {
  it('user reminders (remind-) and tool-created (ccb-) are user-initiated', () => {
    assert.equal(isUserInitiatedCronJob({ id: 'remind-mqfc31wr-swii' }), true)
    assert.equal(isUserInitiatedCronJob({ id: 'ccb-abc123-def4' }), true)
    assert.equal(isUserInitiatedCronJob({ id: 'some-future-user-entry' }), true)
  })
  it('system reflection/skill/heartbeat jobs are excluded', () => {
    assert.equal(isUserInitiatedCronJob({ id: 'heartbeat', heartbeat: true }), false)
    assert.equal(isUserInitiatedCronJob({ id: 'daily-reflection' }), false)
    assert.equal(isUserInitiatedCronJob({ id: 'weekly-curation' }), false)
    assert.equal(isUserInitiatedCronJob({ id: 'skill-check' }), false)
  })
})

describe('validateCronSchedule — 数值范围/形态校验(matcher 对齐)', () => {
  const cases: Array<[string, boolean]> = [
    // 合法:matcher 真正能命中的形态
    ['0 9 * * *', true],
    ['*/5 0-23/2 1,15 * 0', true],
    ['59 23 31 12 6', true],
    ['30 8 * * 1-5', true],
    // 非法:越界(纯字符正则拦不住的静默失效写法)
    ['60 9 * * *', false], // minute 60
    ['0 25 * * *', false], // hour 25
    ['0 9 32 * *', false], // dom 32
    ['0 9 * 13 *', false], // month 13
    ['0 9 * * 7', false], // dow 7(matcher getDay() 0-6,7 永不命中)
    ['0-60 * * * *', false], // range 端点越界
    ['10-5 * * * *', false], // 倒置区间
    // 非法:形态(matcher 恒 false 或误匹配)
    ['1, 9 * * *', false], // 空 part(Number('')===0 会误匹配 0)
    ['*/0 * * * *', false], // 步长 0 永不命中
    ['5/2 * * * *', false], // 数字底 step,matcher 不支持
    ['0 9 * *', false], // 4 字段
    ['a b c d e', false],
  ]
  for (const [expr, ok] of cases) {
    it(`${JSON.stringify(expr)} → ${ok ? 'valid' : 'invalid'}`, () => {
      const err = validateCronSchedule(expr)
      if (ok) assert.equal(err, null, `expected valid, got: ${err}`)
      else assert.notEqual(err, null, 'expected an error message')
    })
  }

  it('错误信息指明字段与非法值', () => {
    assert.match(validateCronSchedule('60 25 * * *') ?? '', /minute field "60" out of range 0-59/)
    assert.match(validateCronSchedule('0 9 * * 7') ?? '', /use 0 for Sunday/)
  })
})

// ── Bounded catch-up + quotas (cron-master-wake batch) ──────────────────────

/** 构造一个「本地挂钟视图」Date(server 本地 TZ);resolveDueMinute 只看它的日历字段。 */
function at(h: number, m: number): Date {
  return new Date(2026, 6, 7, h, m, 0, 0) // 2026-07-07(月份索引 6 = July)
}
/** 真实 epoch → minuteKey(与 resolveDueMinute 内部同口径)。 */
function mk(d: Date): number {
  return Math.floor(d.getTime() / 60_000)
}

describe('resolveDueMinute — 有界 catch-up', () => {
  it('当前分钟命中优先(不进 catch-up)', () => {
    // 每分钟任务:当前分钟即命中,返回当前 minuteKey 而非任何过去分钟。
    const now = at(9, 3)
    const r = resolveDueMinute({ id: 'j', schedule: '* * * * *' }, {}, now.getTime(), now, 15)
    assert.equal(r, mk(at(9, 3)))
  })

  it('错过的调度分钟在窗口内 → 补跑最近一次', () => {
    // 9:00 的 daily 任务,现在 9:03,窗口 15,未跑过 → 补 9:00。
    const now = at(9, 3)
    const r = resolveDueMinute({ id: 'j', schedule: '0 9 * * *' }, {}, now.getTime(), now, 15)
    assert.equal(r, mk(at(9, 0)))
  })

  it('已补跑过 → 不再补(跨重启幂等,只补一次)', () => {
    const now = at(9, 3)
    const r = resolveDueMinute(
      { id: 'j', schedule: '0 9 * * *' },
      { j: mk(at(9, 0)) }, // lastRun 已记 9:00
      now.getTime(),
      now,
      15,
    )
    assert.equal(r, null)
  })

  it('createdAt 晚于错过分钟 → 不补(虚假错过)', () => {
    const now = at(9, 3)
    // 任务 9:01 创建,晚于 9:00 触发点 → 不该补 9:00。
    const late = resolveDueMinute(
      { id: 'j', schedule: '0 9 * * *', createdAt: at(9, 1).getTime() },
      {},
      now.getTime(),
      now,
      15,
    )
    assert.equal(late, null)
    // 任务 8:58 创建,早于 9:00 → 正常补。
    const early = resolveDueMinute(
      { id: 'j', schedule: '0 9 * * *', createdAt: at(8, 58).getTime() },
      {},
      now.getTime(),
      now,
      15,
    )
    assert.equal(early, mk(at(9, 0)))
  })

  it('错过分钟在窗口之外 → 不补', () => {
    const now = at(9, 3)
    // 窗口只有 2 分钟,9:00 在 3 分钟前 → 扫不到。
    const r = resolveDueMinute({ id: 'j', schedule: '0 9 * * *' }, {}, now.getTime(), now, 2)
    assert.equal(r, null)
  })

  it('catchupMin=0 → 关闭 catch-up(仅当前分钟)', () => {
    const now = at(9, 3)
    const r = resolveDueMinute({ id: 'j', schedule: '0 9 * * *' }, {}, now.getTime(), now, 0)
    assert.equal(r, null)
  })

  it('多次错过只补最近一次(不回填更早的)', () => {
    // schedule 命中 9:00 与 9:02;现在 9:05。最近错过 = 9:02。
    const now = at(9, 5)
    const r = resolveDueMinute({ id: 'j', schedule: '0,2 9 * * *' }, {}, now.getTime(), now, 15)
    assert.equal(r, mk(at(9, 2)), '应补最近的 9:02 而非更早的 9:00')
    // 若 9:02 已补 → 不回退去补 9:00(collapse)。
    const r2 = resolveDueMinute(
      { id: 'j', schedule: '0,2 9 * * *' },
      { j: mk(at(9, 2)) },
      now.getTime(),
      now,
      15,
    )
    assert.equal(r2, null)
  })
})

describe('cron 频率/数量 env 解析器', () => {
  const KEYS = ['OC_CRON_CATCHUP_MIN', 'OC_CRON_MAX_JOBS', 'OC_CRON_MAX_PER_HOUR']
  const saved: Record<string, string | undefined> = {}
  before(() => {
    for (const k of KEYS) saved[k] = process.env[k]
  })
  after(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })
  it('默认值:catchup=15, maxJobs=50, maxPerHour=12', () => {
    for (const k of KEYS) delete process.env[k]
    assert.equal(getCatchupMinutes(), 15)
    assert.equal(getMaxJobs(), 50)
    assert.equal(getMaxPerHour(), 12)
  })
  it('catchup "0" 关闭;非法/负值回退默认', () => {
    assert.equal(getCatchupMinutes({ OC_CRON_CATCHUP_MIN: '0' } as any), 0)
    assert.equal(getCatchupMinutes({ OC_CRON_CATCHUP_MIN: '30' } as any), 30)
    assert.equal(getCatchupMinutes({ OC_CRON_CATCHUP_MIN: 'abc' } as any), 15)
    assert.equal(getCatchupMinutes({ OC_CRON_CATCHUP_MIN: '-5' } as any), 15)
  })
})

describe('countMinuteHitsPerHour + frequencyQuotaError', () => {
  it('每分钟任务 = 60 命中/小时 → 拒', () => {
    assert.equal(countMinuteHitsPerHour('* * * * *'), 60)
    assert.match(frequencyQuotaError('* * * * *') ?? '', /Invalid cron schedule/)
    assert.match(frequencyQuotaError('* * * * *') ?? '', /per hour/)
  })
  it('每 5 分钟 = 12 命中,恰在默认上限内 → 过', () => {
    assert.equal(countMinuteHitsPerHour('*/5 * * * *'), 12)
    assert.equal(frequencyQuotaError('*/5 * * * *'), null)
  })
  it('每 2 分钟 = 30 命中 → 拒', () => {
    assert.equal(countMinuteHitsPerHour('*/2 * * * *'), 30)
    assert.notEqual(frequencyQuotaError('*/2 * * * *'), null)
  })
  it('每天/每小时低频 → 过', () => {
    assert.equal(countMinuteHitsPerHour('0 9 * * *'), 1)
    assert.equal(countMinuteHitsPerHour('0,30 * * * *'), 2)
    assert.equal(frequencyQuotaError('0 9 * * *'), null)
  })
})

describe('CronScheduler.addJob — 配额闸', () => {
  const ORIGINAL_MAX_JOBS = process.env.OC_CRON_MAX_JOBS
  const ORIGINAL_MAX_PER_HOUR = process.env.OC_CRON_MAX_PER_HOUR

  beforeEach(() => {
    // 空 cron.yaml 起步(商业容器口径:不 seed 默认自省 job)。
    delete process.env.OC_CRON_MAX_JOBS
    delete process.env.OC_CRON_MAX_PER_HOUR
    process.env.OC_SEED_DEFAULT_CRON = '0'
    if (existsSync(paths.cronYaml)) unlinkSync(paths.cronYaml)
  })
  after(() => {
    if (ORIGINAL_MAX_JOBS === undefined) delete process.env.OC_CRON_MAX_JOBS
    else process.env.OC_CRON_MAX_JOBS = ORIGINAL_MAX_JOBS
    if (ORIGINAL_MAX_PER_HOUR === undefined) delete process.env.OC_CRON_MAX_PER_HOUR
    else process.env.OC_CRON_MAX_PER_HOUR = ORIGINAL_MAX_PER_HOUR
    delete process.env.OC_SEED_DEFAULT_CRON
    if (existsSync(paths.cronYaml)) unlinkSync(paths.cronYaml)
  })

  // addJob 只用 cron.yaml + 配额,不触碰 sessions/config;maybePushCronIndex 因未 start()
  // 且无 master env → no-op。故可用空替身构造。
  function makeScheduler(): InstanceType<typeof CronScheduler> {
    return new CronScheduler({} as any, {} as any, () => {})
  }

  it('第 51 个 job 被拒(默认 OC_CRON_MAX_JOBS=50)', async () => {
    const sched = makeScheduler()
    for (let i = 0; i < 50; i++) {
      await sched.addJob({ id: `r-${i}`, schedule: '0 9 * * *', agent: 'main', prompt: 'p', enabled: true })
    }
    await assert.rejects(
      () => sched.addJob({ id: 'r-50', schedule: '0 9 * * *', agent: 'main', prompt: 'p', enabled: true }),
      /limit reached/,
    )
    // 替换同 id 不算新增(size-neutral),仍应允许。
    await sched.addJob({ id: 'r-0', schedule: '0 10 * * *', agent: 'main', prompt: 'p2', enabled: true })
    const jobs = await sched.listJobs()
    assert.equal(jobs.length, 50)
  })

  it('每分钟 schedule 被拒', async () => {
    const sched = makeScheduler()
    await assert.rejects(
      () => sched.addJob({ id: 'x', schedule: '* * * * *', agent: 'main', prompt: 'p' }),
      /per hour/,
    )
    assert.equal((await sched.listJobs()).length, 0, '被拒的 job 不应落库')
  })

  it('*/5 schedule 通过', async () => {
    const sched = makeScheduler()
    await sched.addJob({ id: 'y', schedule: '*/5 * * * *', agent: 'main', prompt: 'p' })
    assert.ok((await sched.listJobs()).some((j) => j.id === 'y'))
  })
})

describe('deriveCronIndexPayload — 唤醒索引只计用户任务', () => {
  it('系统 seed(daily-reflection/heartbeat/skill-check/weekly-curation)不参与唤醒', () => {
    const seeds = [
      { id: 'daily-reflection', schedule: '17 3 * * *', prompt: 'x', enabled: true },
      { id: 'heartbeat', schedule: '13 */4 * * *', prompt: 'x', enabled: true, heartbeat: true },
      { id: 'skill-check', schedule: '47 */6 * * *', prompt: 'x', enabled: true },
      { id: 'weekly-curation', schedule: '31 4 * * 0', prompt: 'x', enabled: true },
    ] as any[]
    const now = new Date('2026-07-07T10:30:20.000Z')
    assert.deepEqual(deriveCronIndexPayload({ jobs: seeds } as any, now), {
      nextFireAt: null,
      enabledCount: 0,
    })
    const withUser = [...seeds, { id: 'remind-a-b', schedule: '* * * * *', prompt: 'x', enabled: true }]
    const r = deriveCronIndexPayload({ jobs: withUser } as any, now)
    assert.equal(r.enabledCount, 1)
    assert.equal(r.nextFireAt, '2026-07-07T10:31:00.000Z')
  })
})

describe('CronScheduler.runJob — 合成首帧非 codex 路由字段补齐', () => {
  // codex 计费旁路封堵的对偶面:cron 进程内直接派发、绕过 master bridge 计费编排,
  // host 平台 agent(main)又无 per-user 计费主体 → 落 codex 会被 CODEX_BILLING_GUARD
  // 100% fail-closed 拒。runJob 必须把"解析为 codex 的 cron"改路由到显式非 codex 模型,
  // 并把 model 路由字段同点传入 getOrCreate(决定 runner engine)+ submit(路由字段)。
  //
  // MAJOR-1 routable 自检:降级前 resolveSyntheticTurnModel 会自检兜底模型可路由性。测试进程
  // 非容器,需注入 host 静态 provider seam(等价 commercial 已装配 OpenCode Go key;合成兜底
  // 现为 deepseek-v4-flash),否则 gate 判"不可路由"→ 不降级。
  beforeEach(() => setHostStaticProviderKeys({ opencodego: 'og-key' }))
  afterEach(() => setHostStaticProviderKeys(null))
  type SubmitCall = { model: unknown }
  function makeSchedulerWithSpies(defaultModel: string): {
    sched: InstanceType<typeof CronScheduler>
    getOrCreateOpts: any[]
    submitCalls: SubmitCall[]
  } {
    const getOrCreateOpts: any[] = []
    const submitCalls: SubmitCall[] = []
    const sessions = {
      getOrCreate: async (opts: any) => {
        getOrCreateOpts.push(opts)
        return { sessionKey: opts.sessionKey } as any
      },
      // submit 签名:(session, textOrBlocks, onEvent, effortLevel?, model?, ...)
      submit: async (_s: any, _t: any, _cb: any, _effort?: any, model?: any) => {
        submitCalls.push({ model })
        // 不 emit 任何 block → output 为空 → runJob 跳过投递(不触 onDeliver)。
      },
      destroySession: async () => {},
    }
    const config = { defaults: { model: defaultModel } } as any
    const sched = new CronScheduler(config, sessions as any, () => {})
    return { sched, getOrCreateOpts, submitCalls }
  }

  const job = { id: 'heartbeat', schedule: '13 */4 * * *', prompt: 'ping', enabled: true, heartbeat: true } as any

  it('codex 默认(agent 无 model + defaults=gpt-5.6-sol)→ getOrCreate+submit 均带非 codex 兜底模型', async () => {
    const { sched, getOrCreateOpts, submitCalls } = makeSchedulerWithSpies('gpt-5.6-sol')
    const outcome = await (sched as any).runJob(job, { id: 'main' }, NOOP_CRON_DURABILITY)
    assert.deepEqual(outcome, { kind: 'terminal_failure', code: 'EMPTY_OUTPUT' })
    assert.equal(getOrCreateOpts.length, 1)
    assert.equal(getOrCreateOpts[0].model, 'deepseek-v4-flash', 'getOrCreate 必须收到非 codex 模型(runner engine 决定点)')
    assert.equal(submitCalls.length, 1)
    assert.equal(submitCalls[0].model, 'deepseek-v4-flash', 'submit 必须带同源 model 路由字段')
  })

  it('agent 显式 gpt-5.6-sol(codex)→ 同样替换为非 codex 兜底', async () => {
    const { sched, getOrCreateOpts, submitCalls } = makeSchedulerWithSpies('glm-5.2')
    await (sched as any).runJob(job, { id: 'main', model: 'gpt-5.6-sol' }, NOOP_CRON_DURABILITY)
    assert.equal(getOrCreateOpts[0].model, 'deepseek-v4-flash')
    assert.equal(submitCalls[0].model, 'deepseek-v4-flash')
  })

  it('非 codex agent(glm-5.2)→ 不覆盖(getOrCreate 不带 model,submit model=undefined)', async () => {
    const { sched, getOrCreateOpts, submitCalls } = makeSchedulerWithSpies('gpt-5.6-sol')
    await (sched as any).runJob(job, { id: 'x', model: 'glm-5.2' }, NOOP_CRON_DURABILITY)
    // 尊重原配置:getOrCreate 不注入 model 键(沿用 agent 默认),submit model 为 undefined。
    assert.equal('model' in getOrCreateOpts[0], false, '非 codex 不应注入 model override')
    assert.equal(submitCalls[0].model, undefined)
  })
})

describe('CronScheduler.runJob — 引擎 API 错误熔断(402 站内信轰炸根治)', () => {
  // 线上事故:402 余额不足 × 高频 schedule → 同一段 "API Error: 402…" 被当正常产出
  // 反复送达,离线兜底 35 小时写了 424 条同文站内信。断言三件事:
  //   1. API 错误产出一律不送达(它是失败,不是结果);
  //   2. insufficient_credits 连续 3 次 → job.enabled=false 持久化 + 恰好一条暂停通知;
  //   3. 瞬时错误(429 等)只抑制送达,永不替用户关任务;正常产出清零计数。
  function makeSchedulerWithOutput(): {
    sched: InstanceType<typeof CronScheduler>
    setOutput: (text: string) => void
    delivered: string[]
  } {
    let output = ''
    const delivered: string[] = []
    const sessions = {
      getOrCreate: async (opts: any) => ({ sessionKey: opts.sessionKey }) as any,
      submit: async (_s: any, _t: any, cb: any) => {
        if (output) cb({ kind: 'block', block: { kind: 'text', text: output } })
      },
      destroySession: async () => {},
    }
    const config = { defaults: { model: 'glm-5.2' } } as any
    const sched = new CronScheduler(config, sessions as any, (text: string) => {
      delivered.push(text)
    })
    return { sched, setOutput: (t) => (output = t), delivered }
  }

  const ERR_402 = 'API Error: 402 {"error":{"code":"INSUFFICIENT_CREDITS","message":"insufficient credits: balance=0 required=69"}}'
  const ERR_429 = 'API Error: 429 {"error":{"code":"RATE_LIMITED"}}'
  // 非 codex agent,避开合成模型降级的 provider seam 依赖。
  const AGENT = { id: 'x', model: 'glm-5.2' } as any

  function seedJob(job: any): void {
    // YAML 是 JSON 超集,直接写 JSON 形态即可被 parseYaml 读回。
    writeFileSync(paths.cronYaml, JSON.stringify({ jobs: [job] }))
  }

  beforeEach(() => {
    process.env.OC_SEED_DEFAULT_CRON = '0'
    if (existsSync(paths.cronYaml)) unlinkSync(paths.cronYaml)
  })

  afterEach(() => {
    delete process.env.OC_SEED_DEFAULT_CRON
  })

  it('API 错误产出不送达;连续 3 次 402 → 持久化停用 + 恰好一条暂停通知', async () => {
    const job = { id: 'wd-1', schedule: '*/5 * * * *', agent: 'x', prompt: 'watch', deliver: 'webchat', label: 'Run the watchdog', enabled: true } as any
    seedJob(job)
    const { sched, setOutput, delivered } = makeSchedulerWithOutput()
    setOutput(ERR_402)

    await (sched as any).runJob(job, AGENT, NOOP_CRON_DURABILITY)
    await (sched as any).runJob(job, AGENT, NOOP_CRON_DURABILITY)
    assert.equal(delivered.length, 0, '裸 API 错误绝不能作为任务产出送达')
    assert.equal(job.enabled, true, '未到阈值不停用')

    await (sched as any).runJob(job, AGENT, NOOP_CRON_DURABILITY)
    assert.equal(job.enabled, false, '第 3 次连续 402 必须停用任务')
    assert.equal(delivered.length, 1, '暂停通知恰好一条')
    assert.ok(delivered[0].includes('已自动暂停'), `通知需说明暂停:${delivered[0]}`)
    assert.ok(delivered[0].includes('Run the watchdog'), '通知需带任务名')

    const onDisk = parseYaml(readFileSync(paths.cronYaml, 'utf8')) as any
    assert.equal(onDisk.jobs[0].enabled, false, '停用必须持久化到 cron.yaml')
  })

  it('正常产出清零连击:2 次 402 → 成功 → 2 次 402,不停用', async () => {
    const job = { id: 'wd-2', schedule: '*/5 * * * *', agent: 'x', prompt: 'watch', deliver: 'webchat', enabled: true } as any
    seedJob(job)
    const { sched, setOutput, delivered } = makeSchedulerWithOutput()

    setOutput(ERR_402)
    await (sched as any).runJob(job, AGENT, NOOP_CRON_DURABILITY)
    await (sched as any).runJob(job, AGENT, NOOP_CRON_DURABILITY)
    setOutput('今日一切正常。')
    await (sched as any).runJob(job, AGENT, NOOP_CRON_DURABILITY)
    assert.deepEqual(delivered, ['今日一切正常。'], '正常产出照常送达')
    setOutput(ERR_402)
    await (sched as any).runJob(job, AGENT, NOOP_CRON_DURABILITY)
    await (sched as any).runJob(job, AGENT, NOOP_CRON_DURABILITY)
    assert.equal(job.enabled, true, '成功已清零连击,两次新失败不该停用')
  })

  it('瞬时错误(429)只抑制送达,永不停用', async () => {
    const job = { id: 'wd-3', schedule: '*/5 * * * *', agent: 'x', prompt: 'watch', deliver: 'webchat', enabled: true } as any
    seedJob(job)
    const { sched, setOutput, delivered } = makeSchedulerWithOutput()
    setOutput(ERR_429)
    for (let i = 0; i < 5; i++) {
      assert.deepEqual(await (sched as any).runJob(job, AGENT, NOOP_CRON_DURABILITY), {
        kind: 'terminal_failure', code: 'RATE_LIMITED',
      })
    }
    assert.equal(delivered.length, 0, '瞬时错误不送达')
    assert.equal(job.enabled, true, '瞬时错误永不替用户关任务')
  })
})

describe('CronScheduler execution retry boundary', () => {
  const job = {
    id: 'remind-side-effect-boundary', schedule: '0 9 * * *', agent: 'x',
    prompt: 'perform a side effect', deliver: 'webchat', enabled: true,
  } as any
  const agent = { id: 'x', model: 'glm-5.2' } as any

  it('retries a session-creation failure because submit never started', async () => {
    let submits = 0
    const sched = new CronScheduler(
      { defaults: { model: 'glm-5.2' } } as any,
      {
        getOrCreate: async () => { throw new Error('spawn unavailable') },
        submit: async () => { submits++ },
        destroySession: async () => {},
      } as any,
      async () => {},
    )
    assert.deepEqual(await (sched as any).runJob(job, agent, NOOP_CRON_DURABILITY), {
      kind: 'retryable_failure', code: 'SESSION_CREATE_FAILED',
    })
    assert.equal(submits, 0)
  })

  it('fails closed without replay when the submit-started record precedes a last-run write failure', async () => {
    process.env.OC_SEED_DEFAULT_CRON = '0'
    const retryPath = join(TEST_HOME, 'cron', 'retry-state.json')
    const lastRunPath = join(TEST_HOME, 'cron', 'last-run.json')
    for (const path of [paths.cronYaml, paths.agentsYaml, retryPath, lastRunPath]) {
      if (existsSync(path)) unlinkSync(path)
    }
    const job = {
      id: 'oneshot-last-run-retry', schedule: '* * * * *', agent: 'x',
      prompt: 'do once', deliver: 'local', enabled: true, oneshot: true,
    }
    writeFileSync(paths.cronYaml, stringifyYaml({ jobs: [job] }))
    writeFileSync(paths.agentsYaml, stringifyYaml({
      agents: [{ id: 'x', model: 'glm-5.2' }], routes: [], default: 'x',
    }))
    let submits = 0
    const sched = new CronScheduler(
      { defaults: { model: 'glm-5.2' } } as any,
      {
        getOrCreate: async (opts: any) => ({ sessionKey: opts.sessionKey }),
        submit: async (_session: any, _prompt: any, cb: any) => {
          submits++
          cb({ kind: 'block', block: { kind: 'text', text: '[SILENT]' } })
        },
        destroySession: async () => {},
      } as any,
      async () => {},
    )
    const persistLastRun = (sched as any).persistLastRun.bind(sched)
    let failOnce = true
    ;(sched as any).persistLastRun = async (value: Record<string, number>) => {
      if (failOnce) {
        failOnce = false
        throw new Error('simulated last-run disk failure')
      }
      await persistLastRun(value)
    }

    await (sched as any).tick()
    assert.equal(submits, 0, 'submit cannot start before the owned occurrence is durable')
    const disabled = parseYaml(readFileSync(paths.cronYaml, 'utf8')) as any
    assert.equal(disabled.jobs[0].enabled, false)
    const retryState = JSON.parse(readFileSync(retryPath, 'utf8')) as Record<string, any>
    assert.equal(retryState[job.id], undefined)

    await (sched as any).tick()
    assert.equal(submits, 0)
    await (sched as any).tick()
    assert.equal(submits, 0, 'unknown submit boundary cannot be replayed')
  })

  it('never retries after submit began, even when partial output/tool side effects preceded the throw', async () => {
    let destroys = 0
    let deliveries = 0
    const sched = new CronScheduler(
      { defaults: { model: 'glm-5.2' } } as any,
      {
        getOrCreate: async (opts: any) => ({ sessionKey: opts.sessionKey }),
        submit: async (_session: any, _prompt: any, cb: any) => {
          cb({ kind: 'block', block: { kind: 'text', text: 'partial after tool write' } })
          throw new Error('upstream failed after side effect')
        },
        destroySession: async () => { destroys++ },
      } as any,
      async () => { deliveries++ },
    )
    assert.deepEqual(await (sched as any).runJob(job, agent, NOOP_CRON_DURABILITY), {
      kind: 'terminal_failure', code: 'EXECUTION_ERROR',
    })
    assert.equal(destroys, 1)
    assert.equal(deliveries, 0, 'partial output after an execution failure must not be delivered')
  })

  it('retries after submit only from a complete read-only tool checkpoint', async () => {
    const events: unknown[] = []
    const sched = new CronScheduler(
      { defaults: { model: 'glm-5.2' } } as any,
      {
        getOrCreate: async (opts: any) => ({ sessionKey: opts.sessionKey }),
        submit: async (_session: any, _prompt: any, cb: any) => {
          cb({ kind: 'block', block: { kind: 'tool_use', blockId: 'read-1', toolName: 'Read' } })
          cb({ kind: 'block', block: { kind: 'tool_result', toolUseBlockId: 'read-1', toolName: 'Read', isError: false } })
          throw new Error('runner disconnected after a read-only checkpoint')
        },
        destroySession: async () => {},
      } as any,
      async () => {},
    )
    const outcome = await (sched as any).runJob(job, agent, {
      consumeOccurrence: async () => {},
      markSubmitStarted: async () => {},
      recordEvent: (event: unknown) => events.push(event),
      stageDelivery: async () => {},
      recoverInterruptedExecution: async () => cronExecutionTapeIsReplaySafe(events),
    })
    assert.deepEqual(outcome, {
      kind: 'retryable_failure', code: 'SAFE_CHECKPOINT_RECOVERY',
    })
  })
})

describe('CronScheduler delivery outbox retry', () => {
  it('consumes before submit and suppresses send/re-execution when outbox persistence fails', async () => {
    const events: string[] = []
    let submits = 0
    let deliveries = 0
    const sched = new CronScheduler(
      { defaults: { model: 'glm-5.2' } } as any,
      {
        getOrCreate: async (opts: any) => ({ sessionKey: opts.sessionKey }),
        submit: async (_s: any, _t: any, cb: any) => {
          events.push('submit')
          submits++
          cb({ kind: 'block', block: { kind: 'text', text: 'side effect already happened' } })
        },
        destroySession: async () => {},
      } as any,
      async () => { deliveries++ },
    )
    ;(sched as any).persistRetryState = async () => {
      throw new Error('disk unavailable')
    }
    const job = {
      id: 'remind-outbox-write-failure', schedule: '0 9 * * *', agent: 'x',
      prompt: 'p', deliver: 'webchat', enabled: true,
    } as any
    const outcome = await (sched as any).runJob(
      job,
      { id: 'x', model: 'glm-5.2' },
      {
        consumeOccurrence: async () => { events.push('consume') },
        stageDelivery: async (outputFile: string) => {
          events.push('stage')
          await (sched as any).stageDeliveryOutbox(job, 100, Date.now(), outputFile)
        },
      },
    )
    assert.deepEqual(outcome, {
      kind: 'terminal_failure', code: 'DELIVERY_OUTBOX_WRITE_FAILED',
    })
    assert.deepEqual(events, ['consume', 'submit', 'stage'])
    assert.equal(submits, 1)
    assert.equal(deliveries, 0)
    assert.equal((sched as any).retryState.has(job.id), false)
  })

  it('retries archived delivery without executing the agent a second time', async () => {
    let submits = 0
    let deliveries = 0
    const sessions = {
      getOrCreate: async (opts: any) => ({ sessionKey: opts.sessionKey }) as any,
      submit: async (_s: any, _t: any, cb: any) => {
        submits++
        cb({ kind: 'block', block: { kind: 'text', text: 'durable reminder output' } })
      },
      destroySession: async () => {},
    }
    const deliveryIds: string[] = []
    const sched = new CronScheduler(
      { defaults: { model: 'glm-5.2' } } as any,
      sessions as any,
      async (_text, _job, delivery) => {
        deliveries++
        deliveryIds.push(delivery!.deliveryId)
        if (deliveries === 1) throw new Error('transient channel detail')
      },
    )
    const job = {
      id: 'remind-delivery-outbox', schedule: '0 9 * * *', agent: 'x',
      prompt: 'p', deliver: 'webchat', enabled: true,
    } as any
    const first = await (sched as any).runJob(
      job,
      { id: 'x', model: 'glm-5.2' },
      NOOP_CRON_DURABILITY,
      { dueMinuteKey: 100, deliveryId: cronDeliveryId(job.id, 100) },
    )
    assert.equal(first.kind, 'retryable_failure')
    assert.equal(first.retry?.phase, 'delivery')
    assert.equal(typeof first.retry?.outputFile, 'string')
    const retried = await (sched as any).retryArchivedDelivery(job, {
      dueMinuteKey: 100,
      schedule: job.schedule,
      failures: 1,
      nextAttemptAt: 0,
      code: first.code,
      phase: 'delivery',
      outputFile: first.retry.outputFile,
      deliveryId: cronDeliveryId(job.id, 100),
    })
    assert.deepEqual(retried, { kind: 'completed' })
    assert.equal(submits, 1, 'delivery retry must not re-run model/tool side effects')
    assert.equal(deliveries, 2)
    assert.deepEqual(deliveryIds, [cronDeliveryId(job.id, 100), cronDeliveryId(job.id, 100)])
  })
})
