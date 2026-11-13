/**
 * OCV5-746 段 3 端到端:真实 master relay + 两个真实节点子进程(fixtures/codexRemoteNode.mjs)
 * + 容器内真实 CCB 工具宿主。证明:
 *   1. 远端 codex turn 的工具真的在本容器执行(哨兵文件 + 宿主调用计数);
 *   2. 原生工具 / 未观测(伪造参数)调用零执行,两端 fail-closed;
 *   3. 计费收据段 2 口径的 receipt v3(baseline/total/nativeUsage/归一化 usage)金额精确;
 *   4. 取消与节点断线都不重放,同一签名 authority 二次准入被拒;
 *   5. 常驻 lane 的第二 turn 复用同一 app-server,不再重开线程/进程。
 *
 * Run: /opt/openclaude/node_modules/.bin/tsx --test packages/gateway/src/__tests__/codexRemoteAdapterE2E.test.ts
 */
import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  authoritySigningInput,
  encodeAuthorityEnvelope,
  encodeTurnLeaseEnvelope,
  turnLeaseSigningInput,
  type ModelAuthorityPayload,
  type TurnLease,
} from '@openclaude/protocol'
import { Cc5ToolHost } from '../cc5ToolHost.js'
import { cc5ToolInputSha256 } from '../cc5NativeTool.js'
import {
  codexBackend,
  zeroNativeTokens,
  type CodexNativeTerminalReceipt,
  type CodexNativeTokens,
  type CodexRemoteBinding,
} from '../codexRemoteContract.js'
import type { CodexLaneSpec } from '../codexRemoteHost.js'
import { commissioningLines } from '../codexCommissioningWire.js'
import { CodexRemoteRelay } from '../codexRemoteRelay.js'
import { CodexRemoteAdapter } from '../engine/codexAdapter.js'
import { restartRunnerForConfigChange } from '../runnerConfigRestart.js'
import type { TurnParams } from '../engine/engineAdapter.js'
import type { EngineCreateOpts } from '../engine/registry.js'
import type { CcbExecutionDescriptor } from '../subprocessSpawnConfig.js'

const NODE_FIXTURE = fileURLToPath(new URL('./fixtures/codexRemoteNode.mjs', import.meta.url))
/** The real tool host requires the native session id to be a UUID, as a real codex thread is. */
const THREAD = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
/** The fixture answers each turn/start with the next id: a resident app serves unique turns. */
const TURNS = ['turn-fixture', 'turn-two', 'turn-three']

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

interface Lane {
  root: string
  binding: CodexRemoteBinding
  sentinel: string
  turnKey: string
  adapter: CodexRemoteAdapter
  relay: CodexRemoteRelay
  receipts: CodexNativeTerminalReceipt[]
  executed: Array<{ name: string; args: unknown }>
  errors: Error[]
  /** Fixture keyring handed to the relay and forwarded to the worker as base64. */
  keys: Map<string, Uint8Array>
  launches: number
  call: (path: string, body?: Record<string, unknown>) => Promise<{ status: number } & Record<string, any>>
  received: (role: 'launch' | 'tool-socket') => any[]
  toolResponses: () => any[]
  child: (role: 'launch' | 'tool-socket') => ChildProcessWithoutNullStreams
  emit: (frame: unknown) => void
  sendTool: (request: unknown) => void
  nativeItem: (method: string, item: unknown, turnId?: string) => void
  tokenUsage: (turnId: string, cumulative: CodexNativeTokens, last: CodexNativeTokens) => Record<string, unknown>
  authority: (label: string, leaseTtlMs?: number) => { a: ModelAuthorityPayload; authority: string; lease: string }
  turnParams: (
    /** `a` is present for a fresh authority and absent when a replay probe reuses one half. */
    signed: { a?: ModelAuthorityPayload; authority: string; lease: string },
    turnKey: string,
    requestId: string,
  ) => TurnParams
  toolRequest: (callId: string, args: Record<string, unknown>, turnId?: string) => Record<string, unknown>
  /** The master's `/admit` parks while held: the kernel cannot reach `turn/start` before it lands. */
  holdAdmission: (hold: boolean) => void
  /** The master closes the admission, then the container's ACK is held: an interregnum window. */
  holdAbandon: (hold: boolean) => void
  abandonAcksHeld: () => boolean
  abandons: () => number
  abandonCauses: () => Array<{ failureCode: string; diagnostic: string } | null>
  /** The master applied `/renew`, then the container's ACK is held: a legal early delivery. */
  holdRenewAck: (hold: boolean) => void
  renewAcksHeld: () => boolean
  /** Rolling-lease renewals the master answered (the fixture's own `/renew` endpoint). */
  renewals: () => number
  /** `submitTurn` is exactly `lane.beginTurn(...)` + `kernel.submit(...)`: the lane-level halves are
   *  reachable so a test can submit a second turn without the adapter's single-turn parser routing. */
  remoteLane: {
    beginTurn: (params: TurnParams) => void
    kernel: {
      submit: (input: string, requestId?: string) => Promise<void>
      /** The kernel recycles its app-server when the provider route changes (launch-time argv). */
      setCodexRoute: (route: Record<string, unknown> | null) => void
    }
  }
  /** `attempts` is 20 ms each: the default is 12 s, a recycled generation may need a new tool host. */
  until: (predicate: () => boolean | Promise<boolean>, label: string, attempts?: number) => Promise<void>
}

