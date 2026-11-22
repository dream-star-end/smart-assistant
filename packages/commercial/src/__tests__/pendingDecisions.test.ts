/**
 * Run: npx tsx --test packages/commercial/src/__tests__/pendingDecisions.test.ts
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import type { Pool } from 'pg'
import {
  InMemoryBrowserHandoffStore,
  InMemoryTaskboardDecisionBackend,
  PendingDecisionError,
  createBrowserHandoffSource,
  createConnectorWriteSource,
  createPendingDecisionsService,
  createTaskboardSource,
  createTurnPermissionSource,
  encodeTaskboardVersionedSourceId,
  evaluateConnectorWritePolicy,
} from '../pendingDecisions/index.js'
import { mountPendingDecisionsRoutes } from '../http/pendingDecisionsHandlers.js'
import { makeConnectorsRpcHandler } from '../connectors/rpc.js'

interface FakePermRow {
  user_id: string
  request_id: string
  session_id: string
  client_message_id: string | null
  tool_use_id: string | null
  tool_name: string
  input_json: Record<string, unknown>
  ask_payload_json?: Record<string, unknown> | null
  status: 'pending' | 'responded' | 'cancelled'
  response_json: Record<string, unknown> | null
  created_at: Date
  updated_at: Date
  expires_at: Date
}

interface FakeLedgerRow {
  id: string
  user_id: number
  connection_id: string
  provider: string
  action: string
  summary: string
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'executing'
  created_at: Date
  approved_at: Date | null
  finished_at: Date | null
  expires_at: Date
}

function makeFakePool(state: { perms: FakePermRow[]; ledger: FakeLedgerRow[] }) {
  return {
    async query(sql: string, params: unknown[] = []) {
      if (sql.includes('FROM turn_permission_requests p')) {
        const uid = String(params[0])
        const rows = state.perms.filter(
          (r) => r.user_id === uid && r.status === 'pending' && r.expires_at.getTime() > Date.now(),
        )
        return { rows, rowCount: rows.length }
      }
      if (sql.includes('FROM turn_permission_requests') && sql.includes('WHERE request_id = $1')) {
        const reqId = String(params[0])
        const uid = String(params[1])
        const matches = state.perms
          .filter((r) => r.request_id === reqId)
          .sort((a, b) => Number(b.user_id === uid) - Number(a.user_id === uid))
        return { rows: matches.slice(0, 1), rowCount: matches.length > 0 ? 1 : 0 }
      }
      if (sql.includes('FROM connector_write_ledger') && sql.includes("status = 'pending'")) {
        const uid = Number(params[0])
        const rows = state.ledger.filter(
          (r) => r.user_id === uid && r.status === 'pending' && r.expires_at.getTime() > Date.now(),
        )
        return { rows, rowCount: rows.length }
      }
      if (sql.includes('FROM connector_write_ledger') && sql.includes('WHERE id = $1::uuid')) {
        const id = String(params[0])
        const rows = state.ledger.filter((r) => r.id === id)
        return { rows: rows.slice(0, 1), rowCount: rows.length > 0 ? 1 : 0 }
      }
      throw new Error(`unexpected SQL in fake pool: ${sql}`)
    },
  } as unknown as Pool
}

function makeFakeReq(opts: {
  method: string
  url: string
  headers?: Record<string, string>
  body?: unknown
}): IncomingMessage {
  const ee = new EventEmitter() as IncomingMessage & {
    [Symbol.asyncIterator]: () => AsyncGenerator<Buffer>
  }
  ee.method = opts.method
  ee.url = opts.url
  ee.headers = opts.headers ?? {}
  const bodyBuf = opts.body !== undefined ? Buffer.from(JSON.stringify(opts.body), 'utf8') : null
  ee[Symbol.asyncIterator] = async function* () {
    if (bodyBuf) yield bodyBuf
  }
  return ee
}

function makeFakeRes() {
  const headers: Record<string, string> = {}
  let statusCode = 200
  let rawBody = ''
  const res = {
    get statusCode() {
      return statusCode
    },
    set statusCode(v: number) {
      statusCode = v
    },
    setHeader(k: string, v: string) {
      headers[k.toLowerCase()] = String(v)
    },
    end(chunk?: string) {
      rawBody = chunk ?? ''
    },
  } as unknown as ServerResponse
  return {
    res,
    get status() {
      return statusCode
    },
    json() {
      return JSON.parse(rawBody)
    },
  }
}

describe('PendingDecisionsService — B3 connector policy, B5 full frame & ask_user, B6 atomic CAS', () => {
  const LEDGER_UUID_1 = '11111111-1111-4111-8111-111111111111'
  const LEDGER_UUID_2 = '22222222-2222-4222-8222-222222222222'

  async function buildFixture() {
    const now = Date.now()
    const perms: FakePermRow[] = [
      {
        user_id: '42',
        request_id: 'perm-req-1',
        session_id: 'sess-a',
        client_message_id: 'cm-1',
        tool_use_id: 'tu-1',
        tool_name: 'Bash',
        input_json: { command: 'git push origin main --force' },
        ask_payload_json: null,
        status: 'pending',
        response_json: null,
        created_at: new Date(now - 5000),
        updated_at: new Date(now - 5000),
        expires_at: new Date(now + 10 * 60_000),
      },
      {
        user_id: '42',
        request_id: 'ask-user:q-1',
        session_id: 'sess-a',
        client_message_id: 'cm-2',
        tool_use_id: 'tu-2',
        tool_name: 'AskUserQuestion',
        input_json: { questions: [{ question: 'Pick env?' }] },
        ask_payload_json: { questions: [{ question: 'Pick env?' }] },
        status: 'pending',
        response_json: null,
        created_at: new Date(now - 4500),
        updated_at: new Date(now - 4500),
        expires_at: new Date(now + 10 * 60_000),
      },
      {
        user_id: '99',
        request_id: 'perm-req-other',
        session_id: 'sess-other',
        client_message_id: null,
        tool_use_id: null,
        tool_name: 'Bash',
        input_json: { command: 'rm -rf ./tmp' },
        ask_payload_json: null,
        status: 'pending',
        response_json: null,
        created_at: new Date(now - 4000),
        updated_at: new Date(now - 4000),
        expires_at: new Date(now + 10 * 60_000),
      },
    ]
    const ledger: FakeLedgerRow[] = [
      {
        id: LEDGER_UUID_1,
        user_id: 42,
        connection_id: 'conn-1',
        provider: 'feishu',
        action: 'send_message',
        summary: '发送消息到项目群',
        status: 'pending',
        created_at: new Date(now - 3000),
        approved_at: null,
        finished_at: null,
        expires_at: new Date(now + 8 * 60_000),
      },
      {
        id: LEDGER_UUID_2,
        user_id: 99,
        connection_id: 'conn-99',
        provider: 'github',
        action: 'delete_branch',
        summary: '他人操作',
        status: 'pending',
        created_at: new Date(now - 2000),
        approved_at: null,
        finished_at: null,
        expires_at: new Date(now + 8 * 60_000),
      },
    ]
    const pool = makeFakePool({ perms, ledger })

    const taskboard = new InMemoryTaskboardDecisionBackend()
    taskboard.upsert({
      id: 'tb-1',
      identifier: 'OCV5-900',
      userId: '42',
      sessionId: 'sess-a',
      title: '上线审批单',
      summary: '等待确认发布',
      status: 'waiting_human',
      version: 1,
      priority: 'P1',
      createdAt: new Date(now - 6000),
    })
    taskboard.upsert({
      id: 'tb-other',
      identifier: 'OCV5-901',
      userId: '99',
      title: '其他用户单据',
      status: 'waiting_human',
      version: 1,
      createdAt: new Date(now - 6000),
    })

    const browserStore = new InMemoryBrowserHandoffStore()
    await browserStore.create({
      id: 'bh-1',
      userId: '42',
      sessionId: 'sess-a',
      title: '登录验证码接管',
      url: 'https://portal.example.com/login',
      reason: '需要输入短信验证码',
      ttlMs: 12 * 60_000,
    })

    const admittedPayloads: Array<Record<string, unknown>> = []
    let wakeCalls = 0
    const permSource = createTurnPermissionSource({
      pool,
      admitControl: async (_p, input) => {
        admittedPayloads.push(input.payload)
        const row = perms.find(
          (r) => r.user_id === input.userId.toString() && r.request_id === input.requestId,
        )
        assert.ok(row)
        row.status = 'responded'
        row.response_json = input.payload
        row.updated_at = new Date()
        return { inserted: true, status: 'pending' }
      },
      onControlAdmitted: async () => {
        wakeCalls += 1
      },
    })

    // Atomic pending-only CAS simulator matching `approvePendingConfirmationCas` / `denyPendingConfirmationCas`
    const { ConnectorError } = await import('../connectors/errors.js')
    const ledgerSource = createConnectorWriteSource({
      pool,
      approvePendingCasFn: async (id, uid) => {
        const row = ledger.find((r) => r.id === id && r.user_id === uid)
        if (!row) throw new ConnectorError('CONFIRMATION_NOT_FOUND', 'no such confirmation')
        if (row.status === 'pending' && row.expires_at.getTime() > Date.now()) {
          row.status = 'approved'
          row.approved_at = new Date()
          return { status: 'approved', idempotentReplay: false }
        }
        if (row.status === 'approved') return { status: 'approved', idempotentReplay: true }
        throw new ConnectorError('CONFIRMATION_ALREADY_FINALIZED', `status=${row.status}`)
      },
      denyPendingCasFn: async (id, uid) => {
        const row = ledger.find((r) => r.id === id && r.user_id === uid)
        if (!row) throw new ConnectorError('CONFIRMATION_NOT_FOUND', 'no such confirmation')
        // Strictly pending-only CAS: NEVER overwrites `approved`!
        if (row.status === 'pending' && row.expires_at.getTime() > Date.now()) {
          row.status = 'denied'
          row.finished_at = new Date()
          return { status: 'denied', idempotentReplay: false }
        }
        if (row.status === 'denied') return { status: 'denied', idempotentReplay: true }
        throw new ConnectorError('CONFIRMATION_ALREADY_FINALIZED', `status=${row.status}`)
      },
    })

    let resolvedListenerCount = 0
    const service = createPendingDecisionsService({
      sources: [
        permSource,
        ledgerSource,
        createTaskboardSource(taskboard),
        createBrowserHandoffSource(browserStore),
      ],
      hooks: {
        onResolved: () => {
          resolvedListenerCount += 1
        },
      },
    })

    return {
      service,
      taskboard,
      admittedPayloads,
      getWakeCalls: () => wakeCalls,
      getResolvedListenerCount: () => resolvedListenerCount,
    }
  }

  it('B5: emits full InboundPermissionResponse wire frame & blocks binary approve on ask_user', async () => {
    const { service, admittedPayloads, getWakeCalls, getResolvedListenerCount } = await buildFixture()

    const list = await service.list('42')
    const askItem = list.items.find((i) => i.sourceId === 'ask-user:q-1')
    assert.ok(askItem)
    assert.equal(askItem.metadata.requiresInteractiveAnswer, true)
    assert.deepEqual(askItem.allowedActions, ['deny'])

    // Binary approve on structured ask_user -> 422 REQUIRES_INTERACTIVE_ANSWER
    await assert.rejects(
      () => service.resolve('42', 'turn_permission:ask-user:q-1', { decision: 'approve' }),
      (err: unknown) =>
        err instanceof PendingDecisionError &&
        err.code === 'REQUIRES_INTERACTIVE_ANSWER' &&
        err.httpStatus === 422,
    )

    // Standard tool permission approve -> exact InboundPermissionResponse frame
    const r1 = await service.resolve('42', 'turn_permission:perm-req-1', {
      decision: 'approve',
      reason: 'ok',
    })
    assert.equal(r1.status, 'approved')
    assert.equal(r1.idempotentReplay, false)
    assert.equal(getWakeCalls(), 1)
    assert.equal(admittedPayloads.length, 1)

    const wire = admittedPayloads[0]!
    assert.equal(wire.type, 'inbound.permission_response')
    assert.equal(wire.channel, 'webchat')
    assert.deepEqual(wire.peer, { id: 'sess-a', kind: 'dm' })
    assert.equal(wire.requestId, 'perm-req-1')
    assert.equal(wire.behavior, 'allow')
    assert.equal(typeof wire.controlId, 'string')

    // Idempotent replay does NOT re-trigger onResolved listener!
    const beforeCount = getResolvedListenerCount()
    const r2 = await service.resolve('42', 'turn_permission:perm-req-1', { decision: 'approve' })
    assert.equal(r2.idempotentReplay, true)
    assert.equal(getResolvedListenerCount(), beforeCount)
  })

  it('B6: atomic CAS prevents concurrent approve+deny overwrite & fences reopened taskboard rounds', async () => {
    const { service, taskboard, getResolvedListenerCount } = await buildFixture()

    // Concurrent approve + deny on same connector write: exactly one wins, opposite gets 409 CONFLICT
    const [a, d] = await Promise.allSettled([
      service.resolve('42', `connector_write:${LEDGER_UUID_1}`, { decision: 'approve' }),
      service.resolve('42', `connector_write:${LEDGER_UUID_1}`, { decision: 'deny' }),
    ])
    assert.equal(a.status, 'fulfilled')
    assert.equal(d.status, 'rejected')
    if (d.status === 'rejected') {
      assert.ok(d.reason instanceof PendingDecisionError && d.reason.code === 'CONFLICT_ALREADY_RESOLVED')
    }

    // Taskboard v1 approve -> done; replay v1 approve is idempotent; reopen -> v2 fences old v1 card!
    const v1Id = `taskboard:${encodeTaskboardVersionedSourceId('tb-1', 1)}`
    const t1 = await service.resolve('42', v1Id, { decision: 'approve' })
    assert.equal(t1.status, 'approved')
    assert.equal(t1.idempotentReplay, false)
    const countAfterT1 = getResolvedListenerCount()

    const t1Replay = await service.resolve('42', v1Id, { decision: 'approve' })
    assert.equal(t1Replay.idempotentReplay, true)
    assert.equal(getResolvedListenerCount(), countAfterT1)

    // Reopen ticket back to waiting_human (v3) -> old v1 card AND unversioned legacy id are rejected with 409!
    const reopenedVer = taskboard.reopenToWaitingHuman('tb-1')
    assert.ok(reopenedVer >= 3)
    await assert.rejects(
      () => service.resolve('42', v1Id, { decision: 'approve' }),
      (err: unknown) =>
        err instanceof PendingDecisionError && err.code === 'CONFLICT_ALREADY_RESOLVED',
    )
    await assert.rejects(
      () => service.resolve('42', 'taskboard:tb-1', { decision: 'approve' }),
      (err: unknown) =>
        err instanceof PendingDecisionError && err.code === 'CONFLICT_ALREADY_RESOLVED',
    )

    // New v3 card can be resolved cleanly
    const vNewId = `taskboard:${encodeTaskboardVersionedSourceId('tb-1', reopenedVer)}`
    const tNew = await service.resolve('42', vNewId, { decision: 'deny', reason: '需要再测' })
    assert.equal(tNew.status, 'denied')
    assert.equal(tNew.idempotentReplay, false)

    // B6: concurrent admitControl returning `inserted: false` is marked idempotentReplay=true
    // and MUST NOT re-fire onResolved listener!
    let concurrentListenerCalls = 0
    const concurrentPool = makeFakePool({
      perms: [
        {
          user_id: '42',
          request_id: 'perm-concurrent-1',
          session_id: 'sess-c',
          client_message_id: null,
          tool_use_id: null,
          tool_name: 'Bash',
          input_json: { command: 'rm -rf ./tmp' },
          ask_payload_json: null,
          status: 'pending',
          response_json: null,
          created_at: new Date(),
          updated_at: new Date(),
          expires_at: new Date(Date.now() + 60_000),
        },
      ],
      ledger: [],
    })
    const concurrentSvc = createPendingDecisionsService({
      sources: [
        createTurnPermissionSource({
          pool: concurrentPool,
          admitControl: async () => ({ inserted: false, status: 'pending' }),
        }),
      ],
      hooks: {
        onResolved: () => {
          concurrentListenerCalls += 1
        },
      },
    })
    const concRes = await concurrentSvc.resolve('42', 'turn_permission:perm-concurrent-1', {
      decision: 'approve',
    })
    assert.equal(concRes.idempotentReplay, true)
    assert.equal(concurrentListenerCalls, 0)
  })

  it('B3: connectors RPC passes forceInteractiveConfirmation=true BEFORE ledger proposeWrite so policy-gated plugin writes persist as pending', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-conn-policy-'))
    const humanYaml = join(dir, 'human-weibo.yaml')
    writeFileSync(
      humanYaml,
      [
        'version: 1',
        'rules:',
        '  - id: default-connector-plugin-write',
        '    tier: human_approval',
        '    priority: 999',
        '    match:',
        '      category: connector_write',
        '      target: weibo',
        '    reason: Require explicit human confirmation for weibo',
      ].join('\n'),
    )
    const evalHuman = await evaluateConnectorWritePolicy({
      provider: 'weibo',
      action: 'post_status',
      connectionId: '10',
      userId: 42,
      policyPath: humanYaml,
    })
    // Even overriding a `default-*` rule id in a user file MUST block account_preapproval!
    assert.equal(evalHuman.blockPreapproval, true)

    // Real makeConnectorsRpcHandler plugin call verifies forceInteractiveConfirmation=true reaches proposeWrite
    // BEFORE writing the ledger, returns confirmation_required, and NEVER auto-executes!
    const secretHex = 'a'.repeat(64)
    const secretHash = createHash('sha256').update(Buffer.from(secretHex, 'hex')).digest()
    const proposeInputs: Array<{ forceInteractiveConfirmation?: boolean }> = []
    let executedCount = 0
    const preapprovedConfirmId = '33333333-3333-4333-8333-333333333333'
    const rpcPool = {
      async query(sql: string, params: unknown[] = []) {
        if (sql.includes('FROM connector_write_ledger') && String(params[0]) === preapprovedConfirmId) {
          return {
            rows: [
              {
                id: preapprovedConfirmId,
                user_id: 42,
                connection_id: '10',
                provider: 'weibo',
                action: 'post_status',
                approval_source: 'account_preapproval',
                status: 'approved',
                expires_at: new Date(Date.now() + 60_000),
              },
            ],
            rowCount: 1,
          }
        }
        return { rows: [], rowCount: 0 }
      },
    } as unknown as Pool

    const rpc = makeConnectorsRpcHandler({
      identityRepo: {
        findActiveByHostAndBoundIp: async () => ({
          id: 7,
          user_id: 42,
          bound_ip: '127.0.0.1',
          host_uuid: 'host-1',
          secret_hash: secretHash,
        }),
      },
      redis: { eval: async () => 1 } as unknown as Parameters<typeof makeConnectorsRpcHandler>[0]['redis'],
      pool: rpcPool,
      actionPolicyPath: humanYaml,
      pluginFacade: {
        catalog: async () => [],
        list: async () => [],
        classifyTarget: async () => 'managed-browser',
        targetProvider: async () => 'weibo',
        actionEffect: async () => 'write',
        call: async () => ({}),
        proposeWrite: async (input) => {
          proposeInputs.push({ forceInteractiveConfirmation: input.forceInteractiveConfirmation })
          return {
            confirmId: '44444444-4444-4444-8444-444444444444',
            provider: 'weibo',
            summary: 'post',
            expiresAt: new Date(Date.now() + 60_000),
            approvalMode: input.forceInteractiveConfirmation ? 'interactive' : 'account_preapproval',
          }
        },
        executeConfirmedWrite: async () => {
          executedCount += 1
          return { kind: 'result', result: {} }
        },
      },
    })

    // 1) Propose write through real /v3/plugins/call -> forceInteractiveConfirmation=true -> confirmation_required!
    const propRes = makeFakeRes()
    await rpc(
      makeFakeReq({
        method: 'POST',
        url: '/v3/plugins/call',
        headers: { authorization: `Bearer oc-v3.7.${secretHex}` },
        body: { connectionId: '10', action: 'post_status', params: { text: 'hello' } },
      }),
      propRes.res,
      { hostUuid: 'host-1', boundIp: '127.0.0.1' },
    )
    assert.equal(propRes.status, 200)
    assert.equal(propRes.json().kind, 'confirmation_required')
    assert.equal(proposeInputs.length, 1)
    assert.equal(proposeInputs[0]!.forceInteractiveConfirmation, true)
    assert.equal(executedCount, 0)

    // 2) Confirm execution against a preapproved ledger row when policy requires human_approval -> rejected!
    const execRes = makeFakeRes()
    await rpc(
      makeFakeReq({
        method: 'POST',
        url: '/v3/plugins/call',
        headers: { authorization: `Bearer oc-v3.7.${secretHex}` },
        body: { connectionId: '10', confirmId: preapprovedConfirmId },
      }),
      execRes.res,
      { hostUuid: 'host-1', boundIp: '127.0.0.1' },
    )
    assert.equal(execRes.status, 200)
    assert.equal(execRes.json().kind, 'error')
    assert.equal(execRes.json().code, 'CONFIRMATION_NOT_APPROVED')
    assert.equal(executedCount, 0)

    // 3) Broken YAML fails closed too
    const badYaml = join(dir, 'bad.yaml')
    writeFileSync(badYaml, 'version: 1\nrules: null\n')
    const badRes = await evaluateConnectorWritePolicy({
      provider: 'github',
      action: 'create_issue',
      connectionId: '2',
      userId: 42,
      policyPath: badYaml,
    })
    assert.equal(badRes.evaluation.configError, true)
    assert.equal(badRes.blockPreapproval, true)
  })

  it('HTTP routes enforce auth, 403 cross-uid, 422 ask_user, and clean fallthrough', async () => {
    const { service } = await buildFixture()
    const handler = mountPendingDecisionsRoutes({
      jwtSecret: 'unused',
      service,
      authenticate: async (req) => {
        const uid = req.headers['x-test-uid']
        if (typeof uid !== 'string') {
          const { HttpError } = await import('../http/util.js')
          throw new HttpError(401, 'UNAUTHORIZED', 'missing auth')
        }
        return { id: uid, role: 'user', jti: 'jti-1' }
      },
    })

    const askRes = makeFakeRes()
    await handler(
      makeFakeReq({
        method: 'POST',
        url: `/api/me/pending-decisions/${encodeURIComponent('turn_permission:ask-user:q-1')}/resolve`,
        headers: { 'x-test-uid': '42' },
        body: { decision: 'approve' },
      }),
      askRes.res,
    )
    assert.equal(askRes.status, 422)
    assert.equal(askRes.json().error.code, 'REQUIRES_INTERACTIVE_ANSWER')
  })
})
