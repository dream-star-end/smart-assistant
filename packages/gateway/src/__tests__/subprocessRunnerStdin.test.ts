import assert from 'node:assert/strict'
import test from 'node:test'
import { SubprocessRunner } from '../subprocessRunner.js'

// submit() must not let a failed stdin write masquerade as a delivered prompt.
// A runner whose stdin was already ended makes write() EITHER throw synchronously
// (ERR_STREAM_WRITE_AFTER_END) OR — more commonly — return false and fire an
// async 'error' event that does NOT reject submit(). In both cases the prompt
// never reaches the subprocess; if submit() resolved anyway, _runOneTurn would
// wait forever for stdout and the run would be stuck `running`. We build the
// instance via the prototype so no real process is spawned.

test('submit fast-rejects when stdin is no longer writable (ended/destroyed) — async-error path', async () => {
  const runner: any = Object.create(SubprocessRunner.prototype)
  runner.opts = { sessionKey: 'test-session' }
  let writes = 0
  // writable=false models an ended/destroyed stream: real Node write() here
  // returns false + emits an async 'error' (no synchronous throw) — exactly the
  // path that previously slipped through and hung the turn forever.
  runner.proc = {
    stdin: {
      writable: false,
      write() {
        writes++
        return false
      },
    },
  }
  await assert.rejects(() => runner.submit('hello'), /not writable/)
  assert.equal(writes, 0) // must fail BEFORE attempting the write
})

test('submit rethrows a synchronous stdin write failure instead of swallowing it', async () => {
  const runner: any = Object.create(SubprocessRunner.prototype)
  runner.opts = { sessionKey: 'test-session' }
  let writes = 0
  // writable=true but write() throws synchronously — models the narrow race
  // where the stream goes unwritable between the guard and the write.
  runner.proc = {
    stdin: {
      writable: true,
      write() {
        writes++
        const err: any = new Error('write after end')
        err.code = 'ERR_STREAM_WRITE_AFTER_END'
        throw err
      },
    },
  }
  await assert.rejects(() => runner.submit('hello'), /write after end/)
  assert.equal(writes, 1)
})

test('submit resolves and writes one SDK user line on success', async () => {
  const runner: any = Object.create(SubprocessRunner.prototype)
  runner.opts = { sessionKey: 'test-session' }
  const lines: string[] = []
  runner.proc = {
    stdin: {
      writable: true,
      write(s: string) {
        lines.push(s)
      },
    },
  }
  await runner.submit('hello')
  assert.equal(lines.length, 1)
  assert.match(lines[0], /"type":"user"/)
  assert.match(lines[0], /"text":"hello"/)
})
