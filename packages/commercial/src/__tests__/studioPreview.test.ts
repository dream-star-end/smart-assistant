/**
 * Q2 (2026-10-30): downscaled WebP previews of studio image blobs — width rounding, one render
 * cached on disk, removal with the blob, and the 304 on a matching ETag.
 */
import assert from 'node:assert/strict'
import { mkdtemp, stat, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import sharp from 'sharp'

import {
  canPreview,
  previewBytes,
  previewPath,
  previewWidth,
  removePreviews,
  sendPreview,
} from '../media-studio/preview.js'

const SHA = 'c'.repeat(64)

describe('studio previews (Q2)', () => {
  it('rounds a requested width up to a preview size; previews only still images', () => {
    assert.equal(previewWidth(null), 640)
    assert.equal(previewWidth('abc'), 640)
    assert.equal(previewWidth('100'), 320)
    assert.equal(previewWidth('480'), 640)
    assert.equal(previewWidth('5000'), 1280)
    assert.ok(canPreview('image/png') && canPreview('image/jpeg') && canPreview('image/webp'))
    assert.ok(!canPreview('video/mp4') && !canPreview('audio/mpeg'))
    assert.throws(() => previewPath('/r', 'nope', 640))
  })

  it('renders a WebP inside the width once, serves the cached copy, and is removed with its blob', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'oc-studio-preview-'))
    const src = path.join(root, 'orig.png')
    await writeFile(
      src,
      await sharp({ create: { width: 2048, height: 1152, channels: 3, background: '#a33' } })
        .png()
        .toBuffer(),
    )
    const [a, b] = await Promise.all([
      previewBytes(root, { path: src, sha: SHA }, 640),
      previewBytes(root, { path: src, sha: SHA }, 640),
    ])
    assert.deepEqual(a, b)
    const meta = await sharp(a).metadata()
    assert.equal(meta.format, 'webp')
    assert.equal(meta.width, 640)
    assert.equal(meta.height, 360)
    const cached = previewPath(root, SHA, 640)
    assert.equal((await stat(cached)).size, a.length)
    // A small original is never enlarged.
    const tiny = path.join(root, 'tiny.png')
    await writeFile(
      tiny,
      await sharp({ create: { width: 200, height: 100, channels: 3, background: '#3a3' } })
        .png()
        .toBuffer(),
    )
    assert.equal(
      (await sharp(await previewBytes(root, { path: tiny, sha: 'd'.repeat(64) }, 1280)).metadata())
        .width,
      200,
    )
    await removePreviews(root, SHA)
    await assert.rejects(stat(cached))
  })

  it('answers 304 to a matching ETag and is cacheable for good', () => {
    const headers: Record<string, string> = {}
    const res = {
      statusCode: 0,
      body: null as Buffer | null,
      setHeader(k: string, v: string) {
        headers[k.toLowerCase()] = v
      },
      end(b?: Buffer) {
        this.body = b ?? null
      },
    }
    const bytes = Buffer.from('webp')
    sendPreview(
      { headers: {} } as IncomingMessage,
      res as unknown as ServerResponse,
      SHA,
      640,
      bytes,
    )
    assert.equal(res.statusCode, 200)
    assert.equal(headers['content-type'], 'image/webp')
    assert.match(headers['cache-control']!, /immutable/)
    sendPreview(
      { headers: { 'if-none-match': headers.etag } } as unknown as IncomingMessage,
      res as unknown as ServerResponse,
      SHA,
      640,
      bytes,
    )
    assert.equal(res.statusCode, 304)
    assert.equal(res.body, null)
  })
})
