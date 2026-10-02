import { createHash } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { describe, expect, test } from 'bun:test'

const ROOT = join(import.meta.dir, '../../../..')
const CLI = join(ROOT, 'claude-code-best/src/entrypoints/cli.tsx')
const RECOVERY = join(ROOT, 'claude-code-best/src/utils/conversationRecovery.ts')
const SESSION = '11111111-2222-4333-8444-555555555555'
const OP = 'ab'.repeat(32)
const BUSINESS = 'cd'.repeat(32)
const GROW = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ANNOUNCEMENT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const OLD_TOOL = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const OLD_RESULT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const KEPT_TOOL = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const KEPT_IMAGE = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const INSTRUCTIONS =
  'preserve the user goal, decisions, constraints, current work, files, errors, and next steps'

function idleUuid(opId: string, role: string): string {
  const hex = createHash('sha256').update(`${opId}:${role}`).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

function row(index: number, entry: Record<string, unknown>): string {
  return JSON.stringify({
    isSidechain: false,
    userType: 'external',
    entrypoint: 'sdk-cli',
    version: '2.1.888',
    sessionId: SESSION,
    ...entry,
    timestamp: new Date(Date.UTC(2026, 8, 30, 0, 0, index)).toISOString(),
  })
}

function descriptor(owner: boolean): string {
  return JSON.stringify({
    canonicalModel: 'box-api-claude-opus-5-5',
    contextWindow: 200000,
    capabilityZero: true,
    supportsThinking: false,
    supportsVision: false,
    supportedEfforts: [],
    ...(owner ? { contextOwner: 'box-native-v1' } : {}),
  })
}

async function listen(): Promise<{ url: string; calls: () => Array<{ path: string; body: string }>; close: () => Promise<void> }> {
  const calls: Array<{ path: string; body: string }> = []
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      calls.push({ path: req.url ?? '', body })
      const path = (req.url ?? '').split('?')[0]
      if (path === '/v1/messages/count_tokens') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ input_tokens: 100 }))
        return
      }
      if (!path.startsWith('/v1/messages')) {
        res.writeHead(404)
        res.end()
        return
      }
      const text = body.includes('NEXT-USER-REAL-QUERY')
        ? 'NEXT-REAL-QUERY'
        : 'synthetic-prepared-summary'
      const frames = [
        ['message_start', { type: 'message_start', message: { id: 'msg_local', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } } }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } }],
        ['message_stop', { type: 'message_stop' }],
      ] as const
      const data = frames.map(([event, value]) => `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`).join('')
      res.writeHead(200, { 'content-type': 'text/event-stream', 'content-length': Buffer.byteLength(data) })
      res.end(data)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  return {
    url: `http://127.0.0.1:${address.port}`,
    calls: () => calls,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

describe('local idle compact replaces the shared query history', () => {
  for (const shape of ['text-block', 'string'] as const) {
    test(`${shape} input keeps the same op across the owner transition`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'ocv5-296-r27-'))
      const api = await listen()
      let failed = false
      try {
        await runShape(root, api.url, api.calls, shape)
      } catch (error) {
        failed = true
        throw error
      } finally {
        await api.close()
        if (!failed) await rm(root, { recursive: true, force: true })
      }
    }, 180_000)
  }
})

