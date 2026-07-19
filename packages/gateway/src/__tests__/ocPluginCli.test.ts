import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'

import { runOcPluginCli } from '../ocConnectCli.js'
import { callConnectors } from '../ocConnectorsClient.js'

describe('oc-plugin shared CLI surface', () => {
  test('uses Plugin nouns and response keys without changing the oc-connect core', async () => {
    const help = await runOcPluginCli(['help'], { transport: async () => ({}) })
    assert.match(help.stdout, /Usage: oc-plugin/)
    assert.doesNotMatch(help.stdout, /Usage: oc-connect/)
    assert.match(help.stdout, /--confirm/)
    assert.match(help.stdout, /确认卡批准的 Plugin 写操作/)

    const list = await runOcPluginCli(['list'], {
      transport: async () => ({
        plugins: [
          {
            id: 'plugin:51',
            provider: 'local-reader',
            displayName: 'Local Reader',
            status: 'active',
            pluginType: 'sandboxed-local',
            actions: [{ id: 'read', readOnly: true }],
          },
        ],
      }),
    })
    assert.match(list.stdout, /可调用的插件/)
    assert.match(list.stdout, /local-reader/)
    assert.match(list.stdout, /plugin:51/)
  })

  test('shows managed account write mode so the Agent does not invent a second confirmation', async () => {
    const list = await runOcPluginCli(['list'], {
      transport: async () => ({
        plugins: [
          {
            id: '3',
            provider: 'weibo',
            displayName: '微博',
            status: 'active',
            pluginType: 'managed-browser',
            writeMode: 'account_preapproval',
            actions: [
              { id: 'get_self', description: '读取当前账号', readOnly: true },
              { id: 'create_post', description: '发布微博', readOnly: false },
            ],
          },
          {
            id: '4',
            provider: 'knowledge-planet',
            displayName: '知识星球',
            status: 'active',
            pluginType: 'managed-browser',
            writeMode: 'confirm_each',
            actions: [{ id: 'create_topic', description: '发布主题', readOnly: false }],
          },
          {
            id: '5',
            provider: 'read-only-browser',
            displayName: '只读网页',
            status: 'active',
            pluginType: 'managed-browser',
            writeMode: 'disabled',
            actions: [{ id: 'read', description: '读取', readOnly: true }],
          },
        ],
      }),
    })
    assert.match(list.stdout, /写入模式: 账号免逐次确认（写操作直接执行，不展示确认卡）/)
    assert.match(list.stdout, /create_post {2}\[写·账号免确认\]/)
    assert.match(list.stdout, /写入模式: 逐次确认（写操作先展示确认卡）/)
    assert.match(list.stdout, /create_topic {2}\[写·需确认\]/)
    assert.match(list.stdout, /写入模式: 关闭（仅可读取）/)
  })

  test('passes declarative Plugin write confirmation without reading stdin', async () => {
    let stdinRead = false
    const calls: Array<{ op: string; body: unknown }> = []
    const result = await runOcPluginCli(
      ['call', 'webdav', 'put_file', '--account', '41', '--confirm', 'opaque'],
      {
        readStdin: async () => {
          stdinRead = true
          return '{"ignored":true}'
        },
        transport: async (op, body) => {
          calls.push({ op, body })
          return { kind: 'result', result: { done: true } }
        },
      },
    )
    assert.equal(result.exitCode, 0)
    assert.equal(stdinRead, false)
    assert.deepEqual(calls, [
      {
        op: 'call',
        body: { connectionId: '41', action: 'put_file', confirmId: 'opaque' },
      },
    ])
  })

  test('reads params from stdin and auto-selects a Plugin target', async () => {
    const calls: Array<{ op: string; body: unknown }> = []
    const output = await runOcPluginCli(['call', 'browser-reader', 'search'], {
      readStdin: async () => '{"q":"hello"}',
      transport: async (op, body) => {
        calls.push({ op, body })
        if (op === 'list')
          return { plugins: [{ id: '41', provider: 'browser-reader', displayName: 'Browser' }] }
        return { kind: 'result', result: { ok: true } }
      },
    })
    assert.equal(output.exitCode, 0)
    assert.deepEqual(calls, [
      { op: 'list', body: {} },
      { op: 'call', body: { connectionId: '41', action: 'search', params: { q: 'hello' } } },
    ])
  })

  test('transport selects /v3/plugins and shell wrapper stays a thin pinned entry', async () => {
    let url = ''
    await callConnectors(
      'list',
      {},
      {
        surface: 'plugins',
        env: {
          OPENCLAUDE_V3_MASTER_BASE_URL: 'http://master.internal',
          OPENCLAUDE_V3_CONTAINER_TOKEN: 'token-value',
        },
        fetchImpl: (async (input: string | URL | Request) => {
          url = String(input)
          return new Response('{"plugins":[]}', { status: 200 })
        }) as typeof fetch,
      },
    )
    assert.equal(url, 'http://master.internal/v3/plugins/list')

    const shell = readFileSync(
      'packages/commercial/agent-sandbox/platform-runtime/bin/oc-plugin.sh',
      'utf8',
    )
    assert.match(shell, /ocPluginCli\.ts/)
    assert.match(shell, /readlink -f/)
    assert.doesNotMatch(shell, /OPENCLAUDE_V3_CONTAINER_TOKEN=/)
  })
})
