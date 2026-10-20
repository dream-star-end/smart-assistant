/**
 * Detached oc_* children must die when the MCP process does.
 * Run: npx tsx --test packages/mcp-memory/src/__tests__/localCliToolsReap.test.ts
 */
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const source = resolve(dirname(fileURLToPath(import.meta.url)), '../localCliTools.ts')

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

async function readPidFile(file: string, timeoutMs: number): Promise<number> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const text = readFileSync(file, 'utf8').trim()
      if (/^[0-9]+$/.test(text)) return Number(text)
    } catch {
      /* bash has not written $! yet */
    }
    await sleep(20)
  }
  throw new Error(`sleep pid file was not written: ${file}`)
}

async function waitDead(pid: number, timeoutMs: number): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (!pidAlive(pid)) return true
    await sleep(30)
  }
  return !pidAlive(pid)
}

function childScript(pidFile: string, mode: 'signal' | 'exit'): string {
  const command = `sleep 30 & echo $! > '${pidFile.replace(/'/g, `'\\''`)}'; wait`
  return `import { readFileSync } from 'node:fs'
import { runCaptured } from ${JSON.stringify(source)}
const pidFile = ${JSON.stringify(pidFile)}
const mode = ${JSON.stringify(mode)}
void runCaptured({
  bin: '/bin/bash',
  args: ['-lc', ${JSON.stringify(command)}],
  timeoutMs: 60_000,
  maxBytes: 1024,
})
const started = Date.now()
const timer = setInterval(() => {
  let text = ''
  try { text = readFileSync(pidFile, 'utf8').trim() } catch { text = '' }
  if (/^[0-9]+$/.test(text)) {
    clearInterval(timer)
    if (mode === 'exit') process.exit(0)
    return
  }
  if (Date.now() - started > 4_000) {
    clearInterval(timer)
    process.exit(2)
  }
}, 15)
`
}

async function launch(mode: 'signal' | 'exit'): Promise<{
  child: ChildProcess
  sleepPid: number
  dir: string
  stderr: () => string
}> {
  const dir = mkdtempSync(join(tmpdir(), 'oc-reap-'))
  const pidFile = join(dir, 'sleep.pid')
  const script = join(dir, 'child.ts')
  writeFileSync(script, childScript(pidFile, mode))
  const stderrChunks: Buffer[] = []
  const child = spawn(process.execPath, ['--import', 'tsx', script], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: process.env,
  })
  child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk))
  try {
    const sleepPid = await readPidFile(pidFile, 6_000)
    return {
      child,
      sleepPid,
      dir,
      stderr: () => Buffer.concat(stderrChunks).toString('utf8'),
    }
  } catch (err) {
    child.kill('SIGKILL')
    throw new Error(`${(err as Error).message}\n${Buffer.concat(stderrChunks).toString('utf8')}`)
  }
}

describe('oc_* process groups die with the MCP process', () => {
  it('SIGTERM to the node process reaps the detached sleep', { timeout: 9_000 }, async () => {
    const started = Date.now()
    const launched = await launch('signal')
    try {
      assert.equal(pidAlive(launched.sleepPid), true)
      launched.child.kill('SIGTERM')
      const code = await new Promise<number | null>((resolvePromise) => {
        launched.child.once('exit', (status) => resolvePromise(status))
      })
      const dead = await waitDead(launched.sleepPid, 2_000)
      assert.equal(dead, true, `sleep ${launched.sleepPid} still alive; node exit=${code}; ${launched.stderr()}`)
      assert.ok(Date.now() - started < 9_000)
    } finally {
      if (pidAlive(launched.sleepPid)) {
        try { process.kill(launched.sleepPid, 'SIGKILL') } catch { /* gone */ }
      }
      if (launched.child.exitCode === null && launched.child.signalCode === null) {
        launched.child.kill('SIGKILL')
      }
      rmSync(launched.dir, { recursive: true, force: true })
    }
  })

  it('process.exit(0) reaps the detached sleep', { timeout: 9_000 }, async () => {
    const started = Date.now()
    const launched = await launch('exit')
    try {
      const code = await new Promise<number | null>((resolvePromise) => {
        launched.child.once('exit', (status) => resolvePromise(status))
      })
      assert.equal(code, 0, launched.stderr())
      const dead = await waitDead(launched.sleepPid, 2_000)
      assert.equal(dead, true, `sleep ${launched.sleepPid} still alive after process.exit; ${launched.stderr()}`)
      assert.ok(Date.now() - started < 9_000)
    } finally {
      if (pidAlive(launched.sleepPid)) {
        try { process.kill(launched.sleepPid, 'SIGKILL') } catch { /* gone */ }
      }
      if (launched.child.exitCode === null && launched.child.signalCode === null) {
        launched.child.kill('SIGKILL')
      }
      rmSync(launched.dir, { recursive: true, force: true })
    }
  })
})
