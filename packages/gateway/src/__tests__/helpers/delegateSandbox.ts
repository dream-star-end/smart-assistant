import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { after, afterEach, beforeEach } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

type GatewayFixture = {
  sessions?: { submit?: (...args: unknown[]) => Promise<unknown> }
  _releaseHold?: () => void
  _activeDelegations?: number
  _shuttingDown?: boolean
  _delegateReconcileTimer?: ReturnType<typeof setTimeout>
  _delegateReapTimer?: ReturnType<typeof setInterval>
  _notifyRetryTimer?: ReturnType<typeof setTimeout>
  _delegateJobs?: { close(): void }
  _delegateInflightSurface?: { close(): void }
}

const FLAGS = ['SM', 'DURABLE', 'NOTIFIER', 'CUTOVER', 'INFLIGHT_SURFACE'] as const

function fingerprint(dir: string): string {
  const entries: string[] = []
  function walk(path: string): void {
    for (const ent of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(path, ent.name)
      entries.push(`${relative(dir, full)}:${ent.isDirectory() ? 'directory' : 'file'}`)
      if (ent.isDirectory()) walk(full)
      else entries.push(createHash('sha256').update(readFileSync(full)).digest('hex'))
    }
  }
  walk(dir)
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex')
}

// This module MUST be the first import in each fixture. cron.ts and several
// storage modules freeze directories at import time, before beforeEach runs.
const originalEnv = { ...process.env }
const importRoot = mkdtempSync(join(tmpdir(), 'oc-delegate-import-'))
const importHome = join(importRoot, 'forbidden-home')
mkdirSync(importHome)
mkdirSync(join(importRoot, 'state'))
writeFileSync(join(importHome, 'canary'), 'import-time fallback is forbidden\n')
const importFingerprint = fingerprint(importHome)
for (const key of Object.keys(process.env)) {
  if (/^(OC_|OPENCLAUDE_)/.test(key)) delete process.env[key]
}
process.env.HOME = importHome
process.env.OPENCLAUDE_HOME = join(importRoot, 'state')
for (const flag of FLAGS) process.env[`OC_DELEGATE_${flag}`] = '0'

/** One node:test file/process owns this fixture; tests within it are sequential.
 * Capture *all* platform environment keys, not just HOME: production delegate
 * resolvers prefer explicit DB/intent paths over HOME. Never touch real ledgers.
 */
export function installDelegateSandbox() {
  let root = ''
  let forbiddenHome = ''
  let initialFingerprint = ''
  let saved: NodeJS.ProcessEnv = {}
  const gateways = new Set<GatewayFixture>()
  const wrapped = new WeakSet<object>()
  const pending = new Set<Promise<unknown>>()

  after(() => {
    try { assert.equal(fingerprint(importHome), importFingerprint, 'import-time fallback HOME was touched') }
    finally {
      for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key]
      Object.assign(process.env, originalEnv)
      rmSync(importRoot, { recursive: true, force: true })
    }
  })

  beforeEach(() => {
    saved = { ...process.env }
    root = mkdtempSync(join(tmpdir(), 'oc-delegate-sandbox-'))
    forbiddenHome = join(root, 'forbidden-home')
    for (const key of Object.keys(process.env)) {
      if (/^(OC_|OPENCLAUDE_)/.test(key)) delete process.env[key]
    }
    for (const name of ['forbidden-home/.openclaude/runtime', 'state', 'snapshots', 'intents', 'tmp']) {
      mkdirSync(join(root, name), { recursive: true })
    }
    writeFileSync(join(forbiddenHome, '.openclaude', 'canary'), 'not a delegate sandbox\n')
    initialFingerprint = fingerprint(forbiddenHome)
    Object.assign(process.env, {
      HOME: forbiddenHome,
      OPENCLAUDE_HOME: join(root, 'state'),
      OPENCLAUDE_DELEGATE_JOBS_DB: join(root, 'state', 'delegate-jobs.db'),
      OPENCLAUDE_DELEGATE_INFLIGHT_DB: join(root, 'state', 'delegate-inflight-surface.db'),
      OPENCLAUDE_DELEGATE_JOB_SNAPSHOT_DIR: join(root, 'snapshots'),
      OPENCLAUDE_SEND_TO_AGENT_INTENT_DIR: join(root, 'intents'),
      TMPDIR: join(root, 'tmp'),

    })
    for (const flag of FLAGS) process.env[`OC_DELEGATE_${flag}`] = '0'
  })

  afterEach(async () => {
    try {
      // Existing fixtures may return an HTTP job handle while submit is still
      // running. Finish it before changing environment or closing its store.
      for (const gw of gateways) gw._releaseHold?.()
      const deadline = Date.now() + 3_000
      while (pending.size > 0 && Date.now() < deadline) {
        await delay(5)
      }
      assert.equal(pending.size, 0, 'delegate fixture did not quiesce')
      await delay(0)
      assert.equal(fingerprint(forbiddenHome), initialFingerprint, 'delegate test touched fallback HOME (including WAL/SHM or new files)')
    } finally {
      for (const gw of gateways) {
        gw._shuttingDown = true
        clearTimeout(gw._delegateReconcileTimer)
        clearInterval(gw._delegateReapTimer)
        clearTimeout(gw._notifyRetryTimer)
        gw._delegateReconcileTimer = gw._delegateReapTimer = gw._notifyRetryTimer = undefined
        gw._delegateJobs?.close()
        gw._delegateInflightSurface?.close()
        gw._delegateJobs = gw._delegateInflightSurface = undefined
      }
      gateways.clear()
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
      Object.assign(process.env, saved)
      rmSync(root, { recursive: true, force: true })
    }
  })

  return {
    get root() { return root },
    get forbiddenHome() { return forbiddenHome },
    trackGateway<T extends GatewayFixture>(gw: T): T {
      gateways.add(gw)
      const sessions = gw.sessions
      if (sessions?.submit && !wrapped.has(sessions)) {
        wrapped.add(sessions)
        const submit = sessions.submit.bind(sessions)
        sessions.submit = (...args: unknown[]) => {
          const task = Promise.resolve().then(() => submit(...args))
          pending.add(task)
          return task.finally(() => pending.delete(task))
        }
      }
      return gw
    },
    enableAllFlags() {
      for (const flag of FLAGS) process.env[`OC_DELEGATE_${flag}`] = '1'
      process.env.OC_DELEGATE_CALLBACK_OWNER = 'job'
    },
    assertOwnedPath(path: string) {
      const real = realpathSync(path)
      const rel = relative(realpathSync(root), real)
      assert.ok(rel && !rel.startsWith('..') && !rel.startsWith('/'), `path escapes sandbox: ${path}`)
      assert.ok(!resolve(path).startsWith(resolve(forbiddenHome)), `path uses fallback HOME: ${path}`)
    },
    assertHomeUntouched() {
      assert.equal(fingerprint(forbiddenHome), initialFingerprint, 'delegate test touched fallback HOME')
    },
  }
}
