import assert from 'node:assert/strict'
import test from 'node:test'
import {
  boundCc5ToolResultSize,
  createCc5ToolDispatcher,
  isCc5ToolHostCommand,
  parseCc5HostProfile,
} from './cc5ToolHost.js'

const session = 'd71e4679-e7df-482a-a129-a998a8f51f7e'
const listed = new Set([
  'Read',
  'Edit',
  'Bash',
  'Write',
  'Grep',
  'ExecuteExtraTool',
])
function call(
  toolUseId: string,
  name = 'Read',
  args: unknown = { file_path: '/workspace/probe.txt' },
) {
  return {
    name,
    arguments: args,
    _meta: {
      'claudecode/toolUseId': toolUseId,
      'openclaude/nativeSessionId': session,
      'openclaude/turnKey': 'turn-one',
    },
  }
}
interface TestRuntime {
  execute: (input: never) => Promise<{
    content: Array<{ type: 'text'; text: string }>
    isError: boolean
  }>
  close: () => Promise<void>
}
function dispatcher(runtime: TestRuntime) {
  return createCc5ToolDispatcher(
    runtime as Parameters<typeof createCc5ToolDispatcher>[0],
    listed,
  )
}
const ok = {
  content: [{ type: 'text' as const, text: 'done' }],
  isError: false,
}
const profile = {
  version: 1,
  cwd: '/workspace',
  mcpConfigPath: '/workspace/mcp.json',
  settingsPath: null,
  disallowedTools: ['SendMessage'],
}

test('the exact full-tool host command is routed while ordinary commands remain ordinary', () => {
  assert.equal(
    isCc5ToolHostCommand([
      'mcp',
      'serve',
      '--tool-profile',
      'full',
      '--host-profile',
      '/run/host-profile.json',
    ]),
    true,
  )
  for (const args of [
    [],
    ['--version'],
    ['mcp', 'serve'],
    ['mcp', 'serve', '--help'],
    ['auth', 'status'],
  ])
    assert.equal(isCc5ToolHostCommand(args), false)
})

test('malformed, legacy and misplaced profiles cannot fall through to normal initialization', () => {
  for (const args of [
    ['mcp', 'serve', '--tool-profile', 'full', '--host-profile'],
    [
      'mcp',
      'serve',
      '--tool-profile',
      'full',
      '--host-profile',
      'relative.json',
    ],
    [
      'mcp',
      'serve',
      '--tool-profile',
      'full',
      '--host-profile',
      '/run/host-profile.json',
      '--debug',
    ],
    [
      'mcp',
      'serve',
      '--tool-profile=full',
      '--host-profile',
      '/run/host-profile.json',
    ],
    [
      'mcp',
      'serve',
      '--tool-profile',
      'minimal',
      '--host-profile',
      '/run/host-profile.json',
    ],
    ['mcp', 'serve', '--tool-allowlist', 'Read,Edit,Bash'],
    [
      '--tool-profile',
      'full',
      'mcp',
      'serve',
      '--host-profile',
      '/run/host-profile.json',
    ],
    [
      'mcp',
      'list',
      '--tool-profile',
      'full',
      '--host-profile',
      '/run/host-profile.json',
    ],
    [
      'mcp',
      'serve',
      '--host-profile',
      '/run/host-profile.json',
      '--tool-profile',
      'full',
    ],
    [
      'mcp',
      'serve',
      '--tool-profile',
      'full',
      '--host-profile',
      '/run/host-profile.json',
      '--host-profile',
      '/run/other.json',
    ],
  ])
    assert.throws(() => isCc5ToolHostCommand(args), /REJECTED/)
})

test('the host profile is closed, versioned and absolute', () => {
  assert.deepEqual(parseCc5HostProfile(profile), profile)
  assert.deepEqual(
    parseCc5HostProfile({
      ...profile,
      mcpConfigPath: null,
      settingsPath: '/run/settings.json',
    }),
    { ...profile, mcpConfigPath: null, settingsPath: '/run/settings.json' },
  )
  for (const value of [
    undefined,
    null,
    'profile',
    [],
    { ...profile, version: 2 },
    { ...profile, cwd: 'relative' },
    { ...profile, mcpConfigPath: 'relative.json' },
    { ...profile, settingsPath: 7 },
    { ...profile, disallowedTools: 'SendMessage' },
    { ...profile, extra: true },
    {
      cwd: profile.cwd,
      mcpConfigPath: null,
      settingsPath: null,
      disallowedTools: [],
    },
    { ...profile, disallowedTools: ['x'.repeat(513)] },
    {
      ...profile,
      disallowedTools: Array.from({ length: 200 }, () => 'x'.repeat(400)),
    },
  ])
    assert.throws(() => parseCc5HostProfile(value), /REJECTED/)
})

