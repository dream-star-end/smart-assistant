/**
 * 连接器平台 · 统一 HTTP driver **对抗测试上游**(P1 切片② 验收核心,无需 PG)。
 *
 * 用受控本地 http 服务器 + mock DNS resolver + 静态 canary 凭据驱动 `engineHttpRequest`,
 * 覆盖 RFC §4/§3.3 的每个强制点:
 *   1. 恶意 redirect(302)→ driver 拒(redirect:error),凭据不跟随。
 *   2. DNS 多址(公网+私网)→ 拒(全记录 global-unicast),凭据未上线。
 *   3. origin ∉ audience → OUTBOUND_BLOCKED 且**凭据未注入**(服务器零收)。
 *   4. 上游 500 body 回显 canary → driver error/log 不含 canary(错误 body 从不读)。
 *   5. query placement → 请求带 token 发出,但 plan/日志/error 里 token 被抹。
 *   6. params 含 CRLF → 构造期拒(header/path 注入)。
 *   7. 结果泄漏:白名单外字段被剥;超限 → RESULT_TOO_LARGE;白名单内 canary 被脱敏。
 *   8. 非法 placement source(client_secret/refresh_token)→ 运行期拒。
 *
 * **总验收断言**:一个 canary secret 跑完所有场景后,收集 mock logger 捕获的
 * 全部 driver 输出(日志 / 返回 result / 抛出 error/stack)里 **grep 不到它**。
 */

import assert from 'node:assert/strict'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, describe, test } from 'node:test'
import { fetch as undiciFetch } from 'undici'
import { ConnectorError } from '../connectors/errors.js'
import {
  type EngineHttpDeps,
  type EngineLogger,
  engineHttpRequest,
  projectResultAllowlist,
} from '../connectors/engine/driver.js'
import { injectCredentials } from '../connectors/engine/placement.js'
import { buildRequestPlan, redactedPlan } from '../connectors/engine/requestPlan.js'
import { redactSecrets, redactUrl } from '../connectors/engine/redact.js'
import type { DnsResolver } from '../connectors/outboundPolicy.js'
import type { ExecActionT, ExecContractT } from '../connectors/spec/types.js'

// ─── canary + 常量 ────────────────────────────────────────────────────────

/** 全测试唯一 canary(既作凭据值,又被上游回显)。跑完必须 grep 不到。 */
const CANARY = 'CANARY-SECRET-4b8f2c1a-DO-NOT-LEAK-e2e7-0123456789abcdef'
const PUBLIC_IP = '93.184.216.34'
const API_ORIGIN_INPUT = 'https://api.example.test'
const API_ORIGIN_NORM = 'https://api.example.test:443'

// ─── 收集 driver 所有对外输出的 sink(总验收断言的证据) ────────────────────

const sink: string[] = []
function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v)
  } catch {
    return String(v)
  }
}

// ─── 受控本地测试服务器 ────────────────────────────────────────────────────

interface CapturedRequest {
  method: string
  path: string
  query: Record<string, string[]>
  headers: Record<string, string | string[] | undefined>
  bodyText: string
}
interface TestServer {
  port: number
  requests: CapturedRequest[]
  setHandler(fn: (req: CapturedRequest) => { status: number; headers?: Record<string, string>; body: string }): void
  reset(): void
  close(): Promise<void>
}

function startTestServer(): Promise<TestServer> {
  return new Promise((resolve) => {
    const requests: CapturedRequest[] = []
    let handler: (req: CapturedRequest) => { status: number; headers?: Record<string, string>; body: string } =
      () => ({ status: 200, headers: { 'content-type': 'application/json' }, body: '{}' })
    const server: Server = createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://127.0.0.1')
      const query: Record<string, string[]> = {}
      for (const [k, v] of u.searchParams) (query[k] ??= []).push(v)
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        const captured: CapturedRequest = {
          method: req.method ?? '',
          path: u.pathname,
          query,
          headers: req.headers,
          bodyText: Buffer.concat(chunks).toString('utf8'),
        }
        requests.push(captured)
        const out = handler(captured)
        res.statusCode = out.status
        for (const [hk, hv] of Object.entries(out.headers ?? { 'content-type': 'application/json' }))
          res.setHeader(hk, hv)
        res.end(out.body)
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      resolve({
        port,
        requests,
        setHandler: (fn) => {
          handler = fn
        },
        reset: () => {
          requests.length = 0
          handler = () => ({ status: 200, headers: { 'content-type': 'application/json' }, body: '{}' })
        },
        close: () => new Promise<void>((r) => server.close(() => r())),
      })
    })
  })
}

