import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, test } from 'node:test'

import {
  OCR_RESULT_RETENTION_MS,
  ScnetResultHttpError,
  downloadScnetResultJson,
  gcScnetOcrResults,
} from '../ocr/scnetResultDownload.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true })))
})

describe('SCNet pinned result download', () => {
  test('keeps the dispatcher open until a slow response body is complete', async () => {
    let closed = false
    const chunks = ['{"documents":', '[]', '}']
    const response = new Response(
      new ReadableStream({
        async pull(controller) {
          await new Promise((done) => setTimeout(done, 30))
          assert.equal(closed, false)
          const chunk = chunks.shift()
          if (chunk === undefined) controller.close()
          else controller.enqueue(new TextEncoder().encode(chunk))
        },
      }),
    )
    const result = await downloadScnetResultJson('https://results.example/path?signature=x', {
      resolver: {
        resolve4: async () => ['203.0.114.10'],
        resolve6: async () => [],
      },
      makeDispatcher: (() => ({
        close: async () => {
          closed = true
        },
      })) as any,
      fetchImpl: async (_url, init) => {
        assert.equal(init.redirect, 'error')
        assert.equal('signal' in init, false)
        return response
      },
    })
    assert.deepEqual(result, { documents: [] })
    assert.equal(closed, true)
  })

  test('rejects private DNS answers before fetch', async () => {
    let fetched = false
    await assert.rejects(
      downloadScnetResultJson('https://results.example/file', {
        resolver: {
          resolve4: async () => ['127.0.0.1'],
          resolve6: async () => [],
        },
        fetchImpl: async () => {
          fetched = true
          return Response.json({})
        },
      }),
      /global unicast/,
    )
    assert.equal(fetched, false)
  })

  test('rejects redirects and closes the dispatcher', async () => {
    let closed = false
    await assert.rejects(
      downloadScnetResultJson('https://results.example/file', {
        resolver: {
          resolve4: async () => ['203.0.114.10'],
          resolve6: async () => [],
        },
        makeDispatcher: (() => ({
          close: async () => {
            closed = true
          },
        })) as any,
        fetchImpl: async () => new Response(null, { status: 302 }),
      }),
      (error: unknown) => error instanceof ScnetResultHttpError && error.status === 302,
    )
    assert.equal(closed, true)
  })
})

describe('SCNet result retention GC', () => {
  test('drains every expired DB batch and removes only stale untracked directories', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'oc-scnet-gc-'))
    tempDirs.push(root)
    const userDirectory = path.join(root, '42')
    const orphan = path.join(userDirectory, 'orphan')
    const tracked = path.join(userDirectory, 'tracked')
    const fresh = path.join(userDirectory, 'fresh')
    for (const directory of [orphan, tracked, fresh]) {
      await mkdir(directory, { recursive: true })
      await writeFile(path.join(directory, 'result.md'), directory)
    }
    const now = Date.now()
    const old = new Date(now - OCR_RESULT_RETENTION_MS - 1_000)
    await utimes(orphan, old, old)
    await utimes(tracked, old, old)

    let batch = 0
    let deletedExpired = 0
    await gcScnetOcrResults({
      resultDir: root,
      now,
      store: {
        listExpired: async () => {
          batch += 1
          const count = batch === 1 ? 100 : batch === 2 ? 1 : 0
          return Array.from({ length: count }, (_, index) => ({
            id: `expired-${batch}-${index}`,
            userId: 42,
            markdownPath: null,
            jsonlPath: null,
          }))
        },
        deleteExpired: async () => {
          deletedExpired += 1
        },
        get: async (_userId, id) => (id === 'tracked' ? ({} as any) : null),
      },
    })

    assert.equal(deletedExpired, 101)
    await assert.rejects(stat(orphan), (error: unknown) => {
      return (error as NodeJS.ErrnoException).code === 'ENOENT'
    })
    assert.equal((await stat(tracked)).isDirectory(), true)
    assert.equal((await stat(fresh)).isDirectory(), true)
  })
})
