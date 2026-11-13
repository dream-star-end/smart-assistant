import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const built = spawnSync(process.execPath, [path.join(root, 'scripts/lib/build-v5-bootstrap-validator.mjs')], {
  cwd: root, encoding: 'utf8', timeout: 30_000,
})
assert.equal(built.status, 0, built.stderr)
const [digest, compressed] = built.stdout.trim().split(' ')
const bytes = gunzipSync(Buffer.from(compressed, 'base64'))
assert.equal(createHash('sha256').update(bytes).digest('hex'), digest)
const dir = mkdtempSync(path.join(tmpdir(), 'v5-bootstrap-schema-'))
const validator = path.join(dir, 'validator.cjs')
writeFileSync(validator, bytes, { mode: 0o600 })
after(() => rmSync(dir, { recursive: true, force: true }))

const base: Record<string, string> = {
  DATABASE_URL: 'postgresql://fixture:fixture@127.0.0.1:55432/openclaude_test',
  REDIS_URL: 'redis://127.0.0.1:56379',
  COMMERCIAL_ENABLED: '1', OC_RUNTIME_CHANNEL: 'v5',
  OC_RUNTIME_IMAGE: 'openclaude/runtime:fixture',
  COMMERCIAL_JWT_SECRET: 'j'.repeat(32),
  OC_EGRESS_SPLIT: '1', INTERNAL_CONTROL_BIND: '127.0.0.1',
  INTERNAL_CONTROL_PORT: '18894', OC_EGRESS_SECRET: 'e'.repeat(32),
}
function run(change: Record<string, string | undefined>) {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, ...base }
  for (const [key, value] of Object.entries(change)) {
    if (value === undefined) delete env[key]
    else env[key] = value
  }
  return spawnSync(process.execPath, [validator], { env, encoding: 'utf8', timeout: 10_000 })
}
test('candidate bytes are SHA bound and gzip payload fits one SSH argument', () => {
  assert.match(digest, /^[0-9a-f]{64}$/)
  assert.ok(Buffer.byteLength(compressed) < 120_000)
  const changed = Buffer.from(bytes)
  changed[0] ^= 1
  assert.notEqual(createHash('sha256').update(changed).digest('hex'), digest)
})
test('complete official bootstrap config passes without optional OAuth/payment credentials', () => {
  assert.equal(run({}).status, 0)
})
for (const [name, changes] of [
  ['JWT missing', { COMMERCIAL_JWT_SECRET: undefined }],
  ['JWT too short', { COMMERCIAL_JWT_SECRET: 'short' }],
  ['Redis missing', { REDIS_URL: undefined }],
  ['control bind missing', { INTERNAL_CONTROL_BIND: undefined }],
  ['control port missing', { INTERNAL_CONTROL_PORT: undefined }],
  ['egress secret missing', { OC_EGRESS_SECRET: undefined }],
  ['wrong runtime channel', { OC_RUNTIME_CHANNEL: 'v3' }],
  ['runtime image missing', { OC_RUNTIME_IMAGE: undefined }],
  ['non-split first install', { OC_EGRESS_SPLIT: '0' }],
  ['production dangerous flag despite dev shell', { NODE_ENV: 'development', TURNSTILE_TEST_BYPASS: '1' }],
] as Array<[string, Record<string, string | undefined>]>) {
  test('official bootstrap rejects ' + name, () => {
    const out = run(changes)
    assert.equal(out.status, 79, out.stderr)
    assert.match(out.stderr, /incomplete or invalid/)
    assert.ok(!out.stderr.includes(base.COMMERCIAL_JWT_SECRET))
    assert.ok(!out.stderr.includes(base.OC_EGRESS_SECRET))
  })
}
test('JWT fallback uses the same runtime selection contract', () => {
  assert.equal(run({ COMMERCIAL_JWT_SECRET: undefined, JWT_SECRET: 'f'.repeat(32) }).status, 0)
})