/** fetchImpl:把 driver 的 https 目标 URL 改写到本地 http 服务器(保留 path/query/headers)。 */
function localFetch(port: number): NonNullable<EngineHttpDeps['fetchImpl']> {
  return async (input, init) => {
    const u = new URL(input)
    u.protocol = 'http:'
    u.hostname = '127.0.0.1'
    u.port = String(port)
    return undiciFetch(u.toString(), {
      method: init.method as string,
      headers: init.headers as Record<string, string> | undefined,
      body: init.body as string | undefined,
      redirect: (init.redirect as RequestRedirect) ?? 'error',
      signal: init.signal as AbortSignal | undefined,
    }) as unknown as Promise<Response>
  }
}

/** 解析出单一公网地址(happy path DNS 通过)。 */
function okResolver(): DnsResolver {
  return {
    resolve4: async () => [PUBLIC_IP],
    resolve6: async () => {
      const e = new Error('nodata') as NodeJS.ErrnoException
      e.code = 'ENODATA'
      throw e
    },
  }
}
/** 混合应答:公网 + 私网 → 全记录校验必拒(rebinding/切换攻击征兆)。 */
function multiAddrResolver(): DnsResolver {
  return {
    resolve4: async () => [PUBLIC_IP, '10.0.0.5'],
    resolve6: async () => {
      const e = new Error('nodata') as NodeJS.ErrnoException
      e.code = 'ENODATA'
      throw e
    },
  }
}

// ─── ExecContract / ExecAction fixtures(手工构造,便于制造非法边界) ──────────

function makeContract(apiOrigins: string[] = [API_ORIGIN_NORM]): ExecContractT {
  return {
    spec_hash: 'a'.repeat(64),
    auth_contract_version: 1,
    authMode: 'static-token',
    originMode: 'fixed-reviewed',
    credentialAudiencePolicy: {
      authorizationOrigins: [],
      tokenOrigins: [],
      apiOrigins,
      unauthenticatedUploadOrigins: [],
    },
    credentialPipeline: { nodes: [] },
    actions: [],
  } as unknown as ExecContractT
}

interface ActionInit {
  method?: ExecActionT['request']['method']
  pathTemplate?: string
  query?: Record<string, string>
  bodyTemplate?: ExecActionT['request']['bodyTemplate']
  result?: Record<string, unknown>
  placements?: unknown[]
}
function makeAction(init: ActionInit = {}): ExecActionT {
  return {
    id: 'get_thing',
    effect: 'read',
    request: {
      method: init.method ?? 'GET',
      pathTemplate: init.pathTemplate ?? '/v1/things',
      ...(init.query ? { query: init.query } : {}),
      ...(init.bodyTemplate ? { bodyTemplate: init.bodyTemplate } : {}),
    },
    params: { type: 'object', additionalProperties: false, properties: {} },
    result: init.result ?? { type: 'object', additionalProperties: false, properties: { ok: { type: 'string' } } },
    apiCredentialPlacements: (init.placements ?? [
      { source: 'access_token', placement: 'authorization-bearer' },
    ]) as ExecActionT['apiCredentialPlacements'],
  } as unknown as ExecActionT
}

const BEARER_CREDS = { accessToken: CANARY }

// ─── 驱动包装:捕获日志 + result + error 进 sink,返回该次的证据切片 ────────────

