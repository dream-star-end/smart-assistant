import { afterAll, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { unlink } from 'node:fs/promises'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname } from 'node:path'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { agentRemoteContentHash } from '@openclaude/protocol/agentRemote'
import {
  type NativeDeliveryCommit,
  type NativeDeliveryPreparation,
  type NativeDeliveryWriterProof,
  type NativeMessageProjection,
  type NativeTranscriptTarget,
  nativeDeliveryCommitHash,
  nativeDeliveryPreparationHash,
  nativeTranscriptMessageHash,
} from '@openclaude/protocol/agentRemoteNativeDelivery'
import { nativeArtifactManifestHash } from '../../../../packages/storage/src/nativeArtifactInstaller.js'
import { getSessionId, getSessionProjectDir, switchSession } from '../../bootstrap/state.js'
import * as storage from '../sessionStorage.js'

const sid = '00000000-0000-4000-8000-000000000003'
if (!process.env.NATIVE_ARTIFACT_TEST_LOCK_PATH) {
  test('native CCB delivery integration runs in its actual session lock owner', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentremote-ccb-artifact-runner-'))
    const lock = join(directory, `${sid}.lock`)
    const child = spawn(
      '/usr/bin/flock',
      [
        '--no-fork',
        lock,
        process.execPath,
        'test',
        fileURLToPath(import.meta.url),
        '--timeout',
        '30000',
      ],
      {
        env: {
          PATH: process.env.PATH,
          HOME: join(directory, 'home'),
          CLAUDE_CONFIG_DIR: join(directory, 'config'),
          OPENCLAUDE_HOME: join(directory, 'openclaude'),
          TMPDIR: directory,
          CLAUDE_CODE_TMPDIR: directory,
          NODE_ENV: 'test',
          CLAUDE_CODE_VERSION: '2.8.4',
          CLAUDE_CODE_SIMPLE: '1',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          DISABLE_AUTO_COMPACT: '1',
          NATIVE_ARTIFACT_TEST_LOCK_PATH: lock,
        },
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    const closed = once(child, 'close')
    const stop = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }
    const deadline = setTimeout(stop, 150000)
    let output = ''
    child.stdout.on('data', (bytes) => {
      output = (output + bytes.toString()).slice(-65536)
    })
    child.stderr.on('data', (bytes) => {
      output = (output + bytes.toString()).slice(-65536)
    })
    try {
      const [code] = await closed
      expect({ code, output: code ? output : '' }).toEqual({ code: 0, output: '' })
    } finally {
      clearTimeout(deadline)
      if (child.exitCode === null && child.signalCode === null) {
        stop()
        await closed.catch(() => {})
      }
      await rm(directory, { recursive: true, force: true })
    }
  }, 180000)
} else {
  async function fixture(run: (directory: string, file: string, session: string) => Promise<void>) {
    const directory = await mkdtemp(join(tmpdir(), 'agentremote-ccb-artifact-'))
    const project = join(directory, 'projects', 'fixture')
    const file = join(project, `${sid}.jsonl`)
    const keys = [
      'CLAUDE_CONFIG_DIR',
      'OPENCLAUDE_TRANSCRIPT_INTEGRITY',
      'TEST_ENABLE_SESSION_PERSISTENCE',
    ]
    const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
    const originalSid = getSessionId()
    const originalProject = getSessionProjectDir()
    try {
      process.env.CLAUDE_CONFIG_DIR = directory
      process.env.OPENCLAUDE_TRANSCRIPT_INTEGRITY = '1'
      process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
      await mkdir(project, { recursive: true, mode: 0o700 })
      await writeFile(file, '', { mode: 0o600 })
      switchSession(sid as any, project)
      storage.resetProjectForTesting()
      storage.clearSessionMessagesCache()
      storage.setSessionFileForTesting(file)
      await run(directory, file, join(project, sid))
    } finally {
      try {
        await storage.flushSessionStorage()
      } catch {
        /* The negative producer already observed the failure. */
      }
      storage.resetProjectForTesting()
      storage.clearSessionMessagesCache()
      switchSession(originalSid, originalProject)
      for (const [key, value] of Object.entries(saved))
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      await rm(directory, { recursive: true, force: true })
    }
  }
  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
  const timestamp = '2026-11-01T00:00:00.000Z'
  function message(
    n: number,
    type: 'user' | 'assistant' = 'user',
    text = 'synthetic native result',
  ) {
    return {
      type,
      uuid: uuid(n),
      timestamp,
      message: {
        role: type,
        ...(type === 'assistant' ? { id: `model-${n}` } : {}),
        content: [{ type: 'text', text }],
      },
    }
  }
  async function start() {
    await storage.recordTranscript(
      [message(0), message(1, 'assistant')] as any,
      undefined,
      undefined,
      undefined,
      true,
    )
    await storage.flushSessionStorage()
  }
  function prepare(
    messages: unknown[],
    projections?: NativeMessageProjection[],
    artifacts: any[] = [],
  ) {
    const rows = messages as Record<string, any>[]
    const payloadHash = 'a'.repeat(64)
    const base = {
      version: 1 as const,
      receiptHash: 'b'.repeat(64),
      projectionVersion: 1 as const,
      source: {
        kind: 'execution' as const,
        hostInstanceId: 'h1',
        ledgerId: 'l1',
        environmentIncarnation: 'boot1',
        sealedSequence: 1,
        sealedEventHash: 'c'.repeat(64),
        blobs: [],
      },
      artifactManifestHash: nativeArtifactManifestHash(artifacts),
      artifactCount: artifacts.length,
      messages:
        projections ??
        rows.map((row, index) => ({
          uuid: row.uuid,
          target: { kind: 'main' as const },
          projectionHash: nativeTranscriptMessageHash(row),
          parentUuid: index ? rows[index - 1]!.uuid : uuid(1),
          timestamp: row.timestamp,
        })),
    }
    const preparation: NativeDeliveryPreparation = {
      ...base,
      preparationHash: nativeDeliveryPreparationHash(payloadHash, base),
    }
    const sources = new Map(rows.map((row) => [row.uuid, structuredClone(row)]))
    let committed: NativeDeliveryCommit | undefined
    const options: {
      -readonly [K in keyof storage.NativeTranscriptDelivery]: storage.NativeTranscriptDelivery[K]
    } = {
      nativeSessionId: sid,
      operationId: 'delivery-op',
      payloadHash,
      preparation,
      nativeWriterLockPath: process.env.NATIVE_ARTIFACT_TEST_LOCK_PATH!,
      artifacts,
      resolveMessage: async (projection) => structuredClone(sources.get(projection.uuid)),
      openArtifactSource: async function* () {
        yield Buffer.alloc(0)
        throw Error('unexpected artifact fetch')
      },
      commitProof: async (proof) => {
        if (committed) return committed
        const base = {
          version: 1 as const,
          preparationHash: preparation.preparationHash,
          receiptHash: preparation.receiptHash,
          proof,
          ack: {
            kind: 'native.delivery.ack' as const,
            receiptHash: preparation.receiptHash,
            nativeHeadRevision: proof.main.headUuid,
            nativeHeadHash: proof.main.prefixHash,
            artifactManifestHash: proof.artifactManifestHash,
          },
          committedAtMs: 1000,
        }
        committed = { ...base, commitHash: nativeDeliveryCommitHash(payloadHash, base) }
        return committed
      },
    }
    return { options, sources }
  }
  let crashBundleDirectory: string | undefined
  let crashBundle: Promise<string> | undefined
  async function compiledCrashFixture(): Promise<string> {
    crashBundle ??= (async () => {
      const parent = fileURLToPath(new URL('../../../.task-cache/', import.meta.url))
      await mkdir(parent, { recursive: true, mode: 0o700 })
      crashBundleDirectory = await mkdtemp(join(parent, 'native-writer-crash-'))
      const output = join(crashBundleDirectory, 'writer.js')
      const source = fileURLToPath(
        new URL('./fixtures/nativeDeliveryCrashChild.ts', import.meta.url),
      )
      const built = spawnSync(
        process.execPath,
        [
          'build',
          source,
          '--target=bun',
          '--minify',
          '--external',
          '@openclaude/*',
          '--external',
          'better-sqlite3',
          '--external',
          'node-pty',
          '--external',
          'sharp',
          '--external',
          'keytar',
          '--outfile',
          output,
        ],
        { encoding: 'utf8', timeout: 15000 },
      )
      expect({ code: built.status, error: built.status ? built.stderr : '' }).toEqual({
        code: 0,
        error: '',
      })
      return output
    })()
    return crashBundle
  }
  afterAll(async () => {
    if (crashBundleDirectory) await rm(crashBundleDirectory, { recursive: true, force: true })
  })
  for (const point of ['partial', 'before-commit', 'after-commit']) {
    test(`SIGKILL actual Writer at ${point}; fresh process reuses stable records and durable control ACK`, async () => {
      const directory = await mkdtemp(join(tmpdir(), 'agentremote-writer-crash-'))
      const nativeId = '00000000-0000-4000-8000-000000000006'
      const lock = join(directory, `${nativeId}.lock`)
      const control = fileURLToPath(
        new URL(
          '../../../../packages/gateway/src/agentRemote/fixtures/nativeDeliveryCrashControl.ts',
          import.meta.url,
        ),
      )
      const childFixture = await compiledCrashFixture()
      const controlCall = (mode: string) => {
        const result = spawnSync('node', ['--import', 'tsx', control, mode, directory], {
          encoding: 'utf8',
          timeout: 15000,
        })
        expect({ code: result.status, error: result.status ? result.stderr : '' }).toEqual({
          code: 0,
          error: '',
        })
        return JSON.parse(result.stdout)
      }
      let child: ReturnType<typeof spawn> | undefined
      let closed: ReturnType<typeof once> | undefined
      const launch = (mode: string) =>
        spawn(
          '/usr/bin/flock',
          ['--no-fork', lock, process.execPath, childFixture, directory, point, mode, control],
          {
            env: {
              ...process.env,
              HOME: join(directory, 'home'),
              CLAUDE_CONFIG_DIR: directory,
              OPENCLAUDE_HOME: join(directory, 'openclaude'),
              NATIVE_ARTIFACT_TEST_LOCK_PATH: lock,
            },
            cwd: directory,
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        )
      const stop = () => {
        try {
          if (child?.pid) process.kill(-child.pid, 'SIGKILL')
        } catch {
          child?.kill('SIGKILL')
        }
      }
      try {
        controlCall('init')
        child = launch('crash')
        closed = once(child, 'close')
        let output = ''
        let errorOutput = ''
        child.stderr!.on('data', (bytes) => {
          errorOutput = (errorOutput + bytes.toString()).slice(-8192)
        })
        await new Promise<void>((resolve, reject) => {
          const deadline = setTimeout(async () => {
            const stage = await readFile(join(directory, 'stage'), 'utf8').catch(
              () => 'not-started',
            )
            reject(Error(`barrier timeout at ${stage}: ${errorOutput}`))
          }, 20000)
          child!.stdout!.on('data', (bytes) => {
            output += bytes.toString()
            if (output.includes('BARRIER\n')) {
              clearTimeout(deadline)
              resolve()
            }
          })
          closed!.then(([code, signal]) => {
            clearTimeout(deadline)
            reject(Error(`early exit ${code}/${signal}: ${errorOutput}`))
          }, reject)
        })
        const file = join(directory, 'projects', 'fixture', `${nativeId}.jsonl`)
        expect(spawnSync('/usr/bin/flock', ['-n', lock, '/usr/bin/true']).status).toBe(1)
        if (point !== 'partial')
          expect(spawnSync('/usr/bin/flock', ['-n', file, '/usr/bin/true']).status).toBe(1)
        const before = controlCall('query')
        expect(Boolean(before.deliveryCommit)).toBe(point === 'after-commit')
        stop()
        const [code, signal] = await closed
        expect({ code, signal }).toEqual({ code: null, signal: 'SIGKILL' })
        expect(spawnSync('/usr/bin/flock', ['-n', lock, '/usr/bin/true']).status).toBe(0)
        expect(spawnSync('/usr/bin/flock', ['-n', file, '/usr/bin/true']).status).toBe(0)
        child = launch('recover')
        closed = once(child, 'close')
        child.stderr!.on('data', (bytes) => {
          errorOutput = (errorOutput + bytes.toString()).slice(-8192)
        })
        const recoveryDeadline = setTimeout(stop, 20000)
        const [recoveryCode, recoverySignal] = await closed.finally(() =>
          clearTimeout(recoveryDeadline),
        )
        expect({
          code: recoveryCode,
          signal: recoverySignal,
          error:
            recoveryCode !== 0
              ? `${await readFile(join(directory, 'stage'), 'utf8').catch(() => 'no-stage')}: ${errorOutput}`
              : '',
        }).toEqual({ code: 0, signal: null, error: '' })
        const recovered = JSON.parse(
          await readFile(join(directory, 'recovered-commit.json'), 'utf8'),
        )
        const after = controlCall('query')
        expect(after.state).toBe('completed')
        expect(recovered).toEqual(after.deliveryCommit)
        if (point === 'after-commit') expect(recovered).toEqual(before.deliveryCommit)
        const rows = (await readFile(file, 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
        const pinned = JSON.parse(await readFile(join(directory, 'delivery.json'), 'utf8'))
        for (const message of pinned.messages)
          expect(rows.filter((row) => row.uuid === message.uuid)).toHaveLength(1)
        expect(rows.filter((row) => typeof row.uuid === 'string').map((row) => row.uuid)).toEqual(
          [...pinned.initial, ...pinned.messages].map((row) => row.uuid),
        )
        const resolved = (await readFile(join(directory, 'resolved.jsonl'), 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
        expect(resolved.filter((row) => row.mode === 'recover').map((row) => row.uuid)).toEqual(
          point === 'partial'
            ? pinned.messages.slice(1).map((row: { uuid: string }) => row.uuid)
            : [],
        )
      } finally {
        if (child && child.exitCode === null && child.signalCode === null) {
          stop()
          await closed?.catch(() => {})
        }
        await rm(directory, { recursive: true, force: true })
      }
    }, 60000)
  }
  test('actual Writer appends only the missing stable UUID and returns the original ACK on replay', async () => {
    await fixture(async (_directory, file) => {
      await start()
      const result = { ...message(2), sourceToolAssistantUUID: uuid(1) }
      const { options } = prepare([result])
      const first = await storage.deliverNativeTranscript(options)
      options.resolveMessage = async () => {
        throw Error('replay must not rerun a source')
      }
      const second = await storage.deliverNativeTranscript(options)
      expect(second).toEqual(first)
      const rows = (await readFile(file, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      expect(rows.filter((row) => row.uuid === uuid(2))).toHaveLength(1)
      expect(rows.find((row) => row.uuid === uuid(2)).parentUuid).toBe(uuid(1))
    })
  })
  test('missing main source assistant rejects before append or commit', async () => {
    await fixture(async (_directory, file) => {
      await start()
      const before = await readFile(file, 'utf8')
      const result = { ...message(2), sourceToolAssistantUUID: uuid(99) }
      const { options } = prepare(
        [result],
        [
          {
            uuid: uuid(2),
            target: { kind: 'main' },
            projectionHash: nativeTranscriptMessageHash(result),
            parentUuid: uuid(99),
            timestamp,
          },
        ],
      )
      options.commitProof = async () => {
        throw Error('must not commit')
      }
      await expect(storage.deliverNativeTranscript(options)).rejects.toMatchObject({
        code: 'native-writer-parent-missing',
      })
      expect(await readFile(file, 'utf8')).toBe(before)
    })
  })
  test('control ACK loss preserves real JSONL and permits same-process delivery retry without new messages', async () => {
    await fixture(async (_directory, file) => {
      await start()
      const { options } = prepare([message(2)])
      const original = options.commitProof
      options.commitProof = async () => {
        throw Error('synthetic control disconnect')
      }
      await expect(storage.deliverNativeTranscript(options)).rejects.toThrow(
        'synthetic control disconnect',
      )
      await storage.flushSessionStorage()
      options.commitProof = original
      options.resolveMessage = async () => {
        throw Error('already recorded source')
      }
      const commit = await storage.deliverNativeTranscript(options)
      expect(commit.ack.nativeHeadRevision).toBe(uuid(2))
      expect((await readFile(file, 'utf8')).split(uuid(2))).toHaveLength(2)
    })
  })
  test('sidechain proof uses its fixed timestamps and the actual distinct main head', async () => {
    await fixture(async (_directory, file) => {
      await start()
      const agentId = 'a0123456789abcdef'
      const target: NativeTranscriptTarget = { kind: 'sidechain', agentId }
      const rows = [message(2, 'assistant'), { ...message(3), sourceToolAssistantUUID: uuid(2) }]
      const { options } = prepare(
        rows,
        rows.map((row, index) => ({
          uuid: row.uuid,
          target,
          projectionHash: nativeTranscriptMessageHash(row),
          parentUuid: index ? uuid(2) : null,
          timestamp,
        })),
      )
      const commit = await storage.deliverNativeTranscript(options)
      expect(commit.ack.nativeHeadRevision).toBe(uuid(1))
      const side = (await readFile(storage.getAgentTranscriptPath(agentId as any), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      expect(side.map((row) => row.timestamp)).toEqual([timestamp, timestamp])
      expect(side[1].parentUuid).toBe(uuid(2))
      expect(
        (await readFile(file, 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
          .some((row) => row.uuid === uuid(3)),
      ).toBe(false)
    })
  })
  test('large artifact is durable under actual proof lock; an unACKed existing record repairs bytes without another message', async () => {
    await fixture(async (_directory, file, session) => {
      await start()
      const bytes = Buffer.alloc(9 * 1024 * 1024, 37)
      const artifact = {
        nativeSessionId: sid,
        relativePath: 'tool-results/call_delivery.txt',
        sizeBytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      }
      const { options } = prepare([message(2, 'user', artifact.relativePath)], undefined, [
        artifact,
      ])
      let fetched = 0
      options.openArtifactSource = async function* () {
        fetched++
        for (let offset = 0; offset < bytes.length; offset += 131072)
          yield bytes.subarray(offset, offset + 131072)
      }
      const original = options.commitProof
      options.commitProof = async () => {
        throw Error('synthetic lost commit')
      }
      await expect(storage.deliverNativeTranscript(options)).rejects.toThrow(
        'synthetic lost commit',
      )
      const target = join(session, artifact.relativePath)
      expect((await readFile(target)).equals(bytes)).toBe(true)
      await unlink(target)
      options.resolveMessage = async () => {
        throw Error('must reuse stable native UUID')
      }
      options.commitProof = async (proof) => {
        expect(spawnSync('/usr/bin/flock', ['-n', file, '/usr/bin/true']).status).toBe(1)
        expect((await readFile(target)).equals(bytes)).toBe(true)
        return original(proof)
      }
      const commit = await storage.deliverNativeTranscript(options)
      expect(commit.ack.nativeHeadRevision).toBe(uuid(2))
      expect(fetched).toBe(2)
      const rows = (await readFile(file, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      expect(rows.filter((row) => row.uuid === uuid(2))).toHaveLength(1)
    })
  })
  test('a filtered result can commit zero transcript projections against the actual main head', async () => {
    await fixture(async (_directory, file) => {
      await start()
      const before = await readFile(file, 'utf8')
      const { options } = prepare([])
      options.resolveMessage = async () => {
        throw Error('no native projection')
      }
      const commit = await storage.deliverNativeTranscript(options)
      expect(commit.proof.files).toEqual([])
      expect(commit.ack.nativeHeadRevision).toBe(uuid(1))
      expect(await readFile(file, 'utf8')).toBe(before)
    })
  })
  test('compact logical parent and source assistant override use the original Writer semantics', async () => {
    await fixture(async (_directory, file) => {
      await start()
      const compact = {
        type: 'system',
        subtype: 'compact_boundary',
        uuid: uuid(2),
        timestamp,
        content: '',
        compactMetadata: { trigger: 'manual', preTokens: 10 },
      }
      const summary = message(3)
      const rows = [compact, summary]
      const projections: NativeMessageProjection[] = [
        {
          uuid: uuid(2),
          target: { kind: 'main' },
          projectionHash: nativeTranscriptMessageHash(compact),
          parentUuid: null,
          logicalParentUuid: uuid(1),
          timestamp,
        },
        {
          uuid: uuid(3),
          target: { kind: 'main' },
          projectionHash: nativeTranscriptMessageHash(summary),
          parentUuid: uuid(2),
          timestamp,
        },
      ]
      await storage.deliverNativeTranscript(prepare(rows, projections).options)
      const result = { ...message(4), sourceToolAssistantUUID: uuid(1) }
      const prepared = prepare(
        [result],
        [
          {
            uuid: uuid(4),
            target: { kind: 'main' },
            projectionHash: nativeTranscriptMessageHash(result),
            parentUuid: uuid(1),
            timestamp,
          },
        ],
      )
      await storage.deliverNativeTranscript(prepared.options)
      const saved = (await readFile(file, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      expect(saved.find((row) => row.uuid === uuid(2)).logicalParentUuid).toBe(uuid(1))
      expect(saved.find((row) => row.uuid === uuid(4)).parentUuid).toBe(uuid(1))
    })
  })
  test('source await cannot move a prepared native write into another ambient project', async () => {
    await fixture(async (directory, file) => {
      await start()
      const before = await readFile(file, 'utf8')
      const { options, sources } = prepare([message(2)])
      const other = join(directory, 'projects', 'other')
      await mkdir(other, { mode: 0o700 })
      options.resolveMessage = async (projection) => {
        switchSession(sid as any, other)
        return sources.get(projection.uuid)
      }
      try {
        await expect(storage.deliverNativeTranscript(options)).rejects.toMatchObject({
          code: 'native-writer-session-changed',
        })
      } finally {
        switchSession(sid as any, dirname(file))
      }
      expect(await readFile(file, 'utf8')).toBe(before)
    })
  })
  test('fresh Project adopts the existing real main before writing a sidechain attachment', async () => {
    await fixture(async (_directory, file) => {
      await start()
      storage.resetProjectForTesting()
      const attachment = {
        type: 'attachment',
        uuid: uuid(2),
        timestamp,
        attachment: {
          type: 'hook_additional_context',
          content: 'frozen hook',
          hookName: 'PostToolUse',
          hookEvent: 'PostToolUse',
        },
      }
      const target: NativeTranscriptTarget = { kind: 'sidechain', agentId: 'a0123456789abcdef' }
      const prepared = prepare(
        [attachment],
        [
          {
            uuid: uuid(2),
            target,
            projectionHash: nativeTranscriptMessageHash(attachment),
            parentUuid: null,
            timestamp,
          },
        ],
      )
      const commit = await storage.deliverNativeTranscript(prepared.options)
      expect(commit.ack.nativeHeadRevision).toBe(uuid(1))
      expect(
        (await readFile(file, 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
          .some((row) => row.uuid === uuid(2)),
      ).toBe(false)
    })
  })
  test('partial multi-message delivery reuses its verified prefix and appends only the missing suffix', async () => {
    await fixture(async (_directory, file) => {
      await start()
      const { options, sources } = prepare([message(2), message(3, 'assistant'), message(4)])
      const resolved: string[] = []
      options.resolveMessage = async (projection) => {
        resolved.push(projection.uuid)
        if (projection.uuid === uuid(3)) throw Error('synthetic pinned source unavailable')
        return sources.get(projection.uuid)
      }
      await expect(storage.deliverNativeTranscript(options)).rejects.toThrow(
        'synthetic pinned source unavailable',
      )
      options.resolveMessage = async (projection) => {
        if (projection.uuid === uuid(2)) throw Error('prefix re-fetch')
        return sources.get(projection.uuid)
      }
      const commit = await storage.deliverNativeTranscript(options)
      expect(commit.ack.nativeHeadRevision).toBe(uuid(4))
      const rows = (await readFile(file, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      for (const n of [2, 3, 4]) expect(rows.filter((row) => row.uuid === uuid(n))).toHaveLength(1)
      expect(resolved).toEqual([uuid(2), uuid(3)])
    })
  })
  test('changed pinned content or timestamp cannot enter the actual Writer', async () => {
    await fixture(async (_directory, file) => {
      await start()
      const before = await readFile(file, 'utf8')
      for (const changed of [
        message(2, 'user', 'tampered content'),
        { ...message(2), timestamp: '2026-11-02T00:00:00.000Z' },
      ]) {
        const { options } = prepare([message(2)])
        options.resolveMessage = async () => changed
        await expect(storage.deliverNativeTranscript(options)).rejects.toMatchObject({
          code: 'native-writer-message',
        })
      }
      expect(await readFile(file, 'utf8')).toBe(before)
    })
  })
  test('sidechain-only delivery cannot invent a missing actual main head', async () => {
    await fixture(async (_directory, file) => {
      const source = message(2, 'assistant')
      const target: NativeTranscriptTarget = { kind: 'sidechain', agentId: 'a0123456789abcdef' }
      const { options } = prepare(
        [source],
        [
          {
            uuid: source.uuid,
            target,
            projectionHash: nativeTranscriptMessageHash(source),
            parentUuid: null,
            timestamp,
          },
        ],
      )
      await expect(storage.deliverNativeTranscript(options)).rejects.toMatchObject({
        code: 'native-writer-main-head',
      })
      expect(await readFile(file, 'utf8')).toBe('')
    })
  })
  test('binding change during artifact download is checked before its real JSONL patch', async () => {
    await fixture(async (directory, file) => {
      await start()
      const before = await readFile(file, 'utf8')
      const other = join(directory, 'projects', 'other')
      await mkdir(other, { mode: 0o700 })
      const bytes = Buffer.from('frozen pinned output')
      const artifact = {
        nativeSessionId: sid,
        relativePath: 'tool-results/call_fence.txt',
        sizeBytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      }
      const { options } = prepare([message(2)], undefined, [artifact])
      options.openArtifactSource = async function* () {
        yield bytes
        switchSession(sid as any, other)
      }
      try {
        await expect(storage.deliverNativeTranscript(options)).rejects.toMatchObject({
          code: 'native-writer-session-changed',
        })
      } finally {
        switchSession(sid as any, dirname(file))
      }
      expect(await readFile(file, 'utf8')).toBe(before)
    })
  })
  test('final Writer envelope cannot append an over-limit line even when its source JSON fits', async () => {
    await fixture(async (_directory, file) => {
      await start()
      const before = await readFile(file, 'utf8')
      const limit = 64 * 1024 * 1024
      const empty = message(2, 'user', '')
      const source = message(
        2,
        'user',
        'x'.repeat(limit - Buffer.byteLength(JSON.stringify(empty))),
      )
      expect(Buffer.byteLength(JSON.stringify(source))).toBe(limit)
      await expect(
        storage.recordTranscript([source] as any, undefined, undefined, undefined, true),
      ).rejects.toMatchObject({ code: 'native-line-bound' })
      expect(await readFile(file, 'utf8')).toBe(before)
    })
  }, 60000)
}
