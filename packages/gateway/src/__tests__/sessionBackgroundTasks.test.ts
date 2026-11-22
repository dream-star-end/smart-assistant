/**
 * Unit tests for gateway session background commands, single-delegate cancel, and
 * container-internal background task endpoints (OCV5-844).
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/sessionBackgroundTasks.test.ts
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { describe, it } from 'node:test'
import { cancelSingleDelegateJob, type DelegateCancelHost } from '../delegateCancel.js'
import { DelegateInflightSurfaceStore } from '../delegateInflightSurface.js'
import { DelegateJobStore } from '../delegateJobs.js'
import { registerDelegateTraceWait } from '../delegateTrace.js'
import {
  buildSignedInternalBridgeHeaders,
  InternalBridgeReplayCache,
} from '../routes/internalBridgeAuth.js'
import {
  handleInternalSessionBackgroundState,
  handleInternalSessionBgCmdCancel,
  handleInternalSessionDelegateCancel,
} from '../routes/sessionBackgroundRoute.js'
import {
  cancelSessionBgCommand,
  listSessionBgCommands,
  parseProcStatStartTimeTicks,
  readLinuxProcStartTimeTicks,
  type SessionBgCommandSnapshot,
} from '../sessionBgCommands.js'

function writeSnap(dir: string, snap: SessionBgCommandSnapshot): string {
  const filePath = join(dir, `${snap.id}.json`)
  writeFileSync(filePath, JSON.stringify(snap), 'utf8')
  return filePath
}

function mockRes() {
  let status = 200
  let headersSent = false
  const headers: Record<string, string> = {}
  let rawBody = ''
  const res = {
    get statusCode() {
      return status
    },
    set statusCode(v: number) {
      status = v
    },
    get headersSent() {
      return headersSent
    },
    setHeader(k: string, v: string) {
      headers[k.toLowerCase()] = v
    },
    end(chunk?: string | Buffer) {
      headersSent = true
      if (chunk) rawBody += chunk.toString()
    },
  } as unknown as ServerResponse
  return {
    res,
    result: () => ({
      status,
      headers,
      json: rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : null,
    }),
  }
}

function mockReq(opts: {
  method: string
  url: string
  headers?: Record<string, string>
  remoteAddress?: string
  body?: string
}): IncomingMessage {
  const stream = Readable.from(opts.body ? [Buffer.from(opts.body, 'utf8')] : []) as unknown as IncomingMessage
  stream.method = opts.method
  stream.url = opts.url
  stream.headers = {}
  for (const [k, v] of Object.entries(opts.headers ?? {})) {
    stream.headers[k.toLowerCase()] = v
  }
  ;(stream as unknown as { socket: { remoteAddress: string } }).socket = {
    remoteAddress: opts.remoteAddress ?? '172.18.0.1',
  }
  return stream
}

describe('sessionBgCommands', () => {
  it('parses /proc/<pid>/stat field 22 with parentheses in comm', () => {
    const stat =
      '555 (bash (sub)) R 1 555 555 0 -1 4194304 10 0 0 0 1 1 0 0 20 0 1 0 1234567 100 10 0'
    assert.equal(parseProcStatStartTimeTicks(stat), 1234567)
  })

  it('lists live session commands newest-first, caps at 20, and reaps stale/expired/PID-reused entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-bg-list-'))
    const now = 1_700_000_000_000
    try {
      // 22 live entries for sess-A
      for (let i = 1; i <= 22; i++) {
        writeSnap(dir, {
          id: `1000-ocb_${i}`,
          jobId: `ocb_${i}`,
          pid: 5000 + i,
          pgid: 5000 + i,
          ownerPid: 1000,
          startTimeTicks: 9000 + i,
          sessionKey: 'agent:main:webchat:dm:sess-A',
          sessionId: 'sess-A',
          commandPreview: `cmd ${i}`,
          cwd: '/work',
          startedAt: now - (30 - i) * 1000,
          updatedAt: now - (30 - i) * 1000,
          maxLifetimeAt: now + 60_000,
        })
      }
      // Entry for another session (must not be returned, must NOT be deleted)
      const otherPath = writeSnap(dir, {
        id: '2000-ocb_1',
        jobId: 'ocb_1',
        pid: 6001,
        pgid: 6001,
        ownerPid: 2000,
        startTimeTicks: 7777,
        sessionKey: 'agent:main:webchat:dm:sess-B',
        sessionId: 'sess-B',
        commandPreview: 'other cmd',
        startedAt: now,
        updatedAt: now,
        maxLifetimeAt: now + 60_000,
      })
      // Expired entry (reaped)
      const expiredPath = writeSnap(dir, {
        id: '3000-ocb_1',
        jobId: 'ocb_1',
        pid: 6002,
        pgid: 6002,
        ownerPid: 3000,
        startTimeTicks: 8888,
        sessionKey: 'agent:main:webchat:dm:sess-A',
        sessionId: 'sess-A',
        commandPreview: 'expired',
        startedAt: now - 10_000,
        updatedAt: now - 10_000,
        maxLifetimeAt: now - 1,
      })
      // PID-reused entry (ticks mismatch → reaped)
      const reusedPath = writeSnap(dir, {
        id: '4000-ocb_1',
        jobId: 'ocb_1',
        pid: 6003,
        pgid: 6003,
        ownerPid: 4000,
        startTimeTicks: 1111,
        sessionKey: 'agent:main:webchat:dm:sess-A',
        sessionId: 'sess-A',
        commandPreview: 'reused',
        startedAt: now - 5_000,
        updatedAt: now - 5_000,
        maxLifetimeAt: now + 60_000,
      })

      const items = listSessionBgCommands('sess-A', dir, {
        now: () => now,
        platform: 'linux',
        isProcessAlive: () => true,
        readStartTimeTicks: (pid) => {
          if (pid === 6003) return 2222 // PID reused!
          if (pid === 6001) return 7777
          if (pid === 6002) return 8888
          return 9000 + (pid - 5000)
        },
      })

      assert.equal(items.length, 20, 'capped at 20')
      assert.equal(items[0]!.jobId, 'ocb_22', 'newest first')
      assert.equal(items[19]!.jobId, 'ocb_3')
      assert.equal(existsSync(otherPath), true, 'other session entry preserved')
      assert.equal(existsSync(expiredPath), false, 'expired entry reaped')
      assert.equal(existsSync(reusedPath), false, 'PID-reused entry reaped')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects path traversal entryIds and isolates across sessions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-bg-sec-'))
    const now = 1_700_000_000_000
    try {
      for (const badId of ['../etc/passwd', '123-ocb_1/../x', 'ocb_1', 'abc-ocb_1', '123-ocb_1.json']) {
        const res = await cancelSessionBgCommand('sess-A', badId, dir)
        assert.equal(res.ok, false)
        if (!res.ok) assert.equal(res.status, 400)
      }

      const snapPath = writeSnap(dir, {
        id: '100-ocb_1',
        jobId: 'ocb_1',
        pid: 7001,
        pgid: 7001,
        ownerPid: 100,
        startTimeTicks: 555,
        sessionKey: 'agent:main:webchat:dm:sess-A',
        sessionId: 'sess-A',
        commandPreview: 'sleep 100',
        startedAt: now,
        updatedAt: now,
        maxLifetimeAt: now + 60_000,
      })

      const signals: Array<{ target: number; sig: NodeJS.Signals }> = []
      const crossRes = await cancelSessionBgCommand('sess-B', '100-ocb_1', dir, {
        now: () => now,
        platform: 'linux',
        isProcessAlive: () => true,
        readStartTimeTicks: () => 555,
        sendSignal: (target, sig) => signals.push({ target, sig }),
      })
      assert.equal(crossRes.ok, false)
      if (!crossRes.ok) assert.equal(crossRes.status, 404)
      assert.equal(signals.length, 0, 'must never signal another session process')
      assert.equal(existsSync(snapPath), true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('never signals a reused PID and escalates SIGTERM → SIGKILL only for verified startTimeTicks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-bg-kill-'))
    const now = 1_700_000_000_000
    try {
      // 1. Reused PID: startTimeTicks mismatch → no signal, file removed, alreadyExited: true
      const reusedPath = writeSnap(dir, {
        id: '100-ocb_2',
        jobId: 'ocb_2',
        pid: 7002,
        pgid: 7002,
        ownerPid: 100,
        startTimeTicks: 1000,
        sessionKey: 'a:b:sess-A',
        sessionId: 'sess-A',
        commandPreview: 'reused',
        startedAt: now,
        updatedAt: now,
        maxLifetimeAt: now + 60_000,
      })
      const signals1: Array<{ target: number; sig: NodeJS.Signals }> = []
      const res1 = await cancelSessionBgCommand('sess-A', '100-ocb_2', dir, {
        now: () => now,
        platform: 'linux',
        isProcessAlive: () => true,
        readStartTimeTicks: () => 9999,
        sendSignal: (target, sig) => signals1.push({ target, sig }),
      })
      assert.deepEqual(res1, { ok: true, cancelled: false, alreadyExited: true })
      assert.equal(signals1.length, 0)
      assert.equal(existsSync(reusedPath), false)

      // 2. Stubborn live process: SIGTERM then SIGKILL after grace
      const stubbornPath = writeSnap(dir, {
        id: '100-ocb_3',
        jobId: 'ocb_3',
        pid: 7003,
        pgid: 7003,
        ownerPid: 100,
        startTimeTicks: 3333,
        sessionKey: 'a:b:sess-A',
        sessionId: 'sess-A',
        commandPreview: 'stubborn',
        startedAt: now,
        updatedAt: now,
        maxLifetimeAt: now + 60_000,
      })
      const signals2: Array<{ target: number; sig: NodeJS.Signals }> = []
      const res2 = await cancelSessionBgCommand('sess-A', '100-ocb_3', dir, {
        now: () => now,
        platform: 'linux',
        isProcessAlive: () => true,
        readStartTimeTicks: () => 3333,
        sendSignal: (target, sig) => signals2.push({ target, sig }),
        killGraceMs: 40,
        sleep: async () => {},
      })
      assert.deepEqual(res2, { ok: true, cancelled: true })
      assert.deepEqual(signals2, [
        { target: -7003, sig: 'SIGTERM' },
        { target: -7003, sig: 'SIGKILL' },
      ])
      assert.equal(existsSync(stubbornPath), false)

      // 3. Missing entry → idempotent alreadyExited
      const res3 = await cancelSessionBgCommand('sess-A', '100-ocb_999', dir)
      assert.deepEqual(res3, { ok: true, cancelled: false, alreadyExited: true })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('cancels a real detached bash child process cleanly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-bg-real-'))
    const child = spawn('/bin/bash', ['-lc', 'sleep 30'], { detached: true, stdio: 'ignore' })
    try {
      assert.ok(child.pid && child.pid > 1)
      const ticks = readLinuxProcStartTimeTicks(child.pid)
      const now = Date.now()
      writeSnap(dir, {
        id: `${process.pid}-ocb_1`,
        jobId: 'ocb_1',
        pid: child.pid,
        pgid: child.pid,
        ownerPid: process.pid,
        startTimeTicks: ticks,
        sessionKey: 'agent:main:webchat:dm:sess-real',
        sessionId: 'sess-real',
        commandPreview: 'sleep 30',
        startedAt: now,
        updatedAt: now,
        maxLifetimeAt: now + 60_000,
      })
      const listed = listSessionBgCommands('sess-real', dir)
      assert.equal(listed.length, 1)
      assert.equal(listed[0]!.commandPreview, 'sleep 30')

      const cancelled = await cancelSessionBgCommand('sess-real', `${process.pid}-ocb_1`, dir, {
        killGraceMs: 200,
      })
      assert.deepEqual(cancelled, { ok: true, cancelled: true })
      assert.equal(listSessionBgCommands('sess-real', dir).length, 0)
    } finally {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
      } catch {}
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('cancelSingleDelegateJob', () => {
  it('cancels a running delegate, interrupts child + traceWait + queueWaiter + descendants, and projects cancelled', () => {
    const jobs = new DelegateJobStore({ sm: true })
    const surface = new DelegateInflightSurfaceStore({ dbPath: null })
    const parentSessionKey = 'agent:main:webchat:dm:sess-own-1'
    const childSessionKey = 'agent:coder:delegate:main:child-1'

    const created = jobs.create('coder', {
      parentSessionKey,
      sessionKey: childSessionKey,
    })
    assert.ok('jobId' in created)
    const jobId = created.jobId
    surface.upsertEnqueue({
      jobId,
      parentSessionKey,
      agentId: 'coder',
      goal: 'build feature',
      state: 'running',
    })

    const traceHost = {}
    const traceHandle = registerDelegateTraceWait(traceHost, childSessionKey)
    let waiterWoken = false
    const waiters = new Map<string, () => void>([
      [childSessionKey, () => { waiterWoken = true }],
    ])
    const interruptedSessions: string[] = []
    const cascadedParents: string[] = []

    const host: DelegateCancelHost = {
      traceHost,
      delegateJobs: () => jobs,
      delegateInflightSurface: () => surface,
      sessions: {
        getByKey: (k) => (k === childSessionKey ? ({ sessionKey: k } as never) : undefined),
        interrupt: (k) => {
          interruptedSessions.push(k)
          return true
        },
      },
      _delegateQueueWaiters: waiters,
      _interruptDelegationsForParent: (k) => {
        cascadedParents.push(k)
        return true
      },
    }

    // Cross-session attempt must return 404 and leave job untouched
    const cross = cancelSingleDelegateJob(host, 'sess-other-2', jobId)
    assert.equal(cross.ok, false)
    if (!cross.ok) assert.equal(cross.status, 404)
    assert.equal(jobs.snapshotOf(jobId)?.state, 'running')

    // Valid owner cancel
    const res = cancelSingleDelegateJob(host, 'sess-own-1', jobId)
    assert.deepEqual(res, { ok: true, cancelled: true, state: 'cancelled' })
    assert.equal(traceHandle.isAborted(), true)
    assert.equal(waiterWoken, true)
    assert.deepEqual(interruptedSessions, [childSessionKey])
    assert.deepEqual(cascadedParents, [childSessionKey])
    assert.equal(jobs.snapshotOf(jobId)?.state, 'cancelled')
    assert.equal(surface.get(jobId)?.state, 'cancelled')

    // Repeat cancel is idempotent
    const again = cancelSingleDelegateJob(host, 'sess-own-1', jobId)
    assert.deepEqual(again, { ok: true, cancelled: false, state: 'cancelled' })
  })

  it('is idempotent on already-completed jobs', () => {
    const jobs = new DelegateJobStore({ sm: true })
    const parentSessionKey = 'agent:main:webchat:dm:sess-term-1'
    const created = jobs.create('coder', { parentSessionKey })
    assert.ok('jobId' in created)
    const snap = jobs.snapshotOf(created.jobId)!
    jobs.complete(
      created.jobId,
      { httpStatus: 200, body: { ok: true, output: 'done' } },
      { claimToken: snap.claimToken!, fencingEpoch: snap.fencingEpoch },
    )
    const host: DelegateCancelHost = {
      delegateJobs: () => jobs,
      sessions: { getByKey: () => undefined, interrupt: () => false },
      _interruptDelegationsForParent: () => false,
    }
    const res = cancelSingleDelegateJob(host, 'sess-term-1', created.jobId)
    assert.deepEqual(res, { ok: true, cancelled: false, state: 'completed' })
  })
})

describe('internal container background routes (bridge auth + replay)', () => {
  const env = {
    OPENCLAUDE_TRUST_BRIDGE_IP: '172.18.0.1',
    OC_CONTAINER_ID: '42',
    OC_BRIDGE_NONCE: 'a'.repeat(64),
  }

  it('rejects unauthenticated requests fail-closed (401) and replays (409)', async () => {
    const replayCache = new InternalBridgeReplayCache()
    const unauthedReq = mockReq({
      method: 'GET',
      url: '/internal/sessions/sess-1/background-state',
    })
    const m1 = mockRes()
    await handleInternalSessionBackgroundState(
      unauthedReq,
      m1.res,
      new URL(unauthedReq.url!, 'http://c'),
      { env, replayCache },
    )
    assert.equal(m1.result().status, 401)

    const signedHeaders = buildSignedInternalBridgeHeaders({
      containerId: 42,
      bridgeNonce: env.OC_BRIDGE_NONCE,
      method: 'GET',
      pathAndQuery: '/internal/sessions/sess-1/background-state',
      nowMs: 1_700_000_000_000,
    })
    const jobs = new DelegateJobStore({ sm: true })
    const surface = new DelegateInflightSurfaceStore({ dbPath: null })
    const created = jobs.create('researcher', { parentSessionKey: 'agent:main:webchat:dm:sess-1' })
    assert.ok('jobId' in created)
    const regDir = mkdtempSync(join(tmpdir(), 'oc-int-bg-'))
    try {
      const req1 = mockReq({
        method: 'GET',
        url: '/internal/sessions/sess-1/background-state',
        headers: signedHeaders,
      })
      const m2 = mockRes()
      await handleInternalSessionBackgroundState(req1, m2.res, new URL(req1.url!, 'http://c'), {
        env,
        replayCache,
        now: () => 1_700_000_000_000,
        delegateJobs: () => jobs,
        ensureDelegateInflightSurface: () => surface,
        bgCommandsRegistryDir: regDir,
      })
      assert.equal(m2.result().status, 200)
      const body = m2.result().json!
      assert.equal(Array.isArray(body.delegates), true)
      assert.equal((body.delegates as unknown[]).length, 1)
      assert.deepEqual(body.bgCommands, [])

      // Replay same headers → 409 REPLAY_REJECTED
      const req2 = mockReq({
        method: 'GET',
        url: '/internal/sessions/sess-1/background-state',
        headers: signedHeaders,
      })
      const m3 = mockRes()
      await handleInternalSessionBackgroundState(req2, m3.res, new URL(req2.url!, 'http://c'), {
        env,
        replayCache,
        now: () => 1_700_000_000_000,
        delegateJobs: () => jobs,
        ensureDelegateInflightSurface: () => surface,
        bgCommandsRegistryDir: regDir,
      })
      assert.equal(m3.result().status, 409)
      assert.equal(m3.result().json?.code, 'REPLAY_REJECTED')

      // Signed POST delegate cancel
      const cancelUrl = `/internal/sessions/sess-1/inflight-delegates/${created.jobId}/cancel`
      const cancelHeaders = buildSignedInternalBridgeHeaders({
        containerId: 42,
        bridgeNonce: env.OC_BRIDGE_NONCE,
        method: 'POST',
        pathAndQuery: cancelUrl,
        body: '{}',
        nowMs: 1_700_000_000_100,
      })
      const cancelReq = mockReq({ method: 'POST', url: cancelUrl, headers: cancelHeaders, body: '{}' })
      const m4 = mockRes()
      await handleInternalSessionDelegateCancel(
        cancelReq,
        m4.res,
        new URL(cancelUrl, 'http://c'),
        {
          env,
          replayCache,
          now: () => 1_700_000_000_100,
          delegateCancelHost: () => ({
            delegateJobs: () => jobs,
            delegateInflightSurface: () => surface,
            sessions: { getByKey: () => undefined, interrupt: () => false },
            _interruptDelegationsForParent: () => false,
          }),
        },
      )
      assert.equal(m4.result().status, 200)
      assert.deepEqual(m4.result().json, { ok: true, cancelled: true, state: 'cancelled' })

      // Signed POST bg-command cancel (missing entry → idempotent alreadyExited)
      const bgUrl = '/internal/sessions/sess-1/bg-commands/999-ocb_1/cancel'
      const bgHeaders = buildSignedInternalBridgeHeaders({
        containerId: 42,
        bridgeNonce: env.OC_BRIDGE_NONCE,
        method: 'POST',
        pathAndQuery: bgUrl,
        body: '{}',
        nowMs: 1_700_000_000_200,
      })
      const bgReq = mockReq({ method: 'POST', url: bgUrl, headers: bgHeaders, body: '{}' })
      const m5 = mockRes()
      await handleInternalSessionBgCmdCancel(bgReq, m5.res, new URL(bgUrl, 'http://c'), {
        env,
        replayCache,
        now: () => 1_700_000_000_200,
        bgCommandsRegistryDir: regDir,
      })
      assert.equal(m5.result().status, 200)
      assert.deepEqual(m5.result().json, { ok: true, cancelled: false, alreadyExited: true })
    } finally {
      rmSync(regDir, { recursive: true, force: true })
    }
  })
})
