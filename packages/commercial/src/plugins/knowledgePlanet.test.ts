import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, test } from 'node:test'

import type Docker from 'dockerode'

import {
  COMPILED_KNOWLEDGE_PLANET_PLUGIN,
  KNOWLEDGE_PLANET_DRIVER_ID,
  KNOWLEDGE_PLANET_DRIVER_VERSION,
  KNOWLEDGE_PLANET_LAUNCHER_ID,
  KNOWLEDGE_PLANET_LAUNCHER_VERSION,
  KNOWLEDGE_PLANET_LOGIN_ORIGINS,
  KNOWLEDGE_PLANET_PLUGIN_CONTRACT,
  KNOWLEDGE_PLANET_PLUGIN_SLUG,
  KNOWLEDGE_PLANET_WORKER_DIGEST,
  KnowledgePlanetDockerService,
  KnowledgePlanetRuntimeError,
  createKnowledgePlanetRuntimeRegistries,
  isOfficialKnowledgePlanetPluginIdentity,
} from './knowledgePlanet.js'
import { KNOWLEDGE_PLANET_WORKER_SOURCE } from './knowledgePlanetWorkerSource.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('official Knowledge Planet Plugin', () => {
  test('requires platform provenance as well as both exact signed hashes for official identity', () => {
    const exact = {
      slug: KNOWLEDGE_PLANET_PLUGIN_SLUG,
      pluginType: 'managed-browser',
      artifactHash: COMPILED_KNOWLEDGE_PLANET_PLUGIN.artifactHash,
      execContractHash: COMPILED_KNOWLEDGE_PLANET_PLUGIN.execContractHash,
    }
    assert.equal(
      isOfficialKnowledgePlanetPluginIdentity({ ...exact, reviewSource: 'human' }),
      false,
      'a human-approved copy of public artifact bytes must never receive the official badge',
    )
    assert.equal(
      isOfficialKnowledgePlanetPluginIdentity({ ...exact, reviewSource: 'platform' }),
      true,
    )
    assert.equal(
      isOfficialKnowledgePlanetPluginIdentity({
        ...exact,
        execContractHash: '0'.repeat(64),
        reviewSource: 'platform',
      }),
      false,
    )
  })

  test('has a read-only action network separated from login/account state', () => {
    assert.equal(COMPILED_KNOWLEDGE_PLANET_PLUGIN.pluginType, 'managed-browser')
    assert.deepEqual(KNOWLEDGE_PLANET_PLUGIN_CONTRACT.runtime.network, {
      origins: ['https://api.zsxq.com:443'],
      methods: ['GET'],
      forbiddenChannels: [
        'background-network',
        'doh',
        'proxy',
        'quic',
        'websocket',
        'webrtc',
        'worker',
      ],
      redirects: 'revalidate-every-hop',
      ipv4PinsRequired: true,
    })
    assert.ok(KNOWLEDGE_PLANET_PLUGIN_CONTRACT.runtime.accountState.origins.length > 1)
    assert.ok(KNOWLEDGE_PLANET_LOGIN_ORIGINS.includes('https://open.weixin.qq.com:443'))
    assert.ok(KNOWLEDGE_PLANET_PLUGIN_CONTRACT.actions.every((action) => action.effect === 'read'))
  })

  test('materialized worker source is valid JavaScript', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oc-kp-worker-source-'))
    roots.push(root)
    const path = join(root, 'worker.mjs')
    await writeFile(path, KNOWLEDGE_PLANET_WORKER_SOURCE)
    const status = await new Promise<number | null>((resolveStatus) => {
      const child = spawn(process.execPath, ['--check', path], { stdio: 'ignore' })
      child.once('exit', resolveStatus)
    })
    assert.equal(status, 0)
  })

  test('normalizes explicit-port login pins before browser route checks', () => {
    assert.ok(KNOWLEDGE_PLANET_LOGIN_ORIGINS.every((origin) => origin.endsWith(':443')))
    assert.ok(
      KNOWLEDGE_PLANET_WORKER_SOURCE.includes(
        'new Set(input.allowedOrigins.map((origin) => new URL(origin).origin))',
      ),
    )
  })

  test('registers only the fixed official driver/launcher pair', () => {
    const service = {} as KnowledgePlanetDockerService
    const registries = createKnowledgePlanetRuntimeRegistries(service)
    assert.deepEqual(
      [...registries.drivers.keys()],
      [`${KNOWLEDGE_PLANET_DRIVER_ID}@${KNOWLEDGE_PLANET_DRIVER_VERSION}`],
    )
    assert.deepEqual(
      [...registries.launchers.keys()],
      [`${KNOWLEDGE_PLANET_LAUNCHER_ID}@${KNOWLEDGE_PLANET_LAUNCHER_VERSION}`],
    )
    assert.equal(KNOWLEDGE_PLANET_DRIVER_ID, `kp-${KNOWLEDGE_PLANET_WORKER_DIGEST.slice(0, 60)}`)
    assert.equal(
      KNOWLEDGE_PLANET_LAUNCHER_ID,
      `kp-container-${KNOWLEDGE_PLANET_WORKER_DIGEST.slice(0, 50)}`,
    )
  })

  test('refuses a tag before any Docker worker can be created', async () => {
    let inspected = false
    const docker = {
      getImage() {
        inspected = true
        throw new Error('must not inspect a tag')
      },
    } as unknown as Docker
    const service = new KnowledgePlanetDockerService(docker, {
      imageId: 'openclaude-runtime:v5',
      workerRoot: '/tmp/not-used',
      brokerRoot: '/tmp/not-used',
    })
    await assert.rejects(
      service.runAction({
        profileDir: '/tmp/not-used-profile',
        pins: [],
        storageState: { cookies: [], origins: [] },
        actionId: 'list_groups',
        params: {},
        deadlineMs: Date.now() + 10_000,
      }),
      (error: unknown) =>
        error instanceof KnowledgePlanetRuntimeError && error.code === 'IMAGE_MISMATCH',
    )
    assert.equal(inspected, false)
  })

  test('uses fixed Docker slots as an atomic host-wide total cap', async () => {
    const attempted: string[] = []
    const docker = {
      async createContainer(options: Docker.ContainerCreateOptions) {
        attempted.push(options.name ?? '')
        throw Object.assign(new Error('name is already in use'), { statusCode: 409 })
      },
      async listContainers() {
        return []
      },
    } as unknown as Docker
    const service = new KnowledgePlanetDockerService(docker, {
      imageId: `sha256:${'0'.repeat(64)}`,
      workerRoot: '/tmp/not-used',
      brokerRoot: '/tmp/not-used',
      maxWorkers: 2,
    })
    const createInSlot = (
      service as unknown as {
        createContainerInHostSlot(options: Docker.ContainerCreateOptions): Promise<Docker.Container>
      }
    ).createContainerInHostSlot.bind(service)
    await assert.rejects(
      createInSlot({ Image: `sha256:${'0'.repeat(64)}` }),
      (error: unknown) =>
        error instanceof KnowledgePlanetRuntimeError && error.code === 'CAPACITY_EXCEEDED',
    )
    assert.deepEqual(attempted, ['oc-v5-kp-worker-slot-0', 'oc-v5-kp-worker-slot-1'])
  })

  test('reclaims an expired fixed-slot orphan and retries without a gateway restart', async () => {
    let occupied = true
    let removals = 0
    const attempted: string[] = []
    const created = { id: 'new-worker' } as unknown as Docker.Container
    const docker = {
      async createContainer(options: Docker.ContainerCreateOptions) {
        attempted.push(options.name ?? '')
        if (occupied) throw Object.assign(new Error('name is already in use'), { statusCode: 409 })
        return created
      },
      async listContainers() {
        return occupied
          ? [
              {
                Id: 'expired-worker',
                Labels: {
                  'com.openclaude.plugin.expires_at_ms': String(Date.now() - 60_000),
                },
              },
            ]
          : []
      },
      getContainer() {
        return {
          async kill() {},
          async remove() {
            removals++
            occupied = false
          },
          async inspect() {
            return occupied ? {} : null
          },
        }
      },
    } as unknown as Docker
    const service = new KnowledgePlanetDockerService(docker, {
      imageId: `sha256:${'0'.repeat(64)}`,
      workerRoot: '/tmp/not-used',
      brokerRoot: '/tmp/not-used',
      orphanGraceMs: 0,
      maxWorkers: 1,
    })
    const createInSlot = (
      service as unknown as {
        createContainerInHostSlot(options: Docker.ContainerCreateOptions): Promise<Docker.Container>
      }
    ).createContainerInHostSlot.bind(service)
    assert.equal(await createInSlot({ Image: `sha256:${'0'.repeat(64)}` }), created)
    assert.equal(removals, 1)
    assert.deepEqual(attempted, ['oc-v5-kp-worker-slot-0', 'oc-v5-kp-worker-slot-0'])
  })

  test('does not create a worker if an action aborts during image initialization', async () => {
    const imageId = `sha256:${'0'.repeat(64)}`
    let resolveInspect!: () => void
    const inspect = new Promise<{ Id: string }>((resolve) => {
      resolveInspect = () => resolve({ Id: imageId })
    })
    let created = false
    const docker = {
      getImage() {
        return { inspect: () => inspect }
      },
      async listContainers() {
        return []
      },
      createContainer() {
        created = true
        throw new Error('worker must not be created after abort')
      },
    } as unknown as Docker
    const root = await mkdtemp(join(tmpdir(), 'oc-kp-abort-'))
    roots.push(root)
    const service = new KnowledgePlanetDockerService(docker, {
      imageId,
      workerRoot: join(root, 'workers'),
      brokerRoot: join(root, 'brokers'),
    })
    const controller = new AbortController()
    const aborted = new Error('cancelled')
    const action = service.runAction({
      profileDir: join(root, 'profile'),
      pins: [],
      storageState: { cookies: [], origins: [] },
      actionId: 'list_groups',
      params: {},
      deadlineMs: Date.now() + 10_000,
      signal: controller.signal,
    })
    controller.abort(aborted)
    resolveInspect()
    await assert.rejects(action, (error: unknown) => error === aborted)
    assert.equal(created, false)
  })

  test('atomically caps pending action workers and releases capacity after startup abort', async () => {
    const imageId = `sha256:${'1'.repeat(64)}`
    let resolveInspect!: () => void
    const inspect = new Promise<{ Id: string }>((resolve) => {
      resolveInspect = () => resolve({ Id: imageId })
    })
    let created = false
    const docker = {
      getImage() {
        return { inspect: () => inspect }
      },
      async listContainers() {
        return []
      },
      createContainer() {
        created = true
        throw new Error('worker must not be created after abort')
      },
    } as unknown as Docker
    const root = await mkdtemp(join(tmpdir(), 'oc-kp-capacity-'))
    roots.push(root)
    const service = new KnowledgePlanetDockerService(docker, {
      imageId,
      workerRoot: join(root, 'workers'),
      brokerRoot: join(root, 'brokers'),
      maxWorkers: 1,
      maxActionWorkers: 1,
    })
    const firstController = new AbortController()
    const first = service.runAction({
      profileDir: join(root, 'profile-1'),
      pins: [],
      storageState: { cookies: [], origins: [] },
      actionId: 'list_groups',
      params: {},
      deadlineMs: Date.now() + 10_000,
      signal: firstController.signal,
    })
    await assert.rejects(
      service.runAction({
        profileDir: join(root, 'profile-2'),
        pins: [],
        storageState: { cookies: [], origins: [] },
        actionId: 'list_groups',
        params: {},
        deadlineMs: Date.now() + 10_000,
      }),
      (error: unknown) =>
        error instanceof KnowledgePlanetRuntimeError && error.code === 'CAPACITY_EXCEEDED',
    )
    const firstAbort = new Error('first cancelled')
    firstController.abort(firstAbort)
    resolveInspect()
    await assert.rejects(first, (error: unknown) => error === firstAbort)

    const nextController = new AbortController()
    const nextAbort = new Error('next cancelled')
    const next = service.runAction({
      profileDir: join(root, 'profile-3'),
      pins: [],
      storageState: { cookies: [], origins: [] },
      actionId: 'list_groups',
      params: {},
      deadlineMs: Date.now() + 10_000,
      signal: nextController.signal,
    })
    nextController.abort(nextAbort)
    await assert.rejects(next, (error: unknown) => error === nextAbort)
    assert.equal(created, false)
  })

  test('caps concurrent login workers and shutdown waits for pending reservations', async () => {
    const imageId = `sha256:${'2'.repeat(64)}`
    let resolveInspect!: () => void
    const inspect = new Promise<{ Id: string }>((resolve) => {
      resolveInspect = () => resolve({ Id: imageId })
    })
    let created = false
    const docker = {
      getImage() {
        return { inspect: () => inspect }
      },
      async listContainers() {
        return []
      },
      createContainer() {
        created = true
        throw new Error('worker must not start while closing')
      },
    } as unknown as Docker
    const root = await mkdtemp(join(tmpdir(), 'oc-kp-login-capacity-'))
    roots.push(root)
    const service = new KnowledgePlanetDockerService(docker, {
      imageId,
      workerRoot: join(root, 'workers'),
      brokerRoot: join(root, 'brokers'),
      maxWorkers: 2,
      maxLoginWorkers: 1,
    })
    const callbacks = {
      pins: [],
      deadlineMs: Date.now() + 10_000,
      onQr() {},
      onAuthenticated() {},
      onFailed() {},
    }
    const first = service.startLogin({ sessionId: randomUUID(), ...callbacks })
    await assert.rejects(
      service.startLogin({ sessionId: randomUUID(), ...callbacks }),
      (error: unknown) =>
        error instanceof KnowledgePlanetRuntimeError && error.code === 'CAPACITY_EXCEEDED',
    )
    const closing = service.closeAndDrain()
    resolveInspect()
    await assert.rejects(
      first,
      (error: unknown) => error instanceof KnowledgePlanetRuntimeError && error.code === 'CLOSING',
    )
    await closing
    assert.equal(created, false)
  })
})
