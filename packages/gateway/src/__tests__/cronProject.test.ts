import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  deriveFixedBoardProjectId,
  filterCronJobsForBoard,
  normalizeCronProject,
  originSessionIdFromKey,
  resolveCronFireProject,
} from '../cronProject.js'

const OCV5 = '852859fa-cf1d-481c-96fd-23f2966b8b5f'

describe('normalizeCronProject', () => {
  it('defaults missing fields to follow_session', () => {
    assert.deepEqual(normalizeCronProject({}), {
      projectMode: 'follow_session',
      boardProjectId: null,
    })
  })
})

describe('resolveCronFireProject', () => {
  const ports = {
    async getBoardProject(id: string) {
      if (id === OCV5) return { id, archivedAt: null }
      if (id === 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee') return { id, archivedAt: 9 }
      return null
    },
    async getSessionBoardProject(sessionId: string) {
      return sessionId === 'web-live' ? OCV5 : null
    },
  }

  it('fixed missing/archived fail-closed', async () => {
    const missing = await resolveCronFireProject(
      { id: 'j', schedule: '* * * * *', agent: 'main', prompt: 'p', projectMode: 'fixed' },
      ports,
    )
    assert.equal(missing.ok, false)
    if (!missing.ok) assert.equal(missing.reason, 'fixed_project_missing')
    const archived = await resolveCronFireProject(
      {
        id: 'j',
        schedule: '* * * * *',
        agent: 'main',
        prompt: 'p',
        projectMode: 'fixed',
        boardProjectId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      },
      ports,
    )
    assert.equal(archived.ok, false)
    if (!archived.ok) assert.equal(archived.reason, 'fixed_project_archived')
  })

  it('follow_session uses current origin bind', async () => {
    const got = await resolveCronFireProject(
      {
        id: 'j',
        schedule: '* * * * *',
        agent: 'main',
        prompt: 'p',
        resume: 'origin-session',
        sourceSessionKey: 'agent:main:webchat:dm:web-live',
      },
      ports,
    )
    assert.equal(got.ok, true)
    if (got.ok) {
      assert.equal(got.mode, 'follow_session')
      assert.equal(got.boardProjectId, OCV5)
    }
  })

  it('fixed ignores later session moves', async () => {
    const got = await resolveCronFireProject(
      {
        id: 'j',
        schedule: '* * * * *',
        agent: 'main',
        prompt: 'p',
        projectMode: 'fixed',
        boardProjectId: OCV5,
        sourceSessionKey: 'agent:main:webchat:dm:web-other',
      },
      ports,
    )
    assert.equal(got.ok, true)
    if (got.ok) {
      assert.equal(got.source, 'job_fixed')
      assert.equal(got.boardProjectId, OCV5)
    }
  })
})

describe('filterCronJobsForBoard', () => {
  it('keeps follow_session jobs whose origin currently binds', async () => {
    const ports = {
      async getBoardProject(id: string) {
        return id === OCV5 ? { id, archivedAt: null } : null
      },
      async getSessionBoardProject(sessionId: string) {
        return sessionId === 'web-live' ? OCV5 : null
      },
    }
    const jobs = [
      {
        id: 'follow',
        schedule: '* * * * *',
        agent: 'main',
        prompt: 'p',
        sourceSessionKey: 'agent:main:webchat:dm:web-live',
      },
      {
        id: 'other',
        schedule: '* * * * *',
        agent: 'main',
        prompt: 'p',
        sourceSessionKey: 'agent:main:webchat:dm:web-other',
      },
    ]
    const got = await filterCronJobsForBoard(jobs, OCV5, ports)
    assert.deepEqual(got.map((j) => j.id), ['follow'])
  })
})

describe('origin + derive', () => {
  it('parses webchat origin peer id', () => {
    assert.equal(
      originSessionIdFromKey('agent:main:webchat:dm:webmt6uqcvnj6p069'),
      'webmt6uqcvnj6p069',
    )
  })
  it('deriveFixed rejects archived', async () => {
    const id = await deriveFixedBoardProjectId(
      {
        async getBoardProject() {
          return { id: OCV5, archivedAt: 1 }
        },
        async getSessionBoardProject() {
          return null
        },
      },
      OCV5,
    )
    assert.equal(id, null)
  })
})
