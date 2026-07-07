// Set OPENCLAUDE_HOME to an isolated temp dir BEFORE importing cron.ts —
// `paths.cronYaml` snapshots HOME at module load time, so this must run first.
import { mkdtempSync, rmSync, existsSync, unlinkSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ORIGINAL_OPENCLAUDE_HOME = process.env.OPENCLAUDE_HOME
const ORIGINAL_SEED_DEFAULT_CRON = process.env.OC_SEED_DEFAULT_CRON

const TEST_HOME = mkdtempSync(join(tmpdir(), 'oc-cron-test-'))
process.env.OPENCLAUDE_HOME = TEST_HOME

import { describe, it, before, after, beforeEach } from 'node:test'
import * as assert from 'node:assert/strict'
import { parse as parseYaml } from 'yaml'

const { ensureCronFile, isUserInitiatedCronJob, validateCronSchedule } = await import('../cron.js')
const { paths } = await import('@openclaude/storage')

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
