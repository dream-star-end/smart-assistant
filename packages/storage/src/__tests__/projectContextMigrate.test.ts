/**
 * Run: npx tsx --test packages/storage/src/__tests__/projectContextMigrate.test.ts
 */
import * as assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import Database from 'better-sqlite3'

const home = await mkdtemp(join(tmpdir(), 'oc-migrate-pc-'))
process.env.OPENCLAUDE_HOME = home

const { migrateProjectContext, defaultManifestPath } = await import('../projectContextMigrate.js')
const { ensureProjectMemoryLedger } = await import('../projectMemoryLedger.js')

const ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const E2E = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

function seedDb(path: string): void {
  const db = new Database(path)
  db.exec(`
    CREATE TABLE tb_project (
      id TEXT PRIMARY KEY, key TEXT, name TEXT, archived_at INTEGER, created_at INTEGER
    );
  `)
  ensureProjectMemoryLedger(db)
  const now = Date.now()
  db.prepare(`INSERT INTO tb_project VALUES (?,?,?,?,?)`).run(ID, 'TEST', 'V5个人版', null, now)
  db.prepare(`INSERT INTO tb_project VALUES (?,?,?,?,?)`).run(E2E, 'E2E', 'E2E 冒烟', null, now)
  db.close()
}

describe('migrateProjectContext', () => {
  it('dry-run / apply copy main project memories as candidates; safe-down refuses edits', async () => {
    const dbPath = join(home, 'taskboard.db')
    seedDb(dbPath)
    mkdirSync(join(home, 'agents', 'main', 'memory'), { recursive: true })
    writeFileSync(
      join(home, 'agents', 'main', 'memory', 'v5-notes.md'),
      '---\nname: v5\ndescription: TEST 约定\ntype: project\n---\nV5个人版看板约定\n',
    )
    const dry = await migrateProjectContext({ home, dbPath, mode: 'dry-run' })
    assert.equal(dry.autoBindSessions, false)
    assert.ok(dry.skippedE2E.includes(E2E))
    assert.equal(dry.copiedCandidates.length, 1)
    assert.equal(dry.mode, 'dry-run')

    const applied = await migrateProjectContext({ home, dbPath, mode: 'apply' })
    assert.equal(applied.mode, 'apply')
    const manifestPath = defaultManifestPath(home, applied.createdAt)
    const saved = JSON.parse(await readFile(manifestPath, 'utf8')) as { created: unknown[] }
    assert.ok(saved.created.length >= 1)

    await writeFile(
      join(home, 'projects', ID, 'meta.json'),
      JSON.stringify({ schemaVersion: 1, userEdited: true }),
    )
    await assert.rejects(
      () => migrateProjectContext({ home, dbPath, mode: 'down', downManifestPath: manifestPath }),
      /safe-down refused/,
    )
  })
})
