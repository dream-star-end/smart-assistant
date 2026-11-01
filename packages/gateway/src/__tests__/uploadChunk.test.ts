import * as assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  MAX_UPLOAD_FILE_BYTES,
  MAX_UPLOAD_SINGLE_BYTES,
  UPLOAD_CHUNK_BYTES,
  UPLOAD_PART_MAX_AGE_MS,
  UPLOAD_RETENTION_MS,
} from '../../../protocol/src/uploadLimits.js'
import {
  confirmedReceived,
  freshUploadIds,
  isOrphanRemotePart,
  partFileName,
  sumUploadReservationBytes,
  writeLocalPart,
  writeMeta,
  type UploadSessionMeta,
} from '../uploadChunkStore.js'
import { planAgedDeletes, readReachedSize, scanJsonlTree, scanRefsForUploads, sweepStalePartsInDir } from '../uploadRetention.js'

function meta(dir: string, over: Partial<UploadSessionMeta> = {}): UploadSessionMeta {
  const value: UploadSessionMeta = {
    uploadId: 'a'.repeat(32),
    userId: 'default',
    filename: 'note.txt',
    size: 3,
    mimeType: 'text/plain',
    ext: 'txt',
    chunkBytes: UPLOAD_CHUNK_BYTES,
    chunkCount: 1,
    createdAt: Date.now(),
    received: [],
    remote: null,
    ...over,
  }
  writeMeta(dir, value)
  return value
}

describe('chunk store quota', () => {
  it('assembled file cap is 1GiB and one HTTP body stays 100MiB', () => {
    assert.equal(MAX_UPLOAD_FILE_BYTES, 1024 * 1024 * 1024)
    assert.equal(MAX_UPLOAD_SINGLE_BYTES, 100 * 1024 * 1024)
    assert.ok(MAX_UPLOAD_SINGLE_BYTES < MAX_UPLOAD_FILE_BYTES)
    assert.equal(UPLOAD_CHUNK_BYTES, 16 * 1024 * 1024)
  })

  it('quota ignores dotfiles and does not count a live part twice', () => {
    const root = mkdtempSync(join(tmpdir(), 'upload-chunk-'))
    const uploads = join(root, 'uploads')
    const sessions = join(root, '.upload-sessions')
    mkdirSync(uploads)
    writeFileSync(join(uploads, 'kept.bin'), Buffer.alloc(10))
    writeFileSync(join(uploads, '.hidden'), Buffer.alloc(1000))
    const session = meta(sessions, { size: 30 })
    writeLocalPart(sessions, session, 0, Buffer.from('abc'))
    writeFileSync(join(sessions, partFileName('b'.repeat(32), 0)), Buffer.from('orphan'))
    assert.equal(sumUploadReservationBytes(uploads, sessions), 10 + 30 + 'orphan'.length)
  })
})

describe('upload retention decisions', () => {
  it('keeps a referenced aged file and a young file, and deletes an old unreferenced file', () => {
    const old = UPLOAD_RETENTION_MS + 5
    const young = UPLOAD_RETENTION_MS - 5
    const name = `${'ab'.repeat(32)}.txt`
    const refs = new Set([name])
    assert.deepEqual(
      planAgedDeletes(
        [
          { name, ageMs: old },
          { name: `${'cd'.repeat(32)}.bin`, ageMs: old },
          { name: `${'ef'.repeat(32)}.bin`, ageMs: young },
        ],
        refs,
        true,
      ),
      [`${'cd'.repeat(32)}.bin`],
    )
  })

  it('does not delete aged files when the reference scan is incomplete', () => {
    const name = `${'ab'.repeat(32)}.txt`
    assert.deepEqual(planAgedDeletes([{ name, ageMs: UPLOAD_RETENTION_MS + 1 }], new Set(), false), [])
  })

  it('deletes stale parts even when the reference scan is incomplete', () => {
    const root = mkdtempSync(join(tmpdir(), 'upload-parts-'))
    const part = partFileName('a'.repeat(32), 0)
    writeFileSync(join(root, part), Buffer.from('stale'))
    const old = new Date(Date.now() - UPLOAD_PART_MAX_AGE_MS - 1000)
    utimesSync(join(root, part), old, old)
    writeFileSync(join(root, '.tmp-keep'), Buffer.from('tmp'))
    const removed = sweepStalePartsInDir(root, Date.now())
    assert.equal(removed, 1)
    assert.equal(statSync(join(root, '.tmp-keep')).isFile(), true)
    assert.throws(() => statSync(join(root, part)))
  })
})

