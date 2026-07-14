import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'sessionManager.ts'), 'utf8')
const submitStart = source.indexOf('  async submit(')
const submitEnd = source.indexOf('  private async runOneTurnWithRetry(', submitStart)
const submit = source.slice(submitStart, submitEnd)

test('commercial foreground turns hold the shared memory barrier until submit finally', () => {
  assert.ok(submitStart >= 0 && submitEnd > submitStart, 'submit method must be extractable')
  const serialized = submit.indexOf('await prev')
  const acquired = submit.indexOf(
    'memoryTurnBarrier = await new MemoryDir(session.agentId).acquireSharedBarrier()',
  )
  const modelRun = submit.indexOf('this.runOneTurnWithRetry(')
  const released = submit.indexOf('await memoryTurnBarrier?.release().catch(() => {})')
  const sessionReleased = submit.lastIndexOf('release()')

  assert.ok(
    serialized >= 0 && acquired > serialized,
    'barrier is acquired only after turn serialization',
  )
  assert.ok(modelRun > acquired, 'barrier must cover the native model/tool turn')
  assert.ok(released > modelRun, 'barrier must remain held through model/tool completion')
  assert.ok(
    sessionReleased > released,
    'barrier must release before the next serialized turn starts',
  )
  assert.match(
    submit,
    /isCommercialManagedRuntime\(\) && session\.channel !== 'auto-dream'/,
    'only managed foreground turns hold the barrier; the hermetic Auto-Dream turn is excluded',
  )
})