async function runShape(
  root: string,
  apiUrl: string,
  calls: () => Array<{ path: string; body: string }>,
  shape: 'text-block' | 'string',
): Promise<void> {
  const before = messageCalls(calls()).length
  const home = join(root, shape)
  const work = join(home, 'work')
  const marker = join(work, 'execution-log')
  await mkdir(work, { recursive: true })
  const project = join(home, 'claude-config', 'projects', work.replace(/[^a-zA-Z0-9]/g, '-'))
  await mkdir(project, { recursive: true })
  const transcript = join(project, `${SESSION}.jsonl`)
  const big = 'x'.repeat(700_000)
  const lines = [
    row(0, { parentUuid: null, type: 'user', uuid: GROW, message: { role: 'user', content: `goal ${big}` } }),
    row(1, {
      parentUuid: GROW,
      type: 'attachment',
      uuid: ANNOUNCEMENT,
      attachment: { type: 'deferred_tools_delta', addedNames: ['Bash'], addedLines: ['Bash'], removedNames: [] },
    }),
    row(2, {
      parentUuid: ANNOUNCEMENT,
      type: 'assistant',
      uuid: OLD_TOOL,
      message: {
        id: 'msg_old', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'toolu_old', name: 'Bash', input: { command: `echo toolu_old >> ${JSON.stringify(marker)}` } }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    }),
    row(3, {
      parentUuid: OLD_TOOL,
      type: 'user',
      uuid: OLD_RESULT,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_old', content: 'old-ok' }] },
    }),
    row(4, {
      parentUuid: OLD_RESULT,
      type: 'assistant',
      uuid: KEPT_TOOL,
      message: {
        id: 'msg_kept', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'toolu_kept', name: 'Read', input: { file_path: 'a.ts' } }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    }),
    row(5, {
      parentUuid: KEPT_TOOL,
      type: 'user',
      uuid: KEPT_IMAGE,
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_kept', content: 'kept-ok' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aaaa' } },
        ],
      },
    }),
  ]
  await writeFile(transcript, `${lines.join('\n')}\n`)
  const nativeDir = join(home, 'idle-native', SESSION)
  await mkdir(nativeDir, { recursive: true })
  const nativePath = join(nativeDir, 'prepared.json')
  await writeFile(nativePath, JSON.stringify({
    v: 1, opId: OP, revision: 'prepared', sessionId: SESSION, modelCalls: 0,
    frozenTail: [
      { uuid: KEPT_TOOL, parentUuid: OLD_RESULT, message: JSON.parse(lines[4]!) },
      { uuid: KEPT_IMAGE, parentUuid: KEPT_TOOL, message: JSON.parse(lines[5]!) },
    ],
    attachments: [],
  }))
  const seeded = await coldLoad(home, work, transcript, 'seed')
  assertSeedLoaded(shape, seeded)
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    OPENCLAUDE_HOME: home,
    CLAUDE_CONFIG_DIR: join(home, 'claude-config'),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_MAX_RETRIES: '0',
    ANTHROPIC_BASE_URL: apiUrl,
    ANTHROPIC_AUTH_TOKEN: 'fixture-only-not-a-key',
    CLAUDE_CODE_EXTRA_METADATA: JSON.stringify({ oc_turn_key: OP }),
    OC_MODEL_EXECUTION_DESCRIPTOR: descriptor(false),
  }
  const child = spawn('bun', [
    'run', CLI, '-p', '--resume', SESSION,
    '--input-format=stream-json', '--output-format=stream-json',
    '--include-partial-messages', '--verbose',
    '--model', 'box-api-claude-opus-5-5',
  ], { cwd: work, env, stdio: ['pipe', 'pipe', 'pipe'] })
  const stderr: string[] = []
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => stderr.push(chunk))
  const results = new ResultQueue(child)
  const compact = `/compact ${INSTRUCTIONS}`
  try {
    const prepared = await turn(child, results, compact)
    expect(prepared.is_error, `${shape} prepared ${stderr.join('')}`).toBe(false)
    expect(messageCalls(calls()).length, `${shape} prepared http`).toBe(before + 1)
    expect(await countUuid(transcript, ANNOUNCEMENT), `${shape} prepared announcement`).toBe(1)
    expect((await readFile(transcript, 'utf8')).includes('compact_boundary'), `${shape} prepared wrote boundary`).toBe(false)

    const applied = await turn(child, results, compact)
    expect(applied.is_error, `${shape} apply ${JSON.stringify(applied.seen ?? applied.result).slice(0, 400)} ${stderr.join('').slice(-500)}`).toBe(false)
    expect(messageCalls(calls()).length, `${shape} apply http`).toBe(before + 1)

    const nextText = 'NEXT-USER-REAL-QUERY'
    const content = shape === 'string' ? nextText : [{ type: 'text', text: nextText }]
    const next = await turn(child, results, content, { owner: true, turnKey: BUSINESS })
    expect(next.is_error, `${shape} next ${String(next.result).slice(0, 300)}`).toBe(false)
    expect(messageCalls(calls()).length, `${shape} next http`).toBe(before + 2)
    const nextBody = messageCalls(calls()).at(-1)?.body ?? ''
    const afterNext = await coldLoad(home, work, transcript, 'next')
    await assertCompactSurvived(shape, 'next', afterNext, transcript, nextText)

    expect(nextBody.includes('toolu_old'), `${shape} old tool resent`).toBe(false)
    expect(nextBody.includes('toolu_kept'), `${shape} kept tool missing`).toBe(true)
    expect(nextBody.includes('aaaa'), `${shape} image missing`).toBe(true)

    await writeFile(join(nativeDir, 'short.json'), JSON.stringify({
      v: 1, opId: 'ef'.repeat(32), revision: 'short', sessionId: SESSION, modelCalls: 0,
      frozenTail: [], attachments: [],
    }))
    const short = await turn(child, results, compact, { owner: false, turnKey: 'ef'.repeat(32) })
    expect(short.is_error, `${shape} short`).toBe(false)
    const shortNative = JSON.parse(await readFile(join(nativeDir, 'short.json'), 'utf8')) as { applied?: boolean; summaryText?: string }
    expect(shortNative.applied, `${shape} short applied`).toBe(true)
    expect(shortNative.summaryText, `${shape} short summary`).toBeUndefined()

    await writeFile(join(nativeDir, 'failure.json'), JSON.stringify({
      v: 1, opId: '11'.repeat(32), revision: 'failure', sessionId: SESSION, modelCalls: 0,
      modelStarted: true, frozenTail: [], attachments: [],
    }))
    const failed = await turn(child, results, compact, { owner: false, turnKey: '11'.repeat(32) })
    const failedSeen = JSON.stringify(failed.seen ?? { result: failed.result })
    expect(failed.is_error, `${shape} failure result ${failedSeen.slice(0, 500)}`).toBe(false)
    expect(failedSeen.includes('IDLE_HISTORY_PENDING'), `${shape} failure did not reach the pending summary ${failedSeen.slice(0, 800)}`).toBe(true)
    expect(messageCalls(calls()).length, `${shape} failure http`).toBe(before + 2)
    const failedText = await readFile(transcript, 'utf8')
    expect(failedText.includes('"subtype":"compact_boundary"') || failedText.includes('compact_boundary'), `${shape} failure cleared the boundary`).toBe(true)

    const loaded = await coldLoad(home, work, transcript, 'final')
    await assertCompactSurvived(shape, 'final', loaded, transcript, nextText)
    expect(await fileExists(marker), `${shape} old tool executed`).toBe(false)
  } finally {
    await stop(child)
  }
}