async function lane(t: TestContext, options: {
  /** Fixtures only: shorten the 30-minute rolling window so a renewal is observable. */
  leaseRenewAfterMs?: number
  platformTools?: boolean
  closeFailure?: { active: boolean }
  /** The web chat's peer id; the prompt only projects a nickname consented for this session. */
  sessionId?: string
  /** The node refuses thread/unsubscribe, as an older controller does. */
  rejectUnsubscribe?: boolean
  /** The node's post-resume usage replay claims more tokens than were billed. */
  inflateUsageReplay?: boolean
} = {}): Promise<Lane> {
  const root = mkdtempSync(join(tmpdir(), 'codex-container-e2e-'))
  const cwd = join(root, 'cwd')
  const home = join(root, 'home')
  mkdirSync(cwd)
  mkdirSync(home)
  // The real host runs the real CLI: isolate it from this container's own config, as cc5ToolHost.test does.
  const previousPlatformHome = process.env.OPENCLAUDE_HOME
  process.env.OPENCLAUDE_HOME = home
  const agentId = options.platformTools ? 'coding-assistant' : 'main'
  if (options.platformTools) {
    for (const [agent, body] of [['coding-assistant','R1_AGENT_PRIVATE_SKILL_BODY'], ['main','WRONG_MAIN_BODY']]) {
      const dir = join(home, 'agents', agent!, 'skills', 'r1-private')
      mkdirSync(dir, {recursive:true})
      writeFileSync(join(dir, 'SKILL.md'), `---\nname: r1-private\ndescription: private R1 verification\n---\n${body}\n`)
    }
  }
  const previousHome = process.env.HOME
  const previousConfig = process.env.CLAUDE_CONFIG_DIR
  process.env.HOME = home
  process.env.CLAUDE_CONFIG_DIR = join(home, '.claude')
  const now = Date.now()
  const binding: CodexRemoteBinding = {
    version: 3, backendKind: 'codex-app-server-v1', uid: '3', containerDbId: '7', dockerId: 'a'.repeat(64),
    operationId: randomUUID(), runId: randomUUID(), sessionKey: `agent:${agentId}:webchat:dm:codex_container_e2e`,
    canonicalModel: 'gpt-6-luna-remote', generation: '1', profileId: 'default', authEpoch: 'epoch1',
    manifestSha256: 'a'.repeat(64), capability: 'b'.repeat(64), expiresAt: now + 600000,
  }
  const spec: CodexLaneSpec = {
    controllerPath: 'fixture',
    manifest: {
      version: 1, engine: 'codex', root: '/fixture', operationId: binding.operationId, runId: binding.runId,
      generation: binding.generation, profileId: binding.profileId, authEpoch: binding.authEpoch,
      model: 'gpt-6-luna', nativeThreadId: null, codexHome: '/fixture',
      controllerSha256: 'a'.repeat(64), cliSha256: 'a'.repeat(64), nativeSha256: 'a'.repeat(64),
    },
    modelList: [], modelCatalog: { models: [] },
  }
  const key = generateKeyPairSync('ed25519')
  const keyId = 'e2e-key'
  const keys = new Map([[keyId, new Uint8Array(Buffer.from(key.publicKey.export({ format: 'jwk' }).x!, 'base64url'))]])

  const authority = (label: string, leaseTtlMs = 600000) => {
    const issuedAt = Date.now()
    const a: ModelAuthorityPayload = {
      v: 1, keyId, uid: 3, containerId: 7, authorityTurnId: randomUUID().replaceAll('-', ''),
      billingRequestId: label, connectionChallenge: 'fixture', canonicalModel: binding.canonicalModel,
      engine: 'codex', executionBackend: codexBackend(binding), securityEpoch: 1,
      executionRevision: 'e2e-r1', issuedAt, expiresAt: issuedAt + 120000,
      executionDescriptor: {
        capabilityProfile: {}, capabilitySchemaVersion: 1, contextWindow: 1000,
        supportsVision: false, supportedEfforts: ['low', 'high'],
      },
    }
    const leaseFor = (expiresAt: number): string => {
      const l: TurnLease = {
        v: 1, keyId, uid: 3, containerId: 7, authorityTurnId: a.authorityTurnId, connectionChallenge: 'fixture',
        canonicalModel: binding.canonicalModel, securityEpoch: 1, issuedAt, expiresAt,
      }
      return encodeTurnLeaseEnvelope(l, sign(null, turnLeaseSigningInput(l), key.privateKey))
    }
    signedPayload = a
    return {
      a,
      authority: encodeAuthorityEnvelope(a, sign(null, authoritySigningInput(a), key.privateKey)),
      lease: leaseFor(issuedAt + leaseTtlMs),
    }
  }
  // The master's rolling lease endpoint, played by the test: it re-signs the same authority's lease
  // with a fresh window, exactly the capability the container has to keep using.
  let signedPayload: ModelAuthorityPayload | undefined
  let renewals = 0
  const renewLease = async (): Promise<{ lease: string; expiresAt: number }> => {
    assert.ok(signedPayload, 'a lease can only be renewed for a signed authority')
    const issuedAt = signedPayload.issuedAt
    const expiresAt = Date.now() + 600000
    const l: TurnLease = {
      v: 1, keyId, uid: 3, containerId: 7, authorityTurnId: signedPayload.authorityTurnId,
      connectionChallenge: 'fixture', canonicalModel: binding.canonicalModel, securityEpoch: 1, issuedAt, expiresAt,
    }
    renewals++
    return {
      lease: encodeTurnLeaseEnvelope(l, sign(null, turnLeaseSigningInput(l), key.privateKey)),
      expiresAt,
    }
  }

  const children = new Map<string, ChildProcessWithoutNullStreams>()
  const receivedByRole = new Map<string, any[]>()
  const receipts: CodexNativeTerminalReceipt[] = []
  let launches = 0
  let billing = ''
  const hostPort = {
    preflight: async () => ({ memoryOk: true, activeSessions: 0 }),
    provision: async () => {},
    open: (role: 'launch' | 'tool-socket') => {
      if (role === 'launch') launches++
      const child = spawn(process.execPath, [NODE_FIXTURE], {
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        env: { ...process.env, OC_TEST_NODE: JSON.stringify({ role, manifest: spec.manifest, turns: TURNS, thread: THREAD,
          rejectUnsubscribe: options.rejectUnsubscribe === true, inflateUsageReplay: options.inflateUsageReplay === true }) },
      }) as ChildProcessWithoutNullStreams
      const rows = receivedByRole.get(role) ?? []
      receivedByRole.set(role, rows)
      child.on('message', (message) => rows.push(message))
      children.set(role, child)
      return child
    },
    stop: async () => {
      for (const child of children.values()) child.kill()
      return { remoteStopped: true as const }
    },
  }
  // The finance port's thread baseline: what this thread has already been billed, so the next
  // receipt bills only the delta of the turn being settled.
  let threadTotal: CodexNativeTokens = zeroNativeTokens()
  // One lane can settle several turns: the billed request id is per authority, never the last one.
  const requestIdByAuthority = new Map<string, string>()
  // A test can park the master's admission: the kernel then cannot reach turn/start before the
  // user's stop, which is exactly the cancel-before-dispatch branch.
  let admissionHold: Promise<void> | undefined
  let releaseAdmissionHook: (() => void) | undefined
  // A test can hold the master's abandon closure after the admission is already closed: the master
  // is done, the container is still waiting for the ACK, and that is the interregnum race.
  let abandonHold: Promise<void> | undefined
  let releaseAbandonHook: (() => void) | undefined
  let abandons = 0
  let abandonsHeld = false
  const abandonCauses: Array<{ failureCode: string; diagnostic: string } | null> = []
  const relay = new CodexRemoteRelay(binding, keys, hostPort, spec, join(root, 'journal'), {
    admit: async () => {
      const held = admissionHold
      if (held) await held
      // The real port claims a thread boundary once per finance turn and rejects a second claim,
      // so the double enforces the same contract instead of hiding a rebind behind a friendly port.
      let bound = false
      return {
        beforeHostStart: async () => {},
        beforeDispatch: async () => {},
        bindNativeThread: async () => {
          if (bound) throw new Error('REMOTE_NATIVE_BILLING_REJECTED')
          bound = true
          return threadTotal
        },
        // The real port closes the journal row and the thread claim by identity; the double only
        // has to answer with proof, and can be parked to model a late ACK.
        abandonUndispatched: async (cause?: { failureCode: 'INTERNAL_ERROR'; diagnostic: string }) => {
          abandonCauses.push(cause ?? null)
          const held = abandonHold
          if (held) {
            abandonsHeld = true
            try { await held } finally { abandonsHeld = false }
          }
          abandons++
          return { state: 'proven' as const, requestId: billing }
        },
        terminal: async (receipt) => {
          const terminal = receipt as CodexNativeTerminalReceipt
          receipts.push(terminal)
          threadTotal = terminal.total
          return { state: 'proven' as const, requestId: requestIdByAuthority.get(terminal.authorityTurnId) ?? billing }
        },
        stop: async () => {},
      }
    },
  }, async () => {})
  const sock = join(root, 'relay.sock')
  relay.controlServer.listen(sock)
  await once(relay.controlServer, 'listening')
  const call = (path: string, body: Record<string, unknown> = {}) => new Promise<any>((resolve, reject) => {
    const bytes = JSON.stringify({ ...binding, ...body })
    const req = request(
      { socketPath: sock, path, method: 'POST', headers: { 'content-length': Buffer.byteLength(bytes) } },
      (res) => {
        let text = ''
        res.on('data', (chunk) => { text += chunk })
        res.on('end', () => resolve({ status: res.statusCode!, ...(text ? JSON.parse(text) : {}) }))
      },
    )
    req.on('error', reject)
    req.end(bytes)
  })

  const executed: Array<{ name: string; args: unknown }> = []
  const errors: Error[] = []
  const executionRoot = join(root, 'tools')
  const adapter = new CodexRemoteAdapter({
    sessionKey: binding.sessionKey,
    agentId,
    config: { version: 1, gateway: { bind: '127.0.0.1', port: 9, accessToken: 'fixture-token' },
      auth: {mode:'subscription',claudeCodePath:''}, channels:{webchat:{enabled:false}}, sessions:{dbPath:''}, defaults:{model:binding.canonicalModel,permissionMode:'bypassPermissions'} },
    agentBaseDir: cwd,
    model: binding.canonicalModel,
    effortLevel: 'low',
    executionBackend: codexBackend(binding),
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
  } as EngineCreateOpts, {
    binding, socketPath: sock, keyring: keys, executionRoot, renewLease,
    ...(options.leaseRenewAfterMs === undefined ? {} : { leaseRenewAfterMs: options.leaseRenewAfterMs }),
    // The real host, with a wrapper that counts effects the container actually performed.
    hostFactory: (toolRoot, lifecycleId, profile, env) => {
      const inner = new Cc5ToolHost(toolRoot, lifecycleId, profile, async () => {
        throw new Error('CODEX_REMOTE_PERMISSION_UNSUPPORTED')
      }, env)
      return {
        tools: () => inner.tools(),
        close: async () => {
          await inner.close()
          if (options.closeFailure?.active) throw new Error('FIXTURE_STOP_PROOF_LOST')
        },
        execute: (name, args, identity) => {
          executed.push({ name, args })
          return inner.execute(name, args, identity)
        },
      }
    },
  })
  adapter.on('error', (error: Error) => errors.push(error))

  const sentinel = join(cwd, 'remote-sentinel.txt')
  const descriptor: CcbExecutionDescriptor = {
    executionBackend: codexBackend(binding), canonicalModel: binding.canonicalModel, contextWindow: 1000,
    capabilityZero: false, supportsThinking: true, supportsVision: false, supportedEfforts: ['low', 'high'],
  }
  const turnKey = 'c'.repeat(64)

  const received = (role: 'launch' | 'tool-socket') => receivedByRole.get(role) ?? []
  const responses = () => received('tool-socket')
    .filter((row) => row?.received?.kind === 'tool-response')
    .map((row) => JSON.parse(Buffer.from(row.received.body, 'base64').toString('utf8')))
  const child = (role: 'launch' | 'tool-socket') => {
    const value = children.get(role)
    assert.ok(value, `${role} child not opened`)
    return value!
  }
  const emit = (frame: unknown) => { child('launch').send!(frame as any) }
  let toolSeq = 0
  const sendTool = (payload: unknown) => {
    child('tool-socket').send!({
      version: 3, engine: 'codex', kind: 'tool-request', seq: ++toolSeq,
      body: Buffer.from(JSON.stringify(payload)).toString('base64'),
    })
  }
  const nativeItem = (method: string, item: unknown, turnId: string = TURNS[0]!) => {
    emit({ method, params: { threadId: THREAD, turnId, item } })
  }
  const toolRequest = (callId: string, args: Record<string, unknown>, turnId: string = TURNS[0]!) => ({
    version: 3, engine: 'codex', operationId: binding.operationId, runId: binding.runId,
    generation: binding.generation, callId, nativeThreadId: THREAD, nativeTurnId: turnId,
    server: 'ocbridge', name: 'Write', arguments: args, inputSha256: cc5ToolInputSha256(args),
  })
  const until = async (predicate: () => boolean | Promise<boolean>, label: string, attempts = 2000) => {
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (await predicate()) return
      await pause(20)
    }
    assert.fail(`timed out waiting for ${label}`)
  }
  t.after(async () => {
    if (previousPlatformHome === undefined) delete process.env.OPENCLAUDE_HOME
    else process.env.OPENCLAUDE_HOME = previousPlatformHome
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previousConfig
    await adapter.shutdown().catch(() => {})
    await relay.stop().catch(() => {})
    for (const value of children.values()) value.kill()
    relay.controlServer.closeAllConnections()
    await new Promise<void>((resolve) => relay.controlServer.close(() => resolve()))
    rmSync(root, { recursive: true, force: true })
  })

  // Fixtures only: the master has already applied a renewal, but the container's ACK is parked, so
  // the next tool delivery legitimately carries a lease the local publish never saw.
  let renewAckHold: Promise<void> | undefined
  let releaseRenewAckHook: (() => void) | undefined
  let renewAcksHeld = false
  let renewAckPatched: { renew: (lease: string) => Promise<void> } | undefined

  return {
    root, binding, sentinel, turnKey, adapter, relay, receipts, executed, errors, keys,
    get launches() { return launches },
    call, received,
    toolResponses: responses,
    child, emit, sendTool, nativeItem, toolRequest, until,
    renewals: () => renewals,
    abandons: () => abandons,
    abandonCauses: () => abandonCauses,
    abandonAcksHeld: () => abandonsHeld,
    holdAbandon: (hold: boolean) => {
      if (!hold) { releaseAbandonHook?.(); releaseAbandonHook = undefined; abandonHold = undefined; return }
      abandonHold = new Promise<void>((resolve) => { releaseAbandonHook = resolve })
    },
    renewAcksHeld: () => renewAcksHeld,
    holdRenewAck: (hold: boolean) => {
      const generation = (adapter as unknown as {
        lane?: { generation?: { client: { renew: (lease: string) => Promise<void> } } }
      }).lane?.generation
      assert.ok(generation, 'a live kernel generation is required to hold a renewal ACK')
      const client = generation!.client
      if (!hold) {
        if (renewAckPatched) client.renew = renewAckPatched.renew
        releaseRenewAckHook?.()
        releaseRenewAckHook = undefined
        renewAckHold = undefined
        return
      }
      renewAckHold = new Promise<void>((resolve) => { releaseRenewAckHook = resolve })
      const real = client.renew.bind(client)
      renewAckPatched = { renew: real }
      client.renew = async (lease: string) => {
        await real(lease)
        renewAcksHeld = true
        try { await renewAckHold } finally { renewAcksHeld = false }
      }
    },
    holdAdmission: (hold: boolean) => {
      if (!hold) { releaseAdmissionHook?.(); releaseAdmissionHook = undefined; admissionHold = undefined; return }
      admissionHold = new Promise<void>((resolve) => { releaseAdmissionHook = resolve })
    },
    remoteLane: (adapter as unknown as { lane: Lane['remoteLane'] }).lane,
    // Codex reports a cumulative thread snapshot plus the most recent call: `total − last` is the
    // baseline a freshly attached runner bootstraps from, so both halves must be real.
    tokenUsage: (turnId: string, cumulative: CodexNativeTokens, last: CodexNativeTokens) => ({
      threadId: THREAD, turnId,
      tokenUsage: {
        total: { ...cumulative, totalTokens: cumulative.inputTokens + cumulative.outputTokens },
        last: { ...last, totalTokens: last.inputTokens + last.outputTokens },
      },
    }),
    authority,
    turnParams: (signed, turnKeyValue, requestId) => {
      billing = requestId
      // A replay probe reuses one half's envelopes only, so it has no payload to key on.
      if (signed.a) requestIdByAuthority.set(signed.a.authorityTurnId, requestId)
      return {
        input: 'run the fixture turn',
        requestId,
        turnKey: turnKeyValue,
        onEvent: () => {},
        sessionTotals: { totalCostUSD: 0, turns: 0 },
        toolUseIdToName: new Map(),
        modelAuthority: { authorityEnvelope: signed.authority, leaseEnvelope: signed.lease, executionDescriptor: descriptor },
      }
    },
  }
}

