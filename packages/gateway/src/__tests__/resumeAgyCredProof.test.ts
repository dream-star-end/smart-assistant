/**
 * Unit-suite run of the OCV5-556 release proof (also executed by the pinned
 * selfhost release gate, scripts/check-v5-box-success-recovery.ts).
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/resumeAgyCredProof.test.ts
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { proveResumeAgyCred, RESUME_AGY_CRED_PROOF } from './resumeAgyCredProof.js'

test('OCV5-556 release proof passes on the candidate code', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'oc-agy-cred-proof-'))
  const previousHome = process.env.OPENCLAUDE_HOME
  process.env.OPENCLAUDE_HOME = root
  try {
    assert.equal(proveResumeAgyCred(), RESUME_AGY_CRED_PROOF)
  } finally {
    if (previousHome === undefined) Reflect.deleteProperty(process.env, 'OPENCLAUDE_HOME')
    else process.env.OPENCLAUDE_HOME = previousHome
    await rm(root, { recursive: true, force: true })
  }
})
