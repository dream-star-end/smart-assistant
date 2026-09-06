import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { killProcessGroup } from '../processGroupShutdown.js'

describe('killProcessGroup — B3 process tree termination', () => {
  it('linux sends the process-group signal (-pid) and does not spawn taskkill', () => {
    const kills: Array<[number, NodeJS.Signals]> = []
    const spawns: string[][] = []
    killProcessGroup(
      { pid: 4242, kill() { throw new Error('direct kill must not run after group success') } },
      'SIGKILL',
      {
        platform: 'linux',
        kill: (pid, signal) => {
          kills.push([pid, signal as NodeJS.Signals])
          return true
        },
        spawnSync: (command, args) => {
          spawns.push([String(command), ...(args ?? []).map(String)])
          return { status: 0 } as never
        },
      },
    )
    assert.deepEqual(kills, [[-4242, 'SIGKILL']])
    assert.deepEqual(spawns, [])
  })

  it('linux falls back to proc.kill when group kill throws', () => {
    let direct = 0
    killProcessGroup(
      {
        pid: 7,
        kill(signal) {
          direct += 1
          assert.equal(signal, 'SIGTERM')
          return true
        },
      },
      'SIGTERM',
      {
        platform: 'linux',
        kill: () => {
          throw new Error('ESRCH')
        },
      },
    )
    assert.equal(direct, 1)
  })

  it('win32 uses taskkill /T /F /PID <pid> and does not process.kill(-pid)', () => {
    const kills: number[] = []
    const spawns: string[][] = []
    let direct = 0
    killProcessGroup(
      {
        pid: 99,
        kill() {
          direct += 1
          return true
        },
      },
      'SIGKILL',
      {
        platform: 'win32',
        kill: (pid) => {
          kills.push(pid)
          return true
        },
        spawnSync: (command, args) => {
          spawns.push([String(command), ...(args ?? []).map(String)])
          return { status: 0 } as never
        },
      },
    )
    assert.deepEqual(kills, [])
    assert.deepEqual(spawns, [['taskkill', '/T', '/F', '/PID', '99']])
    assert.equal(direct, 1)
  })
})
