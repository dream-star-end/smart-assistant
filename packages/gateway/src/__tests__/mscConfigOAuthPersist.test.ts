/**
 * msc-config 阶段 B(CFG-02 / CFG-10):OAuth 凭据落盘走 storage.updateConfig 事务。
 *
 *   - openclaude.json 里手写的未知字段 / 其他段在 OAuth 写回后原样保留(锁内读-改-写,非整文件覆盖);
 *   - 写回不留 .tmp 残留(tmp + rename);
 *   - deps.config 只同步 auth 段,内存里的其他字段不被磁盘副本整体替换;
 *   - openclaude.json 不存在 → 返回 false 且不凭空创建文件(与旧行为一致:跳过持久化)。
 *
 * 运行:npx tsx --test --test-concurrency=1 packages/gateway/src/__tests__/mscConfigOAuthPersist.test.ts
 */
import * as assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

const saved = process.env.OC_MODEL_AUTHORITY
before(() => {
  process.env.OC_MODEL_AUTHORITY = '0'
})
after(() => {
  if (saved === undefined) process.env.OC_MODEL_AUTHORITY = undefined
  else process.env.OC_MODEL_AUTHORITY = saved
})

const home = mkdtempSync(join(tmpdir(), 'oc-gw-msc-config-oauth-'))
process.env.OPENCLAUDE_HOME = home

const { Gateway } = await import('../server.js')
const { paths, readConfig, writeConfig, writeAgentsConfig, readAgentsConfig } = await import(
  '@openclaude/storage'
)

type PersistFn = (
  providerKey: string,
  credential: { accessToken: string; refreshToken: string; expiresAt: number; scope: string },
  opts?: { setSubscriptionMode?: boolean },
) => Promise<boolean>

function buildGateway(
  memoryConfig: Record<string, unknown>,
  agentsConfig: Awaited<ReturnType<typeof readAgentsConfig>>,
) {
  return new Gateway({ config: memoryConfig as never, agentsConfig })
}

describe('msc-config · OAuth credential persistence (updateConfig transaction)', () => {
  it('keeps unknown fields, leaves no tmp file, and syncs only deps.config.auth', async () => {
    await writeAgentsConfig({ agents: [{ id: 'main' }], routes: [], default: 'main' })
    const agentsConfig = await readAgentsConfig()
    const onDisk = {
      version: 1,
      gateway: { bind: '127.0.0.1', port: 18789, accessToken: 'disk-token', users: [] },
      auth: { mode: 'api_key', claudeCodePath: '/opt/ccb' },
      defaults: { model: 'glm-5.3-zai', permissionMode: 'acceptEdits' },
      channels: { webchat: { enabled: true }, telegram: { enabled: true, botToken: 'tg' } },
      mcpServers: [{ id: 'm', command: 'npx', env: { K: 'v' } }],
      terminal: { type: 'local' },
      customUnknownSection: { keepMe: true },
    }
    await writeConfig(onDisk as never)

    // 内存里的 deps.config 故意与磁盘不同(模拟 CFG-10 里「手改字段被意外拉进内存」的场景)。
    const memoryConfig = {
      version: 1,
      gateway: { bind: '127.0.0.1', port: 0, accessToken: 'memory-token' },
      auth: { mode: 'api_key', claudeCodePath: '/opt/ccb' },
      sessions: { dbPath: join(home, 'sessions.db') },
      defaults: { model: 'memory-model', permissionMode: 'default' },
      channels: { webchat: { enabled: true } },
    }
    const gw = buildGateway(memoryConfig, agentsConfig)
    const persist = (
      gw as unknown as { _persistOAuthCredential: PersistFn }
    )._persistOAuthCredential.bind(gw)

    const cred = { accessToken: 'new-at', refreshToken: 'new-rt', expiresAt: 123, scope: 's' }
    assert.equal(await persist('claude', cred, { setSubscriptionMode: true }), true)

    const after = (await readConfig()) as any
    assert.deepEqual(after.auth.claudeOAuth, cred)
    assert.equal(after.auth.mode, 'subscription')
    assert.equal(after.auth.claudeCodePath, '/opt/ccb')
    assert.deepEqual(after.customUnknownSection, { keepMe: true }, 'unknown section must survive')
    assert.deepEqual(after.gateway.users, [])
    assert.equal(after.channels.telegram.botToken, 'tg')
    assert.equal(after.mcpServers[0].env.K, 'v')
    assert.equal(
      after.gateway.accessToken,
      'disk-token',
      'disk token untouched (no full overwrite from memory)',
    )
    assert.ok(
      !readdirSync(home).some((f) => f.includes('.tmp-')),
      `no tmp leftovers expected, got ${readdirSync(home).join(',')}`,
    )
    // 原文件是合法 JSON(rename 原子替换)
    assert.doesNotThrow(() => JSON.parse(readFileSync(paths.config, 'utf-8')))

    // deps.config:只有 auth 段被同步;defaults / gateway 仍是内存值
    const deps = (gw as unknown as { deps: { config: any } }).deps.config
    assert.deepEqual(deps.auth.claudeOAuth, cred)
    assert.equal(deps.auth.mode, 'subscription')
    assert.equal(deps.defaults.model, 'memory-model', 'deps.config must not be replaced wholesale')
    assert.equal(deps.gateway.accessToken, 'memory-token')

    // 非 claude provider 落到 `<provider>OAuth`
    assert.equal(await persist('codex', { ...cred, accessToken: 'codex-at' }), true)
    const again = (await readConfig()) as any
    assert.equal(again.auth.codexOAuth.accessToken, 'codex-at')
    assert.equal(again.auth.claudeOAuth.accessToken, 'new-at')
  })

  it('returns false and does not invent a config file when openclaude.json is missing', async () => {
    // paths.* 在模块加载时固定,所以用「删掉同一 HOME 下的 openclaude.json」来模拟缺失。
    rmSync(paths.config, { force: true })
    assert.equal(existsSync(paths.config), false)
    const agentsConfig = { agents: [{ id: 'main' }], routes: [], default: 'main' }
    const gw = buildGateway(
      {
        version: 1,
        gateway: { bind: '127.0.0.1', port: 0, accessToken: 't' },
        auth: { mode: 'subscription', claudeCodePath: '' },
        sessions: { dbPath: join(home, 'sessions.db') },
        defaults: { model: 'glm-5.3-zai', permissionMode: 'default' },
        channels: { webchat: { enabled: true } },
      },
      agentsConfig,
    )
    const persist = (
      gw as unknown as { _persistOAuthCredential: PersistFn }
    )._persistOAuthCredential.bind(gw)
    const ok = await persist('claude', {
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: 1,
      scope: 's',
    })
    assert.equal(ok, false)
    assert.equal(existsSync(paths.config), false, 'must not create openclaude.json out of thin air')
  })
})
