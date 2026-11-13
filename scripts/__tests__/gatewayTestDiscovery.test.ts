import test from 'node:test'
import assert from 'node:assert/strict'
import { assertGatewayTestPartition, checkGatewayTestDiscovery } from '../check-gateway-test-discovery.js'
const targets = ['packages/gateway/src/a.test.ts', 'packages/gateway/src/b.integ.test.ts']
test('all discovered gateway targets keep unit or actual mandatory matrix execution', () => {
  assertGatewayTestPartition(targets, new Map([['pr-9', [targets[1]]]]), new Set(['pr-9']))
  checkGatewayTestDiscovery(new URL('../..', import.meta.url).pathname)
})
test('rejects unlisted, duplicate, nightly-only and unscheduled integ execution', () => {
  for (const [tiers, shards] of [
    [new Map(), new Set(['pr-9'])], [new Map([['pr-9', [targets[1]]], ['pr-8', [targets[1]]]]), new Set(['pr-9', 'pr-8'])],
    [new Map([['nightly-1', [targets[1]]]]), new Set(['nightly-1'])], [new Map([['pr-9', [targets[1]]]]), new Set()],
  ] as Array<[Map<string, string[]>, Set<string>]>) assert.throws(() => assertGatewayTestPartition(targets, tiers, shards))
})
