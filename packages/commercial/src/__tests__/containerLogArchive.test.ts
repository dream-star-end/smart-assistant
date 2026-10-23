// OCV5-568 (plan §7.5): logs are saved before a turn-runtime container is removed; saving never
// blocks removal; memory and the archive are bounded; and no new removal path can bypass the helper.
import assert from 'node:assert/strict'
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  type LogStreamOpener,
  type RemovableContainer,
  TailDemuxer,
  containerLogArchiveStats,
  pruneContainerLogArchive,
  removeContainerSavingLogs,
} from '../compute-pool/containerLogArchive.js'
import { createLogger } from '../logging/logger.js'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function frame(stream: 1 | 2, text: string): Buffer {
  const body = Buffer.from(text)
  const h = Buffer.alloc(8)
  h[0] = stream
  h.writeUInt32BE(body.length, 4)
  return Buffer.concat([h, body])
}

function fakeContainer(over: { remove?: RemovableContainer['remove'] } = {}) {
  const calls: string[] = []
  const c: RemovableContainer = {
    id: 'abcdef0123456789',
    remove: async (opts) => {
      calls.push(`remove:${opts.force}`)
      if (over.remove) return over.remove(opts)
      return undefined
    },
  }
  return { c, calls }
}

/** An opener that records the call and returns the given chunks as a stream. */
function opener(calls: string[], chunks: Buffer[]): LogStreamOpener {
  return async () => {
    calls.push('logs')
    return Readable.from(chunks)
  }
}

