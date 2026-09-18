import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  AdvisorConfigStore,
  CollaborationConfigError,
  parseCollaborationConfigDoc,
  resolveSessionCollab,
} from '../advisorConfigStore.js'

describe('advisorConfigStore', () => {
  it('missing file reads as empty solo default', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-collab-'))
    const store = new AdvisorConfigStore(join(dir, 'collaboration-config.json'))
    const doc = store.read()
    assert.equal(doc.rev, 0)
    assert.equal(doc.defaultMode, 'solo')
    assert.equal(resolveSessionCollab(doc, 'web-1').mode, 'solo')
  })

  it('CAS putSession increments rev and does not silent-evict other sessions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-collab-'))
    const store = new AdvisorConfigStore(join(dir, 'collaboration-config.json'))
    const a = await store.putSession('web-a', { mode: 'advisor', advisorModel: 'gpt-6-astra' }, 0)
    assert.equal(a.rev, 1)
    const b = await store.putSession('web-b', { mode: 'team', advisorModel: null }, 1)
    assert.equal(b.rev, 2)
    assert.equal(b.sessions['web-a']?.mode, 'advisor')
    assert.equal(b.sessions['web-b']?.mode, 'team')
    await assert.rejects(
      () => store.putSession('web-c', { mode: 'solo', advisorModel: null }, 1),
      (err: unknown) => err instanceof CollaborationConfigError && err.code === 'CAS',
    )
    assert.equal(store.read().sessions['web-a']?.mode, 'advisor')
  })

  it('corrupt JSON fails closed and leaves the original file bytes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-collab-'))
    const file = join(dir, 'collaboration-config.json')
    await writeFile(file, '{not-json', 'utf8')
    const store = new AdvisorConfigStore(file)
    assert.throws(() => store.read(), (err: unknown) => {
      return err instanceof CollaborationConfigError && err.code === 'CORRUPT'
    })
    assert.equal(await readFile(file, 'utf8'), '{not-json')
  })

  it('putIntent asDefault does not replace an existing session save', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-collab-'))
    const store = new AdvisorConfigStore(join(dir, 'collaboration-config.json'))
    await store.putSession('web-keep', { mode: 'advisor', advisorModel: 'gpt-6-astra' }, 0)
    const next = await store.putIntent({
      sessionId: 'web-keep',
      asDefault: true,
      mode: 'team',
      advisorModel: null,
      expectedRev: 1,
    })
    assert.equal(next.rev, 2)
    assert.equal(next.defaultMode, 'team')
    assert.equal(next.sessions['web-keep']?.mode, 'team')
    const onlyDefault = await store.putIntent({
      asDefault: true,
      mode: 'solo',
      advisorModel: null,
      expectedRev: 2,
    })
    assert.equal(onlyDefault.sessions['web-keep']?.mode, 'team')
    assert.equal(onlyDefault.defaultMode, 'solo')
  })

  it('missing provenCcbModels reads as empty and markProvenCcbModel is model/provider scoped', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-collab-'))
    const file = join(dir, 'collaboration-config.json')
    await writeFile(
      file,
      JSON.stringify({
        format: 1,
        rev: 0,
        defaultMode: 'solo',
        defaultAdvisorModel: null,
        provenEngines: ['codex'],
        sessions: {},
      }),
      'utf8',
    )
    const store = new AdvisorConfigStore(file)
    const doc = store.read()
    assert.deepEqual(doc.provenCcbModels, [])
    await assert.rejects(() => store.markEngineProven('ccb'))
    const marked = await store.markProvenCcbModel({ modelId: 'MiniMax-M3', providerId: 'minimax' })
    assert.equal(marked.provenCcbModels.length, 1)
    assert.equal(marked.provenEngines.includes('ccb'), false)
    const again = await store.markProvenCcbModel({ modelId: 'MiniMax-M3', providerId: 'minimax' })
    assert.equal(again.provenCcbModels.length, 1)
    const glm = await store.markProvenCcbModel({ modelId: 'glm-5.3-zai', providerId: 'zai' })
    assert.equal(glm.provenCcbModels.length, 2)
  })

  it('putIntent without sessionId and without asDefault does not write the user default', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-collab-'))
    const store = new AdvisorConfigStore(join(dir, 'collaboration-config.json'))
    await assert.rejects(
      () =>
        store.putIntent({
          mode: 'advisor',
          advisorModel: 'gpt-6-astra',
          expectedRev: 0,
        }),
      (err: unknown) =>
        err instanceof CollaborationConfigError &&
        err.code === 'VALIDATION' &&
        /asDefault or sessionId/.test(err.message),
    )
    assert.equal(store.read().defaultMode, 'solo')
    assert.equal(store.read().rev, 0)
  })

  it('parseCollaborationConfigDoc rejects collaborationMode native field as format', () => {
    assert.throws(
      () =>
        parseCollaborationConfigDoc({
          format: 1,
          rev: 0,
          defaultMode: 'nope',
          defaultAdvisorModel: null,
          sessions: {},
        }),
      /defaultMode/,
    )
  })
})
