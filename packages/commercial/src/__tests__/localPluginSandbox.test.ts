import assert from 'node:assert/strict'
import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Duplex } from 'node:stream'
import { afterEach, describe, test } from 'node:test'

import type Docker from 'dockerode'

import {
  BoundedOutput,
  DEFAULT_LOCAL_PLUGIN_LIMITS,
  LOCAL_PLUGIN_IMAGE_ABI,
  LOCAL_PLUGIN_IMAGE_ABI_LABEL,
  LocalPluginSandboxError,
  LocalPluginSandboxService,
  type PlatformLocalPluginPackage,
  assertLocalPluginSandboxLimits,
  assertPinnedLocalPluginImage,
  buildLocalPluginContainerOptions,
  compilePlatformLocalPluginPackage,
  materializePlatformLocalPluginPackage,
  verifyMaterializedLocalPluginPackage,
  waitWithTimeout,
} from '../plugins/localSandbox.js'

const IMAGE_ID = `sha256:${'a'.repeat(64)}`
const OWNER_UID = process.getuid?.() ?? 0
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'oc-local-plugin-'))
  roots.push(root)
  return root
}

function strictObject(
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  }
}

function fixturePackage(
  overrides: {
    manifest?: Record<string, unknown>
    action?: Record<string, unknown>
    files?: Record<string, unknown>
  } = {},
): PlatformLocalPluginPackage {
  const action = {
    id: 'echo',
    description: 'Return a bounded local transformation.',
    effect: 'read',
    entrypoint: 'scripts/echo.py',
    timeoutSeconds: 5,
    params: strictObject({ text: { type: 'string', maxLength: 100 } }, ['text']),
    result: strictObject({ echo: { type: 'string' } }, ['echo']),
    ...overrides.action,
  }
  return {
    manifest: {
      schemaVersion: 1,
      id: 'fixture-local-plugin',
      version: '1.0.0',
      actions: [action],
      ...overrides.manifest,
    },
    files:
      overrides.files ??
      ({
        'scripts/echo.py':
          'import json, sys\np = json.loads(sys.stdin.readline())\nprint(json.dumps({"echo": p["text"]}))\n',
      } satisfies Record<string, string>),
  }
}

function expectCode(code: LocalPluginSandboxError['code']): (error: unknown) => boolean {
  return (error) => error instanceof LocalPluginSandboxError && error.code === code
}

describe('local Plugin package compiler', () => {
  test('normalizes a read-only package and produces a deterministic digest', () => {
    const first = compilePlatformLocalPluginPackage(fixturePackage())
    const second = compilePlatformLocalPluginPackage(
      fixturePackage({
        files: {
          'scripts/unused.sh': "printf '{}\\n'\n",
          'scripts/echo.py':
            'import json, sys\np = json.loads(sys.stdin.readline())\nprint(json.dumps({"echo": p["text"]}))\n',
        },
      }),
    )
    const reordered = compilePlatformLocalPluginPackage({
      ...fixturePackage({
        files: {
          'scripts/echo.py':
            'import json, sys\np = json.loads(sys.stdin.readline())\nprint(json.dumps({"echo": p["text"]}))\n',
          'scripts/unused.sh': "printf '{}\\n'\n",
        },
      }),
    })
    assert.match(first.digest, /^[0-9a-f]{64}$/)
    assert.equal(second.digest, reordered.digest)
    assert.equal(first.manifest.actions[0]?.effect, 'read')
  })

  test('rejects browser/network/write fields rather than treating them as advisory permissions', () => {
    assert.throws(
      () =>
        compilePlatformLocalPluginPackage(
          fixturePackage({ manifest: { browser: true, networkOrigins: ['https://example.com'] } }),
        ),
      expectCode('INVALID_PACKAGE'),
    )
    assert.throws(
      () => compilePlatformLocalPluginPackage(fixturePackage({ action: { effect: 'write' } })),
      expectCode('INVALID_PACKAGE'),
    )
  })

  test('rejects traversal, missing entrypoints, duplicate actions and unsafe schemas', () => {
    assert.throws(
      () =>
        compilePlatformLocalPluginPackage(
          fixturePackage({ action: { entrypoint: 'scripts/../steal.py' } }),
        ),
      expectCode('INVALID_PACKAGE'),
    )
    assert.throws(
      () =>
        compilePlatformLocalPluginPackage(fixturePackage({ files: { 'scripts/other.py': '' } })),
      expectCode('INVALID_PACKAGE'),
    )
    const duplicated = fixturePackage()
    ;(duplicated.manifest as Record<string, unknown>).actions = [
      ...(duplicated.manifest as { actions: unknown[] }).actions,
      { ...((duplicated.manifest as { actions: Record<string, unknown>[] }).actions[0] ?? {}) },
    ]
    assert.throws(
      () => compilePlatformLocalPluginPackage(duplicated),
      expectCode('INVALID_PACKAGE'),
    )
    assert.throws(
      () =>
        compilePlatformLocalPluginPackage(
          fixturePackage({
            action: { params: { type: 'object', $ref: 'https://evil.test/schema' } },
          }),
        ),
      expectCode('INVALID_PACKAGE'),
    )
  })
})

