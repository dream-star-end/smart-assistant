/**
 * Media studio compose sandbox runner (OCV5-588).
 *
 * One-shot ffmpeg/ffprobe containers scheduled by master, isolated like the
 * plugin sandbox (plugins/localSandbox.ts): no network, read-only rootfs, all
 * capabilities dropped, uid 1000, memory/cpu/pids limits, the job's input dir
 * mounted read-only and its output dir read-write, nothing else. The command is
 * an argv array built by spec.ts; nothing goes through a shell.
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  chmod,
  chown,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  statfs,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { type Duplex, Writable } from 'node:stream'

import type Docker from 'dockerode'
import type { Pool } from 'pg'

import { BASENAME_RE, type ComposeOp, SANDBOX_IN, SANDBOX_OUT, buildCommand } from './spec.js'

export const COMPOSE_LABEL = 'com.openclaude.studio.compose'
export const OWNER_LABEL = 'com.openclaude.studio.owner'
export const STARTED_LABEL = 'com.openclaude.studio.started'
const DISK_HEADROOM_BYTES = 1024 * 1024 * 1024
const LOCK_WAIT_MS = 5_000
const KILL_GRACE_MS = 10_000
const STREAM_DRAIN_MS = 5_000
const REMOVE_RETRY_MS = 30_000
const REMOVE_RETRIES = 10

/**
 * Host-wide mutual exclusion for disk reservations across both A/B masters. Production uses a
 * Postgres advisory lock (released by the server if the holding process dies), which replaces a
 * lock file whose takeover and crash windows could not be made safe (Codex code r1 P1-2/3).
 */
export type HostLock = <T>(fn: () => Promise<T>) => Promise<T>

export function pgHostLock(pool: Pool, key = 'oc-studio-compose-disk'): HostLock {
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    const client = await pool.connect()
    try {
      const deadline = Date.now() + LOCK_WAIT_MS
      for (;;) {
        const r = await client.query<{ ok: boolean }>(
          'SELECT pg_try_advisory_lock(hashtext($1)) AS ok',
          [key],
        )
        if (r.rows[0]?.ok) break
        if (Date.now() > deadline)
          throw new ComposeRunnerError('COMPOSE_BUSY', 'compose disk reservation lock is busy')
        await new Promise((res) => setTimeout(res, 50))
      }
      try {
        return await fn()
      } finally {
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key]).catch(() => {})
      }
    } finally {
      client.release()
    }
  }
}

/** Resolves to the promise's value, or to undefined after `ms`. */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      p,
      new Promise<undefined>((res) => {
        timer = setTimeout(() => res(undefined), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Single-process lock for tests and tooling (not cross-process). */
export function inProcessHostLock(): HostLock {
  let chain: Promise<unknown> = Promise.resolve()
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn)
    chain = next.catch(() => {})
    return next
  }
}

/** `<hostname>:<pid>:<starttime>` — starttime (field 22 of /proc/<pid>/stat) guards against pid reuse. */
export function processOwnerToken(pid = process.pid): string {
  return `${hostname()}:${pid}:${procStartTime(pid) ?? '0'}`
}

function procStartTime(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    // comm (field 2) may contain spaces/parens: split after the last ')'.
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return rest[19] ?? null // field 22 overall = index 19 after pid and comm
  } catch {
    return null
  }
}

/**
 * Proven-dead check for an owner token. Only answers "dead" when the owner ran on this host and
 * its pid is gone or now belongs to another process; anything unparsable or remote is treated as
 * alive so a sweeper never removes work it cannot prove abandoned (Codex plan r2 P1-1).
 */
export function isOwnerDead(
  owner: string | undefined,
  procStart: (pid: number) => string | null = procStartTime,
): boolean {
  if (!owner) return false
  const m = /^(.+):(\d+):(\d+)$/.exec(owner)
  if (!m) return false
  if (m[1] !== hostname()) return false
  const now = procStart(Number(m[2]))
  return now === null || now !== m[3]
}
const IMAGE_ID_RE = /^sha256:[0-9a-f]{64}$/
const JOB_ID_RE = /^[a-z0-9][a-z0-9-]{7,63}$/
const MAX_OUTPUT_BYTES = 512 * 1024 * 1024
const MAX_STDOUT_BYTES = 4 * 1024 * 1024
const MAX_STDERR_BYTES = 64 * 1024
const SANDBOX_UID = 1000

