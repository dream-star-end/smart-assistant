/**
 * Container-side multi-lane verification worker for `remote-driver-v4` commissioning (`OCV5-749`, R12).
 *
 * Security invariants:
 * - Redirects `process.stdout.write` to `process.stderr.write`; NDJSON protocol owns `rawWrite`.
 * - Enforces `process.getuid?.() === 1000` (unprivileged container agent user only).
 * - Delegates `Write`-only `Cc5ToolHost`, relay proxy, and `stopped.json` validation to `verificationWorkerHost.ts`.
 */
import { once } from 'node:events'
import { mkdirSync, readdirSync, rmSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AuthorityKeyring } from '@openclaude/protocol'
import { commissioningLines } from '../codexCommissioningWire.js'
import type { TurnModelAuthority } from '../subprocessRunner.js'
import { RemoteEngineAdapter } from './remoteEngineAdapter.js'
import { type RemotePoolBinding, remotePoolBackendOf, remotePoolNeed } from './types.js'
import {
  type ExecutedToolCall,
  type PendingHttpCall,
  type WorkerLaneState,
  createRelayProxyServer,
  createVerificationHostFactory,
  readStoppedProof,
} from './verificationWorkerHost.js'

const rawWrite = process.stdout.write.bind(process.stdout)
process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write

const UUID_RE = /^[a-f0-9-]{36}$/
const LANE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const COMMISSIONING_BASE = '/home/agent/.openclaude/commissioning'

function emit(frame: Record<string, unknown>): void {
  rawWrite(`${JSON.stringify(frame)}\n`)
}