interface DriverOutcome {
  result?: unknown
  error?: ConnectorError
  entries: string[]
}
async function callDriver(input: {
  contract: ExecContractT
  action: ExecActionT
  credentialAudience: 'api' | 'token' | 'authorization' | 'upload'
  targetOrigin: string
  resolvedCreds: Record<string, unknown>
  params?: unknown
  deps?: EngineHttpDeps
}): Promise<DriverOutcome> {
  const start = sink.length
  const logger: EngineLogger = (event, fields) => sink.push(`LOG:${safeStringify({ event, fields })}`)
  let result: unknown
  let error: ConnectorError | undefined
  try {
    result = await engineHttpRequest({
      contract: input.contract,
      action: input.action,
      credentialAudience: input.credentialAudience,
      targetOrigin: input.targetOrigin,
      resolvedCreds: input.resolvedCreds,
      params: input.params ?? {},
      deps: { ...(input.deps ?? {}), logger },
    })
    sink.push(`RESULT:${safeStringify(result)}`)
  } catch (e) {
    if (e instanceof ConnectorError) error = e
    sink.push(`ERROR:${String((e as Error)?.message)} :: ${String((e as Error)?.stack ?? '')}`)
  }
  return { result, error, entries: sink.slice(start) }
}

function assertNoCanary(entries: string[], label: string): void {
  for (const e of entries) {
    assert.ok(!e.includes(CANARY), `[${label}] canary leaked into driver output: ${e.slice(0, 120)}…`)
  }
}

// ─── 服务器生命周期 + console 守卫 ─────────────────────────────────────────

let server: TestServer
const origConsole = { log: console.log, error: console.error, warn: console.warn, info: console.info }
before(async () => {
  server = await startTestServer()
  // 守卫:driver 若误用 console 输出,也进 sink 一起被 grep。
  console.log = (...a: unknown[]) => sink.push(`CONSOLE.log:${a.map(safeStringify).join(' ')}`)
  console.error = (...a: unknown[]) => sink.push(`CONSOLE.error:${a.map(safeStringify).join(' ')}`)
  console.warn = (...a: unknown[]) => sink.push(`CONSOLE.warn:${a.map(safeStringify).join(' ')}`)
  console.info = (...a: unknown[]) => sink.push(`CONSOLE.info:${a.map(safeStringify).join(' ')}`)
})
after(async () => {
  Object.assign(console, origConsole)
  await server?.close()
})

// ─── 场景 1:恶意 redirect ──────────────────────────────────────────────────

describe('对抗①:恶意 redirect(302)→ driver 拒,凭据不跟随', () => {
  test('302 → 抛 ConnectorError(UPSTREAM_ERROR),不跟随到 Location', async () => {
    server.reset()
    server.setHandler(() => ({
      status: 302,
      headers: { location: 'https://evil.example.test/stolen' },
      body: 'go',
    }))
    const out = await callDriver({
      contract: makeContract(),
      action: makeAction(),
      credentialAudience: 'api',
      targetOrigin: API_ORIGIN_INPUT,
      resolvedCreds: BEARER_CREDS,
      deps: { resolver: okResolver(), fetchImpl: localFetch(server.port) },
    })
    assert.ok(out.error instanceof ConnectorError)
    assert.equal(out.error.code, 'UPSTREAM_ERROR')
    // 只有初次请求命中服务器;redirect:error 不产生第二次请求(凭据不跟随到 /stolen)。
    assert.equal(server.requests.length, 1)
    assert.equal(server.requests[0]?.path, '/v1/things')
    assertNoCanary(out.entries, '恶意redirect')
  })
})

// ─── 场景 2:DNS 多址 ───────────────────────────────────────────────────────

describe('对抗②:DNS 多址(公网+私网)→ 拒', () => {
  test('resolver 返回 [公网,私网] → OUTBOUND_BLOCKED,凭据未上线', async () => {
    server.reset()
    const out = await callDriver({
      contract: makeContract(),
      action: makeAction(),
      credentialAudience: 'api',
      targetOrigin: API_ORIGIN_INPUT,
      resolvedCreds: BEARER_CREDS,
      deps: { resolver: multiAddrResolver(), fetchImpl: localFetch(server.port) },
    })
    assert.ok(out.error instanceof ConnectorError)
    assert.equal(out.error.code, 'OUTBOUND_BLOCKED')
    // SSRF 在 fetch 前拦截 → 服务器零收(凭据从未离开进程)。
    assert.equal(server.requests.length, 0)
    assertNoCanary(out.entries, 'DNS多址')
  })
})

