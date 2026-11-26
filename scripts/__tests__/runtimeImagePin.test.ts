import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  RUNTIME_IMAGE_PIN_PATH,
  loadRuntimeImagePin,
  validateRuntimeImagePin,
} from '../lib/runtimeImagePin.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

describe('runtimeImagePin', () => {
  test('live deploy/v5/runtime-image-pin.json is valid and matches deploy-v5-selfhost.sh', () => {
    const pin = loadRuntimeImagePin(repoRoot)
    assert.equal(pin.schemaVersion, 1)
    assert.equal(pin.channel, 'v5-selfhost')
    assert.ok(pin.runtimeImage.startsWith('openclaude/openclaude-runtime:'))
    assert.equal(pin.cliVersions.claudeCode, '2.1.332')
    assert.equal(pin.cliVersions.codex, '0.172.0')
    assert.equal(pin.cliVersions.grok, '1.0.92')
    assert.equal(pin.cliVersions.cursor, '2026.11.22')
    assert.equal(pin.cliVersions.antigravity, '1.5.18')

    // Parity check with current scripts/deploy-v5-selfhost.sh authoritative RUNTIME_IMAGE line
    const deploySh = readFileSync(path.join(repoRoot, 'scripts/deploy-v5-selfhost.sh'), 'utf8')
    const m = deploySh.match(/^RUNTIME_IMAGE="([^"]+)"/m)
    assert.ok(m, 'scripts/deploy-v5-selfhost.sh should define RUNTIME_IMAGE')
    assert.equal(pin.runtimeImage, m[1])
  })

  test('rejects :latest, untrusted image prefix, shell metacharacters, and invalid schema', () => {
    const base = loadRuntimeImagePin(repoRoot)

    assert.equal(
      validateRuntimeImagePin({
        ...base,
        runtimeImage: 'openclaude/openclaude-runtime:latest',
      }).ok,
      false,
    )

    assert.equal(
      validateRuntimeImagePin({
        ...base,
        runtimeImage: 'evil.registry.example/pwn/runtime:v1',
      }).ok,
      false,
    )

    assert.equal(
      validateRuntimeImagePin({
        ...base,
        runtimeImage: 'openclaude/openclaude-runtime:v1$(whoami)',
      }).ok,
      false,
    )

    assert.equal(
      validateRuntimeImagePin({
        ...base,
        schemaVersion: 2,
      }).ok,
      false,
    )

    assert.equal(
      validateRuntimeImagePin({
        ...base,
        cliVersions: {},
      }).ok,
      false,
    )

    assert.equal(
      validateRuntimeImagePin({
        ...base,
        cliVersions: { codex: '0.172.0; rm -rf /' },
      }).ok,
      false,
    )

    assert.equal(
      validateRuntimeImagePin({
        ...base,
        updatedAt: '2026-02-31',
      }).ok,
      false,
    )

    assert.equal(
      validateRuntimeImagePin({
        ...base,
        ticket: 'BAD-1',
      }).ok,
      false,
    )
  })

  test('accepts digest-pinned runtimeImage and rejects corrupt JSON file on load', () => {
    const base = loadRuntimeImagePin(repoRoot)
    const digestRef = `${base.runtimeImage}@sha256:${'a'.repeat(64)}`
    const validRes = validateRuntimeImagePin({ ...base, runtimeImage: digestRef })
    assert.equal(validRes.ok, true)

    const dir = mkdtempSync(path.join(tmpdir(), 'runtime-pin-'))
    try {
      const badFile = path.join(dir, 'bad.json')
      writeFileSync(badFile, '{ not json')
      assert.throws(() => loadRuntimeImagePin(dir, badFile), /failed to parse/)
      assert.throws(
        () => loadRuntimeImagePin(dir, RUNTIME_IMAGE_PIN_PATH),
        /runtime image pin file not found/,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
