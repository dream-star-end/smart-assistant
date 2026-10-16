// OCV5-449: deploy-v5-selfhost.sh --status prints one state word per unit and
// reads spa dist / .complete from the live release, not the worktree.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const src = readFileSync(path.join(root, 'scripts/deploy-v5-selfhost.sh'), 'utf8')

function fnBody(name: string): string {
  const start = src.indexOf(`${name}() {`)
  assert.ok(start >= 0, `${name} not found`)
  return src.slice(start, src.indexOf('\n}\n', start) + 2)
}

function unitState(stub: string, args: string[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ocv5-449-'))
  try {
    writeFileSync(path.join(dir, 'systemctl'), `#!/usr/bin/env bash\n${stub}\n`)
    chmodSync(path.join(dir, 'systemctl'), 0o755)
    const r = spawnSync(
      'bash',
      [
        '-c',
        `set -euo pipefail; ${fnBody('status_unit_state')}\nstatus_unit_state "$@"`,
        'x',
        ...args,
      ],
      { env: { PATH: `${dir}:${process.env.PATH}` }, encoding: 'utf8' },
    )
    assert.equal(r.status, 0, r.stderr)
    return r.stdout
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('deploy-v5-selfhost.sh --status', () => {
  test('inactive unit: exactly one word, no appended fallback line', () => {
    assert.equal(unitState('echo inactive; exit 3', ['u.service']), 'inactive')
  })

  test('active unit: active', () => {
    assert.equal(unitState('echo active; exit 0', ['u.service']), 'active')
  })

  test('systemctl prints nothing: fallback word (default n/a)', () => {
    assert.equal(unitState('exit 1', ['u.service']), 'n/a')
    assert.equal(unitState('exit 1', ['u.service', 'inactive']), 'inactive')
  })

  test('cmd_status has no `systemctl is-active … || echo` left', () => {
    const body = fnBody('cmd_status')
    assert.equal(/systemctl is-active[^\n]*\|\| echo/.test(body), false)
    assert.ok(body.includes('status_unit_state "$V5_UNIT"'))
  })

  test('spa dist and .complete are read from the live release', () => {
    const body = fnBody('cmd_status')
    assert.ok(body.includes('"$live_now/packages/web-react/dist/index.html"'))
    assert.ok(body.includes('"$live_now/.complete"'))
    assert.equal(body.includes('"$REPO_ROOT/packages/web-react/dist/index.html"'), false)
    assert.equal(body.includes('"$REPO_ROOT/.complete"'), false)
  })
})
