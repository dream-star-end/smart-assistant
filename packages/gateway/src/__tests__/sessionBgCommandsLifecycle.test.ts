/**
 * Unit & live-process tests for Wave 3 P2-1 Gateway `sessionBgCommands.ts` lifecycle governance
 * + R1 audit blocker fixes B05 (full sessionKey isolation), B07 (expired managed_job & dead-owner
 * ephemeral sweeper), and W01 (no 20-item UI truncation).
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/sessionBgCommandsLifecycle.test.ts
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  listSessionBgCommands,
  readLinuxProcStartTimeTicks,
  reapSessionBgCommandsByClass,
  sweepExpiredSessionBgCommands,
  type SessionBgCommandSnapshot,
} from '../sessionBgCommands.js'

function isAlive(pid: number): boolean {
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

function writeSnapshot(dir: string, snap: SessionBgCommandSnapshot): string {
  const filePath = join(dir, `${snap.id}.json`)
  writeFileSync(filePath, JSON.stringify(snap), 'utf8')
  return filePath
}

describe('sessionBgCommands lifecycle classes (OCV5-908 P2-1)', () => {
  it('defaults legacy snapshots without lifecycleClass to ephemeral_turn and keeps daemon_service unexpired', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-bg-lc-parse-'))
    try {
      const now = 10_000
      writeSnapshot(dir, {
        id: '100-ocb_1',
        jobId: 'ocb_1',
        pid: 4001,
        pgid: 4001,
        ownerPid: 100,
        startTimeTicks: 100,
        sessionKey: 'agent:main:webchat:dm:sess-1',
        sessionId: 'sess-1',
        commandPreview: 'legacy cmd',
        startedAt: 1000,
        updatedAt: 2000,
        maxLifetimeAt: 50_000,
      })
      writeSnapshot(dir, {
        id: '100-ocb_2',
        jobId: 'ocb_2',
        pid: 4002,
        pgid: 4002,
        ownerPid: 100,
        startTimeTicks: 100,
        sessionKey: 'agent:main:webchat:dm:sess-1',
        sessionId: 'sess-1',
        commandPreview: 'npm run dev',
        startedAt: 1000,
        updatedAt: 2000,
        maxLifetimeAt: 5_000,
        lifecycleClass: 'daemon_service',
        leaseId: 'lease-1',
      })
      writeSnapshot(dir, {
        id: '100-ocb_3',
        jobId: 'ocb_3',
        pid: 4003,
        pgid: 4003,
        ownerPid: 100,
        startTimeTicks: 100,
        sessionKey: 'agent:main:webchat:dm:sess-1',
        sessionId: 'sess-1',
        commandPreview: 'cargo build',
        startedAt: 1500,
        updatedAt: 2500,
        maxLifetimeAt: 50_000,
        lifecycleClass: 'managed_job',
        leaseId: 'lease-1',
      })

      const items = listSessionBgCommands('sess-1', dir, {
        now: () => now,
        platform: 'linux',
        readProcStat: (pid) => ({ state: 'S', pgrp: pid, startTimeTicks: 100 }),
        listProcPids: () => [4001, 4002, 4003],
      })
      const byJob = new Map(items.map((i) => [i.jobId, i]))
      assert.equal(items.length, 3)
      assert.equal(byJob.get('ocb_1')?.lifecycleClass, 'ephemeral_turn')
      assert.equal(byJob.get('ocb_2')?.lifecycleClass, 'daemon_service')
      assert.equal(byJob.get('ocb_3')?.lifecycleClass, 'managed_job')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('B05: full sessionKey reaping isolates two sessions sharing the exact same short tail peer ID and skips missing-key snapshots', { timeout: 10_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-bg-b05-iso-'))
    const children: number[] = []
    const spawnSleeper = (): { pid: number; ticks: number | null } => {
      const child = spawn('/bin/sleep', ['30'], { detached: true, stdio: 'ignore' })
      child.unref()
      assert.ok(child.pid && child.pid > 1)
      children.push(child.pid)
      return { pid: child.pid, ticks: readLinuxProcStartTimeTicks(child.pid) }
    }

    try {
      const mainEph = spawnSleeper()
      const otherAgentSameTail = spawnSleeper()
      const missingKeySameTail = spawnSleeper()
      const mainManaged = spawnSleeper()

      const now = Date.now()
      const mainEphFile = writeSnapshot(dir, {
        id: '300-ocb_1',
        jobId: 'ocb_1',
        pid: mainEph.pid,
        pgid: mainEph.pid,
        ownerPid: 300,
        startTimeTicks: mainEph.ticks,
        sessionKey: 'agent:main:webchat:dm:shared-peer',
        sessionId: 'shared-peer',
        commandPreview: 'main ephemeral',
        startedAt: now,
        updatedAt: now,
        maxLifetimeAt: now + 60_000,
        lifecycleClass: 'ephemeral_turn',
      })
      const otherAgentFile = writeSnapshot(dir, {
        id: '300-ocb_2',
        jobId: 'ocb_2',
        pid: otherAgentSameTail.pid,
        pgid: otherAgentSameTail.pid,
        ownerPid: 300,
        startTimeTicks: otherAgentSameTail.ticks,
        sessionKey: 'agent:coding-assistant:webchat:dm:shared-peer',
        sessionId: 'shared-peer',
        commandPreview: 'other agent ephemeral same tail',
        startedAt: now,
        updatedAt: now,
        maxLifetimeAt: now + 60_000,
        lifecycleClass: 'ephemeral_turn',
      })
      const missingKeyFile = writeSnapshot(dir, {
        id: '300-ocb_3',
        jobId: 'ocb_3',
        pid: missingKeySameTail.pid,
        pgid: missingKeySameTail.pid,
        ownerPid: 300,
        startTimeTicks: missingKeySameTail.ticks,
        sessionKey: '',
        sessionId: 'shared-peer',
        commandPreview: 'missing sessionKey',
        startedAt: now,
        updatedAt: now,
        maxLifetimeAt: now + 60_000,
        lifecycleClass: 'ephemeral_turn',
      })
      const mainManagedFile = writeSnapshot(dir, {
        id: '300-ocb_4',
        jobId: 'ocb_4',
        pid: mainManaged.pid,
        pgid: mainManaged.pid,
        ownerPid: 300,
        startTimeTicks: mainManaged.ticks,
        sessionKey: 'agent:main:webchat:dm:shared-peer',
        sessionId: 'shared-peer',
        commandPreview: 'main managed',
        startedAt: now,
        updatedAt: now,
        maxLifetimeAt: now + 60_000,
        lifecycleClass: 'managed_job',
      })

      const result = await reapSessionBgCommandsByClass(
        { sessionKey: 'agent:main:webchat:dm:shared-peer' },
        ['ephemeral_turn'],
        dir,
        { killGraceMs: 120, killConfirmMs: 300 },
      )
      assert.deepEqual([...result.reapedIds], ['300-ocb_1'])
      assert.deepEqual([...result.preservedIds], ['300-ocb_4'])
      assert.deepEqual([...result.failedIds], [])

      assert.equal(isAlive(mainEph.pid), false, 'target session ephemeral_turn must be killed')
      assert.equal(existsSync(mainEphFile), false)
      assert.equal(isAlive(otherAgentSameTail.pid), true, 'other agent with same tail MUST survive')
      assert.equal(existsSync(otherAgentFile), true)
      assert.equal(isAlive(missingKeySameTail.pid), true, 'snapshot without full sessionKey MUST NOT be guessed-killed')
      assert.equal(existsSync(missingKeyFile), true)
      assert.equal(isAlive(mainManaged.pid), true, 'target session managed_job MUST survive')
      assert.equal(existsSync(mainManagedFile), true)
    } finally {
      for (const pid of children) {
        try {
          process.kill(-pid, 'SIGKILL')
        } catch {
          try {
            process.kill(pid, 'SIGKILL')
          } catch {
            /* ignore */
          }
        }
      }
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('B07: sweepExpiredSessionBgCommands kills expired managed_job & dead-owner ephemeral_turn while preserving daemon_service', { timeout: 10_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-bg-b07-sweep-'))
    const children: number[] = []
    const spawnSleeper = (): { pid: number; ticks: number | null } => {
      const child = spawn('/bin/sleep', ['30'], { detached: true, stdio: 'ignore' })
      child.unref()
      assert.ok(child.pid && child.pid > 1)
      children.push(child.pid)
      return { pid: child.pid, ticks: readLinuxProcStartTimeTicks(child.pid) }
    }

    try {
      const expiredManaged = spawnSleeper()
      const deadOwnerEph = spawnSleeper()
      const liveDaemon = spawnSleeper()

      const logsDir = join(dir, 'logs')
      mkdirSync(logsDir, { recursive: true })
      const outLog = join(logsDir, '400-ocb_1.stdout.log')
      const outLogPrev = join(logsDir, '400-ocb_1.stdout.log.1')
      writeFileSync(outLog, 'some output\n', 'utf8')
      writeFileSync(outLogPrev, 'prev segment\n', 'utf8')
      const now = Date.now()

      const managedFile = writeSnapshot(dir, {
        id: '400-ocb_1',
        jobId: 'ocb_1',
        pid: expiredManaged.pid,
        pgid: expiredManaged.pid,
        ownerPid: 99_999_991, // dead MCP owner
        startTimeTicks: expiredManaged.ticks,
        sessionKey: 'agent:main:webchat:dm:sess-sweep',
        sessionId: 'sess-sweep',
        commandPreview: 'expired managed',
        startedAt: now - 5_000,
        updatedAt: now - 5_000,
        maxLifetimeAt: now - 100, // already past deadline
        lifecycleClass: 'managed_job',
        stdoutLogPath: outLog,
      })
      const ephFile = writeSnapshot(dir, {
        id: '400-ocb_2',
        jobId: 'ocb_2',
        pid: deadOwnerEph.pid,
        pgid: deadOwnerEph.pid,
        ownerPid: 99_999_992, // dead MCP owner
        startTimeTicks: deadOwnerEph.ticks,
        sessionKey: 'agent:main:webchat:dm:sess-sweep',
        sessionId: 'sess-sweep',
        commandPreview: 'orphaned ephemeral',
        startedAt: now - 1_000,
        updatedAt: now - 1_000,
        maxLifetimeAt: now + 60_000,
        lifecycleClass: 'ephemeral_turn',
      })
      const daemonFile = writeSnapshot(dir, {
        id: '400-ocb_3',
        jobId: 'ocb_3',
        pid: liveDaemon.pid,
        pgid: liveDaemon.pid,
        ownerPid: 99_999_993, // dead MCP owner
        startTimeTicks: liveDaemon.ticks,
        sessionKey: 'agent:main:webchat:dm:sess-sweep',
        sessionId: 'sess-sweep',
        commandPreview: 'long-lived daemon',
        startedAt: now - 5_000,
        updatedAt: now - 5_000,
        maxLifetimeAt: now - 100, // daemons ignore maxLifetimeAt
        lifecycleClass: 'daemon_service',
      })

      const res = await sweepExpiredSessionBgCommands(dir, {
        now: () => now,
        killGraceMs: 120,
        killConfirmMs: 300,
      })
      assert.deepEqual([...res.reapedIds].sort(), ['400-ocb_1', '400-ocb_2'])
      assert.deepEqual([...res.failedIds], [])

      assert.equal(isAlive(expiredManaged.pid), false, 'expired managed_job must be killed by sweeper')
      assert.equal(existsSync(managedFile), false, 'expired managed_job snapshot deleted only after exit')
      assert.equal(existsSync(outLog), false, 'canonical active log file cleaned up')
      assert.equal(existsSync(outLogPrev), false, 'canonical rotated log file cleaned up')
      assert.equal(isAlive(deadOwnerEph.pid), false, 'dead-owner ephemeral_turn must be killed')
      assert.equal(existsSync(ephFile), false)
      assert.equal(isAlive(liveDaemon.pid), true, 'daemon_service must survive sweep')
      assert.equal(existsSync(daemonFile), true)
    } finally {
      for (const pid of children) {
        try {
          process.kill(-pid, 'SIGKILL')
        } catch {
          try {
            process.kill(pid, 'SIGKILL')
          } catch {
            /* ignore */
          }
        }
      }
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('W01: reapSessionBgCommandsByClass scans past the 20-item UI limit and reaps item #23', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-bg-w01-cap-'))
    const alive = new Set<number>()
    try {
      const now = 50_000
      // 22 newer managed_job snapshots (would fill the 20-item UI list)
      for (let i = 1; i <= 22; i++) {
        const pid = 8000 + i
        alive.add(pid)
        writeSnapshot(dir, {
          id: `500-ocb_${i}`,
          jobId: `ocb_${i}`,
          pid,
          pgid: pid,
          ownerPid: 500,
          startTimeTicks: 100,
          sessionKey: 'agent:main:webchat:dm:sess-many',
          sessionId: 'sess-many',
          commandPreview: `managed ${i}`,
          startedAt: now + i,
          updatedAt: now + i,
          maxLifetimeAt: now + 600_000,
          lifecycleClass: 'managed_job',
        })
      }
      // 2 older ephemeral_turn snapshots (#23, #24)
      for (const i of [23, 24]) {
        const pid = 8000 + i
        alive.add(pid)
        writeSnapshot(dir, {
          id: `500-ocb_${i}`,
          jobId: `ocb_${i}`,
          pid,
          pgid: pid,
          ownerPid: 500,
          startTimeTicks: 100,
          sessionKey: 'agent:main:webchat:dm:sess-many',
          sessionId: 'sess-many',
          commandPreview: `ephemeral ${i}`,
          startedAt: now - 100 + i,
          updatedAt: now - 100 + i,
          maxLifetimeAt: now + 600_000,
          lifecycleClass: 'ephemeral_turn',
        })
      }

      const res = await reapSessionBgCommandsByClass(
        { sessionKey: 'agent:main:webchat:dm:sess-many' },
        ['ephemeral_turn'],
        dir,
        {
          now: () => now,
          platform: 'linux',
          readProcStat: (pid) => (alive.has(pid) ? { state: 'S', pgrp: pid, startTimeTicks: 100 } : null),
          listProcPids: () => [...alive],
          sendSignal: (target) => {
            alive.delete(Math.abs(target))
          },
          killGraceMs: 0,
          killConfirmMs: 0,
        },
      )
      assert.deepEqual([...res.reapedIds].sort(), ['500-ocb_23', '500-ocb_24'])
      assert.equal(res.preservedIds.length, 22)
      assert.deepEqual([...res.failedIds], [])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('F01: snapshot log cleanup NEVER unlinks foreign files, sibling job logs, or symlinks outside canonical <registryDir>/logs/<id>.*', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'oc-bg-f01-boundary-'))
    const regDir = join(baseDir, 'registry')
    const logsDir = join(regDir, 'logs')
    mkdirSync(logsDir, { recursive: true })
    const foreignFile = join(baseDir, 'important-user-file.txt')
    const siblingLog = join(logsDir, '600-ocb_99.stdout.log')
    const canonicalSymlink = join(logsDir, '600-ocb_1.stderr.log')
    const canonicalOwnLog = join(logsDir, '600-ocb_1.stdout.log')
    writeFileSync(foreignFile, 'DO NOT DELETE\n', 'utf8')
    writeFileSync(siblingLog, 'SIBLING LOG\n', 'utf8')
    writeFileSync(canonicalOwnLog, 'OWN LOG\n', 'utf8')
    symlinkSync(foreignFile, canonicalSymlink)

    try {
      const now = 50_000
      // Snapshot pointing stdoutLogPath to foreignFile & stderrLogPath to siblingLog (poisoned metadata!)
      writeSnapshot(regDir, {
        id: '600-ocb_1',
        jobId: 'ocb_1',
        pid: 99_999_901,
        pgid: 99_999_901,
        ownerPid: 99_999_902, // dead owner
        startTimeTicks: 100,
        sessionKey: 'agent:main:webchat:dm:sess-f01',
        sessionId: 'sess-f01',
        commandPreview: 'poisoned paths',
        startedAt: now - 1_000,
        updatedAt: now - 1_000,
        maxLifetimeAt: now + 60_000,
        lifecycleClass: 'managed_job',
        stdoutLogPath: foreignFile,
        stderrLogPath: siblingLog,
      })

      listSessionBgCommands('sess-f01', regDir, {
        now: () => now,
        platform: 'linux',
        isProcessAlive: () => false,
        readProcStat: () => null,
        listProcPids: () => [],
      })
      const unlinkDeadline = Date.now() + 1_000
      while (existsSync(canonicalOwnLog) && Date.now() < unlinkDeadline) {
        await new Promise((r) => setTimeout(r, 20))
      }

      assert.equal(existsSync(foreignFile), true, 'foreign file outside logs/ MUST remain untouched')
      assert.equal(existsSync(siblingLog), true, 'sibling job log inside logs/ MUST remain untouched')
      assert.equal(existsSync(canonicalSymlink), true, 'symlink at canonical log path MUST NOT be followed or unlinked')
      assert.equal(existsSync(canonicalOwnLog), false, 'owned canonical regular log file is cleaned up')
    } finally {
      rmSync(baseDir, { recursive: true, force: true })
    }
  })

  it('F02: listSessionBgCommands leaves canonical logs intact while owning MCP process (ownerPid) is still alive', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-bg-f02-live-owner-'))
    const logsDir = join(dir, 'logs')
    mkdirSync(logsDir, { recursive: true })
    const ownLog = join(logsDir, `${process.pid}-ocb_1.stdout.log`)
    writeFileSync(ownLog, 'final-marker\n', 'utf8')
    try {
      const now = 60_000
      writeSnapshot(dir, {
        id: `${process.pid}-ocb_1`,
        jobId: 'ocb_1',
        pid: 99_999_910,
        pgid: 99_999_910,
        ownerPid: process.pid, // live MCP owner!
        startTimeTicks: 100,
        sessionKey: 'agent:main:webchat:dm:sess-f02',
        sessionId: 'sess-f02',
        commandPreview: 'echo final-marker',
        startedAt: now - 500,
        updatedAt: now - 500,
        maxLifetimeAt: now + 60_000,
        lifecycleClass: 'managed_job',
      })
      listSessionBgCommands('sess-f02', dir, {
        now: () => now,
        platform: 'linux',
        isProcessAlive: (pid) => pid === process.pid,
        readProcStat: () => null,
        listProcPids: () => [],
      })
      assert.equal(existsSync(ownLog), true, 'live owner canonical log MUST NOT be unlinked by Gateway list')
      assert.equal(readFileSync(ownLog, 'utf8'), 'final-marker\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('A02: reapSessionBgCommandsByClass returns empty on ENOENT but rethrows real I/O errors (ENOTDIR)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-bg-a02-io-'))
    const notADir = join(dir, 'regular-file')
    writeFileSync(notADir, 'not a dir', 'utf8')
    try {
      const missing = await reapSessionBgCommandsByClass(
        { sessionKey: 'agent:main:webchat:dm:sess-a02' },
        ['ephemeral_turn'],
        join(dir, 'does-not-exist'),
      )
      assert.deepEqual(missing, { reapedIds: [], preservedIds: [], failedIds: [] })

      await assert.rejects(
        () =>
          reapSessionBgCommandsByClass(
            { sessionKey: 'agent:main:webchat:dm:sess-a02' },
            ['ephemeral_turn'],
            notADir,
          ),
        /ENOTDIR/,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
