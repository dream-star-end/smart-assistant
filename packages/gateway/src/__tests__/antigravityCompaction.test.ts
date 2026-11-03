/**
 * OCV5-680 — Antigravity native compaction reuse, caller audit, internal
 * `context_compacted` observation on `checkpoint` steps, and model-switch
 * handoff reading `step_type=23` `<summary>` with fallback.
 *
 * Uses synthetic SQLite conversation DB fixtures matching the real
 * `<OPENCLAUDE_HOME>/antigravity-cli/home/.gemini/antigravity-cli/conversations/<uuid>.db`
 * `steps` table schema and `CortexTrajectoryStep` protobuf wire layout
 * (zero real user text, zero live/paid model calls).
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/antigravityCompaction.test.ts
 */
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'
import { type OutboundMessage, SysContextCompacted } from '@openclaude/protocol'
import { Value } from '@sinclair/typebox/value'
import type { AgentDef, OpenClaudeConfig } from '@openclaude/storage'
import Database from 'better-sqlite3'

import { boxTurnMayIdle } from '../boxIdleCompact.js'
import { buildContextObservationFrame } from '../contextObservationFrames.js'
import { ANTIGRAVITY_RELAY_PATH_PREFIX, AntigravityAdapter } from '../engine/antigravityAdapter.js'
import {
  extractAntigravityCheckpointSummary,
  readLatestAntigravityCheckpointSummary,
  readLatestAntigravityNativeHandoff,
} from '../engine/antigravityCompaction.js'
import { CcbAdapter } from '../engine/ccbAdapter.js'
import { CursorAdapter } from '../engine/cursorAdapter.js'
import type { EngineContentEvent, EngineEvent } from '../engine/engineEvents.js'
import { GrokAdapter } from '../engine/grokAdapter.js'
import {
  type EngineAuthorityOverride,
  type EngineCreateOpts,
  registerEngine,
} from '../engine/registry.js'
import { ZcodeAdapter } from '../engine/zcodeAdapter.js'
import type { HistoricalTurnInput } from '../historicalContextPayload.js'
import { type AgentSession, SessionManager } from '../sessionManager.js'
import type { SubprocessRunner } from '../subprocessRunner.js'
import { MinimalPrivacyRunner } from './fixtures/minimalPrivacyRunner.js'

const TOKEN = 'a'.repeat(64)
const ROUTE = {
  baseUrl: `http://127.0.0.1:18789${ANTIGRAVITY_RELAY_PATH_PREFIX}${TOKEN}`,
  routeToken: TOKEN,
  accessToken: 'ya29.synthetic-limited-userinfo-token',
  accessTokenExpiresAt: '2026-12-01T00:00:00Z',
  idToken: 'eyJhbGciOi.synthetic.sig',
}

function makeConfig(): OpenClaudeConfig {
  return {
    version: 1,
    gateway: { bind: '127.0.0.1', port: 0, accessToken: '' },
    auth: { mode: 'subscription', claudeCodePath: '' },
    sessions: { dbPath: '' },
    defaults: { model: 'antigravity-gemini-3.8-flash' },
  } as unknown as OpenClaudeConfig
}

/** Protobuf wire helpers for synthetic `CortexTrajectoryStep` fixtures. */
function encodeVarint(value: number | bigint): Buffer {
  let v = typeof value === 'bigint' ? value : BigInt(value)
  const bytes: number[] = []
  while (v >= 0x80n) {
    bytes.push(Number(v & 0x7fn) | 0x80)
    v >>= 7n
  }
  bytes.push(Number(v))
  return Buffer.from(bytes)
}

function encodeVarintField(fieldNumber: number, value: number | bigint): Buffer {
  return Buffer.concat([encodeVarint((fieldNumber << 3) | 0), encodeVarint(value)])
}

function encodeBytesField(fieldNumber: number, data: Buffer | string): Buffer {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
  return Buffer.concat([encodeVarint((fieldNumber << 3) | 2), encodeVarint(buf.length), buf])
}

/**
 * Encodes a synthetic `CortexTrajectoryStep` (`step_type = 23` CHECKPOINT):
 *   - field 1 (varint): step_type (23)
 *   - field 4 (varint): status (3 = DONE, 5 = CANCELLED)
 *   - field 5 (bytes): synthetic metadata
 *   - field 30 (bytes): `CortexStepCheckpoint`
 *       - field 5 (bytes): `session_summary`
 *       - field 12 (varint): `checkpoint_index`
 *       - field 26 (bytes): synthetic file snapshot diff (must NOT leak into handoff)
 */
