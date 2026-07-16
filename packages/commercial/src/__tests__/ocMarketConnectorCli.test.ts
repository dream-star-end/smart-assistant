import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { compileSpec } from '../connectors/spec/compiler.js'

const SCRIPT = resolve('packages/commercial/agent-sandbox/platform-runtime/bin/oc-market.sh')

async function run(
  args: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<{
  code: number | null
  stdout: string
  stderr: string
}> {
  return new Promise((done, reject) => {
    const child = spawn('sh', [SCRIPT, ...args], { env: { ...process.env, ...env } })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => (stdout += String(c)))
    child.stderr.on('data', (c) => (stderr += String(c)))
    child.once('error', reject)
    child.once('close', (code) => done({ code, stdout, stderr }))
  })
}

async function fixture(port: number): Promise<{
  home: string
  spec: string
  decision: string
  draft: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'oc-market-connector-'))
  const home = join(root, 'home')
  await mkdir(home)
  await writeFile(join(home, 'openclaude.json'), JSON.stringify({ gateway: { port } }))
  const spec = join(root, 'spec.json')
  const decision = join(root, 'decision.json')
  await writeFile(spec, JSON.stringify({ id: 'cli-connector', identity: {}, actions: [] }))
  await writeFile(decision, JSON.stringify({ audience: {}, actions: {} }))
  const draft = join(root, 'plugin.json')
  await writeFile(
    draft,
    JSON.stringify({
      kind: 'plugin',
      version: '1.2.3',
      spec: { id: 'cli-plugin', identity: {}, actions: [] },
      securityDecision: { audience: {}, actions: {} },
      category: 'daily-tools',
      useCases: ['查询当前账号身份'],
      outcomeExamples: ['授权账号后返回身份'],
      tags: ['API插件', '测试'],
      visibility: 'public',
    }),
  )
  return { home, spec, decision, draft }
}

test('oc-market publish-connector --help 自描述全部必需参数', async () => {
  const r = await run(['publish-connector', '--help'])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /--spec-file/)
  assert.match(r.stdout, /--security-decision-file/)
  assert.match(r.stdout, /--use-cases/)
  assert.match(r.stdout, /--examples/)
})

test('oc-market publish-connector --examples 提供容器内可编译的三种完整模板', async () => {
  const r = await run(['publish-connector', '--examples'])
  assert.equal(r.code, 0, r.stderr)
  const examples = JSON.parse(r.stdout) as Record<
    string,
    { spec: Record<string, unknown>; securityDecision: Record<string, unknown> }
  >
  assert.deepEqual(Object.keys(examples).sort(), [
    'oauth2-auth-code-byoa',
    'static-token',
    'token-exchange',
  ])
  for (const [name, example] of Object.entries(examples)) {
    assert.doesNotThrow(() => compileSpec(example.spec, example.securityDecision), name)
  }
})

test('oc-market plugin examples 提供完整单文件草稿、合法分类和可编译声明', async () => {
  const r = await run(['plugin', 'examples'])
  assert.equal(r.code, 0, r.stderr)
  const output = JSON.parse(r.stdout) as {
    categoryIds: string[]
    examples: Record<
      string,
      {
        kind: string
        spec: Record<string, unknown>
        securityDecision: Record<string, unknown>
      }
    >
  }
  assert.ok(output.categoryIds.includes('daily-tools'))
  assert.deepEqual(Object.keys(output.examples).sort(), [
    'oauth2-auth-code-byoa',
    'static-token',
    'token-exchange',
  ])
  for (const [name, example] of Object.entries(output.examples)) {
    assert.equal(example.kind, 'plugin')
    assert.doesNotThrow(() => compileSpec(example.spec, example.securityDecision), name)
  }
})

