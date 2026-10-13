/**
 * GNSS-X 地学工具市场插件（OCV5-401）：静态规格生成、发布前校验与引擎行为（本地受控上游，不连真实服务）。
 * Run: npx tsx --test packages/commercial/src/__tests__/gnssXBlueprint.test.ts
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, describe, test } from 'node:test'
import { fetch as undiciFetch } from 'undici'

import { DEFAULT_CONNECTORS, isDefaultConnectorSlug } from '../connectors/defaults/index.js'
import { type EngineHttpDeps, engineHttpRequest } from '../connectors/engine/driver.js'
import { validateDeclarativeParams } from '../connectors/engine/params.js'
import { ConnectorError } from '../connectors/errors.js'
import type { DnsResolver } from '../connectors/outboundPolicy.js'
import { compileSpec } from '../connectors/spec/compiler.js'
import type { ExecActionT, ExecContractT } from '../connectors/spec/types.js'
import {
  GNSS_X_DRAWING_TOOLS,
  GNSS_X_EXCLUDED,
  GNSS_X_MAX_ACTIONS,
  GNSS_X_SLUG,
  GNSS_X_TOKEN_PLACEMENT,
  type GnssXSnapshot,
  type GnssXTokenPlacement,
  buildGnssXBlueprint,
  selectedGnssXToolNames,
} from '../marketplace/gnssX/gnssXBlueprint.js'
import { compilePluginBlueprint } from '../marketplace/pluginBlueprint.js'
import { prepareConnectorPublish } from '../marketplace/publishConnectorPipeline.js'
import { connectorRpcErrorEnvelope } from '../plugins/pluginErrorGuidance.js'

const SNAPSHOT_URL = new URL('../marketplace/gnssX/gnssXToolsSnapshot.json', import.meta.url)
const BLUEPRINT_URL = new URL('../marketplace/gnssX/gnss-x.blueprint.json', import.meta.url)
const snapshot = JSON.parse(readFileSync(SNAPSHOT_URL, 'utf8')) as GnssXSnapshot
const API_ORIGIN = 'https://mcp.gnss-x.ac.cn:443'
const CANARY = 'GNSSX-CANARY-TOKEN-7d3f-DO-NOT-LEAK'

function publishBody(placement?: GnssXTokenPlacement): Record<string, unknown> {
  return compilePluginBlueprint(
    buildGnssXBlueprint(snapshot, placement ? { tokenPlacement: placement } : {}),
  )
}

function compiled(placement?: GnssXTokenPlacement): ExecContractT {
  const body = publishBody(placement)
  return compileSpec(body.spec, body.securityDecision).execContract
}

function actionOf(contract: ExecContractT, id: string): ExecActionT {
  const action = contract.actions.find((a) => a.id === id)
  assert.ok(action, `action ${id}`)
  return action
}

/** 遍历模板,收集所有 ref。 */
function refsIn(node: unknown, out: string[] = []): string[] {
  if (node === null || typeof node !== 'object') return out
  const t = node as Record<string, unknown>
  if (typeof t.ref === 'string') out.push(t.ref)
  for (const value of Object.values(t)) refsIn(value, out)
  return out
}

