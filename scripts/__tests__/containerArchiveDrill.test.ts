import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertOwnedProof } from '../ocv5-605/container-archive-drill.js'

test('Docker proof mutation guard requires exact full id, private name, ticket and uid labels', () => {
  const id = 'a'.repeat(64)
  const runId = '123abc'
  const own = {
    Id: id,
    Name: `/ocv5-605-proof-${runId}-normal`,
    Config: { Labels: { 'ocv5-605-proof': runId, 'proof-ticket': 'OCV5-605', 'proof-uid': '765' } },
    State: { Running: false, Pid: 0, ExitCode: 0, OOMKilled: false },
  }
  assert.doesNotThrow(() => assertOwnedProof(own, id, runId))
  for (const unsafe of [
    { ...own, Id: 'b'.repeat(64) },
    { ...own, Name: '/oc-v5-u765' },
    { ...own, Config: { Labels: { ...own.Config.Labels, 'proof-uid': '247' } } },
    { ...own, Config: { Labels: { ...own.Config.Labels, 'proof-ticket': 'OTHER' } } },
    { ...own, Config: { Labels: { ...own.Config.Labels, 'oc.user_id': '765' } } },
  ])
    assert.throws(() => assertOwnedProof(unsafe, id, runId))
  assert.throws(() => assertOwnedProof(own, id.slice(0, 12), runId))
})