// ─── 场景 3:origin ∉ audience ──────────────────────────────────────────────

describe('对抗③:origin ∉ apiOrigins → OUTBOUND_BLOCKED 且凭据未注入', () => {
  test('目标 origin 不在受众集 → 阻断,服务器零收(凭据结构上不注入)', async () => {
    server.reset()
    const out = await callDriver({
      contract: makeContract([API_ORIGIN_NORM]), // 只允许 api.example.test
      action: makeAction(),
      credentialAudience: 'api',
      targetOrigin: 'https://evil.example.test', // 目标是别处
      resolvedCreds: BEARER_CREDS,
      deps: { resolver: okResolver(), fetchImpl: localFetch(server.port) },
    })
    assert.ok(out.error instanceof ConnectorError)
    assert.equal(out.error.code, 'OUTBOUND_BLOCKED')
    assert.equal(server.requests.length, 0)
    assertNoCanary(out.entries, 'origin不在audience')
  })
})

// ─── 场景 4:上游 500 回显 token ─────────────────────────────────────────────

describe('对抗④:上游 500 body 含 canary → driver 输出不含 canary', () => {
  test('500 + body 回显 canary → error 稳定码,body 从不读', async () => {
    server.reset()
    server.setHandler(() => ({
      status: 500,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: `boom token=${CANARY}` }),
    }))
    const out = await callDriver({
      contract: makeContract(),
      action: makeAction(),
      credentialAudience: 'api',
      targetOrigin: API_ORIGIN_INPUT,
      resolvedCreds: BEARER_CREDS,
      deps: { resolver: okResolver(), fetchImpl: localFetch(server.port) },
    })
    assert.ok(out.error instanceof ConnectorError)
    assert.equal(out.error.code, 'UPSTREAM_ERROR')
    assert.ok(!out.error.message.includes(CANARY))
    assertNoCanary(out.entries, '500回显token')
  })
})

// ─── 场景 5:query placement ─────────────────────────────────────────────────

describe('对抗⑤:query placement → token 上线但 plan/日志/error 抹掉', () => {
  test('access_token 走 query → 服务器收到 token,driver 输出抹掉 token', async () => {
    server.reset()
    server.setHandler(() => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ok: 'good' }),
    }))
    const out = await callDriver({
      contract: makeContract(),
      action: makeAction({
        placements: [{ source: 'access_token', placement: 'query', name: 'access_token' }],
      }),
      credentialAudience: 'api',
      targetOrigin: API_ORIGIN_INPUT,
      resolvedCreds: BEARER_CREDS,
      deps: { resolver: okResolver(), fetchImpl: localFetch(server.port) },
    })
    // 注入生效:token 到了受众允许的上游(wire 上有 token 是预期,不算泄漏)。
    assert.equal(server.requests.length, 1)
    assert.deepEqual(server.requests[0]?.query.access_token, [CANARY])
    // 但 driver 侧输出(plan/日志/result)不含 token。
    assert.deepEqual(out.result, { ok: 'good' })
    assertNoCanary(out.entries, 'query-token')
  })
})

// ─── 场景 6:CRLF 注入(构造期拒) ───────────────────────────────────────────

describe('对抗⑥:params 含 CRLF → 构造期拒(header/path 注入)', () => {
  test('query 值含 \\r\\n → buildRequestPlan 抛 BAD_REQUEST', () => {
    const action = makeAction({ query: { q: '/params/q' } })
    assert.throws(
      () => buildRequestPlan(action, { q: 'a\r\nX-Injected: 1' }, API_ORIGIN_INPUT),
      (e: unknown) => e instanceof ConnectorError && e.code === 'BAD_REQUEST',
    )
  })
  test('path 占位符值含 CRLF → 构造期拒', () => {
    const action = makeAction({ pathTemplate: '/v1/things/{/params/id}' })
    assert.throws(
      () => buildRequestPlan(action, { id: 'x\r\ninjected' }, API_ORIGIN_INPUT),
      (e: unknown) => e instanceof ConnectorError && e.code === 'BAD_REQUEST',
    )
  })
  test('valuePrefix 含 CRLF → injectCredentials 运行期拒', () => {
    const plan = buildRequestPlan(makeAction(), {}, API_ORIGIN_INPUT)
    assert.throws(
      () =>
        injectCredentials(
          plan,
          [{ source: 'access_token', placement: 'header', name: 'X-Api', valuePrefix: 'p\r\nEvil: 1' }] as never,
          BEARER_CREDS,
        ),
      (e: unknown) => e instanceof ConnectorError && e.code === 'BAD_REQUEST',
    )
  })
  test('params 污染键 __proto__ → 构造期拒', () => {
    const action = makeAction({ query: { q: '/params/q' } })
    const evil = JSON.parse('{"__proto__":{"polluted":1},"q":"ok"}')
    assert.throws(
      () => buildRequestPlan(action, evil, API_ORIGIN_INPUT),
      (e: unknown) => e instanceof ConnectorError && e.code === 'BAD_REQUEST',
    )
  })
})