describe('digest-addressed immutable materialization', () => {
  test('writes only root-owned/test-owner 0444 files below a 0555 digest path', async () => {
    const root = await tempRoot()
    const materialized = await materializePlatformLocalPluginPackage(fixturePackage(), {
      root,
      expectedOwnerUid: OWNER_UID,
    })
    assert.equal(materialized.path, join(root, materialized.digest))
    await verifyMaterializedLocalPluginPackage(materialized.path, materialized.compiled, OWNER_UID)
    const manifest = await readFile(join(materialized.path, 'manifest.json'), 'utf8')
    assert.equal((JSON.parse(manifest) as { id: string }).id, 'fixture-local-plugin')
  })

  test('fails closed after content replacement, symlink replacement or hardlink insertion', async () => {
    const root = await tempRoot()
    const first = await materializePlatformLocalPluginPackage(fixturePackage(), {
      root,
      expectedOwnerUid: OWNER_UID,
    })
    const entry = join(first.path, 'scripts/echo.py')
    await chmod(entry, 0o644)
    await writeFile(entry, 'print("tampered")\n')
    await assert.rejects(
      verifyMaterializedLocalPluginPackage(first.path, first.compiled, OWNER_UID),
      expectCode('PACKAGE_TAMPERED'),
    )

    const secondRoot = await tempRoot()
    const second = await materializePlatformLocalPluginPackage(fixturePackage(), {
      root: secondRoot,
      expectedOwnerUid: OWNER_UID,
    })
    const scripts = join(second.path, 'scripts')
    await chmod(scripts, 0o755)
    await rm(join(scripts, 'echo.py'))
    await symlink('/etc/passwd', join(scripts, 'echo.py'))
    await assert.rejects(
      verifyMaterializedLocalPluginPackage(second.path, second.compiled, OWNER_UID),
      expectCode('PACKAGE_TAMPERED'),
    )

    const thirdRoot = await tempRoot()
    const third = await materializePlatformLocalPluginPackage(fixturePackage(), {
      root: thirdRoot,
      expectedOwnerUid: OWNER_UID,
    })
    const thirdScripts = join(third.path, 'scripts')
    await chmod(thirdScripts, 0o755)
    await link(join(thirdScripts, 'echo.py'), join(thirdScripts, 'alias.py'))
    await assert.rejects(
      verifyMaterializedLocalPluginPackage(third.path, third.compiled, OWNER_UID),
      expectCode('PACKAGE_TAMPERED'),
    )

    const fourthRoot = await tempRoot()
    const fourth = await materializePlatformLocalPluginPackage(fixturePackage(), {
      root: fourthRoot,
      expectedOwnerUid: OWNER_UID,
    })
    const replacementRoot = await tempRoot()
    const replacement = await materializePlatformLocalPluginPackage(fixturePackage(), {
      root: replacementRoot,
      expectedOwnerUid: OWNER_UID,
    })
    await rm(fourth.path, { recursive: true })
    await symlink(replacement.path, fourth.path)
    await assert.rejects(
      verifyMaterializedLocalPluginPackage(fourth.path, fourth.compiled, OWNER_UID),
      expectCode('PACKAGE_TAMPERED'),
    )
  })

  test('refuses an unsafe artifact root', async () => {
    const parent = await tempRoot()
    const root = join(parent, 'unsafe')
    await mkdir(root, { mode: 0o777 })
    await chmod(root, 0o777)
    await assert.rejects(
      materializePlatformLocalPluginPackage(fixturePackage(), {
        root,
        expectedOwnerUid: OWNER_UID,
      }),
      expectCode('PACKAGE_TAMPERED'),
    )
  })
})

