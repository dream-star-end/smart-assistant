import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const testHome = await mkdtemp(join(tmpdir(), 'oc-context-notice-'))
process.env.OPENCLAUDE_HOME = testHome

const {
  closeSessionsDb,
  getMaxTurnIdx,
  hasPersistedTurnActivity,
  reserveTurnIndex,
} = await import('../../../storage/src/sessionsDb.js')
const { SessionManager } = await import('../sessionManager.js')

function makeConfigStub() {
  return {
    version: 1,
    gateway: { bind: '127.0.0.1', port: 0, accessToken: '' },
    auth: { mode: 'subscription', claudeCodePath: '' },
    sessions: { dbPath: '' },
    defaults: { model: 'gpt-5.6-sol' },
  } as any
}

function makeManager() {
  const sm = new SessionManager(makeConfigStub())
  const internals = sm as any
  internals._saveResumeMap = () => {}
  internals._resumeMap.clear()
  internals._resumeMapTimestamps.clear()
  internals._resumeMapProvider.clear()
  internals._resumeMapLastCost.clear()
  return sm
}

const agent = { id: 'main', model: 'gpt-5.6-sol' } as any

after(async () => {
  await closeSessionsDb()
  await rm(testHome, { recursive: true, force: true })
})

test('switching an untouched default-engine prewarm to Cursor creates no rebuild notice', async () => {
  const sm = makeManager()
  const key = 'agent:main:webchat:dm:fresh-prewarm-cursor'
  const prewarmed = await sm.getOrCreate({
    sessionKey: key,
    agent,
    channel: 'webchat',
    peerId: 'fresh-prewarm-cursor',
    model: 'gpt-5.6-sol',
  })
  assert.equal(prewarmed.turns, 0)
  assert.equal(await hasPersistedTurnActivity([key]), false)

  const cursor = await sm.getOrCreate({
    sessionKey: key,
    agent,
    channel: 'webchat',
    peerId: 'fresh-prewarm-cursor',
    model: 'cursor-grok-4.6-high',
  })

  assert.equal(cursor.providerTag, 'cursor')
  assert.equal(cursor._contextRebuildNotice, undefined)
})

test('a durable turn reservation preserves the switch notice before async FTS indexing', async () => {
  const sm = makeManager()
  const key = 'agent:main:webchat:dm:reserved-pre-fts-cursor'
  const prewarmed = await sm.getOrCreate({
    sessionKey: key,
    agent,
    channel: 'webchat',
    peerId: 'reserved-pre-fts-cursor',
    model: 'gpt-5.6-sol',
  })
  assert.equal(prewarmed.turns, 0)

  assert.equal(await reserveTurnIndex(key), 1)
  assert.equal(await getMaxTurnIdx([key]), 0, 'the async FTS projection is intentionally absent')
  assert.equal(await hasPersistedTurnActivity([key]), true)

  const cursor = await sm.getOrCreate({
    sessionKey: key,
    agent,
    channel: 'webchat',
    peerId: 'reserved-pre-fts-cursor',
    model: 'cursor-grok-4.6-high',
  })

  assert.equal(cursor.providerTag, 'cursor')
  assert.equal(cursor._contextRebuildNotice, 'engine-switch')
})