// The finance port here is a test double: this proves the receipt v3 usage the port is asked to
// settle, not a real price snapshot or wallet debit (that evidence lives in segment 2).
test('a remote codex turn executes a real tool here and reports the receipt v3 usage to the finance port',
  { timeout: 180000 }, async (t) => {
  const h = await lane(t)
  const first = h.authority('req-first')
  const run = h.adapter.submitTurn(h.turnParams(first, h.turnKey, 'req-first'))
  await h.until(() => h.received('launch').some((row) => row?.received?.method === 'turn/start'), 'turn/start')
  assert.equal(h.launches, 1)

  const args = { file_path: h.sentinel, content: 'remote-sentinel\n' }
  h.nativeItem('item/started', { type: 'mcpToolCall', id: 'call-1', server: 'ocbridge', tool: 'Write', arguments: args })
  h.sendTool(h.toolRequest('call-1', args))

  // The effect is real and container-local: the file exists before any node-side "result".
  await h.until(() => existsSync(h.sentinel), 'container sentinel file')
  assert.equal(readFileSync(h.sentinel, 'utf8'), 'remote-sentinel\n')
  assert.deepEqual(h.executed, [{ name: 'Write', args }])
  await h.until(() => h.toolResponses().length === 1, 'tool response back on the node channel')
  const response = h.toolResponses()[0]
  assert.equal(response.callId, 'call-1')
  assert.equal(response.ok, true)
  assert.equal(response.result.isError, false)

  h.nativeItem('item/completed', { type: 'mcpToolCall', id: 'call-1', server: 'ocbridge', tool: 'Write', arguments: args })
  const total: CodexNativeTokens = {
    ...zeroNativeTokens(), inputTokens: 1000, cachedInputTokens: 400, outputTokens: 60, reasoningOutputTokens: 10,
  }
  h.emit({ method: 'thread/tokenUsage/updated', params: h.tokenUsage(TURNS[0]!, total, total) })
  h.emit({ method: 'turn/completed', params: { threadId: THREAD, turn: { id: TURNS[0], status: 'completed' } } })

  const summary = await run.summary
  assert.ok(summary)
  assert.equal(summary.isError, false)
  assert.equal(summary.usage.inputTokens, 600)
  assert.equal(summary.usage.cacheReadTokens, 400)
  assert.equal(h.receipts.length, 1)
  const receipt = h.receipts[0]!
  assert.equal(receipt.usageSemantics, 'codex-0.167-total-v1')
  assert.deepEqual(receipt.baseline, zeroNativeTokens())
  assert.deepEqual(receipt.total, total)
  assert.deepEqual(receipt.nativeUsage, total)
  assert.deepEqual(receipt.usage, { inputTokens: 600, outputTokens: 60, cacheReadTokens: 400, cacheWriteTokens: 0 })
  assert.equal(receipt.status, 'success')
  assert.equal(receipt.nativeStatus, 'completed')
  assert.equal(receipt.authorityTurnId, first.a.authorityTurnId)
  assert.equal(receipt.turnKey, h.turnKey)
  assert.equal(receipt.nativeThreadId, THREAD)
  assert.equal(receipt.nativeTurnId, TURNS[0])
  assert.equal(receipt.canonicalModel, h.binding.canonicalModel)
  assert.equal(receipt.upstreamModel, 'gpt-6-luna')
  assert.match(receipt.resultSha256, /^[a-f0-9]{64}$/)

  // Resident lane: the second turn reuses the same app-server and native thread.
  const second = h.authority('req-second')
  const run2 = h.adapter.submitTurn(h.turnParams(second, 'd'.repeat(64), 'req-second'))
  await h.until(
    () => h.received('launch').filter((row) => row?.received?.method === 'turn/start').length === 2,
    'second turn/start',
  )
  assert.equal(h.received('launch').filter((row) => row?.received?.method === 'thread/start').length, 1)
  assert.equal(h.received('launch').filter((row) => row?.received?.method === 'initialize').length, 1)
  const secondTotal: CodexNativeTokens = {
    ...zeroNativeTokens(), inputTokens: 500, cachedInputTokens: 100, outputTokens: 40,
  }
  const cumulative: CodexNativeTokens = {
    ...zeroNativeTokens(),
    inputTokens: total.inputTokens + secondTotal.inputTokens,
    cachedInputTokens: total.cachedInputTokens + secondTotal.cachedInputTokens,
    outputTokens: total.outputTokens + secondTotal.outputTokens,
    reasoningOutputTokens: total.reasoningOutputTokens + secondTotal.reasoningOutputTokens,
  }
  h.emit({ method: 'thread/tokenUsage/updated', params: h.tokenUsage(TURNS[1]!, cumulative, secondTotal) })
  h.emit({ method: 'turn/completed', params: { threadId: THREAD, turn: { id: TURNS[1], status: 'completed' } } })
  const summary2 = await run2.summary
  assert.ok(summary2)
  assert.equal(summary2.isError, false)
  // The thread snapshot is cumulative; both the kernel and the receipt bill only this turn's delta.
  assert.equal(summary2.usage.inputTokens, 400)
  assert.equal(summary2.usage.cacheReadTokens, 100)
  assert.equal(h.receipts.length, 2)
  assert.equal(h.receipts[1]!.nativeTurnId, TURNS[1])
  assert.deepEqual(h.receipts[1]!.total, cumulative)
  assert.deepEqual(h.receipts[1]!.nativeUsage, secondTotal)
  assert.equal(h.executed.length, 1, 'the second turn ran no extra tool')
  assert.equal(h.launches, 1, 'the lane launched exactly one resident node app')
})

test('a native tool item never reaches the container tool host', { timeout: 120000 }, async (t) => {
  const h = await lane(t)
  const signed = h.authority('req-native')
  const run = h.adapter.submitTurn(h.turnParams(signed, h.turnKey, 'req-native'))
  await h.until(() => h.received('launch').some((row) => row?.received?.method === 'turn/start'), 'turn/start')
  h.emit({
    method: 'item/started',
    params: { threadId: THREAD, turnId: TURNS[0], item: { id: 'exec-1', type: 'commandExecution', command: 'touch sentinel' } },
  })
  await h.until(() => h.relay.stopped, 'relay fence')
  const summary = await run.summary
  assert.ok(summary)
  assert.equal(summary.isError, true)
  assert.deepEqual(h.executed, [])
  assert.equal(existsSync(h.sentinel), false)
  assert.equal(h.receipts.length, 0)
  assert.equal((await h.call('/tool/next')).status, 403)
})

test('a tool request whose arguments were never observed executes nothing', { timeout: 120000 }, async (t) => {
  const h = await lane(t)
  const signed = h.authority('req-forged')
  const run = h.adapter.submitTurn(h.turnParams(signed, h.turnKey, 'req-forged'))
  await h.until(() => h.received('launch').some((row) => row?.received?.method === 'turn/start'), 'turn/start')
  const args = { file_path: h.sentinel, content: 'genuine\n' }
  h.nativeItem('item/started', { type: 'mcpToolCall', id: 'call-1', server: 'ocbridge', tool: 'Write', arguments: args })
  const forged = { file_path: h.sentinel, content: 'forged\n' }
  h.sendTool(h.toolRequest('call-1', forged))
  await h.until(() => h.relay.stopped, 'relay fence')
  const summary = await run.summary
  assert.ok(summary)
  assert.equal(summary.isError, true)
  assert.deepEqual(h.executed, [])
  assert.equal(existsSync(h.sentinel), false)
  assert.equal(h.receipts.length, 0)
})

test('a cancelled turn is billed as interrupted and its authority can never be replayed', { timeout: 120000 }, async (t) => {
  const h = await lane(t)
  const signed = h.authority('req-cancel')
  const params = h.turnParams(signed, h.turnKey, 'req-cancel')
  const run = h.adapter.submitTurn(params)
  await h.until(() => h.received('launch').some((row) => row?.received?.method === 'turn/start'), 'turn/start')
  assert.equal(h.adapter.interrupt(), true)
  await h.until(() => h.received('launch').some((row) => row?.received?.method === 'turn/interrupt'), 'turn/interrupt')
  const partial: CodexNativeTokens = { ...zeroNativeTokens(), inputTokens: 200, outputTokens: 20 }
  h.emit({ method: 'thread/tokenUsage/updated', params: h.tokenUsage(TURNS[0]!, partial, partial) })
  h.emit({ method: 'turn/completed', params: { threadId: THREAD, turn: { id: TURNS[0], status: 'interrupted' } } })
  const summary = await run.summary
  assert.ok(summary)
  assert.equal(summary.isError, true)
  assert.equal(h.receipts.length, 1)
  assert.equal(h.receipts[0]!.nativeStatus, 'interrupted')
  assert.equal(h.receipts[0]!.status, 'error')
  assert.deepEqual(h.receipts[0]!.nativeUsage, partial)
  assert.deepEqual(h.executed, [])

  // The same signed authority is consumed: neither half may admit it again.
  assert.throws(() => h.adapter.submitTurn(params), /CODEX_TURN_REPLAYED/)
  assert.throws(
    () => h.adapter.submitTurn(h.turnParams({ authority: signed.authority, lease: signed.lease }, h.turnKey, 'req-cancel')),
    /CODEX_TURN_REPLAYED/,
  )
  const replay = await h.call('/admit', {
    authority: signed.authority, lease: signed.lease, turnKey: h.turnKey,
    catalog: { tools: [{ name: 'Write', inputSchema: { type: 'object' } }] },
  })
  assert.equal(replay.status, 403)
  assert.equal(h.receipts.length, 1)
})

