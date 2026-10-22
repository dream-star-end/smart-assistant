/**
 * OCV5-538(OCV5-488 根因):reap() 找"stdin 是这个 fifo 的进程"时,不得每个进程 fork 一次 readlink。
 * 旧实现对宿主上每个进程起一个子 shell + readlink(v5-dev 约 450 个进程,负载 10–20 时扫描 2.9–6.8 s),
 * 桥关闭时 stop exec 因此必然吃满 2 s 超时 + 0.3 s grace,高负载下撑破发布门的 5 s 关闭窗口。
 * 现在用 shell 内建 `[ A -ef B ]` 比 inode,不 fork。窗口不变,只让关闭本身变快。
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, test } from 'node:test'
import { BOX_CC_REAP_FUNCTION } from '../engine/cursorBoxCcExec.js'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('Box CC reap() (OCV5-538)', () => {
  test('ends the process reading the fifo without forking readlink per process', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-reap-'))
    dirs.push(dir)
    const fifo = join(dir, 's.1.fifo')
    assert.equal(spawnSync('mkfifo', ['-m', '600', fifo]).status, 0)
    // stdin = the fifo (read-write open never blocks), like the launch script's Claude.
    const reader = spawn('sh', ['-c', 'exec sleep 60 <>"$1"', 'sh', fifo], { stdio: 'ignore' })
    const bystander = spawn('sleep', ['60'], { stdio: 'ignore' })
    try {
      await new Promise((r) => setTimeout(r, 200))
      assert.ok(reader.pid && alive(reader.pid))
      // A readlink on PATH that only counts its calls: the reap must not need it.
      const bin = join(dir, 'bin')
      spawnSync('mkdir', [bin])
      const count = join(dir, 'readlink.calls')
      writeFileSync(join(bin, 'readlink'), `#!/bin/sh\necho x >>'${count}'\nexec /usr/bin/readlink "$@"\n`)
      chmodSync(join(bin, 'readlink'), 0o755)
      const script = [...BOX_CC_REAP_FUNCTION, 'reap "$1"'].join('\n')
      const t0 = Date.now()
      const r = spawnSync('sh', ['-c', script, 'sh', fifo], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        encoding: 'utf8',
      })
      const ms = Date.now() - t0
      assert.equal(r.status, 0, r.stderr)
      assert.equal(existsSync(count) ? readFileSync(count, 'utf8').split('\n').filter(Boolean).length : 0, 0,
        'reap forked readlink')
      await new Promise((res) => reader.once('exit', res))
      assert.ok(bystander.pid && alive(bystander.pid), 'a process not reading the fifo is left alone')
      assert.ok(ms < 2_500, `reap took ${ms} ms`)
    } finally {
      reader.kill('SIGKILL')
      bystander.kill('SIGKILL')
    }
  })

  test('no reader: returns at once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-reap-'))
    dirs.push(dir)
    const fifo = join(dir, 'none.fifo')
    spawnSync('mkfifo', [fifo])
    const r = spawnSync('sh', ['-c', [...BOX_CC_REAP_FUNCTION, 'reap "$1"; echo done'].join('\n'), 'sh', fifo], {
      encoding: 'utf8',
    })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.stdout.trim(), 'done')
  })
})