describe('Docker isolation contract', () => {
  test('pins exact image ID and rejects tag/mismatched ID/labels', async () => {
    const docker = {
      getImage: () => ({
        inspect: async () => ({
          Id: IMAGE_ID,
          Config: {
            Labels: { [LOCAL_PLUGIN_IMAGE_ABI_LABEL]: LOCAL_PLUGIN_IMAGE_ABI, runner: 'v1' },
            Env: ['PATH=/usr/bin:/bin'],
          },
        }),
      }),
    } as unknown as Docker
    await assertPinnedLocalPluginImage(docker, {
      imageId: IMAGE_ID,
      requiredLabels: { runner: 'v1' },
    })
    await assert.rejects(
      assertPinnedLocalPluginImage(docker, {
        imageId: 'openclaude/runtime:latest',
        requiredLabels: {},
      }),
      expectCode('IMAGE_MISMATCH'),
    )
    const dirty = {
      getImage: () => ({
        inspect: async () => ({
          Id: IMAGE_ID,
          Config: {
            Labels: { [LOCAL_PLUGIN_IMAGE_ABI_LABEL]: LOCAL_PLUGIN_IMAGE_ABI },
            Env: ['SECRET=value'],
          },
        }),
      }),
    } as unknown as Docker
    await assert.rejects(
      assertPinnedLocalPluginImage(dirty, { imageId: IMAGE_ID, requiredLabels: {} }),
      expectCode('IMAGE_MISMATCH'),
    )
    const volumeImage = {
      getImage: () => ({
        inspect: async () => ({
          Id: IMAGE_ID,
          Config: {
            Labels: { [LOCAL_PLUGIN_IMAGE_ABI_LABEL]: LOCAL_PLUGIN_IMAGE_ABI },
            Volumes: { '/data': {} },
          },
        }),
      }),
    } as unknown as Docker
    await assert.rejects(
      assertPinnedLocalPluginImage(volumeImage, { imageId: IMAGE_ID, requiredLabels: {} }),
      expectCode('IMAGE_MISMATCH'),
    )
    const wrong = {
      getImage: () => ({
        inspect: async () => ({ Id: `sha256:${'b'.repeat(64)}`, Config: { Labels: {} } }),
      }),
    } as unknown as Docker
    await assert.rejects(
      assertPinnedLocalPluginImage(wrong, { imageId: IMAGE_ID, requiredLabels: {} }),
      expectCode('IMAGE_MISMATCH'),
    )
    await assert.rejects(
      assertPinnedLocalPluginImage(docker, {
        imageId: IMAGE_ID,
        requiredLabels: { runner: 'v2' },
      }),
      expectCode('IMAGE_MISMATCH'),
    )
  })

  test('rejects limits that Docker would interpret as unlimited or excessive', () => {
    const invalid: Array<[keyof typeof DEFAULT_LOCAL_PLUGIN_LIMITS, number]> = [
      ['memoryBytes', 0],
      ['nanoCpus', -1],
      ['pidsLimit', 0],
      ['tmpBytes', 0],
      ['stateBytes', Number.NaN],
      ['maxConcurrentPerUser', 0],
      ['memoryBytes', 2 * 1024 * 1024 * 1024 + 1],
      ['maxConcurrentPerUser', 9],
    ]
    for (const [key, value] of invalid) {
      assert.throws(
        () => assertLocalPluginSandboxLimits({ ...DEFAULT_LOCAL_PLUGIN_LIMITS, [key]: value }),
        expectCode('INVALID_CONFIG'),
      )
    }
  })

  test('container gets network none, read-only root, tmpfs-only writes and one RO rprivate package mount', () => {
    const compiled = compilePlatformLocalPluginPackage(fixturePackage())
    const path = `/var/lib/openclaude-v5/plugin-artifacts/${compiled.digest}`
    const opts = buildLocalPluginContainerOptions({
      imageId: IMAGE_ID,
      materializedPath: path,
      digest: compiled.digest,
      manifest: compiled.manifest,
      action: compiled.manifest.actions[0]!,
      invocationId: '12345678-1234-1234-1234-123456789abc',
    })
    assert.equal(opts.Image, IMAGE_ID)
    assert.equal(opts.User, '1000:1000')
    assert.deepEqual(opts.Entrypoint, [])
    assert.deepEqual(opts.Cmd, ['/usr/bin/python3', '/plugin/scripts/echo.py'])
    assert.equal(opts.NetworkDisabled, true)
    assert.deepEqual(opts.Healthcheck, { Test: ['NONE'] })
    assert.equal(opts.HostConfig?.NetworkMode, 'none')
    assert.equal(opts.HostConfig?.ReadonlyRootfs, true)
    assert.deepEqual(opts.HostConfig?.CapDrop, ['ALL'])
    assert.deepEqual(opts.HostConfig?.SecurityOpt, ['no-new-privileges'])
    assert.equal(opts.HostConfig?.Privileged, false)
    assert.deepEqual(opts.HostConfig?.LogConfig, { Type: 'none', Config: {} })
    assert.match(opts.HostConfig?.Tmpfs?.['/tmp'] ?? '', /nosuid,nodev,noexec/)
    assert.match(opts.HostConfig?.Tmpfs?.['/state'] ?? '', /nosuid,nodev,noexec/)
    assert.equal(opts.HostConfig?.Binds, undefined)
    assert.deepEqual(opts.HostConfig?.Mounts, [
      {
        Type: 'bind',
        Source: path,
        Target: '/plugin',
        ReadOnly: true,
        BindOptions: { Propagation: 'rprivate' },
      },
    ])
    const names = (opts.Env ?? []).map((entry) => entry.split('=', 1)[0])
    for (const forbidden of [
      'OPENCLAUDE_V3_CONTAINER_TOKEN',
      'ANTHROPIC_AUTH_TOKEN',
      'DATABASE_URL',
      'KMS_KEY',
      'HTTP_PROXY',
      'HTTPS_PROXY',
    ])
      assert.equal(names.includes(forbidden), false, `${forbidden} leaked into Plugin env`)
  })
})