test('a cancelled turn leaves the lane usable: the next turn runs on the same resident node', { timeout: 180000 }, async (t) => {
  const h = await lane(t)
  const first = h.authority('req-stop-1')
  const run = h.adapter.submitTurn(h.turnParams(first, h.turnKey, 'req-stop-1'))
  await h.until(() => h.received('launch').some((row) => row?.received?.method === 'turn/start'), 'first turn/start')
  assert.equal(h.adapter.interrupt(), true)
  await h.until(() => h.received('launch').some((row) => row?.received?.method === 'turn/interrupt'), 'turn/interrupt')
  const partial: CodexNativeTokens = { ...zeroNativeTokens(), inputTokens: 300, outputTokens: 30 }
  h.emit({ method: 'thread/tokenUsage/updated', params: h.tokenUsage(TURNS[0]!, partial, partial) })
  h.emit({ method: 'turn/completed', params: { threadId: THREAD, turn: { id: TURNS[0], status: 'interrupted' } } })
  const stopped = await run.summary
  assert.ok(stopped)
  assert.equal(stopped.isError, true)
  assert.equal(h.receipts.length, 1)

  // The container's kernel generation ended with the cancel; the lane and the node did not.
  const second = h.authority('req-after-stop')
  const run2 = h.adapter.submitTurn(h.turnParams(second, 'e'.repeat(64), 'req-after-stop'))
  await h.until(
    () => h.received('launch').filter((row) => row?.received?.method === 'turn/start').length === 2,
    'second turn/start after the cancel',
  )
  assert.equal(h.launches, 1, 'the cancel must not relaunch the node app')

  const args = { file_path: h.sentinel, content: 'after-cancel\n' }
  h.nativeItem('item/started',
    { type: 'mcpToolCall', id: 'call-2', server: 'ocbridge', tool: 'Write', arguments: args }, TURNS[1])
  h.sendTool(h.toolRequest('call-2', args, TURNS[1]))
  await h.until(() => existsSync(h.sentinel), 'container sentinel after the cancel')
  assert.equal(readFileSync(h.sentinel, 'utf8'), 'after-cancel\n')
  assert.equal(h.executed.length, 1)
  // The app only reports the item complete after the relay answered its tool call.
  await h.until(() => h.toolResponses().length === 1, 'tool response back on the node channel')

  h.nativeItem('item/completed',
    { type: 'mcpToolCall', id: 'call-2', server: 'ocbridge', tool: 'Write', arguments: args }, TURNS[1])
  const secondTotal: CodexNativeTokens = { ...zeroNativeTokens(), inputTokens: 400, outputTokens: 50 }
  const cumulative: CodexNativeTokens = {
    ...zeroNativeTokens(),
    inputTokens: partial.inputTokens + secondTotal.inputTokens,
    outputTokens: partial.outputTokens + secondTotal.outputTokens,
  }
  h.emit({ method: 'thread/tokenUsage/updated', params: h.tokenUsage(TURNS[1]!, cumulative, secondTotal) })
  h.emit({ method: 'turn/completed', params: { threadId: THREAD, turn: { id: TURNS[1], status: 'completed' } } })
  const summary2 = await run2.summary
  assert.ok(summary2)
  assert.equal(summary2.isError, false)
  assert.equal(h.receipts.length, 2)
  // The receipt after the cancel bills only this turn; the abandoned turn is not replayed into it.
  assert.deepEqual(h.receipts[1]!.nativeUsage, secondTotal)
  assert.deepEqual(h.receipts[1]!.total, cumulative)
  assert.equal(h.receipts[1]!.nativeTurnId, TURNS[1])
})

test('an effort change restarts only the kernel: first and later turns still run on the same lane',
  { timeout: 180000 }, async (t) => {
  // OCV5-746: a web chat that picks a reasoning effort makes sessionSubmit restart the runner
  // before the first turn. That restart must not revoke the lane (it used to: CODEX_LANE_CLOSED).
  // The chat opens at the fixture's `low` and the user picks `high` before the first message.
  const h = await lane(t)
  const turnStarts = () => h.received('launch')
    .map((row) => row?.received).filter((frame) => frame?.method === 'turn/start')
  h.adapter.setEffortLevel('high')
  await restartRunnerForConfigChange(h.adapter)
  const first = h.authority('req-effort-1')
  const run = h.adapter.submitTurn(h.turnParams(first, h.turnKey, 'req-effort-1'))
  await h.until(() => turnStarts().length === 1, 'turn/start after the effort change')
  assert.equal(turnStarts()[0].params?.effort, 'high', 'the node runs the first turn at the chosen effort')
  const firstTotal: CodexNativeTokens = { ...zeroNativeTokens(), inputTokens: 200, outputTokens: 20 }
  h.emit({ method: 'thread/tokenUsage/updated', params: h.tokenUsage(TURNS[0]!, firstTotal, firstTotal) })
  h.emit({ method: 'turn/completed', params: { threadId: THREAD, turn: { id: TURNS[0], status: 'completed' } } })
  const summary = await run.summary
  assert.ok(summary)
  assert.equal(summary.isError, false)
  assert.equal(h.receipts.length, 1)

  // A warm lane switching effort again between turns keeps the same resident node app.
  h.adapter.setEffortLevel('low')
  await restartRunnerForConfigChange(h.adapter)
  const second = h.authority('req-effort-2')
  const run2 = h.adapter.submitTurn(h.turnParams(second, 'f'.repeat(64), 'req-effort-2'))
  await h.until(() => turnStarts().length === 2, 'second turn/start after the second effort change')
  assert.equal(turnStarts()[1].params?.effort, 'low', 'the switch back is honoured on the same lane')
  const secondTotal: CodexNativeTokens = { ...zeroNativeTokens(), inputTokens: 500, outputTokens: 60 }
  h.emit({ method: 'thread/tokenUsage/updated', params: h.tokenUsage(TURNS[1]!, secondTotal, {
    ...zeroNativeTokens(), inputTokens: 300, outputTokens: 40,
  }) })
  h.emit({ method: 'turn/completed', params: { threadId: THREAD, turn: { id: TURNS[1], status: 'completed' } } })
  const summary2 = await run2.summary
  assert.ok(summary2)
  assert.equal(summary2.isError, false)
  assert.equal(h.receipts.length, 2)
  assert.equal(h.launches, 1, 'an effort change must not relaunch the node app')
  assert.equal(h.received('launch').filter((row) => row?.received?.method === 'thread/unsubscribe').length, 0,
    'unchanged instructions keep the thread loaded')
})

test('a withdrawn nickname is gone from the instructions the node resumes the warm thread with',
  { timeout: 180000 }, async (t) => {
  // OCV5-746 audit B1: a privacy refresh on a warm remote chat recycles only the kernel and keeps
  // the native thread, so the rebuilt instructions must reach the node on thread/resume.
  const nickname = 'Zq746Nick'
  const sessionId = 'codex_container_e2e'
  const h = await lane(t, { sessionId })
  const nodeFrames = (method: string) => h.received('launch')
    .map((row) => row?.received).filter((frame) => frame?.method === method)
  h.adapter.setPromptPrivacy({ schemaVersion: 1, profile: { nickname, sessionId } })
  const first = h.authority('req-privacy-1')
  const run = h.adapter.submitTurn(h.turnParams(first, h.turnKey, 'req-privacy-1'))
  await h.until(() => nodeFrames('turn/start').length === 1, 'first turn/start')
  const started = nodeFrames('thread/start')
  assert.equal(started.length, 1)
  assert.ok(String(started[0].params?.baseInstructions).includes(nickname), 'the authorized nickname is in the first instructions')
  // Codex injects <environment_context> for the node (its cwd, UTC, a read-only sandbox); the model
  // must be told to disregard it rather than narrate it to the user as its own limits.
  const firstInstructions = String(started[0].params?.baseInstructions)
  assert.ok(firstInstructions.includes('<environment_context>') && firstInstructions.includes('ignore them'),
    'the node is told to ignore its own injected environment block')
  assert.ok(firstInstructions.includes("the user's normal read/write"), 'tools are described with their real access')
  assert.ok(!firstInstructions.includes('model host'), 'no host/container split for the model to repeat')
  const firstTotal: CodexNativeTokens = { ...zeroNativeTokens(), inputTokens: 200, outputTokens: 20 }
  h.emit({ method: 'thread/tokenUsage/updated', params: h.tokenUsage(TURNS[0]!, firstTotal, firstTotal) })
  h.emit({ method: 'turn/completed', params: { threadId: THREAD, turn: { id: TURNS[0], status: 'completed' } } })
  assert.equal((await run.summary)?.isError, false)

  h.adapter.setPromptPrivacy({ schemaVersion: 1, profile: null })
  await restartRunnerForConfigChange(h.adapter)
  const second = h.authority('req-privacy-2')
  const run2 = h.adapter.submitTurn(h.turnParams(second, 'f'.repeat(64), 'req-privacy-2'))
  await h.until(() => nodeFrames('turn/start').length === 2, 'second turn/start after the privacy refresh')
  const resumed = nodeFrames('thread/resume')
  assert.equal(resumed.length, 1, 'the warm thread is resumed, not restarted')
  assert.equal(resumed[0].params?.threadId, THREAD)
  const delivered = resumed[0].params?.baseInstructions
  assert.equal(typeof delivered, 'string', 'the resume carries the rebuilt instructions')
  assert.ok(delivered.length > 0)
  assert.ok(!delivered.includes(nickname), 'the withdrawn nickname must not reach the node again')
  // Delivery is not enough: a loaded native thread ignores resume instructions. The node must have
  // been made to unload it first, so the second turn actually runs on the rebuilt instructions.
  assert.equal(nodeFrames('thread/unsubscribe').length, 1, 'the master unloads the warm thread before the resume')
  const effective = h.received('launch').filter((row) => row && 'effectiveInstructions' in row)
    .map((row) => row.effectiveInstructions)
  assert.equal(effective.length, 2)
  assert.ok(String(effective[0]).includes(nickname))
  assert.equal(effective[1], delivered, 'the second turn runs on the rebuilt instructions')
  const secondTotal: CodexNativeTokens = { ...zeroNativeTokens(), inputTokens: 500, outputTokens: 60 }
  h.emit({ method: 'thread/tokenUsage/updated', params: h.tokenUsage(TURNS[1]!, secondTotal, {
    ...zeroNativeTokens(), inputTokens: 300, outputTokens: 40,
  }) })
  h.emit({ method: 'turn/completed', params: { threadId: THREAD, turn: { id: TURNS[1], status: 'completed' } } })
  assert.equal((await run2.summary)?.isError, false)
  assert.equal(h.receipts.length, 2)
  assert.equal(h.launches, 1)
})

