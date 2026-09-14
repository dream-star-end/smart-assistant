import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { test } from 'node:test'

for (const mode of ['success', 'missing-late', 'denied', 'write-fault', 'expired-body', 'expired-permission', 'deleted-after-accept', 'parent-restore', 'parent-metadata-missing', 'parent-restore-expired', 'parent-restore-race']) {
  test(`actual retry HTTP and original native executor: ${mode}`, { timeout: 45000 }, async () => {
    const home = mkdtempSync(join(tmpdir(), 'retry-http-private-'))
    const child = spawn(process.execPath, ['--import', 'tsx',
      fileURLToPath(new URL('./fixtures/delegateRetryHttp.fixture.ts', import.meta.url)), mode], {
      env: { PATH: process.env.PATH, HOME: home, OPENCLAUDE_HOME: home, CODEX_HOME: join(home, 'codex'),
        CLAUDE_CONFIG_DIR: join(home, 'claude'), NODE_ENV: 'test', OC_DELEGATE_SM: '1', OC_DELEGATE_DURABLE: '1', OC_DELEGATE_NOTIFIER: '1' },
      stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    })
    let output = ''; child.stdout.on('data', b => { output += b }); child.stderr.on('data', b => { output += b })
    const timer = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL') } catch {} }, 35000)
    try {
      const exit = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
      assert.equal(exit, 0, output); assert.match(output, new RegExp(`RETRY_HTTP_PASS ${mode}`))
    } finally { clearTimeout(timer); try { process.kill(-child.pid!, 'SIGKILL') } catch {} }
  })
}
