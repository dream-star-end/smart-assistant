import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, test } from 'node:test'

import type Docker from 'dockerode'

import { RuntimePluginContractError, validateRuntimePluginJson } from './contracts.js'

import {
  COMPILED_KNOWLEDGE_PLANET_PLUGIN,
  KNOWLEDGE_PLANET_DRIVER_ID,
  KNOWLEDGE_PLANET_DRIVER_VERSION,
  KNOWLEDGE_PLANET_LAUNCHER_ID,
  KNOWLEDGE_PLANET_LAUNCHER_VERSION,
  KNOWLEDGE_PLANET_LOGIN_ORIGINS,
  KNOWLEDGE_PLANET_PLUGIN_CONTRACT,
  KNOWLEDGE_PLANET_PLUGIN_SLUG,
  KNOWLEDGE_PLANET_PLUGIN_VERSION,
  KNOWLEDGE_PLANET_SETUP_COMPATIBLE_PREDECESSORS,
  KNOWLEDGE_PLANET_WORKER_DIGEST,
  KnowledgePlanetDockerService,
  KnowledgePlanetRuntimeError,
  classifyKnowledgePlanetSetupPin,
  createKnowledgePlanetRuntimeRegistries,
  decodeKnowledgePlanetWorkerFramesForTest,
  isOfficialKnowledgePlanetPluginIdentity,
} from './knowledgePlanet.js'
import {
  KNOWLEDGE_PLANET_LOGIN_PROBE_INITIAL_DELAY_MS,
  KNOWLEDGE_PLANET_LOGIN_PROBE_INTERVAL_MS,
  KNOWLEDGE_PLANET_LOGIN_PROBE_MAX_ATTEMPTS,
  KNOWLEDGE_PLANET_QR_CAPTURE_TIMEOUT_MS,
  KNOWLEDGE_PLANET_QR_MIN_DARK_FRACTION,
  KNOWLEDGE_PLANET_QR_MIN_LIGHT_FRACTION,
  KNOWLEDGE_PLANET_QR_MIN_LUMINANCE_DEVIATION,
  KNOWLEDGE_PLANET_TOPIC_PAGE_MAX,
  KNOWLEDGE_PLANET_WORKER_MAX_OUTPUT_BYTES,
  KNOWLEDGE_PLANET_WORKER_MAX_STATE_JSON_BYTES,
  KNOWLEDGE_PLANET_WORKER_SOURCE,
  isKnowledgePlanetLoginProbeDue,
  isKnowledgePlanetQrPixelSampleReady,
} from './knowledgePlanetWorkerSource.js'

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

  test('accepts only the current or exact signed v1.0 pin for product setup', () => {
    assert.equal(
      classifyKnowledgePlanetSetupPin({
        version: KNOWLEDGE_PLANET_PLUGIN_VERSION,
        artifactHash: COMPILED_KNOWLEDGE_PLANET_PLUGIN.artifactHash,
        execContractHash: COMPILED_KNOWLEDGE_PLANET_PLUGIN.execContractHash,
      }),
      'current',
    )
    assert.equal(KNOWLEDGE_PLANET_SETUP_COMPATIBLE_PREDECESSORS.length, 1)
    assert.equal(
      classifyKnowledgePlanetSetupPin(KNOWLEDGE_PLANET_SETUP_COMPATIBLE_PREDECESSORS[0]!),
      'compatible-predecessor',
    )
    assert.equal(
      classifyKnowledgePlanetSetupPin({
        ...KNOWLEDGE_PLANET_SETUP_COMPATIBLE_PREDECESSORS[0]!,
        execContractHash: '0'.repeat(64),
      }),
      null,
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

  test('v1.1 exposes the complete bounded read surface without credential-bearing result fields', () => {
    assert.equal(KNOWLEDGE_PLANET_PLUGIN_VERSION, '1.1.0')
    assert.deepEqual(
      KNOWLEDGE_PLANET_PLUGIN_CONTRACT.actions.map((action) => action.id),
      [
        'list_groups',
        'get_group',
        'list_topics',
        'get_topic',
        'list_comments',
        'search_topics',
        'list_dynamics',
        'get_unread_counts',
        'list_hashtags',
        'list_hashtag_topics',
        'list_columns',
        'list_column_topics',
        'list_checkins',
        'get_checkin',
        'list_checkin_topics',
      ],
    )
    const forbidden = /(?:url|uri|href|token|cookie|header|signature|secret)/i
    const visit = (schema: unknown): void => {
      if (!schema || typeof schema !== 'object') return
      if (Array.isArray(schema)) {
        for (const child of schema) visit(child)
        return
      }
      for (const [key, child] of Object.entries(schema)) {
        if (key === 'properties' && child && typeof child === 'object')
          for (const property of Object.keys(child)) assert.doesNotMatch(property, forbidden)
        visit(child)
      }
    }
    for (const action of KNOWLEDGE_PLANET_PLUGIN_CONTRACT.actions) visit(action.result)
  })

  test('declares the same numeric ID domain enforced by every worker action path', () => {
    let checked = 0
    for (const action of KNOWLEDGE_PLANET_PLUGIN_CONTRACT.actions) {
      const schema = action.params as {
        properties?: Record<string, Record<string, unknown>>
        required?: string[]
      }
      const idNames = Object.keys(schema.properties ?? {}).filter((name) => name.endsWith('Id'))
      if (idNames.length === 0) continue
      const valid: Record<string, unknown> = {}
      for (const name of schema.required ?? []) valid[name] = name === 'keyword' ? 'x' : '123456'
      validateRuntimePluginJson(action.params, valid, 'params')
      for (const name of idNames) {
        assert.deepEqual(schema.properties?.[name], {
          type: 'string',
          minLength: 6,
          maxLength: 32,
          pattern: '^[0-9]{6,32}$',
        })
        assert.throws(
          () => validateRuntimePluginJson(action.params, { ...valid, [name]: 'abcdef' }, 'params'),
          (error: unknown) =>
            error instanceof RuntimePluginContractError && error.code === 'INVALID_PARAMS',
          `${action.id}.${name}`,
        )
        checked++
      }
    }
    assert.equal(checked, 15)
    assert.match(KNOWLEDGE_PLANET_WORKER_SOURCE, /const NUMERIC_ID = \/\^\\d\{6,32\}\$\//)
  })

  test('login API probe is delayed, five-second limited and capped at 48 attempts', () => {
    assert.equal(KNOWLEDGE_PLANET_LOGIN_PROBE_INITIAL_DELAY_MS, 3_000)
    assert.equal(KNOWLEDGE_PLANET_LOGIN_PROBE_INTERVAL_MS, 5_000)
    assert.equal(KNOWLEDGE_PLANET_LOGIN_PROBE_MAX_ATTEMPTS, 48)
    assert.equal(isKnowledgePlanetLoginProbeDue(2_999, 3_000, 0), false)
    assert.equal(isKnowledgePlanetLoginProbeDue(3_000, 3_000, 0), true)
    assert.equal(isKnowledgePlanetLoginProbeDue(999_999, 3_000, 48), false)
  })

  test('flushes authenticated state before exiting so host cleanup can finish immediately', () => {
    assert.match(
      KNOWLEDGE_PLANET_WORKER_SOURCE,
      /async function writeTerminalAndExit\(value\)[\s\S]*process\.stdout\.write\(output, \(error\) => error \? reject\(error\) : resolve\(\)\);[\s\S]*process\.exit\(0\)/,
    )
    assert.match(
      KNOWLEDGE_PLANET_WORKER_SOURCE,
      /async function writeAuthenticatedAndExit\(storageState\) \{[\s\S]*await writeTerminalAndExit\(\{ event: 'authenticated', storageState \}\)/,
    )
    const loginStart = KNOWLEDGE_PLANET_WORKER_SOURCE.indexOf('async function runLogin')
    const entrypointStart = KNOWLEDGE_PLANET_WORKER_SOURCE.indexOf('\ntry {', loginStart)
    assert.ok(loginStart >= 0 && entrypointStart > loginStart)
    const loginSource = KNOWLEDGE_PLANET_WORKER_SOURCE.slice(loginStart, entrypointStart)
    assert.match(
      loginSource,
      /const state = filteredState\([\s\S]*await writeAuthenticatedAndExit\(state\)/,
    )
    assert.doesNotMatch(loginSource, /writeFrame\(\{ event: 'authenticated'/)
  })

  test('flushes action terminal frames before exiting instead of waiting on proxy cleanup', () => {
    const actionStart = KNOWLEDGE_PLANET_WORKER_SOURCE.indexOf('async function runAction')
    const probeStart = KNOWLEDGE_PLANET_WORKER_SOURCE.indexOf(
      '\nasync function authenticatedProbe',
      actionStart,
    )
    assert.ok(actionStart >= 0 && probeStart > actionStart)
    const actionSource = KNOWLEDGE_PLANET_WORKER_SOURCE.slice(actionStart, probeStart)
    assert.match(
      actionSource,
      /if \(!response\.ok\(\) \|\| data\?\.succeeded !== true\) \{[\s\S]*await writeTerminalAndExit\(\{ event: 'failed'/,
    )
    assert.match(actionSource, /await writeTerminalAndExit\(completed\)/)
    assert.doesNotMatch(actionSource, /writeFrame\(completed\)/)
    assert.doesNotMatch(actionSource, /writeFrame\(\{ event: 'failed'/)
  })

  test('waits for the real QR image and never publishes the iframe loading mask', () => {
    assert.equal(KNOWLEDGE_PLANET_QR_CAPTURE_TIMEOUT_MS, 45_000)
    assert.equal(KNOWLEDGE_PLANET_QR_MIN_DARK_FRACTION, 0.15)
    assert.equal(KNOWLEDGE_PLANET_QR_MIN_LIGHT_FRACTION, 0.2)
    assert.equal(KNOWLEDGE_PLANET_QR_MIN_LUMINANCE_DEVIATION, 70)
    assert.equal(
      isKnowledgePlanetQrPixelSampleReady({
        darkFraction: 0.378,
        lightFraction: 0.547,
        luminanceDeviation: 117.9,
      }),
      true,
    )
    assert.equal(
      isKnowledgePlanetQrPixelSampleReady({
        darkFraction: 0.0011,
        lightFraction: 0.7,
        luminanceDeviation: 19.25,
      }),
      false,
    )
    const captureStart = KNOWLEDGE_PLANET_WORKER_SOURCE.indexOf('async function captureQr')
    const captureEnd = KNOWLEDGE_PLANET_WORKER_SOURCE.indexOf('async function runLogin')
    assert.ok(captureStart >= 0 && captureEnd > captureStart)
    const captureSource = KNOWLEDGE_PLANET_WORKER_SOURCE.slice(captureStart, captureEnd)
    assert.match(
      KNOWLEDGE_PLANET_WORKER_SOURCE,
      /async function beforeCaptureDeadline\(operation,[\s\S]*Promise\.race\([\s\S]*Promise\.resolve\(\)\.then\(operation\)[\s\S]*setTimeout\(\(\) => reject\(new Error\('qr'\)\), remaining\)/,
    )
    assert.match(captureSource, /while \(Date\.now\(\) < captureDeadline\)/)
    assert.match(captureSource, /let requested = false/)
    assert.match(captureSource, /let consentHandled = false/)
    assert.match(captureSource, /consentHandled = true;[\s\S]*requested = false/)
    assert.match(
      captureSource,
      /requested = await beforeCaptureDeadline\([\s\S]*\(\) => qrButton\.click\(\{ timeout:/,
    )
    assert.match(captureSource, /!element\.complete \|\| element\.naturalWidth < 180/)
    assert.match(captureSource, /style\.filter !== 'none'/)
    assert.match(captureSource, /Number\(style\.opacity\) < 0\.99/)
    assert.match(captureSource, /document\.elementFromPoint\([\s\S]*\) !== element/)
    assert.match(captureSource, /sampleContext\.fillStyle = '#fff'/)
    assert.match(captureSource, /sampleContext\.imageSmoothingEnabled = false/)
    assert.match(captureSource, /sampleContext\.getImageData/)
    assert.match(captureSource, /output\.toDataURL\('image\/png'\)/)
    assert.match(captureSource, /png\.toString\('base64'\) !== encodedQr/)
    assert.match(captureSource, /Buffer\.from\(\[137, 80, 78, 71, 13, 10, 26, 10\]\)/)
    assert.match(
      captureSource,
      /beforeCaptureDeadline\(\(\) => image\.isVisible\(\), captureDeadline\)/,
    )
    assert.match(
      captureSource,
      /beforeCaptureDeadline\(\(\) => images\.count\(\), captureDeadline\)/,
    )
    assert.match(
      captureSource,
      /beforeCaptureDeadline\([\s\S]*\(\) => image\.evaluate\([\s\S]*undefined,[\s\S]*timeout: remainingCaptureTimeout\(captureDeadline\)[\s\S]*captureDeadline/,
    )
    assert.match(captureSource, /remainingCaptureTimeout\(captureDeadline\);\s*return png/)
    assert.doesNotMatch(captureSource, /\.screenshot\(|iframe/)
    assert.match(
      KNOWLEDGE_PLANET_WORKER_SOURCE,
      /const qrCaptureDeadline = Math\.min\(input\.deadlineMs,[\s\S]*const qrButton =[\s\S]*const switchButton =[\s\S]*const qr = await beforeCaptureDeadline\([\s\S]*captureQr\(page, qrButton, switchButton, qrCaptureDeadline\)[\s\S]*remainingCaptureTimeout\(qrCaptureDeadline\);\s*writeFrame/,
    )
    const deadlineStart = KNOWLEDGE_PLANET_WORKER_SOURCE.indexOf('const qrCaptureDeadline')
    const captureCall = KNOWLEDGE_PLANET_WORKER_SOURCE.indexOf(
      'const qr = await beforeCaptureDeadline(',
    )
    assert.ok(deadlineStart >= 0 && captureCall > deadlineStart)
    assert.doesNotMatch(
      KNOWLEDGE_PLANET_WORKER_SOURCE.slice(deadlineStart, captureCall),
      /\.click\(\)/,
    )
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

  test('keeps worst-case topic pages plus account state below the worker frame ceiling', () => {
    const jsonStringAtMost = (bytes: number) => '汉'.repeat(Math.floor((bytes - 2) / 3))
    const topic = {
      id: '123456',
      title: jsonStringAtMost(1024),
      text: jsonStringAtMost(12 * 1024),
      question: jsonStringAtMost(8 * 1024),
      answer: jsonStringAtMost(8 * 1024),
      article: { title: jsonStringAtMost(1024), summary: jsonStringAtMost(4 * 1024) },
      files: Array.from({ length: 10 }, (_, index) => ({
        id: String(123456 + index),
        name: jsonStringAtMost(1024),
        type: jsonStringAtMost(256),
      })),
      images: Array.from({ length: 10 }, (_, index) => ({ id: String(223456 + index) })),
    }
    const storageState = {
      cookies: [{ value: 'x'.repeat(KNOWLEDGE_PLANET_WORKER_MAX_STATE_JSON_BYTES - 128) }],
      origins: [],
    }
    const stateBytes = Buffer.byteLength(JSON.stringify(storageState), 'utf8')
    assert.ok(stateBytes <= KNOWLEDGE_PLANET_WORKER_MAX_STATE_JSON_BYTES)
    const completed = {
      event: 'completed',
      result: { topics: Array.from({ length: KNOWLEDGE_PLANET_TOPIC_PAGE_MAX }, () => topic) },
      storageState,
    }
    assert.ok(
      Buffer.byteLength(JSON.stringify(completed), 'utf8') <
        KNOWLEDGE_PLANET_WORKER_MAX_OUTPUT_BYTES,
    )
    assert.match(KNOWLEDGE_PLANET_WORKER_SOURCE, /while \(result\[listKey\]\.length > 0/)
  })

  test('decodes coalesced ready plus a near-limit completed frame independently', () => {
    const workerFrame = (value: unknown) => {
      const body = Buffer.from(JSON.stringify(value))
      const header = Buffer.alloc(4)
      header.writeUInt32BE(body.length)
      return Buffer.concat([header, body])
    }
    const ready = workerFrame({
      event: 'ready',
      runtime: 'knowledge-planet-worker-v1.1',
      playwrightMcpVersion: '0.0.76',
    })
    const completedBase = {
      event: 'completed',
      result: { padding: '' },
      storageState: { cookies: [], origins: [] },
    }
    const completed = workerFrame({
      ...completedBase,
      result: {
        padding: 'x'.repeat(
          KNOWLEDGE_PLANET_WORKER_MAX_OUTPUT_BYTES -
            Buffer.byteLength(JSON.stringify(completedBase), 'utf8'),
        ),
      },
    })
    assert.equal(completed.length, KNOWLEDGE_PLANET_WORKER_MAX_OUTPUT_BYTES + 4)
    assert.ok(ready.length + completed.length > KNOWLEDGE_PLANET_WORKER_MAX_OUTPUT_BYTES + 4)
    assert.equal(
      decodeKnowledgePlanetWorkerFramesForTest(Buffer.concat([ready, completed])),
      2,
    )
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
    let listFilters: unknown
    const attempted: string[] = []
    const created = { id: 'new-worker' } as unknown as Docker.Container
    const docker = {
      async createContainer(options: Docker.ContainerCreateOptions) {
        attempted.push(options.name ?? '')
        if (occupied) throw Object.assign(new Error('name is already in use'), { statusCode: 409 })
        return created
      },
      async listContainers(options?: Docker.ContainerListOptions) {
        listFilters = options?.filters ?? ''
        return occupied
          ? [
              {
                Id: 'foreign-worker',
                Labels: {
                  'com.openclaude.plugin.worker': 'another-managed-browser-plugin-v1',
                  'com.openclaude.plugin.expires_at_ms': String(Date.now() - 60_000),
                },
              },
              {
                Id: 'expired-worker',
                Labels: {
                  'com.openclaude.plugin.worker': 'knowledge-planet-v1',
                  'com.openclaude.plugin.expires_at_ms': String(Date.now() - 60_000),
                },
              },
            ]
          : []
      },
      getContainer(id: string) {
        assert.equal(id, 'expired-worker')
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
    assert.deepEqual(typeof listFilters === 'string' ? JSON.parse(listFilters) : listFilters, {
      label: ['com.openclaude.plugin.worker'],
    })
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