export class ComposeRunnerError extends Error {
  constructor(
    readonly code:
      | 'COMPOSE_NOT_CONFIGURED'
      | 'COMPOSE_BUSY'
      | 'COMPOSE_INVALID'
      | 'COMPOSE_FAILED'
      | 'COMPOSE_TIMEOUT'
      | 'COMPOSE_OUTPUT'
      | 'COMPOSE_DISK',
    message: string,
  ) {
    super(message)
    this.name = 'ComposeRunnerError'
  }
}

export type DockerLike = Pick<Docker, 'createContainer' | 'listContainers' | 'getContainer'> & {
  modem: { demuxStream: (stream: NodeJS.ReadableStream, out: Writable, err: Writable) => void }
}

export interface ComposeRunnerOptions {
  docker: DockerLike
  imageId: string | undefined
  root: string
  maxConcurrent?: number
  queueWaitMs?: number
  /** Test seam: chown is skipped when not running as root. */
  chownOutput?: boolean
  /** Test seam: overrides every step timeout. */
  timeoutMsOverride?: number
  /** Host-wide lock for disk reservations (production: pgHostLock). */
  hostLock: HostLock
  /** Owner token stamped on containers and reservations (default: this process). */
  owner?: string
  /** Test seams. */
  now?: () => number
  freeBytes?: (path: string) => Promise<number>
  ownerDead?: (owner: string | undefined) => boolean
  removeRetryMs?: number
  killGraceMs?: number
}

export interface ComposeResult {
  outputs: Array<{ name: string; path: string; bytes: number }>
  stdoutJson?: unknown
}

const MAGIC: Record<string, (b: Buffer) => boolean> = {
  '.png': (b) =>
    b.length >= 8 &&
    b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  '.mp4': (b) => b.length >= 12 && b.subarray(4, 8).toString('latin1') === 'ftyp',
  '.raw': () => true,
}

class Bounded {
  private chunks: Buffer[] = []
  private bytes = 0
  overflow = false
  constructor(private readonly max: number) {}
  push(c: Buffer): void {
    if (this.overflow) return
    if (this.bytes + c.length > this.max) {
      this.overflow = true
      return
    }
    this.chunks.push(c)
    this.bytes += c.length
  }
  text(): string {
    return Buffer.concat(this.chunks).toString('utf8')
  }
}

function sink(b: Bounded): Writable {
  return new Writable({
    write(chunk, _enc, cb) {
      b.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      cb()
    },
  })
}

export class ComposeRunner {
  private active = 0
  private readonly waiters: Array<() => void> = []
  private readonly max: number
  readonly owner: string
  private readonly ownerDead: (owner: string | undefined) => boolean

  constructor(private readonly opts: ComposeRunnerOptions) {
    this.max = Math.max(1, Math.min(8, opts.maxConcurrent ?? 2))
    this.owner = opts.owner ?? processOwnerToken()
    this.ownerDead = opts.ownerDead ?? ((o) => isOwnerDead(o))
  }

  configured(): boolean {
    return typeof this.opts.imageId === 'string' && IMAGE_ID_RE.test(this.opts.imageId)
  }

  jobDir(jobId: string): { dir: string; inDir: string; outDir: string } {
    if (!JOB_ID_RE.test(jobId))
      throw new ComposeRunnerError('COMPOSE_INVALID', 'invalid compose job id')
    const dir = join(this.opts.root, 'work', jobId)
    return { dir, inDir: join(dir, 'in'), outDir: join(dir, 'out') }
  }

  /** Create the job's in/ and out/ directories. Callers then place inputs into in/. */
  async prepare(jobId: string): Promise<{ inDir: string; outDir: string }> {
    const { inDir, outDir } = this.jobDir(jobId)
    // The container runs as uid 1000: in/ must be traversable and its files readable (code r1 P1-1).
    await mkdir(inDir, { recursive: true, mode: 0o755 })
    await chmod(inDir, 0o755)
    await rm(outDir, { recursive: true, force: true })
    await mkdir(outDir, { recursive: false, mode: 0o700 })
    if (this.opts.chownOutput ?? process.getuid?.() === 0)
      await chown(outDir, SANDBOX_UID, SANDBOX_UID)
    await chmod(outDir, 0o700)
    return { inDir, outDir }
  }

  async cleanup(jobId: string): Promise<void> {
    await rm(this.jobDir(jobId).dir, { recursive: true, force: true })
  }

