// Set OPENCLAUDE_HOME to an isolated temp dir BEFORE importing cron.ts —
// `paths.cronYaml` snapshots HOME at module load time, so this must run first.
import { mkdtempSync, rmSync, existsSync, unlinkSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ORIGINAL_OPENCLAUDE_HOME = process.env.OPENCLAUDE_HOME
const ORIGINAL_SEED_DEFAULT_CRON = process.env.OC_SEED_DEFAULT_CRON

const TEST_HOME = mkdtempSync(join(tmpdir(), 'oc-cron-test-'))
process.env.OPENCLAUDE_HOME = TEST_HOME

import { describe, it, before, after, beforeEach, afterEach } from 'node:test'
import * as assert from 'node:assert/strict'
import { parse as parseYaml } from 'yaml'

const {
  ensureCronFile,
  isUserInitiatedCronJob,
  validateCronSchedule,
  resolveDueMinute,
  getCatchupMinutes,
  getMaxJobs,
  getMaxPerHour,
  countMinuteHitsPerHour,
  frequencyQuotaError,
  deriveCronIndexPayload,
  CronScheduler,
} = await import('../cron.js')
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
  // 非容器,需注入 host 静态 provider seam(等价 commercial 已装配 deepseek key),否则 gate
  // 判"不可路由"→ 不降级(见 hostStaticProviders.test.ts / syntheticTurnModel.test.ts)。
  beforeEach(() => setHostStaticProviderKeys({ deepseek: 'sk-deep' }))
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
    await (sched as any).runJob(job, { id: 'main' })
    assert.equal(getOrCreateOpts.length, 1)
    assert.equal(getOrCreateOpts[0].model, 'deepseek-v4-pro', 'getOrCreate 必须收到非 codex 模型(runner engine 决定点)')
    assert.equal(submitCalls.length, 1)
    assert.equal(submitCalls[0].model, 'deepseek-v4-pro', 'submit 必须带同源 model 路由字段')
  })

  it('agent 显式 gpt-5.6-sol(codex)→ 同样替换为非 codex 兜底', async () => {
    const { sched, getOrCreateOpts, submitCalls } = makeSchedulerWithSpies('glm-5.2')
    await (sched as any).runJob(job, { id: 'main', model: 'gpt-5.6-sol' })
    assert.equal(getOrCreateOpts[0].model, 'deepseek-v4-pro')
    assert.equal(submitCalls[0].model, 'deepseek-v4-pro')
  })

  it('非 codex agent(glm-5.2)→ 不覆盖(getOrCreate 不带 model,submit model=undefined)', async () => {
    const { sched, getOrCreateOpts, submitCalls } = makeSchedulerWithSpies('gpt-5.6-sol')
    await (sched as any).runJob(job, { id: 'x', model: 'glm-5.2' })
    // 尊重原配置:getOrCreate 不注入 model 键(沿用 agent 默认),submit model 为 undefined。
    assert.equal('model' in getOrCreateOpts[0], false, '非 codex 不应注入 model override')
    assert.equal(submitCalls[0].model, undefined)
  })
})
