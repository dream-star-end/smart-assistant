#!/usr/bin/env tsx
/** Deploy-only exact-image smoke and idempotent official Knowledge Planet Plugin seed. */

import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import Docker from 'dockerode'

import { closePool } from '../src/db/index.js'
import { seedKnowledgePlanetPlugin } from '../src/marketplace/seedKnowledgePlanetPlugin.js'
import {
  COMPILED_KNOWLEDGE_PLANET_PLUGIN,
  KNOWLEDGE_PLANET_WORKER_DIGEST,
  KnowledgePlanetDockerService,
} from '../src/plugins/knowledgePlanet.js'
import { resolveKnowledgePlanetLoginPins } from '../src/plugins/knowledgePlanetSetup.js'

const IMAGE_ID_RE = /^sha256:[0-9a-f]{64}$/
const EVIDENCE_PATH = '/run/openclaude-v5/knowledge-planet-plugin-smoke.json'
const EVIDENCE_TTL_MS = 10 * 60_000
const QR_DEADLINE_MS = 90_000

interface SmokeEvidence {
  schemaVersion: 1
  artifactHash: string
  execContractHash: string
  workerDigest: string
  imageId: string
  smokedAt: string
  qrRendered: true
  cleanupVerified: true
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join('\0') === [...keys].sort().join('\0')
}

function imageIdFromEnv(): string {
  if (process.env.OC_RUNTIME_CHANNEL !== 'v5')
    throw new Error('Knowledge Planet Plugin deploy gate is V5-only')
  const imageId = process.env.OC_RUNTIME_IMAGE_ID?.trim() ?? ''
  if (!IMAGE_ID_RE.test(imageId))
    throw new Error('OC_RUNTIME_IMAGE_ID must be an exact sha256 image ID')
  return imageId
}

function dockerClient(): Docker {
  const socketPath = process.env.AGENT_DOCKER_SOCKET?.trim()
  return socketPath ? new Docker({ socketPath }) : new Docker()
}

async function inspectExactImage(docker: Docker, imageId: string): Promise<void> {
  const image = await docker
    .getImage(imageId)
    .inspect()
    .catch(() => null)
  if (!image || image.Id !== imageId) throw new Error('exact runtime image is unavailable')
}

async function writeEvidence(evidence: SmokeEvidence): Promise<void> {
  const root = dirname(EVIDENCE_PATH)
  await mkdir(root, { recursive: true, mode: 0o700 })
  await chmod(root, 0o700)
  const rootStat = await lstat(root)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.uid !== 0)
    throw new Error('Plugin smoke evidence root is unsafe')
  const temporary = `${EVIDENCE_PATH}.tmp-${randomUUID()}`
  const file = await open(temporary, 'wx', 0o600)
  try {
    await file.writeFile(`${JSON.stringify(evidence)}\n`, 'utf8')
    await file.sync()
  } finally {
    await file.close()
  }
  try {
    await chmod(temporary, 0o600)
    await rename(temporary, EVIDENCE_PATH)
  } finally {
    await rm(temporary, { force: true })
  }
  const stat = await lstat(EVIDENCE_PATH)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o777) !== 0o600)
    throw new Error('Plugin smoke evidence file is unsafe')
}

