/**
 * A chat project's reserved work-project id is created on first use in the
 * container, idempotently, and never replaced.
 * Run: npx tsx --test packages/gateway/src/taskboard/__tests__/ensureProject.test.ts
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'

import { createProject, deriveProjectKey, ensureProjectById, listPipelines, openTaskboardDb } from '../db/index.js'

const ID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function db() {
  return openTaskboardDb(join(mkdtempSync(join(tmpdir(), 'oc-ensure-')), 'taskboard.db'))
}

describe('ensureProjectById', () => {
  test('creates the board with the reserved id, a key from the name and default pipelines', () => {
    const d = db()
    const { project, created } = ensureProjectById(d, { id: ID_A, name: 'V5 自用版改版', workspaceSpec: { kind: 'isolated' } })
    assert.equal(created, true)
    assert.equal(project.id, ID_A)
    assert.equal(project.key, 'V5')
    assert.deepEqual(project.workspaceSpec, { kind: 'isolated' })
    assert.ok(listPipelines(d, ID_A).length > 0)
  })

  test('is idempotent: a second call returns the same row unchanged', () => {
    const d = db()
    const first = ensureProjectById(d, { id: ID_A, name: '论文综述' })
    const second = ensureProjectById(d, { id: ID_A, name: '改了名也不改看板' })
    assert.equal(second.created, false)
    assert.equal(second.project.key, first.project.key)
    assert.equal(second.project.name, '论文综述')
  })

  test('a taken key moves to the next free one', () => {
    const d = db()
    createProject(d, { key: 'V5', name: 'existing' })
    const { project } = ensureProjectById(d, { id: ID_B, name: 'V5 other' })
    assert.equal(project.key, 'V5OTHE')
    const again = ensureProjectById(d, { id: ID_A, name: 'V5' })
    assert.equal(again.project.key, 'V52')
  })

  test('names without ASCII get a stable P-key', () => {
    assert.match(deriveProjectKey('论文综述'), /^P[A-Z0-9]{1,4}$/)
    assert.equal(deriveProjectKey('论文综述'), deriveProjectKey('论文综述'))
    assert.equal(deriveProjectKey('a'), deriveProjectKey('a'))
    assert.match(deriveProjectKey('a'), /^P/)
  })
})
