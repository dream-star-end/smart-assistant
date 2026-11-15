/**
 * Helper primitives for the container-side `remote-driver-v4` verification worker
 * (`OCV5-749`, R12): barrier controller, `stopped.json` proof reader, `Write`-only
 * filtered `Cc5ToolHost` factory, and relay HTTP-over-stdio proxy server.
 */
import { lstatSync, readFileSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { Cc5HostProfile } from '../cc5ToolCatalog.js'
import { Cc5ToolHost } from '../cc5ToolHost.js'
import type { EngineTurnRun } from '../engine/engineAdapter.js'
import type { RemoteEngineAdapter } from './remoteEngineAdapter.js'
import { remotePoolNeed } from './types.js'

export interface PendingHttpCall {
  readonly resolve: (reply: { status: number; body: string }) => void
  readonly reject: (err: Error) => void
}

export interface ExecutedToolCall {
  readonly name: string
  readonly filePath: string
  readonly content: string
  readonly isError: boolean
}

export interface BarrierController {
  readonly arrived: Promise<void>
  resolveArrived(): void
  waitRelease(): Promise<{ abort: boolean }>
  release(abort: boolean): void
}

export function createBarrierController(): BarrierController {
  let resolveArrived!: () => void
  let resolveRelease!: (val: { abort: boolean }) => void
  let arrivedDone = false
  let released = false
  const arrived = new Promise<void>((res) => {
    resolveArrived = res
  })
  const releasePromise = new Promise<{ abort: boolean }>((res) => {
    resolveRelease = res
  })
  return {
    arrived,
    resolveArrived: () => {
      if (!arrivedDone) {
        arrivedDone = true
        resolveArrived()
      }
    },
    waitRelease: () => releasePromise,
    release: (abort: boolean) => {
      if (!released) {
        released = true
        resolveRelease({ abort })
      }
    },
  }
}

export interface WorkerLaneState {
  readonly laneId: string
  readonly laneDir: string
  readonly laneCwd: string
  readonly sockPath: string
  readonly server: Server
  adapter: RemoteEngineAdapter
  readonly calls: ExecutedToolCall[]
  readonly lifecycles: Array<{ root: string; lifecycleId: string }>
  barrierMode: 'none' | 'hold_until_release'
  barrier?: BarrierController
  activeRun?: EngineTurnRun
  nativeSessionId: string | null
  closed: boolean
}

export function verifySafeSubpath(baseDir: string, rawPath: unknown): string {
  remotePoolNeed(
    typeof rawPath === 'string' && rawPath.trim().length > 0,
    'VERIFICATION_PATH_INVALID',
  )
  const candidate = resolve(baseDir, rawPath)
  const rel = relative(baseDir, candidate)
  remotePoolNeed(
    rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel),
    'VERIFICATION_PATH_OUTSIDE_LANE',
  )
  return candidate
}

export function readStoppedProof(root: string, lifecycleId: string): Record<string, unknown> {
  const proofPath = join(root, 'stopped.json')
  const st = lstatSync(proofPath)
  remotePoolNeed(
    st.isFile() &&
      !st.isSymbolicLink() &&
      st.uid === process.getuid?.() &&
      st.nlink === 1 &&
      (st.mode & 0o077) === 0 &&
      st.size <= 4096,
    'VERIFICATION_STOP_PROOF_UNSAFE',
  )
  const proof = JSON.parse(readFileSync(proofPath, 'utf8')) as Record<string, unknown>
  remotePoolNeed(
    proof.version === 1 &&
      proof.lifecycleId === lifecycleId &&
      typeof proof.supervisorPid === 'number' &&
      proof.localStopped === true,
    'VERIFICATION_STOP_PROOF_INVALID',
  )
  return proof
}

export function createRelayProxyServer(input: {
  readonly laneId: string
  readonly pendingHttp: Map<number, PendingHttpCall>
  readonly nextHttpId: () => number
  readonly emit: (frame: Record<string, unknown>) => void
}): Server {
  return createServer(async (req, res) => {
    try {
      remotePoolNeed(
        req.method === 'POST' && input.pendingHttp.size < 16,
        'VERIFICATION_HTTP_OVERFLOW',
      )
      const chunks: Buffer[] = []
      let bytes = 0
      for await (const chunk of req) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        bytes += buf.length
        remotePoolNeed(bytes <= 4 * 1024 * 1024, 'VERIFICATION_HTTP_BODY_TOO_LARGE')
        chunks.push(buf)
      }
      const id = input.nextHttpId()
      const bodyStr = Buffer.concat(chunks).toString('utf8')
      const reply = await new Promise<{ status: number; body: string }>((resolveReq, rejectReq) => {
        input.pendingHttp.set(id, { resolve: resolveReq, reject: rejectReq })
        input.emit({
          kind: 'http_req',
          id,
          laneId: input.laneId,
          path: req.url ?? '/',
          body: bodyStr,
        })
      })
      res.writeHead(reply.status, { 'content-type': 'application/json' })
      res.end(reply.body)
    } catch {
      if (!res.headersSent) {
        res.writeHead(503, { 'content-type': 'application/json' })
      }
      res.end('{}')
    }
  })
}

export function createVerificationHostFactory(input: {
  readonly laneId: string
  readonly laneDir: string
  readonly laneState: Partial<WorkerLaneState>
  readonly calls: ExecutedToolCall[]
  readonly lifecycles: Array<{ root: string; lifecycleId: string }>
  readonly emit: (frame: Record<string, unknown>) => void
}) {
  return (root: string, lifecycleId: string, profile: Cc5HostProfile, env: NodeJS.ProcessEnv) => {
    const inner = new Cc5ToolHost(
      root,
      lifecycleId,
      { ...profile, mcpConfigPath: null, settingsPath: null },
      async () => {
        throw new Error('VERIFICATION_PERMISSION_DENIED')
      },
      env,
    )
    return {
      tools: async () => {
        const tools = (await inner.tools()).filter((t) => t.name === 'Write')
        remotePoolNeed(tools.length === 1, 'VERIFICATION_WRITE_TOOL_MISSING')
        return tools
      },
      execute: async (name: string, args: Record<string, unknown>, identity: unknown) => {
        remotePoolNeed(name === 'Write', 'VERIFICATION_TOOL_FORBIDDEN')
        const targetPath = verifySafeSubpath(input.laneDir, args.file_path)
        if (input.laneState.barrierMode === 'hold_until_release') {
          const barrier = input.laneState.barrier ?? createBarrierController()
          input.laneState.barrier = barrier
          barrier.resolveArrived()
          input.emit({ kind: 'barrier_arrived', laneId: input.laneId })
          const rel = await barrier.waitRelease()
          if (rel.abort) {
            return {
              content: [{ type: 'text', text: 'VERIFICATION_BARRIER_ABORTED' }],
              isError: true,
            }
          }
        }
        const res = await inner.execute(name, args, identity as never)
        input.calls.push({
          name,
          filePath: targetPath,
          content: typeof args.content === 'string' ? args.content : '',
          isError: Boolean(res.isError),
        })
        return res
      },
      close: async () => {
        await inner.close()
        input.lifecycles.push({ root, lifecycleId })
      },
    }
  }
}
