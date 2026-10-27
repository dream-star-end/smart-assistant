/**
 * 插件启用开关（OCV5-383，管理中心 → 插件 一级列表的开关）在 master 侧的生效面：
 *   - 偏好 schema：disabled_plugins 只收合法 slug、去重、≤200；
 *   - 容器 RPC：/v3/plugins/state 回答启用状态（给 plugin-exec 用）；list 隐藏已停用插件；
 *     运行时门面抛 PLUGIN_DISABLED 时 call 信封给出稳定码与中文指引（不落到 CONNECTION_ERROR）。
 *
 * Run: npx tsx --test packages/commercial/src/__tests__/pluginEnablement.test.ts
 */
import * as assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, test } from 'node:test'
import { makeConnectorsRpcHandler } from '../connectors/rpc.js'
import { type PluginEnablement, defaultOffPlugins, effectiveDisabledPlugins } from '../plugins/enablement.js'
import { PluginRuntimeFacadeError } from '../plugins/runtime.js'
import { PreferencesPatchSchema, PreferencesSchema } from '../user/preferences.js'

function makeFakeRes() {
  const state = { statusCode: 200, headers: {} as Record<string, string>, body: '', ended: false }
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
  } as unknown as ServerResponse
  return { res, state }
}

function makeFakeReq(url: string, body: unknown): IncomingMessage {
  const em = new EventEmitter() as EventEmitter & Record<string, unknown> & { [Symbol.asyncIterator]?: unknown }
  em.method = 'POST'
  em.url = url
  em.headers = { authorization: `Bearer oc-v3.1.${'b'.repeat(64)}` }
  em[Symbol.asyncIterator] = async function* () {
    yield Buffer.from(JSON.stringify(body), 'utf8')
  }
  return em as unknown as IncomingMessage
}

const okRepo = {
  async findActiveByHostAndBoundIp() {
    return {
      id: 1,
      user_id: 7,
      bound_ip: '1.2.3.4',
      host_uuid: 'h',
      secret_hash: createHash('sha256').update(Buffer.from('b'.repeat(64), 'hex')).digest(),
    }
  },
}

const disabledFor = (...slugs: string[]): PluginEnablement & { calls: unknown[] } => {
  const calls: unknown[] = []
  return {
    calls,
    async disabledSet(userId) {
      calls.push(userId)
      return new Set(slugs)
    },
  }
}

/** 空 DB：list 路径里的声明式 / v1 / github 查询都返回空。 */
const emptyPool = { query: async () => ({ rows: [], rowCount: 0 }) } as never

async function rpc(handler: ReturnType<typeof makeConnectorsRpcHandler>, url: string, body: unknown) {
  const { res, state } = makeFakeRes()
  await handler(makeFakeReq(url, body), res, { hostUuid: 'h', boundIp: '1.2.3.4' })
  return { status: state.statusCode, body: JSON.parse(state.body) as Record<string, unknown> }
}

describe('偏好 disabled_plugins', () => {
  test('合法 slug 列表通过；null 表示删除该键', () => {
    assert.ok(PreferencesSchema.safeParse({ disabled_plugins: ['ths', 'knowledge-planet', 'imap'] }).success)
    assert.ok(PreferencesPatchSchema.safeParse({ disabled_plugins: null }).success)
    assert.ok(PreferencesPatchSchema.safeParse({ disabled_plugins: [] }).success)
  })
  test('非法 slug、重复、超过 200 个都拒绝（不悄悄修）', () => {
    assert.equal(PreferencesPatchSchema.safeParse({ disabled_plugins: ['../x'] }).success, false)
    assert.equal(PreferencesPatchSchema.safeParse({ disabled_plugins: ['THS'] }).success, false)
    assert.equal(PreferencesPatchSchema.safeParse({ disabled_plugins: ['ths', 'ths'] }).success, false)
    const many = Array.from({ length: 201 }, (_, i) => `p${i}`)
    assert.equal(PreferencesPatchSchema.safeParse({ disabled_plugins: many }).success, false)
  })
})

