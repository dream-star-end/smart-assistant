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

const { ensureCronFile } = await import('../cron.js')
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