test('a node that refuses the thread unload fences the lane and closes the undispatched admission',
  { timeout: 180000 }, async (t) => {
  // OCV5-746 audit R3 B2: the admission already claimed the bound thread but never wrote turn/start;
  // the plain stop leaves that inflight, so the fence must close it by identity, with its cause.
  const nickname = 'Zq746Nick'
  const sessionId = 'codex_container_e2e'
  const h = await lane(t, { sessionId, rejectUnsubscribe: true })
  const nodeFrames = (method: string) => h.received('launch')
    .map((row) => row?.received).filter((frame) => frame?.method === method)
  h.adapter.setPromptPrivacy({ schemaVersion: 1, profile: { nickname, sessionId } })
  const first = h.authority('req-unload-1')
  const run = h.adapter.submitTurn(h.turnParams(first, h.turnKey, 'req-unload-1'))
  await h.until(() => nodeFrames('turn/start').length === 1, 'first turn/start')
  const firstTotal: CodexNativeTokens = { ...zeroNativeTokens(), inputTokens: 200, outputTokens: 20 }
  h.emit({ method: 'thread/tokenUsage/updated', params: h.tokenUsage(TURNS[0]!, firstTotal, firstTotal) })
  h.emit({ method: 'turn/completed', params: { threadId: THREAD, turn: { id: TURNS[0], status: 'completed' } } })
  assert.equal((await run.summary)?.isError, false)

  h.adapter.setPromptPrivacy({ schemaVersion: 1, profile: null })
  await restartRunnerForConfigChange(h.adapter)
  const second = h.authority('req-unload-2')
  const run2 = h.adapter.submitTurn(h.turnParams(second, 'f'.repeat(64), 'req-unload-2'))
  const summary2 = await run2.summary.catch((error: unknown) => ({ isError: true, error }))
  assert.equal(summary2?.isError, true, 'the turn fails instead of running on the old instructions')
  await h.until(() => h.abandonCauses().length === 1, 'the undispatched admission is closed')
  assert.deepEqual(h.abandonCauses(), [{ failureCode: 'INTERNAL_ERROR', diagnostic: 'codex_thread_unload_unproven' }])
  assert.equal(nodeFrames('thread/unsubscribe').length, 1)
  assert.equal(nodeFrames('thread/resume').length, 0, 'no resume reaches the node after a refused unload')
  assert.equal(nodeFrames('turn/start').length, 1, 'the second turn never reached the node')
  assert.equal(h.receipts.length, 1)
})

test('a post-resume usage replay that differs from the billed thread total fences before the turn',
  { timeout: 180000 }, async (t) => {
  // OCV5-746 live: 0.167 re-emits the last cumulative usage after a warm resume. Only the exact
  // settled boundary may be dropped; anything else is unbilled usage and must not be ignored.
  const h = await lane(t, { inflateUsageReplay: true })
  const turnStarts = () => h.received('launch')
    .map((row) => row?.received).filter((frame) => frame?.method === 'turn/start')
  const first = h.authority('req-replay-1')
  const run = h.adapter.submitTurn(h.turnParams(first, h.turnKey, 'req-replay-1'))
  await h.until(() => turnStarts().length === 1, 'first turn/start')
  const firstTotal: CodexNativeTokens = { ...zeroNativeTokens(), inputTokens: 200, outputTokens: 20 }
  h.emit({ method: 'thread/tokenUsage/updated', params: h.tokenUsage(TURNS[0]!, firstTotal, firstTotal) })
  h.emit({ method: 'turn/completed', params: { threadId: THREAD, turn: { id: TURNS[0], status: 'completed' } } })
  assert.equal((await run.summary)?.isError, false)

  h.adapter.setEffortLevel('high')
  await restartRunnerForConfigChange(h.adapter)
  const second = h.authority('req-replay-2')
  const run2 = h.adapter.submitTurn(h.turnParams(second, 'f'.repeat(64), 'req-replay-2'))
  const summary2 = await run2.summary.catch((error: unknown) => ({ isError: true, error }))
  assert.equal(summary2?.isError, true)
  assert.equal(turnStarts().length, 1, 'the second turn never reached the node')
  assert.equal(h.receipts.length, 1)
  // Live it stayed inflight with the thread claimed, so the conversation could never continue.
  await h.until(() => h.abandonCauses().length === 1, 'the undispatched admission is closed unbilled')
  assert.deepEqual(h.abandonCauses(), [{ failureCode: 'INTERNAL_ERROR', diagnostic: 'codex_usage_replay_unproven' }])
})

test('a turn submitted while another runs admits only after that turn ends', { timeout: 180000 }, async (t) => {
  const h = await lane(t)
  const starts = () => h.received('launch').filter((row) => row?.received?.method === 'turn/start').length
  const first = h.authority('req-queued-1')
  const run1 = h.adapter.submitTurn(h.turnParams(first, h.turnKey, 'req-queued-1'))
  await h.until(() => starts() === 1, 'first turn/start')

  // The master admits one turn per lane: a second admission while this one is live is rejected as a
  // scope violation and fences the lane, taking the running turn down with it. The second turn must
  // therefore wait for the first terminal — submitted here through the same two lane halves
  // `submitTurn` uses (`beginTurn` + `kernel.submit`), without the adapter's single-turn parser.
  const second = h.authority('req-queued-2')
  h.remoteLane.beginTurn(h.turnParams(second, 'c'.repeat(64), 'req-queued-2'))
  void h.remoteLane.kernel.submit('run the queued fixture turn', 'req-queued-2').catch(() => {})
  await new Promise((resolve) => setTimeout(resolve, 500))
  assert.equal(starts(), 1, 'the queued turn must not start early')
  assert.equal(h.relay.stopped, false, 'the queued admission must not fence the lane')

  const total: CodexNativeTokens = { ...zeroNativeTokens(), inputTokens: 1000, outputTokens: 100 }
  h.emit({ method: 'thread/tokenUsage/updated', params: h.tokenUsage(TURNS[0]!, total, total) })
  h.emit({ method: 'turn/completed', params: { threadId: THREAD, turn: { id: TURNS[0], status: 'completed' } } })
  const summary1 = await run1.summary
  assert.ok(summary1)
  assert.equal(summary1.isError, false)
  assert.equal(h.receipts.length, 1)

  await h.until(() => starts() === 2, 'queued turn/start after the first terminal')
  const secondTotal: CodexNativeTokens = { ...zeroNativeTokens(), inputTokens: 500, outputTokens: 40 }
  const cumulative: CodexNativeTokens = {
    ...zeroNativeTokens(), inputTokens: total.inputTokens + secondTotal.inputTokens,
    outputTokens: total.outputTokens + secondTotal.outputTokens,
  }
  h.emit({ method: 'thread/tokenUsage/updated', params: h.tokenUsage(TURNS[1]!, cumulative, secondTotal) })
  h.emit({ method: 'turn/completed', params: { threadId: THREAD, turn: { id: TURNS[1], status: 'completed' } } })
  await h.until(() => h.receipts.length === 2, 'the queued turn settled')
  assert.equal(h.launches, 1, 'both turns share the one resident node app')
  assert.deepEqual(h.receipts[1]!.nativeUsage, secondTotal)
  assert.deepEqual(h.receipts[1]!.total, cumulative)
  assert.equal(h.relay.stopped, false)
})

test('a route change rebinds the tool host and pump to the generation that still serves the turn',
  { timeout: 180000 }, async (t) => {
    const h = await lane(t)
    const starts = () => h.received('launch').filter((row) => row?.received?.method === 'turn/start').length
    const first = h.authority('req-route-1')
    const run1 = h.adapter.submitTurn(h.turnParams(first, h.turnKey, 'req-route-1'))
    await h.until(() => starts() === 1, 'first turn/start')
    const firstTotal: CodexNativeTokens = { ...zeroNativeTokens(), inputTokens: 700, outputTokens: 70 }
    h.emit({ method: 'thread/tokenUsage/updated', params: h.tokenUsage(TURNS[0]!, firstTotal, firstTotal) })
    h.emit({ method: 'turn/completed', params: { threadId: THREAD, turn: { id: TURNS[0], status: 'completed' } } })
    const summary1 = await run1.summary
    assert.ok(summary1)
    assert.equal(summary1.isError, false)
    assert.equal(h.receipts.length, 1)

    // The provider route is launch-time argv for the app-server, so the kernel replaces its
    // process here: the fresh container generation must still execute this lane's tools.
    h.remoteLane.kernel.setCodexRoute({ model: 'gpt-6-luna-alt' })
    const second = h.authority('req-route-2')
    const run2 = h.adapter.submitTurn(h.turnParams(second, 'd'.repeat(64), 'req-route-2'))
    await h.until(() => starts() === 2, 'second turn/start after the route change')
    assert.equal(h.received('launch').filter((row) => row?.received?.method === 'thread/resume').length, 1,
      'the fresh kernel generation resumes the thread the lane already bound')

    const args = { file_path: h.sentinel, content: 'after-route-change\n' }
    h.nativeItem('item/started',
      { type: 'mcpToolCall', id: 'call-route', server: 'ocbridge', tool: 'Write', arguments: args }, TURNS[1])
    h.sendTool(h.toolRequest('call-route', args, TURNS[1]))
    // Without a pump on the new generation the master keeps this call forever and no file appears.
    // The recycled generation also builds its own tool host, which can be slow under load.
    await h.until(() => existsSync(h.sentinel), 'container tool effect on the recycled generation', 3000)
    assert.equal(readFileSync(h.sentinel, 'utf8'), 'after-route-change\n')
    assert.equal(h.executed.length, 1)
    await h.until(() => h.toolResponses().length === 1, 'tool response on the node channel', 3000)
    assert.equal(h.toolResponses()[0]!.callId, 'call-route')

    h.nativeItem('item/completed',
      { type: 'mcpToolCall', id: 'call-route', server: 'ocbridge', tool: 'Write', arguments: args }, TURNS[1])
    const secondTotal: CodexNativeTokens = { ...zeroNativeTokens(), inputTokens: 300, outputTokens: 30 }
    const cumulative: CodexNativeTokens = {
      ...zeroNativeTokens(), inputTokens: firstTotal.inputTokens + secondTotal.inputTokens,
      outputTokens: firstTotal.outputTokens + secondTotal.outputTokens,
    }
    h.emit({ method: 'thread/tokenUsage/updated', params: h.tokenUsage(TURNS[1]!, cumulative, secondTotal) })
    h.emit({ method: 'turn/completed', params: { threadId: THREAD, turn: { id: TURNS[1], status: 'completed' } } })
    const summary2 = await run2.summary
    assert.ok(summary2)
    assert.equal(summary2.isError, false)
    assert.equal(h.receipts.length, 2)
    assert.equal(h.receipts[1]!.nativeTurnId, TURNS[1])
    assert.deepEqual(h.receipts[1]!.nativeUsage, secondTotal)
    assert.equal(h.launches, 1, 'the node app stays resident across container generations')
    assert.equal(h.relay.stopped, false)
  })

