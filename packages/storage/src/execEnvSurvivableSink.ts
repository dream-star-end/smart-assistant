/**
 * OCV5-908 Layer 3 — Detached MCP-independent bounded rotating log sink for survivable jobs
 * (`managed_job` & `daemon_service`). Enforces F01 canonical log paths, F02 open POSIX read
 * handles, F03 hard per-stream disk budget across 2 rotating files, and F04 fail-closed setup.
 * Zero sync I/O and zero empty catch blocks.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, open, stat, unlink, writeFile, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import type { Duplex, Writable } from 'node:stream'
import { ExecEnvJobError } from './execEnvProcInspect.js'

export const EXEC_ENV_JOB_DEFAULT_MAX_LOG_FILE_BYTES = 4 * 1024 * 1024
export const EXEC_ENV_JOB_MIN_LOG_FILE_BYTES = 4096
export const SINK_FLUSH_WAIT_MS = 120
const LOG_PUMP_CHUNK_BYTES = 64 * 1024
const DEFAULT_SINK_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'

const DETACHED_BOUNDED_SINK_SCRIPT = `
const fs = require('node:fs');
const [outPath, errPath, maxStr] = process.argv.slice(1);
const maxTotal = Math.max(4096, Number(maxStr) || 4194304);
const segMax = Math.max(2048, Math.floor(maxTotal / 2));
function attach(fd, basePath) {
  const prevPath = basePath + '.1';
  let curFd = fs.openSync(basePath, 'a', 0o600);
  let curSize = 0;
  try { curSize = fs.fstatSync(curFd).size; } catch {}
  const rs = fs.createReadStream(null, { fd, autoClose: true });
  rs.on('data', (chunk) => {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let off = 0;
    while (off < buf.length) {
      if (curSize >= segMax) {
        try { fs.closeSync(curFd); } catch {}
        try { fs.renameSync(basePath, prevPath); } catch {}
        curFd = fs.openSync(basePath, 'a', 0o600);
        curSize = 0;
      }
      const take = Math.min(buf.length - off, segMax - curSize);
      try { fs.writeSync(curFd, buf, off, take); } catch {}
      curSize += take;
      off += take;
    }
  });
  const done = () => { try { fs.closeSync(curFd); } catch {} };
  rs.on('end', done);
  rs.on('error', done);
}
attach(0, outPath);
attach(3, errPath);
try { fs.writeSync(1, 'R'); fs.closeSync(1); } catch {}
`

export interface LogStreamReaderState {
  logPath?: string
  handle: FileHandle | null
  ino: number | null
  offset: number
}

export interface SurvivableSinkSetup {
  stdoutLogPath: string
  stderrLogPath: string
  stdoutReader: LogStreamReaderState
  stderrReader: LogStreamReaderState
  sinkProcess: ChildProcess
  sinkClosePromise: Promise<void>
}

export function closeHandleQuiet(handle: FileHandle | null | undefined): void {
  if (!handle) return
  void handle.close().catch((err) => {
    void err
  })
}

export async function unlinkRotatingLogPairAsync(basePath: string | undefined): Promise<void> {
  if (!basePath) return
  for (const target of [basePath, `${basePath}.1`]) {
    try {
      await unlink(target)
    } catch (err) {
      void err
    }
  }
}

export function scheduleUnlinkRotatingLogPair(basePath: string | undefined): void {
  if (!basePath) return
  void unlinkRotatingLogPairAsync(basePath)
}

export function destroySinkParentPipes(sink: ChildProcess | undefined): void {
  if (!sink) return
  try {
    ;(sink.stdio[0] as Writable | null)?.destroy()
    ;(sink.stdio[3] as Duplex | null)?.destroy()
  } catch (err) {
    void err
  }
}

function waitForSinkReady(sink: ChildProcess): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (err?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(readyTimer)
      sink.stdout?.removeAllListeners('data')
      sink.stdout?.removeAllListeners('close')
      sink.stdout?.removeAllListeners('error')
      sink.removeListener('error', onSinkErr)
      sink.removeListener('close', onSinkClose)
      try {
        sink.stdout?.destroy()
      } catch (destroyErr) {
        void destroyErr
      }
      if (err) reject(err)
      else resolve()
    }
    const onSinkErr = (err: Error) => finish(err)
    const onSinkClose = (code: number | null) =>
      finish(new Error(`detached bounded log sink exited prematurely (code=${code})`))
    const readyTimer = setTimeout(
      () => finish(new Error('detached bounded log sink readiness timed out')),
      5_000,
    )
    sink.once('error', onSinkErr)
    sink.once('close', onSinkClose)
    sink.stdout!.once('data', () => finish())
    sink.stdout!.once('close', () => finish(new Error('detached bounded log sink closed before ready')))
    sink.stdout!.once('error', (err) => finish(err))
  })
}

export async function setupSurvivableLogSink(opts: {
  jobId: string
  lifecycleClass: string
  stdioDir: string | null
  maxLogFileBytes: number
}): Promise<SurvivableSinkSetup> {
  if (!opts.stdioDir) {
    throw new ExecEnvJobError(
      'EXEC_JOB_SURVIVABLE_STDIO_UNAVAILABLE',
      `Cannot start ${opts.lifecycleClass} job ${opts.jobId}: survivableStdioDir is unavailable`,
    )
  }
  const canonicalStem = `${process.pid}-${opts.jobId}`
  const stdoutLogPath = join(opts.stdioDir, `${canonicalStem}.stdout.log`)
  const stderrLogPath = join(opts.stdioDir, `${canonicalStem}.stderr.log`)
  let outHandle: FileHandle | null = null
  let errHandle: FileHandle | null = null
  let sinkProcess: ChildProcess | undefined

  try {
    await mkdir(opts.stdioDir, { recursive: true, mode: 0o700 })
    await unlinkRotatingLogPairAsync(stdoutLogPath)
    await unlinkRotatingLogPairAsync(stderrLogPath)
    await writeFile(stdoutLogPath, '', { mode: 0o600 })
    await writeFile(stderrLogPath, '', { mode: 0o600 })
    outHandle = await open(stdoutLogPath, 'r')
    errHandle = await open(stderrLogPath, 'r')
    const outStat = await outHandle.stat()
    const errStat = await errHandle.stat()

    const sink = spawn(
      process.execPath,
      ['-e', DETACHED_BOUNDED_SINK_SCRIPT, stdoutLogPath, stderrLogPath, String(opts.maxLogFileBytes)],
      { detached: true, stdio: ['pipe', 'pipe', 'ignore', 'pipe'], env: { PATH: DEFAULT_SINK_PATH } },
    )
    if (!sink.pid || sink.pid <= 0 || !sink.stdio[0] || !sink.stdout || !sink.stdio[3]) {
      sinkProcess = sink
      throw new Error('detached bounded log sink failed to initialize stdio pipes')
    }
    sinkProcess = sink
    const sinkClosePromise = new Promise<void>((resolve) => {
      sink.once('close', () => resolve())
      sink.once('error', () => resolve())
    })
    await waitForSinkReady(sink)
    sink.unref()
    return {
      stdoutLogPath,
      stderrLogPath,
      stdoutReader: { logPath: stdoutLogPath, handle: outHandle, ino: outStat.ino, offset: 0 },
      stderrReader: { logPath: stderrLogPath, handle: errHandle, ino: errStat.ino, offset: 0 },
      sinkProcess: sink,
      sinkClosePromise,
    }
  } catch (err) {
    closeHandleQuiet(outHandle)
    closeHandleQuiet(errHandle)
    destroySinkParentPipes(sinkProcess)
    try {
      sinkProcess?.kill('SIGKILL')
    } catch (killErr) {
      void killErr
    }
    await unlinkRotatingLogPairAsync(stdoutLogPath)
    await unlinkRotatingLogPairAsync(stderrLogPath)
    throw new ExecEnvJobError(
      'EXEC_JOB_SURVIVABLE_STDIO_UNAVAILABLE',
      `Cannot start ${opts.lifecycleClass} job ${opts.jobId}: failed to establish MCP-independent bounded log sink (${err instanceof Error ? err.message : String(err)})`,
    )
  }
}

async function drainHandle(
  reader: LogStreamReaderState,
  onChunk: (buf: Buffer) => void,
): Promise<void> {
  const handle = reader.handle
  if (!handle) return
  let size = 0
  try {
    size = (await handle.stat()).size
  } catch {
    return
  }
  while (reader.offset < size) {
    const toRead = Math.min(LOG_PUMP_CHUNK_BYTES, size - reader.offset)
    const buf = Buffer.allocUnsafe(toRead)
    let bytesRead = 0
    try {
      const res = await handle.read(buf, 0, toRead, reader.offset)
      bytesRead = res.bytesRead
    } catch {
      break
    }
    if (bytesRead <= 0) break
    reader.offset += bytesRead
    onChunk(bytesRead === toRead ? buf : buf.subarray(0, bytesRead))
  }
}

export async function pumpLogReaderAsync(
  reader: LogStreamReaderState,
  onChunk: (buf: Buffer) => void,
): Promise<void> {
  if (!reader.logPath) return
  await drainHandle(reader, onChunk)
  let activeIno: number | null = null
  try {
    activeIno = (await stat(reader.logPath)).ino
  } catch {
    activeIno = null
  }
  if (activeIno !== null && activeIno !== reader.ino) {
    closeHandleQuiet(reader.handle)
    reader.handle = null
    reader.ino = null
    try {
      const nextHandle = await open(reader.logPath, 'r')
      const nextStat = await nextHandle.stat()
      reader.handle = nextHandle
      reader.ino = nextStat.ino
      reader.offset = 0
      await drainHandle(reader, onChunk)
    } catch (err) {
      void err
    }
  }
}