  /**
   * Remove abandoned one-shot containers. A container is removed only when it is no longer running
   * or its owner process is proven dead on this host; the other A/B master's live work is never
   * touched, and no wall-clock age is involved (Codex plan r1/r2 P1-1).
   */
  async sweepStale(): Promise<number> {
    const list = await this.opts.docker.listContainers({
      all: true,
      filters: { label: [`${COMPOSE_LABEL}=1`] },
    })
    let n = 0
    for (const c of list) {
      const labels = (c.Labels ?? {}) as Record<string, string>
      // Only a stopped container (exited/dead) is safe without an owner check; created, restarting
      // and paused containers may run at any moment (plan r3 P1-1).
      const stopped = c.State === 'exited' || c.State === 'dead'
      if (!stopped && !this.ownerDead(labels[OWNER_LABEL])) continue
      await this.opts.docker
        .getContainer(c.Id)
        .remove({ force: true })
        .catch(() => {})
      n += 1
    }
    return n
  }

  /** Force-remove every compose container of a (dead) owner; true when none remain. */
  private async removeOwnerContainers(owner: string): Promise<boolean> {
    const filters = { label: [`${COMPOSE_LABEL}=1`, `${OWNER_LABEL}=${owner}`] }
    for (const c of await this.opts.docker.listContainers({ all: true, filters })) {
      await this.opts.docker
        .getContainer(c.Id)
        .remove({ force: true })
        .catch(() => {})
    }
    return (await this.opts.docker.listContainers({ all: true, filters })).length === 0
  }

  private reservationsDir(): string {
    return join(this.opts.root, 'reservations')
  }