export async function runVerificationWorkerMain(): Promise<void> {
  remotePoolNeed(process.getuid?.() === 1000, 'VERIFICATION_WORKER_UID_1000_REQUIRED')

  let initializedRunId: string | null = null
  let runRootDir = ''
  let keyring: AuthorityKeyring = new Map()
  let httpSeq = 0
  const pendingHttp = new Map<number, PendingHttpCall>()
  const lanes = new Map<string, WorkerLaneState>()

  async function closeLaneInternal(laneId: string) {
    const lane = lanes.get(laneId)
    remotePoolNeed(lane !== undefined, 'VERIFICATION_LANE_NOT_FOUND')
    if (!lane.closed) {
      lane.closed = true
      lane.barrier?.release(true)
      await lane.adapter.waitForOutputDrain().catch(() => {})
      await lane.adapter.shutdown().catch(() => {})
      await new Promise<void>((res) => lane.server.close(() => res()))
      try {
        unlinkSync(lane.sockPath)
      } catch {
        // Ignore already unlinked socket.
      }
    }
    const proofs = lane.lifecycles.map(({ root, lifecycleId }) => ({
      root,
      lifecycleId,
      proof: readStoppedProof(root, lifecycleId),
    }))
    lanes.delete(laneId)
    return { laneId, calls: lane.calls, nativeSessionId: lane.nativeSessionId, proofs }
  }

  async function shutdownAll(): Promise<void> {
    for (const laneId of [...lanes.keys()]) {
      await closeLaneInternal(laneId).catch(() => {})
    }
  }

  async function handleCommand(msg: Record<string, unknown>): Promise<Record<string, unknown>> {
    const op = String(msg.op ?? '')
    if (op === 'init') {
      remotePoolNeed(initializedRunId === null, 'VERIFICATION_WORKER_ALREADY_INITIALIZED')
      const runId = String(msg.runId ?? '')
      remotePoolNeed(UUID_RE.test(runId), 'VERIFICATION_RUN_ID_INVALID')
      remotePoolNeed(Array.isArray(msg.keyring), 'VERIFICATION_KEYRING_INVALID')
      keyring = new Map<string, Uint8Array>(
        (msg.keyring as Array<[string, string]>).map(([id, b64]) => [
          String(id),
          new Uint8Array(Buffer.from(String(b64), 'base64')),
        ]),
      )
      initializedRunId = runId
      runRootDir = join(COMMISSIONING_BASE, runId)
      mkdirSync(runRootDir, { recursive: true, mode: 0o700 })
      return { ok: true, runRootDir }
    }

    remotePoolNeed(initializedRunId !== null, 'VERIFICATION_WORKER_NOT_INITIALIZED')

    if (op === 'open_lane') {
      const laneId = String(msg.laneId ?? '')
      remotePoolNeed(LANE_ID_RE.test(laneId) && !lanes.has(laneId), 'VERIFICATION_LANE_ID_INVALID')
      const binding = msg.binding as RemotePoolBinding
      const barrierMode = msg.barrierMode === 'hold_until_release' ? 'hold_until_release' : 'none'

      const laneDir = join(runRootDir, laneId)
      const laneCwd = join(laneDir, 'cwd')
      mkdirSync(laneCwd, { recursive: true, mode: 0o700 })
      const sockPath = join(laneDir, 'relay.sock')
      try {
        rmSync(sockPath, { force: true })
      } catch {
        // Ignore if absent.
      }

      const server = createRelayProxyServer({
        laneId,
        pendingHttp,
        nextHttpId: () => ++httpSeq,
        emit,
      })
      server.listen(sockPath)
      await once(server, 'listening')

      const calls: ExecutedToolCall[] = []
      const lifecycles: Array<{ root: string; lifecycleId: string }> = []
      const laneState: Partial<WorkerLaneState> = {
        laneId,
        laneDir,
        laneCwd,
        sockPath,
        server,
        calls,
        lifecycles,
        barrierMode,
        nativeSessionId: null,
        closed: false,
      }

      const hostFactory = createVerificationHostFactory({
        laneId,
        laneDir,
        laneState,
        calls,
        lifecycles,
        emit,
      })

      const adapter = new RemoteEngineAdapter(
        {
          peerId: 'verification-u3',
          sessionKey: binding.sessionKey,
          executionBackend: remotePoolBackendOf(binding),
          agentId: 'main',
          agentBaseDir: laneDir,
          model: binding.canonicalModel,
          effortLevel:
            typeof msg.effort === 'string' && msg.effort.length > 0 ? msg.effort : undefined,
          config: {
            version: 1,
            gateway: { bind: '127.0.0.1', port: 9, accessToken: 'verification-worker' },
            auth: { mode: 'subscription', claudeCodePath: '' },
            channels: { webchat: { enabled: false } },
            sessions: { dbPath: '' },
            defaults: { model: binding.canonicalModel, permissionMode: 'bypassPermissions' },
          } as unknown as ConstructorParameters<typeof RemoteEngineAdapter>[0]['config'],
        },
        {
          binding,
          socketPath: sockPath,
          keyring,
          executionRoot: join(laneDir, 'tools'),
          renewLease: async () => {
            throw new Error('VERIFICATION_LEASE_NOT_RENEWABLE')
          },
          hostFactory,
          toolContextFactory: async () => ({
            profile: { cwd: laneCwd, mcpConfigPath: null, settingsPath: null, disallowedTools: [] },
            env: process.env,
            platformPrompt: '',
            promptCwd: laneCwd,
            cleanup: () => {},
          }),
        },
      )
      adapter.on('error', () => {})
      adapter.on('session_id', (id: string) => {
        const parts = String(id).split(':')
        if (parts.length > 0) laneState.nativeSessionId = parts[parts.length - 1] ?? null
      })
      await adapter.start()
      laneState.adapter = adapter
      lanes.set(laneId, laneState as WorkerLaneState)
      return { ok: true, laneId, laneCwd }
    }

    if (op === 'submit_turn') {
      const laneId = String(msg.laneId ?? '')
      const lane = lanes.get(laneId)
      remotePoolNeed(lane !== undefined && !lane.closed, 'VERIFICATION_LANE_NOT_FOUND')
      if (msg.barrierMode === 'hold_until_release' || msg.barrierMode === 'none') {
        lane.barrierMode = msg.barrierMode
        lane.barrier = undefined
      }
      const run = lane.adapter.submitTurn({
        input: String(msg.prompt ?? ''),
        requestId: String(msg.requestId ?? ''),
        turnKey: String(msg.turnKey ?? ''),
        modelAuthority: {
          authorityEnvelope: String(msg.authority ?? ''),
          leaseEnvelope: String(msg.lease ?? ''),
          executionDescriptor: msg.executionDescriptor as TurnModelAuthority['executionDescriptor'],
        },
        onEvent: () => {},
        sessionTotals: { totalCostUSD: 0, turns: 0 },
        toolUseIdToName: new Map(),
      })
      lane.activeRun = run
      void run.submitted
        .then(() =>
          emit({ kind: 'turn_submitted', laneId, requestId: String(msg.requestId ?? '') }),
        )
        .catch(() => {})
      try {
        const summary = await run.summary
        await lane.adapter.waitForOutputDrain().catch(() => {})
        return {
          ok: true,
          laneId,
          summary,
          nativeSessionId: lane.nativeSessionId,
          calls: lane.calls,
          files: readdirSync(lane.laneCwd).sort(),
        }
      } finally {
        if (lane.activeRun === run) lane.activeRun = undefined
      }
    }

    if (op === 'release_barrier') {
      const lane = lanes.get(String(msg.laneId ?? ''))
      remotePoolNeed(lane !== undefined, 'VERIFICATION_LANE_NOT_FOUND')
      lane.barrier?.release(Boolean(msg.abort))
      return { ok: true, laneId: lane.laneId }
    }

    if (op === 'interrupt_lane') {
      const lane = lanes.get(String(msg.laneId ?? ''))
      remotePoolNeed(lane !== undefined, 'VERIFICATION_LANE_NOT_FOUND')
      lane.adapter.interrupt('user')
      return { ok: true, laneId: lane.laneId }
    }

    if (op === 'close_lane') {
      return { ok: true, ...(await closeLaneInternal(String(msg.laneId ?? ''))) }
    }

    if (op === 'shutdown_worker') {
      await shutdownAll()
      return { ok: true }
    }

    throw new Error(`VERIFICATION_UNSUPPORTED_OP:${op}`)
  }

  let closed = false
  commissioningLines(
    process.stdin,
    (msg) => {
      if (msg.kind === 'http_res') {
        const waiter = pendingHttp.get(Number(msg.id))
        if (waiter) {
          pendingHttp.delete(Number(msg.id))
          waiter.resolve({ status: Number(msg.status ?? 200), body: String(msg.body ?? '{}') })
        }
        return
      }
      if (msg.kind === 'cmd') {
        const cmdId = String(msg.cmdId ?? '')
        const op = String(msg.op ?? '')
        void handleCommand(msg).then(
          (result) => {
            emit({ kind: 'cmd_ok', cmdId, ...result })
            if (op === 'shutdown_worker') {
              closed = true
              process.exit(0)
            }
          },
          (err) => {
            emit({
              kind: 'cmd_err',
              cmdId,
              error: err instanceof Error ? err.message : String(err),
            })
          },
        )
      }
    },
    () => {
      for (const p of pendingHttp.values()) p.reject(new Error('VERIFICATION_STDIO_CLOSED'))
      pendingHttp.clear()
      if (!closed) {
        closed = true
        void shutdownAll().finally(() => process.exit(1))
      }
    },
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runVerificationWorkerMain().catch((err) => {
    process.stderr.write(
      `VERIFICATION_WORKER_FATAL: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    process.exit(1)
  })
}