test('oc-market plugin validate/publish 使用单文件、loopback 与 hash 绑定确认', async () => {
  const validationHash = 'a'.repeat(64)
  const received: Array<{ url: string; body: Record<string, unknown> }> = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      received.push({
        url: req.url ?? '',
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      })
      res.setHeader('content-type', 'application/json')
      if (req.url?.endsWith('/validate-plugin')) {
        res.end(
          JSON.stringify({
            ok: true,
            validationHash,
            plugin: { slug: 'cli-plugin' },
            permissionSummary: { authMode: 'static-token' },
          }),
        )
      } else {
        res.end(JSON.stringify({ ok: true, versionId: 'v-plugin', status: 'pending' }))
      }
    })
  })
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const f = await fixture(address.port)
  const env = { OPENCLAUDE_HOME: f.home, HTTP_PROXY: 'http://127.0.0.1:1' }
  try {
    let r = await run(['plugin', 'validate', '--file', f.draft], env)
    assert.equal(r.code, 0, r.stderr)
    const validated = JSON.parse(r.stdout) as {
      validationHash: string
      publishCommand: string
    }
    assert.equal(validated.validationHash, validationHash)
    assert.match(validated.publishCommand, new RegExp(`--confirm ${validationHash}$`))
    assert.equal(received[0]?.url, '/internal/v3/marketplace/agent-local/validate-plugin')
    assert.deepEqual(received[0]?.body, {
      kind: 'connector',
      version: '1.2.3',
      spec: { id: 'cli-plugin', identity: {}, actions: [] },
      securityDecision: { audience: {}, actions: {} },
      category: 'daily-tools',
      useCases: ['查询当前账号身份'],
      outcomeExamples: ['授权账号后返回身份'],
      tags: ['API插件', '测试'],
    })

    received.length = 0
    r = await run(['plugin', 'publish', '--file', f.draft, '--confirm', 'b'.repeat(64)], env)
    assert.equal(r.code, 1)
    assert.match(r.stderr, /hash is stale/)
    assert.deepEqual(received.map((x) => x.url), [
      '/internal/v3/marketplace/agent-local/validate-plugin',
    ])

    received.length = 0
    r = await run(['plugin', 'publish', '--file', f.draft, '--confirm', validationHash], env)
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /"versionId": "v-plugin"/)
    assert.deepEqual(received.map((x) => x.url), [
      '/internal/v3/marketplace/agent-local/validate-plugin',
      '/internal/v3/marketplace/agent-local/publish',
    ])
    assert.deepEqual(received[0]?.body, received[1]?.body)
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
  }
})

test('oc-market plugin publish 缺少确认 hash 时不接触 relay', async () => {
  const f = await fixture(1)
  const r = await run(['plugin', 'publish', '--file', f.draft], { OPENCLAUDE_HOME: f.home })
  assert.equal(r.code, 2)
  assert.match(r.stderr, /--confirm/)
})

test('oc-market publish-connector 只经 loopback relay 发送正确 payload', async () => {
  let received: unknown = null
  let receivedUrl = ''
  const server = createServer((req, res) => {
    receivedUrl = req.url ?? ''
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      received = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: true, versionId: 'v-test', status: 'pending' }))
    })
  })
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const f = await fixture(address.port)
  try {
    const r = await run(
      [
        'publish-connector',
        '--spec-file',
        f.spec,
        '--security-decision-file',
        f.decision,
        '--version',
        '1.2.3',
        '--category',
        'daily-tools',
        '--use-cases',
        '查询当前身份;读取条目列表',
        '--outcomes',
        '给定账号→返回身份',
        '--tags',
        '连接器,测试',
        '--visibility',
        'org',
      ],
      { OPENCLAUDE_HOME: f.home },
    )
    assert.equal(r.code, 0, r.stderr)
    assert.equal(receivedUrl, '/internal/v3/marketplace/agent-local/publish')
    assert.deepEqual(received, {
      kind: 'connector',
      version: '1.2.3',
      spec: { id: 'cli-connector', identity: {}, actions: [] },
      securityDecision: { audience: {}, actions: {} },
      category: 'daily-tools',
      useCases: ['查询当前身份', '读取条目列表'],
      outcomeExamples: ['给定账号→返回身份'],
      tags: ['连接器', '测试'],
      visibility: 'org',
    })
    assert.match(r.stdout, /"versionId": "v-test"/)
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
  }
})

test('oc-market publish-connector 对坏 JSON 与 relay 错误给结构化失败', async () => {
  const f = await fixture(1)
  await writeFile(f.spec, '[]')
  const baseArgs = [
    'publish-connector',
    '--spec-file',
    f.spec,
    '--security-decision-file',
    f.decision,
    '--version',
    '1.0.0',
    '--category',
    'daily-tools',
    '--use-cases',
    '查询当前身份',
  ]
  let r = await run(baseArgs, { OPENCLAUDE_HOME: f.home })
  assert.equal(r.code, 1)
  assert.match(r.stderr, /must contain a JSON object/)

  await writeFile(f.spec, JSON.stringify({ id: 'cli-connector' }))
  r = await run(baseArgs, { OPENCLAUDE_HOME: f.home })
  assert.equal(r.code, 1)
  assert.match(r.stderr, /publish relay failed/)
})