function encodeSyntheticCheckpointStep(opts: {
  idx: number
  status: number
  sessionSummary?: string
  artifactDiff?: string
}): Buffer {
  const parts: Buffer[] = [
    encodeVarintField(1, 23),
    encodeVarintField(4, opts.status),
    encodeBytesField(5, Buffer.from([0x08, 0x01])),
  ]
  if (opts.sessionSummary !== undefined) {
    const checkpointParts: Buffer[] = [
      encodeBytesField(5, opts.sessionSummary),
      encodeVarintField(12, opts.idx),
    ]
    if (opts.artifactDiff) {
      checkpointParts.push(encodeBytesField(26, opts.artifactDiff))
    }
    parts.push(encodeBytesField(30, Buffer.concat(checkpointParts)))
  }
  return Buffer.concat(parts)
}

function conversationDbPath(openclaudeHome: string, conversationId: string): string {
  return path.join(
    openclaudeHome,
    'antigravity-cli',
    'home',
    '.gemini',
    'antigravity-cli',
    'conversations',
    `${conversationId}.db`,
  )
}

async function createSyntheticAntigravityDb(
  openclaudeHome: string,
  conversationId: string,
  rows: Array<{
    idx: number
    stepType: number
    status: number
    payload: Buffer | null
    stepFormat?: number
  }>,
): Promise<string> {
  const dbFile = conversationDbPath(openclaudeHome, conversationId)
  await mkdir(path.dirname(dbFile), { recursive: true })
  const db = new Database(dbFile)
  try {
    db.exec(`
      CREATE TABLE trajectory_meta (key TEXT PRIMARY KEY, value BLOB);
      CREATE TABLE steps (
        idx integer,
        step_type integer NOT NULL DEFAULT 0,
        status integer NOT NULL DEFAULT 0,
        has_subtrajectory numeric NOT NULL DEFAULT false,
        metadata blob,
        error_details blob,
        permissions blob,
        task_details blob,
        render_info blob,
        step_payload blob,
        step_format integer NOT NULL DEFAULT 0,
        PRIMARY KEY (idx)
      );
      CREATE INDEX idx_steps_step_type ON steps(step_type);
    `)
    db.prepare('INSERT INTO trajectory_meta (key, value) VALUES (?, ?)').run(
      'meta',
      Buffer.from('synthetic-meta', 'utf8'),
    )
    const insert = db.prepare(
      'INSERT INTO steps (idx, step_type, status, has_subtrajectory, step_payload, step_format) VALUES (?, ?, ?, 0, ?, ?)',
    )
    for (const row of rows) {
      insert.run(row.idx, row.stepType, row.status, row.payload, row.stepFormat ?? 0)
    }
  } finally {
    db.close()
  }
  return dbFile
}

const FAKE_CLI_SCRIPT = `#!/usr/bin/env node
const fs = require('node:fs');
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { stdin += chunk; });
setTimeout(() => {
  fs.writeFileSync(process.env.FAKE_AGY_CAPTURE, JSON.stringify({
    argv: process.argv.slice(2),
    settings: fs.readFileSync(process.env.HOME + '/.gemini/antigravity-cli/settings.json', 'utf8'),
    stdin,
  }));
  const lines = fs.readFileSync(process.env.FAKE_AGY_FIXTURE, 'utf8').trim().split('\\n');
  for (const line of lines) {
    if (line.trim()) process.stdout.write(line + '\\n');
  }
  process.exit(0);
}, 15);
`