  /**
   * Cross-process disk reservation (Codex plan r2 P1-2): under one host-wide lock, free space minus
   * the bytes reserved by every live in-flight job must cover this step's -fs cap plus headroom.
   * Every ffmpeg output carries -fs, so a running job never writes more than it reserved.
   */
  private async reserveDisk(jobId: string, bytes: number): Promise<() => Promise<void>> {
    if (bytes <= 0) return async () => {}
    const file = join(this.reservationsDir(), `${jobId}-${randomUUID().slice(0, 8)}.json`)
    await mkdir(this.reservationsDir(), { recursive: true, mode: 0o700 })
    await this.opts.hostLock(async () => {
      let reserved = 0
      for (const name of await readdir(this.reservationsDir())) {
        if (!name.endsWith('.json')) continue
        const path = join(this.reservationsDir(), name)
        let r: { bytes?: number; owner?: string }
        try {
          r = JSON.parse(await readFile(path, 'utf8')) as { bytes?: number; owner?: string }
        } catch {
          // Unreadable: count it conservatively as the largest possible step.
          reserved += MAX_OUTPUT_BYTES
          continue
        }
        // A dead owner's containers may still be writing: remove them first, and drop the
        // reservation only once none remain. Any Docker error keeps it counted (code r1 P1-4).
        if (this.ownerDead(r.owner)) {
          let gone = false
          try {
            gone = await this.removeOwnerContainers(r.owner!)
          } catch {
            gone = false
          }
          if (gone) {
            await unlink(path).catch(() => {})
            continue
          }
        }
        reserved += Number(r.bytes) || MAX_OUTPUT_BYTES
      }
      const free = this.opts.freeBytes
        ? await this.opts.freeBytes(this.opts.root)
        : await statfs(this.opts.root).then((st) => st.bavail * st.bsize)
      if (free - reserved < bytes + DISK_HEADROOM_BYTES) {
        throw new ComposeRunnerError('COMPOSE_DISK', 'not enough free disk for this compose step')
      }
      await writeFile(file, JSON.stringify({ bytes, owner: this.owner, jobId }), {
        mode: 0o600,
        flag: 'wx',
      })
    })
    return async () => {
      await unlink(file).catch(() => {})
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active += 1
      return
    }
    const waitMs = this.opts.queueWaitMs ?? 10 * 60_000
    await new Promise<void>((resolve, reject) => {
      const grant = () => {
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(grant)
        if (i >= 0) this.waiters.splice(i, 1)
        reject(new ComposeRunnerError('COMPOSE_BUSY', 'compose sandbox queue wait exceeded'))
      }, waitMs)
      this.waiters.push(grant)
    })
  }

  private release(): void {
    const next = this.waiters.shift()
    if (next) next()
    else this.active = Math.max(0, this.active - 1)
  }

  async run(jobId: string, op: ComposeOp): Promise<ComposeResult> {
    if (!this.configured())
      throw new ComposeRunnerError(
        'COMPOSE_NOT_CONFIGURED',
        'compose sandbox image is not configured',
      )
    const cmd = buildCommand(op)
    const { inDir, outDir } = this.jobDir(jobId)
    await this.assertInputs(inDir)
    const releaseDisk = await this.reserveDisk(jobId, cmd.maxOutputBytes)
    try {
      await this.acquire()
    } catch (err) {
      await releaseDisk()
      throw err
    }
    let container: Docker.Container | null = null
    let stream: Duplex | null = null
    try {
      container = await this.opts.docker.createContainer({
        name: `oc-v5-studio-compose-${jobId}-${randomUUID().slice(0, 8)}`,
        Image: this.opts.imageId!,
        User: `${SANDBOX_UID}:${SANDBOX_UID}`,
        WorkingDir: '/work',
        Env: ['PATH=/usr/local/bin:/usr/bin:/bin', 'LANG=C.UTF-8', 'HOME=/tmp'],
        Entrypoint: [],
        Cmd: cmd.argv,
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
        NetworkDisabled: true,
        Healthcheck: { Test: ['NONE'] },
        Labels: {
          [COMPOSE_LABEL]: '1',
          [OWNER_LABEL]: this.owner,
          [STARTED_LABEL]: String(Math.floor((this.opts.now ?? Date.now)() / 1000)),
          'com.openclaude.studio.job': jobId,
        },
        HostConfig: {
          NetworkMode: 'none',
          ReadonlyRootfs: true,
          CapDrop: ['ALL'],
          CapAdd: [],
          SecurityOpt: ['no-new-privileges'],
          Privileged: false,
          Memory: 2 * 1024 * 1024 * 1024,
          MemorySwap: 2 * 1024 * 1024 * 1024,
          MemorySwappiness: 0,
          NanoCpus: 2_000_000_000,
          PidsLimit: 256,
          Tmpfs: { '/tmp': 'rw,nosuid,nodev,noexec,size=268435456,mode=0700,uid=1000,gid=1000' },
          Mounts: [
            {
              Type: 'bind',
              Source: inDir,
              Target: SANDBOX_IN,
              ReadOnly: true,
              BindOptions: { Propagation: 'rprivate' },
            },
            {
              Type: 'bind',
              Source: outDir,
              Target: SANDBOX_OUT,
              ReadOnly: false,
              BindOptions: { Propagation: 'rprivate' },
            },
          ],
          RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
          LogConfig: { Type: 'none', Config: {} },
          AutoRemove: false,
          ShmSize: 64 * 1024 * 1024,
        },
      })
      stream = (await container.attach({ stream: true, stdout: true, stderr: true })) as Duplex
      const stdout = new Bounded(MAX_STDOUT_BYTES)
      const stderr = new Bounded(MAX_STDERR_BYTES)
      this.opts.docker.modem.demuxStream(stream, sink(stdout), sink(stderr))
      const streamEnded = new Promise<void>((resolveEnd) => {
        stream?.once('end', () => resolveEnd())
        stream?.once('close', () => resolveEnd())
        stream?.once('error', () => resolveEnd())
      })
      await container.start()
      const timeoutMs = this.opts.timeoutMsOverride ?? cmd.timeoutMs
      const waited = container.wait().then(
        (r) => ({ status: (r as { StatusCode?: number }).StatusCode ?? -1 }),
        () => ({ status: -1 }),
      )
      // The timeout must end the wait even if kill() fails or wait() never settles (code r1 P1-6).
      let timer: NodeJS.Timeout | undefined
      const outcome = await Promise.race([
        waited,
        new Promise<'timeout'>((res) => {
          timer = setTimeout(() => res('timeout'), timeoutMs)
        }),
      ])
      clearTimeout(timer)
      if (outcome === 'timeout') {
        // kill() itself may hang: bound it by the grace period too (code r2 P1-1).
        const grace = this.opts.killGraceMs ?? KILL_GRACE_MS
        await withTimeout(
          container.kill().catch(() => {}),
          grace,
        )
        await Promise.race([
          waited,
          new Promise((res) => setTimeout(res, this.opts.killGraceMs ?? KILL_GRACE_MS)),
        ])
        throw new ComposeRunnerError('COMPOSE_TIMEOUT', `compose step exceeded ${timeoutMs} ms`)
      }
      const status = outcome.status
      // stdout may arrive after wait() resolves on its own connection (code r1 P1-8).
      await Promise.race([streamEnded, new Promise((res) => setTimeout(res, STREAM_DRAIN_MS))])
      if (status !== 0) {
        throw new ComposeRunnerError(
          'COMPOSE_FAILED',
          `ffmpeg exited ${status}: ${stderr.text().slice(0, 2000)}`,
        )
      }
      if (stdout.overflow)
        throw new ComposeRunnerError('COMPOSE_OUTPUT', 'compose stdout exceeded limit')
      const outputs = await this.collectOutputs(outDir, cmd.outputs, cmd.perFileCapBytes)
      if (cmd.stdoutJson) {
        try {
          return { outputs, stdoutJson: JSON.parse(stdout.text()) }
        } catch {
          throw new ComposeRunnerError('COMPOSE_OUTPUT', 'ffprobe did not return JSON')
        }
      }
      return { outputs }
    } finally {
      stream?.destroy()
      // The concurrency slot and the disk reservation are released only once the container is
      // confirmed removed, so stuck containers can never exceed the concurrency cap (code r2 P1-2).
      if (container) void this.retireContainer(container, releaseDisk)
      else {
        this.release()
        await releaseDisk()
      }
    }
  }

  /** Remove the container (retrying) and only then release its disk reservation. */
  private async retireContainer(
    container: Docker.Container,
    releaseDisk: () => Promise<void>,
  ): Promise<void> {
    const done = async () => {
      this.release()
      await releaseDisk()
    }
    for (let attempt = 0; attempt <= REMOVE_RETRIES; attempt++) {
      try {
        // remove() may hang on a wedged daemon: bound each attempt.
        const removed = await withTimeout(
          container.remove({ force: true }).then(() => true),
          this.opts.killGraceMs ?? KILL_GRACE_MS,
        )
        if (removed === true) {
          await done()
          return
        }
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode
        if (status === 404) {
          await done()
          return
        }
      }
      if (attempt < REMOVE_RETRIES)
        await new Promise((res) => setTimeout(res, this.opts.removeRetryMs ?? REMOVE_RETRY_MS))
    }
    // Still not removable: keep the slot and the reservation held (fail safe); a later restart
    // (new owner) lets sweepStale retire the container and frees both.
  }

  private async assertInputs(inDir: string): Promise<void> {
    let names: string[]
    try {
      names = await readdir(inDir)
    } catch {
      throw new ComposeRunnerError(
        'COMPOSE_INVALID',
        'compose job inputs are missing; call prepare() first',
      )
    }
    for (const name of names) {
      if (!BASENAME_RE.test(name))
        throw new ComposeRunnerError('COMPOSE_INVALID', 'unexpected input file name')
      const st = await lstat(join(inDir, name))
      if (!st.isFile())
        throw new ComposeRunnerError(
          'COMPOSE_INVALID',
          'compose inputs must be regular files (no links or directories)',
        )
      if ((st.mode & 0o044) !== 0o044) await chmod(join(inDir, name), 0o644)
    }
  }

  private async collectOutputs(
    outDir: string,
    expected: string[],
    perFileCap: number,
  ): Promise<ComposeResult['outputs']> {
    const present = new Set(await readdir(outDir))
    const out: ComposeResult['outputs'] = []
    for (const name of expected) {
      if (!present.has(name))
        throw new ComposeRunnerError('COMPOSE_OUTPUT', `missing output ${name}`)
      const path = join(outDir, name)
      const st = await lstat(path)
      if (!st.isFile())
        throw new ComposeRunnerError('COMPOSE_OUTPUT', `output ${name} is not a regular file`)
      if (st.size === 0 || st.size > MAX_OUTPUT_BYTES)
        throw new ComposeRunnerError('COMPOSE_OUTPUT', `output ${name} has invalid size`)
      // ffmpeg -fs stops at the cap; an output that reached it was truncated.
      const cap = perFileCap > 0 ? Math.min(perFileCap, MAX_OUTPUT_BYTES) : MAX_OUTPUT_BYTES
      if (perFileCap > 0 && st.size >= cap * 0.99) {
        throw new ComposeRunnerError(
          'COMPOSE_OUTPUT',
          `output ${name} hit the size cap and was truncated`,
        )
      }
      const ext = name.slice(name.lastIndexOf('.'))
      const check = MAGIC[ext]
      if (!check) throw new ComposeRunnerError('COMPOSE_OUTPUT', `unexpected output type ${ext}`)
      const fh = await open(path, 'r')
      const head = Buffer.alloc(16)
      try {
        await fh.read(head, 0, 16, 0)
      } finally {
        await fh.close()
      }
      if (!check(head))
        throw new ComposeRunnerError('COMPOSE_OUTPUT', `output ${name} failed the magic check`)
      out.push({ name, path, bytes: st.size })
    }
    return out
  }
}