describe('默认关闭的插件（OCV5-388，env OC_PLUGINS_DEFAULT_OFF）', () => {
  test('env 未设置 = 没有默认关闭的插件；非法 slug 忽略', () => {
    assert.deepEqual([...defaultOffPlugins({})], [])
    assert.deepEqual([...defaultOffPlugins({ OC_PLUGINS_DEFAULT_OFF: '' })], [])
    assert.deepEqual([...defaultOffPlugins({ OC_PLUGINS_DEFAULT_OFF: ' ths , ../x,THS,zhihu' })], ['ths', 'zhihu'])
  })
  test('没打开过 = 停用；打开过 = 启用；用户自己停用的照旧停用', () => {
    const off = new Set(['ths'])
    assert.deepEqual([...effectiveDisabledPlugins({}, off)], ['ths'])
    assert.deepEqual([...effectiveDisabledPlugins({ enabled_plugins: ['ths'] }, off)], [])
    assert.deepEqual([...effectiveDisabledPlugins({ disabled_plugins: ['imap'] }, off)].sort(), ['imap', 'ths'])
    assert.deepEqual(
      [...effectiveDisabledPlugins({ disabled_plugins: ['ths'], enabled_plugins: ['ths'] }, off)],
      ['ths'],
    )
  })
  test('没有默认关闭的插件时与原来一样：只看 disabled_plugins', () => {
    assert.deepEqual([...effectiveDisabledPlugins({ disabled_plugins: ['imap'], enabled_plugins: ['ths'] }, new Set())], [
      'imap',
    ])
  })
  test('偏好 enabled_plugins 与 disabled_plugins 同样校验', () => {
    assert.ok(PreferencesPatchSchema.safeParse({ enabled_plugins: ['ths'] }).success)
    assert.ok(PreferencesPatchSchema.safeParse({ enabled_plugins: null }).success)
    assert.ok(PreferencesSchema.safeParse({ enabled_plugins: ['ths'], disabled_plugins: [] }).success)
    assert.equal(PreferencesPatchSchema.safeParse({ enabled_plugins: ['THS'] }).success, false)
    assert.equal(PreferencesPatchSchema.safeParse({ enabled_plugins: ['ths', 'ths'] }).success, false)
  })
})

