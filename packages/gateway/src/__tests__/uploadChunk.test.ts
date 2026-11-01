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
  partFileName,
  sumUploadReservationBytes,
  writeLocalPart,
  writeMeta,
  type UploadSessionMeta,
} from '../uploadChunkStore.js'
import { planAgedDeletes, sweepStalePartsInDir } from '../uploadRetention.js'

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