// ─── 场景 7:结果泄漏 ───────────────────────────────────────────────────────

describe('对抗⑦:结果泄漏 → allowlist 剥字段 / 超限拒 / 白名单内脱敏', () => {
  test('白名单外字段(含 canary)被剥掉', async () => {
    server.reset()
    server.setHandler(() => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ok: 'good', leaked: CANARY, nested: { deep: CANARY } }),
    }))
    const out = await callDriver({
      contract: makeContract(),
      action: makeAction(),
      credentialAudience: 'api',
      targetOrigin: API_ORIGIN_INPUT,
      resolvedCreds: BEARER_CREDS,
      deps: { resolver: okResolver(), fetchImpl: localFetch(server.port) },
    })
    assert.deepEqual(out.result, { ok: 'good' })
    assertNoCanary(out.entries, '白名单外剥字段')
  })

  test('超限数组 → RESULT_TOO_LARGE', async () => {
    server.reset()
    const items = Array.from({ length: 300 }, (_v, i) => ({ v: i }))
    server.setHandler(() => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items }),
    }))
    const out = await callDriver({
      contract: makeContract(),
      action: makeAction({
        result: {
          type: 'object',
          additionalProperties: false,
          properties: {
            items: {
              type: 'array',
              items: { type: 'object', additionalProperties: false, properties: { v: { type: 'number' } } },
            },
          },
        },
      }),
      credentialAudience: 'api',
      targetOrigin: API_ORIGIN_INPUT,
      resolvedCreds: BEARER_CREDS,
      deps: { resolver: okResolver(), fetchImpl: localFetch(server.port) },
    })
    assert.ok(out.error instanceof ConnectorError)
    assert.equal(out.error.code, 'RESULT_TOO_LARGE')
    assertNoCanary(out.entries, '结果超限')
  })

  test('白名单内字段回显 canary(=access_token)→ redactDeep 抹成 [REDACTED]', async () => {
    server.reset()
    server.setHandler(() => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ok: CANARY }),
    }))
    const out = await callDriver({
      contract: makeContract(),
      action: makeAction(),
      credentialAudience: 'api',
      targetOrigin: API_ORIGIN_INPUT,
      resolvedCreds: BEARER_CREDS,
      deps: { resolver: okResolver(), fetchImpl: localFetch(server.port) },
    })
    assert.deepEqual(out.result, { ok: '[REDACTED]' })
    assertNoCanary(out.entries, '白名单内脱敏')
  })
})

// ─── 场景 8:非法 placement source ──────────────────────────────────────────

