import test from 'node:test'
import assert from 'node:assert/strict'
import { SessionManager } from '../sessionManager.js'

test('explicit exact Stop retains turn fence and user reason', () => {
  const manager = Object.create(SessionManager.prototype) as SessionManager
  const seen: Array<[string, string]> = []
  ;(manager as any).sessions = new Map([['agent:main:web', {
    _currentTurnKey: 'a'.repeat(64),
  }]])
  ;(manager as any).interrupt = (key: string, reason: string) => {
    seen.push([key, reason]); return true
  }
  assert.equal(manager.interruptExact('agent:main:web', 'b'.repeat(64)), false)
  assert.equal(manager.interruptExact('agent:main:web', 'a'.repeat(64)), true)
  assert.deepEqual(seen, [['agent:main:web', 'user']])
})

test('automatic interrupt persists system origin; browser Stop persists user origin', () => {
  const manager = Object.create(SessionManager.prototype) as SessionManager
  const persisted: Array<[string, string, string]> = []
  ;(manager as any).sessions = new Map([['agent:main:web', {
    _persistActiveTurn: (status: string, text: string, code: string) => {
      persisted.push([status, text, code]); return Promise.resolve()
    }, runner: { interrupt: () => true },
  }]])
  ;(manager as any)._trackPersistence = () => {}
  assert.equal(manager.interrupt('agent:main:web'), true)
  assert.equal(manager.interrupt('agent:main:web', 'user'), true)
  assert.deepEqual(persisted.map((row) => row[2]),
    ['SYSTEM_INTERRUPT', 'USER_CANCELLED'])
})