test('two turns queued behind a running turn admit one at a time and never fence the lane',
  { timeout: 240000 }, async (t) => {
    const h = await lane(t)
    const starts = () => h.received('launch').filter((row) => row?.received?.method === 'turn/start').length
    const first = h.authority('req-fifo-1')
    const run1 = h.adapter.submitTurn(h.turnParams(first, h.turnKey, 'req-fifo-1'))
    await h.until(() => starts() === 1, 'first turn/start')

    // Two more turns arrive while the first runs. The master admits one turn per lane, so a
    // broadcast handover would race two `/admit` calls and revoke the lane under the live turn.
    h.remoteLane.beginTurn(h.turnParams(h.authority('req-fifo-2'), 'd'.repeat(64), 'req-fifo-2'))
    void h.remoteLane.kernel.submit('queued fixture turn two', 'req-fifo-2').catch(() => {})
    h.remoteLane.beginTurn(h.turnParams(h.authority('req-fifo-3'), 'e'.repeat(64), 'req-fifo-3'))
    void h.remoteLane.kernel.submit('queued fixture turn three', 'req-fifo-3').catch(() => {})
    await pause(500)
    assert.equal(starts(), 1, 'queued turns must not admit early')
    assert.equal(h.relay.stopped, false, 'queueing must not fence the lane')

    const firstTotal: CodexNativeTokens = { ...zeroNativeTokens(), inputTokens: 800, outputTokens: 80 }
    h.emit({ method: 'thread/tokenUsage/updated', params: h.tokenUsage(TURNS[0]!, firstTotal, firstTotal) })
    h.emit({ method: 'turn/completed', params: { threadId: THREAD, turn: { id: TURNS[0], status: 'completed' } } })
    const summary1 = await run1.summary
    assert.ok(summary1)
    assert.equal(summary1.isError, false)

    await h.until(() => starts() === 2, 'second turn/start after the first terminal')
    await pause(500)
    assert.equal(starts(), 2, 'the third turn waits for the second terminal, not the first')
    assert.equal(h.relay.stopped, false)

    const secondTotal: CodexNativeTokens = { ...zeroNativeTokens(), inputTokens: 500, outputTokens: 50 }
    h.emit({
      method: 'thread/tokenUsage/updated',
      params: h.tokenUsage(TURNS[1]!, { ...zeroNativeTokens(),
        inputTokens: firstTotal.inputTokens + secondTotal.inputTokens,
        outputTokens: firstTotal.outputTokens + secondTotal.outputTokens }, secondTotal),
    })
    h.emit({ method: 'turn/completed', params: { threadId: THREAD, turn: { id: TURNS[1], status: 'completed' } } })
    await h.until(() => starts() === 3, 'third turn/start after the second terminal')

    const thirdTotal: CodexNativeTokens = { ...zeroNativeTokens(), inputTokens: 200, outputTokens: 20 }
    const cumulative: CodexNativeTokens = {
      ...zeroNativeTokens(),
      inputTokens: firstTotal.inputTokens + secondTotal.inputTokens + thirdTotal.inputTokens,
      outputTokens: firstTotal.outputTokens + secondTotal.outputTokens + thirdTotal.outputTokens,
    }
    h.emit({ method: 'thread/tokenUsage/updated', params: h.tokenUsage(TURNS[2]!, cumulative, thirdTotal) })
    h.emit({ method: 'turn/completed', params: { threadId: THREAD, turn: { id: TURNS[2], status: 'completed' } } })
    await h.until(() => h.receipts.length === 3, 'all three turns settled')
    assert.deepEqual(h.receipts.map((receipt) => receipt.nativeTurnId), TURNS)
    assert.deepEqual(h.receipts.map((receipt) => receipt.nativeUsage.inputTokens), [800, 500, 200])
    assert.equal(h.launches, 1, 'one resident node app serves every turn of the lane')
    assert.equal(h.relay.stopped, false)
  })

test('a stop reaches the node while another turn waits behind the running one', { timeout: 180000 }, async (t) => {
  const h = await lane(t)
  const starts = () => h.received('launch').filter((row) => row?.received?.method === 'turn/start').length
  const first = h.authority('req-stop-queued-1')
  const run1 = h.adapter.submitTurn(h.turnParams(first, h.turnKey, 'req-stop-queued-1'))
  await h.until(() => starts() === 1, 'first turn/start')

  // The queued admission must not take the shared frame gate hostage: the running turn's own
  // `turn/interrupt` has to leave this container immediately.
  h.remoteLane.beginTurn(h.turnParams(h.authority('req-stop-queued-2'), 'd'.repeat(64), 'req-stop-queued-2'))
  void h.remoteLane.kernel.submit('queued fixture turn', 'req-stop-queued-2').catch(() => {})
  await pause(300)
  assert.equal(h.adapter.interrupt(), true)
  await h.until(
    () => h.received('launch').some((row) => row?.received?.method === 'turn/interrupt'),
    'turn/interrupt reaches the node while a turn is queued',
  )

  const partial: CodexNativeTokens = { ...zeroNativeTokens(), inputTokens: 250, outputTokens: 25 }
  h.emit({ method: 'thread/tokenUsage/updated', params: h.tokenUsage(TURNS[0]!, partial, partial) })
  h.emit({ method: 'turn/completed', params: { threadId: THREAD, turn: { id: TURNS[0], status: 'interrupted' } } })
  const stopped = await run1.summary
  assert.ok(stopped)
  assert.equal(stopped.isError, true)
  assert.equal(h.receipts.length, 1)
  assert.equal(h.receipts[0]!.nativeStatus, 'interrupted')

  // The queued turn takes over the same resident app once the cancelled one settled.
  await h.until(() => starts() === 2, 'queued turn/start after the cancel')
  const secondTotal: CodexNativeTokens = { ...zeroNativeTokens(), inputTokens: 400, outputTokens: 40 }
  h.emit({
    method: 'thread/tokenUsage/updated',
    params: h.tokenUsage(TURNS[1]!, { ...zeroNativeTokens(),
      inputTokens: partial.inputTokens + secondTotal.inputTokens,
      outputTokens: partial.outputTokens + secondTotal.outputTokens }, secondTotal),
  })
  h.emit({ method: 'turn/completed', params: { threadId: THREAD, turn: { id: TURNS[1], status: 'completed' } } })
  await h.until(() => h.receipts.length === 2, 'the queued turn settled after the cancel')
  assert.deepEqual(h.receipts[1]!.nativeUsage, secondTotal)
  assert.equal(h.launches, 1)
  assert.equal(h.relay.stopped, false)
})

test('a cancel before the native turn/start hands the admission back and the lane keeps working',
  { timeout: 180000 }, async (t) => {
    const h = await lane(t)
    const starts = () => h.received('launch').filter((row) => row?.received?.method === 'turn/start').length
    h.holdAdmission(true)
    const first = h.authority('req-early-1')
    const run = h.adapter.submitTurn(h.turnParams(first, h.turnKey, 'req-early-1'))
    // The kernel is parked on its admission, so the stop lands before `turn/start` exists.
    await h.until(() => h.adapter.interrupt(), 'interrupt accepted before turn/start')
    assert.equal(starts(), 0, 'nothing may reach the node before the admission')
    h.holdAdmission(false)

    const cancelled = await run.summary
    assert.ok(cancelled)
    assert.equal(cancelled.isError, true)
    assert.equal(starts(), 0, 'a turn cancelled before start never dispatches')
    assert.equal(h.receipts.length, 0, 'an undispatched turn has no receipt to settle')
    assert.equal(h.relay.stopped, false, 'the abandoned admission must not fence the lane')

    // The master's admission was handed back, so the next turn admits on the same lane and app.
    const second = h.authority('req-early-2')
    const run2 = h.adapter.submitTurn(h.turnParams(second, 'd'.repeat(64), 'req-early-2'))
    await h.until(() => starts() === 1, 'the next turn/start after the abandoned admission', 1500)
    const args = { file_path: h.sentinel, content: 'after-early-cancel\n' }
    h.nativeItem('item/started',
      { type: 'mcpToolCall', id: 'call-early', server: 'ocbridge', tool: 'Write', arguments: args }, TURNS[0])
    h.sendTool(h.toolRequest('call-early', args, TURNS[0]))
    // The interrupt recycled the app-server, so this generation starts its own tool host: the real
    // supervisor can take a while under load before the pump can execute anything.
    await h.until(() => existsSync(h.sentinel), 'container tool effect after the abandon', 3000)
    assert.equal(readFileSync(h.sentinel, 'utf8'), 'after-early-cancel\n')
    await h.until(() => h.toolResponses().length === 1, 'tool response after the abandon', 3000)
    h.nativeItem('item/completed',
      { type: 'mcpToolCall', id: 'call-early', server: 'ocbridge', tool: 'Write', arguments: args }, TURNS[0])

    const total: CodexNativeTokens = { ...zeroNativeTokens(), inputTokens: 350, outputTokens: 35 }
    h.emit({ method: 'thread/tokenUsage/updated', params: h.tokenUsage(TURNS[0]!, total, total) })
    h.emit({ method: 'turn/completed', params: { threadId: THREAD, turn: { id: TURNS[0], status: 'completed' } } })
    const summary2 = await run2.summary
    assert.ok(summary2)
    assert.equal(summary2.isError, false)
    assert.equal(h.receipts.length, 1, 'only the dispatched turn is billed')
    assert.equal(h.receipts[0]!.authorityTurnId, second.a.authorityTurnId)
    assert.deepEqual(h.receipts[0]!.nativeUsage, total)
    assert.equal(h.launches, 1)
  })

