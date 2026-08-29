/**
 * Grok device-login credential parsing. No real OAuth flow is used here.
 *
 * Run: npx tsx --test packages/commercial/src/__tests__/grokDeviceAuth.test.ts
 */
import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'

import {
  GROK_AUTH_SCOPE,
  buildGrokDeviceAuthEnv,
  cancelGrokDeviceAuth,
  getGrokDeviceAuthStatus,
  parseGrokAuthJson,
  startGrokDeviceAuth,
} from '../admin/grokDeviceAuth.js'

function auth(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    [GROK_AUTH_SCOPE]: {
      key: 'access-token',
      refresh_token: 'refresh-token',
      expires_at: 2_000_000_000,
      auth_mode: 'oidc',
      oidc_issuer: 'https://auth.x.ai',
      oidc_client_id: 'b1a00492-073a-47ea-816f-4c329264a828',
      principal_type: 'Team',
      principal_id: 'team-123',
      ...overrides,
    },
  })
}

describe('parseGrokAuthJson', () => {
  test('accepts only the official xAI OAuth scope and normalizes epoch expiry', () => {
    assert.deepEqual(parseGrokAuthJson(auth()), {
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expires_at: '2033-05-18T03:33:20.000Z',
      principal_type: 'Team',
      principal_id: 'team-123',
    })
  })

  test('rejects absent refresh token, wrong issuer/client and non-OAuth mode', () => {
    assert.throws(() => parseGrokAuthJson(auth({ refresh_token: '' })), /REFRESH_TOKEN_MISSING/)
    assert.throws(() => parseGrokAuthJson(auth({ auth_mode: 'api_key' })), /AUTH_MODE_INVALID/)
    assert.throws(() => parseGrokAuthJson(auth({
      oidc_issuer: 'https://evil.example',
    })), /OIDC_INVALID/)
    assert.throws(() => parseGrokAuthJson(auth({ principal_id: undefined })), /PRINCIPAL_INVALID/)
    assert.throws(() => parseGrokAuthJson(JSON.stringify({ other: {} })), /SCOPE_MISSING/)
  })
})

test('device-login child gets only controlled environment keys', () => {
  const env = buildGrokDeviceAuthEnv('/tmp/home', '/tmp/home/.grok', 'http://proxy:1234', {
    PATH: '/test/bin',
    DATABASE_URL: 'postgres://secret',
    COMMERCIAL_KMS_KEY: 'secret-key',
    OPENCLAUDE_V3_CONTAINER_TOKEN: 'container-secret',
  })
  assert.equal(env.PATH, '/test/bin')
  assert.equal(env.HOME, '/tmp/home')
  assert.equal(env.HTTPS_PROXY, 'http://proxy:1234')
  assert.equal(env.DATABASE_URL, undefined)
  assert.equal(env.COMMERCIAL_KMS_KEY, undefined)
  assert.equal(env.OPENCLAUDE_V3_CONTAINER_TOKEN, undefined)
})

test('device-login helper captures the official URL and consumes the resulting auth file once', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'oc-grok-device-test-'))
  const fake = path.join(dir, 'fake-grok.cjs')
  await writeFile(fake, `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
process.stderr.write('Open https://accounts.x.ai/oauth2/device?user_code=ABCD-1234\\n')
fs.writeFileSync(path.join(process.env.GROK_HOME, 'auth.json'), JSON.stringify({
  '${GROK_AUTH_SCOPE}': {
    key: 'access-from-device', auth_mode: 'oidc', create_time: new Date().toISOString(),
    user_id: 'user-1', refresh_token: 'refresh-from-device', expires_at: '2033-05-18T03:33:20.000Z',
    oidc_issuer: 'https://auth.x.ai', oidc_client_id: 'b1a00492-073a-47ea-816f-4c329264a828',
    principal_type: 'Team', principal_id: 'team-123'
  }
}))
`)
  await chmod(fake, 0o755)
  const previous = process.env.OC_GROK_CLI_BIN
  process.env.OC_GROK_CLI_BIN = fake
  let id: string | null = null
  try {
    const started = await startGrokDeviceAuth({ proxyUrl: 'http://proxy.test:8080' })
    assert.equal(started.status, 'pending')
    assert.equal(started.user_code, 'ABCD-1234')
    id = started.session_id
    let status = getGrokDeviceAuthStatus(id)
    for (let i = 0; status?.status === 'pending' && i < 100; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      status = getGrokDeviceAuthStatus(id)
    }
    assert.deepEqual(status, {
      status: 'complete',
      session_id: id,
      access_token: 'access-from-device',
      refresh_token: 'refresh-from-device',
      expires_at: '2033-05-18T03:33:20.000Z',
      principal_type: 'Team',
      principal_id: 'team-123',
    })
    assert.equal(getGrokDeviceAuthStatus(id), null, 'credential retrieval must be one-shot')
    id = null
  } finally {
    if (id) cancelGrokDeviceAuth(id)
    if (previous === undefined) delete process.env.OC_GROK_CLI_BIN
    else process.env.OC_GROK_CLI_BIN = previous
    await rm(dir, { recursive: true, force: true })
  }
})
