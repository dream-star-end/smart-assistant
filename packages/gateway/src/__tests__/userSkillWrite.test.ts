/**
 * Run: npx tsx --test packages/gateway/src/__tests__/userSkillWrite.test.ts
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { saveUserSkill } from '../userSkillWrite.js'

function fakeStore() {
  const skills = new Map<string, string>()
  return {
    skills,
    async view(name: string) {
      await new Promise((r) => setTimeout(r, 5))
      return skills.has(name) ? { name } : null
    },
    async save(meta: { name: string }, body: string) {
      await new Promise((r) => setTimeout(r, 5))
      skills.set(meta.name, body)
      return { ok: true }
    },
  }
}

describe('saveUserSkill', () => {
  test('create-only refuses an existing name and leaves it untouched', async () => {
    const store = fakeStore()
    store.skills.set('weekly', 'original')
    const r = await saveUserSkill(store, { name: 'weekly', description: '', body: 'new' }, { createOnly: true })
    assert.deepEqual(r, { status: 'exists' })
    assert.equal(store.skills.get('weekly'), 'original')
  })

  test('two concurrent creates of one name: exactly one wins, the other is refused', async () => {
    const store = fakeStore()
    const [a, b] = await Promise.all([
      saveUserSkill(store, { name: 'weekly', description: '', body: 'tab A' }, { createOnly: true }),
      saveUserSkill(store, { name: 'weekly', description: '', body: 'tab B' }, { createOnly: true }),
    ])
    assert.deepEqual([a.status, b.status], ['saved', 'exists'])
    assert.equal(store.skills.get('weekly'), 'tab A')
  })

  test('a plain save still overwrites (the editor path)', async () => {
    const store = fakeStore()
    store.skills.set('weekly', 'v1')
    const r = await saveUserSkill(store, { name: 'weekly', description: '', body: 'v2' }, { createOnly: false })
    assert.equal(r.status, 'saved')
    assert.equal(store.skills.get('weekly'), 'v2')
  })
})
