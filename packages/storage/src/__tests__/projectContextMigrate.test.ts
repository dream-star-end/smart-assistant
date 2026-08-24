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

  it('safe-down backup uses project-relative paths and fails closed on copy/hash errors', async () => {
    const { backupRefusedFiles } = await import('../projectContextMigrate.js')
    const { mkdir, writeFile, readFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const a = join(home, 'projects', ID, 'meta.json')
    const b = join(home, 'projects', E2E, 'meta.json')
    await mkdir(join(home, 'projects', ID), { recursive: true })
    await mkdir(join(home, 'projects', E2E), { recursive: true })
    await writeFile(a, '{"a":1}\n')
    await writeFile(b, '{"b":2}\n')
    const backupRoot = join(home, 'projects', '_migration', 'down-rel')
    const ok = await backupRefusedFiles(home, backupRoot, [a, b])
    assert.equal(ok.ok, true)
    if (!ok.ok) return
    const manifest = JSON.parse(await readFile(ok.manifestPath, 'utf8')) as {
      files: Array<{ relativePath: string }>
    }
    assert.deepEqual(
      manifest.files.map((f) => f.relativePath).sort(),
      [`projects/${E2E}/meta.json`, `projects/${ID}/meta.json`].sort(),
    )
    const copiedA = await readFile(join(backupRoot, 'projects', ID, 'meta.json'), 'utf8')
    const copiedB = await readFile(join(backupRoot, 'projects', E2E, 'meta.json'), 'utf8')
    assert.equal(copiedA.includes('"a":1'), true)
    assert.equal(copiedB.includes('"b":2'), true)

    const failRoot = join(home, 'projects', '_migration', 'down-fail')
    const failed = await backupRefusedFiles(home, failRoot, [a], async () => {
      throw new Error('copy exploded')
    })
    assert.equal(failed.ok, false)
    if (!failed.ok) assert.match(failed.error, /copy exploded/)

    const mismatch = await backupRefusedFiles(home, join(home, 'projects', '_migration', 'down-hash'), [a], async (_src, dest) => {
      await writeFile(dest, 'wrong-bytes\n')
    })
    assert.equal(mismatch.ok, false)
    if (!mismatch.ok) assert.match(mismatch.error, /hash mismatch/)
  })
})
