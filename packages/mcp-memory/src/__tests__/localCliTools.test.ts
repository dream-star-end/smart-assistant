/**
 * Run: npx tsx --test packages/mcp-memory/src/__tests__/localCliTools.test.ts
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  clampInt,
  handleOcBash,
  handleOcGlob,
  handleOcGrep,
  OC_BASH_MAX_TIMEOUT_MS,
  OC_BASH_MIN_TIMEOUT_MS,
  ocGlobArgv,
  ocGrepArgv,
  runCaptured,
} from '../localCliTools.js'

describe('clampInt', () => {
  it('falls back, floors, and clamps', () => {
    assert.equal(clampInt(undefined, 60_000, OC_BASH_MIN_TIMEOUT_MS, OC_BASH_MAX_TIMEOUT_MS), 60_000)
    assert.equal(clampInt('nope', 60_000, 1_000, 180_000), 60_000)
    assert.equal(clampInt(500, 60_000, 1_000, 180_000), 1_000)
    assert.equal(clampInt(999_999, 60_000, 1_000, 180_000), 180_000)
    assert.equal(clampInt(1500.9, 60_000, 1_000, 180_000), 1500)
  })
})

describe('rg argv', () => {
  it('oc_grep puts the pattern after -- and never shells it', () => {
    assert.deepEqual(
      ocGrepArgv('/usr/bin/rg', { pattern: '-n', path: 'src', glob: '*.ts', maxMatches: 80 }),
      ['/usr/bin/rg', '--line-number', '--no-heading', '--color', 'never', '--max-count', '80', '--glob', '*.ts', '--', '-n', 'src'],
    )
  })

  it('oc_glob uses --files and skips .git', () => {
    assert.deepEqual(
      ocGlobArgv('/usr/bin/rg', { pattern: '*.ts', path: 'src' }),
      ['/usr/bin/rg', '--files', '--hidden', '--iglob', '*.ts', '--glob', '!.git/**', '--color', 'never', 'src'],
    )
    assert.deepEqual(
      ocGlobArgv('/usr/bin/rg', { pattern: '*.ts' }).includes('src'),
      false,
    )
  })
})

describe('oc_bash', () => {
  it('rejects an empty command', async () => {
    const result = await handleOcBash({ command: '   ' })
    assert.equal(result.isError, true)
    assert.match(result.content[0]!.text, /command/)
  })

  it('returns stdout and exit=0 for a short command', async () => {
    const result = await handleOcBash({ command: 'echo hello-oc-bash' })
    assert.equal(result.isError, undefined)
    assert.match(result.content[0]!.text, /exit=0/)
    assert.match(result.content[0]!.text, /hello-oc-bash/)
  })

  it('reports a non-zero exit in the text without a protocol error', async () => {
    const result = await handleOcBash({ command: 'exit 7' })
    assert.equal(result.isError, undefined)
    assert.match(result.content[0]!.text, /exit=7/)
  })

  it('kills a sleep that outlives the timeout', async () => {
    const started = Date.now()
    const result = await handleOcBash({ command: 'sleep 30', timeout_ms: 1000 })
    const elapsed = Date.now() - started
    assert.equal(result.isError, true)
    assert.match(result.content[0]!.text, /timed out/)
    assert.ok(elapsed < 8_000, `elapsed ${elapsed}ms`)
  })
})

describe('runCaptured truncation', () => {
  it('caps output and still lets the writer exit', async () => {
    const outcome = await runCaptured({
      bin: '/bin/bash',
      args: ['-lc', "printf '%200000s' '' | tr ' ' x"],
      timeoutMs: 8_000,
      maxBytes: 1024,
    })
    assert.equal(outcome.timedOut, false)
    assert.equal(outcome.truncated, true)
    assert.equal(outcome.exitCode, 0)
    assert.ok(outcome.stdout.length <= 1024)
  })
})

describe('oc_grep / oc_glob', () => {
  it('returns rg hits and no-match text', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-cli-'))
    writeFileSync(join(dir, 'note.ts'), 'export const needle = 1\n')
    const hit = await handleOcGrep({ pattern: 'needle', path: dir })
    assert.equal(hit.isError, undefined)
    assert.match(hit.content[0]!.text, /needle/)
    const miss = await handleOcGrep({ pattern: 'not-in-file-xyz', path: dir })
    assert.equal(miss.isError, undefined)
    assert.equal(miss.content[0]!.text, 'no matches')
    const files = await handleOcGlob({ pattern: 'note.ts', path: dir })
    assert.equal(files.isError, undefined)
    assert.match(files.content[0]!.text, /note\.ts/)
  })

  it('errors when rg is missing', async () => {
    const result = await handleOcGrep({ pattern: 'x' }, { rgBin: null })
    assert.equal(result.isError, true)
    assert.match(result.content[0]!.text, /找不到 rg/)
    const globbed = await handleOcGlob({ pattern: '*.ts' }, { rgBin: null })
    assert.equal(globbed.isError, true)
    assert.match(globbed.content[0]!.text, /找不到 rg/)
  })
})
