/**
 * Import-time isolation for CCB spawn wiring tests.
 *
 * Must be the first import in the test file (and in the wiring helper) so
 * storage `paths.HOME` freezes onto this sandbox, not the live agent home.
 * This file must not import product modules — ESM imports would evaluate
 * them before the env assignments below.
 * TMPDIR stays the short `/tmp` path — long generated prefixes break tsx IPC.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after } from 'node:test'

const originalEnv = { ...process.env }
const root = mkdtempSync('/tmp/ocv5-213-a9-')
const home = join(root, 'home')
const openclaudeHome = join(home, '.openclaude')
mkdirSync(join(openclaudeHome, 'runtime'), { recursive: true })
mkdirSync(join(root, 'snapshots'), { recursive: true })
mkdirSync(join(root, 'intents'), { recursive: true })
writeFileSync(join(openclaudeHome, 'canary'), 'ocv5-213-a9-isolated-home\n')

for (const key of Object.keys(process.env)) {
  if (/^(OC_|OPENCLAUDE_)/.test(key)) delete process.env[key]
}

process.env.HOME = home
process.env.OPENCLAUDE_HOME = openclaudeHome
process.env.OPENCLAUDE_DELEGATE_JOBS_DB = join(openclaudeHome, 'delegate-jobs.db')
process.env.OPENCLAUDE_DELEGATE_INFLIGHT_DB = join(openclaudeHome, 'delegate-inflight.db')
process.env.OPENCLAUDE_DELEGATE_JOB_SNAPSHOT_DIR = join(root, 'snapshots')
process.env.OPENCLAUDE_SEND_TO_AGENT_INTENT_DIR = join(root, 'intents')
process.env.TMPDIR = '/tmp'

after(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key]
  }
  Object.assign(process.env, originalEnv)
  rmSync(root, { recursive: true, force: true })
})

export const spawnEnvIsolate = {
  root,
  home,
  openclaudeHome,
} as const
