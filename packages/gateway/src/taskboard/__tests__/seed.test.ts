/**
 * 默认流水线种子单测。覆盖四种类型、agent 绑定、human 不巡检、prompt
 * 字数、以及重复 seed 幂等。库文件落临时目录,跑完删除。
 *
 * Run: npx tsx --test packages/gateway/src/taskboard/__tests__/seed.test.ts
 */
import * as assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { type TaskboardDb, openTaskboardDb } from '../db/index.js'
import { listPipelines, listStages } from '../db/pipelines.js'
import { createProject } from '../db/projects.js'
import {
  DEFAULT_PATROL_CRON,
  SEED_AGENT_IDS,
  listSeedStageNames,
  seedDefaultPipelines,
} from '../db/seed.js'

const dirs: string[] = []

function freshDb(): TaskboardDb {
  const dir = mkdtempSync(join(tmpdir(), 'oc-tb-seed-'))
  dirs.push(dir)
  return openTaskboardDb(join(dir, 'taskboard.db'))
}

afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function hanCount(text: string): number {
  return (text.match(/\p{Script=Han}/gu) ?? []).length
}

describe('seedDefaultPipelines', () => {
  it('为四种类型各建默认流水线,阶段名与设计一致', () => {
    const db = freshDb()
    const project = createProject(db, { key: 'OCV5', name: 'V5' })
    const result = seedDefaultPipelines(db, project.id)
    assert.equal(result.createdPipelines, 4)
    assert.equal(result.skippedPipelines, 0)
    assert.equal(listPipelines(db, project.id).length, 4)

    assert.deepEqual(listSeedStageNames('bug'), [
      '复现确认',
      '定位根因',
      '修复',
      '自验',
      '待我确认',
      '完成',
    ])
    assert.deepEqual(listSeedStageNames('feature'), [
      '需求澄清',
      '方案设计',
      '我确认方案',
      '实现',
      '自验+审查',
      '待我确认',
      '完成',
    ])
    assert.deepEqual(listSeedStageNames('spike'), ['明确问题', '检索调研', '结论汇总', '待我确认'])
    assert.deepEqual(listSeedStageNames('chore'), ['执行', '自验', '待我确认'])

    for (const pipe of listPipelines(db, project.id)) {
      assert.equal(pipe.isDefault, true)
      assert.ok(pipe.ticketType)
      const stages = listStages(db, pipe.id)
      assert.deepEqual(
        stages.map((s) => s.name),
        listSeedStageNames(pipe.ticketType!),
      )
      stages.forEach((stage, i) => {
        assert.equal(stage.ordinal, i)
        if (stage.kind === 'ai') {
          assert.ok(stage.agentId, `${stage.name} 必须绑 agent`)
          assert.ok(
            Object.values(SEED_AGENT_IDS).includes(
              stage.agentId as (typeof SEED_AGENT_IDS)[keyof typeof SEED_AGENT_IDS],
            ),
          )
          assert.notEqual(stage.agentId, 'hidden-reviewer')
          assert.ok(stage.promptTemplate)
          assert.ok(stage.exitChecklist)
          assert.equal(stage.patrolEnabled, true)
          assert.equal(stage.patrolCron, DEFAULT_PATROL_CRON)
          assert.equal(stage.model, null)
          const han = hanCount(stage.promptTemplate ?? '')
          assert.ok(han >= 100 && han <= 250, `${stage.name} prompt 汉字 ${han} 不在 100-250`)
          for (const ph of [
            '{{ticket.identifier}}',
            '{{ticket.title}}',
            '{{ticket.body}}',
            '{{last_run.summary}}',
            '{{last_run.output}}',
            '{{comments}}',
            '{{stage.exit_checklist}}',
          ]) {
            assert.ok(stage.promptTemplate?.includes(ph), `${stage.name} 缺少占位符 ${ph}`)
          }
        } else {
          assert.equal(stage.patrolEnabled, false)
          assert.equal(stage.patrolCron, null)
          assert.equal(stage.agentId, null)
          assert.equal(stage.requireHumanAck, true)
        }
      })
    }

    const bug = listPipelines(db, project.id).find((p) => p.ticketType === 'bug')
    const bugStages = listStages(db, bug!.id)
    assert.equal(bugStages.find((s) => s.name === '复现确认')?.agentId, 'stage-triage')
    assert.equal(bugStages.find((s) => s.name === '定位根因')?.agentId, 'stage-diagnose')
    assert.equal(bugStages.find((s) => s.name === '修复')?.agentId, 'stage-implement')
    assert.equal(bugStages.find((s) => s.name === '自验')?.agentId, 'stage-verify')

    const feat = listPipelines(db, project.id).find((p) => p.ticketType === 'feature')
    const featStages = listStages(db, feat!.id)
    assert.equal(featStages.find((s) => s.name === '需求澄清')?.agentId, 'stage-triage')
    assert.equal(featStages.find((s) => s.name === '方案设计')?.agentId, 'stage-design')
    assert.equal(featStages.find((s) => s.name === '实现')?.agentId, 'stage-implement')
    assert.equal(featStages.find((s) => s.name === '自验+审查')?.agentId, 'stage-verify')

    const spike = listPipelines(db, project.id).find((p) => p.ticketType === 'spike')
    const spikeStages = listStages(db, spike!.id)
    assert.equal(spikeStages.find((s) => s.name === '明确问题')?.agentId, 'stage-triage')
    assert.equal(spikeStages.find((s) => s.name === '检索调研')?.agentId, 'stage-research')
    assert.equal(spikeStages.find((s) => s.name === '结论汇总')?.agentId, 'stage-report')

    const chore = listPipelines(db, project.id).find((p) => p.ticketType === 'chore')
    const choreStages = listStages(db, chore!.id)
    assert.equal(choreStages.find((s) => s.name === '执行')?.agentId, 'stage-implement')
    assert.equal(choreStages.find((s) => s.name === '自验')?.agentId, 'stage-verify')
    db.close()
  })

  it('重复 seed 不重复插入', () => {
    const db = freshDb()
    const project = createProject(db, { key: 'OCV5', name: 'V5' })
    const first = seedDefaultPipelines(db, project.id)
    const second = seedDefaultPipelines(db, project.id)
    assert.equal(second.createdPipelines, 0)
    assert.equal(second.createdStages, 0)
    assert.equal(second.skippedPipelines, 4)
    assert.equal(second.skippedStages, first.createdStages)
    assert.equal(listPipelines(db, project.id).length, 4)
    const stageCount = listPipelines(db, project.id).reduce(
      (n, pipe) => n + listStages(db, pipe.id).length,
      0,
    )
    assert.equal(stageCount, first.createdStages)
    db.close()
  })
})
