import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

const lib = resolve('scripts/v5-runtime-release-lib.sh')
test('runtime cc5 child guard protects fresh/reused leaves while preserving historic rollback', () => {
  const root = mkdtempSync(join(tmpdir(), 'cc5-artifact-'))
  const pkg = join(root, 'packages/gateway')
  mkdirSync(join(pkg, 'src'), { recursive: true })
  mkdirSync(join(pkg, 'dist'), { recursive: true })
  writeFileSync(join(pkg, 'package.json'), '{"type":"module"}')
  const check = () =>
    spawnSync(
      'bash',
      ['-c', '. "$1"; oc_hotcfg_assert_runtime_cc5_bridge "$2"', 'cc5-artifact-test', lib, root],
      { encoding: 'utf8' },
    )
  try {
    assert.equal(check().status, 0, 'historic source without cc5 remains a valid rollback')
    writeFileSync(join(pkg, 'src/cc5BridgePort.ts'), '// synthetic new port')
    assert.notEqual(check().status, 0, 'partial source cannot bypass the child guard')
    writeFileSync(join(pkg, 'src/cc5StdioBridge.ts'), '// synthetic new source')
    assert.notEqual(check().status, 0, 'missing child blocks release')
    const entry = join(pkg, 'dist/cc5StdioBridge.js')
    writeFileSync(entry, '')
    assert.notEqual(check().status, 0, 'empty child blocks release')
    writeFileSync(entry, 'export ! syntax')
    assert.notEqual(check().status, 0, 'invalid child blocks release')
    writeFileSync(entry, 'export const wrong = true')
    assert.notEqual(check().status, 0, 'wrong closure blocks release')
    writeFileSync(entry, 'import "./missing.js";export function runCc5StdioBridge(){}')
    assert.notEqual(check().status, 0, 'unloadable dependency blocks release')
    writeFileSync(
      entry,
      'export function runCc5StdioBridge(){throw new Error("must never launch at import")}',
    )
    assert.equal(check().status, 0, 'valid independent import performs no worker launch')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