describe('对抗⑧:client_secret / refresh_token 作 placement source → 运行期拒', () => {
  for (const bad of ['client_secret', 'refresh_token'] as const) {
    test(`source=${bad} → BAD_REQUEST,服务器零收`, async () => {
      server.reset()
      const out = await callDriver({
        contract: makeContract(),
        action: makeAction({
          placements: [{ source: bad, placement: 'header', name: 'X-Secret' }],
        }),
        credentialAudience: 'api',
        targetOrigin: API_ORIGIN_INPUT,
        resolvedCreds: { accessToken: 'ok', clientSecret: CANARY, refreshToken: CANARY },
        deps: { resolver: okResolver(), fetchImpl: localFetch(server.port) },
      })
      assert.ok(out.error instanceof ConnectorError)
      assert.equal(out.error.code, 'BAD_REQUEST')
      assert.equal(server.requests.length, 0)
      assertNoCanary(out.entries, `非法source-${bad}`)
    })
  }

  test('authorization-bearer 配非 access_token(client_id)→ 运行期拒', async () => {
    server.reset()
    const out = await callDriver({
      contract: makeContract(),
      action: makeAction({
        placements: [{ source: 'client_id', placement: 'authorization-bearer' }],
      }),
      credentialAudience: 'api',
      targetOrigin: API_ORIGIN_INPUT,
      resolvedCreds: { accessToken: 'ok', clientId: 'cid-123' },
      deps: { resolver: okResolver(), fetchImpl: localFetch(server.port) },
    })
    assert.ok(out.error instanceof ConnectorError)
    assert.equal(out.error.code, 'BAD_REQUEST')
    assert.equal(server.requests.length, 0)
  })
})

// ─── 补充:纯单元(不接网络) ────────────────────────────────────────────────

describe('requestPlan / redact 纯单元', () => {
  test('buildRequestPlan:path 占位符 + query materialize,targetUrl 正确', () => {
    const action = makeAction({ pathTemplate: '/v1/pages/{/params/id}', query: { limit: '/params/limit' } })
    const plan = buildRequestPlan(action, { id: 'p 1/2', limit: 5 }, API_ORIGIN_INPUT)
    assert.equal(plan.origin, API_ORIGIN_NORM)
    // 空格/斜杠被 encodeURIComponent 中和,不产生新路径段。
    assert.equal(plan.path, '/v1/pages/p%201%2F2')
    assert.equal(plan.targetUrl, `${API_ORIGIN_NORM}/v1/pages/p%201%2F2?limit=5`)
  })

  test('redactedPlan 不含凭据(注入前产物)', () => {
    const plan = buildRequestPlan(makeAction({ query: { q: '/params/q' } }), { q: 'hello' }, API_ORIGIN_INPUT)
    const rp = redactedPlan(plan, [CANARY])
    assert.ok(!JSON.stringify(rp).includes(CANARY))
    assert.equal(rp.method, 'GET')
    assert.equal(rp.origin, API_ORIGIN_NORM)
  })

  test('redactSecrets exact-match 抹;redactUrl 去 query/userinfo', () => {
    assert.equal(redactSecrets(`a ${CANARY} b`, [CANARY]), 'a [REDACTED] b')
    assert.equal(
      redactUrl(`https://u:p@api.example.test/path?access_token=${CANARY}#frag`),
      'https://api.example.test/path',
    )
  })

  test('projectResultAllowlist 剥白名单外字段(直接单元)', () => {
    const schema = { type: 'object', additionalProperties: false, properties: { keep: { type: 'string' } } }
    const projected = projectResultAllowlist(schema, { keep: 'y', drop: CANARY, __proto__: { x: 1 } })
    assert.deepEqual(projected, { keep: 'y' })
  })

  test('body materialize:非 GET + bodyTemplate → JSON body', () => {
    const action = makeAction({
      method: 'POST',
      bodyTemplate: { obj: { title: { ref: '/params/title' }, fixed: { lit: 1 } } },
    })
    const plan = buildRequestPlan(action, { title: 'hi' }, API_ORIGIN_INPUT)
    assert.equal(plan.body, JSON.stringify({ title: 'hi', fixed: 1 }))
    assert.equal(plan.headers['content-type'], 'application/json')
  })
})

// ─── 总验收:canary 从不泄漏 ────────────────────────────────────────────────
// 放在文件末尾;node:test 同文件内 top-level 测试顺序执行,此处 sink 已含全部证据。

describe('总验收:canary 从不出现在任何 driver 输出', () => {
  test('grep 全部 sink(日志/result/error/console)不含 canary', () => {
    assert.ok(sink.length > 0, 'sink 应已累积证据')
    const leaks = sink.filter((e) => e.includes(CANARY))
    assert.deepEqual(
      leaks.map((e) => e.slice(0, 160)),
      [],
      `canary 泄漏点数=${leaks.length}`,
    )
  })
})