describe('GNSS-X blueprint generation', () => {
  test('committed gnss-x.blueprint.json is exactly what the generator builds', () => {
    const committed = readFileSync(BLUEPRINT_URL, 'utf8')
    assert.equal(committed, `${JSON.stringify(buildGnssXBlueprint(snapshot), null, 2)}\n`)
  })

  test('selects at most 60 of the 102 tools, never drawing or databox tools', () => {
    assert.equal(snapshot.tools.length, 102)
    const selected = selectedGnssXToolNames(snapshot)
    assert.ok(selected.length <= GNSS_X_MAX_ACTIONS)
    assert.equal(selected.length, 60)
    assert.equal(GNSS_X_DRAWING_TOOLS.length, 20)
    for (const name of [...GNSS_X_DRAWING_TOOLS, 'databox_weather', 'databox_sounding'])
      assert.equal(selected.includes(name), false, name)
    for (const [name, reason] of Object.entries(GNSS_X_EXCLUDED))
      assert.ok(reason.length > 0 && !selected.includes(name), name)
    assert.equal(selected.length + GNSS_X_DRAWING_TOOLS.length + Object.keys(GNSS_X_EXCLUDED).length, 102)
  })

  test('passes the existing plugin publish pipeline: one origin, bearer token, all read', () => {
    const prepared = prepareConnectorPublish(publishBody())
    assert.equal(prepared.ok, true, JSON.stringify(prepared))
    if (!prepared.ok) return
    assert.equal(prepared.slug, 'gnss-x')
    assert.match(prepared.version, /^\d+\.\d+\.\d+$/)
    assert.equal(prepared.permissionSummary.authMode, 'static-token')
    assert.deepEqual(prepared.permissionSummary.requiredCredentialSources, ['access_token'])
    assert.deepEqual(prepared.permissionSummary.origins, {
      authorizationOrigins: [],
      tokenOrigins: [],
      apiOrigins: [API_ORIGIN],
      unauthenticatedUploadOrigins: [],
    })
    assert.deepEqual(prepared.permissionSummary.credentialPlacements, [
      { source: 'access_token', placement: 'authorization-bearer' },
    ])
    assert.equal(prepared.permissionSummary.actions.length, 60)
    for (const action of prepared.permissionSummary.actions)
      assert.deepEqual([action.method, action.effect], ['POST', 'read'], action.id)
    assert.equal(
      prepared.riskFlags.some((flag) => flag.block),
      false,
    )
    assert.deepEqual(prepared.permissionSummary.identity, {
      probeActionId: 'time',
      accountKeyPointer: '/jsonrpc',
    })
  })

  test('every action is POST /rpc tools/call with a fixed name and params-only arguments', () => {
    const body = publishBody()
    const spec = body.spec as {
      actions: Array<{
        id: string
        request: { method: string; pathTemplate: string; bodyTemplate: any }
        params: { properties?: Record<string, unknown>; additionalProperties?: boolean }
      }>
    }
    for (const action of spec.actions) {
      assert.equal(action.request.method, 'POST')
      assert.equal(action.request.pathTemplate, '/rpc')
      const t = action.request.bodyTemplate.obj
      assert.deepEqual(t.jsonrpc, { lit: '2.0' })
      assert.deepEqual(t.method, { lit: 'tools/call' })
      assert.deepEqual(t.params.obj.name, { lit: action.id })
      const args = t.params.obj.arguments.obj as Record<string, unknown>
      const declared = Object.keys(action.params.properties ?? {})
      assert.deepEqual(Object.keys(args), declared, action.id)
      for (const [name, value] of Object.entries(args))
        assert.deepEqual(value, { ref: `/params/${name}` }, `${action.id}.${name}`)
      assert.deepEqual(
        refsIn(action.request.bodyTemplate).sort(),
        declared.map((name) => `/params/${name}`).sort(),
      )
      assert.equal(action.params.additionalProperties, false)
    }
  })

  test('the token placement is one constant; header or query compile without other edits', () => {
    assert.deepEqual(GNSS_X_TOKEN_PLACEMENT, { type: 'bearer' })
    assert.deepEqual(actionOf(compiled(), 'time').apiCredentialPlacements, [
      { source: 'access_token', placement: 'authorization-bearer' },
    ])
    const header = compiled({ type: 'header', name: 'X-API-Key' })
    for (const action of header.actions)
      assert.deepEqual(action.apiCredentialPlacements, [
        { source: 'access_token', placement: 'header', name: 'X-API-Key' },
      ])
    assert.deepEqual(actionOf(compiled({ type: 'query', name: 'token' }), 'time').apiCredentialPlacements, [
      { source: 'access_token', placement: 'query', name: 'token' },
    ])
  })

  test('market only: not a preinstalled default connector', () => {
    assert.equal(isDefaultConnectorSlug(GNSS_X_SLUG), false)
    assert.equal(
      DEFAULT_CONNECTORS.some((d) => d.spec.id === GNSS_X_SLUG),
      false,
    )
  })

  test('Chinese copy tells the user to register and claim their own Token', () => {
    const blueprint = buildGnssXBlueprint(snapshot)
    const description = String(blueprint.description)
    assert.match(description, /需要用户自己在 https:\/\/mcp\.gnss-x\.ac\.cn 注册账号并领取 Token/)
    assert.match(description, /-32001/)
    assert.match(description, /256KB/)
    assert.doesNotMatch(description, /\n/)
    assert.match(String(blueprint.humanMd), /## 使用前准备：需要你自己注册并领取 Token/)
  })

  test('signed params bound the inputs that drive result size', () => {
    const contract = compiled()
    const kp = actionOf(contract, 'kp_index')
    assert.deepEqual(validateDeclarativeParams(kp, { limit: 24 }), { limit: 24 })
    assert.throws(() => validateDeclarativeParams(kp, { limit: 500 }), isCode('VALIDATION_FAILED'))
    assert.throws(() => validateDeclarativeParams(kp, { nope: 1 }), isCode('VALIDATION_FAILED'))
    const ionosonde = actionOf(contract, 'ionosonde')
    assert.throws(() => validateDeclarativeParams(ionosonde, { days: 31 }), isCode('VALIDATION_FAILED'))
    assert.throws(
      () => validateDeclarativeParams(ionosonde, { bin_minutes: 7 }),
      isCode('VALIDATION_FAILED'),
    )
    // 上游 anyOf(字符串/对象)按字符串签名:对象以 JSON 字符串传。
    const coor = actionOf(contract, 'coor')
    validateDeclarativeParams(coor, {
      input_type: 'wgs84',
      input_value: '{"lon":114.3,"lat":30.5,"h":20}',
      operation: 'convert',
    })
    assert.throws(
      () => validateDeclarativeParams(coor, { input_type: 'wgs84', operation: 'convert' }),
      isCode('VALIDATION_FAILED'),
    )
    validateDeclarativeParams(actionOf(contract, 'time'), {})
  })
})

function isCode(code: string) {
  return (e: unknown) => e instanceof ConnectorError && e.code === code
}

// ─── 引擎:本地受控上游(Token 用 canary,不连真实服务)────────────────────────

interface Captured {
  method: string
  path: string
  headers: Record<string, string | string[] | undefined>
  body: string
}

let server: Server
let port = 0
const requests: Captured[] = []
let reply: () => { status: number; body: string } = () => ({ status: 200, body: '{}' })

before(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      requests.push({
        method: req.method ?? '',
        path: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      })
      const out = reply()
      res.statusCode = out.status
      res.setHeader('content-type', 'application/json')
      res.end(out.body)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

const resolver: DnsResolver = {
  resolve4: async () => ['93.184.216.34'],
  resolve6: async () => {
    const e = new Error('nodata') as NodeJS.ErrnoException
    e.code = 'ENODATA'
    throw e
  },
}

function deps(): EngineHttpDeps {
  return {
    resolver,
    fetchImpl: async (input, init) => {
      const u = new URL(input)
      u.protocol = 'http:'
      u.hostname = '127.0.0.1'
      u.port = String(port)
      return undiciFetch(u.toString(), {
        method: init.method as string,
        headers: init.headers as Record<string, string> | undefined,
        body: init.body as string | undefined,
        redirect: 'error',
      }) as unknown as Promise<Response>
    },
  }
}

async function call(id: string, params: Record<string, unknown>): Promise<unknown> {
  const contract = compiled()
  return engineHttpRequest({
    contract,
    action: actionOf(contract, id),
    credentialAudience: 'api',
    targetOrigin: contract.credentialAudiencePolicy.apiOrigins[0]!,
    resolvedCreds: { accessToken: CANARY },
    params,
    deps: deps(),
  })
}

describe('GNSS-X through the connector engine (mock upstream)', () => {
  test('sends Bearer token and a JSON-RPC tools/call; omitted optional args are dropped', async () => {
    requests.length = 0
    reply = () => ({
      status: 200,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: { content: [{ type: 'text', text: '{"week":2388,"tow":172800}' }], isError: false },
        leak: 'stripped',
      }),
    })
    const result = await call('gpst_utc', { operation: 'utc_to_gpst', time: '2025-10-13T00:00:00Z' })
    assert.equal(requests.length, 1)
    const req = requests[0]!
    assert.equal(req.method, 'POST')
    assert.equal(req.path, '/rpc')
    assert.equal(req.headers.authorization, `Bearer ${CANARY}`)
    assert.deepEqual(JSON.parse(req.body), {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'gpst_utc',
        arguments: { operation: 'utc_to_gpst', time: '2025-10-13T00:00:00Z' },
      },
    })
    assert.deepEqual(result, {
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: '{"week":2388,"tow":172800}' }], isError: false },
    })
  })

  test('HTTP 401 with JSON-RPC -32001 → UPSTREAM_AUTH_FAILED, guidance says check Token or quota', async () => {
    reply = () => ({
      status: 401,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32001, message: `Missing or invalid API key ${CANARY}` },
      }),
    })
    await assert.rejects(call('time', {}), (e: unknown) => {
      assert.ok(e instanceof ConnectorError)
      assert.equal(e.code, 'UPSTREAM_AUTH_FAILED')
      assert.doesNotMatch(e.message, new RegExp(CANARY))
      return true
    })
    const envelope = connectorRpcErrorEnvelope('UPSTREAM_AUTH_FAILED')
    assert.equal(envelope.requiresReauth, true)
    assert.match(envelope.message, /Token/)
    assert.match(envelope.message, /配额/)
    assert.match(envelope.nextAction, /检查 Token 是否有效、配额是否用完/)
    assert.match(envelope.nextAction, /管理中心 → 插件/)
  })

  test('HTTP 200 carrying error -32001 reaches the agent as result.error', async () => {
    reply = () => ({
      status: 200,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32001, message: 'quota exhausted', data: { internal: 'x' } },
      }),
    })
    assert.deepEqual(await call('kp_index', { limit: 3 }), {
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32001, message: 'quota exhausted' },
    })
  })

  test('HTTP 429 → UPSTREAM_RATE_LIMITED with quota guidance', async () => {
    reply = () => ({ status: 429, body: '{}' })
    await assert.rejects(call('time', {}), isCode('UPSTREAM_RATE_LIMITED'))
    assert.match(connectorRpcErrorEnvelope('UPSTREAM_RATE_LIMITED').nextAction, /配额/)
  })

  test('results over the platform cap fail closed with RESULT_TOO_LARGE', async () => {
    reply = () => ({
      status: 200,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: { content: [{ type: 'text', text: 'x'.repeat(300 * 1024) }] },
      }),
    })
    await assert.rejects(call('msis_profile', {
      datetime: '2025-10-13T00:00:00Z',
      latitude_deg: 30,
      longitude_deg: 114,
      height_range_km: '[100,1000]',
    }), isCode('RESULT_TOO_LARGE'))
    assert.match(connectorRpcErrorEnvelope('RESULT_TOO_LARGE').nextAction, /增大步长/)
  })
})
