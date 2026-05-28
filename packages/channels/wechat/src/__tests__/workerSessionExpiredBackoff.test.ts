import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

const WORKER_SRC = readFileSync(resolve(import.meta.dirname, '..', 'worker.ts'), 'utf-8')

function extractTopLevelFn(source: string, name: string): string {
  const lines = source.split('\n')
  const headerIdx = lines.findIndex((l) =>
    new RegExp(`^(export\\s+)?function\\s+${name}\\s*\\(`).test(l),
  )
  if (headerIdx === -1) throw new Error(`function ${name} not found`)
  let endIdx = headerIdx + 1
  for (; endIdx < lines.length; endIdx++) {
    if (/^\}\s*$/.test(lines[endIdx])) break
  }
  return lines
    .slice(headerIdx, endIdx + 1)
    .join('\n')
    .replace(/^export\s+/, '')
    .replace(/:\s*number/g, '')
    .replace(/:\s*boolean/g, '')
}

const helpers = new Function(
  `const SESSION_EXPIRED_BASE_BACKOFF_MS = 5_000;
   const SESSION_EXPIRED_MAX_BACKOFF_MS = 60_000;
   ${extractTopLevelFn(WORKER_SRC, 'sessionExpiredBackoffMs')}
   ${extractTopLevelFn(WORKER_SRC, 'shouldLogSessionExpired')}
   return { sessionExpiredBackoffMs, shouldLogSessionExpired };`,
)() as {
  sessionExpiredBackoffMs: (consecutiveExpired: number) => number
  shouldLogSessionExpired: (consecutiveExpired: number, nowMs: number, nextLogAtMs: number) => boolean
}

const { sessionExpiredBackoffMs, shouldLogSessionExpired } = helpers

describe('WechatWorker session-expired backoff helpers', () => {
  it('backs off 5s → 10s → 20s → 40s → 60s cap', () => {
    assert.equal(sessionExpiredBackoffMs(1), 5_000)
    assert.equal(sessionExpiredBackoffMs(2), 10_000)
    assert.equal(sessionExpiredBackoffMs(3), 20_000)
    assert.equal(sessionExpiredBackoffMs(4), 40_000)
    assert.equal(sessionExpiredBackoffMs(5), 60_000)
    assert.equal(sessionExpiredBackoffMs(99), 60_000)
  })

  it('logs first expiry and then only after the next log deadline', () => {
    assert.equal(shouldLogSessionExpired(1, 1_000, 999_999), true)
    assert.equal(shouldLogSessionExpired(2, 2_000, 10_000), false)
    assert.equal(shouldLogSessionExpired(9, 10_000, 10_000), true)
  })
})
