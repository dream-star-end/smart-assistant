import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseSystemActionReference } from '../systemActions.js'
const id = 'b5be0795-e604-45ee-bd8b-a519324b5cf4'
test('privileged action references accept only complete, exact JSON and an opaque id', () => {
  assert.deepEqual(parseSystemActionReference(JSON.stringify({ type: 'system_action', proposalId: id })), { type: 'system_action', proposalId: id })
  for (const value of [
    '{"type":"system_action","proposalId":"' + id + '",}',
    '{type:"system_action",proposalId:"' + id + '"}',
    JSON.stringify({ type: 'system_action', proposalId: id, url: '/api/me/preferences' }),
    JSON.stringify({ type: 'system_action', proposalId: id, args: { theme: 'dark' } }),
    JSON.stringify({ type: 'system_action', proposalId: 'javascript:alert(1)' }),
    JSON.stringify([{ type: 'system_action', proposalId: id }]),
    JSON.stringify({ type: 'tabs', block: { type: 'system_action', proposalId: id } }),
  ]) assert.equal(parseSystemActionReference(value), null, value)
  assert.equal(parseSystemActionReference(JSON.stringify({ type: 'system_action', proposalId: id }), false), null)
})
