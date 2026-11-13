/**
 * Output versions keep their bytes: every captured output is copied into the
 * content-addressed store before it is registered, so writing report.md twice
 * gives two downloadable versions even after the file is overwritten or deleted.
 * Run: npx tsx --test packages/gateway/src/__tests__/projectAssetOutputVersions.test.ts
 */
import * as assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, open, readdir, readFile, rm, symlink, truncate, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, it } from 'node:test'
import type { OutputAssetRegistration } from '../projectAssetCollector.js'

process.env.OPENCLAUDE_HOME = await mkdtemp(join(tmpdir(), 'oc-output-versions-'))
const HOME = process.env.OPENCLAUDE_HOME

const {
  OUTPUT_VERSION_COPY_MAX_BYTES,
  _resetOutputAssetSpoolThrottleForTest,
  captureOutputVersion,
  collectSessionOutputAssets,
} = await import('../projectAssetCollector.js')
const { getSessionsDb, listProjectAssets, listProjectAssetVersions } = await import('@openclaude/storage')

const GEN = '/home/agent/.openclaude/generated'
const roots = { generated: join(HOME, 'generated'), cas: join(HOME, 'uploads') }
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const MASTER_ENV = {
  OPENCLAUDE_V3_MASTER_BASE_URL: 'http://master.test',
  OPENCLAUDE_V3_CONTAINER_TOKEN: 'container-token',
} as NodeJS.ProcessEnv
const LOCAL_ENV = {} as NodeJS.ProcessEnv

async function casFiles(): Promise<string[]> {
  return (await readdir(roots.cas).catch(() => [] as string[])).sort()
}