function messageCalls(calls: Array<{ path: string; body: string }>): Array<{ path: string; body: string }> {
  return calls.filter((call) => {
    const path = call.path.split('?')[0]
    return path === '/v1/messages' || path === '/v1/messages/'
  })
}

async function countUuid(file: string, uuid: string): Promise<number> {
  const text = await readFile(file, 'utf8')
  return text.split('\n').filter((line) => line.includes(`"uuid":"${uuid}"`)).length
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await readFile(file)
    return true
  } catch {
    return false
  }
}

class ResultQueue {
  private pending: Record<string, unknown>[] = []
  private waiters: Array<(row: Record<string, unknown>) => void> = []
  private done = false
  constructor(child: ChildProcess) {
    const lines = createInterface({ input: child.stdout! })
    lines.on('line', (line) => {
      try { this.push(JSON.parse(line) as Record<string, unknown>) }
      catch { /* non-json stdout */ }
    })
    child.on('exit', () => {
      this.done = true
      this.push({ eof: true, exitCode: child.exitCode })
    })
  }
  private push(row: Record<string, unknown>): void {
    const waiter = this.waiters.shift()
    if (waiter) waiter(row)
    else this.pending.push(row)
  }
  next(timeoutMs: number): Promise<Record<string, unknown>> {
    const queued = this.pending.shift()
    if (queued) return Promise.resolve(queued)
    if (this.done) return Promise.resolve({ eof: true })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter !== onRow)
        reject(new Error('result timeout'))
      }, timeoutMs)
      const onRow = (row: Record<string, unknown>) => {
        clearTimeout(timer)
        resolve(row)
      }
      this.waiters.push(onRow)
    })
  }
}