test('unlisted tools, malformed frames and non-object arguments never enter the pipeline', async () => {
  let effects = 0
  const host = dispatcher({
    async execute() {
      effects++
      return ok
    },
    async close() {},
  })
  const missingMeta = call('1')
  delete (missingMeta as { _meta?: unknown })._meta
  const extraMeta = call('2')
  extraMeta._meta.extra = true
  const badSession = call('3')
  badSession._meta['openclaude/nativeSessionId'] = 'not-a-uuid'
  for (const input of [
    call('unlisted', 'CronCreate', { cron: '* * * * *' }),
    call('string-args', 'Bash', 'pwd'),
    call('array-args', 'Bash', []),
    call('oversized-args', 'Bash', { command: 'p'.repeat(98304) }),
    missingMeta,
    extraMeta,
    badSession,
  ])
    assert.throws(() => host.call(input), /REJECTED/)
  assert.equal(effects, 0)
  await host.close()
})

test('listed tool names pass through without per-tool hand validation', async () => {
  const seen: Array<{ name: string; input: Record<string, unknown> }> = []
  const host = dispatcher({
    async execute(input: { name: string; input: Record<string, unknown> }) {
      seen.push({ name: input.name, input: input.input })
      return ok
    },
    async close() {},
  })
  await host.call(
    call('write', 'Write', { file_path: '/workspace/probe.txt', content: 'b' }),
  )
  await host.call(
    call('grep', 'Grep', {
      pattern: 'probe',
      path: '/workspace',
      output_mode: 'content',
    }),
  )
  await host.call(
    call('extra', 'ExecuteExtraTool', {
      tool_name: 'mcp__fixture__echo',
      params: { text: 'x' },
    }),
  )
  assert.deepEqual(
    seen.map(entry => entry.name),
    ['Write', 'Grep', 'ExecuteExtraTool'],
  )
  assert.deepEqual(seen[1].input, {
    pattern: 'probe',
    path: '/workspace',
    output_mode: 'content',
  })
  await host.close()
})

test('tool identity remains burned across an execution failure', async () => {
  let effects = 0
  const host = dispatcher({
    async execute() {
      effects++
      throw new Error('pipeline failed')
    },
    async close() {},
  })
  await assert.rejects(host.call(call('once')), /pipeline failed/)
  assert.throws(() => host.call(call('once')), /REJECTED/)
  assert.equal(effects, 1)
  await host.close()
})

test('a new turn shares the session and runtime while a different session is rejected', async () => {
  const seen: string[] = []
  const host = dispatcher({
    async execute(input: { turnKey: string; name: string }) {
      seen.push(`${input.turnKey}:${input.name}`)
      return ok
    },
    async close() {},
  })
  await host.call(call('read'))
  const edit = call('edit', 'Edit', {
    file_path: '/workspace/probe.txt',
    old_string: 'a',
    new_string: 'b',
  })
  edit._meta['openclaude/turnKey'] = 'turn-two'
  await host.call(edit)
  const other = call('other')
  other._meta['openclaude/nativeSessionId'] =
    '9a35eda8-8870-4c3f-a4e4-98e7f98fe169'
  assert.throws(() => host.call(other), /REJECTED/)
  assert.deepEqual(seen, ['turn-one:Read', 'turn-two:Edit'])
  await host.close()
})

test('a busy host rejects a second pipeline without queueing an effect', async () => {
  let release!: () => void
  let effects = 0
  const host = dispatcher({
    async execute() {
      effects++
      await new Promise<void>(resolve => {
        release = resolve
      })
      return ok
    },
    async close() {},
  })
  const first = host.call(call('first'))
  await Promise.resolve()
  assert.throws(() => host.call(call('second')), /REJECTED/)
  release()
  await first
  assert.equal(effects, 1)
  await host.close()
})

test('close revokes new calls, aborts and waits for the running pipeline', async () => {
  let drain!: () => void
  let signal: AbortSignal | undefined
  let closed = false
  const host = dispatcher({
    async execute(input: { signal: AbortSignal }) {
      signal = input.signal
      await new Promise<void>(resolve => {
        drain = resolve
      })
      return ok
    },
    async close() {
      closed = true
    },
  })
  const running = host.call(call('running'))
  await Promise.resolve()
  const closing = host.close()
  assert.equal(signal?.aborted, true)
  assert.equal(closed, false)
  assert.throws(() => host.call(call('late')), /REJECTED/)
  drain()
  await running
  await closing
  assert.equal(closed, true)
  assert.equal(host.close(), closing)
})

test('admitted input is captured, not aliased to the caller frame', async () => {
  let command: unknown
  const host = dispatcher({
    async execute(input: { input: { command: unknown } }) {
      command = input.input.command
      return ok
    },
    async close() {},
  })
  const request = call('bash', 'Bash', { command: 'pwd' })
  const running = host.call(request)
  ;(request.arguments as { command: string }).command =
    'changed-after-admission'
  await running
  assert.equal(command, 'pwd')
  await host.close()
})