describe('output version capture', () => {
  beforeEach(async () => {
    _resetOutputAssetSpoolThrottleForTest()
    await rm(roots.generated, { recursive: true, force: true })
    await rm(roots.cas, { recursive: true, force: true })
    await mkdir(roots.generated, { recursive: true })
    const db = await getSessionsDb()
    db.exec('DELETE FROM project_assets')
  })

  it('copies into the store before the master registration is sent', async () => {
    await writeFile(join(roots.generated, 'report.md'), 'v1\n')
    const seenAtSend: string[][] = []
    const fetcher = (async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { items: Array<{ url?: string }> }
      const name = body.items[0]!.url!.slice('/api/media/'.length)
      seenAtSend.push([name, await readFile(join(roots.cas, name), 'utf8')])
      return { statusCode: 200, body: { text: async () => '{}' } }
    }) as unknown as typeof import('undici').request
    await collectSessionOutputAssets({
      userId: 'default', sessionId: 's-1', assistantText: `see ${GEN}/report.md`,
      env: MASTER_ENV, fetcher, sleep: async () => {}, outputRoots: roots,
      spoolFile: join(HOME, 'spool-a.jsonl'),
    })
    assert.deepEqual(seenAtSend, [[`${sha('v1\n')}.md`, 'v1\n']])
  })

  it('an output over the cap is registered by path only, nothing copied', async () => {
    const big = join(roots.generated, 'big.bin')
    await writeFile(big, '')
    await truncate(big, OUTPUT_VERSION_COPY_MAX_BYTES + 1)
    const captured = await captureOutputVersion(`${GEN}/big.bin`, roots)
    assert.deepEqual(captured, { size: OUTPUT_VERSION_COPY_MAX_BYTES + 1 })
    assert.deepEqual(await casFiles(), [])
  })

  it('a symlink out of generated/ is not followed or registered; one inside is', async () => {
    const outside = join(HOME, 'secret.txt')
    await writeFile(outside, 'not an output')
    await symlink(outside, join(roots.generated, 'escape.txt'))
    await mkdir(join(roots.generated, 'sub'))
    await writeFile(join(roots.generated, 'sub', 'real.txt'), 'inside')
    await symlink(join(roots.generated, 'sub', 'real.txt'), join(roots.generated, 'alias.txt'))

    assert.equal(await captureOutputVersion(`${GEN}/escape.txt`, roots), null)
    const inside = await captureOutputVersion(`${GEN}/alias.txt`, roots)
    assert.equal(inside?.digest, sha('inside'))

    await collectSessionOutputAssets({
      userId: 'default', sessionId: 's-1', assistantText: `${GEN}/escape.txt and ${GEN}/alias.txt`,
      env: LOCAL_ENV, outputRoots: roots,
    })
    const listed = await listProjectAssets('default', { projectId: null })
    assert.deepEqual(listed.map((a) => a.containerPath), [`${GEN}/alias.txt`])
    assert.deepEqual(await casFiles(), [`${sha('inside')}.txt`])
  })

  it('same content again is not a new version; changed content is, and both stay downloadable', async () => {
    const file = join(roots.generated, 'report.md')
    const turn = (text = `wrote ${GEN}/report.md`) =>
      collectSessionOutputAssets({ userId: 'default', sessionId: 's-1', assistantText: text, env: LOCAL_ENV, outputRoots: roots })

    await writeFile(file, '# v1\n')
    await turn()
    await turn('updated nothing, still at ' + `${GEN}/report.md`)
    let listed = await listProjectAssets('default', { projectId: null })
    assert.equal(listed.length, 1)
    assert.equal(listed[0]?.versionCount, undefined)

    await writeFile(file, '# v2, longer\n')
    await turn()
    listed = await listProjectAssets('default', { projectId: null })
    assert.equal(listed.length, 1)
    assert.equal(listed[0]?.versionCount, 2)
    assert.equal(listed[0]?.digest, sha('# v2, longer\n'))
    assert.equal(listed[0]?.containerPath, `${GEN}/report.md`)

    const versions = await listProjectAssetVersions('default', listed[0]!.id)
    assert.deepEqual(versions?.map((v) => v.sizeBytes), [13, 5])

    // The source goes away; every version still has its own bytes.
    await rm(file)
    for (const v of versions ?? []) {
      const bytes = await readFile(join(roots.cas, v.url!.slice('/api/media/'.length)), 'utf8')
      assert.equal(sha(bytes), v.digest)
    }
  })

  it('a planted file under the digest name that is not those bytes is replaced', async () => {
    await mkdir(roots.cas, { recursive: true })
    await writeFile(join(roots.cas, `${sha('real')}.txt`), 'planted, wrong size')
    await writeFile(join(roots.generated, 'a.txt'), 'real')
    const captured = await captureOutputVersion(`${GEN}/a.txt`, roots)
    assert.equal(captured?.digest, sha('real'))
    assert.equal(await readFile(join(roots.cas, `${sha('real')}.txt`), 'utf8'), 'real')
    assert.deepEqual((await casFiles()).filter((f) => f.startsWith('.tmp-')), [])
  })

  it('a FIFO with no writer is skipped without blocking', async () => {
    const fifo = join(roots.generated, 'pipe.md')
    execFileSync('mkfifo', [fifo])
    let timer: NodeJS.Timeout | undefined
    const guard = new Promise<'timeout'>((done) => {
      timer = setTimeout(() => done('timeout'), 3_000)
    })
    try {
      const got = await Promise.race([captureOutputVersion(`${GEN}/pipe.md`, roots), guard])
      assert.equal(got, null)
      const collected = await Promise.race([
        collectSessionOutputAssets({
          userId: 'default', sessionId: 's-1', assistantText: `${GEN}/pipe.md`, env: LOCAL_ENV, outputRoots: roots,
        }).then(() => 'done' as const),
        guard,
      ])
      assert.equal(collected, 'done')
    } finally {
      clearTimeout(timer)
    }
    assert.deepEqual(await listProjectAssets('default', { projectId: null }), [])
  })

  it('sends the source mtime as capturedAt with each version copy', async () => {
    const file = join(roots.generated, 'dated.md')
    await writeFile(file, 'dated')
    const when = new Date('2026-01-02T03:04:05.678Z')
    await utimes(file, when, when)
    const captured = await captureOutputVersion(`${GEN}/dated.md`, roots)
    assert.equal(captured?.capturedAt, when.getTime())
  })
})

