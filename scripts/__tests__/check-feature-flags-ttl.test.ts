import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { DEFAULT_REGISTRY_PATH, checkFeatureFlagsTtl } from '../check-feature-flags-ttl.ts'

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../check-feature-flags-ttl.ts',
)
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function makeRepo(
  t: { after(fn: () => void): void },
  registry: unknown,
  extraFiles: Record<string, string> = {},
): string {
  const root = mkdtempSync(path.join(tmpdir(), 'ff-ttl-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const regAbs = path.join(root, DEFAULT_REGISTRY_PATH)
  mkdirSync(path.dirname(regAbs), { recursive: true })
  writeFileSync(regAbs, JSON.stringify(registry, null, 2))
  for (const [rel, text] of Object.entries(extraFiles)) {
    const abs = path.join(root, rel)
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, text)
  }
  return root
}

describe('check-feature-flags-ttl', () => {
  test('GREEN: valid active temporary and permanent flags pass cleanly', (t) => {
    const root = makeRepo(t, {
      schema: 1,
      flags: [
        {
          name: 'OC_FLAG_TEMP_ROLLOUT',
          owner: '@dream-star-end',
          createdAt: '2026-11-01',
          expireAt: '2026-12-01',
          permanent: false,
          description: 'Temporary rollout flag for testing',
        },
        {
          name: 'OC_PERM_SWITCH',
          owner: '@dream-star-end',
          createdAt: '2026-11-01',
          expireAt: null,
          permanent: true,
          description: 'Permanent deployment capability switch',
        },
      ],
    })
    const r = spawnSync(
      process.execPath,
      ['--import', 'tsx', SCRIPT, '--root', root, '--today', '2026-11-22', '--fail-on-expired'],
      { encoding: 'utf8' },
    )
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /total=2 .* expired=0/)
  })

  test('WARN by default / RED with --fail-on-expired when temporary flag is expired', (t) => {
    const root = makeRepo(t, {
      schema: 1,
      flags: [
        {
          name: 'OC_FLAG_STALE',
          owner: '@dream-star-end',
          createdAt: '2026-10-01',
          expireAt: '2026-11-01',
          permanent: false,
          ticket: 'OCV5-829',
          description: 'Stale temporary flag ready for cleanup',
        },
      ],
    })
    const warnRun = spawnSync(
      process.execPath,
      ['--import', 'tsx', SCRIPT, '--root', root, '--today', '2026-11-22'],
      { encoding: 'utf8' },
    )
    assert.equal(warnRun.status, 0)
    assert.match(warnRun.stderr, /OC_FLAG_STALE expired on 2026-11-01 \(21d overdue/)

    const strictRun = spawnSync(
      process.execPath,
      ['--import', 'tsx', SCRIPT, '--root', root, '--today', '2026-11-22', '--fail-on-expired'],
      { encoding: 'utf8' },
    )
    assert.equal(strictRun.status, 1)
    assert.match(strictRun.stderr, /\[GATE-ERROR\] FEATURE-FLAG-EXPIRED/)
  })

  test('RED: invalid schema (missing expireAt on temporary flag, bad date, duplicate name) blocks', (t) => {
    const root = makeRepo(t, {
      schema: 1,
      flags: [
        {
          name: 'OC_FLAG_BAD',
          owner: '',
          createdAt: '2026-11-22',
          expireAt: null,
          permanent: false,
          description: 'short',
        },
        {
          name: 'OC_FLAG_BAD',
          owner: '@dream-star-end',
          createdAt: '2026-11-22',
          expireAt: '2026-11-01',
          permanent: false,
          description: 'expireAt earlier than createdAt',
        },
      ],
    })
    const r = spawnSync(
      process.execPath,
      ['--import', 'tsx', SCRIPT, '--root', root, '--today', '2026-11-22'],
      { encoding: 'utf8' },
    )
    assert.equal(r.status, 1)
    assert.match(r.stderr, /\[GATE-ERROR\] FEATURE-FLAG-SCHEMA/)
  })

  test('RED: unregistered OC_FLAG_* in production source fails with FEATURE-FLAG-UNREGISTERED', (t) => {
    const root = makeRepo(
      t,
      { schema: 1, flags: [] },
      { 'packages/gateway/src/feature.ts': `export const on = process.env.OC_FLAG_GHOST === '1'\n` },
    )
    const r = spawnSync(
      process.execPath,
      ['--import', 'tsx', SCRIPT, '--root', root, '--today', '2026-11-22'],
      { encoding: 'utf8' },
    )
    assert.equal(r.status, 1)
    assert.match(r.stderr, /\[GATE-ERROR\] FEATURE-FLAG-UNREGISTERED/)
    assert.match(r.stderr, /OC_FLAG_GHOST/)
  })

  test('real repository registry passes with zero schema/unregistered/expired errors (no arbitrary minimum count)', () => {
    const res = checkFeatureFlagsTtl({ root: REPO_ROOT, today: '2026-11-22' })
    assert.ok(Array.isArray(res.entries))
    assert.deepEqual(res.schemaProblems, [])
    assert.deepEqual(res.unregistered, [])
    assert.deepEqual(res.expired, [])
  })
})
