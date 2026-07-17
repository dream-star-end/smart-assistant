import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, test } from 'node:test'

import {
  type KnowledgePlanetMediaDeps,
  KnowledgePlanetMediaError,
  sealKnowledgePlanetMedia,
  stageKnowledgePlanetMedia,
} from './knowledgePlanetMedia.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<{
  deps: KnowledgePlanetMediaDeps
  uploads: string
  generated: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'oc-kp-media-'))
  roots.push(root)
  const uploads = join(root, 'uploads')
  const generated = join(root, 'generated')
  const stagingRoot = join(root, 'staging')
  await Promise.all([mkdir(uploads), mkdir(generated)])
  return {
    uploads,
    generated,
    deps: {
      resolveUserMediaDirs: async () => ({ kind: 'ok', uid: 7, uploads, generated }),
      stagingRoot,
      expectedOwnerUid: process.getuid?.() ?? 0,
    },
  }
}

describe('Knowledge Planet media sealing and staging', () => {
  test('seals only supported container paths and stages immutable hash-bound bytes', async () => {
    const { deps, uploads, generated } = await fixture()
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('image-body'),
    ])
    const pdf = Buffer.from('%PDF-1.7\nfile-body')
    await writeFile(join(uploads, 'photo.png'), png)
    await writeFile(join(generated, 'report.pdf'), pdf)
    const manifest = await sealKnowledgePlanetMedia({
      userId: 7,
      deps,
      items: [
        { path: '/home/agent/.openclaude/uploads/photo.png', kind: 'image' },
        { path: '/home/agent/.openclaude/generated/report.pdf', kind: 'file' },
      ],
    })
    assert.equal(manifest.length, 2)
    assert.equal(manifest[0]?.mimeType, 'image/png')
    assert.equal(manifest[1]?.mimeType, 'application/pdf')
    assert.equal(manifest[0]?.sha256, createHash('sha256').update(png).digest('hex'))

    const staged = await stageKnowledgePlanetMedia({ userId: 7, manifest, deps })
    assert.ok(staged)
    assert.equal((await lstat(staged.directory)).mode & 0o777, 0o555)
    for (const item of manifest) {
      const path = join(staged.directory, item.inputId)
      assert.equal((await lstat(path)).mode & 0o777, 0o444)
      assert.equal(
        createHash('sha256')
          .update(await readFile(path))
          .digest('hex'),
        item.sha256,
      )
    }
    await staged.cleanup()
    await assert.rejects(lstat(staged.directory), { code: 'ENOENT' })
  })

  test('rejects traversal, symlinks, unsupported image bytes and post-confirm changes', async () => {
    const { deps, uploads } = await fixture()
    await writeFile(join(uploads, 'plain.txt'), 'not an image')
    await assert.rejects(
      sealKnowledgePlanetMedia({
        userId: 7,
        deps,
        items: [{ path: '/home/agent/.openclaude/uploads/../plain.txt', kind: 'file' }],
      }),
      KnowledgePlanetMediaError,
    )
    await assert.rejects(
      sealKnowledgePlanetMedia({
        userId: 7,
        deps,
        items: [{ path: '/home/agent/.openclaude/uploads/plain.txt', kind: 'image' }],
      }),
      KnowledgePlanetMediaError,
    )

    await symlink(join(uploads, 'plain.txt'), join(uploads, 'alias.txt'))
    await assert.rejects(
      sealKnowledgePlanetMedia({
        userId: 7,
        deps,
        items: [{ path: '/home/agent/.openclaude/uploads/alias.txt', kind: 'file' }],
      }),
      KnowledgePlanetMediaError,
    )

    const manifest = await sealKnowledgePlanetMedia({
      userId: 7,
      deps,
      items: [{ path: '/home/agent/.openclaude/uploads/plain.txt', kind: 'file' }],
    })
    await writeFile(join(uploads, 'plain.txt'), 'changed after confirmation')
    await assert.rejects(
      stageKnowledgePlanetMedia({ userId: 7, manifest, deps }),
      (error: unknown) =>
        error instanceof KnowledgePlanetMediaError &&
        /changed after confirmation/.test(error.message),
    )
  })
})
