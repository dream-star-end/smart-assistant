/**
 * oc-task CLI: 鉴权自举 + 命令规划 + 退出码映射。
 * Run: npx tsx --test packages/gateway/src/__tests__/ocTaskCli.test.ts
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  TASK_CLI_EXIT,
  TASK_CLI_SCHEMA_VERSION,
  buildNdjsonLines,
  createStreamWriter,
  exitCodeForHttp,
  isEpipe,
  planTaskCommand,
  resolveTaskboardEndpoint,
  slimListItem,
  slimListPayload,
  splitListPayload,
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

    const approve = planTaskCommand(
      ['ticket', 'approve', 'OCV5-1', '--expected-version', '3', '--owner', 'agent:main'],
      {},
    )
    assert.deepEqual(approve, {
      kind: 'request',
      method: 'POST',
      path: '/tickets/OCV5-1/approve',
      body: { expectedVersion: 3, owner: 'agent:main' },
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

    const approve = planTaskCommand(['ticket', 'approve', 'OCV5-1', '--expected-version', '3'], env)
    assert.equal(approve.kind, 'request')
    if (approve.kind === 'request') {
      assert.equal((approve.body as Record<string, unknown>).owner, 'agent:coding-assistant')
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
      // OCV5-165: list 默认瘦身、非 ndjson
      ndjson: false,
      slim: true,
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

/** 造 n 张带长 body 的卡,复现宽列表溢出 64KiB 管道缓冲的场景。 */
function fatTickets(n: number, bodyLen = 2000) {
  return Array.from({ length: n }, (_, i) => ({
    id: `id-${i}`,
    identifier: `OCV5-${100 + i}`,
    title: `ticket ${i}`,
    status: 'open',
    version: 1,
    // 带引号/换行/中文/反斜杠:截断时最容易断在字符串中间的形状
    body: `第${i}行说明 "quoted" \\ 反斜杠\n${'长'.repeat(bodyLen)}`,
  }))
}

const PIPE_BUF = 65536

describe('ticket list — 64KiB stdout truncation (OCV5-165)', () => {
  test('plan: --ndjson / --full 映射到 ndjson+slim,默认 slim 开、ndjson 关', () => {
    const dflt = planTaskCommand(['ticket', 'list', '--limit', '50'])
    assert.equal(dflt.kind, 'request')
    assert.equal((dflt as any).ndjson, false)
    assert.equal((dflt as any).slim, true)

    const nd = planTaskCommand(['ticket', 'list', '--limit', '50', '--ndjson'])
    assert.equal((nd as any).ndjson, true)
    assert.equal((nd as any).slim, true)

    const full = planTaskCommand(['ticket', 'list', '--full'])
    assert.equal((full as any).slim, false)

    // --ndjson/--full 是布尔旗,不能被吞成 --limit 的值
    assert.deepEqual((planTaskCommand(['ticket', 'list', '--ndjson']) as any).query, {})
  })

  test('60 张长 body 卡:ndjson 每行独立可 parse,且逐行都在管道缓冲以内', () => {
    const payload = { items: fatTickets(60), total: 60 }
    const lines = buildNdjsonLines(payload, { slim: false })

    assert.equal(lines.length, 61) // 1 meta + 60 item
    const meta = JSON.parse(lines[0])
    assert.equal(meta.kind, 'meta')
    assert.equal(meta.count, 60)
    assert.equal(meta.total, 60)
    assert.equal(meta.itemsKey, 'items')
    assert.equal(meta.schemaVersion, TASK_CLI_SCHEMA_VERSION)

    // 关键不变量:每一行都能单独 JSON.parse,没有跨行的字符串
    for (let i = 1; i < lines.length; i++) {
      const rec = JSON.parse(lines[i])
      assert.equal(rec.kind, 'item')
      assert.equal(rec.item.identifier, `OCV5-${100 + (i - 1)}`)
      assert.ok(rec.item.body.includes('"quoted"'))
      assert.equal(lines[i].includes('\n'), false)
      assert.ok(Buffer.byteLength(lines[i], 'utf8') < PIPE_BUF)
    }

    // 整体确实超过 64KiB —— 正是单块 JSON 会被截断的规模
    const whole = Buffer.byteLength(lines.join('\n'), 'utf8')
    assert.ok(whole > PIPE_BUF, `expected >64KiB, got ${whole}`)
  })

  test('ndjson 截断只损失最后一行,前缀仍全部可用(单块 JSON 则整份报废)', () => {
    const payload = { items: fatTickets(60), total: 60 }
    const nd = `${buildNdjsonLines(payload, { slim: false }).join('\n')}\n`

    // 模拟内核管道在 65536 字节处硬切
    const cut = Buffer.from(nd, 'utf8').subarray(0, PIPE_BUF).toString('utf8')
    const complete = cut.split('\n').slice(0, -1) // 丢弃最后一行(可能不完整)
    assert.ok(complete.length > 1)
    for (const line of complete) JSON.parse(line) // 不抛 = 全部可用

    // 对照:同样数据的单块 JSON 被切后整份不可解析(线上那条 listError)
    const blob = JSON.stringify(wrapSuccess(payload))
    const blobCut = Buffer.from(blob, 'utf8').subarray(0, PIPE_BUF).toString('utf8')
    assert.throws(() => JSON.parse(blobCut), /JSON|Unterminated|Unexpected/)
  })

  test('slim 默认:去掉 body 换成 bodyBytes,50 张卡落回 64KiB 以内', () => {
    const payload = { items: fatTickets(50), total: 50 }
    assert.ok(Buffer.byteLength(JSON.stringify(wrapSuccess(payload)), 'utf8') > PIPE_BUF)

    const slim = slimListPayload(payload) as any
    const encoded = Buffer.byteLength(JSON.stringify(wrapSuccess(slim)), 'utf8')
    assert.ok(encoded < PIPE_BUF, `slim should fit one pipe buffer, got ${encoded}`)

    const first = slim.items[0]
    assert.equal('body' in first, false)
    assert.equal(typeof first.bodyBytes, 'number')
    assert.ok(first.bodyBytes > 0)
    // 定位用的字段一个都不能丢
    assert.equal(first.identifier, 'OCV5-100')
    assert.equal(first.status, 'open')
    assert.equal(first.version, 1)
    assert.equal(slim.total, 50) // 信封保持原样
  })

  test('slimListItem: null 重字段不产出 Bytes;非对象原样返回', () => {
    assert.deepEqual(slimListItem({ id: 'a', body: null, outputMd: undefined }), {
      id: 'a',
      body: null,
      outputMd: undefined,
    })
    const withComments = slimListItem({ id: 'a', comments: [{ body: 'hi' }] }) as any
    assert.equal('comments' in withComments, false)
    assert.ok(withComments.commentsBytes > 0)
    assert.equal(slimListItem('plain'), 'plain')
    assert.equal(slimListItem(null), null)
  })

  test('splitListPayload 认 items/tickets/裸数组,并把其余键留给信封', () => {
    assert.deepEqual(splitListPayload({ items: [1], total: 9 }), {
      key: 'items',
      items: [1],
      envelope: { total: 9 },
    })
    assert.equal(splitListPayload({ tickets: [1, 2] }).key, 'tickets')
    assert.deepEqual(splitListPayload([1, 2]), { key: null, items: [1, 2], envelope: {} })
    assert.deepEqual(splitListPayload({ ok: true }), { key: null, items: [], envelope: {} })
  })
})

