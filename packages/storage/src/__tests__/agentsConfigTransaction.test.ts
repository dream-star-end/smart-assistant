import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const home = await mkdtemp(join(tmpdir(), 'ocv5-179-agent-txn-'))
process.env.OPENCLAUDE_HOME = home
const { writeAgentsConfig, updateAgentsConfig, readAgentsConfig } = await import('../config.js')
after(() => rm(home, { recursive: true, force: true }))

test('another process reads latest config only after the holder releases its transaction', async () => {
  await writeAgentsConfig({ agents: [{ id: 'main' }], default: 'main', routes: [] })
  let child: ReturnType<typeof spawn> | undefined
  let done: Promise<void> | undefined
  try {
    await updateAgentsConfig(async cfg => {
      child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
        import { updateAgentsConfig } from ${JSON.stringify(new URL('../config.ts', import.meta.url).href)};
        process.stdout.write('ready\\n');
        await updateAgentsConfig(cfg => { cfg.agents.push({id:'child'}); });
      `], { env: { ...process.env, OPENCLAUDE_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] })
      let error = ''
      child.stderr!.on('data', b => { error += String(b) })
      done = new Promise<void>((resolve, reject) => {
        child!.once('error', reject)
        child!.once('exit', code => code === 0 ? resolve() : reject(new Error(error || `exit ${code}`)))
      })
      await Promise.race([
        new Promise<void>(resolve => child!.stdout!.once('data', () => resolve())),
        done.then(() => { throw new Error('child exited before contention') }),
      ])
      cfg.agents.push({ id: 'parent' })
    })
    await done
    assert.deepEqual((await readAgentsConfig()).agents.map(a => a.id), ['main', 'parent', 'child'])
  } finally {
    if (child && child.exitCode === null) child.kill()
    await done?.catch(() => {})
  }
})

test('callback failure publishes nothing and releases the lock for a later update', async () => {
  const before = await readAgentsConfig()
  await assert.rejects(updateAgentsConfig(cfg => { cfg.default = 'bad'; throw new Error('abort') }), /abort/)
  assert.deepEqual(await readAgentsConfig(), before)
  await updateAgentsConfig(cfg => { cfg.routes.push({ match: { channel: 'webchat' }, agent: 'main' }) })
  assert.equal((await readAgentsConfig()).routes.length, before.routes.length + 1)
})
