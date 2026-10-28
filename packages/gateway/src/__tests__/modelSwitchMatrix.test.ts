import assert from 'node:assert/strict'
import { after, describe, test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager, type AgentSession } from '../sessionManager.js'
import { CcbAdapter } from '../engine/ccbAdapter.js'
import { registerEngine, type EngineAuthorityOverride, type EngineCreateOpts } from '../engine/registry.js'
import type { SubprocessRunner } from '../subprocessRunner.js'
import type { AgentDef, OpenClaudeConfig } from '@openclaude/storage'
import { MinimalPrivacyRunner } from './fixtures/minimalPrivacyRunner.js'
import type { HistoricalTurnInput } from '../historicalContextPayload.js'

const engines = ['ccb', 'codex', 'grok', 'cursor', 'zcode', 'antigravity'] as const
const workspace = mkdtempSync(join(tmpdir(), 'rf-errors-matrix-'))
after(() => rmSync(workspace, { recursive: true, force: true }))

/** Only runner construction and submission are replaced. Real manager switch/history gates execute. */
class MatrixRunner extends MinimalPrivacyRunner {
  sessionId: string | null = null
  isRunning = false
  lastActivityAt = Date.now()
  shutdowns = 0
  model: string | undefined
  constructor(opts: EngineCreateOpts) { super(); this.model = opts.model }
  async start() { this.recordBuiltPromptPrivacy(); this.isRunning = true }
  async shutdown() { this.shutdowns++; this.isRunning = false }
  clearSessionId() { this.sessionId = null }
  setModel(model: string | undefined) { this.model = model }
  setResumeSessionId(id: string) { this.sessionId = id }
  async waitForOutputDrain() {}
  interrupt() { return false }
}
const runners = new WeakMap<object, MatrixRunner>()
for (const engine of engines) {
  registerEngine(engine, (opts) => {
    const runner = new MatrixRunner(opts)
    const adapter = new CcbAdapter(opts, runner as unknown as SubprocessRunner)
    Object.defineProperty(adapter, 'engineId', { value: engine })
    Object.assign(adapter.capabilities, {
      // All six production adapters currently advertise native-resume.
      historyMode: 'native-resume',
      maxPromptBytes: 96 * 1024,
    })
    runners.set(adapter, runner)
    return adapter
  })
}

interface Internals {
  _resumeMap: Map<string, string>
  _resumeMapProvider: Map<string, string>
  _resumeMapLastCost: Map<string, number>
  _saveResumeMap: () => void
  runOneTurnWithRetry: (session: AgentSession, input: HistoricalTurnInput) => Promise<void>
}
const config = { version: 1, gateway: { bind: '127.0.0.1', port: 0, accessToken: '' },
  auth: { mode: 'subscription', claudeCodePath: '' }, sessions: { dbPath: '' },
  defaults: { model: 'glm-5.2' },
} as unknown as OpenClaudeConfig

describe('model switch presentation contract', () => {
for (const from of engines) for (const to of engines) {
  test(`engine matrix ${from} -> ${to}: isolate state, retain text/image/tool history, no notice flood`, async () => {
    const sm = new SessionManager(config)
    const internals = sm as unknown as Internals
    internals._saveResumeMap = () => {}
    const peer = `matrix-${from}-${to}`
    const sessionKey = `agent:main:webchat:dm:${peer}`
    const agent = { id: 'main', cwd: workspace } as AgentDef
    const opts = (engine: typeof engines[number]) => ({
      sessionKey, peerId: peer, channel: 'webchat', agent,
      model: `matrix-${engine}`, executionAuthority: { engine, canonicalModel: `matrix-${engine}`,
        source: 'local_catalog' } as EngineAuthorityOverride,
    })
    const source = await sm.getOrCreate(opts(from))
    source.turns = 1
    source._platformGoal = { goalId: 'source-only' } as AgentSession['_platformGoal']
    source.toolUseIdToName.set('old-tool-call', 'Bash')
    internals._resumeMap.set(sessionKey, `${from}-native-id`)
    internals._resumeMapProvider.set(sessionKey, from)
    internals._resumeMapLastCost.set(sessionKey, 42)
    const target = await sm.getOrCreate(opts(to))
    assert.equal(target.providerTag, to)
    if (from === to) {
      assert.equal(target, source)
      assert.equal(runners.get(source.runner)!.shutdowns, 0)
    } else {
      assert.notEqual(target, source)
      assert.equal(runners.get(source.runner)!.shutdowns, 1)
      assert.equal(target.runner.nativeSessionId, null)
      assert.equal(target.totalCostUSD, 0)
      assert.equal(target._lastCcbCumulativeCost, 0)
      assert.equal(target._platformGoal, undefined)
      assert.equal(target.toolUseIdToName.size, 0)
    }
    // No paid call, no provider process, no native transcript probes on the submission path.
    internals._resumeMap.delete(sessionKey)
    internals._resumeMapProvider.delete(sessionKey)
    const inputs: HistoricalTurnInput[] = []
    internals.runOneTurnWithRetry = async (_session, input) => { inputs.push(input) }
    const notices: number[] = []
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } }
    const current = [{ type: 'text', text: 'interpret this image using the earlier answer' }, image]
    const history = [{ role: 'assistant', id: `srv-${peer}-main-t1`, text: 'HISTORY_MARKER' },
      { role: 'tool', toolName: 'Bash', inputJson: { command: 'pwd' }, output: 'TOOL_MARKER' }]
    for (let turn = 0; turn < 2; turn++) {
      // The changing history id used to produce another grey banner on every native fallback.
      history[0]!.id = `srv-${peer}-main-t${turn + 1}`
      await sm.submit(target, turn === 0 ? current : 'continue', () => {}, undefined, undefined,
        undefined, undefined, undefined, { historicalMessages: history,
          emitContextRebuilt: ({ messageCount }) => notices.push(messageCount) })
    }
    assert.ok(Array.isArray(inputs[0]))
    assert.deepEqual(inputs[0].slice(1), current)
    assert.match(String(inputs[0][0]?.text), /HISTORY_MARKER/)
    assert.match(String(inputs[0][0]?.text), /TOOL_MARKER/)
    assert.equal(inputs[0][2], image)
    assert.match(String(inputs[1]), /HISTORY_MARKER/)
    assert.equal(notices.length, 1)
    assert.equal(target.toolUseIdToName.size, 0)
  })
}

})