describe('remote part resume', () => {
  it('does not report a received index whose part is gone', () => {
    const id = 'a'.repeat(32)
    const session = {
      uploadId: id,
      userId: 'default',
      filename: 'note.txt',
      size: 3,
      mimeType: 'text/plain',
      ext: 'txt',
      chunkBytes: UPLOAD_CHUNK_BYTES,
      chunkCount: 2,
      createdAt: Date.now(),
      received: [0, 1],
      remote: { hostUuid: 'h', remoteUploadsDir: '/uploads' },
    }
    const present = new Set([partFileName(id, 1)])
    assert.deepEqual(confirmedReceived(session, (index) => present.has(partFileName(id, index))), [1])
    assert.equal(isOrphanRemotePart(partFileName(id, 0), new Set([id])), false)
    assert.equal(isOrphanRemotePart(partFileName(id, 0), new Set()), true)
    assert.equal(isOrphanRemotePart(`.tmp-asm-${'b'.repeat(32)}`, new Set()), false)
  })

  it('keeps a part whose meta is fresh and drops one whose meta is stale', () => {
    const root = mkdtempSync(join(tmpdir(), 'upload-meta-'))
    const fresh = 'a'.repeat(32)
    const stale = 'b'.repeat(32)
    meta(root, { uploadId: fresh })
    meta(root, { uploadId: stale })
    const old = new Date(Date.now() - UPLOAD_PART_MAX_AGE_MS - 1000)
    utimesSync(join(root, `.upload-${stale}.json`), old, old)
    const live = freshUploadIds(root, Date.now())
    assert.ok(live)
    assert.equal(live?.has(fresh), true)
    assert.equal(live?.has(stale), false)
    assert.equal(freshUploadIds(join(root, 'missing'), Date.now()), null)
  })
})

describe('upload reference scan fails closed', () => {
  it('a short read is incomplete', () => {
    assert.equal(readReachedSize(4, () => 0), false)
    assert.equal(readReachedSize(4, () => 4), true)
    let left = 4
    assert.equal(readReachedSize(4, () => {
      if (left <= 0) return 0
      left -= 1
      return 1
    }), true)
  })

  it('a missing directory or a walk deeper than 6 levels is incomplete', () => {
    const root = mkdtempSync(join(tmpdir(), 'upload-jsonl-'))
    const into = new Set<string>()
    assert.equal(scanJsonlTree(join(root, 'missing'), into), false)
    let dir = root
    for (let depth = 0; depth < 8; depth++) {
      dir = join(dir, `d${depth}`)
      mkdirSync(dir)
    }
    const name = `${'ab'.repeat(32)}.txt`
    writeFileSync(join(dir, 'note.jsonl'), `see /api/media/${name}\n`)
    assert.equal(scanJsonlTree(root, into), false)
    assert.equal(into.has(name), false)
    const shallow = mkdtempSync(join(tmpdir(), 'upload-jsonl-ok-'))
    writeFileSync(join(shallow, 'note.jsonl'), `see /api/media/${name}\n`)
    const seen = new Set<string>()
    assert.equal(scanJsonlTree(shallow, seen), true)
    assert.equal(seen.has(name), true)
  })

  it('archive chunks and /uploads refs protect files, and a missing archive table does not', async () => {
    const mod = (await import('better-sqlite3')) as { default: new (path: string) => {
      exec: (sql: string) => void
      prepare: (sql: string) => { run: (...args: unknown[]) => void }
      close: () => void
    } }
    const Database = mod.default
    const root = mkdtempSync(join(tmpdir(), 'upload-sess-'))
    const dbPath = join(root, 'sessions.db')
    const db = new Database(dbPath)
    db.exec(`CREATE TABLE client_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      last_at INTEGER NOT NULL,
      deleted_at INTEGER,
      messages TEXT
    )`)
    db.exec(`CREATE TABLE client_session_archive_chunks (
      session_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      first_seq INTEGER NOT NULL,
      last_seq INTEGER NOT NULL,
      message_count INTEGER NOT NULL,
      messages TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`)
    const now = Date.now()
    const viaUploads = `${'cd'.repeat(32)}.bin`
    const viaArchive = `${'ab'.repeat(32)}.txt`
    const insert = db.prepare('INSERT INTO client_sessions (id, user_id, last_at, deleted_at, messages) VALUES (?, ?, ?, NULL, ?)')
    insert.run('s-default', 'default', now, `{"url":"/uploads/${viaUploads}"}`)
    insert.run('s-jwt', 'jwt-user', now, 'hello')
    db.prepare('INSERT INTO client_session_archive_chunks (session_id, user_id, first_seq, last_seq, message_count, messages, created_at) VALUES (?, ?, 1, 1, 1, ?, ?)').run(
      's-jwt',
      'jwt-user',
      `{"url":"/api/media/${viaArchive}"}`,
      now,
    )
    db.close()
    const all = await scanRefsForUploads({ userId: null, sessionsDb: dbPath, sinceMs: now - 1000, jsonlRoots: [] })
    assert.equal(all.complete, true)
    assert.equal(all.names.has(viaUploads), true)
    assert.equal(all.names.has(viaArchive), true)
    const onlyDefault = await scanRefsForUploads({ userId: 'default', sessionsDb: dbPath, sinceMs: now - 1000, jsonlRoots: [] })
    assert.equal(onlyDefault.names.has(viaUploads), true)
    assert.equal(onlyDefault.names.has(viaArchive), false)
    const barePath = join(root, 'bare.db')
    const bare = new Database(barePath)
    bare.exec('CREATE TABLE client_sessions (id TEXT, user_id TEXT, last_at INTEGER, deleted_at INTEGER, messages TEXT)')
    bare.prepare('INSERT INTO client_sessions (id, user_id, last_at, deleted_at, messages) VALUES (?, ?, ?, NULL, ?)').run('s', 'default', now, `{"url":"/api/media/${viaUploads}"}`)
    bare.close()
    const incomplete = await scanRefsForUploads({ userId: null, sessionsDb: barePath, sinceMs: now - 1000, jsonlRoots: [] })
    assert.equal(incomplete.complete, false)
  })
})