describe('bounded execution helpers', () => {
  test('bounded output stops retaining bytes at the cap', () => {
    const output = new BoundedOutput(5)
    output.append('abc')
    output.append('defgh')
    output.append('ignored')
    assert.equal(output.text(), 'abcde')
    assert.equal(output.overflowed, true)
  })

  test('timeout calls the kill hook and returns a typed timeout error', async () => {
    let killed = 0
    await assert.rejects(
      waitWithTimeout(new Promise<never>(() => {}), 10, () => {
        killed += 1
      }),
      expectCode('TIMEOUT'),
    )
    assert.equal(killed, 1)
  })
})

class FakeAttachStream extends Duplex {
  input = ''

  _read(): void {}

  _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.input += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk
    callback()
  }

  finishOutput(): void {
    this.push(null)
    this.resume()
  }
}

function fakeDocker(): {
  docker: Docker
  created: Docker.ContainerCreateOptions[]
  streams: FakeAttachStream[]
  removed: number
} {
  const created: Docker.ContainerCreateOptions[] = []
  const streams: FakeAttachStream[] = []
  let removed = 0
  let stdoutSink: NodeJS.WritableStream | null = null
  let stderrSink: NodeJS.WritableStream | null = null
  const docker = {
    getImage: () => ({
      inspect: async () => ({
        Id: IMAGE_ID,
        Config: {
          Labels: {
            [LOCAL_PLUGIN_IMAGE_ABI_LABEL]: LOCAL_PLUGIN_IMAGE_ABI,
            'oc.runtime.embed_source': '0',
          },
        },
      }),
    }),
    modem: {
      demuxStream: (
        _stream: Duplex,
        stdout: NodeJS.WritableStream,
        stderr: NodeJS.WritableStream,
      ) => {
        stdoutSink = stdout
        stderrSink = stderr
      },
    },
    createContainer: async (options: Docker.ContainerCreateOptions) => {
      created.push(options)
      const stream = new FakeAttachStream()
      streams.push(stream)
      let resolveWait!: (value: { StatusCode: number }) => void
      const waited = new Promise<{ StatusCode: number }>((resolve) => {
        resolveWait = resolve
      })
      let finished = false
      return {
        attach: async () => stream,
        start: async () => {
          setImmediate(() => {
            if (finished) return
            const params = JSON.parse(stream.input) as { text: string }
            stdoutSink?.write(Buffer.from(JSON.stringify({ echo: params.text })))
            stderrSink?.write(Buffer.from('fixture warning'))
            finished = true
            stream.finishOutput()
            resolveWait({ StatusCode: 0 })
          })
        },
        wait: async () => waited,
        kill: async () => {
          if (!finished) {
            finished = true
            stream.finishOutput()
            resolveWait({ StatusCode: 137 })
          }
        },
        remove: async () => {
          removed += 1
        },
      }
    },
  } as unknown as Docker
  return {
    docker,
    created,
    streams,
    get removed() {
      return removed
    },
  }
}