describe('OCV5-725 — >50 MiB outputs preserve historical versions in CAS across overwrites', () => {
  it('captures two >50 MiB versions at the same path and enforces the large-file CAS quota', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-asset-large-'))
    const ENV = { OPENCLAUDE_V3_MASTER_BASE_URL: 'http://127.0.0.1:18799', OPENCLAUDE_V3_CONTAINER_TOKEN: 'tok' }
    const roots = {
      generated: join(dir, 'generated'),
      cas: join(dir, 'uploads'),
      largeVersionQuotaBytes: 120 * 1024 * 1024,
    }
    await mkdir(roots.generated, { recursive: true })
    await mkdir(roots.cas, { recursive: true })
    const posted: OutputAssetRegistration[] = []
    const fetcher = (async (_url: string, init?: { body?: string }) => {
      if (init?.body) posted.push(JSON.parse(init.body) as OutputAssetRegistration)
      return { statusCode: 200, body: { text: async () => '{}' } }
    }) as any

    try {
      const target = join(roots.generated, 'archive.bin')
      const size52M = 52 * 1024 * 1024
      await writeFile(target, 'v1-header-')
      await truncate(target, size52M)
      await collectSessionOutputAssets({
        userId: '3',
        sessionId: 'sess-725',
        assistantText: 'round 1 /home/agent/.openclaude/generated/archive.bin',
        env: ENV,
        outputRoots: roots,
        spoolFile: join(dir, 'spool.jsonl'),
        fetcher,
      })

      await writeFile(target, 'v2-header-different-')
      await truncate(target, size52M)
      await collectSessionOutputAssets({
        userId: '3',
        sessionId: 'sess-725',
        assistantText: 'round 2 /home/agent/.openclaude/generated/archive.bin',
        env: ENV,
        outputRoots: roots,
        spoolFile: join(dir, 'spool.jsonl'),
        fetcher,
      })

      assert.equal(posted.length, 2)
      const v1 = posted[0]!.items[0]!
      const v2 = posted[1]!.items[0]!
      assert.ok(v1.digest && v1.url)
      assert.ok(v2.digest && v2.url)
      assert.notEqual(v1.digest, v2.digest)
      const casV1 = await open(join(roots.cas, `${v1.digest}.bin`), 'r')
      const casV2 = await open(join(roots.cas, `${v2.digest}.bin`), 'r')
      try {
        const b1 = Buffer.alloc(10)
        const b2 = Buffer.alloc(10)
        await casV1.read(b1, 0, 10, 0)
        await casV2.read(b2, 0, 10, 0)
        assert.equal(b1.toString('utf8'), 'v1-header-')
        assert.equal(b2.toString('utf8'), 'v2-header-')
      } finally {
        await casV1.close()
        await casV2.close()
      }

      await writeFile(target, 'v3-header-over-quota-')
      await truncate(target, size52M)
      await collectSessionOutputAssets({
        userId: '3',
        sessionId: 'sess-725',
        assistantText: 'round 3 /home/agent/.openclaude/generated/archive.bin',
        env: ENV,
        outputRoots: roots,
        spoolFile: join(dir, 'spool.jsonl'),
        fetcher,
      })
      assert.equal(posted.length, 3)
      assert.equal(posted[2]!.items[0]!.digest, undefined)
      assert.equal(posted[2]!.items[0]!.size, size52M)

      // Concurrent copies into a fresh CAS with a 90 MiB quota: two 52 MiB files
      // raced in parallel must serialize so only one publishes to CAS.
      const raceCas = join(dir, 'cas-race')
      await mkdir(raceCas, { recursive: true })
      const f1 = join(roots.generated, 'race-a.bin')
      const f2 = join(roots.generated, 'race-b.bin')
      await writeFile(f1, 'race-a-')
      await truncate(f1, size52M)
      await writeFile(f2, 'race-b-')
      await truncate(f2, size52M)
      const raceRoots = {
        generated: roots.generated,
        cas: raceCas,
        largeVersionQuotaBytes: 90 * 1024 * 1024,
      }
      const [r1, r2] = await Promise.all([
        captureOutputVersion('/home/agent/.openclaude/generated/race-a.bin', raceRoots),
        captureOutputVersion('/home/agent/.openclaude/generated/race-b.bin', raceRoots),
      ])
      const publishedCount = [r1, r2].filter((r) => Boolean(r?.digest)).length
      assert.equal(publishedCount, 1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
