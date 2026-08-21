/**
 * 流水线模板:内置四条即 seed,自定义快照可套用,不与种子分叉。
 *
 * Run: npx tsx --test packages/gateway/src/taskboard/__tests__/templates.test.ts
 */
import * as assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { type TaskboardDb, openTaskboardDb } from '../db/index.js'
import { listPipelines, listStages } from '../db/pipelines.js'
import { createProject } from '../db/projects.js'
import { listSeedStageNames, seedDefaultPipelines } from '../db/seed.js'
import {
  applyTemplate,
  createTemplateFromPipeline,
  deleteTemplate,
  getTemplate,
  listTemplates,
} from '../db/templates.js'

const dirs: string[] = []

function freshDb(): TaskboardDb {
  const dir = mkdtempSync(join(tmpdir(), 'oc-tb-tpl-'))
  dirs.push(dir)
  return openTaskboardDb(join(dir, 'taskboard.db'))
}

afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('内置模板与 seed 自洽', () => {
  it('列出 4 条 builtin,阶段名与 seed 一致', () => {
    const db = freshDb()
    const items = listTemplates(db)
    const builtins = items.filter((t) => t.source === 'builtin')
    assert.equal(builtins.length, 4)
    assert.deepEqual(
      builtins.map((t) => t.id),
      ['builtin:bug', 'builtin:feature', 'builtin:spike', 'builtin:chore'],
    )
    for (const t of builtins) {
      assert.ok(t.ticketType)
      assert.deepEqual(
        t.stages.map((s) => s.name),
        listSeedStageNames(t.ticketType),
      )
    }
    db.close()
  })

  it('对已有项目套用 builtin:chore 幂等,第二次跳过', () => {
    const db = freshDb()
    const project = createProject(db, { key: 'TPL', name: '模板' })
    const first = applyTemplate(db, 'builtin:chore', project.id)
    assert.equal(first.createdPipelines, 1)
    assert.ok(first.createdStages >= 3)
    assert.equal(listPipelines(db, project.id).length, 1)
    const second = applyTemplate(db, 'builtin:chore', project.id)
    assert.equal(second.createdPipelines, 0)
    assert.equal(second.skippedPipelines, 1)
    assert.equal(listPipelines(db, project.id).length, 1)
    const stages = listStages(db, first.pipeline!.id)
    assert.deepEqual(
      stages.map((s) => s.name),
      listSeedStageNames('chore'),
    )
    db.close()
  })

  it('seedDefaultPipelines 传入子集只种那些类型', () => {
    const db = freshDb()
    const project = createProject(db, { key: 'SUB', name: '子集' })
    const result = seedDefaultPipelines(db, project.id, ['bug'])
    assert.equal(result.createdPipelines, 1)
    const pipes = listPipelines(db, project.id)
    assert.equal(pipes.length, 1)
    assert.equal(pipes[0].ticketType, 'bug')
    db.close()
  })
})

describe('自定义模板', () => {
  it('从已有流水线快照,套到另一项目,删内置被拒', () => {
    const db = freshDb()
    const src = createProject(db, { key: 'SRC', name: '源' })
    seedDefaultPipelines(db, src.id, ['feature'])
    const srcPipe = listPipelines(db, src.id)[0]
    const custom = createTemplateFromPipeline(db, {
      pipelineId: srcPipe.id,
      name: '我的需求线',
      slug: 'my-feature',
    })
    assert.equal(custom.source, 'custom')
    assert.equal(custom.slug, 'my-feature')
    assert.equal(custom.ticketType, 'feature')
    assert.ok(getTemplate(db, 'my-feature'))

    const dst = createProject(db, { key: 'DST', name: '目标' })
    const applied = applyTemplate(db, custom.id, dst.id)
    assert.equal(applied.createdPipelines, 1)
    assert.equal(applied.createdStages, custom.stages.length)
    const dstStages = listStages(db, applied.pipeline!.id)
    assert.deepEqual(
      dstStages.map((s) => s.name),
      listSeedStageNames('feature'),
    )

    assert.throws(() => deleteTemplate(db, 'builtin:bug'), /cannot delete builtin/)
    deleteTemplate(db, custom.id)
    assert.equal(getTemplate(db, custom.id), null)
    db.close()
  })
})