test('a turn that outlives its first lease window keeps its tools after the renewal',
  { timeout: 180000 }, async (t) => {
    const h = await lane(t, { leaseRenewAfterMs: 200 })
    const starts = () => h.received('launch').filter((row) => row?.received?.method === 'turn/start').length
    // Warm the resident app first: the kernel's one-off spawn must not eat the short window this
    // test needs to observe. A later turn on a warm app admits in a few hundred milliseconds.
    const warm = h.authority('req-lease-warm')
    const run1 = h.adapter.submitTurn(h.turnParams(warm, h.turnKey, 'req-lease-warm'))
    await h.until(() => starts() === 1, 'warm-up turn/start')
    const warmTotal: CodexNativeTokens = { ...zeroNativeTokens(), inputTokens: 100, outputTokens: 10 }
    h.emit({ method: 'thread/tokenUsage/updated', params: h.tokenUsage(TURNS[0]!, warmTotal, warmTotal) })
    h.emit({ method: 'turn/completed', params: { threadId: THREAD, turn: { id: TURNS[0], status: 'completed' } } })
    const warmSummary = await run1.summary
    assert.ok(warmSummary)
    assert.equal(warmSummary.isError, false)
    const renewalsBefore = h.renewals()

    // The master's first window for this turn is deliberately short: without a renewal consumer
    // the relay fences the lane at its expiry (CODEX_LEASE_EXPIRED) and the turn dies mid-flight.
    const shortTtlMs = 5000
    const issuedAt = Date.now()
    const signed = h.authority('req-lease', shortTtlMs)
    const run = h.adapter.submitTurn(h.turnParams(signed, 'd'.repeat(64), 'req-lease'))
    await h.until(() => starts() === 2, 'turn/start on the short lease')
    await h.until(() => h.renewals() > renewalsBefore, 'the lane renewed its turn lease')
    // Cross the original expiry: the relay only survives because `/renew` re-armed its fence.
    while (Date.now() < issuedAt + shortTtlMs + 1200) await pause(100)
    assert.equal(h.relay.stopped, false, 'the lane outlived its original lease window')

    const args = { file_path: h.sentinel, content: 'after-lease-renewal\n' }
    h.nativeItem('item/started',
      { type: 'mcpToolCall', id: 'call-lease', server: 'ocbridge', tool: 'Write', arguments: args }, TURNS[1])
    h.sendTool(h.toolRequest('call-lease', args, TURNS[1]))
    await h.until(() => existsSync(h.sentinel), 'container tool effect on the renewed lease')
    assert.equal(readFileSync(h.sentinel, 'utf8'), 'after-lease-renewal\n')
    assert.equal(h.receipts.length, 1, 'the warm-up turn settled before the long one started')
    await h.until(() => h.toolResponses().length === 1, 'tool response on the renewed lease')
    h.nativeItem('item/completed',
      { type: 'mcpToolCall', id: 'call-lease', server: 'ocbridge', tool: 'Write', arguments: args }, TURNS[1])

    const total: CodexNativeTokens = { ...zeroNativeTokens(), inputTokens: 600, outputTokens: 60 }
    h.emit({
      method: 'thread/tokenUsage/updated',
      params: h.tokenUsage(TURNS[1]!, { ...zeroNativeTokens(),
        inputTokens: warmTotal.inputTokens + total.inputTokens,
        outputTokens: warmTotal.outputTokens + total.outputTokens }, total),
    })
    h.emit({ method: 'turn/completed', params: { threadId: THREAD, turn: { id: TURNS[1], status: 'completed' } } })
    const summary = await run.summary
    assert.ok(summary)
    assert.equal(summary.isError, false)
    assert.equal(h.receipts.length, 2)
    assert.equal(h.receipts[1]!.nativeTurnId, TURNS[1])
    assert.deepEqual(h.receipts[1]!.nativeUsage, total)
    assert.equal(h.relay.stopped, false)
  })

test('a late abandon ACK keeps the recycled kernel silent until the next admission',
  { timeout: 180000 }, async (t) => {
    const h = await lane(t)
    const starts = () => h.received('launch').filter((row) => row?.received?.method === 'turn/start').length
    h.holdAdmission(true)
    const first = h.authority('req-late-1')
    const run = h.adapter.submitTurn(h.turnParams(first, h.turnKey, 'req-late-1'))
    await h.until(() => h.adapter.interrupt(), 'interrupt accepted before turn/start')
    // The master closes the admission but the container's ACK is parked: the finishing turn still
    // owns this lane locally, so any frame written now would ride a closed admission.
    h.holdAbandon(true)
    h.holdAdmission(false)
    const cancelled = await run.summary
    assert.ok(cancelled)
    assert.equal(cancelled.isError, true)
    await h.until(() => h.abandonAcksHeld(), 'the container is still waiting for the abandon ACK')
    assert.equal(starts(), 0)

    // A second turn lands inside that window, and the kernel recycles its app-server for it.
    const framesBefore = h.received('launch').length
    const second = h.authority('req-late-2')
    const run2 = h.adapter.submitTurn(h.turnParams(second, 'd'.repeat(64), 'req-late-2'))
    await pause(1500)
    assert.equal(h.received('launch').length, framesBefore,
      'the recycled kernel wrote nothing on the admission it does not own')
    assert.equal(h.relay.stopped, false, 'an early RPC would have fenced the whole lane')

    h.holdAbandon(false)
    await h.until(() => h.abandons() === 1, 'the master closed the abandoned admission')
    await h.until(() => starts() === 1, 'the queued turn dispatches after the late ACK', 1500)
    const args = { file_path: h.sentinel, content: 'after-late-ack\n' }
    h.nativeItem('item/started',
      { type: 'mcpToolCall', id: 'call-late', server: 'ocbridge', tool: 'Write', arguments: args }, TURNS[0])
    h.sendTool(h.toolRequest('call-late', args, TURNS[0]))
    await h.until(() => existsSync(h.sentinel), 'container tool effect after the late ACK', 3000)
    assert.equal(readFileSync(h.sentinel, 'utf8'), 'after-late-ack\n')
    await h.until(() => h.toolResponses().length === 1, 'tool response after the late ACK', 3000)
    h.nativeItem('item/completed',
      { type: 'mcpToolCall', id: 'call-late', server: 'ocbridge', tool: 'Write', arguments: args }, TURNS[0])

    const total: CodexNativeTokens = { ...zeroNativeTokens(), inputTokens: 420, outputTokens: 42 }
    h.emit({ method: 'thread/tokenUsage/updated', params: h.tokenUsage(TURNS[0]!, total, total) })
    h.emit({ method: 'turn/completed', params: { threadId: THREAD, turn: { id: TURNS[0], status: 'completed' } } })
    const summary2 = await run2.summary
    assert.ok(summary2)
    assert.equal(summary2.isError, false)
    assert.equal(h.receipts.length, 1, 'only the dispatched turn is billed')
    assert.equal(h.receipts[0]!.authorityTurnId, second.a.authorityTurnId)
    assert.deepEqual(h.receipts[0]!.nativeUsage, total)
    assert.equal(h.relay.stopped, false)
  })

test('a tool delivery carrying a just-renewed lease is served while its ACK is still parked',
  { timeout: 180000 }, async (t) => {
    const h = await lane(t, { leaseRenewAfterMs: 200 })
    const starts = () => h.received('launch').filter((row) => row?.received?.method === 'turn/start').length
    // Warm the resident app: the turn under test must admit long before its renewal fires.
    const warm = h.authority('req-renew-warm')
    const run1 = h.adapter.submitTurn(h.turnParams(warm, h.turnKey, 'req-renew-warm'))
    await h.until(() => starts() === 1, 'warm-up turn/start')
    const warmTotal: CodexNativeTokens = { ...zeroNativeTokens(), inputTokens: 100, outputTokens: 10 }
    h.emit({ method: 'thread/tokenUsage/updated', params: h.tokenUsage(TURNS[0]!, warmTotal, warmTotal) })
    h.emit({ method: 'turn/completed', params: { threadId: THREAD, turn: { id: TURNS[0], status: 'completed' } } })
    assert.ok(await run1.summary)
    assert.equal(h.receipts.length, 1)

    h.holdRenewAck(true)
    const signed = h.authority('req-renew-ack')
    const run = h.adapter.submitTurn(h.turnParams(signed, 'd'.repeat(64), 'req-renew-ack'))
    await h.until(() => starts() === 2, 'turn/start under the held renewal')
    await h.until(() => h.renewAcksHeld(), 'the master applied the renewal and the ACK is parked')

    // The master already serves the renewed lease, so this delivery is legal even though the
    // container has not published the renewal yet.
    const args = { file_path: h.sentinel, content: 'renewed-before-ack\n' }
    h.nativeItem('item/started',
      { type: 'mcpToolCall', id: 'call-ack', server: 'ocbridge', tool: 'Write', arguments: args }, TURNS[1])
    h.sendTool(h.toolRequest('call-ack', args, TURNS[1]))
    await h.until(() => existsSync(h.sentinel), 'the early delivery still reaches the container host')
    assert.equal(readFileSync(h.sentinel, 'utf8'), 'renewed-before-ack\n')
    assert.equal(h.relay.stopped, false, 'a legal early delivery must never fence the lane')

    h.holdRenewAck(false)
    await h.until(() => !h.renewAcksHeld(), 'the parked renewal ACK completes', 1500)
    await h.until(() => h.toolResponses().length === 1, 'tool response after the renewal ACK', 3000)
    h.nativeItem('item/completed',
      { type: 'mcpToolCall', id: 'call-ack', server: 'ocbridge', tool: 'Write', arguments: args }, TURNS[1])

    const total: CodexNativeTokens = { ...zeroNativeTokens(), inputTokens: 500, outputTokens: 50 }
    h.emit({
      method: 'thread/tokenUsage/updated',
      params: h.tokenUsage(TURNS[1]!, { ...zeroNativeTokens(),
        inputTokens: warmTotal.inputTokens + total.inputTokens,
        outputTokens: warmTotal.outputTokens + total.outputTokens }, total),
    })
    h.emit({ method: 'turn/completed', params: { threadId: THREAD, turn: { id: TURNS[1], status: 'completed' } } })
    const summary = await run.summary
    assert.ok(summary)
    assert.equal(summary.isError, false)
    assert.equal(h.receipts.length, 2)
    assert.deepEqual(h.receipts[1]!.nativeUsage, total)
    assert.equal(h.relay.stopped, false)
  })

