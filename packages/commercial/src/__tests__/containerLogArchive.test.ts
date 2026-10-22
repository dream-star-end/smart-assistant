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
// OCV5-568 (plan §7.5): logs are saved before a turn-runtime container is removed; saving never
// blocks removal; the archive is bounded; and no new removal path can bypass the helper.
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  type RemovableContainer,
  containerLogArchiveStats,
  demuxDockerLogs,
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

function fakeContainer(
  over: Partial<RemovableContainer> & { logsImpl?: () => Promise<Buffer> } = {},
) {
  const calls: string[] = []
  const c: RemovableContainer = {
    id: 'abcdef0123456789',
    logs: async () => {
      calls.push('logs')
      return over.logsImpl
        ? over.logsImpl()
        : Buffer.concat([frame(1, 'out line\n'), frame(2, 'err line\n')])
    },
    remove: async (opts) => {
      calls.push(`remove:${opts.force}`)
      if (over.remove) return over.remove(opts)
      return undefined
    },
  }
  return { c, calls }
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

describe('container log archive', () => {
  test('demux: framed stdout/stderr are joined without headers; TTY or malformed input is returned as is', () => {
    assert.equal(
      demuxDockerLogs(Buffer.concat([frame(1, 'a\n'), frame(2, 'b\n')])).toString(),
      'a\nb\n',
    )
    assert.equal(
      demuxDockerLogs(Buffer.from('plain tty output\n')).toString(),
      'plain tty output\n',
    )
    const truncated = frame(1, 'abcdef').subarray(0, 10)
    assert.deepEqual(demuxDockerLogs(truncated), truncated)
  })

  test('logs are saved (demuxed, 0600) before removal, which runs with force', async (t) => {
    const dir = tmp(t)
    const { c, calls } = fakeContainer()
    await removeContainerSavingLogs(c, 'stop_and_remove', {
      dir,
      now: () => new Date('2026-10-22T01:02:03.456Z'),
    })
    assert.deepEqual(calls, ['logs', 'remove:true'])
    const files = readdirSync(dir)
    assert.deepEqual(files, ['abcdef012345-2026-10-22T01-02-03-456Z-stop_and_remove.log'])
    assert.equal(readFileSync(path.join(dir, files[0]!), 'utf8'), 'out line\nerr line\n')
    assert.equal(statSync(path.join(dir, files[0]!)).mode & 0o777, 0o600)
  })

  test('a log larger than the cap keeps its end (where the crash is)', async (t) => {
    const dir = tmp(t)
    const { c } = fakeContainer({ logsImpl: async () => frame(1, `${'x'.repeat(100)}CRASH`) })
    await removeContainerSavingLogs(c, 'r', { dir, maxBytes: 10 })
    assert.equal(readFileSync(path.join(dir, readdirSync(dir)[0]!), 'utf8'), 'xxxxxCRASH')
  })

  test('a failed or slow save never blocks removal; it is warned and counted (404 is silent)', async (t) => {
    const dir = tmp(t)
    const before = containerLogArchiveStats().failed
    const cap = captureLog()
    const broken = fakeContainer({
      logsImpl: async () => {
        throw Object.assign(new Error('daemon busy'), { statusCode: 500 })
      },
    })
    await removeContainerSavingLogs(broken.c, 'r', { dir, log: cap.log })
    assert.deepEqual(broken.calls, ['logs', 'remove:true'])
    assert.equal(
      cap.lines.filter((l) => l.msg === 'container logs not saved before removal').length,
      1,
    )
    const slow = fakeContainer({ logsImpl: () => new Promise(() => {}) })
    const t0 = Date.now()
    await removeContainerSavingLogs(slow.c, 'r', { dir, log: cap.log, timeoutMs: 50 })
    assert.ok(Date.now() - t0 < 2000)
    assert.deepEqual(slow.calls, ['logs', 'remove:true'])
    const gone = fakeContainer({
      logsImpl: async () => {
        throw Object.assign(new Error('no such container'), { statusCode: 404 })
      },
    })
    await removeContainerSavingLogs(gone.c, 'r', { dir, log: cap.log })
    assert.equal(cap.lines.length, 2, '404 adds no warning')
    assert.equal(containerLogArchiveStats().failed, before + 2)
  })

  test('removal errors propagate unchanged, and force can be turned off', async (t) => {
    const dir = tmp(t)
    const notFound = Object.assign(new Error('gone'), { statusCode: 404 })
    const { c } = fakeContainer({
      remove: async () => {
        throw notFound
      },
    })
    await assert.rejects(removeContainerSavingLogs(c, 'r', { dir }), (e) => e === notFound)
    const soft = fakeContainer()
    await removeContainerSavingLogs(soft.c, 'r', { dir, force: false })
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
      'plugins/knowledgePlanet.ts': { count: 4, why: 'plugin browser sandbox, not a turn runtime' },
      'plugins/weibo.ts': { count: 4, why: 'plugin browser sandbox, not a turn runtime' },
      'plugins/zhihu.ts': { count: 4, why: 'plugin browser sandbox, not a turn runtime' },
      'plugins/localSandbox.ts': { count: 1, why: 'plugin local sandbox, not a turn runtime' },
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
