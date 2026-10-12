/**
 * Thin subprocess wrapper for openclaudePromptTrim.runner.ts (OCV5-382): it
 * imports prompts.ts, which must not see mock.module() calls from other test
 * files in the same bun test batch (same pattern as promptEngineeringAudit).
 */

import { describe, test } from 'bun:test'
import { relative, resolve } from 'node:path'

const PROJECT_ROOT = resolve(__dirname, '..', '..', '..')
const RUNNER_ABS = resolve(__dirname, '..', 'openclaudePromptTrim.runner.ts')
const RUNNER_REL = `./${relative(PROJECT_ROOT, RUNNER_ABS).replace(/\\/g, '/')}`

describe('OpenClaude runner drops upstream product text (OCV5-382)', () => {
  test('runs in an isolated subprocess', async () => {
    const proc = Bun.spawn(['bun', 'test', RUNNER_REL], {
      cwd: PROJECT_ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const code = await proc.exited
    if (code !== 0) {
      const stderr = await new Response(proc.stderr).text()
      const stdout = await new Response(proc.stdout).text()
      throw new Error(
        `prompt trim subprocess failed (exit ${code}):\n${`${stderr}\n${stdout}`.slice(-3000)}`,
      )
    }
  }, 60_000)
})
