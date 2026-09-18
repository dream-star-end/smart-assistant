/**
 * msc-config 阶段 B:openclaude.json 的 schema 归一(CFG-04)、原子写 + 跨进程锁(CFG-02)、
 * agents.yaml 字段级校验器(CFG-05/07)、凭据路径段校验(CFG-15)。
 * 运行:npx tsx --test packages/storage/src/__tests__/mscConfigOpenclaudeJson.test.ts
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'

const home = await mkdtemp(join(tmpdir(), 'msc-config-json-'))
process.env.OPENCLAUDE_HOME = home
const {
  ConfigValidationError,
  DEFAULT_GATEWAY_BIND,
  DEFAULT_GATEWAY_PORT,
  SELFHOST_FALLBACK_MODEL,
  parseOpenClaudeConfig,
  readConfig,
  readConfigWithWarnings,
  updateConfig,
  validateAgentPatch,
  writeConfig,
} = await import('../config.js')
const { paths } = await import('../paths.js')
const { readCredential, saveCredential } = await import('../credentials.js')
after(() => rm(home, { recursive: true, force: true }))

const VALID = {
  version: 1 as const,
  gateway: { bind: '127.0.0.1', port: 18789, accessToken: 'tok' },
  auth: { mode: 'subscription' as const, claudeCodePath: '/ccb' },
  defaults: { model: 'glm-5.3-zai', permissionMode: 'default' as const },
  channels: { webchat: { enabled: true } },
}

describe('parseOpenClaudeConfig (CFG-04)', () => {
  test('empty object → every required section filled with defaults + warnings, nothing fatal', () => {
    const { config, warnings } = parseOpenClaudeConfig({})
    assert.equal(config.version, 1)
    assert.equal(config.gateway.bind, DEFAULT_GATEWAY_BIND)
    assert.equal(config.gateway.port, DEFAULT_GATEWAY_PORT)
    assert.equal(config.auth.mode, 'subscription')
    assert.equal(config.defaults.model, SELFHOST_FALLBACK_MODEL)
    assert.equal(config.defaults.permissionMode, 'default')
    assert.deepEqual(config.channels, { webchat: { enabled: true } })
    assert.ok(
      warnings.length >= 4,
      `expected warnings for gateway/auth/defaults/channels, got ${JSON.stringify(warnings)}`,
    )
  })

  test('version other than 1 is fatal', () => {
    assert.throws(
      () => parseOpenClaudeConfig({ ...VALID, version: 2 }),
      (err: unknown) =>
        err instanceof ConfigValidationError && err.code === 'FATAL' && /version/.test(err.message),
    )
  })

  test('gateway.port present but not an integer in 1..65535 is fatal (string / 0 / 70000)', () => {
    for (const port of ['18789', 0, 70000, 1.5]) {
      assert.throws(
        () => parseOpenClaudeConfig({ ...VALID, gateway: { ...VALID.gateway, port } }),
        (err: unknown) => err instanceof ConfigValidationError && /port/.test(err.message),
        `port=${JSON.stringify(port)} must be fatal`,
      )
    }
  })

  test('non-object root (array / null / string) is fatal', () => {
    for (const raw of [[1, 2], null, 'x', 42]) {
      assert.throws(() => parseOpenClaudeConfig(raw), ConfigValidationError)
    }
  })

  test('out-of-enum permissionMode / auth.mode fall back to defaults with a warning; unknown keys survive', () => {
    const { config, warnings } = parseOpenClaudeConfig({
      ...VALID,
      auth: { ...VALID.auth, mode: 'magic' },
      defaults: { model: 'm', permissionMode: 'yolo' },
      futureFlag: { keep: true },
    })
    assert.equal(config.defaults.permissionMode, 'default')
    assert.equal(config.auth.mode, 'subscription')
    assert.ok(warnings.some((w) => /permissionMode/.test(w)))
    assert.ok(warnings.some((w) => /auth\.mode/.test(w)))
    assert.deepEqual((config as unknown as Record<string, unknown>).futureFlag, { keep: true })
  })

  test('a fully valid config round-trips byte-identical (no defaults injected, no warnings)', () => {
    const { config, warnings } = parseOpenClaudeConfig(structuredClone(VALID))
    assert.deepEqual(config, VALID)
    assert.deepEqual(warnings, [])
  })

  test('mcpServers / users that are not arrays are dropped with a warning', () => {
    const { config, warnings } = parseOpenClaudeConfig({
      ...VALID,
      gateway: { ...VALID.gateway, users: 'boss' },
      mcpServers: { id: 'x' },
    })
    assert.equal(config.gateway.users, undefined)
    assert.equal(config.mcpServers, undefined)
    assert.equal(warnings.filter((w) => /users|mcpServers/.test(w)).length, 2)
  })
})

describe('readConfig / writeConfig / updateConfig (CFG-02 / CFG-04)', () => {
  test('readConfig normalizes what is on disk and readConfigWithWarnings reports the gaps', async () => {
    await writeFile(paths.config, JSON.stringify({ version: 1, gateway: { accessToken: 't' } }))
    const cfg = await readConfig()
    assert.ok(cfg)
    assert.equal(cfg.gateway.port, DEFAULT_GATEWAY_PORT)
    assert.equal(cfg.defaults.permissionMode, 'default')
    const withWarnings = await readConfigWithWarnings()
    assert.ok(withWarnings && withWarnings.warnings.length > 0)
  })

  test('readConfig surfaces a fatal config as ConfigValidationError (not a bare TypeError downstream)', async () => {
    await writeFile(paths.config, JSON.stringify({ ...VALID, version: 3 }))
    await assert.rejects(readConfig(), ConfigValidationError)
    await writeFile(paths.config, '{ not json')
    await assert.rejects(readConfig(), ConfigValidationError)
  })

  test('writeConfig leaves no temp file behind and the result parses', async () => {
    await writeConfig(structuredClone(VALID))
    const files = await readdir(home)
    assert.ok(
      !files.some((f) => f.startsWith('openclaude.json.tmp')),
      `temp files left: ${files.join(',')}`,
    )
    assert.deepEqual(JSON.parse(await readFile(paths.config, 'utf8')), VALID)
  })

  test('updateConfig callback failure publishes nothing and releases the lock', async () => {
    await writeConfig(structuredClone(VALID))
    await assert.rejects(
      updateConfig((c) => {
        c.defaults.model = 'broken'
        throw new Error('abort')
      }),
      /abort/,
    )
    assert.equal((await readConfig())?.defaults.model, VALID.defaults.model)
    const { config } = await updateConfig((c) => {
      c.defaults.model = 'next'
    })
    assert.equal(config.defaults.model, 'next')
    assert.equal((await readConfig())?.defaults.model, 'next')
  })

  test('updateConfig on a missing openclaude.json throws MISSING instead of inventing a config', async () => {
    await rm(paths.config, { force: true })
    await assert.rejects(
      updateConfig(() => undefined),
      (err: unknown) => err instanceof ConfigValidationError && err.code === 'MISSING',
    )
  })

  test('another process only reads the update after the holder releases the transaction', async () => {
    await writeConfig(structuredClone(VALID))
    let child: ReturnType<typeof spawn> | undefined
    let done: Promise<void> | undefined
    try {
      await updateConfig(async (cfg) => {
        child = spawn(
          process.execPath,
          [
            '--import',
            'tsx',
            '--input-type=module',
            '-e',
            `
        import { updateConfig } from ${JSON.stringify(new URL('../config.ts', import.meta.url).href)};
        process.stdout.write('ready\\n');
        await updateConfig(cfg => { cfg.defaults.toolsets = ['child']; });
      `,
          ],
          { env: { ...process.env, OPENCLAUDE_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] },
        )
        let error = ''
        child.stderr!.on('data', (b) => {
          error += String(b)
        })
        done = new Promise<void>((resolve, reject) => {
          child!.once('error', reject)
          child!.once('exit', (code) =>
            code === 0 ? resolve() : reject(new Error(error || `exit ${code}`)),
          )
        })
        await Promise.race([
          new Promise<void>((resolve) => child!.stdout!.once('data', () => resolve())),
          done.then(() => {
            throw new Error('child exited before contention')
          }),
        ])
        cfg.provider = 'parent'
      })
      await done
      const final = await readConfig()
      assert.equal(final?.provider, 'parent', 'parent write must not be lost')
      assert.deepEqual(
        final?.defaults.toolsets,
        ['child'],
        'child write must land after parent released',
      )
    } finally {
      if (child && child.exitCode === null) child.kill()
      await done?.catch(() => {})
    }
  })
})

describe('validateAgentPatch (CFG-05 / CFG-07)', () => {
  const opts = { home: '/home/agent/.openclaude', platform: 'linux' as const }

  test('permissionMode must be one of the five engine modes', () => {
    assert.equal(validateAgentPatch({ permissionMode: 'yolo' }, opts).ok, false)
    const ok = validateAgentPatch({ permissionMode: 'bypassPermissions' }, opts)
    assert.ok(ok.ok && ok.value.permissionMode === 'bypassPermissions')
  })

  test('toolsets must be a string[] of non-empty names', () => {
    assert.equal(validateAgentPatch({ toolsets: 'coding' }, opts).ok, false)
    assert.equal(validateAgentPatch({ toolsets: ['coding', 3] }, opts).ok, false)
    const ok = validateAgentPatch({ toolsets: ['coding', 'browser'] }, opts)
    assert.ok(ok.ok && Array.isArray(ok.value.toolsets))
  })

  test('mcpServers must be an array of {id, command} with string-only args/env', () => {
    assert.equal(validateAgentPatch({ mcpServers: { id: 'x', command: 'npx' } }, opts).ok, false)
    assert.equal(validateAgentPatch({ mcpServers: [{ id: 'x' }] }, opts).ok, false)
    assert.equal(validateAgentPatch({ mcpServers: [{ id: 'x', command: '' }] }, opts).ok, false)
    assert.equal(
      validateAgentPatch({ mcpServers: [{ id: 'x', command: 'npx', env: { K: 1 } }] }, opts).ok,
      false,
    )
    const ok = validateAgentPatch(
      { mcpServers: [{ id: 'x', command: 'npx', args: ['a'], env: { K: 'v' }, enabled: true }] },
      opts,
    )
    assert.ok(ok.ok)
  })

  test('persona must resolve inside OPENCLAUDE_HOME (relative resolves against home)', () => {
    assert.equal(validateAgentPatch({ persona: '../../etc/passwd' }, opts).ok, false)
    assert.equal(validateAgentPatch({ persona: '/etc/passwd' }, opts).ok, false)
    assert.ok(validateAgentPatch({ persona: 'agents/main/CLAUDE.md' }, opts).ok)
    assert.ok(
      validateAgentPatch({ persona: '/home/agent/.openclaude/agents/main/CLAUDE.md' }, opts).ok,
    )
  })

  test('cwd must be absolute, not a filesystem/drive root, not inside system directories', () => {
    assert.equal(validateAgentPatch({ cwd: 'relative/dir' }, opts).ok, false)
    assert.equal(validateAgentPatch({ cwd: '/' }, opts).ok, false)
    for (const bad of ['/etc', '/etc/x', '/proc/1', '/sys', '/dev/null', '/boot/grub']) {
      assert.equal(validateAgentPatch({ cwd: bad }, opts).ok, false, `${bad} must be rejected`)
    }
    assert.ok(validateAgentPatch({ cwd: '/home/agent/work' }, opts).ok)
    assert.ok(
      validateAgentPatch({ cwd: '/etcetera' }, opts).ok,
      'prefix match must be segment-aware',
    )
    const win = { home: 'C:\\Users\\me\\.openclaude', platform: 'win32' as const }
    assert.equal(validateAgentPatch({ cwd: 'C:\\' }, win).ok, false)
    assert.equal(validateAgentPatch({ cwd: 'C:\\Windows\\System32' }, win).ok, false)
    assert.equal(validateAgentPatch({ cwd: 'c:\\windows' }, win).ok, false)
    assert.ok(validateAgentPatch({ cwd: 'D:\\work\\proj' }, win).ok)
  })

  test('scalar display fields must be strings; unknown keys are ignored; a non-object body is rejected', () => {
    assert.equal(validateAgentPatch({ displayName: 5 }, opts).ok, false)
    assert.equal(validateAgentPatch({ model: '' }, opts).ok, false)
    const ok = validateAgentPatch(
      { model: 'glm-5.3-zai', displayName: '小克', source: 'marketplace', bogus: 1 },
      opts,
    )
    assert.ok(ok.ok)
    assert.equal('source' in ok.value, false, 'provenance must never come from the request body')
    assert.equal('bogus' in ok.value, false)
    assert.equal(validateAgentPatch('nope', opts).ok, false)
  })
})

describe('credentials path segments (CFG-15)', () => {
  test('channel / accountId must be simple identifiers', async () => {
    await assert.rejects(saveCredential('../x', 'a', { k: 1 }), /channel/)
    await assert.rejects(saveCredential('telegram', '../../etc', { k: 1 }), /accountId/)
    await assert.rejects(readCredential('tele/gram', 'a'), /channel/)
    await saveCredential('telegram', 'bot-1', { token: 't' })
    assert.deepEqual(await readCredential('telegram', 'bot-1'), { token: 't' })
  })
})
