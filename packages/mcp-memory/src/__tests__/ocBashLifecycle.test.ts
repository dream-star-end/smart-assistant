/**
 * Unit & live-process tests for Wave 3 P2-1 (`ExecEnvJobRegistry`-backed `OcBashJobManager`
 * lifecycle classes + R1 audit blocker fixes B06, B07, B08, W02, W03, W04).
 *
 * Run: npx tsx --test packages/mcp-memory/src/__tests__/ocBashLifecycle.test.ts
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  ExecEnvJobRegistry,
  hasAliveVerifiedProcessGroup,
  hasAliveVerifiedProcessGroupAsync,
  readProcStartTimeTicksAsync,
  sendVerifiedGroupSignal,
  sendVerifiedGroupSignalAsync,
} from '@openclaude/storage'
import { handleOcBash } from '../localCliTools.js'
import { OcBashJobManager, type OcBashJobSnapshot } from '../ocBashJobManager.js'

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]
      return state !== 'Z' && state !== 'X' && state !== 'x'
    } catch {
      return false
    }
  }
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function killPidBestEffort(pid: number | undefined): void {
  if (!pid || pid <= 1) return
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }
}

describe('OcBashJobManager Layer 3 lifecycle governance (OCV5-908 P2-1)', () => {
  it('validates lifecycle_class input in handleOcBash and rejects invalid or resume-time values', async () => {
    const mgr = new OcBashJobManager({ registryDir: null })
    try {
      const invalid = await handleOcBash(
        { command: 'echo hi', lifecycle_class: 'unknown_class' },
        { jobManager: mgr },
      )
      assert.equal(invalid.isError, true)
      assert.match(invalid.content[0]!.text, /lifecycle_class/)

      const onResume = await handleOcBash(
        { job_id: 'ocb_1', action: 'status', lifecycle_class: 'managed_job' },
        { jobManager: mgr },
      )
      assert.equal(onResume.isError, true)
      assert.match(onResume.content[0]!.text, /lifecycle_class/)
    } finally {
      mgr.disposeAll()
    }
  })

  it('reapTurnJobs kills ephemeral_turn while preserving managed_job & daemon_service + snapshots', { timeout: 15_000 }, async () => {
    const regDir = mkdtempSync(join(tmpdir(), 'oc-bash-lc-reap-'))
    const mgr = new OcBashJobManager({
      registryDir: regDir,
      sessionKey: 'agent:main:webchat:dm:sess_lc_reap',
      killGraceMs: 80,
      idleJobTtlMs: 30_000,
      maxJobLifetimeMs: 30_000,
    })
    const pidsToClean: number[] = []
    try {
      const eph = await mgr.startAndWait({
        command: 'sleep 30',
        cwd: tmpdir(),
        timeoutMs: 120,
        lifecycleClass: 'ephemeral_turn',
      })
      const managed = await mgr.startAndWait({
        command: 'sleep 30',
        cwd: tmpdir(),
        timeoutMs: 120,
        lifecycleClass: 'managed_job',
      })
      const daemon = await mgr.startAndWait({
        command: 'sleep 30',
        cwd: tmpdir(),
        timeoutMs: 120,
        lifecycleClass: 'daemon_service',
      })
      assert.equal(eph.kind, 'running')
      assert.equal(managed.kind, 'running')
      assert.equal(daemon.kind, 'running')
      assert.equal(managed.lifecycleClass, 'managed_job')
      assert.equal(daemon.lifecycleClass, 'daemon_service')

      const snapOf = (jobId: string): OcBashJobSnapshot =>
        JSON.parse(readFileSync(join(regDir, `${process.pid}-${jobId}.json`), 'utf8')) as OcBashJobSnapshot

      const ephSnap = snapOf(eph.jobId)
      const managedSnap = snapOf(managed.jobId)
      const daemonSnap = snapOf(daemon.jobId)
      pidsToClean.push(ephSnap.pid, managedSnap.pid, daemonSnap.pid)

      assert.equal(ephSnap.lifecycleClass, 'ephemeral_turn')
      assert.equal(managedSnap.lifecycleClass, 'managed_job')
      assert.equal(daemonSnap.lifecycleClass, 'daemon_service')
      assert.equal(ephSnap.leaseId, mgr.leaseId)

      const proof = await mgr.reapTurnJobs()
      assert.deepEqual([...proof.reapedJobIds], [eph.jobId])
      assert.ok(proof.survivingJobIds.includes(managed.jobId))
      assert.ok(proof.survivingJobIds.includes(daemon.jobId))

      assert.equal(isPidAlive(ephSnap.pid), false, 'ephemeral_turn must be reaped')
      assert.equal(isPidAlive(managedSnap.pid), true, 'managed_job must survive turn reap')
      assert.equal(isPidAlive(daemonSnap.pid), true, 'daemon_service must survive turn reap')
      assert.equal(existsSync(join(regDir, `${process.pid}-${eph.jobId}.json`)), false)
      assert.equal(existsSync(join(regDir, `${process.pid}-${managed.jobId}.json`)), true)
      assert.equal(existsSync(join(regDir, `${process.pid}-${daemon.jobId}.json`)), true)
    } finally {
      mgr.disposeAll()
      for (const pid of pidsToClean) killPidBestEffort(pid)
      rmSync(regDir, { recursive: true, force: true })
    }
  })

  it('B06: managed_job keeps writing stdout/stderr AFTER shutdown({ preserveSurvivors: true }) and reaches business completion without SIGPIPE', { timeout: 15_000 }, async () => {
    const regDir = mkdtempSync(join(tmpdir(), 'oc-bash-b06-handoff-'))
    const markerFile = join(regDir, 'completed.marker')
    const mgr = new OcBashJobManager({
      registryDir: regDir,
      sessionKey: 'agent:main:webchat:dm:sess_b06',
      killGraceMs: 80,
    })
    let managedPid: number | undefined
    try {
      // Child emits output before handoff, sleeps past handoff, emits LOTS of stdout+stderr, then writes completion marker.
      const cmd = [
        'echo "before-handoff"',
        'sleep 0.4',
        'for i in $(seq 1 40); do echo "post-handoff-stdout-$i"; echo "post-handoff-stderr-$i" >&2; done',
        `printf "BUSINESS_DONE" > ${JSON.stringify(markerFile)}`,
      ].join('; ')

      const started = await mgr.startAndWait({
        command: cmd,
        cwd: regDir,
        timeoutMs: 120,
        lifecycleClass: 'managed_job',
      })
      assert.equal(started.kind, 'running')
      const snap = JSON.parse(
        readFileSync(join(regDir, `${process.pid}-${started.jobId}.json`), 'utf8'),
      ) as OcBashJobSnapshot
      managedPid = snap.pid
      assert.ok(snap.stdoutLogPath && snap.stderrLogPath, 'managed_job must use file-backed stdio logs')

      // Simulate MCP disconnect / brain switch
      const res = mgr.shutdown({ preserveSurvivors: true })
      assert.ok(res.preservedJobIds.includes(started.jobId))

      // Wait for post-handoff writes and marker completion
      const deadline = Date.now() + 5_000
      while (!existsSync(markerFile) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 40))
      }
      assert.equal(existsSync(markerFile), true, 'managed_job must finish writing stdout/stderr and reach completion after handoff')
      assert.equal(readFileSync(markerFile, 'utf8'), 'BUSINESS_DONE')
    } finally {
      killPidBestEffort(managedPid)
      rmSync(regDir, { recursive: true, force: true })
    }
  })

  it('B07: shutdown({ preserveSurvivors: true }) reaps lingering ephemeral_turn descendant after shell leader already exited', { timeout: 10_000 }, async () => {
    if (process.platform !== 'linux') return
    const regDir = mkdtempSync(join(tmpdir(), 'oc-bash-b07-lingering-'))
    const mgr = new OcBashJobManager({
      registryDir: regDir,
      sessionKey: 'agent:main:webchat:dm:sess_b07',
      killGraceMs: 80,
    })
    let childPid = 0
    try {
      const outcome = await mgr.startAndWait({
        command: 'sleep 30 </dev/null >/dev/null 2>&1 & echo $!',
        timeoutMs: 3_000,
        lifecycleClass: 'ephemeral_turn',
      })
      assert.equal(outcome.kind, 'finished')
      childPid = Number(outcome.stdout.trim())
      assert.ok(Number.isInteger(childPid) && childPid > 1)
      assert.equal(isPidAlive(childPid), true, 'lingering child starts alive')

      mgr.shutdown({ preserveSurvivors: true })
      const deadline = Date.now() + 2_000
      while (isPidAlive(childPid) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 30))
      }
      assert.equal(isPidAlive(childPid), false, 'lingering ephemeral descendant must be reaped on disconnect')
    } finally {
      killPidBestEffort(childPid)
      rmSync(regDir, { recursive: true, force: true })
    }
  })

  it('B08: ExecEnvJobRegistry deltaRing strictly bounds memory on invalid binary + split multi-byte UTF-8 streams', { timeout: 10_000 }, async () => {
    const cap = 8 * 1024
    const reg = new ExecEnvJobRegistry({ maxOutputBytes: cap, survivableStdioDir: null })
    try {
      const script = [
        'const bad = Buffer.alloc(1024, 0xff);',
        'const emoji = Buffer.from("🚀", "utf8");',
        'for (let i = 0; i < 64; i++) {',
        '  process.stdout.write(bad);',
        '  process.stdout.write(emoji.subarray(0, 2));',
        '  process.stdout.write(emoji.subarray(2));',
        '  process.stderr.write(bad.subarray(0, 256));',
        '}',
      ].join('')
      const started = await reg.startJob({
        leaseId: 'lease-b08',
        lifecycleClass: 'ephemeral_turn',
        command: [process.execPath, '-e', script],
        yieldAfterMs: 5_000,
      })
      assert.equal(started.status, 'exited')
      const stats = reg.getDeltaRingStats(started.jobId)
      assert.ok(stats !== null)
      assert.ok(
        stats.bytes <= cap,
        `deltaRingBytes (${stats.bytes}) must never exceed maxOutputBytes (${cap})`,
      )
      assert.ok(stats.entries <= 1024, `deltaRing entries (${stats.entries}) must stay bounded`)
    } finally {
      await reg.disposeAll()
    }
  })

  it('W02: concurrent continueJob(status) calls serialize under waiterInFlight without double-delivering output', { timeout: 10_000 }, async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'oc-bash-w02-'))
    const markerFile = join(tmpDir, 'emitted.marker')
    const mgr = new OcBashJobManager({ registryDir: null })
    try {
      const started = await mgr.startAndWait({
        command: `sleep 0.15; echo "ONCE_ONLY_LINE"; touch ${JSON.stringify(markerFile)}; sleep 2`,
        timeoutMs: 60,
      })
      assert.equal(started.kind, 'running')
      const deadline = Date.now() + 4_000
      while (!existsSync(markerFile) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20))
      }
      await new Promise((r) => setTimeout(r, 40))

      const [r1, r2] = await Promise.all([
        mgr.continueJob({ jobId: started.jobId, action: 'status', timeoutMs: 500 }),
        mgr.continueJob({ jobId: started.jobId, action: 'status', timeoutMs: 500 }),
      ])
      const kinds = [r1.kind, r2.kind].sort()
      assert.deepEqual(kinds, ['busy', 'running'])
      const runningRes = r1.kind === 'running' ? r1 : (r2 as Extract<typeof r2, { kind: 'running' }>)
      assert.match(runningRes.stdout, /ONCE_ONLY_LINE/)
    } finally {
      mgr.disposeAll()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('W03: naturally exited yielded managed_job is promoted to tombstone & pruned after idleJobTtlMs while running managed_job ignores idle TTL', { timeout: 10_000 }, async () => {
    const regDir = mkdtempSync(join(tmpdir(), 'oc-bash-w03-'))
    const mgr = new OcBashJobManager({
      registryDir: regDir,
      sessionKey: 'agent:main:webchat:dm:sess_w03',
      idleJobTtlMs: 120,
      maxJobLifetimeMs: 1500,
      killGraceMs: 50,
    })
    const pidsToClean: number[] = []
    try {
      // Short-lived yielded managed_job: finishes at ~120ms, then unread result expires after idleJobTtlMs (120ms)
      const shortManaged = await mgr.startAndWait({
        command: 'sleep 0.12; echo "short-done"',
        timeoutMs: 40,
        lifecycleClass: 'managed_job',
      })
      assert.equal(shortManaged.kind, 'running')

      // Long-running managed_job & daemon_service
      const longManaged = await mgr.startAndWait({
        command: 'sleep 30',
        timeoutMs: 40,
        lifecycleClass: 'managed_job',
      })
      const daemon = await mgr.startAndWait({
        command: 'sleep 30',
        timeoutMs: 40,
        lifecycleClass: 'daemon_service',
      })
      assert.equal(longManaged.kind, 'running')
      assert.equal(daemon.kind, 'running')

      const longSnap = JSON.parse(
        readFileSync(join(regDir, `${process.pid}-${longManaged.jobId}.json`), 'utf8'),
      ) as OcBashJobSnapshot
      const daemonSnap = JSON.parse(
        readFileSync(join(regDir, `${process.pid}-${daemon.jobId}.json`), 'utf8'),
      ) as OcBashJobSnapshot
      pidsToClean.push(longSnap.pid, daemonSnap.pid)

      // At +750ms: shortManaged exited & its unread buffer was promoted to tombstone; longManaged & daemon STILL alive!
      await new Promise((r) => setTimeout(r, 750))
      const afterShort = await mgr.continueJob({
        jobId: shortManaged.jobId,
        action: 'status',
        timeoutMs: 500,
      })
      assert.equal(afterShort.kind, 'tombstone')
      assert.equal(isPidAlive(longSnap.pid), true, 'running managed_job must ignore idleJobTtlMs')
      assert.equal(isPidAlive(daemonSnap.pid), true, 'running daemon_service must ignore idleJobTtlMs')

      // Past maxJobLifetimeMs (650ms): longManaged terminated, daemon STILL alive
      const deadline = Date.now() + 1_500
      while (isPidAlive(longSnap.pid) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 30))
      }
      assert.equal(isPidAlive(longSnap.pid), false, 'managed_job must still respect maxJobLifetimeMs')
      assert.equal(isPidAlive(daemonSnap.pid), true, 'daemon_service must ignore maxJobLifetimeMs')
    } finally {
      mgr.disposeAll()
      for (const pid of pidsToClean) killPidBestEffort(pid)
      rmSync(regDir, { recursive: true, force: true })
    }
  })

  it('W04: hasAliveVerifiedProcessGroup fails closed on PID reuse (mismatched leader startTimeTicks) or null ticks', () => {
    // Missing startTimeTicks on Linux -> fail closed
    assert.equal(
      hasAliveVerifiedProcessGroup(5000, null, {
        platform: 'linux',
        readProcStat: () => ({ state: 'S', pgrp: 5000, startTimeTicks: 100 }),
        listProcPids: () => [5000],
      }),
      false,
    )
    // Leader PID reused by a newer process with different startTimeTicks -> fail closed even if child shares pgrp
    assert.equal(
      hasAliveVerifiedProcessGroup(5000, 100, {
        platform: 'linux',
        readProcStat: (pid) =>
          pid === 5000
            ? { state: 'S', pgrp: 5000, startTimeTicks: 999 }
            : { state: 'S', pgrp: 5000, startTimeTicks: 1000 },
        listProcPids: () => [5000, 5001],
      }),
      false,
    )
    // Exact leader match -> verified true
    assert.equal(
      hasAliveVerifiedProcessGroup(5000, 100, {
        platform: 'linux',
        readProcStat: () => ({ state: 'S', pgrp: 5000, startTimeTicks: 100 }),
        listProcPids: () => [5000],
      }),
      true,
    )
  })

  it('markEnvMigrated drains jobs and surfaces status=terminated_env_migrated on subsequent wait', { timeout: 10_000 }, async () => {
    const regDir = mkdtempSync(join(tmpdir(), 'oc-bash-lc-mig-'))
    const mgr = new OcBashJobManager({
      registryDir: regDir,
      sessionKey: 'agent:main:webchat:dm:sess_lc_mig',
      killGraceMs: 60,
    })
    try {
      const started = await handleOcBash(
        { command: 'sleep 30', timeout_ms: 1000, lifecycle_class: 'managed_job' },
        { jobManager: mgr },
      )
      const jobId = /job_id=(ocb_\d+)/.exec(started.content[0]!.text)![1]!

      const migrated = await mgr.markEnvMigrated('container_rebuilt')
      assert.deepEqual([...migrated.tombstonedJobIds], [jobId])
      const jsonFiles = readdirSync(regDir).filter((f) => f.endsWith('.json'))
      assert.deepEqual(jsonFiles, [])

      const resumed = await handleOcBash({ job_id: jobId }, { jobManager: mgr })
      assert.equal(resumed.isError, true)
      assert.match(resumed.content[0]!.text, /status=terminated_env_migrated/)
      assert.match(resumed.content[0]!.text, /container_rebuilt/)
    } finally {
      mgr.disposeAll()
      rmSync(regDir, { recursive: true, force: true })
    }
  })

  it('F02 + F03: detached bounded rotating log sink caps disk usage on 512KB burst and preserves final-marker even if log file is concurrently unlinked', { timeout: 15_000 }, async () => {
    const regDir = mkdtempSync(join(tmpdir(), 'oc-bash-f02-f03-'))
    const mgr = new OcBashJobManager({
      registryDir: regDir,
      sessionKey: 'agent:main:webchat:dm:sess_f02_f03',
      maxBytes: 8 * 1024,
      maxLogFileBytes: 16 * 1024,
    })
    try {
      // F03: Write 512KB from a managed_job while memory ring is 8KB and disk cap is 16KB
      const started = await mgr.startAndWait({
        command: 'head -c 524288 /dev/zero | tr "\\0" "A"; printf "\\nTAIL-OK\\n"; sleep 0.35',
        timeoutMs: 120,
        lifecycleClass: 'managed_job',
      })
      assert.equal(started.kind, 'running')
      await new Promise((r) => setTimeout(r, 150))

      const logsDir = join(regDir, 'logs')
      let diskBytes = 0
      if (existsSync(logsDir)) {
        for (const name of readdirSync(logsDir)) {
          diskBytes += statSync(join(logsDir, name)).size
        }
      }
      assert.ok(
        diskBytes <= 16 * 1024,
        `detached rotating log sink must cap disk usage <= 16384 bytes (got ${diskBytes})`,
      )

      // F02: Unlink the active log file while the job is finishing; open POSIX read FD must STILL deliver TAIL-OK!
      const canonicalOut = join(logsDir, `${process.pid}-${started.jobId}.stdout.log`)
      if (existsSync(canonicalOut)) {
        rmSync(canonicalOut, { force: true })
      }
      const done = await mgr.continueJob({
        jobId: started.jobId,
        action: 'wait',
        timeoutMs: 4_000,
      })
      assert.equal(done.kind, 'finished')
      assert.equal(done.exitCode, 0)
      const combined = `${started.stdout}${done.stdout}`
      assert.ok(combined.includes('TAIL-OK'), `expected TAIL-OK despite concurrent unlink; got tail=${combined.slice(-80)}`)
    } finally {
      mgr.disposeAll()
      rmSync(regDir, { recursive: true, force: true })
    }
  })

  it('F04: managed_job and daemon_service fail closed when survivable log sink dir is unavailable or unwritable (never returning running/preserved)', async () => {
    const tmpBase = mkdtempSync(join(tmpdir(), 'oc-bash-f04-'))
    const blockingFile = join(tmpBase, 'not-a-dir')
    writeFileSync(blockingFile, 'block mkdir', 'utf8')
    const mgrUnwritable = new OcBashJobManager({
      registryDir: blockingFile,
      sessionKey: 'agent:main:webchat:dm:sess_f04_unwritable',
    })
    const mgrNullDir = new OcBashJobManager({
      registryDir: null,
      sessionKey: 'agent:main:webchat:dm:sess_f04_null',
    })
    try {
      const r1 = await mgrUnwritable.startAndWait({
        command: 'sleep 10',
        timeoutMs: 100,
        lifecycleClass: 'managed_job',
      })
      assert.equal(r1.kind, 'spawn_error', 'unwritable survivableStdioDir must fail closed')
      assert.match(r1.error, /MCP-independent bounded log sink|survivableStdioDir/)

      const r2 = await mgrNullDir.startAndWait({
        command: 'sleep 10',
        timeoutMs: 100,
        lifecycleClass: 'daemon_service',
      })
      assert.equal(r2.kind, 'spawn_error', 'null registryDir must fail closed for daemon_service')

      // ephemeral_turn still works normally without survivableStdioDir
      const eph = await mgrNullDir.startAndWait({
        command: 'echo EPH-OK',
        timeoutMs: 2_000,
        lifecycleClass: 'ephemeral_turn',
      })
      assert.equal(eph.kind, 'finished')
      assert.equal(eph.stdout.trim(), 'EPH-OK')

      const shut = mgrUnwritable.shutdown({ preserveSurvivors: true })
      assert.deepEqual(shut.preservedJobIds, [])
    } finally {
      mgrUnwritable.disposeAll()
      mgrNullDir.disposeAll()
      rmSync(tmpBase, { recursive: true, force: true })
    }
  })

  it('F06: lingering managed_job descendant retains concurrency slot and canonical logs until worker exits', { timeout: 10_000 }, async () => {
    const regDir = mkdtempSync(join(tmpdir(), 'oc-bash-f06-slot-'))
    const pidFile = join(regDir, 'worker.pid')
    const mgr = new OcBashJobManager({
      registryDir: regDir,
      sessionKey: 'agent:main:webchat:dm:sess_f06',
      maxActiveJobs: 1,
    })
    let workerPid = 0
    try {
      const first = await mgr.startAndWait({
        command: `(/bin/sleep 0.6) & echo $! > ${JSON.stringify(pidFile)}; echo SHELL-DONE`,
        timeoutMs: 2_000,
        lifecycleClass: 'managed_job',
      })
      assert.equal(first.kind, 'finished')
      assert.equal(first.stdout.trim(), 'SHELL-DONE')
      workerPid = Number(readFileSync(pidFile, 'utf8').trim())
      assert.equal(isPidAlive(workerPid), true, 'backgrounded worker must still be alive')

      // While lingering worker is alive: concurrency slot MUST remain occupied (activeRunningCount=1)
      // and canonical log file MUST still exist!
      assert.equal(mgr.activeRunningCount(), 1, 'lingering managed_job group must retain concurrency slot')
      const canonicalOut = join(regDir, 'logs', `${process.pid}-${first.jobId}.stdout.log`)
      assert.equal(existsSync(canonicalOut), true, 'canonical log must be preserved while lingering group is alive')

      const second = await mgr.startAndWait({
        command: 'echo SHOULD-BE-BLOCKED',
        timeoutMs: 1_000,
        lifecycleClass: 'managed_job',
      })
      assert.equal(second.kind, 'too_many_jobs', '2nd job must be rejected while lingering group holds slot')

      // Wait for lingering worker to exit naturally -> slot released & logs cleaned up!
      const deadline = Date.now() + 2_000
      while (isPidAlive(workerPid) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 30))
      }
      assert.equal(mgr.activeRunningCount(), 0, 'slot released once lingering group exits')
      assert.equal(existsSync(canonicalOut), false, 'canonical log cleaned up once lingering group exits')

      const third = await mgr.startAndWait({
        command: 'echo SLOT-FREED',
        timeoutMs: 2_000,
        lifecycleClass: 'managed_job',
      })
      assert.equal(third.kind, 'finished')
      assert.equal(third.stdout.trim(), 'SLOT-FREED')
    } finally {
      mgr.disposeAll()
      killPidBestEffort(workerPid)
      rmSync(regDir, { recursive: true, force: true })
    }
  })

  it('Steward P1-1: concurrent startJob vs shutdown/disposeAll/reapByClass/markEnvMigrated fences async launch and leaks zero orphans or logs', { timeout: 15_000 }, async () => {
    const regDir = mkdtempSync(join(tmpdir(), 'oc-bash-p1-race-'))
    const pidFile = join(regDir, 'raced.pid')
    const mgr = new OcBashJobManager({
      registryDir: regDir,
      sessionKey: 'agent:main:webchat:dm:sess_p1_race',
      maxJobLifetimeMs: 50,
      killGraceMs: 40,
    })
    try {
      // 1. Concurrent managed_job start immediately raced with shutdown({ preserveSurvivors: false })
      const managedPromise = mgr.startAndWait({
        command: `echo $$ > ${JSON.stringify(pidFile)}; sleep 30`,
        cwd: regDir,
        timeoutMs: 150,
        lifecycleClass: 'managed_job',
      })
      const ephPromise = mgr.startAndWait({
        command: 'sleep 0.6',
        cwd: regDir,
        timeoutMs: 150,
        lifecycleClass: 'ephemeral_turn',
      })
      // Trigger immediate synchronous shutdown while async sink setup / ticksReady is in flight
      mgr.disposeAll()
      const [managedOut, ephOut] = await Promise.all([managedPromise, ephPromise])
      assert.ok(
        managedOut.kind === 'spawn_error' || managedOut.kind === 'finished' || managedOut.kind === 'terminated',
        `raced managed_job must fail closed or terminate cleanly, got ${managedOut.kind}`,
      )
      assert.ok(
        ephOut.kind === 'spawn_error' || ephOut.kind === 'finished' || ephOut.kind === 'terminated',
        `raced ephemeral_turn must fail closed or terminate cleanly, got ${ephOut.kind}`,
      )
      await new Promise((r) => setTimeout(r, 80))
      if (existsSync(pidFile)) {
        const pid = Number(readFileSync(pidFile, 'utf8').trim())
        assert.equal(isPidAlive(pid), false, 'raced child process must not survive shutdown')
      }
      assert.equal(mgr.activeRunningCount(), 0)
      const jsonFiles = readdirSync(regDir).filter((f) => f.endsWith('.json'))
      assert.deepEqual(jsonFiles, [], 'no leftover snapshot files after raced shutdown')
      const logsDir = join(regDir, 'logs')
      const logFiles = existsSync(logsDir) ? readdirSync(logsDir) : []
      assert.deepEqual(logFiles, [], 'no leftover log files after raced shutdown')

      // 2. Direct ExecEnvJobRegistry concurrent startJob vs reapByClass & markEnvMigratedTombstones
      const reg = new ExecEnvJobRegistry({ survivableStdioDir: join(regDir, 'reg-logs'), killGraceMs: 40 })
      try {
        const pReap = reg.startJob({
          jobId: 'race_reap_1',
          leaseId: 'lease-p1',
          lifecycleClass: 'managed_job',
          command: ['/bin/sleep', '30'],
          yieldAfterMs: 100,
        })
        const reapProof = await reg.reapByClass('lease-p1', ['managed_job'])
        assert.ok(reapProof.verifiedAtMs > 0)
        await assert.rejects(() => pReap, /EXEC_JOB_REGISTRY_DISPOSED|cancelled/i)

        const pMig = reg.startJob({
          jobId: 'race_mig_1',
          leaseId: 'lease-p1',
          lifecycleClass: 'managed_job',
          command: ['/bin/sleep', '30'],
          yieldAfterMs: 100,
        })
        await reg.markEnvMigratedTombstones('lease-p1', 'env_rebuilt')
        await assert.rejects(() => pMig, /EXEC_JOB_REGISTRY_DISPOSED|env_rebuilt/i)

        const remaining = await reg.listJobs('lease-p1')
        assert.deepEqual(remaining, [])
      } finally {
        await reg.disposeAll()
      }
    } finally {
      if (existsSync(pidFile)) {
        killPidBestEffort(Number(readFileSync(pidFile, 'utf8').trim()))
      }
      rmSync(regDir, { recursive: true, force: true })
    }
  })

  it('Steward P1-1b: deterministic pause at ticksReady during shutdownSync and disposeAll terminates real process group without false reapedJobIds', { timeout: 15_000 }, async () => {
    const regDir = mkdtempSync(join(tmpdir(), 'oc-bash-ticks-race-'))
    const cleanupPids: number[] = []
    const waitForPidPair = async (file: string): Promise<[number, number]> => {
      const deadline = Date.now() + 3_000
      while (Date.now() < deadline) {
        if (existsSync(file)) {
          const parts = readFileSync(file, 'utf8').trim().split(/\s+/).map(Number)
          if (parts.length === 2 && parts[0]! > 1 && parts[1]! > 1) return [parts[0]!, parts[1]!]
        }
        await new Promise((r) => setTimeout(r, 20))
      }
      throw new Error(`timed out waiting for pid pair in ${file}`)
    }
    const waitPidDead = async (pid: number): Promise<boolean> => {
      const deadline = Date.now() + 3_000
      while (isPidAlive(pid) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20))
      }
      return !isPidAlive(pid)
    }

    try {
      // Case A: shutdownSync() fires while startJob is deterministically paused inside ticksReady
      const logsA = join(regDir, 'logs-a')
      const pidFileA = join(regDir, 'pids-a.txt')
      let releaseTicksA!: () => void
      const ticksGateA = new Promise<void>((resolve) => {
        releaseTicksA = resolve
      })
      let ticksEnteredA!: () => void
      const enteredA = new Promise<void>((resolve) => {
        ticksEnteredA = resolve
      })
      let startedEventsA = 0
      let closedEventsA = 0
      const regA = new ExecEnvJobRegistry({
        survivableStdioDir: logsA,
        readStartTimeTicks: async (pid) => {
          ticksEnteredA()
          await ticksGateA
          return await readProcStartTimeTicksAsync(pid)
        },
        onJobStarted: () => {
          startedEventsA += 1
        },
        onJobClosed: () => {
          closedEventsA += 1
        },
      })

      const startA = regA.startJob({
        jobId: 'ticks_race_shutdown',
        leaseId: 'lease-ticks',
        lifecycleClass: 'managed_job',
        command: ['/bin/bash', '-lc', `sleep 30 & echo "$! $$" > ${JSON.stringify(pidFileA)}; wait`],
        yieldAfterMs: 200,
      })
      await enteredA
      const [childPidA, leaderPidA] = await waitForPidPair(pidFileA)
      cleanupPids.push(leaderPidA, childPidA)
      assert.equal(isPidAlive(leaderPidA), true)
      assert.equal(isPidAlive(childPidA), true)

      const shutRes = regA.shutdownSync({ preserveClasses: ['managed_job'] })
      assert.deepEqual(
        shutRes.reapedJobIds,
        ['ticks_race_shutdown'],
        'shutdownSync must synchronously kill already-spawned pending child group',
      )
      assert.deepEqual(shutRes.preservedJobIds, [], 'shutdownSync must NOT preserve unstarted pending job without snapshot')
      assert.equal(startedEventsA, 0)
      assert.equal(closedEventsA, 0)
      assert.equal(await waitPidDead(leaderPidA), true, 'leader process must already be killed synchronously by shutdownSync')
      assert.equal(await waitPidDead(childPidA), true, 'grandchild in process group must already be killed synchronously')

      releaseTicksA()
      await assert.rejects(() => startA, /EXEC_JOB_REGISTRY_DISPOSED|cancelled/i)
      assert.equal(startedEventsA, 0, 'aborted pending start must not emit onJobStarted')
      assert.equal(closedEventsA, 0, 'aborted pending start must not emit onJobClosed')
      assert.deepEqual(existsSync(logsA) ? readdirSync(logsA) : [], [], 'no leftover logs after ticksReady shutdown race')

      // Case C: Real child host process paused in ticksReady receives SIGTERM, runs shutdownSync(),
      // and immediately exits (never resuming async Promises) — external observer confirms detached
      // grandchild process group is dead and zero snapshots/logs remain!
      const childRegDir = join(regDir, 'mcp-child-exit')
      const pidFileC = join(regDir, 'pids-c.txt')
      const readyFileC = join(regDir, 'ready-c.txt')
      const repoRoot = new URL('../../../../', import.meta.url).pathname
      const storageEntry = new URL('../../../storage/src/execEnvJobRegistry.ts', import.meta.url).href
      const childScript = `(async () => {
  const { writeFileSync } = await import('node:fs');
  const { ExecEnvJobRegistry } = await import(${JSON.stringify(storageEntry)});
  const reg = new ExecEnvJobRegistry({
    survivableStdioDir: ${JSON.stringify(join(childRegDir, 'logs'))},
    readStartTimeTicks: async () => {
      writeFileSync(${JSON.stringify(readyFileC)}, 'PAUSED', 'utf8');
      await new Promise(() => {});
      return null;
    },
  });
  process.once('SIGTERM', () => {
    reg.shutdownSync({ preserveClasses: ['managed_job'] });
    process.exit(0);
  });
  void reg.startJob({
    jobId: 'child_exit_race',
    leaseId: 'lease-child-exit',
    lifecycleClass: 'ephemeral_turn',
    command: ['/bin/bash', '-lc', ${JSON.stringify(`sleep 30 & echo "$! $$" > ${JSON.stringify(pidFileC)}; wait`)}],
    yieldAfterMs: 5000,
  });
})().catch((err) => { console.error(err); process.exit(2); });`
      let hostStderr = ''
      const hostProc = spawn(process.execPath, [...process.execArgv, '-e', childScript], {
        cwd: repoRoot,
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      hostProc.stderr?.on('data', (chunk: Buffer) => {
        hostStderr += chunk.toString('utf8')
      })
      try {
        const readyDeadline = Date.now() + 8_000
        while (!existsSync(readyFileC) && Date.now() < readyDeadline) {
          await new Promise((r) => setTimeout(r, 20))
        }
        assert.equal(existsSync(readyFileC), true, `child host must reach ticksReady pause (stderr=${hostStderr})`)
        const [childPidC, leaderPidC] = await waitForPidPair(pidFileC)
        cleanupPids.push(leaderPidC, childPidC)
        assert.equal(isPidAlive(leaderPidC), true)
        assert.equal(isPidAlive(childPidC), true)

        hostProc.kill('SIGTERM')
        await new Promise<void>((resolve) => hostProc.once('close', () => resolve()))

        assert.equal(await waitPidDead(leaderPidC), true, 'detached leader must die synchronously when host exits in ticksReady')
        assert.equal(await waitPidDead(childPidC), true, 'detached grandchild must die synchronously when host exits in ticksReady')
        assert.equal(existsSync(childRegDir) ? readdirSync(childRegDir).filter((f) => f.endsWith('.json')).length : 0, 0)
      } finally {
        try {
          hostProc.kill('SIGKILL')
        } catch {
          /* exited */
        }
      }

      // Case B: disposeAll() waits for ticksReady-paused pending start to verify and kill its real process group
      const logsB = join(regDir, 'logs-b')
      const pidFileB = join(regDir, 'pids-b.txt')
      let releaseTicksB!: () => void
      const ticksGateB = new Promise<void>((resolve) => {
        releaseTicksB = resolve
      })
      let ticksEnteredB!: () => void
      const enteredB = new Promise<void>((resolve) => {
        ticksEnteredB = resolve
      })
      const regB = new ExecEnvJobRegistry({
        survivableStdioDir: logsB,
        readStartTimeTicks: async (pid) => {
          ticksEnteredB()
          await ticksGateB
          return await readProcStartTimeTicksAsync(pid)
        },
      })

      const startB = regB.startJob({
        jobId: 'ticks_race_dispose',
        leaseId: 'lease-ticks',
        lifecycleClass: 'managed_job',
        command: ['/bin/bash', '-lc', `sleep 30 & echo "$! $$" > ${JSON.stringify(pidFileB)}; wait`],
        yieldAfterMs: 200,
      })
      await enteredB
      const [childPidB, leaderPidB] = await waitForPidPair(pidFileB)
      cleanupPids.push(leaderPidB, childPidB)
      assert.equal(isPidAlive(leaderPidB), true)
      assert.equal(isPidAlive(childPidB), true)

      let disposeDone = false
      const disposeP = regB.disposeAll().then(() => {
        disposeDone = true
      })
      await new Promise((r) => setTimeout(r, 30))
      assert.equal(disposeDone, false, 'disposeAll must wait for cancelled pending start cleanup to settle')
      releaseTicksB()
      await disposeP
      await assert.rejects(() => startB, /EXEC_JOB_REGISTRY_DISPOSED|cancelled/i)
      assert.equal(await waitPidDead(leaderPidB), true, 'leader process must exit on disposeAll')
      assert.equal(await waitPidDead(childPidB), true, 'grandchild process must exit on disposeAll')
      assert.deepEqual(existsSync(logsB) ? readdirSync(logsB) : [], [], 'no leftover logs after ticksReady disposeAll race')
    } finally {
      for (const pid of cleanupPids) killPidBestEffort(pid)
      rmSync(regDir, { recursive: true, force: true })
    }
  })

  it('Steward P1-proc: real-process negative control without injected stubs refuses mismatched startTimeTicks on both sync and async paths', { timeout: 10_000 }, async () => {
    if (process.platform !== 'linux') return
    const child = spawn('/bin/sleep', ['30'], { detached: true, stdio: 'ignore' })
    const pid = child.pid!
    assert.ok(pid > 1)
    try {
      const realTicks = await readProcStartTimeTicksAsync(pid)
      assert.ok(realTicks !== null && realTicks > 0, 'real Linux process must expose /proc/<pid>/stat ticks')
      const wrongTicks = realTicks + 1

      // Negative control WITHOUT injected ops: mismatched startTimeTicks MUST return false and refuse to signal!
      assert.equal(hasAliveVerifiedProcessGroup(pid, wrongTicks), false, 'sync default must reject wrong startTimeTicks')
      assert.equal(await hasAliveVerifiedProcessGroupAsync(pid, wrongTicks), false, 'async must reject wrong startTimeTicks')
      assert.equal(
        sendVerifiedGroupSignal(pid, null, wrongTicks, 'SIGTERM'),
        false,
        'sync sendVerifiedGroupSignal must refuse mismatched startTimeTicks',
      )
      assert.equal(
        await sendVerifiedGroupSignalAsync(pid, null, wrongTicks, 'SIGTERM'),
        false,
        'async sendVerifiedGroupSignalAsync must refuse mismatched startTimeTicks',
      )
      await new Promise((r) => setTimeout(r, 80))
      assert.equal(isPidAlive(pid), true, 'real process MUST remain alive after mismatched-identity signal attempts')

      // Positive control WITHOUT injected ops: matching startTimeTicks MUST allow sync verification & termination!
      assert.equal(hasAliveVerifiedProcessGroup(pid, realTicks), true, 'sync default must accept real startTimeTicks')
      assert.equal(await hasAliveVerifiedProcessGroupAsync(pid, realTicks), true, 'async must accept real startTimeTicks')
      assert.equal(
        sendVerifiedGroupSignal(pid, null, realTicks, 'SIGTERM'),
        true,
        'sync sendVerifiedGroupSignal must signal when real startTimeTicks matches',
      )
      const deadline = Date.now() + 2_000
      while (isPidAlive(pid) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20))
      }
      assert.equal(isPidAlive(pid), false, 'real process must terminate after verified sync SIGTERM')
    } finally {
      killPidBestEffort(pid)
    }
  })
})