describe('OCV5-680 supportsNativeCompact capability and caller behavior matrix', () => {
  test('Antigravity advertises supportsNativeCompact=true while keeping --disable-slash-commands and zero /compact turns', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'oc-agy-compact-caps-'))
    const savedHome = process.env.OPENCLAUDE_HOME
    const savedBin = process.env.OC_ANTIGRAVITY_CLI_BIN
    const savedCapture = process.env.FAKE_AGY_CAPTURE
    const savedFixture = process.env.FAKE_AGY_FIXTURE
    try {
      const openclaudeHome = path.join(dir, 'oc-home')
      const fakeCli = path.join(dir, 'fake-agy.cjs')
      const capturePath = path.join(dir, 'capture.json')
      const fixturePath = path.join(dir, 'turn.ndjson')
      await writeFile(fakeCli, FAKE_CLI_SCRIPT)
      await chmod(fakeCli, 0o755)
      const convId = '11111111-2222-4333-8444-555555555555'
      await writeFile(
        fixturePath,
        `${[
          { event: 'init', conversation_id: convId },
          { event: 'step_update', step_update: { step_type: 'user_input', step_index: 1, state: 'DONE' } },
          {
            event: 'step_update',
            step_update: { step_type: 'agent_response', step_index: 2, state: 'DONE', text_delta: 'SYNTHETIC_OK' },
          },
          { event: 'result', result: { conversation_id: convId, status: 'SUCCESS', response: 'SYNTHETIC_OK' } },
        ]
          .map((row) => JSON.stringify(row))
          .join('\n')}\n`,
      )

      process.env.OPENCLAUDE_HOME = openclaudeHome
      process.env.OC_ANTIGRAVITY_CLI_BIN = fakeCli
      process.env.FAKE_AGY_CAPTURE = capturePath
      process.env.FAKE_AGY_FIXTURE = fixturePath

      const cfg = makeConfig()
      const opts = {
        sessionKey: 'agent:main:webchat:dm:caps-audit',
        agentId: 'main',
        agentBaseDir: dir,
        config: cfg,
        model: 'antigravity-gemini-3.8-flash',
      } as EngineCreateOpts

      const agy = new AntigravityAdapter(opts)
      const grok = new GrokAdapter({ ...opts, model: 'grok-build' })
      const cursor = new CursorAdapter({ ...opts, model: 'cursor-auto' })
      const zcode = new ZcodeAdapter({ ...opts, model: 'zcode-glm-5.3' })
      const ccb = new CcbAdapter(opts, new MinimalPrivacyRunner() as unknown as SubprocessRunner)

      assert.equal(agy.capabilities.supportsNativeCompact, true)
      assert.equal(typeof agy.compactForHandoff, 'function')
      assert.equal(grok.capabilities.supportsNativeCompact, true)
      assert.equal(ccb.capabilities.supportsNativeCompact, true)
      assert.equal(cursor.capabilities.supportsNativeCompact, false)
      assert.equal(zcode.capabilities.supportsNativeCompact, false)

      // Box idle compaction caller remains strictly false for Antigravity models.
      assert.equal(
        boxTurnMayIdle({ model: 'antigravity-gemini-3.8-flash', contextOwner: undefined }),
        false,
      )

      // Spawned CLI still passes --disable-slash-commands and untouched empty settings.json.
      agy.setAntigravityRoute(ROUTE)
      const run = agy.submitTurn({
        input: 'synthetic ping',
        requestId: 'b'.repeat(32),
        onEvent: () => {},
        sessionTotals: { totalCostUSD: 0, turns: 0 },
        toolUseIdToName: new Map(),
      })
      await run.submitted
      await run.summary
      await agy.waitForOutputDrain()

      const captured = JSON.parse(await readFile(capturePath, 'utf8')) as {
        argv: string[]
        settings: string
      }
      assert.ok(
        captured.argv.includes('--disable-slash-commands'),
        '--disable-slash-commands must remain present in OCV5-680',
      )
      assert.deepEqual(JSON.parse(captured.settings), {})
    } finally {
      if (savedHome === undefined) Reflect.deleteProperty(process.env, 'OPENCLAUDE_HOME')
      else process.env.OPENCLAUDE_HOME = savedHome
      if (savedBin === undefined) Reflect.deleteProperty(process.env, 'OC_ANTIGRAVITY_CLI_BIN')
      else process.env.OC_ANTIGRAVITY_CLI_BIN = savedBin
      if (savedCapture === undefined) Reflect.deleteProperty(process.env, 'FAKE_AGY_CAPTURE')
      else process.env.FAKE_AGY_CAPTURE = savedCapture
      if (savedFixture === undefined) Reflect.deleteProperty(process.env, 'FAKE_AGY_FIXTURE')
      else process.env.FAKE_AGY_FIXTURE = savedFixture
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('OCV5-680 adapter checkpoint step -> internal context_compacted observation', () => {
  test('emits internal context_compacted once per own DONE checkpoint without context_pressure or UI warning blocks', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'oc-agy-checkpoint-step-'))
    const savedHome = process.env.OPENCLAUDE_HOME
    const savedBin = process.env.OC_ANTIGRAVITY_CLI_BIN
    const savedCapture = process.env.FAKE_AGY_CAPTURE
    const savedFixture = process.env.FAKE_AGY_FIXTURE
    try {
      const fakeCli = path.join(dir, 'fake-agy.cjs')
      const capturePath = path.join(dir, 'capture.json')
      const fixturePath = path.join(dir, 'checkpoint-turn.ndjson')
      await writeFile(fakeCli, FAKE_CLI_SCRIPT)
      await chmod(fakeCli, 0o755)
      const convId = 'b6a20f78-e0af-4f8d-8707-f9bd44245832'

      // Includes:
      // 1) Replayed historical checkpoint from an earlier --conversation launch (step_index 40 < 180) -> ignored
      // 2) Own user_input at step_index 180
      // 3) Own checkpoint ACTIVE -> DONE -> duplicate DONE at step_index 181 -> exactly 1 context_compacted
      // 4) Failed/cancelled checkpoint ERROR at step_index 182 -> ignored
      // 5) Normal assistant reply at step_index 183
      await writeFile(
        fixturePath,
        `${[
          { event: 'init', conversation_id: convId },
          { event: 'step_update', step_update: { step_type: 'checkpoint', step_index: 40, state: 'DONE' } },
          { event: 'step_update', step_update: { step_type: 'user_input', step_index: 180, state: 'DONE' } },
          { event: 'step_update', step_update: { step_type: 'checkpoint', step_index: 181, state: 'ACTIVE' } },
          { event: 'step_update', step_update: { step_type: 'checkpoint', step_index: 181, state: 'DONE' } },
          { event: 'step_update', step_update: { step_type: 'checkpoint', step_index: 181, state: 'DONE' } },
          { event: 'step_update', step_update: { step_type: 'checkpoint', step_index: 182, state: 'ERROR' } },
          {
            event: 'step_update',
            step_update: {
              step_type: 'agent_response',
              step_index: 183,
              state: 'DONE',
              text_delta: 'SYNTHETIC_POST_COMPACT_REPLY',
            },
          },
          {
            event: 'result',
            result: { conversation_id: convId, status: 'SUCCESS', response: 'SYNTHETIC_POST_COMPACT_REPLY' },
          },
        ]
          .map((row) => JSON.stringify(row))
          .join('\n')}\n`,
      )

      process.env.OPENCLAUDE_HOME = path.join(dir, 'oc-home')
      process.env.OC_ANTIGRAVITY_CLI_BIN = fakeCli
      process.env.FAKE_AGY_CAPTURE = capturePath
      process.env.FAKE_AGY_FIXTURE = fixturePath

      const adapter = new AntigravityAdapter({
        sessionKey: 'agent:main:webchat:dm:checkpoint-obs',
        agentId: 'main',
        agentBaseDir: dir,
        config: makeConfig(),
        model: 'antigravity-gemini-3.8-flash',
        resumeSessionId: convId,
      } as EngineCreateOpts)
      adapter.setAntigravityRoute(ROUTE)

      const events: EngineEvent[] = []
      const run = adapter.submitTurn({
        input: 'continue synthetic task',
        requestId: 'c'.repeat(32),
        assistantMessageId: 'asst-compact-1',
        onEvent: (event) => events.push(event),
        sessionTotals: { totalCostUSD: 0, turns: 0 },
        toolUseIdToName: new Map(),
      })
      await run.submitted
      const summary = await run.summary
      await adapter.waitForOutputDrain()

      assert.equal(summary?.isError, false)
      assert.equal(summary?.assistantText, 'SYNTHETIC_POST_COMPACT_REPLY')

      const compacted = events.filter(
        (e): e is Extract<EngineContentEvent, { kind: 'context_compacted' }> =>
          e.kind === 'context_compacted',
      )
      assert.deepEqual(compacted, [
        {
          kind: 'context_compacted',
          compaction: {
            engine: 'antigravity',
            scope: 'native_context',
            strategy: 'native_summary',
          },
        },
      ])

      // Verify wire frame matches protocol SysContextCompacted schema.
      const out: OutboundMessage = {
        type: 'outbound.message',
        sessionKey: 'agent:main:webchat:dm:checkpoint-obs',
        channel: 'webchat',
        peer: { kind: 'dm', id: 'checkpoint-obs' },
        blocks: [],
        isFinal: false,
      }
      const frame = buildContextObservationFrame(out, 'main', compacted[0]!)
      assert.equal(frame.type, 'sys.context_compacted')
      assert.equal(Value.Check(SysContextCompacted, frame), true)

      // t1386u: zero context_pressure ("almost full"), zero turn_status, zero extra UI blocks.
      assert.equal(events.some((e) => e.kind === 'context_pressure'), false)
      assert.equal(events.some((e) => e.kind === 'turn_status'), false)
      const blocks = events.filter((e) => e.kind === 'block')
      assert.equal(blocks.length, 1)
      assert.equal(blocks[0]?.kind === 'block' && blocks[0].block.kind, 'text')
    } finally {
      if (savedHome === undefined) Reflect.deleteProperty(process.env, 'OPENCLAUDE_HOME')
      else process.env.OPENCLAUDE_HOME = savedHome
      if (savedBin === undefined) Reflect.deleteProperty(process.env, 'OC_ANTIGRAVITY_CLI_BIN')
      else process.env.OC_ANTIGRAVITY_CLI_BIN = savedBin
      if (savedCapture === undefined) Reflect.deleteProperty(process.env, 'FAKE_AGY_CAPTURE')
      else process.env.FAKE_AGY_CAPTURE = savedCapture
      if (savedFixture === undefined) Reflect.deleteProperty(process.env, 'FAKE_AGY_FIXTURE')
      else process.env.FAKE_AGY_FIXTURE = savedFixture
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('OCV5-680 read-only SQLite step_type=23 checkpoint summary extraction', () => {
  test('selects latest completed step_type=23 <summary>, skips cancelled status=5, excludes field 26 diffs, and stays read-only', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'oc-agy-sqlite-'))
    try {
      const openclaudeHome = path.join(dir, 'oc-home')
      const convId = 'b6a20f78-e0af-4f8d-8707-f9bd44245832'
      const olderSummary = '<summary>\n1. Task Overview\nSYNTHETIC_CHECKPOINT_V1\n</summary>'
      const latestSummary = [
        '<summary>',
        '1. Task Overview',
        'SYNTHETIC_CHECKPOINT_V2_LATEST',
        '2. Key Findings',
        'Code mentions literal `<summary>inner-literal</summary>` tag without truncating.',
        '</summary>',
      ].join('\n')

      const dbFile = await createSyntheticAntigravityDb(openclaudeHome, convId, [
        { idx: 1, stepType: 14, status: 3, payload: Buffer.from([0x08, 0x0e]) },
        {
          idx: 181,
          stepType: 23,
          status: 3,
          payload: encodeSyntheticCheckpointStep({
            idx: 181,
            status: 3,
            sessionSummary: olderSummary,
            artifactDiff: 'diff --git a/old.ts b/old.ts\n+<summary>OLD_DIFF_NOISE</summary>',
          }),
        },
        {
          idx: 406,
          stepType: 23,
          status: 3,
          payload: encodeSyntheticCheckpointStep({
            idx: 406,
            status: 3,
            sessionSummary: latestSummary,
            artifactDiff: `diff --git a/src/a.ts b/src/a.ts\n+<summary>DIFF_NOISE_MUST_NOT_LEAK</summary>\n${'x'.repeat(32_000)}`,
          }),
        },
        // Trailing cancelled checkpoint (status=5, no field 30) as observed in real agy DBs.
        {
          idx: 512,
          stepType: 23,
          status: 5,
          payload: encodeSyntheticCheckpointStep({ idx: 512, status: 5 }),
        },
      ])

      // Lock file permissions to read-only (0400) and verify bytes remain untouched.
      await chmod(dbFile, 0o400)
      const beforeBytes = await readFile(dbFile)
      const beforeStat = await stat(dbFile)

      const startedAt = 1_760_000_000_000
      const artifact = await readLatestAntigravityNativeHandoff(openclaudeHome, convId, startedAt)
      assert.ok(artifact)
      assert.equal(artifact.source, 'antigravity')
      assert.equal(artifact.compactStartedAt, startedAt)
      assert.match(artifact.summaryText, /SYNTHETIC_CHECKPOINT_V2_LATEST/)
      assert.match(artifact.summaryText, /`<summary>inner-literal<\/summary>`/)
      assert.doesNotMatch(artifact.summaryText, /SYNTHETIC_CHECKPOINT_V1/)
      assert.doesNotMatch(artifact.summaryText, /DIFF_NOISE_MUST_NOT_LEAK/)

      const afterBytes = await readFile(dbFile)
      const afterStat = await stat(dbFile)
      assert.equal(Buffer.compare(beforeBytes, afterBytes), 0)
      assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('returns null cleanly on missing DB, non-UUID id, symlink DB, corrupt payload, or conversation without checkpoints', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'oc-agy-sqlite-edge-'))
    try {
      const openclaudeHome = path.join(dir, 'oc-home')
      const noCheckpointId = '22222222-3333-4444-8555-666666666666'
      await createSyntheticAntigravityDb(openclaudeHome, noCheckpointId, [
        { idx: 0, stepType: 14, status: 3, payload: Buffer.from([0x08, 0x0e]) },
        { idx: 1, stepType: 15, status: 3, payload: Buffer.from([0x08, 0x0f]) },
      ])
      assert.equal(readLatestAntigravityCheckpointSummary(openclaudeHome, noCheckpointId), null)
      assert.equal(
        readLatestAntigravityCheckpointSummary(
          openclaudeHome,
          '33333333-4444-4555-8666-777777777777',
        ),
        null,
      )
      assert.equal(readLatestAntigravityCheckpointSummary(openclaudeHome, '../escape'), null)
      assert.equal(extractAntigravityCheckpointSummary(Buffer.from([0xff, 0xff, 0xff]), 0), null)
      assert.equal(
        extractAntigravityCheckpointSummary(
          encodeSyntheticCheckpointStep({
            idx: 10,
            status: 3,
            sessionSummary: '<summary>   </summary>',
          }),
          0,
        ),
        null,
      )

      // Symlinked conversation DB must be rejected.
      const realDb = await createSyntheticAntigravityDb(
        openclaudeHome,
        '44444444-5555-4666-8777-888888888888',
        [
          {
            idx: 50,
            stepType: 23,
            status: 3,
            payload: encodeSyntheticCheckpointStep({
              idx: 50,
              status: 3,
              sessionSummary: '<summary>SYNTHETIC_SYMLINK_TARGET</summary>',
            }),
          },
        ],
      )
      const symlinkId = '55555555-6666-4777-8888-999999999999'
      await symlink(realDb, conversationDbPath(openclaudeHome, symlinkId))
      assert.equal(readLatestAntigravityCheckpointSummary(openclaudeHome, symlinkId), null)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('OCV5-680 SessionManager model-switch handoff & fallback', () => {
  interface SmInternals {
    _resumeMap: Map<string, string>
    _resumeMapProvider: Map<string, string>
    _saveResumeMap: () => void
    runOneTurnWithRetry: (session: AgentSession, input: HistoricalTurnInput) => Promise<void>
  }

  class MockCodexPrivacyRunner extends MinimalPrivacyRunner {
    sessionId: string | null = null
    isRunning = false
    lastActivityAt = Date.now()
    model: string | undefined
    constructor(model: string | undefined) {
      super()
      this.model = model
    }
    async start(): Promise<void> {
      this.recordBuiltPromptPrivacy()
      this.isRunning = true
    }
    async shutdown(): Promise<void> {
      this.isRunning = false
    }
    clearSessionId(): void {}
    setModel(m: string | undefined): void {
      this.model = m
    }
    setResumeSessionId(): void {}
    async waitForOutputDrain(): Promise<void> {}
    interrupt(): boolean {
      return false
    }
  }

  function registerTargetMockCodex(): void {
    registerEngine('codex', (opts) => {
      const runner = new MockCodexPrivacyRunner(opts.model)
      const adapter = new CcbAdapter(opts, runner as unknown as SubprocessRunner)
      Object.defineProperty(adapter, 'engineId', { value: 'codex' })
      Object.assign(adapter.capabilities, {
        historyMode: 'native-resume',
        maxPromptBytes: 96 * 1024,
      })
      return adapter
    })
  }

  test('prepareModelSwitch injects agy step_type=23 <summary> without spawning CLI, and falls back to historical context when unavailable', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'oc-agy-switch-prep-'))
    const savedHome = process.env.OPENCLAUDE_HOME
    const savedBin = process.env.OC_ANTIGRAVITY_CLI_BIN
    try {
      const openclaudeHome = path.join(dir, 'oc-home')
      process.env.OPENCLAUDE_HOME = openclaudeHome
      // Point CLI bin to a nonexistent path to prove prepareModelSwitch spawns ZERO subprocesses.
      process.env.OC_ANTIGRAVITY_CLI_BIN = path.join(dir, 'must-never-spawn')

      registerEngine('antigravity', (opts) => new AntigravityAdapter(opts))
      registerTargetMockCodex()

      const agent = { id: 'main', cwd: dir } as AgentDef

      // 1) Checkpoint <summary> available -> injected via <openclaude_native_model_handoff>.
      const convWithSummary = '66666666-7777-4888-8999-aaaaaaaaaaaa'
      await createSyntheticAntigravityDb(openclaudeHome, convWithSummary, [
        {
          idx: 220,
          stepType: 23,
          status: 3,
          payload: encodeSyntheticCheckpointStep({
            idx: 220,
            status: 3,
            sessionSummary:
              '<summary>\n1. Task Overview\nSYNTHETIC_PREPARED_HANDOFF_SUMMARY\n</summary>',
            artifactDiff: 'diff --git a/x b/x\n+MUST_NOT_APPEAR_IN_PROMPT',
          }),
        },
      ])

      const sm1 = new SessionManager(makeConfig())
      const i1 = sm1 as unknown as SmInternals
      i1._saveResumeMap = () => {}
      const key1 = 'agent:main:webchat:dm:agy-prep-with-summary'
      i1._resumeMap.set(key1, convWithSummary)
      i1._resumeMapProvider.set(key1, 'antigravity')

      const source1 = await sm1.getOrCreate({
        sessionKey: key1,
        peerId: 'agy-prep-with-summary',
        channel: 'webchat',
        agent,
        model: 'antigravity-gemini-3.8-flash',
        executionAuthority: {
          engine: 'antigravity',
          canonicalModel: 'antigravity-gemini-3.8-flash',
          source: 'local_catalog',
        } as EngineAuthorityOverride,
      })
      assert.equal(source1.runner.nativeSessionId, convWithSummary)

      const switchId1 = 'model-switch:agy:summary1'
      const prepared1 = await sm1.prepareModelSwitch(
        source1,
        'antigravity-gemini-3.8-flash',
        'gpt-5.6-sol',
        switchId1,
      )
      assert.deepEqual(prepared1, {
        sourceModel: 'antigravity-gemini-3.8-flash',
        targetModel: 'gpt-5.6-sol',
      })
      assert.match(
        source1._modelSwitchTransition?.summaryText ?? '',
        /SYNTHETIC_PREPARED_HANDOFF_SUMMARY/,
      )

      const target1 = await sm1.getOrCreate({
        sessionKey: key1,
        peerId: 'agy-prep-with-summary',
        channel: 'webchat',
        agent,
        model: 'gpt-5.6-sol',
        modelSwitchId: switchId1,
        executionAuthority: {
          engine: 'codex',
          canonicalModel: 'gpt-5.6-sol',
          source: 'local_catalog',
        } as EngineAuthorityOverride,
      })
      const capturedInputs1: HistoricalTurnInput[] = []
      i1.runOneTurnWithRetry = async (_s, input) => {
        capturedInputs1.push(input)
      }
      await sm1.submit(
        target1,
        'continue on target model',
        () => {},
        undefined,
        'gpt-5.6-sol',
        undefined,
        undefined,
        undefined,
        {
          modelSwitchId: switchId1,
          historicalMessages: [
            { role: 'assistant', id: 'srv-1', text: 'RAW_HISTORY_SHOULD_NOT_REPLACE_SUMMARY' },
          ],
        },
      )
      assert.equal(capturedInputs1.length, 1)
      assert.match(String(capturedInputs1[0]), /<openclaude_native_model_handoff>/)
      assert.match(String(capturedInputs1[0]), /SYNTHETIC_PREPARED_HANDOFF_SUMMARY/)
      assert.doesNotMatch(String(capturedInputs1[0]), /MUST_NOT_APPEAR_IN_PROMPT/)
      assert.doesNotMatch(String(capturedInputs1[0]), /RAW_HISTORY_SHOULD_NOT_REPLACE_SUMMARY/)
      assert.match(String(capturedInputs1[0]), /<current_user_message>\ncontinue on target model/)

      // 2) Checkpoint <summary> unavailable -> falls back to existing buildHistoricalContextPayload.
      const convNoSummary = '77777777-8888-4999-8aaa-bbbbbbbbbbbb'
      await createSyntheticAntigravityDb(openclaudeHome, convNoSummary, [
        { idx: 1, stepType: 14, status: 3, payload: Buffer.from([0x08, 0x0e]) },
      ])

      const sm2 = new SessionManager(makeConfig())
      const i2 = sm2 as unknown as SmInternals
      i2._saveResumeMap = () => {}
      const key2 = 'agent:main:webchat:dm:agy-prep-fallback'
      i2._resumeMap.set(key2, convNoSummary)
      i2._resumeMapProvider.set(key2, 'antigravity')

      const source2 = await sm2.getOrCreate({
        sessionKey: key2,
        peerId: 'agy-prep-fallback',
        channel: 'webchat',
        agent,
        model: 'antigravity-gemini-3.8-flash',
        executionAuthority: {
          engine: 'antigravity',
          canonicalModel: 'antigravity-gemini-3.8-flash',
          source: 'local_catalog',
        } as EngineAuthorityOverride,
      })
      const switchId2 = 'model-switch:agy:fallback2'
      const prepared2 = await sm2.prepareModelSwitch(
        source2,
        'antigravity-gemini-3.8-flash',
        'gpt-5.6-sol',
        switchId2,
      )
      assert.deepEqual(prepared2, {
        sourceModel: 'antigravity-gemini-3.8-flash',
        targetModel: 'gpt-5.6-sol',
      })
      assert.equal(source2._modelSwitchTransition?.summaryText, undefined)

      const target2 = await sm2.getOrCreate({
        sessionKey: key2,
        peerId: 'agy-prep-fallback',
        channel: 'webchat',
        agent,
        model: 'gpt-5.6-sol',
        modelSwitchId: switchId2,
        executionAuthority: {
          engine: 'codex',
          canonicalModel: 'gpt-5.6-sol',
          source: 'local_catalog',
        } as EngineAuthorityOverride,
      })
      const capturedInputs2: HistoricalTurnInput[] = []
      i2.runOneTurnWithRetry = async (_s, input) => {
        capturedInputs2.push(input)
      }
      await sm2.submit(
        target2,
        'continue after fallback',
        () => {},
        undefined,
        'gpt-5.6-sol',
        undefined,
        undefined,
        undefined,
        {
          modelSwitchId: switchId2,
          historicalMessages: [
            { role: 'assistant', id: 'srv-fallback-1', text: 'SYNTHETIC_FALLBACK_HISTORY_MARKER' },
          ],
        },
      )
      assert.equal(capturedInputs2.length, 1)
      assert.match(String(capturedInputs2[0]), /<openclaude_previous_context_json>/)
      assert.match(String(capturedInputs2[0]), /SYNTHETIC_FALLBACK_HISTORY_MARKER/)
      assert.match(String(capturedInputs2[0]), /continue after fallback/)
    } finally {
      if (savedHome === undefined) Reflect.deleteProperty(process.env, 'OPENCLAUDE_HOME')
      else process.env.OPENCLAUDE_HOME = savedHome
      if (savedBin === undefined) Reflect.deleteProperty(process.env, 'OC_ANTIGRAVITY_CLI_BIN')
      else process.env.OC_ANTIGRAVITY_CLI_BIN = savedBin
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('direct cross-engine switch from Antigravity uses step_type=23 <summary> when available and falls back when unavailable', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'oc-agy-switch-direct-'))
    const savedHome = process.env.OPENCLAUDE_HOME
    try {
      const openclaudeHome = path.join(dir, 'oc-home')
      process.env.OPENCLAUDE_HOME = openclaudeHome
      registerEngine('antigravity', (opts) => new AntigravityAdapter(opts))
      registerTargetMockCodex()

      const agent = { id: 'main', cwd: dir } as AgentDef
      const convDirect = '88888888-9999-4aaa-8bbb-cccccccccccc'
      await createSyntheticAntigravityDb(openclaudeHome, convDirect, [
        {
          idx: 310,
          stepType: 23,
          status: 3,
          payload: encodeSyntheticCheckpointStep({
            idx: 310,
            status: 3,
            sessionSummary:
              '<summary>\n1. Task Overview\nSYNTHETIC_DIRECT_SWITCH_CHECKPOINT\n</summary>',
          }),
        },
      ])

      const sm = new SessionManager(makeConfig())
      const internals = sm as unknown as SmInternals
      internals._saveResumeMap = () => {}
      const key = 'agent:main:webchat:dm:agy-direct-switch'
      internals._resumeMap.set(key, convDirect)
      internals._resumeMapProvider.set(key, 'antigravity')

      const source = await sm.getOrCreate({
        sessionKey: key,
        peerId: 'agy-direct-switch',
        channel: 'webchat',
        agent,
        model: 'antigravity-gemini-3.8-flash',
        executionAuthority: {
          engine: 'antigravity',
          canonicalModel: 'antigravity-gemini-3.8-flash',
          source: 'local_catalog',
        } as EngineAuthorityOverride,
      })
      source.turns = 2

      const target = await sm.getOrCreate({
        sessionKey: key,
        peerId: 'agy-direct-switch',
        channel: 'webchat',
        agent,
        model: 'gpt-5.6-sol',
        executionAuthority: {
          engine: 'codex',
          canonicalModel: 'gpt-5.6-sol',
          source: 'local_catalog',
        } as EngineAuthorityOverride,
      })
      internals._resumeMap.delete(key)
      internals._resumeMapProvider.delete(key)

      const inputs: HistoricalTurnInput[] = []
      internals.runOneTurnWithRetry = async (_s, input) => {
        inputs.push(input)
      }
      await sm.submit(target, 'first direct target turn', () => {}, undefined, undefined, undefined, undefined, undefined, {
        historicalMessages: [{ role: 'assistant', id: 'srv-d1', text: 'DIRECT_HISTORY_T1' }],
      })
      assert.equal(inputs.length, 1)
      assert.match(String(inputs[0]), /<openclaude_native_model_handoff>/)
      assert.match(String(inputs[0]), /SYNTHETIC_DIRECT_SWITCH_CHECKPOINT/)

      // Second turn does not re-inject the one-shot checkpoint summary.
      await sm.submit(target, 'second turn followup', () => {}, undefined, undefined, undefined, undefined, undefined, {
        historicalMessages: [{ role: 'assistant', id: 'srv-d2', text: 'DIRECT_HISTORY_T2' }],
      })
      assert.equal(inputs.length, 2)
      assert.doesNotMatch(String(inputs[1]), /SYNTHETIC_DIRECT_SWITCH_CHECKPOINT/)
    } finally {
      if (savedHome === undefined) Reflect.deleteProperty(process.env, 'OPENCLAUDE_HOME')
      else process.env.OPENCLAUDE_HOME = savedHome
      await rm(dir, { recursive: true, force: true })
    }
  })
})
