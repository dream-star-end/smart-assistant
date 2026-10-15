/**
 * OCV5-427: one exact-turn replay per socket and turn. A page that reloads
 * mid-turn sent a cursor hello and, right after its REST sync, a second hello
 * naming the running turn; each got its own replay and the browser worked
 * through the same frames twice before it caught up with the live tail.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { _noteActiveTurnReplayServed, _unservedActiveTurnReplay } from '../server.js'

test('OCV5-427: a socket gets the exact-turn replay once per turn', () => {
  const served = new WeakMap<object, Set<string>>()
  const socket = {}
  const key = 'agent:main:webchat:dm:s1'
  assert.equal(_unservedActiveTurnReplay(served, socket, key, 'm-user-1'), 'm-user-1')
  _noteActiveTurnReplayServed(served, socket, key, 'm-user-1')
  assert.equal(_unservedActiveTurnReplay(served, socket, key, 'm-user-1'), undefined)
})

test('OCV5-427: the replay fence is per socket, per session and per turn', () => {
  const served = new WeakMap<object, Set<string>>()
  const first = {}
  const second = {}
  _noteActiveTurnReplayServed(served, first, 'agent:main:webchat:dm:s1', 'm-user-1')
  assert.equal(_unservedActiveTurnReplay(served, second, 'agent:main:webchat:dm:s1', 'm-user-1'), 'm-user-1')
  assert.equal(_unservedActiveTurnReplay(served, first, 'agent:main:webchat:dm:s2', 'm-user-1'), 'm-user-1')
  assert.equal(_unservedActiveTurnReplay(served, first, 'agent:main:webchat:dm:s1', 'm-user-2'), 'm-user-2')
})

test('OCV5-427: no matched turn means no exact-turn replay', () => {
  assert.equal(_unservedActiveTurnReplay(new WeakMap(), {}, 'agent:main:webchat:dm:s1', undefined), undefined)
})