async function turn(
  child: ChildProcess,
  results: ResultQueue,
  content: string | Array<Record<string, unknown>>,
  update?: { owner: boolean; turnKey: string },
): Promise<Record<string, unknown>> {
  if (update) {
    child.stdin!.write(`${JSON.stringify({ type: 'update_environment_variables', variables: { OC_MODEL_EXECUTION_DESCRIPTOR: descriptor(update.owner) } })}\n`)
    child.stdin!.write(`${JSON.stringify({ type: 'update_environment_variables', variables: { CLAUDE_CODE_EXTRA_METADATA: JSON.stringify({ oc_turn_key: update.turnKey }) } })}\n`)
  }
  child.stdin!.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`)
  const deadline = Date.now() + 90_000
  const seen: Record<string, unknown>[] = []
  while (Date.now() < deadline) {
    const row = await results.next(deadline - Date.now())
    seen.push(row)
    if (row.type === 'result') return { ...row, seen: seen.slice(0, -1) }
    if (row.eof) throw new Error(`CLI exited ${row.exitCode} seen=${JSON.stringify(seen).slice(-800)}`)
  }
  throw new Error(`result timeout exit=${child.exitCode}`)
}

type Loaded = { default: Array<Record<string, any>>; explicit: Array<Record<string, any>> }

function stableMessage(message: Record<string, any>): Record<string, unknown> {
  return {
    uuid: message.uuid ?? null,
    type: message.type ?? null,
    subtype: message.subtype ?? null,
    role: message.message?.role ?? null,
    content: message.message?.content ?? message.content ?? null,
    attachment: message.attachment ?? null,
    isCompactSummary: message.isCompactSummary ?? null,
    idleOpId: message.compactMetadata?.idleOpId ?? null,
  }
}

const SEED_CHAIN = [GROW, ANNOUNCEMENT, OLD_TOOL, OLD_RESULT, KEPT_TOOL, KEPT_IMAGE]

function comparable(messages: Array<Record<string, any>>): Array<Record<string, unknown>> {
  return messages.flatMap((message) => {
    const text = JSON.stringify(message.message?.content ?? message.content ?? '')
    const kept =
      SEED_CHAIN.includes(message.uuid) ||
      message.subtype === 'compact_boundary' ||
      message.subtype === 'informational' ||
      message.isCompactSummary === true ||
      text.includes('NEXT-USER-REAL-QUERY') ||
      text.includes('NEXT-REAL-QUERY')
    return kept ? [stableMessage(message)] : []
  })
}

function assertSeedLoaded(shape: string, loaded: Loaded): void {
  for (const mode of ['default', 'explicit'] as const) {
    const messages = loaded[mode]
    expect(messages.slice(0, SEED_CHAIN.length).map((message) => message.uuid), `${shape} ${mode} seed chain`).toEqual(SEED_CHAIN)
    const announcement = messages.find((message) => message.uuid === ANNOUNCEMENT)
    expect(announcement?.type, `${shape} ${mode} old announcement`).toBe('attachment')
    expect(announcement?.attachment?.type, `${shape} ${mode} old announcement kind`).toBe('deferred_tools_delta')
    const tail = messages.filter((message) => message.uuid === KEPT_TOOL || message.uuid === KEPT_IMAGE)
    expect(tail.map((message) => message.uuid), `${shape} ${mode} seed tail`).toEqual([KEPT_TOOL, KEPT_IMAGE])
    expect(JSON.stringify(tail).includes('toolu_kept'), `${shape} ${mode} seed tool`).toBe(true)
    expect(JSON.stringify(tail).includes('aaaa'), `${shape} ${mode} seed image`).toBe(true)
  }
  expect(comparable(loaded.default), `${shape} seed default/explicit`).toEqual(comparable(loaded.explicit))
}

async function assertCompactSurvived(shape: string, stage: string, loaded: Loaded, transcript: string, nextText: string): Promise<void> {
  for (const mode of ['default', 'explicit'] as const) {
    const messages = loaded[mode]
    const boundary = messages.find((message) => message.subtype === 'compact_boundary' && message.compactMetadata?.idleOpId === OP)
    expect(boundary, `${shape} ${mode} ${stage} summary missing`).toBeTruthy()
    expect(messages.some((message) => message.isCompactSummary && message.message?.content === 'synthetic-prepared-summary'), `${shape} ${mode} ${stage} summary missing`).toBe(true)
    const kept = messages.filter((message) => message.uuid === KEPT_TOOL || message.uuid === KEPT_IMAGE)
    expect(kept.map((message) => message.uuid), `${shape} ${mode} ${stage} order`).toEqual([KEPT_TOOL, KEPT_IMAGE])
    expect(JSON.stringify(kept).includes('aaaa'), `${shape} ${mode} ${stage} image`).toBe(true)
    expect(JSON.stringify(kept).includes('toolu_kept'), `${shape} ${mode} ${stage} paired tool`).toBe(true)
    expect(messages.some((message) => JSON.stringify(message.message?.content ?? '').includes(nextText)), `${shape} ${mode} ${stage} next user`).toBe(true)
  }
  expect(comparable(loaded.default), `${shape} ${stage} default/explicit`).toEqual(comparable(loaded.explicit))
  const physical = (await readFile(transcript, 'utf8')).split('\n').filter((line) => line.includes(nextText)).map((line) => JSON.parse(line) as { type?: string; parentUuid?: string }).filter((entry) => entry.type === 'user')
  expect(physical.at(-1)?.parentUuid, `${shape} ${stage} old announcement chain break`).toBe(idleUuid(OP, 'resume-leaf'))
  expect(physical.at(-1)?.parentUuid, `${shape} ${stage} old announcement chain break`).not.toBe(ANNOUNCEMENT)
  expect(await countUuid(transcript, ANNOUNCEMENT), `${shape} ${stage} old announcement rewritten`).toBe(1)
}

async function coldLoad(home: string, work: string, transcript: string, tag: string): Promise<Loaded> {
  const script = join(home, `load-${tag}.ts`)
  const loaded = {} as Loaded
  for (const mode of ['default', 'explicit'] as const) {
    const output = join(home, `loaded-${tag}-${mode}.json`)
    await writeFile(script, `
import { writeFileSync } from 'node:fs';
const { loadConversationForResume } = await import(${JSON.stringify(RECOVERY)});
const explicit = process.argv[2] === 'explicit';
const result = await loadConversationForResume(${JSON.stringify(SESSION)}, explicit ? ${JSON.stringify(transcript)} : undefined);
if (!result || result.sessionId !== ${JSON.stringify(SESSION)}) throw new Error('loader missed session ' + process.argv[2]);
writeFileSync(${JSON.stringify(output)}, JSON.stringify(result.messages));
`)
    const child = spawn('bun', [script, mode], {
      cwd: work,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        OPENCLAUDE_HOME: home,
        CLAUDE_CONFIG_DIR: join(home, 'claude-config'),
      },
    })
    const stderr: Buffer[] = []
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    const code = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('loader timeout')) }, 40_000)
      child.on('exit', (status) => { clearTimeout(timer); resolve(status ?? 1) })
    })
    if (code !== 0) throw new Error(`${tag} ${mode} loader ${code} ${Buffer.concat(stderr).toString('utf8').slice(-800)}`)
    loaded[mode] = JSON.parse(await readFile(output, 'utf8'))
  }
  return loaded
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode) return
  child.kill('SIGTERM')
  await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(undefined) }, 3_000)
    child.on('exit', () => { clearTimeout(timer); resolve(undefined) })
  })
}
