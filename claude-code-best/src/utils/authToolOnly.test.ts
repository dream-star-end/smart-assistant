import { test, expect } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

test('tool-only auth neither requires nor retrieves a key; ordinary CI still rejects missing credentials', () => {
  const home = mkdtempSync(join(tmpdir(), 'ccb-tool-only-auth-'))
  try {
    // Fresh module state and HOME; never inherit credentials or auth helpers.
    const result = spawnSync(process.execPath, ['-e', `
      import assert from 'node:assert/strict';
      import { enableConfigs } from './src/utils/config.ts';
      import { getIsToolOnly, enableToolOnlyMode } from './src/bootstrap/state.ts';
      enableConfigs();
      const { getAnthropicApiKeyWithSource } = await import('./src/utils/auth.ts');
      assert.equal(getIsToolOnly(), false);
      process.env.CI = 'true';
      assert.throws(() => getAnthropicApiKeyWithSource(),
        /ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN env var is required/);
      enableToolOnlyMode();
      assert.deepEqual(getAnthropicApiKeyWithSource(), { key: null, source: 'none' });
      process.env.ANTHROPIC_API_KEY = 'synthetic-must-not-be-used';
      assert.deepEqual(getAnthropicApiKeyWithSource(), { key: null, source: 'none' });
      console.log('AUTH_BOUNDARY_PASS');
    `], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      env: { HOME: home, PATH: process.env.PATH, LANG: 'C.UTF-8' },
      encoding: 'utf8', timeout: 15000,
    })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe('AUTH_BOUNDARY_PASS')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
