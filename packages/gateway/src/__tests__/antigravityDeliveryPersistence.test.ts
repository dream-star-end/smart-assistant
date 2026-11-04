/**
 * Real fake-CLI -> AntigravityAdapter -> SessionManager runner -> local SQLite.
 * No fake persistence ACK, V3 sink, network, or real Antigravity credentials.
 * This proves local delivery and one settlement EVENT, not production PG/debit
 * or billing-after-persistence ordering (the runner currently flushes first).
 *
 * Run through admission:
 * bash scripts/test-mutex.sh gateway 'npx tsx --test --test-concurrency=1 packages/gateway/src/__tests__/antigravityDeliveryPersistence.test.ts'
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, describe, test } from 'node:test'
import type { OpenClaudeConfig } from '@openclaude/storage'
import type { AgentSession } from '../sessionManager.js'
import type { SessionStreamEvent } from '../ccbMessageParser.js'
import type { EngineExternalBillingEvent } from '../engine/engineEvents.js'

// Storage paths are evaluated at import time: ONLY node/type imports above.
const root = await mkdtemp(path.join(tmpdir(), 'oc-agy-delivery-persistence-'))
const savedEnv = new Map<string, string | undefined>()
function setEnv(key: string, value: string | undefined): void {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key])
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}
setEnv('HOME', path.join(root, 'home'))
setEnv('OPENCLAUDE_HOME', path.join(root, 'openclaude'))
setEnv('OC_SESSIONS_STORE', 'sqlite')
for (const key of ['OC_RUNTIME_CHANNEL', 'OPENCLAUDE_V3_MASTER_BASE_URL', 'OPENCLAUDE_V3_CONTAINER_TOKEN']) {
  setEnv(key, undefined)
}
await mkdir(process.env.HOME!, { recursive: true })
const { paths, getSessionsDb, closeSessionsDb, upsertClientSession, getClientSession } =
  await import('@openclaude/storage')
const { SessionManager } = await import('../sessionManager.js')
const { AntigravityAdapter } = await import('../engine/antigravityAdapter.js')
const { setV3MasterSinkSingleton, getV3MasterSinkOrNull } = await import('../v3MasterSink.js')
const { prepareAntigravityNativeTrajectory, recoverAntigravityNativeTrajectory, ANTIGRAVITY_NATIVE_CLI_SHA256 } =
  await import('../engine/antigravityNativeTrajectory.js')
const { antigravityNativeSchema } = await import('../engine/antigravityNativeSchema.js')
const { default: Database } = await import('better-sqlite3')
const { default: protobuf } = await import('protobufjs')
const require = createRequire(import.meta.url)
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')
setV3MasterSinkSingleton(null)

after(async () => {
  await closeSessionsDb()
  setV3MasterSinkSingleton(null)
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await rm(root, { recursive: true, force: true })
})

const ANSWER = '已完成：这条正文只来自 terminal result.response。'
const NATIVE_ANSWER = '已完成：这条正文只来自 native trajectory 的最终 DONE。'
const CONVERSATION_ID = '63f1f880-9ff7-459a-9585-a40781030fa3'
const REQUEST_ID = 'd'.repeat(32)
const MODEL = 'antigravity-gemini-3.8-flash'

// Kept inline so this test owns its whole fixture. This executable really
// starts a process and performs one file append, rather than mocking spawn.
// Repeated terminal frames do NOT repeat the side effect or add text deltas.
const FAKE_CLI = `#!${process.execPath}
const fs = require('node:fs')
fs.appendFileSync(__dirname + '/spawns.ndjson', JSON.stringify({ pid: process.pid, home: process.env.HOME, execPath: process.execPath, nodeVersion: process.version, modules: process.versions.modules }) + '\\n')
let input = ''
let ran = false
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  input += chunk
  if (ran || !input.includes('\\n')) return
  ran = true
  const f = JSON.parse(fs.readFileSync(__dirname + '/fixture.json', 'utf8'))
  fs.writeFileSync(__dirname + '/input.json', input)
  const emit = event => {
    const line = JSON.stringify(event) + '\\n'
    fs.appendFileSync(__dirname + '/stdout.ndjson', line)
    process.stdout.write(line)
  }
  emit({ event: 'init', conversation_id: f.id })
  emit({ event: 'step_update', step_update: { conversation_id: f.id, step_index: 0, state: 'DONE', step_type: 'user_input' } })
  const tool = { conversation_id: f.id, step_index: f.native ? 2 : 1, step_type: 'tool', tool_name: 'run_command',
    tool_info: { name: 'run_command', parameters: { CommandLine: 'append isolated side effect' } } }
  emit({ event: 'step_update', step_update: { ...tool, state: 'ACTIVE' } })
  fs.appendFileSync(__dirname + '/effects.txt', 'effect\\n')
  emit({ event: 'step_update', step_update: { ...tool, state: 'DONE', tool_info: { ...tool.tool_info, output: 'effect written' } } })
  if (f.native) {
    // Exact exported descriptor, real protobuf encoding and real SQLite. Only
    // the child writes this DB, after prepare and after reading actual stdin.
    const Database = require(f.databaseModule)
    const protobuf = require(f.protobufModule)
    const schema = JSON.parse(fs.readFileSync(__dirname + '/native-schema.json', 'utf8'))
    const root = protobuf.Root.fromJSON(schema).resolveAll()
    const stepType = root.lookupType('gemini_coder_Step')
    const metadataType = root.lookupType('exa_cortex_pb_CortexStepMetadata')
    const types = root.lookupEnum('exa_cortex_pb_CortexStepType').values
    const statuses = root.lookupEnum('exa_cortex_pb_CortexStepStatus').values
    const stops = root.lookupEnum('exa_codeium_common_pb_StopReason').values
    const content = JSON.parse(input.split('\\n')[0]).message.content
    const nativePath = fs.realpathSync(process.env.HOME + '/.gemini/antigravity-cli/conversations') + '/' + f.id + '.db'
    const db = new Database(nativePath)
    try {
      db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER NOT NULL, status INTEGER NOT NULL, step_payload BLOB, metadata BLOB, step_format INTEGER NOT NULL DEFAULT 0); CREATE TABLE trajectory_meta (trajectory_id TEXT PRIMARY KEY, cascade_id TEXT)')
      db.prepare('INSERT INTO trajectory_meta VALUES (?, ?)').run('fixture-trajectory', f.id)
      const toolCall = { id: 'native-tool-1', name: 'run_command', arguments_json: JSON.stringify(tool.tool_info.parameters) }
      const steps = [
        { type: types.CORTEX_STEP_TYPE_USER_INPUT, user_input: { user_response: content } },
        { type: types.CORTEX_STEP_TYPE_PLANNER_RESPONSE, planner_response: {
          response: 'INTERMEDIATE_NOT_FINAL', stop_reason: stops.STOP_REASON_FUNCTION_CALL, tool_calls: [toolCall] } },
        { type: types.CORTEX_STEP_TYPE_GENERIC, metadata: { tool_call: toolCall }, generic: { result: { result: 'effect written' } } },
        { type: types.CORTEX_STEP_TYPE_PLANNER_RESPONSE, planner_response: {
          response: f.answer, modified_response: f.answer, stop_reason: stops.STOP_REASON_STOP_PATTERN } },
      ]
      const insert = db.prepare('INSERT INTO steps VALUES (?, ?, ?, ?, ?, ?)')
      db.transaction(() => steps.forEach((value, idx) => {
        const step = { ...value, status: statuses.CORTEX_STEP_STATUS_DONE }
        const error = stepType.verify(step)
        if (error) throw new Error(error)
        insert.run(idx, step.type, step.status, Buffer.from(stepType.encode(step).finish()),
          step.metadata ? Buffer.from(metadataType.encode(step.metadata).finish()) : null, 0)
      }))()
    } finally { db.close() }
    fs.writeFileSync(__dirname + '/native-evidence.json', JSON.stringify({ nativePath,
      inputHash: require('node:crypto').createHash('sha256').update(content, 'utf8').digest('hex') }))
  }
  // Deliberately no agent_response/text_delta event in EITHER mode.
  const terminal = { event: 'result', result: { conversation_id: f.id, status: 'SUCCESS', response: f.native ? '' : f.answer, num_turns: 1,
    usage: { input_tokens: 10, output_tokens: 7, total_tokens: 17 } } }
  for (let i = 0; i < f.terminalCopies; i++) emit(terminal)
})
process.stdin.on('end', () => { if (!ran) process.exitCode = 2 })
`

function configStub(): OpenClaudeConfig {
  return {
    version: 1,
    gateway: { bind: '127.0.0.1', port: 0, accessToken: '' },
    auth: { mode: 'subscription', claudeCodePath: '' },
    sessions: { dbPath: paths.sessionsDb },
    defaults: { model: MODEL },
  } as unknown as OpenClaudeConfig
}

function makeTurnSession(runner: InstanceType<typeof AntigravityAdapter>, peerId: string): AgentSession {
  return {
    sessionKey: `agent:main:webchat:dm:${peerId}`,
    agentId: 'main', channel: 'webchat', peerId, userId: 'agy-persistence-owner',
    title: 'Antigravity SQLite regression', startedAt: Date.now(),
    runner, ccbSessionId: null, lock: Promise.resolve(), lastUsedAt: 0,
    totalCostUSD: 0, totalInputTokens: 0, totalOutputTokens: 0,
    totalCacheReadTokens: 0, totalCacheCreationTokens: 0, turns: 0,
    _lastCcbCumulativeCost: 0, toolUseIdToName: new Map(),
    executionTarget: { kind: 'local' }, providerTag: 'antigravity',
    model: MODEL, _currentMessageListener: null,
  } as unknown as AgentSession
}

async function runPrivateOneTurn(sm: InstanceType<typeof SessionManager>, session: AgentSession, events: SessionStreamEvent[]): Promise<void> {
  await (sm as unknown as {
    _runOneTurn(session: AgentSession, input: string, onEvent: (event: SessionStreamEvent) => void, requestId: string): Promise<void>
  })._runOneTurn(session, '完成一次文件操作并回复', event => events.push(event), REQUEST_ID)
}

describe('Antigravity durable SQLite delivery', () => {
for (const deliveryMode of ['terminal-response-only', 'native-only'] as const) for (const terminalCopies of [1, 3]) {
  test(`${deliveryMode} survives SQLite reopen (${terminalCopies} terminal frames, one delivery/settlement)`, { timeout: 30_000 }, async () => {
    const native = deliveryMode === 'native-only'
    const expectedAnswer = native ? NATIVE_ANSWER : ANSWER
    const conversationId = native ? `63f1f880-9ff7-459a-9585-a40781030fa${terminalCopies}` : CONVERSATION_ID
    const dir = await mkdtemp(path.join(root, 'turn-'))
    const fake = path.join(dir, 'fake-agy.cjs')
    await writeFile(fake, FAKE_CLI)
    await chmod(fake, 0o755)
    setEnv('OC_ANTIGRAVITY_CLI_BIN', fake)
    await writeFile(path.join(dir, 'fixture.json'), JSON.stringify({
      id: conversationId, answer: expectedAnswer, terminalCopies, native,
      databaseModule: require.resolve('better-sqlite3'), protobufModule: require.resolve('protobufjs'),
    }))
    if (native) await writeFile(path.join(dir, 'native-schema.json'), JSON.stringify(antigravityNativeSchema))
    assert.equal(paths.home, path.join(root, 'openclaude'), 'storage must not resolve the real HOME')
    assert.equal(getV3MasterSinkOrNull(), null, 'must exercise the real local durable append')
    const db = await getSessionsDb()
    assert.equal(path.resolve(db.name), path.join(root, 'openclaude', 'sessions.db'))
    const peerId = `agy-persistence-${deliveryMode}-${terminalCopies}`
    const userId = 'agy-persistence-owner'
    await upsertClientSession({
      id: peerId, userId, agentId: 'main', title: peerId, pinned: false,
      createdAt: 1000, lastAt: 1000, updatedAt: 1000,
      messages: [{ id: `user-${terminalCopies}`, role: 'user', text: '完成一次文件操作并回复', ts: 1000 }],
    })
    assert.equal((await getClientSession(peerId, userId))?.messages.length, 1)
    const preparedInputs: string[] = []
    const adapter = new AntigravityAdapter({
      sessionKey: `agent:main:webchat:dm:${peerId}`, agentId: 'main', agentBaseDir: dir,
      config: configStub(), model: MODEL, effortLevel: 'high',
    }, native ? {
      nativeTrajectory: {
        prepare: async input => {
          assert.equal(existsSync(path.join(dir, 'spawns.ndjson')), false, 'real prepare must precede spawn')
          assert.equal(existsSync(path.join(input.conversationsDir, `${conversationId}.db`)), false)
          preparedInputs.push(sha256(input.message.content))
          const binding = await prepareAntigravityNativeTrajectory(input, {
            // Sole test double: allow the deliberately fake CLI binary.
            verifyBinary: async (cliPath, expectedHash) => {
              assert.equal(cliPath, fake)
              assert.equal(expectedHash, ANTIGRAVITY_NATIVE_CLI_SHA256)
              return true
            },
          })
          assert.equal(binding.binaryVerified, true)
          assert.equal(binding.baseline, -1)
          assert.equal(binding.reason, undefined)
          return binding
        },
        recover: recoverAntigravityNativeTrajectory,
      },
    } : undefined)
    const adapterErrors: unknown[] = []
    adapter.on('error', error => adapterErrors.push(error))
    const billings: EngineExternalBillingEvent[] = []
    adapter.on('external_billing', event => billings.push(event))
    // No listener or request reaches this URL: the fake CLI is fully offline.
    const routeToken = 'a'.repeat(64)
    adapter.setAntigravityRoute({
      baseUrl: `http://127.0.0.1:1/internal/v5/antigravity-relay/route/${routeToken}`,
      routeToken, accessToken: 'fixture-not-a-real-token', accessTokenExpiresAt: '2099-01-01T00:00:00Z',
    })
    const sm = new SessionManager(configStub())
    const session = makeTurnSession(adapter, peerId)
    const events: SessionStreamEvent[] = []
    try {
      await runPrivateOneTurn(sm, session, events)
      await adapter.waitForOutputDrain()
      await sm.awaitPendingPersistence()
      assert.deepEqual(adapterErrors, [])
      assert.deepEqual(events.filter(event => event.kind === 'error'), [])
      const spawns = (await readFile(path.join(dir, 'spawns.ndjson'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
      assert.equal(spawns.length, 1, 'must not retry the CLI')
      assert.notEqual(spawns[0].pid, process.pid, 'real child process, not an in-process fake runner')
      assert.equal(spawns[0].execPath, process.execPath, 'safe PATH must not select a different Node ABI')
      assert.equal(spawns[0].nodeVersion, process.version)
      assert.equal(spawns[0].modules, process.versions.modules)
      assert.ok(path.resolve(spawns[0].home).startsWith(root + path.sep), 'CLI HOME must also be isolated')
      assert.equal(await readFile(path.join(dir, 'effects.txt'), 'utf8'), 'effect\n', 'one actual tool side effect')
      assert.match(await readFile(path.join(dir, 'input.json'), 'utf8'), /完成一次文件操作并回复/)
      const textBlocks = events.filter(event => event.kind === 'block' && event.block.kind === 'text')
      assert.equal(textBlocks.length, 1, 'one live body block even with repeated terminal frames')
      assert.equal(textBlocks.map(event => event.kind === 'block' && event.block.kind === 'text' ? event.block.text : '').join(''), expectedAnswer)
      if (native) {
        const stdin = JSON.parse((await readFile(path.join(dir, 'input.json'), 'utf8')).trim())
        assert.deepEqual(preparedInputs, [sha256(stdin.message.content)], 'bind exact composed stdin, not just the user prompt')
        const stdout = (await readFile(path.join(dir, 'stdout.ndjson'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
        assert.equal(stdout.filter(event => event.event === 'result').length, terminalCopies)
        assert.ok(stdout.filter(event => event.event === 'result').every(event => event.result.response === ''))
        assert.equal(JSON.stringify(stdout).includes(expectedAnswer), false, 'answer cannot arrive via stdout')
        assert.ok(stdout.every(event => event.step_update?.step_type !== 'agent_response' && !event.step_update?.text_delta))
        const evidence = JSON.parse(await readFile(path.join(dir, 'native-evidence.json'), 'utf8'))
        assert.equal(evidence.inputHash, sha256(stdin.message.content))
        assert.ok(path.resolve(evidence.nativePath).startsWith(root + path.sep))
        assert.equal(path.basename(evidence.nativePath), `${conversationId}.db`)
        const nativeDb = new Database(evidence.nativePath, { readonly: true, fileMustExist: true })
        try {
          const nativeRoot = protobuf.Root.fromJSON(antigravityNativeSchema).resolveAll()
          const stepType = nativeRoot.lookupType('gemini_coder_Step')
          const rows = nativeDb.prepare('SELECT step_payload FROM steps ORDER BY idx').all() as Array<{ step_payload: Buffer }>
          assert.equal(rows.length, 4)
          const steps = rows.map(row => stepType.toObject(stepType.decode(row.step_payload)))
          assert.equal(sha256(steps[0].user_input.user_response), sha256(stdin.message.content))
          assert.equal(steps[3].planner_response.response, expectedAnswer)
          assert.equal(steps[3].status, nativeRoot.lookupEnum('exa_cortex_pb_CortexStepStatus').values.CORTEX_STEP_STATUS_DONE)
        } finally { nativeDb.close() }
      }
      assert.equal(events.filter(event => event.kind === 'final').length, 1)
      assert.equal(session.turns, 1)
      assert.equal(billings.length, 1, 'adapter emits one terminal settlement event')
      const forwarded = events.filter(event => event.kind === 'external_billing')
      assert.equal(forwarded.length, 1, 'SessionManager forwards one terminal settlement event')
      assert.equal(forwarded[0].requestId, REQUEST_ID)
      assert.equal(forwarded[0].status, 'success')
      assert.equal(forwarded[0].engine, 'antigravity')
      assert.equal(billings[0].status, 'success')

      // Check the actual database row, then close/reopen its handle before
      // the public API read: an ACK or in-memory snapshot cannot satisfy this.
      const raw = db.prepare('SELECT messages FROM client_sessions WHERE id = ? AND user_id = ?')
        .get(peerId, userId) as { messages: string }
      const diskMessages = JSON.parse(raw.messages) as Array<Record<string, unknown>>
      const diskAnswers = diskMessages.filter(message => message.role === 'assistant')
      assert.equal(diskMessages.length, 2, 'original user plus exactly one assistant (no duplicate terminal row)')
      assert.equal(diskAnswers.length, 1)
      assert.equal(diskAnswers[0].text, expectedAnswer)
      assert.equal(diskAnswers[0]._source, 'server')
      assert.equal(diskAnswers[0].status, 'completed')
      assert.equal(diskAnswers[0].id, `srv-${peerId}-main-t1`)
      await closeSessionsDb()
      const refreshed = await getClientSession(peerId, userId)
      assert.ok(refreshed, 'public refresh/read API must recover from SQLite')
      assert.deepEqual(refreshed.messages, diskMessages)
      assert.equal(await getClientSession(peerId, 'not-the-owner'), null, 'readback retains owner isolation')
    } finally {
      await adapter.shutdown()
      await sm.awaitPendingPersistence()
    }
  })
}

})
