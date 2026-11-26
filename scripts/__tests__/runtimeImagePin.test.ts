import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  RUNTIME_IMAGE_PIN_PATH,
  type RuntimeImagePin,
  loadRuntimeImagePin,
  validateRuntimeImagePin,
} from '../lib/runtimeImagePin.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

/**
 * Fixed historical v1 schema fixture (OCV5-903 B8):
 * Decouples schema & fallback verification from today's exact CLI versions or shell fallback
 * constants so legitimate A1 bumps to `deploy/v5/runtime-image-pin.json` never break unit tests.
 */
const HISTORICAL_PIN_FIXTURE: RuntimeImagePin = {
  schemaVersion: 1,
  channel: 'v5-selfhost',
  runtimeImage: 'openclaude/openclaude-runtime:v5-cli-historical-slim',
  previousRuntimeImage: 'openclaude/openclaude-runtime:v5-cli-prior-slim',
  ticket: 'OCV5-904',
  updatedAt: '2026-11-01',
  cliVersions: {
    claudeCode: '2.1.300',
    codex: '0.160.0',
    grok: '1.0.80',
  },
}

describe('runtimeImagePin', () => {
  test('live deploy/v5/runtime-image-pin.json satisfies schema & supply-chain invariants without hardcoding current versions', () => {
    const pin = loadRuntimeImagePin(repoRoot)
    assert.equal(pin.schemaVersion, 1)
    assert.equal(pin.channel, 'v5-selfhost')
    assert.ok(pin.runtimeImage.startsWith('openclaude/openclaude-runtime:'))
    assert.ok(!pin.runtimeImage.endsWith(':latest'))
    assert.ok(Object.keys(pin.cliVersions).length >= 1)
  })

  test('validates fixed historical schema fixture and arbitrary future A1 image/CLI pin upgrades', () => {
    const histRes = validateRuntimeImagePin(HISTORICAL_PIN_FIXTURE)
    assert.equal(histRes.ok, true)

    const futureBump: RuntimeImagePin = {
      ...HISTORICAL_PIN_FIXTURE,
      runtimeImage: 'openclaude/openclaude-runtime:v5-cli-future-20270101-slim',
      previousRuntimeImage: HISTORICAL_PIN_FIXTURE.runtimeImage,
      ticket: 'OCV5-999',
      updatedAt: '2027-01-01',
      cliVersions: {
        claudeCode: '3.0.0',
        codex: '1.2.3',
        antigravity: '2.0.0',
      },
    }
    const dir = mkdtempSync(path.join(tmpdir(), 'runtime-pin-fixture-'))
    try {
      const rel = RUNTIME_IMAGE_PIN_PATH
      mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true })
      writeFileSync(path.join(dir, rel), `${JSON.stringify(futureBump, null, 2)}\n`)
      const loaded = loadRuntimeImagePin(dir)
      assert.equal(loaded.runtimeImage, futureBump.runtimeImage)
      assert.deepEqual(loaded.cliVersions, futureBump.cliVersions)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('rejects :latest, untrusted image prefix, shell metacharacters, and invalid schema', () => {
    const base = HISTORICAL_PIN_FIXTURE

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

  test('accepts digest-pinned runtimeImage and fails closed on missing or corrupt pin file (fallback trigger)', () => {
    const base = HISTORICAL_PIN_FIXTURE
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
