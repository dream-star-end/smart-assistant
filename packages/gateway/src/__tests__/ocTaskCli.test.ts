/**
 * oc-task CLI: 鉴权自举 + 命令规划 + 退出码映射。
 * Run: npx tsx --test packages/gateway/src/__tests__/ocTaskCli.test.ts
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  TASK_CLI_EXIT,
  TASK_CLI_SCHEMA_VERSION,
  exitCodeForHttp,
  planTaskCommand,
  resolveTaskboardEndpoint,
  wrapError,
  wrapSuccess,
} from '../ocTaskCli.js'

function reader(files: Record<string, string>) {
  return (path: string) => {
    const v = files[path]
    if (v === undefined) throw new Error(`missing ${path}`)
    return v
  }
}

describe('resolveTaskboardEndpoint', () => {
  test('reads port + accessToken from openclaude.json when env is empty', () => {
    const readFile = reader({
      '/home/agent/.openclaude/openclaude.json': JSON.stringify({
        gateway: { port: 18790, accessToken: 'from-config' },
      }),
    }) as any
    const got = resolveTaskboardEndpoint({ HOME: '/home/agent' }, readFile)
    assert.deepEqual(got, {
      ok: true,
      endpoint: { baseUrl: 'http://127.0.0.1:18790/api/board', token: 'from-config' },
    })
  })

  test('OPENCLAUDE_HOME + TOKEN_FILE win over config; env port wins', () => {
    const readFile = reader({
      '/custom/openclaude.json': JSON.stringify({
        gateway: { port: 11111, accessToken: 'cfg' },
      }),
      '/secret/token': 'file-token\n',
    }) as any
    const got = resolveTaskboardEndpoint(
      {
        OPENCLAUDE_HOME: '/custom',
        HOME: '/home/agent',
        OPENCLAUDE_GATEWAY_PORT: '19999',
        OPENCLAUDE_GATEWAY_TOKEN_FILE: '/secret/token',
      },
      readFile,
    )
    assert.deepEqual(got, {
      ok: true,
      endpoint: { baseUrl: 'http://127.0.0.1:19999/api/board', token: 'file-token' },
    })
  })

  test('OPENCLAUDE_GATEWAY_TOKEN env wins over file and config', () => {
    const readFile = reader({
      '/home/agent/.openclaude/openclaude.json': JSON.stringify({
        gateway: { port: 18789, accessToken: 'cfg' },
      }),
      '/secret/token': 'file-token',
    }) as any
    const got = resolveTaskboardEndpoint(
      {
        HOME: '/home/agent',
        OPENCLAUDE_GATEWAY_TOKEN: 'env-token',
        OPENCLAUDE_GATEWAY_TOKEN_FILE: '/secret/token',
      },
      readFile,
    )
    assert.equal(got.ok, true)
    if (got.ok) assert.equal(got.endpoint.token, 'env-token')
  })

  test('missing port / missing token → ok:false, never throw', () => {
    const missing = (() => {
      throw new Error('nope')
    }) as any
    const noCfg = resolveTaskboardEndpoint({ HOME: '/home/agent' }, missing)
    assert.equal(noCfg.ok, false)
    if (!noCfg.ok) assert.match(noCfg.error, /port/)

    const noToken = resolveTaskboardEndpoint(
      { HOME: '/home/agent' },
      reader({
        '/home/agent/.openclaude/openclaude.json': JSON.stringify({ gateway: { port: 18789 } }),
      }) as any,
    )
    assert.equal(noToken.ok, false)
    if (!noToken.ok) assert.match(noToken.error, /token/)
  })
})

describe('planTaskCommand', () => {
  test('unknown / empty / help → usage (never a request)', () => {
    assert.equal(planTaskCommand([]).kind, 'usage')
    assert.equal(planTaskCommand(['help']).kind, 'usage')
    assert.equal(planTaskCommand(['bogus']).kind, 'usage')
    assert.equal(planTaskCommand(['ticket']).kind, 'usage')
  })

  test('project list / create', () => {
    assert.deepEqual(planTaskCommand(['project', 'list', '--include-archived']), {
      kind: 'request',
      method: 'GET',
      path: '/projects',
      query: { includeArchived: 'true' },
    })
    const created = planTaskCommand(['project', 'create', '--key', 'OCV5', '--name', 'V5'])
    assert.equal(created.kind, 'request')
    if (created.kind === 'request') {
      assert.equal(created.method, 'POST')
      assert.equal(created.path, '/projects')
      assert.deepEqual(created.body, {
        key: 'OCV5',
        name: 'V5',
        description: null,
        workspace: null,
        labels: [],
      })
    }
  })

  test('ticket get uses server identifier as-is and pulls comments', () => {
    const plan = planTaskCommand(['ticket', 'get', 'OCV5-42'])
    assert.deepEqual(plan, {
      kind: 'request',
      method: 'GET',
      path: '/tickets/OCV5-42',
      extraGets: ['/tickets/OCV5-42/comments'],
    })
  })

  test('ticket create never sends identifier / version / id', () => {
    const plan = planTaskCommand([
      'ticket',
      'create',
      '--project-id',
      'OCV5',
      '--type',
      'bug',
      '--title',
      'login 500',
    ])
    assert.equal(plan.kind, 'request')
    if (plan.kind === 'request') {
      const body = plan.body as Record<string, unknown>
      assert.equal('identifier' in body, false)
      assert.equal('version' in body, false)
      assert.equal('id' in body, false)
      assert.equal(body.projectId, 'OCV5')
      assert.equal(body.title, 'login 500')
    }
  })

  test('ticket update / claim / advance / block / comment require expectedVersion where needed', () => {
    assert.equal(planTaskCommand(['ticket', 'update', 'OCV5-1']).kind, 'usage')
    const upd = planTaskCommand(
      ['ticket', 'update', 'OCV5-1', '--expected-version', '3', '--title', 'new'],
      {},
    )
    assert.deepEqual(upd, {
      kind: 'request',
      method: 'PATCH',
      path: '/tickets/OCV5-1',
      body: { expectedVersion: 3, title: 'new' },
    })

    const claim = planTaskCommand(
      ['ticket', 'claim', 'OCV5-1', '--expected-version', '3', '--owner', 'agent:main'],
      {},
    )
    assert.deepEqual(claim, {
      kind: 'request',
      method: 'POST',
      path: '/tickets/OCV5-1/claim',
      body: { expectedVersion: 3, owner: 'agent:main' },
    })

    const adv = planTaskCommand(
      ['ticket', 'advance', 'OCV5-1', '--expected-version', '4', '--summary', 'fixed'],
      {},
    )
    assert.equal(adv.kind, 'request')
    if (adv.kind === 'request') {
      assert.equal(adv.path, '/tickets/OCV5-1/advance')
      assert.deepEqual(adv.body, { expectedVersion: 4, summary: 'fixed' })
    }

    const block = planTaskCommand(
      ['ticket', 'block', 'OCV5-1', '--expected-version', '4', '--reason', 'blocked by OCV5-7'],
      {},
    )
    assert.equal(block.kind, 'request')
    if (block.kind === 'request') {
      assert.equal(block.path, '/tickets/OCV5-1/block')
    }

    const comment = planTaskCommand(
      ['ticket', 'comment', 'OCV5-1', '--body', 'done, please review'],
      {},
    )
    assert.deepEqual(comment, {
      kind: 'request',
      method: 'POST',
      path: '/tickets/OCV5-1/comment',
      body: { body: 'done, please review' },
    })
  })

  test('ambient OPENCLAUDE_AGENT_ID 自动写入 claim/advance/comment 身份', () => {
    const env = { OPENCLAUDE_AGENT_ID: 'coding-assistant' }
    const claim = planTaskCommand(['ticket', 'claim', 'OCV5-1', '--expected-version', '3'], env)
    assert.equal(claim.kind, 'request')
    if (claim.kind === 'request') {
      assert.equal((claim.body as Record<string, unknown>).owner, 'agent:coding-assistant')
    }

    const adv = planTaskCommand(
      ['ticket', 'advance', 'OCV5-1', '--expected-version', '4', '--summary', 'ok'],
      env,
    )
    assert.equal(adv.kind, 'request')
    if (adv.kind === 'request') {
      assert.equal((adv.body as Record<string, unknown>).owner, 'agent:coding-assistant')
    }

    const comment = planTaskCommand(['ticket', 'comment', 'OCV5-1', '--body', 'done'], env)
    assert.equal(comment.kind, 'request')
    if (comment.kind === 'request') {
      assert.equal((comment.body as Record<string, unknown>).author, 'agent:coding-assistant')
    }
  })

  test('relation add/remove and run list/get', () => {
    assert.deepEqual(
      planTaskCommand(['relation', 'add', 'OCV5-2', '--to', 'OCV5-1', '--kind', 'blocks']),
      {
        kind: 'request',
        method: 'POST',
        path: '/tickets/OCV5-2/relations',
        body: { toTicketId: 'OCV5-1', kind: 'blocks' },
      },
    )
    assert.deepEqual(planTaskCommand(['relation', 'remove', 'rel-9']), {
      kind: 'request',
      method: 'DELETE',
      path: '/relations/rel-9',
    })
    assert.deepEqual(planTaskCommand(['run', 'list', 'OCV5-1', '--status', 'running']), {
      kind: 'request',
      method: 'GET',
      path: '/tickets/OCV5-1/runs',
      query: { status: 'running' },
    })
    assert.deepEqual(planTaskCommand(['run', 'get', 'run-1']), {
      kind: 'request',
      method: 'GET',
      path: '/runs/run-1',
    })
  })

  test('ticket list maps flags to query keys', () => {
    const plan = planTaskCommand([
      'ticket',
      'list',
      '--project-id',
      'OCV5',
      '--status',
      'ready,running',
      '--q',
      'login',
    ])
    assert.deepEqual(plan, {
      kind: 'request',
      method: 'GET',
      path: '/tickets',
      query: { projectId: 'OCV5', status: 'ready,running', q: 'login' },
    })
  })
})

describe('exit codes + schemaVersion', () => {
  test('409 → 5, 423 → 6, other 4xx → 4', () => {
    assert.equal(exitCodeForHttp(409, 'version_conflict'), TASK_CLI_EXIT.versionConflict)
    assert.equal(exitCodeForHttp(423, 'lease_held'), TASK_CLI_EXIT.leaseHeld)
    assert.equal(exitCodeForHttp(403, 'forbidden'), TASK_CLI_EXIT.api)
    assert.equal(exitCodeForHttp(404, 'not_found'), TASK_CLI_EXIT.api)
    assert.equal(TASK_CLI_EXIT.usage, 2)
    assert.equal(TASK_CLI_EXIT.unreachable, 3)
  })

  test('wrapSuccess / wrapError always carry schemaVersion', () => {
    assert.deepEqual(wrapSuccess({ ok: true, ticket: { identifier: 'OCV5-1' } }), {
      schemaVersion: TASK_CLI_SCHEMA_VERSION,
      ok: true,
      ticket: { identifier: 'OCV5-1' },
    })
    assert.equal(wrapError('nope', 'validation').schemaVersion, TASK_CLI_SCHEMA_VERSION)
    assert.equal(JSON.stringify(wrapSuccess({ a: 1 })).includes('\n'), false)
  })
})
