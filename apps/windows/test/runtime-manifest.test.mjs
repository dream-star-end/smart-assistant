import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  ManifestError,
  applyManifestEnvOverlay,
  defaultBakeManifestPath,
  loadRuntimeManifest,
  parseRuntimeManifest,
} from '../src/host/runtime/manifest.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const bakePath = path.resolve(here, '../runtime-manifest.json')

function validDoc(overrides = {}) {
  return {
    v: 1,
    engine: 'ccb',
    min_version: '1.2.3',
    keyring_fp: 'ab',
    artifacts: [
      {
        os: 'linux',
        arch: 'x64',
        url: 'https://cdn.example.test/ccb.bin',
        sha256: 'ab'.repeat(32),
        size: 12,
        version: '1.2.3',
      },
    ],
    ...overrides,
  }
}

test('bake placeholder manifest is valid JSON with engine=ccb and https urls', () => {
  const raw = fs.readFileSync(bakePath, 'utf8')
  const doc = JSON.parse(raw)
  assert.equal(doc.v, 1)
  assert.equal(doc.engine, 'ccb')
  assert.ok(Array.isArray(doc.artifacts) && doc.artifacts.length >= 1)
  for (const item of doc.artifacts) {
    assert.equal(item.url.startsWith('https://'), true)
    assert.match(item.sha256, /^[0-9a-f]{64}$/i)
  }
  assert.equal(defaultBakeManifestPath(), bakePath)
})

test('parseRuntimeManifest accepts a matching ccb artifact', () => {
  const parsed = parseRuntimeManifest(validDoc(), { expectedOs: 'linux', expectedArch: 'x64' })
  assert.equal(parsed.engine, 'ccb')
  assert.equal(parsed.selected.os, 'linux')
  assert.equal(parsed.selected.sha256, 'ab'.repeat(32))
})

test('parseRuntimeManifest rejects engine!==ccb', () => {
  assert.throws(
    () => parseRuntimeManifest(validDoc({ engine: 'cursor' })),
    (err) => err instanceof ManifestError && err.code === 'ENGINE_NOT_CCB',
  )
})

test('parseRuntimeManifest rejects non-https url', () => {
  const doc = validDoc()
  doc.artifacts[0].url = 'http://cdn.example.test/ccb.bin'
  assert.throws(
    () => parseRuntimeManifest(doc, { expectedOs: 'linux', expectedArch: 'x64' }),
    (err) => err instanceof ManifestError && err.code === 'NON_HTTPS_URL',
  )
})

test('parseRuntimeManifest rejects os/arch mismatch', () => {
  assert.throws(
    () => parseRuntimeManifest(validDoc(), { expectedOs: 'windows', expectedArch: 'arm64' }),
    (err) => err instanceof ManifestError && err.code === 'OS_ARCH_MISMATCH',
  )
})

test('parseRuntimeManifest rejects short sha256', () => {
  const doc = validDoc()
  doc.artifacts[0].sha256 = 'deadbeef'
  assert.throws(
    () => parseRuntimeManifest(doc, { expectedOs: 'linux', expectedArch: 'x64' }),
    (err) => err instanceof ManifestError && err.code === 'INVALID_SHA256',
  )
})

test('env overlay can replace url and sha256 for tests', () => {
  const parsed = parseRuntimeManifest(validDoc(), { expectedOs: 'linux', expectedArch: 'x64' })
  const over = applyManifestEnvOverlay(parsed, {
    OC_RUNTIME_ARTIFACT_URL: 'https://127.0.0.1:9/fixture.bin',
    OC_RUNTIME_ARTIFACT_SHA256: 'cd'.repeat(32),
  })
  assert.equal(over.selected.url, 'https://127.0.0.1:9/fixture.bin')
  assert.equal(over.selected.sha256, 'cd'.repeat(32))
})

test('loadRuntimeManifest reads the bake file', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-manifest-'))
  const file = path.join(tmp, 'runtime-manifest.json')
  fs.writeFileSync(file, JSON.stringify(validDoc()))
  const loaded = loadRuntimeManifest(file, { expectedOs: 'linux', expectedArch: 'x64', env: {} })
  assert.equal(loaded.selected.url, 'https://cdn.example.test/ccb.bin')
})

test('parseRuntimeManifest rejects mixed artifact origins', () => {
  assert.throws(
    () => parseRuntimeManifest({
      v: 1,
      engine: 'ccb',
      artifacts: [
        { os: 'linux', arch: 'x64', url: 'https://example.invalid/a', sha256: '0'.repeat(64) },
        { os: 'windows', arch: 'x64', url: 'https://other.invalid/a', sha256: '0'.repeat(64) },
      ],
    }, { expectedOs: 'linux', expectedArch: 'x64' }),
    (err) => err && err.code === 'ORIGIN_MISMATCH',
  )
})

test('bake placeholder artifacts share one https origin', () => {
  const parsed = loadRuntimeManifest(bakePath, { expectedOs: 'windows', expectedArch: 'x64' })
  const origin = new URL(parsed.selected.url).origin
  assert.equal(origin.startsWith('https://'), true)
  for (const item of parsed.artifacts) {
    assert.equal(new URL(item.url).origin, origin)
  }
})
