import { describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  collectProcDescendants,
  killProcessTree,
  parseProcStatIdentity,
  parseProcStatPpid,
  signalIfSameProcess,
} from '../killProcessTree.js'

function syntheticStatLine(pid: number, comm: string, ppid: number, starttime: number): string {
  // Fields 3..22 after `)`: state(3), ppid(4), pgrp(5)..itrealvalue(21), starttime(22)
  const zeros = Array.from({ length: 17 }, () => '0').join(' ')
  return `${pid} (${comm}) S ${ppid} ${zeros} ${starttime} 0 0\n`
}

describe('killProcessTree', () => {
  test('parseProcStatPpid and parseProcStatIdentity handle spaces, newlines, nested parens, and starttime', () => {
    expect(parseProcStatPpid('101 (bash) S 42 101 101 0 -1 4194304')).toBe(42)
    expect(
      parseProcStatPpid('202 (weird (proc) name\nv2) R 101 202 202 0 -1 0'),
    ).toBe(101)
    expect(
      parseProcStatIdentity(syntheticStatLine(303, 'cmd (x)\ny', 202, 987654)),
    ).toEqual({ ppid: 202, starttime: '987654' })
    expect(parseProcStatPpid('malformed stat line')).toBeNull()
  })

  test('collectProcDescendants terminates cleanly on real synthetic /proc parent-child cycles and starttime guard blocks recycled PIDs', () => {
    const fakeProc = mkdtempSync(join(tmpdir(), 'fake-proc-'))
    try {
      for (const [pid, comm, ppid, start] of [
        [100, 'sh', 1, 1000],
        [101, 'python3 (worker)', 100, 1010],
        [102, 'grep (sub)', 101, 1020],
        [103, 'cycle-back', 102, 1030],
        [999, 'unrelated', 1, 9990],
      ] as const) {
        mkdirSync(join(fakeProc, String(pid), 'task', String(pid)), { recursive: true })
        writeFileSync(
          join(fakeProc, String(pid), 'stat'),
          syntheticStatLine(pid, comm, ppid, start),
        )
      }
      // Inject an explicit cycle 103 -> 101 -> 102 -> 103 via task/children
      writeFileSync(join(fakeProc, '103', 'task', '103', 'children'), '101 100\n')
      expect(collectProcDescendants(100, fakeProc)).toEqual([101, 102, 103])

      const delivered: Array<[number, NodeJS.Signals]> = []
      expect(
        signalIfSameProcess(102, '1020', 'SIGKILL', fakeProc, (p, s) => {
          delivered.push([p, s])
        }),
      ).toBe(true)
      expect(delivered).toEqual([[102, 'SIGKILL']])

      // Simulate PID 102 reused by a newer process with starttime 5555
      writeFileSync(
        join(fakeProc, '102', 'stat'),
        syntheticStatLine(102, 'reused-proc', 1, 5555),
      )
      expect(
        signalIfSameProcess(102, '1020', 'SIGKILL', fakeProc, (p, s) => {
          delivered.push([p, s])
        }),
      ).toBe(false)
      expect(delivered).toHaveLength(1)
    } finally {
      rmSync(fakeProc, { recursive: true, force: true })
    }
  })

  test('kills both process group and setsid-escaped grandchild when PATH has no ps', async () => {
    if (process.platform === 'win32') return
    const dir = mkdtempSync(join(tmpdir(), 'kill-tree-live-'))
    const escapedPidFile = join(dir, 'escaped.pid')
    const prevPath = process.env.PATH
    try {
      const py = [
        'import os, time',
        'os.setsid()',
        `open(${JSON.stringify(escapedPidFile)}, 'w').write(str(os.getpid()))`,
        'time.sleep(30)',
      ].join('; ')
      const child = spawn(
        '/bin/sh',
        ['-c', `python3 -c ${JSON.stringify(py)} & sleep 30`],
        { detached: true, stdio: 'ignore' },
      )
      expect(typeof child.pid).toBe('number')

      let escapedPid = 0
      for (let i = 0; i < 50; i++) {
        try {
          escapedPid = Number.parseInt(
            readFileSync(escapedPidFile, 'utf8').trim(),
            10,
          )
          if (escapedPid > 1) break
        } catch {}
        await new Promise(r => setTimeout(r, 40))
      }
      expect(escapedPid).toBeGreaterThan(1)

      process.env.PATH = ''
      killProcessTree(child.pid!, 'SIGKILL')
      process.env.PATH = prevPath

      await new Promise<void>(resolve => {
        if (child.exitCode !== null || child.signalCode !== null) resolve()
        else child.once('exit', () => resolve())
      })

      let escapedAlive = true
      for (let i = 0; i < 30; i++) {
        try {
          process.kill(escapedPid, 0)
          await new Promise(r => setTimeout(r, 40))
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
            escapedAlive = false
            break
          }
        }
      }
      expect(escapedAlive).toBe(false)
    } finally {
      process.env.PATH = prevPath
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