async function readEvidence(imageId: string, now = Date.now()): Promise<SmokeEvidence> {
  const stat = await lstat(EVIDENCE_PATH).catch(() => null)
  if (
    !stat ||
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== 0 ||
    (stat.mode & 0o777) !== 0o600
  )
    throw new Error('valid Knowledge Planet Plugin smoke evidence is required')
  let value: unknown
  try {
    value = JSON.parse(await readFile(EVIDENCE_PATH, 'utf8'))
  } catch {
    throw new Error('Knowledge Planet Plugin smoke evidence is invalid')
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Knowledge Planet Plugin smoke evidence is invalid')
  const evidence = value as Record<string, unknown>
  if (
    !exactKeys(evidence, [
      'schemaVersion',
      'artifactHash',
      'execContractHash',
      'workerDigest',
      'imageId',
      'smokedAt',
      'qrRendered',
      'cleanupVerified',
    ]) ||
    evidence.schemaVersion !== 1 ||
    evidence.artifactHash !== COMPILED_KNOWLEDGE_PLANET_PLUGIN.artifactHash ||
    evidence.execContractHash !== COMPILED_KNOWLEDGE_PLANET_PLUGIN.execContractHash ||
    evidence.workerDigest !== KNOWLEDGE_PLANET_WORKER_DIGEST ||
    evidence.imageId !== imageId ||
    evidence.qrRendered !== true ||
    evidence.cleanupVerified !== true ||
    typeof evidence.smokedAt !== 'string'
  )
    throw new Error('Knowledge Planet Plugin smoke evidence does not match this artifact/image')
  const smokedAt = Date.parse(evidence.smokedAt)
  if (!Number.isFinite(smokedAt) || smokedAt > now + 30_000 || now - smokedAt > EVIDENCE_TTL_MS)
    throw new Error('Knowledge Planet Plugin smoke evidence expired')
  return evidence as unknown as SmokeEvidence
}

async function smokeOnly(): Promise<void> {
  const imageId = imageIdFromEnv()
  const docker = dockerClient()
  await inspectExactImage(docker, imageId)
  const service = new KnowledgePlanetDockerService(docker, {
    imageId,
    workerRoot: '/var/lib/openclaude-v5/plugin-workers',
    brokerRoot: '/run/openclaude-v5/plugin-browser-brokers',
    expectedOwnerUid: 0,
    socketUid: 1000,
    socketGid: 1000,
  })
  const sessionId = randomUUID()
  let handle: Awaited<ReturnType<KnowledgePlanetDockerService['startLogin']>> | null = null
  let qrResolve!: () => void
  let qrFailure: Error | null = null
  const qrReady = new Promise<void>((resolve) => {
    qrResolve = resolve
  })
  try {
    const pins = await resolveKnowledgePlanetLoginPins()
    handle = await service.startLogin({
      sessionId,
      pins,
      deadlineMs: Date.now() + QR_DEADLINE_MS,
      onQr: (png) => {
        if (png.length < 8) qrFailure = new Error('Knowledge Planet QR is empty')
        qrResolve()
      },
      onAuthenticated: () => {
        qrFailure = new Error('unexpected authenticated smoke session')
        qrResolve()
      },
      onFailed: (code) => {
        qrFailure = new Error(`Knowledge Planet login worker failed (${code})`)
        qrResolve()
      },
    })
    let timer: NodeJS.Timeout | undefined
    await Promise.race([
      qrReady,
      handle.done.then(() => {
        throw new Error('Knowledge Planet login worker exited before rendering QR')
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Knowledge Planet QR did not render before the smoke deadline')),
          QR_DEADLINE_MS,
        )
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer)
    })
    if (qrFailure) throw qrFailure
  } finally {
    await handle?.stop().catch(() => {})
    await service.closeAndDrain()
  }
  await writeEvidence({
    schemaVersion: 1,
    artifactHash: COMPILED_KNOWLEDGE_PLANET_PLUGIN.artifactHash,
    execContractHash: COMPILED_KNOWLEDGE_PLANET_PLUGIN.execContractHash,
    workerDigest: KNOWLEDGE_PLANET_WORKER_DIGEST,
    imageId,
    smokedAt: new Date().toISOString(),
    qrRendered: true,
    cleanupVerified: true,
  })
  process.stdout.write('Knowledge Planet Plugin exact-image QR smoke passed; cleanup verified.\n')
}

async function seedOnly(): Promise<void> {
  const imageId = imageIdFromEnv()
  const docker = dockerClient()
  await inspectExactImage(docker, imageId)
  await readEvidence(imageId)
  const result = await seedKnowledgePlanetPlugin({
    functionalVerified: true,
    env: process.env,
  })
  await rm(EVIDENCE_PATH, { force: true })
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

async function main(): Promise<void> {
  const mode = process.argv[2]
  if (process.argv.length !== 3 || (mode !== '--smoke-only' && mode !== '--seed-only'))
    throw new Error('usage: seed-knowledge-planet-plugin.ts --smoke-only|--seed-only')
  try {
    if (mode === '--smoke-only') await smokeOnly()
    else await seedOnly()
  } finally {
    await closePool().catch(() => {})
  }
}

main().catch((error) => {
  process.stderr.write(
    `Knowledge Planet Plugin deploy gate failed: ${error instanceof Error ? error.message : String(error)}\n`,
  )
  process.exitCode = 1
})
