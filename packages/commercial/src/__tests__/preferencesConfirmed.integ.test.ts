/** Real PG CAS in a new private schema. Never reset shared tables or use a product account. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'
import { Pool } from 'pg'
import { setPoolOverride, closePool } from '../db/index.js'
import { getVersionedPreferences, patchPreferences, PreferencesError } from '../user/preferences.js'
const target = new URL(process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/openclaude_test')
if (!['127.0.0.1', 'localhost'].includes(target.hostname) || !target.pathname.endsWith('_test')) throw new Error('isolated local test database required')
const schema = `oc_system_prefs_${randomUUID().replaceAll('-', '')}`
const admin = new Pool({ connectionString: target.toString(), max: 1 })
const pool = new Pool({ connectionString: target.toString(), max: 6, options: `-c search_path=${schema}` })
before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`)
  await pool.query('CREATE TABLE user_preferences (user_id bigint PRIMARY KEY, prefs jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())')
  await pool.query("CREATE TABLE users (id bigint PRIMARY KEY, role text NOT NULL, status text NOT NULL)")
  await pool.query("INSERT INTO users VALUES (765, 'user', 'active')")
  setPoolOverride(pool)
})
after(async () => {
  await closePool()
  // Retain the uniquely named proof schema; no task code deletes remote data.
  await admin.end()
})
const conflict = (e: unknown) => e instanceof PreferencesError && e.code === 'CONFLICT'
test('pure read does not initialize preferences, and an intervening first writer invalidates missing', async () => {
  const initial = await getVersionedPreferences('765')
  assert.equal(initial.version, 'missing')
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM user_preferences')).rows[0].n, 0)
  await patchPreferences('765', { theme: 'dark' })
  await assert.rejects(patchPreferences('765', { theme: 'light' }, initial.version), conflict)
  assert.equal((await getVersionedPreferences('765')).prefs.theme, 'dark')
})
test('two approvals of the same existing snapshot commit exactly one preference mutation', async () => {
  const snapshot = await getVersionedPreferences('765')
  const outcomes = await Promise.allSettled([
    patchPreferences('765', { theme: 'light' }, snapshot.version),
    patchPreferences('765', { theme: 'auto' }, snapshot.version),
  ])
  assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal(outcomes.filter(r => r.status === 'rejected' && conflict(r.reason)).length, 1)
})
test('two approvals racing to create an absent row never silently overwrite one another', async () => {
  await pool.query('DELETE FROM user_preferences WHERE user_id=$1', ['765'])
  const outcomes = await Promise.allSettled([
    patchPreferences('765', { theme: 'dark' }, 'missing'),
    patchPreferences('765', { theme: 'light' }, 'missing'),
  ])
  assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal(outcomes.filter(r => r.status === 'rejected' && conflict(r.reason)).length, 1)
})
test('a deleted or recreated tuple cannot be resurrected by an old approval', async () => {
  const snapshot = await getVersionedPreferences('765')
  await pool.query('DELETE FROM user_preferences WHERE user_id=$1', ['765'])
  await assert.rejects(patchPreferences('765', { theme: 'dark' }, snapshot.version), conflict)
  assert.equal((await getVersionedPreferences('765')).version, 'missing')
  await patchPreferences('765', { notify_email: false })
  await assert.rejects(patchPreferences('765', { notify_email: true }, snapshot.version), conflict)
  assert.equal((await getVersionedPreferences('765')).prefs.notify_email, false)
})

test('the approved writer atomically checks current role and active status', async () => {
  let snapshot = await getVersionedPreferences('765')
  await patchPreferences('765', { theme: 'light' }, snapshot.version, 'user')
  snapshot = await getVersionedPreferences('765')
  await pool.query("UPDATE users SET role='admin' WHERE id=765")
  await assert.rejects(patchPreferences('765', { theme: 'dark' }, snapshot.version, 'user'), conflict)
  assert.equal((await getVersionedPreferences('765')).prefs.theme, 'light')
  await pool.query("UPDATE users SET role='user',status='disabled' WHERE id=765")
  await assert.rejects(patchPreferences('765', { theme: 'dark' }, snapshot.version, 'user'), conflict)
  assert.equal((await getVersionedPreferences('765')).prefs.theme, 'light')
  await pool.query("UPDATE users SET status='active' WHERE id=765")
})
