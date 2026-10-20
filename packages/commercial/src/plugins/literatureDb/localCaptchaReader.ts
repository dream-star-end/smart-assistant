/** Fixed offline ddddocr bundle. The process slot is released only after real close. */
import { type ChildProcess, type SpawnOptions, spawn } from 'node:child_process'
import { isAbsolute, join } from 'node:path'
import type { CaptchaReader } from './captcha.js'
import { captchaAnswer } from './captcha.js'
import { LiteratureError, type LiteratureErrorCode } from './errors.js'

// Shared by every operation/reader in this service process; no waiting queue.
let occupied = false
export interface LocalCaptchaReaderOptions {
  bundleRoot: string
  timeoutMs?: number
  /** Trusted composition/test dependency, never accepted from a request. */
  spawnProcess?: (file: string, args: string[], options: SpawnOptions) => ChildProcess
}
export function createLocalCaptchaReader(options: LocalCaptchaReaderOptions): CaptchaReader {
  const timeoutMs = options.timeoutMs ?? 15_000
  if (
    !isAbsolute(options.bundleRoot) ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 15_000
  )
    throw new LiteratureError('INVALID_INPUT')
  const python = join(options.bundleRoot, 'venv/bin/python')
  const runner = join(options.bundleRoot, 'runner.py')
  const spawnProcess = options.spawnProcess ?? spawn
  return {
    provider: 'local-ocr',
    model: 'ddddocr-1.6.1-common-old',
    usageApproved: true,
    drainsOnAbort: true,
    async recognize({ image, signal }) {
      if (signal.aborted) throw new LiteratureError('CANCELLED')
      if (
        image.mediaType !== 'image/png' ||
        !Buffer.isBuffer(image.data) ||
        image.data.length < 1 ||
        image.data.length > 256 * 1024
      )
        throw new LiteratureError('INVALID_INPUT')
      if (occupied) throw new LiteratureError('CAPACITY')
      occupied = true
      let child: ChildProcess
      try {
        child = spawnProcess(python, ['-I', '-B', runner], {
          detached: true,
          shell: false,
          stdio: ['pipe', 'pipe', 'ignore'],
          env: {
            PATH: '/usr/bin:/bin',
            LANG: 'C.UTF-8',
            OMP_NUM_THREADS: '1',
            OPENBLAS_NUM_THREADS: '1',
            MKL_NUM_THREADS: '1',
          },
        })
      } catch {
        occupied = false // A synchronous spawn failure returned no child handle.
        throw new LiteratureError('MODEL_UNAVAILABLE')
      }
      return new Promise<string>((resolve, reject) => {
        let reason: LiteratureErrorCode | undefined
        let closed = false
        let size = 0
        const chunks: Buffer[] = []
        const pixels = Buffer.from(image.data)
        let killTimer: ReturnType<typeof setTimeout> | undefined
        const kill = (kind: NodeJS.Signals) => {
          if (
            closed ||
            child.pid === undefined ||
            child.exitCode !== null ||
            child.signalCode !== null
          )
            return
          try {
            process.kill(-child.pid, kind)
          } catch {
            /* Wait for close, never fake a reap. */
          }
        }
        const stop = (code: LiteratureErrorCode) => {
          reason ??= code
          child.stdin?.destroy()
          kill('SIGTERM')
          killTimer ??= setTimeout(() => kill('SIGKILL'), 100)
        }
        const abort = () => stop('CANCELLED')
        const timer = setTimeout(() => stop('TIMEOUT'), timeoutMs)
        child.on('error', () => {
          reason ??= 'MODEL_UNAVAILABLE'
        })
        child.stdin?.on('error', () => stop('MODEL_UNAVAILABLE'))
        child.stdout?.on('error', () => stop('MODEL_UNAVAILABLE'))
        child.stdout?.on('data', (data: Buffer) => {
          size += data.length
          if (size > 256) {
            stop('MODEL_UNAVAILABLE')
            return
          }
          chunks.push(Buffer.from(data))
        })
        child.once('close', (code) => {
          closed = true
          clearTimeout(timer)
          clearTimeout(killTimer)
          signal.removeEventListener('abort', abort)
          occupied = false
          pixels.fill(0)
          const output = Buffer.concat(chunks)
          for (const chunk of chunks) chunk.fill(0)
          try {
            if (reason) throw new LiteratureError(reason)
            if (code !== 0) throw new LiteratureError('MODEL_UNAVAILABLE')
            const value: unknown = JSON.parse(output.toString('utf8'))
            if (
              !value ||
              typeof value !== 'object' ||
              Array.isArray(value) ||
              Object.keys(value).sort().join(',') !== 'answer,v' ||
              (value as { v: unknown }).v !== 1
            )
              throw new LiteratureError('MODEL_UNAVAILABLE')
            const answer = (value as { answer: unknown }).answer
            const valid = captchaAnswer(answer)
            if (valid !== answer) throw new LiteratureError('MODEL_UNAVAILABLE')
            resolve(valid)
          } catch {
            reject(new LiteratureError(reason ?? 'MODEL_UNAVAILABLE'))
          } finally {
            output.fill(0)
          }
        })
        signal.addEventListener('abort', abort, { once: true })
        if (!child.stdin || !child.stdout) stop('MODEL_UNAVAILABLE')
        else if (signal.aborted) abort()
        else child.stdin.end(pixels)
      })
    },
  }
}
