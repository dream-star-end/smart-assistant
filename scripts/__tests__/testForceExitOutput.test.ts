import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PRELOAD = './scripts/lib/test-blocking-stdio.mjs'

/** A child that queues `bytes` on its stdout pipe and exits at once, as a
 * test file does under --test-force-exit. The reader starts half a second
 * late, so the pipe is full when the child exits. Returns the bytes read. */
function exitWithQueuedOutput(bytes: number, preload: boolean): number {
  const script = `process.stdout.write("x".repeat(${bytes})); process.exit(0);`
  const node = [process.execPath, ...(preload ? ['--import', PRELOAD] : []), '-e', script]
    .map((arg) => `'${arg}'`).join(' ')
  const out = execFileSync('sh', ['-c', `${node} | (sleep 0.5; wc -c)`],
    { cwd: root, encoding: 'utf8' })
  return Number(out.trim())
}

describe('--test-force-exit keeps every test result', () => {
  const bytes = 4 * 1024 * 1024

  it('a child that exits with output queued on a pipe loses it', () => {
    assert.ok(exitWithQueuedOutput(bytes, false) < bytes)
  })

  it('the preload makes the same child deliver all of it', () => {
    assert.equal(exitWithQueuedOutput(bytes, true), bytes)
  })

  it('every force-exit runner loads the preload', () => {
    const sources = ['package.json',
      ...readdirSync(join(root, '.github/scripts')).filter((name) => name.endsWith('.sh'))
        .map((name) => `.github/scripts/${name}`)]
    let commands = 0
    for (const source of sources) {
      for (const line of readFileSync(join(root, source), 'utf8').split('\n')) {
        if (line.trimStart().startsWith('#')) continue
        for (const match of line.matchAll(/npx tsx ([^$'"]*?)--test-force-exit/g)) {
          commands += 1
          assert.ok(match[1]!.includes(`--import ${PRELOAD} `), `${source}: ${match[0]}`)
        }
      }
    }
    assert.equal(commands, 4)
  })
})
