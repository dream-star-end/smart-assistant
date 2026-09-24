import assert from 'node:assert/strict'
import { test } from 'node:test'
import { boxExecEgressBasis } from './boxExecBasis.js'

test('non-null bigint proxy ID is comparable and a changed binding is rejected', () => {
  const before = boxExecEgressBasis({ proxy: null, proxyId: 1n, hostUuid: null, target: null })
  const same = boxExecEgressBasis({ proxy: null, proxyId: 1n, hostUuid: null, target: null })
  const changed = boxExecEgressBasis({ proxy: null, proxyId: 2n, hostUuid: null, target: null })
  assert.equal(before, same)
  assert.notEqual(before, changed)
})
