import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canonicalDigestHex } from '../connectors/canonicalJson.js'
import { freezePreparationRequest, validPreparationSnapshot } from '../dispatch/preparationRecovery.js'

const frame = { type: 'inbound.message',agentId: 'main',model: 'cursor-opus-5-high',contextTier: '1m',
  effortLevel: null,teamMode: true,modelSwitchId: 'switch-exact',content: { text: 'original' } }

test('snapshot freezes exact execution settings independently of mutable enrichment', () => {
  const mutable = structuredClone(frame)
  const snapshot = freezePreparationRequest(mutable)
  assert.ok(snapshot)
  const digest = canonicalDigestHex(snapshot)
  mutable.content.text = 'changed'
  mutable.contextTier = '300k'
  assert.equal((snapshot.request.content as {text: string}).text,'original')
  assert.equal(snapshot.request.contextTier,'1m')
  assert.equal(snapshot.request.effortLevel,null)
  assert.equal(snapshot.request.teamMode,true)
  assert.equal(snapshot.request.modelSwitchId,'switch-exact')
  assert.equal(validPreparationSnapshot(snapshot,digest),true)
  assert.equal(validPreparationSnapshot({...snapshot,request: {...snapshot.request,contextTier: '300k'}},digest),false)
})

test('true nested NUL opts out of retry without confusing a literal backslash-u0000', () => {
  assert.equal(freezePreparationRequest({...frame,content: {text: 'a\u0000b'}}),null)
  assert.equal(freezePreparationRequest({...frame,content: {text: 'a',replyTo: {text: '\u0000'}}}),null)
  const snapshot = freezePreparationRequest({...frame,content: {text: 'a\\u0000b'}})
  assert.ok(snapshot)
  assert.equal((snapshot.request.content as {text: string}).text,'a\\u0000b')
})

test('only platform durable media is replay eligible; remote and expiring links are not', () => {
  for (const url of ['https://example.com/a.png','blob:123','/api/media-signed?t=expiring','/api/media/..%2Fsecret']) {
    assert.equal(freezePreparationRequest({...frame,content: {media: [{kind: 'image',url}]}}),null)
  }
  assert.ok(freezePreparationRequest({...frame,content: {media: [{kind: 'image',url: '/api/media/source.png'}]}}))
})