/** 可注入的假 stdout:能按需在第 N 次 write 上模拟 EPIPE(先 emit 'error' 再回调)。 */
function fakeStream(opts: { failAt?: number; code?: string } = {}) {
  const written: string[] = []
  const listeners: ((err: NodeJS.ErrnoException) => void)[] = []
  let n = 0
  return {
    written,
    /** 没有 listener 的 'error' 在真实 node 里 = uncaught crash,这里用它断言我们挂了 listener。 */
    get hasErrorListener() {
      return listeners.length > 0
    },
    on(_event: 'error', cb: (err: NodeJS.ErrnoException) => void) {
      listeners.push(cb)
    },
    write(chunk: string, cb: (err?: Error | null) => void) {
      n += 1
      if (opts.failAt != null && n >= opts.failAt) {
        const err = Object.assign(new Error('write EPIPE'), { code: opts.code ?? 'EPIPE' })
        // 真实 stream 的顺序:先 emit 'error',再走 write callback
        for (const l of listeners) l(err)
        cb(err)
        return false
      }
      written.push(chunk)
      cb(null)
      return true
    },
  }
}

describe('EPIPE safety — 读端提前关闭不得 crash (OCV5-165 返工1)', () => {
  test('createStreamWriter 建时就挂上 stdout error listener', () => {
    const st = fakeStream()
    assert.equal(st.hasErrorListener, false)
    createStreamWriter(st)
    // 缺这个 listener,node 会把 'error' 当 uncaught exception 直接 crash
    assert.equal(st.hasErrorListener, true)
  })

  test('writeLines 遇 EPIPE 立即停写,不再对断掉的管道写剩余行', async () => {
    const st = fakeStream({ failAt: 2 }) // 第 2 行开始断
    const w = createStreamWriter(st)
    const lines = Array.from({ length: 60 }, (_, i) => JSON.stringify({ i }))

    const ok = await w.writeLines(lines) // 不抛
    assert.equal(ok, false)
    assert.equal(w.broken, true)
    assert.equal(w.fatal, null)
    // 关键:只写成功了第 1 行,后面 59 行没有继续硬写
    assert.equal(st.written.length, 1)
  })

  test('管道断后继续 write 静默返回 false,不抛', async () => {
    const st = fakeStream({ failAt: 1 })
    const w = createStreamWriter(st)
    assert.equal(await w.write('a\n'), false)
    assert.equal(await w.write('b\n'), false)
    assert.equal(await w.writeJson({ a: 1 }), false)
    assert.equal(st.written.length, 0)
    assert.equal(w.broken, true)
  })

  test('非 EPIPE 的写错误照常上抛(不能被当成正常收尾吞掉)', async () => {
    const st = fakeStream({ failAt: 1, code: 'ENOSPC' })
    const w = createStreamWriter(st)
    await assert.rejects(() => w.write('x\n'), /write EPIPE|ENOSPC/)
    assert.equal(w.broken, false)
    assert.equal((w.fatal as NodeJS.ErrnoException | null)?.code, 'ENOSPC')
  })

  test('正常流:全部写出且 broken 保持 false', async () => {
    const st = fakeStream()
    const w = createStreamWriter(st)
    assert.equal(await w.writeLines(['a', 'b', 'c']), true)
    assert.deepEqual(st.written, ['a\n', 'b\n', 'c\n'])
    assert.equal(w.broken, false)
  })

  test('isEpipe 只认 code=EPIPE', () => {
    assert.equal(isEpipe(Object.assign(new Error('x'), { code: 'EPIPE' })), true)
    assert.equal(isEpipe(Object.assign(new Error('x'), { code: 'ENOSPC' })), false)
    assert.equal(isEpipe(new Error('plain')), false)
    assert.equal(isEpipe(null), false)
    assert.equal(isEpipe(undefined), false)
  })
})
