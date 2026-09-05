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

  it('allowSelf:true 出现在 body', () => {
    const body = buildDelegateStartBody({
      agentId: 'main',
      goal: '自调用',
      allowSelf: true,
    })
    assert.equal(body.allowSelf, true)
  })

  it('resume start body carries an opaque per-request idempotencyKey, not a content hash', () => {
    const args = {
      agentId: 'auditor',
      goal: '复审',
      resumeSessionKey: 'agent:auditor:delegate:main:1:abcd',
    }
    const a = buildDelegateStartBody(args)
    const b = buildDelegateStartBody(args)
    assert.equal(a.resumeSessionKey, args.resumeSessionKey)
    assert.equal(typeof a.idempotencyKey, 'string')
    assert.match(String(a.idempotencyKey), /^resume:agent:auditor:delegate:main:1:abcd:[0-9a-f]{16}$/)
    assert.notEqual(a.idempotencyKey, b.idempotencyKey)
    const pinned = buildDelegateStartBody({ ...args, idempotencyKey: 'resume:agent:auditor:delegate:main:1:abcd:fixedkey01' })
    assert.equal(pinned.idempotencyKey, 'resume:agent:auditor:delegate:main:1:abcd:fixedkey01')
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

  it('start 429 with a live jobId continues into wait instead of exiting 1', async () => {
    const r = await runDelegateStartAndWait({
      args: { agentId: 'auditor', goal: '审' },
      contextToken: 'tok',
      pollWaitMs: 20,
      start: async () => ({
        statusCode: 429,
        body: JSON.stringify({
          error: 'too many concurrent delegations (max 4 non-review; in-use 4/4)',
          status: 'running',
          jobId: 'dlgjob-split',
        }),
      }),
      waitOnce: async () => ({
        statusCode: 200,
        body: JSON.stringify({
          status: 'done',
          jobId: 'dlgjob-split',
          httpStatus: 200,
          ok: true,
          output: '实际在跑并完成了',
        }),
      }),
    })
    assert.equal(r.exitCode, 0, r.stderr)
    assert.match(r.stdout, /实际在跑并完成了/)
  })

  it('true start reject without a jobId still exits non-zero with no wait', async () => {
    let waits = 0
    const r = await runDelegateStartAndWait({
      args: { agentId: 'auditor', goal: '审' },
      contextToken: 'tok',
      pollWaitMs: 20,
      start: async () => ({
        statusCode: 429,
        body: JSON.stringify({
          error: 'too many concurrent delegations (max 4 non-review; in-use 4/4); 排队等待者已满(8 个)',
          failure_class: 'capacity_queue_full',
        }),
      }),
      waitOnce: async () => {
        waits++
        return { statusCode: 500, body: '{}' }
      },
    })
    assert.equal(r.exitCode, 1)
    assert.equal(waits, 0)
    assert.match(r.stderr, /委派失败/)
    assert.match(r.stderr, /max 4 non-review/)
  })

  it('request-review wraps hidden-reviewer and keeps the draft in context', () => {
    const args = requestReviewArgs('草稿全文', '已按意见改')
    assert.equal(args.agentId, 'hidden-reviewer')
    assert.match(args.goal, /质量验收/)
    assert.equal(args.reviewMode, 'execution')
    assert.match(args.context ?? '', /草稿全文/)
    assert.match(args.context ?? '', /队长修订说明/)
    const body = buildDelegateStartBody(args)
    assert.equal(body.reviewMode, 'execution')
  })

  it('request-review --mode deliberation selects analyst goal and forwards reviewMode', () => {
    const args = requestReviewArgs('草稿全文', undefined, undefined, 'deliberation')
    assert.equal(args.reviewMode, 'deliberation')
    assert.match(args.goal, /analyst/)
    assert.equal(buildDelegateStartBody(args).reviewMode, 'deliberation')
    // 非法 mode 回落 execution,不报错
    assert.equal(requestReviewArgs('x', undefined, undefined, 'bogus').reviewMode, 'execution')
  })

  it('request-review no longer silently truncates long drafts (gateway marks truncation)', () => {
    const long = 'a'.repeat(20000)
    assert.equal(requestReviewArgs(long).context?.length, 20000)
  })
})
