import * as assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { parseDocument } from '../documentParser.js'

const scratch: string[] = []

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { force: true, recursive: true })))
})

async function fixture(name: string, content: string | Buffer): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'oc-document-parser-'))
  scratch.push(dir)
  const path = join(dir, name)
  await writeFile(path, content)
  return path
}

describe('parseDocument plaintext projection', () => {
  it('projects a UTF-8 text attachment into the model-visible prompt', async () => {
    const path = await fixture('probe.txt', 'OC_ATTACH_CURRENT\n')
    assert.deepEqual(await parseDocument(path, 'text/plain'), {
      markdown: 'OC_ATTACH_CURRENT\n',
      truncated: false,
      parser: 'plaintext',
    })
  })

  it('uses the .txt extension when browsers send application/octet-stream', async () => {
    const path = await fixture('probe.txt', 'fallback by extension')
    assert.equal((await parseDocument(path, 'application/octet-stream'))?.parser, 'plaintext')
  })

  it('rejects NUL and invalid UTF-8 instead of projecting binary data', async () => {
    const nul = await fixture('nul.txt', Buffer.from([0x61, 0x00, 0x62]))
    const invalid = await fixture('invalid.txt', Buffer.from([0xc3, 0x28]))
    assert.equal(await parseDocument(nul, 'text/plain'), null)
    assert.equal(await parseDocument(invalid, 'text/plain'), null)
  })

  it('does not treat an unrelated binary extension as plaintext from MIME alone', async () => {
    const path = await fixture('probe.bin', 'looks textual')
    assert.equal(await parseDocument(path, 'application/octet-stream'), null)
  })
})
