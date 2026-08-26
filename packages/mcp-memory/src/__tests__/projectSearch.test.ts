import * as assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import Database from 'better-sqlite3'

const home = mkdtempSync(join(tmpdir(), 'oc-project-search-'))
process.env.OPENCLAUDE_HOME = home

const { handleCoreSearch, handleProjectSearch } = await import('../memoryTools.js')
const { ensureProjectMemoryLedger, ProjectMemoryLedger } = await import('@openclaude/storage')

const ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'

test('project-search hits official ledger rows and core-search stays agent-only', async () => {
  mkdirSync(join(home, 'agents', 'main', 'memory'), { recursive: true })
  writeFileSync(
    join(home, 'agents', 'main', 'memory', 'agent-only.md'),
    '---\nname: agent\ndescription: 私人\ntype: project\n---\n私人核心记忆鼻炎\n',
  )
  const db = new Database(join(home, 'taskboard.db'))
  db.exec(`CREATE TABLE tb_project (id TEXT PRIMARY KEY, key TEXT, name TEXT, created_at INTEGER, updated_at INTEGER, context_version INTEGER DEFAULT 0)`)
  ensureProjectMemoryLedger(db)
  db.prepare(`INSERT INTO tb_project VALUES (?,?,?,?,?,0)`).run(ID, 'TEST', 'V5', Date.now(), Date.now())
  const ledger = new ProjectMemoryLedger(db)
  const created = await ledger.createCandidate({
    projectId: ID,
    slug: 'board.md',
    content: '---\nname: board\ndescription: 看板约定\ntype: project\n---\n看板表格约定\n',
    actor: 'agent:main',
  })
  assert.equal(created.ok, true)
  if (created.ok) {
    await ledger.promote({
      projectId: ID,
      candidateId: created.candidate.id,
      expectedVersion: created.candidate.version,
      actor: 'user:default',
    })
  }
  db.close()

  const core = await handleCoreSearch({ agentId: 'main', query: '看板表格' })
  assert.match(core.content[0].text, /No safe Core memories match/)

  const project = await handleProjectSearch({ projectId: ID, query: '看板表格' })
  assert.match(project.content[0].text, /scope: project/)
  assert.match(project.content[0].text, /board\.md/)
})
