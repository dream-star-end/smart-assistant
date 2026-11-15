/**
 * Docker stdio NDJSON worker controller for `remote-driver-v4` verification (`OCV5-749`, R12).
 */
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { RemotePoolRelay } from '@openclaude/gateway/remote-pool'
import type { VerificationLaneCloseResult, VerificationTurnResult } from './verificationCases.js'
import { V4_VERIFICATION_WORKER_DIST } from './verificationRuntimeProof.js'
import type { VerificationWorkerController } from './verificationTypes.js'

export async function createDockerWorkerController(input: {
  readonly dockerId: string
  readonly runId: string
  readonly keyring: ReadonlyArray<readonly [string, string]>
  readonly relays: ReadonlyMap<string, RemotePoolRelay>
}): Promise<VerificationWorkerController> {
  const proc: ChildProcessWithoutNullStreams = spawn(
    '/usr/bin/docker',
    [
      'exec',
      '-i',
      '--user',
      '1000',
      input.dockerId,
      '/usr/local/bin/node',
      '--conditions=openclaude-precompiled',
      `/opt/openclaude/${V4_VERIFICATION_WORKER_DIST}`,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  )
  proc.stderr.resume()

  let cmdSeq = 0
  const pendingCmds = new Map<
    string,
    { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }
  >()
  const barrierWaiters = new Map<string, Array<() => void>>()
  const arrivedBarriers = new Set<string>()
  const submittedWaiters = new Map<string, Array<() => void>>()
  const submittedTurns = new Set<string>()
  let workerExited = false

  const failAll = (err: Error) => {
    workerExited = true
    for (const [, p] of pendingCmds) p.reject(err)
    pendingCmds.clear()
  }

  const writeLine = (obj: Record<string, unknown>) => {
    if (!workerExited) proc.stdin.write(`${JSON.stringify(obj)}\n`)
  }

  const rl = createInterface({ input: proc.stdout, crlfDelay: Number.POSITIVE_INFINITY })
  rl.on('line', (line) => {
    if (!line.trim()) return
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(line) as Record<string, unknown>
    } catch {
      return
    }
    if (msg.kind === 'http_req') {
      const id = Number(msg.id)
      const relay = input.relays.get(String(msg.laneId ?? ''))
      if (!relay) {
        writeLine({ kind: 'http_res', id, status: 404, body: '{"ok":false}' })
        return
      }
      void Promise.resolve()
        .then(() =>
          relay.handleControl(
            String(msg.path ?? '/'),
            JSON.parse(String(msg.body ?? '{}')) as Record<string, unknown>,
          ),
        )
        .then(
          (reply) => writeLine({ kind: 'http_res', id, status: 200, body: JSON.stringify(reply) }),
          (err) =>
            writeLine({
              kind: 'http_res',
              id,
              status: 403,
              body: JSON.stringify({
                ok: false,
                error: err instanceof Error ? err.message : 'REMOTE_CONTROL_REJECTED',
              }),
            }),
        )
      return
    }
    if (msg.kind === 'barrier_arrived') {
      const laneId = String(msg.laneId ?? '')
      arrivedBarriers.add(laneId)
      const waiters = barrierWaiters.get(laneId) ?? []
      barrierWaiters.delete(laneId)
      for (const fn of waiters) fn()
      return
    }
    if (msg.kind === 'turn_submitted') {
      const reqId = String(msg.requestId ?? '')
      submittedTurns.add(reqId)
      const waiters = submittedWaiters.get(reqId) ?? []
      submittedWaiters.delete(reqId)
      for (const fn of waiters) fn()
      return
    }
    if (msg.kind === 'cmd_ok' || msg.kind === 'cmd_err') {
      const id = String(msg.cmdId ?? '')
      const waiter = pendingCmds.get(id)
      if (!waiter) return
      pendingCmds.delete(id)
      if (msg.kind === 'cmd_ok') waiter.resolve(msg)
      else waiter.reject(new Error(String(msg.error ?? 'WORKER_CMD_FAILED')))
    }
  })
  proc.once('error', failAll)
  proc.once('close', (code) => {
    if (!workerExited) failAll(new Error(`VERIFICATION_WORKER_EXITED_${String(code ?? 'null')}`))
  })

  const sendCmd = (
    op: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    if (workerExited) return Promise.reject(new Error('VERIFICATION_WORKER_CLOSED'))
    const cmdId = `c${++cmdSeq}`
    return new Promise((resolve, reject) => {
      pendingCmds.set(cmdId, { resolve, reject })
      writeLine({ kind: 'cmd', cmdId, op, ...payload })
    })
  }

  await sendCmd('init', { runId: input.runId, keyring: input.keyring })

  return {
    async openLane(opts) {
      arrivedBarriers.delete(opts.laneId)
      const res = await sendCmd('open_lane', opts)
      return { laneCwd: String(res.laneCwd) }
    },
    startTurn(opts) {
      arrivedBarriers.delete(opts.laneId)
      const waitSubmitted = async () => {
        if (submittedTurns.has(opts.requestId)) return
        await new Promise<void>((res) => {
          const list = submittedWaiters.get(opts.requestId) ?? []
          list.push(res)
          submittedWaiters.set(opts.requestId, list)
        })
      }
      const donePromise = sendCmd('submit_turn', opts).then((res) => ({
        summary: (res.summary as VerificationTurnResult['summary']) ?? null,
        nativeSessionId: res.nativeSessionId ? String(res.nativeSessionId) : null,
        calls: (res.calls as VerificationTurnResult['calls']) ?? [],
        files: (res.files as string[]) ?? [],
        receipts: [],
        requestId: opts.requestId,
      }))
      return { waitSubmitted, waitDone: () => donePromise }
    },
    async waitBarrierArrived(laneId) {
      if (arrivedBarriers.has(laneId)) return
      await new Promise<void>((res) => {
        const list = barrierWaiters.get(laneId) ?? []
        list.push(res)
        barrierWaiters.set(laneId, list)
      })
    },
    async releaseBarrier(laneId, abort) {
      await sendCmd('release_barrier', { laneId, abort })
    },
    async interruptLane(laneId) {
      await sendCmd('interrupt_lane', { laneId })
    },
    async closeLane(laneId) {
      const res = await sendCmd('close_lane', { laneId })
      return {
        calls: (res.calls as VerificationLaneCloseResult['calls']) ?? [],
        nativeSessionId: res.nativeSessionId ? String(res.nativeSessionId) : null,
        proofs: (res.proofs as VerificationLaneCloseResult['proofs']) ?? [],
      }
    },
    async shutdown() {
      if (workerExited) return
      await sendCmd('shutdown_worker', {}).catch(() => {})
      workerExited = true
      rl.close()
      proc.stdin.destroy()
      proc.kill('SIGTERM')
    },
  }
}