describe('容器 RPC 的启用开关', () => {
  test('/v3/plugins/state：按当前容器的用户回答 enabled', async () => {
    const enablement = disabledFor('ths')
    const handler = makeConnectorsRpcHandler({ identityRepo: okRepo, pool: emptyPool, pluginEnablement: enablement, log: () => {} })
    assert.deepEqual((await rpc(handler, '/v3/plugins/state', { slug: 'ths' })).body, { kind: 'state', slug: 'ths', enabled: false })
    assert.deepEqual((await rpc(handler, '/v3/plugins/state', { slug: 'weibo' })).body, { kind: 'state', slug: 'weibo', enabled: true })
    assert.deepEqual(enablement.calls, [7, 7])
  })

  test('/v3/plugins/state：slug 不合法 → BAD_REQUEST 信封（HTTP 200）', async () => {
    const handler = makeConnectorsRpcHandler({ identityRepo: okRepo, pool: emptyPool, pluginEnablement: disabledFor(), log: () => {} })
    const r = await rpc(handler, '/v3/plugins/state', { slug: '../etc' })
    assert.equal(r.status, 200)
    assert.equal(r.body.kind, 'error')
    assert.equal(r.body.code, 'BAD_REQUEST')
  })

  test('/v3/plugins/list：已停用插件的目标不出现在 Agent 可调用列表里', async () => {
    const target = (provider: string) => ({
      id: `p-${provider}`,
      provider,
      pluginType: 'managed-browser' as const,
      displayName: provider,
      accountHint: '',
      status: 'active' as const,
      actions: [],
    })
    const handler = makeConnectorsRpcHandler({
      identityRepo: okRepo,
      pool: emptyPool,
      pluginEnablement: disabledFor('weibo'),
      pluginFacade: {
        catalog: async () => [],
        list: async () => [target('weibo'), target('zhihu')],
        classifyTarget: async () => null,
        actionEffect: async () => 'read',
        proposeWrite: async () => {
          throw new Error('unexpected')
        },
        executeConfirmedWrite: async () => {
          throw new Error('unexpected')
        },
        call: async () => {
          throw new Error('unexpected')
        },
      },
      log: () => {},
    })
    const r = await rpc(handler, '/v3/plugins/list', {})
    const providers = (r.body.plugins as { provider: string }[]).map((p) => p.provider)
    assert.deepEqual(providers, ['zhihu'])
  })

  test('/v3/plugins/call：运行时门面判定已停用 → 稳定码 PLUGIN_DISABLED + 中文指引', async () => {
    const handler = makeConnectorsRpcHandler({
      identityRepo: okRepo,
      pool: emptyPool,
      pluginEnablement: disabledFor('weibo'),
      pluginFacade: {
        catalog: async () => [],
        list: async () => [],
        classifyTarget: async () => 'managed-browser',
        actionEffect: async () => 'read',
        proposeWrite: async () => {
          throw new Error('unexpected')
        },
        executeConfirmedWrite: async () => {
          throw new Error('unexpected')
        },
        call: async () => {
          throw new PluginRuntimeFacadeError('PLUGIN_DISABLED', 'Plugin weibo is disabled by the user')
        },
      },
      log: () => {},
    })
    const r = await rpc(handler, '/v3/plugins/call', { connectionId: '41', action: 'search', params: {} })
    assert.equal(r.body.kind, 'error')
    assert.equal(r.body.code, 'PLUGIN_DISABLED')
    assert.match(String(r.body.message), /插件已停用/)
    assert.match(String(r.body.nextAction), /管理中心 → 插件/)
  })

  test('没有注入启用开关（旧装配 / 旧测试）时一切照旧：state 回答 enabled', async () => {
    const handler = makeConnectorsRpcHandler({ identityRepo: okRepo, pool: emptyPool, log: () => {} })
    assert.deepEqual((await rpc(handler, '/v3/plugins/state', { slug: 'ths' })).body, { kind: 'state', slug: 'ths', enabled: true })
  })
})


test('/v3/plugins/describe routes managed schema and errors through the canonical plugin surface', async () => {
  let disabled = false
  const handler = makeConnectorsRpcHandler({
    identityRepo: okRepo, pool: emptyPool, log: () => {},
    pluginFacade: {
      catalog: async () => [], list: async () => [], classifyTarget: async () => 'managed-browser',
      actionEffect: async () => { throw new Error('must not execute') },
      call: async () => { throw new Error('must not execute') },
      proposeWrite: async () => { throw new Error('must not execute') },
      executeConfirmedWrite: async () => { throw new Error('must not execute') },
      describe: async (input) => {
        assert.deepEqual(input, { userId: 7, targetId: '41', actionId: 'get_self' })
        if (disabled) throw new PluginRuntimeFacadeError('PLUGIN_DISABLED')
        return { kind: 'describe', provider: 'weibo', action: 'get_self', description: '当前账号', readOnly: true, params: { type: 'object' } }
      },
    },
  })
  const request = { connectionId: '41', action: 'get_self' }
  assert.deepEqual((await rpc(handler, '/v3/plugins/describe', request)).body,
    { kind: 'describe', provider: 'weibo', action: 'get_self', description: '当前账号', readOnly: true, params: { type: 'object' } })
  disabled = true
  const response = await rpc(handler, '/v3/plugins/describe', request)
  assert.equal(response.body.code, 'PLUGIN_DISABLED')
  assert.match(String(response.body.nextAction), /管理中心/)
})
