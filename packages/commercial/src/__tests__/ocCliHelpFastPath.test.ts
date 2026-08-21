import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const BIN_DIR = join(REPO_ROOT, 'packages/commercial/agent-sandbox/platform-runtime/bin')

const TSX_WRAPPERS = [
  'oc-cite.sh',
  'oc-connect.sh',
  'oc-figcheck.sh',
  'oc-ingest.sh',
  'oc-ocr.sh',
  'oc-lit.sh',
  'oc-litrag.sh',
  'oc-market.sh',
  'oc-memory.sh',
  'oc-plugin.sh',
  'oc-poster.sh',
  'oc-rank.sh',
  'oc-report.sh',
  'oc-skill.sh',
  'oc-slides.sh',
  'oc-task.sh',
  'oc-vision.sh',
  'oc-web.sh',
] as const

describe('oc-* --help fast path', () => {
  test('tsx wrappers print usage on stdout in-process without starting tsx', () => {
    const present = new Set(readdirSync(BIN_DIR))
    for (const file of TSX_WRAPPERS) {
      assert.ok(present.has(file), `${file} missing`)
      const started = Date.now()
      const result = spawnSync('bash', [join(BIN_DIR, file), '--help'], {
        encoding: 'utf8',
        timeout: 2000,
        env: { ...process.env, PATH: '/usr/bin:/bin' },
      })
      const ms = Date.now() - started
      assert.equal(result.status, 0, `${file}: exit ${result.status}\n${result.stderr}`)
      assert.match(result.stdout, /usage:|Usage:/i, `${file}: usage on stdout`)
      assert.equal(result.stderr ?? '', '', `${file}: stderr must be empty`)
      assert.ok(ms < 500, `${file}: --help took ${ms}ms; tsx probably still started`)
      assert.doesNotMatch(readFileSync(join(BIN_DIR, file), 'utf8'), /npx tsx.*--help/)
    }
  })

  test('oc-web-context --help is a real usage line, not unknown-op JSON', () => {
    const result = spawnSync('python3', [join(BIN_DIR, 'oc-web-context.py'), '--help'], {
      encoding: 'utf8',
      timeout: 2000,
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /oc-web-context/)
    assert.doesNotMatch(result.stdout, /unknown op/)
  })

  test('oc-xlsx --help does not import openpyxl', () => {
    const result = spawnSync('python3', [join(BIN_DIR, 'oc-xlsx.py'), '--help'], {
      encoding: 'utf8',
      timeout: 2000,
      env: { ...process.env, PYTHONPATH: '/nonexistent-openpyxl-on-purpose' },
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /oc-xlsx/)
  })
})