describe('inert orchestration service boundary', () => {
  test('runs an allowlisted local read action with canonical stdin and cleans up', async () => {
    const root = await tempRoot()
    const fake = fakeDocker()
    const service = new LocalPluginSandboxService(fake.docker, {
      artifactRoot: root,
      image: {
        imageId: IMAGE_ID,
        requiredLabels: { 'oc.runtime.embed_source': '0' },
      },
      packages: new Map([['fixture-local-plugin', fixturePackage()]]),
      expectedArtifactOwnerUid: OWNER_UID,
    })
    const result = await service.runReadAction({
      userId: 7,
      pluginId: 'fixture-local-plugin',
      actionId: 'echo',
      params: { text: 'hello' },
    })
    assert.deepEqual(result.result, { echo: 'hello' })
    assert.equal(result.stderr, 'fixture warning')
    assert.match(result.digest, /^[0-9a-f]{64}$/)
    assert.equal(fake.created.length, 1)
    assert.equal(fake.streams[0]?.input, '{"text":"hello"}\n')
    assert.equal(fake.removed, 1)
  })

  test('rejects non-allowlisted packages and bad params before creating a container', async () => {
    const root = await tempRoot()
    const fake = fakeDocker()
    const service = new LocalPluginSandboxService(fake.docker, {
      artifactRoot: root,
      image: { imageId: IMAGE_ID, requiredLabels: {} },
      packages: new Map([['fixture-local-plugin', fixturePackage()]]),
      expectedArtifactOwnerUid: OWNER_UID,
    })
    await assert.rejects(
      service.runReadAction({
        userId: 7,
        pluginId: 'unlisted-plugin',
        actionId: 'echo',
        params: { text: 'x' },
      }),
      expectCode('ACTION_NOT_FOUND'),
    )
    await assert.rejects(
      service.runReadAction({
        userId: 7,
        pluginId: 'fixture-local-plugin',
        actionId: 'echo',
        params: { nope: true },
      }),
      expectCode('INVALID_PARAMS'),
    )
    assert.equal(fake.created.length, 0)
  })

  test('enforces the per-user concurrency quota', async () => {
    const root = await tempRoot()
    const fake = fakeDocker()
    let releaseInspect!: () => void
    const inspectGate = new Promise<void>((resolve) => {
      releaseInspect = resolve
    })
    ;(fake.docker as unknown as { getImage: Docker['getImage'] }).getImage = () =>
      ({
        inspect: async () => {
          await inspectGate
          return {
            Id: IMAGE_ID,
            Config: {
              Labels: {
                [LOCAL_PLUGIN_IMAGE_ABI_LABEL]: LOCAL_PLUGIN_IMAGE_ABI,
                'oc.runtime.embed_source': '0',
              },
            },
          }
        },
      }) as unknown as ReturnType<Docker['getImage']>
    const limits = { ...DEFAULT_LOCAL_PLUGIN_LIMITS, maxConcurrentPerUser: 1 }
    const service = new LocalPluginSandboxService(fake.docker, {
      artifactRoot: root,
      image: { imageId: IMAGE_ID, requiredLabels: {} },
      packages: new Map([['fixture-local-plugin', fixturePackage()]]),
      limits,
      expectedArtifactOwnerUid: OWNER_UID,
    })
    const first = service.runReadAction({
      userId: 7,
      pluginId: 'fixture-local-plugin',
      actionId: 'echo',
      params: { text: 'first' },
    })
    await assert.rejects(
      service.runReadAction({
        userId: 7,
        pluginId: 'fixture-local-plugin',
        actionId: 'echo',
        params: { text: 'second' },
      }),
      expectCode('QUOTA_EXCEEDED'),
    )
    releaseInspect()
    assert.deepEqual((await first).result, { echo: 'first' })
    assert.equal(fake.created.length, 1)
  })
})
