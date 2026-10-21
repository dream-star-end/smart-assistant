// OCV5-556: "continuing a conversation after a few days must work". A user
// back after more than 7 days lost the native resume (resume-map idle TTL) and
// every engine fell back to a lossy history rebuild; CCB also deleted its own
// transcripts after 30 days, so a kept resume id would fail STALE_RESUME_ID.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ResumeStore } from '../resumeStore.js'
import { RESUME_MAP_INACTIVE_TTL_MS } from '../sessionManager.js'
import { buildCcbSessionSettings, CCB_TRANSCRIPT_RETENTION_DAYS } from '../subprocessRunner.js'

const DAY = 24 * 60 * 60 * 1000

test('an idle resume-map entry survives a multi-week break', () => {
  assert.equal(RESUME_MAP_INACTIVE_TTL_MS, 90 * DAY)
  const store = new ResumeStore('/dev/null')
  const now = 200 * DAY
  store.ids.set('back-after-30-days', 'conv-a')
  store.timestamps.set('back-after-30-days', now - 30 * DAY)
  store.ids.set('gone-for-100-days', 'conv-b')
  store.timestamps.set('gone-for-100-days', now - 100 * DAY)
  const pruned = store.prune(() => false, RESUME_MAP_INACTIVE_TTL_MS, now).map((p) => p.key)
  assert.deepEqual(pruned, ['gone-for-100-days'])
  assert.equal(store.ids.get('back-after-30-days'), 'conv-a')
})

test('CCB keeps its transcripts longer than the resume map keeps their ids', () => {
  assert.ok(CCB_TRANSCRIPT_RETENTION_DAYS * DAY > RESUME_MAP_INACTIVE_TTL_MS)
  assert.deepEqual(buildCcbSessionSettings(null), { cleanupPeriodDays: CCB_TRANSCRIPT_RETENTION_DAYS })
  const hooks = { hooks: { PreToolUse: [{ matcher: 'Bash|Shell', hooks: [] }] } }
  assert.deepEqual(buildCcbSessionSettings(hooks), { ...hooks, cleanupPeriodDays: CCB_TRANSCRIPT_RETENTION_DAYS })
})
