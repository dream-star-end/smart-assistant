/**
 * Two processes migrate the same persistent index. The late one embeds from a
 * snapshot taken before the other process finishes, then must not DROP the
 * vectors that process already committed. Fake provider, private SQLite only.
 *
 * Both CLIs are child processes so this file can load beside other storage
 * tests that capture OPENCLAUDE_HOME at import time.
 */
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'

const sourceRoot = join(import.meta.dirname, '../../../..')
const thisFile = import.meta.filename

function deadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function stopWorker(child: ChildProcess | undefined): void {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    // already gone
  }
}

function provider(model: string, beforeEmbed?: () => Promise<void>): {
  providerId: string
  backendId: string
  modelId: string
  dimensions: number
  embed: (texts: string[], inputType?: string) => Promise<Float32Array[]>
} {
  return {
    providerId: 'mock',
    backendId: 'acceptance.invalid',
    modelId: model,
    dimensions: 2,
    async embed(texts: string[], _inputType?: string) {
      if (beforeEmbed) await beforeEmbed()
      return texts.map((text) => new Float32Array(text === 'paraphrase' || text.includes('needle') ? [1, 0] : [0, 1]))
    },
  }
}

async function storageAt(home: string): Promise<typeof import('../index.js')> {
  process.env.OPENCLAUDE_HOME = home
  return import(pathToFileURL(join(sourceRoot, 'packages/storage/src/index.ts')).href)
}

async function seed(home: string): Promise<void> {
  const storage = await storageAt(home)
  try {
    const old = provider('old-model')
    await storage.archivalCount('acceptance-agent')
    await storage.initVectorStore(2, old)
    const oldId = await storage.archivalAdd('acceptance-agent', 'haystack original archive')
    await storage.upsertArchivalVector(oldId, new Float32Array([0, 1]))
    process.stdout.write(`${JSON.stringify({ oldId })}\n`)
  } finally {
    await storage.closeSessionsDb()
    storage.resetVectorStore()
  }
}

async function migrateLate(home: string): Promise<void> {
  const storage = await storageAt(home)
  const entered = join(home, 'entered')
  const releasePath = join(home, 'release')
  try {
    const delayed = provider('new-model', async () => {
      await writeFile(entered, '1')
      const started = Date.now()
      while (Date.now() - started < 20_000) {
        try {
          await readFile(releasePath)
          return
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
      }
      throw new Error('timed out waiting for release')
    })
    await storage.initVectorStore(2, delayed)
    const result = JSON.parse(await readFile(join(home, 'result.json'), 'utf8')) as {
      completedId: string
      sessionId: string
      oldId: string
    }
    const db = await storage.getSessionsDb()
    const ids = (db.prepare('SELECT id FROM archival_vec').all() as Array<{ id: string }>).map((row) => row.id)
    const sessionIds = (db.prepare('SELECT id FROM sessions_vec').all() as Array<{ id: string }>).map((row) => row.id)
    assert.ok(ids.includes(result.completedId), 'stale migration erased the archival vector committed by the other process')
    assert.ok(sessionIds.includes(result.sessionId), 'stale migration erased the session vector committed by the other process')
    assert.ok(ids.includes(result.oldId))
  } finally {
    await storage.closeSessionsDb()
    storage.resetVectorStore()
  }
}

async function finishFirst(home: string): Promise<void> {
  const storage = await storageAt(home)
  try {
    const current = provider('new-model')
    await storage.archivalCount('acceptance-agent')
    await storage.initVectorStore(2, current)
    const id = await storage.archivalAdd('acceptance-agent', 'needle newly completed archive')
    const [vec] = await current.embed(['needle newly completed archive'], 'document')
    await storage.upsertArchivalVector(id, vec)
    const sessionId = storage.encodeSessionVecId('needle-session', 0, 'user')
    await storage.upsertSessionVector(sessionId, vec)
    const hits = await storage.hybridArchivalSearch('acceptance-agent', 'paraphrase', current, 2)
    assert.equal(hits[0]?.id, id)
    assert.equal(hits[0]?.bm25Rank, null)
    const seeded = JSON.parse(await readFile(join(home, 'seed.json'), 'utf8')) as { oldId: string }
    await writeFile(join(home, 'result.json'), JSON.stringify({
      completedId: id,
      sessionId,
      oldId: seeded.oldId,
    }))
    process.stdout.write(`${JSON.stringify({ completedId: id, sessionId })}\n`)
  } finally {
    await storage.closeSessionsDb()
    storage.resetVectorStore()
  }
}

function spawnMode(mode: string, home: string): ChildProcess {
  return spawn(join(sourceRoot, 'node_modules/.bin/tsx'), [thisFile, mode, home], {
    cwd: sourceRoot,
    env: { ...process.env, OPENCLAUDE_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
}

async function waitChild(child: ChildProcess, label: string): Promise<{ rc: number | null; stdout: string; stderr: string }> {
  let stdout = ''
  let stderr = ''
  child.stdout!.on('data', (buf) => {
    stdout += String(buf)
  })
  child.stderr!.on('data', (buf) => {
    stderr += String(buf)
  })
  const rc = await deadline(new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', resolve)
  }), 20_000, label)
  return { rc, stdout, stderr }
}

const mode = process.argv[2]
if (mode === '--seed') {
  seed(process.argv[3]).catch((err) => {
    process.stderr.write(`${String(err)}\n`)
    process.exitCode = 1
  })
} else if (mode === '--late') {
  migrateLate(process.argv[3]).catch((err) => {
    process.stderr.write(`${String(err)}\n`)
    process.exitCode = 1
  })
} else if (mode === '--first') {
  finishFirst(process.argv[3]).catch((err) => {
    process.stderr.write(`${String(err)}\n`)
    process.exitCode = 1
  })
} else {
  test('parallel first-start migrations preserve vectors completed during re-embedding', { timeout: 45_000 }, async (t) => {
    const home = await mkdtemp(join(tmpdir(), 'emb-migration-concurrency-'))
    const children: ChildProcess[] = []
    t.signal.addEventListener('abort', () => {
      for (const child of children) stopWorker(child)
    }, { once: true })
    try {
      const seeder = spawnMode('--seed', home)
      children.push(seeder)
      const seeded = await waitChild(seeder, 'seed')
      assert.equal(seeded.rc, 0, seeded.stderr)
      await writeFile(join(home, 'seed.json'), seeded.stdout.trim().split('\n').at(-1)!)

      const late = spawnMode('--late', home)
      children.push(late)
      const enteredAt = Date.now()
      while (Date.now() - enteredAt < 10_000) {
        try {
          await readFile(join(home, 'entered'))
          break
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
      }
      await readFile(join(home, 'entered'))

      const first = spawnMode('--first', home)
      children.push(first)
      const finished = await waitChild(first, 'first migration')
      assert.equal(finished.rc, 0, finished.stderr)
      await writeFile(join(home, 'release'), '1')
      const lateResult = await waitChild(late, 'late migration')
      assert.equal(lateResult.rc, 0, lateResult.stderr)
    } finally {
      for (const child of children) stopWorker(child)
      await rm(home, { recursive: true, force: true })
    }
  })
}
