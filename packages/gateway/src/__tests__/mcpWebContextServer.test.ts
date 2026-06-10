import * as assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { resolveSafeParseFile } from '../mcpWebContextServer.js'

async function withEnv<T>(patch: Record<string, string | undefined>, fn: () => T | Promise<T>) {
  const old = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(patch)) {
    old.set(key, process.env[key])
    if (value === undefined) Reflect.deleteProperty(process.env, key)
    else process.env[key] = value
  }
  try {
    return await fn()
  } finally {
    for (const [key, value] of old) {
      if (value === undefined) Reflect.deleteProperty(process.env, key)
      else process.env[key] = value
    }
  }
}

describe('mcpWebContextServer safe parse file resolution', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('allows a file under an existing safe root even if another configured root is missing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'oc-webctx-safe-root-'))
    dirs.push(root)
    const file = join(root, 'note.txt')
    writeFileSync(file, 'hello web context')
    await withEnv(
      { OPENCLAUDE_WEB_CONTEXT_SAFE_ROOTS: `/missing/openclaude-webctx-root:${root}` },
      () => {
        const out = resolveSafeParseFile({ file_path: file })
        assert.equal(out.filePath, file)
      },
    )
  })

  it('rejects files outside the configured safe roots', async () => {
    const root = mkdtempSync(join(tmpdir(), 'oc-webctx-safe-root-'))
    const outside = mkdtempSync(join(tmpdir(), 'oc-webctx-outside-'))
    dirs.push(root, outside)
    const file = join(outside, 'note.txt')
    writeFileSync(file, 'outside')
    await withEnv({ OPENCLAUDE_WEB_CONTEXT_SAFE_ROOTS: root }, () => {
      assert.throws(() => resolveSafeParseFile({ file_path: file }), /under uploads, generated/)
    })
  })
})
