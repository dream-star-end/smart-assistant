/**
 * Output versions keep their bytes: every captured output is copied into the
 * content-addressed store before it is registered, so writing report.md twice
 * gives two downloadable versions even after the file is overwritten or deleted.
 * Run: npx tsx --test packages/gateway/src/__tests__/projectAssetOutputVersions.test.ts
 */
import * as assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, it } from 'node:test'

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
})
