/**
 * connectors 纯逻辑单测(无 DB):
 *   - registry:目录形状 / 参数严格校验(未知字段拒绝)/ 结果 allowlist Clean
 *   - 结果硬限(256KB / 深度8 / 数组200)
 *   - ledger classifyForExecute 状态机纯逻辑全路径
 *   - 确认卡 summary/detail 构造(含"detail 不含文件内容"防泄漏)
 *   - RPC 信封:401(身份失败)/ 业务错误 200 {kind:'error',code} / canary 防泄漏
 *   - 用户路由 401(无 Bearer)
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, test } from 'node:test'
import { ConnectorError } from '../connectors/errors.js'
import { dispatchConnectorsRoute } from '../connectors/handlers.js'
import { classifyForExecute } from '../connectors/ledger.js'
import { presetImapConfig } from '../connectors/providers/imap.js'
import {
  RESULT_MAX_ARRAY,
  enforceResultLimits,
  mapUpstreamStatus,
  truncateText,
} from '../connectors/providers/shared.js'
import {
  CONNECTOR_PROVIDERS,
  DB_PROVIDER_IDS,
  cleanActionResult,
  getActionDecl,
  getProviderDecl,
  isDbProvider,
  validateActionParams,
} from '../connectors/registry.js'
import { makeConnectorsRpcHandler } from '../connectors/rpc.js'
import { buildWriteDetail, buildWriteSummary, requireAction } from '../connectors/service.js'
import { HttpError } from '../http/util.js'

// ─── registry ────────────────────────────────────────────────────────────

describe('registry 目录', () => {
  test('五 provider 齐全;github 只读;写 action 标记正确(§1 矩阵)', () => {
    assert.deepEqual(Object.keys(CONNECTOR_PROVIDERS).sort(), [
      'feishu',
      'github',
      'imap',
      'notion',
      'webdav',
    ])
    // github 全只读
    for (const a of CONNECTOR_PROVIDERS.github.actions) {
      assert.equal(a.readOnly, true, `github ${a.id} must be readOnly`)
    }
    // 写 action 清单 = 设计 §1 的 ★ 集
    const writes: string[] = []
    for (const p of Object.values(CONNECTOR_PROVIDERS)) {
      for (const a of p.actions) if (!a.readOnly) writes.push(`${p.id}/${a.id}`)
    }
    assert.deepEqual(writes.sort(), [
      'feishu/create_calendar_event',
      'feishu/send_message',
      'imap/send_email',
      'notion/create_page',
      'webdav/put_file',
    ])
    // send 类标记
    assert.equal(getActionDecl('imap', 'send_email')?.sendClass, true)
    assert.equal(getActionDecl('feishu', 'send_message')?.sendClass, true)
    assert.notEqual(getActionDecl('webdav', 'put_file')?.sendClass, true)
  })

  test('DB provider 集合不含 github(§4:github 无 connections 行)', () => {
    assert.deepEqual([...DB_PROVIDER_IDS].sort(), ['feishu', 'imap', 'notion', 'webdav'])
    assert.equal(isDbProvider('github'), false)
    assert.equal(isDbProvider('webdav'), true)
  })

  test('getProviderDecl / getActionDecl 未知返回 null', () => {
    assert.equal(getProviderDecl('nope'), null)
    assert.equal(getActionDecl('webdav', 'nope'), null)
    assert.equal(getActionDecl('nope', 'list_dir'), null)
  })

  test('requireAction 未知抛 ACTION_UNKNOWN', () => {
    assert.throws(
      () => requireAction('webdav', 'rm_rf'),
      (e: unknown) => e instanceof ConnectorError && e.code === 'ACTION_UNKNOWN',
    )
  })
})

describe('validateActionParams(TypeBox 严格)', () => {
  const sendEmail = getActionDecl('imap', 'send_email')!

  test('合法参数通过', () => {
    const p = validateActionParams(sendEmail.params, {
      to: ['a@b.com'],
      subject: 'hi',
      text: 'body',
    })
    assert.deepEqual(p.to, ['a@b.com'])
  })

  test('未知字段拒绝(additionalProperties:false)', () => {
    assert.throws(
      () =>
        validateActionParams(sendEmail.params, {
          to: ['a@b.com'],
          subject: 'hi',
          text: 'body',
          bcc: ['x@y.com'], // 未声明字段
        }),
      (e: unknown) => e instanceof ConnectorError && e.code === 'VALIDATION_FAILED',
    )
  })

  test('缺必填 / 类型错 / 越界拒绝', () => {
    assert.throws(
      () => validateActionParams(sendEmail.params, { subject: 'hi', text: 'b' }),
      (e: unknown) => e instanceof ConnectorError && e.code === 'VALIDATION_FAILED',
    )
    assert.throws(
      () => validateActionParams(sendEmail.params, { to: 'a@b.com', subject: 'x', text: 'b' }),
      (e: unknown) => e instanceof ConnectorError && e.code === 'VALIDATION_FAILED',
    )
    assert.throws(
      () =>
        validateActionParams(sendEmail.params, {
          to: Array.from({ length: 21 }, (_, i) => `u${i}@x.com`), // >20
          subject: 'x',
          text: 'b',
        }),
      (e: unknown) => e instanceof ConnectorError && e.code === 'VALIDATION_FAILED',
    )
  })

  test('params 为 undefined 时按 {} 校验(无参 action)', () => {
    const listMailboxes = getActionDecl('imap', 'list_mailboxes')!
    assert.deepEqual(validateActionParams(listMailboxes.params, undefined), {})
  })
})

describe('cleanActionResult(结果 allowlist)', () => {
  test('白名单外字段被剥离(上游多余字段不外泄)', () => {
    const decl = getActionDecl('notion', 'search')!
    const cleaned = cleanActionResult(decl.result, {
      results: [
        {
          id: 'x',
          object: 'page',
          title: 't',
          url: 'https://notion.so/x',
          internalToken: 'LEAK', // 白名单外
        },
      ],
      requestId: 'LEAK2', // 白名单外
    }) as Record<string, unknown>
    assert.equal(JSON.stringify(cleaned).includes('LEAK'), false)
    assert.deepEqual(Object.keys(cleaned), ['results'])
  })

  test('形状不符(编程错误)→ INTERNAL', () => {
    const decl = getActionDecl('notion', 'search')!
    assert.throws(
      () => cleanActionResult(decl.result, { results: 'not-an-array' }),
      (e: unknown) => e instanceof ConnectorError && e.code === 'INTERNAL',
    )
  })
})

describe('enforceResultLimits(§6 硬限)', () => {
  test('数组 >200 拒绝', () => {
    assert.throws(
      () => enforceResultLimits({ arr: Array.from({ length: RESULT_MAX_ARRAY + 1 }, () => 1) }),
      (e: unknown) => e instanceof ConnectorError && e.code === 'RESULT_TOO_LARGE',
    )
  })
  test('深度 >8 拒绝', () => {
    let v: Record<string, unknown> = { leaf: 1 }
    for (let i = 0; i < 9; i++) v = { nest: v }
    assert.throws(
      () => enforceResultLimits(v),
      (e: unknown) => e instanceof ConnectorError && e.code === 'RESULT_TOO_LARGE',
    )
  })
  test('>256KB 拒绝;正常大小通过', () => {
    assert.throws(
      () => enforceResultLimits({ s: 'x'.repeat(257 * 1024) }),
      (e: unknown) => e instanceof ConnectorError && e.code === 'RESULT_TOO_LARGE',
    )
    assert.deepEqual(enforceResultLimits({ ok: true }), { ok: true })
  })
})

// ─── ledger 状态机纯逻辑 ─────────────────────────────────────────────────

describe('classifyForExecute(状态机全路径)', () => {
  const future = new Date(Date.now() + 60_000)
  const past = new Date(Date.now() - 60_000)
  const row = (status: string, expires: Date) =>
    ({ status, expires_at: expires, error_code: null, result_digest: null }) as never

  test('executing → in_progress', () => {
    assert.deepEqual(classifyForExecute(row('executing', future)), { kind: 'in_progress' })
  })
  test('终态 → replay(带 errorCode/resultDigest)', () => {
    for (const s of ['succeeded', 'failed', 'unknown', 'expired', 'denied']) {
      const r = classifyForExecute({
        status: s as never,
        expires_at: past,
        error_code: 'E',
        result_digest: 'd',
      })
      assert.deepEqual(r, { kind: 'replay', status: s, errorCode: 'E', resultDigest: 'd' })
    }
  })
  test('pending → not_approved(即使未过期)', () => {
    assert.deepEqual(classifyForExecute(row('pending', future)), { kind: 'not_approved' })
  })
  test('approved 未过期 → ok;过期 → expired', () => {
    assert.deepEqual(classifyForExecute(row('approved', future)), { kind: 'ok' })
    assert.deepEqual(classifyForExecute(row('approved', past)), { kind: 'expired' })
  })
  test('approved 恰好到期(边界 ≤)→ expired', () => {
    const now = Date.now()
    assert.deepEqual(classifyForExecute(row('approved', new Date(now)), now), { kind: 'expired' })
  })
})

// ─── summary / detail ────────────────────────────────────────────────────

describe('buildWriteSummary / buildWriteDetail', () => {
  test('send_email 摘要含主题与收件人;≤2000', () => {
    const s = buildWriteSummary(
      'imap',
      'send_email',
      { to: ['boss@corp.com'], cc: ['x@y.com'], subject: '周报', text: 'A'.repeat(5000) },
      'me@qq.com',
    )
    assert.ok(s.includes('周报'))
    assert.ok(s.includes('boss@corp.com'))
    assert.ok(s.length <= 2000)
  })
  test('put_file detail = 路径/大小/sha256,**不含**文件内容(防确认页泄漏)', () => {
    const content = Buffer.from('hello world').toString('base64')
    const d = buildWriteDetail('webdav', 'put_file', { path: '/a.txt', contentBase64: content })
    assert.equal(d.kind, 'file')
    assert.equal(d.path, '/a.txt')
    assert.equal(d.sizeBytes, 11)
    assert.match(String(d.sha256), /^[0-9a-f]{64}$/)
    assert.equal(JSON.stringify(d).includes(content), false)
  })
  test('send_email detail 含完整正文(批准针对服务端存参 §3②)', () => {
    const d = buildWriteDetail('imap', 'send_email', {
      to: ['a@b.com'],
      subject: 's',
      text: '完整正文'.repeat(100),
    })
    assert.equal(d.kind, 'email')
    assert.equal(String(d.text).length, '完整正文'.repeat(100).length)
  })
  test('未登记 write action 兜底 detail 返回 params 原样', () => {
    const d = buildWriteDetail('x', 'y', { a: 1 })
    assert.deepEqual(d, { kind: 'params', params: { a: 1 } })
  })
})

// ─── 上游错误映射(canary) ───────────────────────────────────────────────

describe('mapUpstreamStatus(不透传上游 body)', () => {
  test('状态映射矩阵', () => {
    assert.equal(mapUpstreamStatus(401, 'x').code, 'UPSTREAM_AUTH_FAILED')
    assert.equal(mapUpstreamStatus(403, 'x').code, 'UPSTREAM_AUTH_FAILED')
    assert.equal(mapUpstreamStatus(404, 'x').code, 'UPSTREAM_NOT_FOUND')
    assert.equal(mapUpstreamStatus(429, 'x').code, 'UPSTREAM_RATE_LIMITED')
    assert.equal(mapUpstreamStatus(500, 'x').code, 'UPSTREAM_ERROR')
    assert.equal(mapUpstreamStatus(418, 'x').code, 'UPSTREAM_ERROR')
  })
})

describe('truncateText / presetImapConfig', () => {
  test('截断标记', () => {
    assert.deepEqual(truncateText('abc', 10), ['abc', false])
    assert.deepEqual(truncateText('abcdef', 3), ['abc', true])
  })
  test('QQ/163 预设;未知域 null', () => {
    assert.equal(presetImapConfig('u@qq.com')?.imapHost, 'imap.qq.com')
    assert.equal(presetImapConfig('u@163.com')?.smtpHost, 'smtp.163.com')
    assert.equal(presetImapConfig('u@foxmail.com')?.imapHost, 'imap.qq.com')
    assert.equal(presetImapConfig('u@corp.example.com'), null)
    assert.equal(presetImapConfig('not-an-email'), null)
  })
})

// ─── RPC 信封 / 401(mock req/res,无 DB) ────────────────────────────────

interface FakeRes {
  statusCode: number
  headers: Record<string, string>
  body: string
  ended: boolean
}

function makeFakeRes(): { res: ServerResponse; state: FakeRes } {
  const state: FakeRes = { statusCode: 200, headers: {}, body: '', ended: false }
  const res = {
    get statusCode() {
      return state.statusCode
    },
    set statusCode(v: number) {
      state.statusCode = v
    },
    headersSent: false,
    setHeader(k: string, v: string) {
      state.headers[k.toLowerCase()] = v
    },
    end(chunk?: string) {
      if (chunk) state.body += chunk
      state.ended = true
    },
    destroy() {
      state.ended = true
    },
  } as unknown as ServerResponse
  return { res, state }
}

function makeFakeReq(opts: {
  method: string
  url: string
  headers?: Record<string, string>
  body?: string
}): IncomingMessage {
  const em = new EventEmitter() as EventEmitter &
    Record<string, unknown> & { [Symbol.asyncIterator]?: unknown }
  em.method = opts.method
  em.url = opts.url
  em.headers = opts.headers ?? {}
  em[Symbol.asyncIterator] = async function* () {
    if (opts.body) yield Buffer.from(opts.body, 'utf8')
  }
  return em as unknown as IncomingMessage
}

const deniedRepo = {
  async findActiveByHostAndBoundIp() {
    return null
  },
}

describe('RPC 信封契约', () => {
  test('容器身份失败 → HTTP 401(唯一非 200 业务外错误面)', async () => {
    const handler = makeConnectorsRpcHandler({ identityRepo: deniedRepo, log: () => {} })
    const { res, state } = makeFakeRes()
    await handler(
      makeFakeReq({
        method: 'POST',
        url: '/v3/connectors/list',
        headers: { authorization: `Bearer oc-v3.1.${'a'.repeat(64)}` },
      }),
      res,
      { hostUuid: 'h', boundIp: '1.2.3.4' },
    )
    assert.equal(state.statusCode, 401)
    const parsed = JSON.parse(state.body) as { error: { code: string } }
    assert.equal(parsed.error.code, 'UNAUTHORIZED')
  })

  test('身份 OK 但 body 非法 → HTTP 200 + {kind:error, code},无多余字段(canary)', async () => {
    const okRepo = {
      async findActiveByHostAndBoundIp() {
        return {
          id: 1,
          user_id: 7,
          bound_ip: '1.2.3.4',
          host_uuid: 'h',
          secret_hash: (await import('node:crypto'))
            .createHash('sha256')
            .update(Buffer.from('b'.repeat(64), 'hex'))
            .digest(),
        }
      },
    }
    // pool 注入 stub:本用例在触达 DB 前就应以 BAD_REQUEST 结束(不许碰 pool)
    const poolStub = new Proxy(
      {},
      {
        get() {
          throw new Error('pool must not be touched for bad-body request')
        },
      },
    ) as never
    const handler = makeConnectorsRpcHandler({
      identityRepo: okRepo,
      pool: poolStub,
      log: () => {},
    })
    const { res, state } = makeFakeRes()
    await handler(
      makeFakeReq({
        method: 'POST',
        url: '/v3/connectors/call',
        headers: { authorization: `Bearer oc-v3.1.${'b'.repeat(64)}` },
        body: '{"connectionId":""}', // 非法:空 id
      }),
      res,
      { hostUuid: 'h', boundIp: '1.2.3.4' },
    )
    assert.equal(state.statusCode, 200) // 业务错误恒 200(CLI 非 2xx 当传输层失败)
    const parsed = JSON.parse(state.body) as Record<string, unknown>
    assert.deepEqual(Object.keys(parsed).sort(), ['code', 'kind'])
    assert.equal(parsed.kind, 'error')
    assert.equal(parsed.code, 'BAD_REQUEST')
  })
})

describe('用户路由 401(handler 内自调 requireAuth)', () => {
  const ctx = {
    requestId: 'r',
    clientIp: '1.1.1.1',
    authBoundIp: '127.0.0.1',
    userAgent: null,
    log: { info() {}, warn() {}, error() {} },
  } as never
  const deps = { jwtSecret: 'test-secret-not-used-to-mint', redis: {} } as never

  test('GET /api/connectors 无 Bearer → HttpError 401', async () => {
    const { res } = makeFakeRes()
    await assert.rejects(
      dispatchConnectorsRoute(
        makeFakeReq({ method: 'GET', url: '/api/connectors', headers: { host: 'x' } }),
        res,
        ctx,
        deps,
      ),
      (e: unknown) => e instanceof HttpError && e.status === 401,
    )
  })

  test('POST /api/connectors/webdav 无 Bearer → 401(先鉴权后校验)', async () => {
    const { res } = makeFakeRes()
    await assert.rejects(
      dispatchConnectorsRoute(
        makeFakeReq({
          method: 'POST',
          url: '/api/connectors/webdav',
          headers: { host: 'x' },
          body: '{}',
        }),
        res,
        ctx,
        deps,
      ),
      (e: unknown) => e instanceof HttpError && e.status === 401,
    )
  })

  test('未知子路由(已鉴权前置的 404 面)→ 非 200', async () => {
    const { res } = makeFakeRes()
    await assert.rejects(
      dispatchConnectorsRoute(
        makeFakeReq({
          method: 'PUT',
          url: '/api/connectors/webdav',
          headers: { host: 'x' },
        }),
        res,
        ctx,
        deps,
      ),
      (e: unknown) => e instanceof HttpError && (e.status === 405 || e.status === 401),
    )
  })
})
