// OCV5-447: the watch behaviour gate has one list, used by both the train and PR CI.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const runner = path.join(root, 'scripts/v5-selfhost-watch-gate.sh')

function list(): string[] {
  const r = spawnSync('bash', [runner, '--list'], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout.trim().split('\n')
}

describe('selfhost watch gate list', () => {
  test('lists the ten watch/autorecover behaviour tests, all present', () => {
    const names = list()
    assert.equal(names.length, 10, names.join(','))
    assert.equal(new Set(names).size, names.length)
    for (const n of names) {
      assert.match(
        n,
        /^v5-selfhost-[a-z0-9-]+\.(test|selftest)\.sh$|^v5-selfhost-watch-selftest\.sh$/,
      )
      assert.ok(existsSync(path.join(root, 'scripts', n)), n)
    }
  })

  test('the train runs the runner and keeps no list of its own', () => {
    const lib = readFileSync(path.join(root, 'scripts/v5-selfhost-master-release-lib.sh'), 'utf8')
    assert.match(
      lib,
      /bash scripts\/v5-selfhost-watch-gate\.sh \\\n\s+--log-dir "\$MASTER_GATE_TMPDIR\/watch-gate"/,
    )
    for (const n of list()) {
      assert.equal(lib.includes(n), false, `master-release-lib still names ${n}`)
    }
  })

  test('PR CI runs the same runner', () => {
    const wf = readFileSync(path.join(root, '.github/workflows/v5-selfhost-gates.yml'), 'utf8')
    assert.match(wf, /run: bash scripts\/v5-selfhost-watch-gate\.sh --log-dir/)
  })

  test('unknown arguments are a usage error (exit 2)', () => {
    const r = spawnSync('bash', [runner, '--bogus'], { encoding: 'utf8' })
    assert.equal(r.status, 2)
    const noDir = spawnSync('bash', [runner, '--log-dir'], { encoding: 'utf8', timeout: 5000 })
    assert.equal(noDir.status, 2)
  })
})
