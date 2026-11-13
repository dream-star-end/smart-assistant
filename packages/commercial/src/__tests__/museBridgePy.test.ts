// Runs the Muse bridge's own Python suite (stub media-generation + mock master) in CI.
// The bridge ships to the Muse VM as a single file; this keeps it covered here (OCV5-561).

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const BRIDGE_DIR = join(REPO_ROOT, 'packages/commercial/muse-bridge')

test('muse bridge python suite passes', { timeout: 300_000 }, () => {
  const work = mkdtempSync(join(tmpdir(), 'muse-python-'))
  try {
    const r = spawnSync(
      'python3',
      ['-I', '-W', 'ignore', join(BRIDGE_DIR, 'tests/test_muse_bridge.py')],
      {
        encoding: 'utf8',
        timeout: 280_000,
        env: { ...process.env, TMPDIR: work, MUSE_BRIDGE_PATH: join(BRIDGE_DIR, 'muse_bridge.py') },
      },
    )
    assert.equal(r.status, 0, `${r.stdout ?? ''}\n${r.stderr ?? ''}`.slice(-6000))
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})
