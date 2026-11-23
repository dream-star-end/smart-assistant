/**
 * Unit tests for `oc_bash` disk in-flight job snapshots (OCV5-844).
 * Run: npx tsx --test packages/mcp-memory/src/__tests__/ocBashSnapshot.test.ts
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  hasAliveVerifiedGroupMembers,
  OcBashJobManager,
  parseProcStatStartTimeTicks,
  resolveOcBashRegistryDir,
  resolveOcBashSessionIdentity,
  sanitizeOcBashCommandPreview,
  type OcBashJobSnapshot,
} from '../ocBashJobManager.js'

describe('ocBashJobManager disk snapshots (OCV5-844)', () => {
  it('parses Linux /proc/<pid>/stat field 22 even when comm contains spaces and parentheses', () => {
    const stat =
      '4242 (node (oc bash)) S 1 4242 4242 0 -1 4194304 100 0 0 0 10 2 0 0 20 0 4 0 987654321 100000 500 18446744073709551615'
    assert.equal(parseProcStatStartTimeTicks(stat), 987654321)
    assert.equal(parseProcStatStartTimeTicks('malformed'), null)
    assert.equal(parseProcStatStartTimeTicks('42 (cmd) S 1 2 3'), null)
  })

  it('sanitizes command preview to single-line redacted <= 240 chars', () => {
    const raw =
      'curl -H "Authorization: Bearer supersecret_token_12345" \\\n  https://alice:hunter2@example.com/api?k=1 \\\n  API_KEY=sk-abcdefghijklmnop ' +
      'x'.repeat(300)
    const preview = sanitizeOcBashCommandPreview(raw)
    assert.equal(preview.includes('\n'), false)
    assert.equal(preview.includes('supersecret_token_12345'), false)
    assert.equal(preview.includes('hunter2'), false)
    assert.equal(preview.includes('sk-abcdefghijklmnop'), false)
    assert.ok(preview.includes('[REDACTED]'))
    assert.ok(preview.length <= 240)
  })

  it('resolves registry dir and session identity from env with expected fallback order', () => {
    assert.equal(
      resolveOcBashRegistryDir({ OC_BASH_REGISTRY_DIR: '/custom/reg' }),
      '/custom/reg',
    )
    assert.equal(
      resolveOcBashRegistryDir({ OPENCLAUDE_STATE_DIR: '/state/dir' }),
      '/state/dir/run/oc-bash-jobs',
    )
    assert.equal(
      resolveOcBashRegistryDir({ OPENCLAUDE_RUNTIME_DIR: '/rt/dir' }),
      '/rt/dir/run/oc-bash-jobs',
    )
    assert.deepEqual(
      resolveOcBashSessionIdentity({ OC_SESSION_KEY: 'agent:main:webchat:dm:sess_abc123' }),
      { sessionKey: 'agent:main:webchat:dm:sess_abc123', sessionId: 'sess_abc123' },
    )
    assert.deepEqual(
      resolveOcBashSessionIdentity({ OPENCLAUDE_SESSION_KEY: 'agent:main:webchat:dm:sess_fallback' }),
      { sessionKey: 'agent:main:webchat:dm:sess_fallback', sessionId: 'sess_fallback' },
    )
  })

  it('writes atomic snapshot on soft-yield and cleans up on explicit kill', async () => {
    const regDir = mkdtempSync(join(tmpdir(), 'oc-bash-snap-kill-'))
    const mgr = new OcBashJobManager({
      registryDir: regDir,
      sessionKey: 'agent:main:webchat:dm:sess_kill_01',
      killGraceMs: 100,
    })
    try {
      const outcome = await mgr.startAndWait({
        command: 'sleep 30',
        cwd: tmpdir(),
        timeoutMs: 150,
      })
      assert.equal(outcome.kind, 'running')
      const files = readdirSync(regDir).filter((f) => f.endsWith('.json'))
      assert.equal(files.length, 1)
      assert.equal(files[0], `${process.pid}-${outcome.jobId}.json`)
      const snap = JSON.parse(readFileSync(join(regDir, files[0]!), 'utf8')) as OcBashJobSnapshot
      assert.equal(snap.id, `${process.pid}-${outcome.jobId}`)
      assert.equal(snap.jobId, outcome.jobId)
      assert.equal(snap.ownerPid, process.pid)
      assert.ok(snap.pid > 1)
      assert.equal(snap.pgid, snap.pid)
      assert.equal(snap.sessionKey, 'agent:main:webchat:dm:sess_kill_01')
      assert.equal(snap.sessionId, 'sess_kill_01')
      assert.equal(snap.commandPreview, 'sleep 30')
      assert.equal(snap.cwd, tmpdir())
      assert.ok(snap.maxLifetimeAt > snap.startedAt)
      if (process.platform === 'linux') {
        assert.equal(typeof snap.startTimeTicks, 'number')
      }

      const killed = await mgr.continueJob({
        jobId: outcome.jobId,
        action: 'kill',
        timeoutMs: 1000,
      })
      assert.equal(killed.kind, 'killed')
      assert.equal(existsSync(join(regDir, files[0]!)), false, 'snapshot removed on kill')
    } finally {
      mgr.disposeAll()
      rmSync(regDir, { recursive: true, force: true })
    }
  })

  it('cleans up snapshot on normal exit, idle_timeout, max_lifetime, and disposeAll', async () => {
    const regDir = mkdtempSync(join(tmpdir(), 'oc-bash-snap-exits-'))
    try {
      // 1. Normal fast completion
      const m1 = new OcBashJobManager({ registryDir: regDir, sessionKey: 'a:b:s1' })
      const done = await m1.startAndWait({ command: 'echo hi', timeoutMs: 2000 })
      assert.equal(done.kind, 'finished')
      assert.deepEqual(readdirSync(regDir), [])
      m1.disposeAll()

      // 2. idle_timeout
      const m2 = new OcBashJobManager({
        registryDir: regDir,
        sessionKey: 'a:b:s2',
        idleJobTtlMs: 120,
        killGraceMs: 50,
      })
      const r2 = await m2.startAndWait({ command: 'sleep 30', timeoutMs: 80 })
      assert.equal(r2.kind, 'running')
      assert.equal(readdirSync(regDir).length, 1)
      await new Promise((r) => setTimeout(r, 450))
      assert.deepEqual(readdirSync(regDir), [], 'snapshot removed after idle_timeout')
      m2.disposeAll()

      // 3. max_lifetime
      const m3 = new OcBashJobManager({
        registryDir: regDir,
        sessionKey: 'a:b:s3',
        maxJobLifetimeMs: 150,
        killGraceMs: 50,
      })
      const r3 = await m3.startAndWait({ command: 'sleep 30', timeoutMs: 60 })
      assert.equal(r3.kind, 'running')
      assert.equal(readdirSync(regDir).length, 1)
      await new Promise((r) => setTimeout(r, 450))
      assert.deepEqual(readdirSync(regDir), [], 'snapshot removed after max_lifetime')
      m3.disposeAll()

      // 4. disposeAll
      const m4 = new OcBashJobManager({ registryDir: regDir, sessionKey: 'a:b:s4' })
      const r4 = await m4.startAndWait({ command: 'sleep 30', timeoutMs: 80 })
      assert.equal(r4.kind, 'running')
      assert.equal(readdirSync(regDir).length, 1)
      m4.disposeAll()
      assert.deepEqual(readdirSync(regDir), [], 'snapshot removed on disposeAll')
    } finally {
      rmSync(regDir, { recursive: true, force: true })
    }
  })

  it('fails open when registryDir is unwritable without breaking oc_bash', async () => {
    const mgr = new OcBashJobManager({
      registryDir: '/dev/null/not-a-directory',
      sessionKey: 'agent:main:webchat:dm:sess_failopen',
    })
    try {
      const outcome = await mgr.startAndWait({ command: 'echo still-works', timeoutMs: 2000 })
      assert.equal(outcome.kind, 'finished')
      assert.equal(outcome.exitCode, 0)
      assert.match(outcome.stdout, /still-works/)
    } finally {
      mgr.disposeAll()
    }
  })

  it('retains disk snapshot when shell leader exits while a backgrounded child in the same pgrp stays alive', async () => {
    if (process.platform !== 'linux') return
    const regDir = mkdtempSync(join(tmpdir(), 'oc-bash-snap-orphan-'))
    const mgr = new OcBashJobManager({
      registryDir: regDir,
      sessionKey: 'agent:main:webchat:dm:sess_orphan',
    })
    let childPid = 0
    try {
      // Spawn detached background child that closes stdio so shell leader exits immediately while child stays in same pgrp.
      const outcome = await mgr.startAndWait({
        command: 'sleep 20 </dev/null >/dev/null 2>&1 & echo $!',
        timeoutMs: 3000,
      })
      assert.equal(outcome.kind, 'finished')
      childPid = Number(outcome.stdout.trim())
      assert.ok(Number.isInteger(childPid) && childPid > 1)
      const files = readdirSync(regDir).filter((f) => f.endsWith('.json'))
      assert.equal(files.length, 1, 'snapshot must remain while verified group member is still alive')
    } finally {
      if (childPid > 1) {
        try {
          process.kill(childPid, 'SIGKILL')
        } catch {
          /* already exited */
        }
      }
      mgr.disposeAll()
      rmSync(regDir, { recursive: true, force: true })
    }
  })

  it('short-circuits hasAliveVerifiedGroupMembers via process.kill(-pgid, 0) ESRCH for dead groups', () => {
    if (process.platform !== 'linux') return
    // PID 99999999 does not exist on Linux (pid_max <= 4194304), so kill(-pgid, 0) yields ESRCH.
    assert.equal(hasAliveVerifiedGroupMembers(99_999_999, 0), false)
  })
})