test('a node that dies mid-turn leaves no container effect and no replay', { timeout: 120000 }, async (t) => {
  const h = await lane(t)
  const signed = h.authority('req-drop')
  const run = h.adapter.submitTurn(h.turnParams(signed, h.turnKey, 'req-drop'))
  await h.until(() => h.received('launch').some((row) => row?.received?.method === 'turn/start'), 'turn/start')
  h.child('launch').kill()
  await h.until(() => h.relay.stopped, 'relay fence')
  const summary = await run.summary
  assert.ok(summary)
  assert.equal(summary.isError, true)
  assert.deepEqual(h.executed, [])
  assert.equal(existsSync(h.sentinel), false)
  assert.equal(h.receipts.length, 0)
  assert.equal((await h.call('/tool/next')).status, 403)
})


test('R1 read-only and consult turns reject before admission: no container Write or node launch', async (t) => {
  const h = await lane(t)
  for (const restriction of [{readOnly: true}, {consultTurn: true}]) {
    const signed = h.authority('readonly')
    assert.throws(() => h.adapter.submitTurn({...h.turnParams(signed, h.turnKey, 'readonly'), ...restriction} as TurnParams),
      /CODEX_REMOTE_READ_ONLY_UNSUPPORTED/)
    assert.equal(existsSync(h.sentinel), false)
    assert.equal(h.executed.length, 0)
    assert.equal(h.launches, 0)
    assert.equal(h.receipts.length, 0)
  }
})

test('R1 cancel then shutdown proves resident node and local host stopped', {timeout: 90000}, async (t) => {
  const h = await lane(t)
  const run = h.adapter.submitTurn(h.turnParams(h.authority('shutdown-after-cancel'), h.turnKey, 'shutdown-after-cancel'))
  await h.until(() => h.received('launch').some(row => row?.received?.method === 'turn/start'), 'turn start')
  assert.equal(h.adapter.interrupt(), true)
  await h.until(() => h.received('launch').some(row => row?.received?.method === 'turn/interrupt'), 'interrupt')
  h.emit({method:'thread/tokenUsage/updated',params:h.tokenUsage(TURNS[0]!,zeroNativeTokens(),zeroNativeTokens())})
  h.emit({method:'turn/completed',params:{threadId:THREAD,turn:{id:TURNS[0],status:'interrupted'}}})
  assert.equal((await run.summary)?.isError, true)
  await h.adapter.shutdown()
  assert.equal(h.relay.stopped, true)
  await h.until(() => h.child('launch').exitCode !== null || h.child('launch').signalCode !== null, 'resident process exit')
  assert.ok(h.child('tool-socket').exitCode !== null || h.child('tool-socket').signalCode !== null)
})


test('R1 platform MCP reads the selected non-main agent private skill through the real container host', {timeout: 120000}, async (t) => {
  const h = await lane(t, {platformTools:true})
  const run = h.adapter.submitTurn(h.turnParams(h.authority('mcp-skill'), h.turnKey, 'mcp-skill'))
  await h.until(() => h.received('launch').some(row => row?.received?.method === 'turn/start'), 'turn start', 2000)
  const call = async (name: string, args: Record<string, unknown>, id: string) => {
    const count = h.toolResponses().length
    h.nativeItem('item/started',{type:'mcpToolCall',id,server:'ocbridge',tool:name,arguments:args})
    h.sendTool({...h.toolRequest(id,args),name})
    await h.until(() => h.toolResponses().length > count, 'MCP result', 2000)
    h.nativeItem('item/completed',{type:'mcpToolCall',id,server:'ocbridge',tool:name,arguments:args})
    return JSON.stringify(h.toolResponses().at(-1))
  }
  const found = await call('SearchExtraTools',{query:'select:mcp__openclaude-memory__skill_view'},'mcp-search')
  assert.match(found,/skill_view/)
  const result = await call('ExecuteExtraTool',{tool_name:'mcp__openclaude-memory__skill_view',params:{name:'r1-private'}},'mcp-view')
  assert.match(result,/R1_AGENT_PRIVATE_SKILL_BODY/)
  assert.doesNotMatch(result,/WRONG_MAIN_BODY/)
  const context = await call('Bash', {command: 'printf "%s|%s|%s" "$OPENCLAUDE_AGENT_ID" "$OC_AGENT_ID" "$OPENCLAUDE_SESSION_KEY"'}, 'context-check')
  assert.ok(context.includes(`coding-assistant|coding-assistant|${h.binding.sessionKey}`))
  h.emit({method:'thread/tokenUsage/updated',params:h.tokenUsage(TURNS[0]!,zeroNativeTokens(),zeroNativeTokens())})
  h.emit({method:'turn/completed',params:{threadId:THREAD,turn:{id:TURNS[0],status:'completed'}}})
  assert.equal((await run.summary)?.isError,false)
})


test('R1 unproved retired tool host prevents successful shutdown until its proof is available', {timeout:120000}, async (t) => {
  const closeFailure = {active:false}
  const h = await lane(t,{closeFailure})
  const run=h.adapter.submitTurn(h.turnParams(h.authority('close-proof'),h.turnKey,'close-proof'))
  await h.until(()=>h.received('launch').some(row=>row?.received?.method==='turn/start'),'turn start')
  closeFailure.active=true
  h.adapter.interrupt()
  await h.until(()=>h.received('launch').some(row=>row?.received?.method==='turn/interrupt'),'interrupt')
  h.emit({method:'thread/tokenUsage/updated',params:h.tokenUsage(TURNS[0]!,zeroNativeTokens(),zeroNativeTokens())})
  h.emit({method:'turn/completed',params:{threadId:THREAD,turn:{id:TURNS[0],status:'interrupted'}}})
  assert.equal((await run.summary)?.isError,true)
  await assert.rejects(h.adapter.shutdown(),/CODEX_|FIXTURE_/)
  assert.throws(()=>h.adapter.submitTurn(h.turnParams(h.authority('no-reuse'), 'e'.repeat(64),'no-reuse')),/CODEX_LOCAL_STOP_UNPROVEN/)
  closeFailure.active=false
  await h.adapter.shutdown()
  assert.deepEqual(await h.relay.stop(),{remoteStopped:true})
})


// Exercise the actual fixed worker and stdio protocol; node/finance remain explicit fixtures.
// This regression is NOT a production commissioning receipt or node proof.
test('commissioning worker traverses stdio relay, real CCB Write and actual supervisor stop', {timeout:180000}, async t=>{
  const h=await lane(t), signed=h.authority('commission-worker')
  h.turnParams(signed,h.turnKey,'commission-worker') // fixture finance attribution, no turn submitted here
  const directory=`/home/agent/.openclaude/commissioning/${randomUUID()}`,sentinel=join(directory,'sentinel.txt'),content='commission-worker-marker\n'
  const worker=spawn(process.execPath,['--import','tsx',fileURLToPath(new URL('../codexCommissioningWorker.ts',import.meta.url))],{stdio:['pipe','pipe','pipe'],env:process.env})
  let done:any,failed:any,stderr=''
  worker.stderr.on('data',b=>{stderr+=b.toString()})
  const exited=once(worker,'close')
  commissioningLines(worker.stdout,v=>{
    if(v.kind==='done'){done=v;return}
    if(v.kind==='failed'){failed=v;return}
    assert.equal(v.kind,'request')
    void h.call(v.path,JSON.parse(v.body)).then(reply=>{
      const {status,...body}=reply
      worker.stdin.write(JSON.stringify({kind:'response',id:v.id,status,body:JSON.stringify(body)})+'\n')
    }).catch(e=>{failed=e;worker.kill()})
  },e=>{if(!done)failed=e})
  t.after(()=>{worker.kill();rmSync(directory,{recursive:true,force:true})})
  worker.stdin.write(JSON.stringify({kind:'init',binding:h.binding,authority:signed.authority,lease:signed.lease,
    sentinel,content,requestId:'commission-worker',turnKey:h.turnKey,contextWindow:1000,
    keyring:[...h.keys].map(([id,key])=>[id,Buffer.from(key).toString('base64')])})+'\n')
  await h.until(()=>h.received('launch').some(r=>r?.received?.method==='turn/start'),'commission worker turn/start')
  const args={file_path:sentinel,content}
  h.nativeItem('item/started',{type:'mcpToolCall',id:'commission-call',server:'ocbridge',tool:'Write',arguments:args})
  h.sendTool(h.toolRequest('commission-call',args))
  await h.until(()=>existsSync(sentinel),'real worker sentinel')
  assert.equal(readFileSync(sentinel,'utf8'),content)
  await h.until(()=>h.toolResponses().length===1,'worker tool response')
  h.nativeItem('item/completed',{type:'mcpToolCall',id:'commission-call',server:'ocbridge',tool:'Write',arguments:args})
  const total={...zeroNativeTokens(),inputTokens:1000,outputTokens:80}
  h.emit({method:'thread/tokenUsage/updated',params:h.tokenUsage(TURNS[0]!,total,total)})
  h.emit({method:'turn/completed',params:{threadId:THREAD,turn:{id:TURNS[0],status:'completed'}}})
  const [code]=await exited
  assert.equal(code,0,`worker failed: ${JSON.stringify(failed)} ${stderr.slice(-1000)}`)
  assert.equal(done.calls,1);assert.equal(done.proofs.length,1)
  assert.equal(done.proofs[0].proof.localStopped,true)
  assert.equal(existsSync(`/proc/${done.proofs[0].proof.supervisorPid}`),false)
  assert.equal(h.receipts[0]!.version,3)
})
