import * as assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, it } from 'node:test'
import type { OpenClaudeConfig } from '@openclaude/storage'
import {
  assertValidRunAsUser,
  isAllowedRunAsUser,
  resolveRunAsUserIds,
  validateAgentsConfig,
} from '@openclaude/storage'
import { CodexAppServerRunner, __setCodexAppServerSpawnForTests } from '../codexAppServerRunner.js'

/** Set or (for undefined) unset an env var. Uses a variable key so biome's
 *  noDelete / useLiteralKeys rules stay happy (matches the repo's test idiom). */
function setOrUnset(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

function makeFakeProc(): any {
  const ee = new EventEmitter() as any
  ee.killed = false
  ee.pid = 4242
  ee.stdin = new PassThrough()
  ee.stdout = new PassThrough()
  ee.stderr = new PassThrough()
  ee.kill = (sig?: string) => {
    ee.killed = true
    setImmediate(() => ee.emit('close', null, sig ?? 'SIGTERM'))
  }
  setTimeout(() => {
    ee.stdout.end()
    ee.stderr.end()
    ee.emit('close', 0, null)
  }, 50)
  return ee
}

function makeFakeConfig(): OpenClaudeConfig {
  return {
    version: 1,
    gateway: { bind: '127.0.0.1', port: 18789, accessToken: 'tok' },
    auth: { mode: 'subscription' },
    defaults: { model: 'claude-opus-4-7', permissionMode: 'bypassPermissions' },
    channels: { webchat: { enabled: true } },
  } as unknown as OpenClaudeConfig
}

describe('runAsUser allowlist (config.ts)', () => {
  const selfhealAgent = {
    id: 'codex-v5ops',
    runAsUser: 'ocheal',
    provider: 'codex-native',
    runnerKind: 'app-server',
  }

  it('accepts runAsUser only on the designated self-heal agent + app-server', () => {
    assert.equal(isAllowedRunAsUser('ocheal'), true)
    assert.doesNotThrow(() => assertValidRunAsUser(selfhealAgent as any))
  })

  it('rejects any non-whitelisted value at config load', () => {
    assert.equal(isAllowedRunAsUser('root'), false)
    assert.throws(
      () => assertValidRunAsUser({ id: 'evil', runAsUser: 'root' } as any),
      /not permitted/,
    )
    assert.throws(
      () =>
        validateAgentsConfig({
          agents: [{ id: 'x', runAsUser: 'nobody' }],
          routes: [],
          default: 'x',
        } as any),
      /not permitted/,
    )
  })

  it('rejects runAsUser on a non-self-heal agent (Codex HIGH #6)', () => {
    assert.throws(
      () => assertValidRunAsUser({ ...selfhealAgent, id: 'main' } as any),
      /only on the self-heal agent/,
    )
  })

  it('rejects runAsUser with the wrong provider', () => {
    assert.throws(
      () => assertValidRunAsUser({ ...selfhealAgent, provider: 'anthropic' } as any),
      /provider=codex-native/,
    )
  })

  it('rejects runAsUser on a non-app-server runner (Codex HIGH #7)', () => {
    assert.throws(
      () => assertValidRunAsUser({ ...selfhealAgent, runnerKind: 'exec' } as any),
      /runnerKind=app-server/,
    )
  })

  it('treats absent runAsUser as ok (zero regression)', () => {
    assert.doesNotThrow(() => assertValidRunAsUser({ id: 'main' } as any))
    assert.doesNotThrow(() =>
      validateAgentsConfig({ agents: [{ id: 'main' }], routes: [], default: 'main' } as any),
    )
  })
})

describe('resolveRunAsUserIds (config.ts)', () => {
  const saved = { uid: process.env.OC_SELFHEAL_OCHEAL_UID, gid: process.env.OC_SELFHEAL_OCHEAL_GID }
  afterEach(() => {
    setOrUnset('OC_SELFHEAL_OCHEAL_UID', saved.uid)
    setOrUnset('OC_SELFHEAL_OCHEAL_GID', saved.gid)
  })

  it('resolves valid uid/gid from env', () => {
    process.env.OC_SELFHEAL_OCHEAL_UID = '997'
    process.env.OC_SELFHEAL_OCHEAL_GID = '998'
    assert.deepEqual(resolveRunAsUserIds('ocheal'), { uid: 997, gid: 998 })
  })

  it('throws (fail-closed) when uid resolves to 0 / root', () => {
    process.env.OC_SELFHEAL_OCHEAL_UID = '0'
    process.env.OC_SELFHEAL_OCHEAL_GID = '998'
    assert.throws(() => resolveRunAsUserIds('ocheal'), /positive integer uid/)
  })

  it('throws when env is missing or non-numeric', () => {
    setOrUnset('OC_SELFHEAL_OCHEAL_UID', undefined)
    process.env.OC_SELFHEAL_OCHEAL_GID = '998'
    assert.throws(() => resolveRunAsUserIds('ocheal'), /positive integer uid/)
    process.env.OC_SELFHEAL_OCHEAL_UID = 'abc'
    assert.throws(() => resolveRunAsUserIds('ocheal'), /positive integer uid/)
  })

  it('throws for a non-whitelisted identity', () => {
    assert.throws(() => resolveRunAsUserIds('root'), /not in the allowlist/)
  })
})

describe('CodexAppServerRunner spawn privilege drop', () => {
  let cwd: string
  const captured: { cmd: string; args: string[]; opts: any }[] = []
  const saved = {
    uid: process.env.OC_SELFHEAL_OCHEAL_UID,
    gid: process.env.OC_SELFHEAL_OCHEAL_GID,
    secret: process.env.OC_SELFHEAL_VERIFY_HMAC,
  }

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'oc-runas-'))
    captured.length = 0
    __setCodexAppServerSpawnForTests(((cmd: string, args: string[], opts: any) => {
      captured.push({ cmd, args, opts })
      return makeFakeProc()
    }) as any)
  })

  afterEach(() => {
    __setCodexAppServerSpawnForTests(null)
    setOrUnset('OC_SELFHEAL_OCHEAL_UID', saved.uid)
    setOrUnset('OC_SELFHEAL_OCHEAL_GID', saved.gid)
    setOrUnset('OC_SELFHEAL_VERIFY_HMAC', saved.secret)
    try {
      rmSync(cwd, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  async function spawnOnce(runAsUser?: 'ocheal'): Promise<void> {
    const runner = new CodexAppServerRunner({
      sessionKey: `runas-${runAsUser ?? 'none'}`,
      agentId: 'aps-agent',
      cwd,
      config: makeFakeConfig(),
      ...(runAsUser ? { runAsUser } : {}),
    })
    void runner.submit('go').catch(() => {
      /* fake proc never completes handshake */
    })
    const deadline = Date.now() + 2500
    while (captured.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10))
    }
    await runner.shutdown().catch(() => {})
  }

  it('wraps codex in setpriv (uid/gid drop + cleared groups) + sane HOME + scrubs OC_SELFHEAL_* when runAsUser=ocheal', async () => {
    process.env.OC_SELFHEAL_OCHEAL_UID = '997'
    process.env.OC_SELFHEAL_OCHEAL_GID = '998'
    process.env.OC_SELFHEAL_VERIFY_HMAC = 'super-secret-signing-key-value'
    await spawnOnce('ocheal')
    assert.equal(captured.length, 1, 'spawn must fire once')
    const { cmd, args, opts } = captured[0]!
    // setpriv performs the drop AND clears supplementary groups (Node can't —
    // Codex HIGH #8). A plain uid/gid drop would inherit root's docker/root group.
    assert.equal(cmd, 'setpriv', 'privilege-drop agent must launch via setpriv')
    assert.ok(args.includes('--clear-groups'), 'supplementary groups must be cleared')
    assert.equal(args[args.indexOf('--reuid') + 1], '997', 'setpriv must drop to ocheal uid')
    assert.equal(args[args.indexOf('--regid') + 1], '998', 'setpriv must drop to ocheal gid')
    assert.equal(
      args[args.indexOf('--') + 1],
      'codex',
      'codex must be the wrapped command after --',
    )
    // Node uid/gid options must NOT also be set (setpriv performs the drop).
    assert.equal(opts.uid, undefined)
    assert.equal(opts.gid, undefined)
    assert.equal(opts.env.HOME, '/home/ocheal', 'dropped proc must not inherit root HOME')
    assert.equal(opts.env.USER, 'ocheal')
    // Self-heal secrets must NOT leak into the codex subprocess env.
    const leaked = Object.keys(opts.env).filter((k) => k.startsWith('OC_SELFHEAL_'))
    assert.deepEqual(leaked, [], `OC_SELFHEAL_* must be scrubbed; leaked: ${leaked.join(',')}`)
  })

  it('launches codex directly (no setpriv, no uid/gid) for a normal agent (zero regression)', async () => {
    process.env.OC_SELFHEAL_OCHEAL_UID = '997'
    process.env.OC_SELFHEAL_OCHEAL_GID = '998'
    await spawnOnce(undefined)
    assert.equal(captured.length, 1)
    const { cmd, opts } = captured[0]!
    assert.equal(cmd, 'codex', 'normal agent must launch codex directly')
    assert.equal(opts.uid, undefined, 'normal agent must not be privilege-dropped')
    assert.equal(opts.gid, undefined)
  })

  it('fail-closed: never spawns as root when uid resolves to 0', async () => {
    process.env.OC_SELFHEAL_OCHEAL_UID = '0'
    process.env.OC_SELFHEAL_OCHEAL_GID = '998'
    await spawnOnce('ocheal')
    assert.equal(captured.length, 0, 'must refuse to spawn rather than launch codex as root')
  })
})
