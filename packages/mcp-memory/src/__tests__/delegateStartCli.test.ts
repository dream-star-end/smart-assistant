import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  buildDelegateStartBody,
  readDelegateContextToken,
  requestReviewArgs,
  runDelegateStartAndWait,
} from '../delegateStartCli.js'

describe('delegateStartCli', () => {
  it('refuses missing context file instead of falling back to env identity', () => {
    const r = readDelegateContextToken({})
    assert.equal(r.ok, false)
    if (!r.ok) assert.match(r.error, /OPENCLAUDE_DELEGATE_CONTEXT_FILE/)
  })

  it('reads the opaque token from the context file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dlg-ctx-'))
    try {
      const file = join(dir, 'delegate-context')
      writeFileSync(file, '  tok-abc  \n')
      const r = readDelegateContextToken({ OPENCLAUDE_DELEGATE_CONTEXT_FILE: file })
      assert.equal(r.ok, true)
      if (r.ok) assert.equal(r.token, 'tok-abc')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('start body is async+streamProgress and omits sourceAgent/parentSessionKey/depth', () => {
    const body = buildDelegateStartBody({
      agentId: 'auditor',
      goal: '审方案',
      context: 'ctx',
      model: 'gpt-5.6-sol',
    })
    assert.equal(body.async, true)
    assert.equal(body.streamProgress, true)
    assert.equal(body.goal, '审方案')
    assert.equal(Object.hasOwn(body, 'sourceAgent'), false)
    assert.equal(Object.hasOwn(body, 'parentSessionKey'), false)
    assert.equal(Object.hasOwn(body, 'depth'), false)
  })

  it('start+wait: one start then wait loop until done', async () => {
    let starts = 0
    const r = await runDelegateStartAndWait({
      args: { agentId: 'auditor', goal: '审' },
      contextToken: 'tok',
      pollWaitMs: 20,
      start: async (agentId, body, token) => {
        starts += 1
        assert.equal(agentId, 'auditor')
        assert.equal(token, 'tok')
        assert.match(body, /"async":true/)
        return {
          statusCode: 200,
          body: JSON.stringify({ status: 'running', jobId: 'dlgjob-1', sessionKey: 'sk' }),
        }
      },
      waitOnce: async () => ({
        statusCode: 200,
        body: JSON.stringify({
          status: 'done',
          jobId: 'dlgjob-1',
          httpStatus: 200,
          ok: true,
          output: '审查 PASS',
        }),
      }),
    })
    assert.equal(starts, 1)
    assert.equal(r.exitCode, 0)
    assert.match(r.stdout, /审查 PASS/)
  })

  it('request-review wraps hidden-reviewer and keeps the draft in context', () => {
    const args = requestReviewArgs('草稿全文', '已按意见改')
    assert.equal(args.agentId, 'hidden-reviewer')
    assert.match(args.goal, /质量审查/)
    assert.match(args.context ?? '', /草稿全文/)
    assert.match(args.context ?? '', /队长修订说明/)
  })
})
