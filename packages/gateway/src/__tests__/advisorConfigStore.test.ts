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