test('oversized output is never returned as a successful tool receipt', async () => {
  const host = dispatcher({
    async execute() {
      return {
        content: [{ type: 'text', text: 'x'.repeat(131072) }],
        isError: false,
      }
    },
    async close() {},
  })
  await assert.rejects(host.call(call('oversized')), /RESULT_LIMIT/)
  assert.throws(() => host.call(call('oversized')), /REJECTED/)
  await host.close()
})

const MAX = 131072
const resultBytes = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value))

/** A smooth 900x900 gradient stored at PNG compression level 0: larger than the
 * transfer bound as produced, but cheap for the resizer to re-encode. */
async function oversizedPng(): Promise<Buffer> {
  const { default: sharp } = await import('sharp')
  const width = 400
  const height = 400
  const raw = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 3
      raw[offset] = Math.floor((x * 255) / width)
      raw[offset + 1] = Math.floor((y * 255) / height)
      raw[offset + 2] = Math.floor(((x + y) * 255) / (width + height))
    }
  }
  return sharp(raw, { raw: { width, height, channels: 3 } })
    .png({ compressionLevel: 0 })
    .toBuffer()
}

test('a result inside the transfer bound is returned untouched', async () => {
  const result = {
    content: [{ type: 'text' as const, text: 'small' }],
    isError: false,
  }
  assert.deepEqual(await boundCc5ToolResultSize(result), result)
})

test('an oversized real PNG is recompressed and still arrives as a decodable image block', {
  timeout: 30000,
}, async () => {
  const png = await oversizedPng()
  assert.ok(
    png.length > MAX,
    `fixture must exceed the bound, got ${png.length}`,
  )
  const original = {
    content: [
      {
        type: 'image' as const,
        mimeType: 'image/png',
        data: png.toString('base64'),
      },
    ],
    isError: false,
  }
  const bounded = await boundCc5ToolResultSize(
    original,
    '/workspace/screenshot.png',
  )
  assert.ok(
    resultBytes(bounded) <= MAX,
    `still oversized: ${resultBytes(bounded)}`,
  )
  assert.equal(bounded.content.length, 2)
  const image = bounded.content[0] as unknown as {
    type: string
    mimeType: string
    data: string
  }
  assert.equal(image.type, 'image')
  const note = bounded.content[1] as unknown as { type: string; text: string }
  assert.equal(note.type, 'text')
  assert.ok(note.text.startsWith('[cc5 tool result truncated: original '))
  assert.ok(image.data.length > 0)
  const { default: sharp } = await import('sharp')
  const metadata = await sharp(Buffer.from(image.data, 'base64')).metadata()
  assert.ok((metadata.width ?? 0) > 0 && (metadata.height ?? 0) > 0)
})

test('an undecodable oversized image degrades to a placeholder instead of breaking the pipeline', async () => {
  const { randomFillSync } = await import('node:crypto')
  const corrupt = Buffer.alloc(200 * 1024)
  randomFillSync(corrupt)
  const original = {
    content: [
      {
        type: 'image' as const,
        mimeType: 'image/png',
        data: corrupt.toString('base64'),
      },
    ],
    isError: false,
  }
  const bounded = await boundCc5ToolResultSize(
    original,
    '/workspace/broken.png',
  )
  assert.ok(resultBytes(bounded) <= MAX)
  const text = JSON.stringify(bounded.content)
  assert.ok(
    text.includes(
      '[image omitted: original 204800 bytes, too large to transfer',
    ),
  )
  assert.ok(text.includes('; source: /workspace/broken.png;'), text)
  assert.ok(
    !text.includes('"data"'),
    'image bytes must never be serialized as text',
  )
})

test('text and image over the shared bound keep the text head and a bounded image', {
  timeout: 30000,
}, async () => {
  const png = await oversizedPng()
  const head = 'read head line\n'.repeat(2000)
  const original = {
    content: [
      { type: 'text' as const, text: head },
      {
        type: 'image' as const,
        mimeType: 'image/png',
        data: png.toString('base64'),
      },
    ],
    isError: false,
  }
  const bounded = await boundCc5ToolResultSize(original)
  assert.ok(resultBytes(bounded) <= MAX)
  const first = bounded.content[0] as unknown as { type: string; text: string }
  assert.equal(first.type, 'text')
  assert.ok(first.text.startsWith('read head line\nread head line\n'))
  assert.ok(
    first.text.endsWith(
      `[cc5 tool result truncated: original ${resultBytes(original)} bytes]`,
    ),
  )
  const second = bounded.content[1] as unknown as {
    type: string
    text?: string
  }
  assert.ok(
    second &&
      (second.type === 'image' ||
        (second.type === 'text' && second.text!.startsWith('[image omitted:'))),
  )
})