function tmp(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ctr-logs-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function captureLog() {
  const lines: Record<string, unknown>[] = []
  return {
    lines,
    log: createLogger({
      level: 'debug',
      out: (l) => {
        lines.push(JSON.parse(l))
      },
    }),
  }
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('container log archive', () => {
  test('demux: frames are stripped even when a header is split across reads; TTY input is kept as is', () => {
    const d = new TailDemuxer(1024)
    const all = Buffer.concat([frame(1, 'a\n'), frame(2, 'b\n')])
    // splits inside the first header, inside the first body, and inside the second header
    for (const [a, b] of [[0, 3], [3, 9], [9, 12], [12, all.length]]) d.push(all.subarray(a, b))
    assert.equal(d.result().toString(), 'a\nb\n')
    const tty = new TailDemuxer(1024)
    tty.push(Buffer.from('plain tty output\n'))
    assert.equal(tty.result().toString(), 'plain tty output\n')
  })

  test('Codex r1: memory is bounded while reading — only about the last maxBytes are held', () => {
    const max = 64 * 1024
    const d = new TailDemuxer(max)
    const line = frame(1, `${'y'.repeat(16 * 1024 - 1)}\n`)
    for (let i = 0; i < 4096; i++) d.push(line) // 64 MiB of log through a 64 KiB tail
    d.push(frame(2, 'CRASH\n'))
    const held = (d as unknown as { total: number }).total
    assert.ok(held <= max + line.length, `held ${held} bytes`)
    const r = d.result()
    assert.equal(r.length, max)
    assert.ok(r.toString().endsWith('CRASH\n'))
  })

  test('the docker opener asks for a non-follow stream with the abort signal (never the buffering logs())', async () => {
    let seen: Record<string, unknown> | undefined
    const c: RemovableContainer = {
      id: 'abcdef0123456789',
      remove: async () => undefined,
      modem: {
        dial: (opts, cb) => {
          seen = opts as Record<string, unknown>
          cb(null, Readable.from([frame(1, 'x\n')]))
        },
      },
    }
    const dir = mkdtempSync(path.join(tmpdir(), 'ctr-logs-'))
    try {
      await removeContainerSavingLogs(c, 'r', { dir })
      assert.equal(seen?.path, '/containers/abcdef0123456789/logs?')
      assert.equal(seen?.isStream, true)
      assert.ok(seen?.abortSignal instanceof AbortSignal)
      assert.deepEqual(seen?.options, { stdout: true, stderr: true, timestamps: true, tail: 20_000 })
      assert.equal(readFileSync(path.join(dir, readdirSync(dir)[0]!), 'utf8'), 'x\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('logs are saved (demuxed, 0600) before removal, which runs with force', async (t) => {
    const dir = tmp(t)
    const { c, calls } = fakeContainer()
    await removeContainerSavingLogs(c, 'stop_and_remove', {
      dir,
      now: () => new Date('2026-10-22T01:02:03.456Z'),
      openLogs: opener(calls, [frame(1, 'out line\n'), frame(2, 'err line\n')]),
    })
    assert.deepEqual(calls, ['logs', 'remove:true'])
    const files = readdirSync(dir)
    assert.deepEqual(files, ['abcdef012345-2026-10-22T01-02-03-456Z-stop_and_remove.log'])
    assert.equal(readFileSync(path.join(dir, files[0]!), 'utf8'), 'out line\nerr line\n')
    assert.equal(statSync(path.join(dir, files[0]!)).mode & 0o777, 0o600)
  })

  test('a log larger than the cap keeps its end (where the crash is)', async (t) => {
    const dir = tmp(t)
    const { c, calls } = fakeContainer()
    const openLogs = opener(calls, [frame(1, `${'x'.repeat(100)}CRASH`)])
    await removeContainerSavingLogs(c, 'r', { dir, maxBytes: 10, openLogs })
    assert.equal(readFileSync(path.join(dir, readdirSync(dir)[0]!), 'utf8'), 'xxxxxCRASH')
  })

  test('a failed save never blocks removal; it is warned and counted (404 is silent)', async (t) => {
    const dir = tmp(t)
    const before = containerLogArchiveStats().failed
    const cap = captureLog()
    const broken = fakeContainer()
    await removeContainerSavingLogs(broken.c, 'r', {
      dir,
      log: cap.log,
      openLogs: async () => {
        throw Object.assign(new Error('daemon busy'), { statusCode: 500 })
      },
    })
    assert.deepEqual(broken.calls, ['remove:true'])
    const gone = fakeContainer()
    await removeContainerSavingLogs(gone.c, 'r', {
      dir,
      log: cap.log,
      openLogs: async () => {
        throw Object.assign(new Error('no such container'), { statusCode: 404 })
      },
    })
    const noModem = fakeContainer()
    await removeContainerSavingLogs(noModem.c, 'r', { dir, log: cap.log })
    assert.deepEqual(noModem.calls, ['remove:true'])
    assert.equal(
      cap.lines.filter((l) => l.msg === 'container logs not saved before removal').length,
      2,
      '404 adds no warning',
    )
    assert.equal(containerLogArchiveStats().failed, before + 2)
  })

  test('Codex r1: a response that comes after the deadline is dropped — nothing is written after removal', async (t) => {
    const dir = tmp(t)
    let late: PassThrough | undefined
    const { c, calls } = fakeContainer()
    const t0 = Date.now()
    await removeContainerSavingLogs(c, 'r', {
      dir,
      timeoutMs: 10,
      log: captureLog().log,
      openLogs: async () => {
        await delay(40)
        late = new PassThrough()
        late.end(frame(1, 'x'.repeat(100)))
        return late
      },
    })
    assert.ok(Date.now() - t0 < 1000)
    assert.deepEqual(calls, ['remove:true'])
    await delay(80)
    assert.deepEqual(readdirSync(dir), [])
    assert.equal(late?.destroyed, true)
  })

  test('Codex r1: a read still running at the deadline is cut, saved with a note, and pruned in the same call', async (t) => {
    const dir = tmp(t)
    const cap = captureLog()
    writeFileSync(path.join(dir, 'older.log'), 'o'.repeat(100))
    utimesSync(path.join(dir, 'older.log'), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
    const s = new PassThrough()
    const { c, calls } = fakeContainer()
    const t0 = Date.now()
    const done = removeContainerSavingLogs(c, 'r', {
      dir,
      timeoutMs: 50,
      maxTotalBytes: 150,
      log: cap.log,
      openLogs: async () => s,
    })
    s.write(frame(1, 'first lines\n')) // the stream never ends
    await done
    assert.ok(Date.now() - t0 < 1000)
    assert.deepEqual(calls, ['remove:true'])
    assert.equal(s.destroyed, true)
    const files = readdirSync(dir)
    assert.equal(files.length, 1, 'the older file was pruned to fit the total')
    assert.match(readFileSync(path.join(dir, files[0]!), 'utf8'), /^first lines\n\n\[oc: log save cut/)
    assert.equal(cap.lines.filter((l) => l.msg === 'container logs cut at save deadline').length, 1)
  })

  test('removal errors propagate unchanged, and force can be turned off', async (t) => {
    const dir = tmp(t)
    const notFound = Object.assign(new Error('gone'), { statusCode: 404 })
    const { c, calls } = fakeContainer({
      remove: async () => {
        throw notFound
      },
    })
    await assert.rejects(
      removeContainerSavingLogs(c, 'r', { dir, openLogs: opener(calls, []) }),
      (e) => e === notFound,
    )
    const soft = fakeContainer()
    await removeContainerSavingLogs(soft.c, 'r', {
      dir,
      force: false,
      openLogs: opener(soft.calls, []),
    })
    assert.deepEqual(soft.calls, ['logs', 'remove:false'])
  })

  test('prune: files past the age limit go, then the oldest until the total fits', async (t) => {
    const dir = tmp(t)
    const now = new Date('2026-11-01T00:00:00Z')
    const put = (name: string, bytes: number, daysAgo: number) => {
      const f = path.join(dir, name)
      writeFileSync(f, 'x'.repeat(bytes))
      const at = new Date(now.getTime() - daysAgo * 86_400_000)
      utimesSync(f, at, at)
    }
    put('old.log', 10, 20)
    put('a.log', 50, 3)
    put('b.log', 50, 2)
    put('c.log', 50, 1)
    put('keep.txt', 999, 30)
    const removed = await pruneContainerLogArchive({
      dir,
      now: () => now,
      maxAgeDays: 14,
      maxTotalBytes: 100,
    })
    assert.equal(removed, 2)
    assert.deepEqual(readdirSync(dir).sort(), ['b.log', 'c.log', 'keep.txt'])
  })

  test('every container removal in commercial/src goes through the helper or is a listed exception', () => {
    // Exceptions are not turn runtimes: plugin browser sandboxes and the channel-migration cutover
    // (which keeps volumes, v:false). Counts are pinned so a new call in these files is red too.
    const allowed: Record<string, { count: number; why: string }> = {
      'compute-pool/containerLogArchive.ts': {
        count: 2,
        why: 'the helper itself (its doc comment and the call)',
      },
      'channelMigration/cutover.ts': { count: 1, why: 'migration cutover, keeps volumes' },
      'plugins/biliAccount.ts': { count: 4, why: 'plugin browser sandbox, not a turn runtime' },
      'plugins/douyin.ts': { count: 4, why: 'plugin browser sandbox, not a turn runtime' },
      'plugins/knowledgePlanet.ts': { count: 4, why: 'plugin browser sandbox, not a turn runtime' },
      'plugins/weibo.ts': { count: 4, why: 'plugin browser sandbox, not a turn runtime' },
      'plugins/zhihu.ts': { count: 4, why: 'plugin browser sandbox, not a turn runtime' },
      'plugins/localSandbox.ts': { count: 1, why: 'plugin local sandbox, not a turn runtime' },
      'media-studio/compose/runner.ts': {
        count: 4,
        why: 'one-shot ffmpeg compose sandbox (OCV5-588), not a turn runtime; its output is captured by the runner over attach (the 4th removes a container whose create answered after the setup deadline)',
      },
    }
    const found: Record<string, number> = {}
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) {
          if (e.name !== '__tests__' && e.name !== 'node_modules') walk(p)
        } else if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name)) {
          const n = (readFileSync(p, 'utf8').match(/\.remove\(\s*\{/g) ?? []).length
          if (n) found[path.relative(SRC, p).split(path.sep).join('/')] = n
        }
      }
    }
    walk(SRC)
    const unexpected = Object.entries(found).filter(([f, n]) => allowed[f]?.count !== n)
    assert.deepEqual(
      unexpected,
      [],
      'container removed outside removeContainerSavingLogs (or a new call in an allowed file)',
    )
  })
})
