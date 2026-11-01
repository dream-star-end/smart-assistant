import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { constants } from 'node:fs'
import fs from 'node:fs/promises'
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test, { afterEach, beforeEach, mock } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { NativeArtifact } from '@openclaude/protocol/agentRemoteNative'
import {
  nativeSessionPathAllowed,
  nativeToolArtifactPathAllowed,
} from '@openclaude/protocol/agentRemoteState'
import {
  type NativeArtifactInstall,
  installNativeArtifacts,
  nativeArtifactManifestHash,
} from '../nativeArtifactInstaller.js'
import {
  type SessionFileLeaseCapability,
  assertSessionFileLease,
  withSessionFile,
} from '../sessionFileIo.js'

const sid = '00000000-0000-4000-8000-000000000003'
// Ordinary CI discovery must exercise the same real flock owner as the direct
// development runner. Node --test forks files, so re-exec this suite under flock.
if (!process.env.NATIVE_ARTIFACT_TEST_LOCK_PATH) {
  test(
    'native artifact Writer integration runs in a process that owns the session lock',
    { timeout: 180000 },
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'agentremote-artifact-runner-'))
      const lock = join(directory, `${sid}.lock`)
      const { NODE_TEST_CONTEXT: _inheritedTestContext, ...nativeTestEnvironment } = process.env
      const child = spawn(
        '/usr/bin/flock',
        ['--no-fork', lock, process.execPath, '--import', 'tsx', fileURLToPath(import.meta.url)],
        {
          env: {
            ...nativeTestEnvironment,
            TMPDIR: directory,
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
        assert.equal(code, 0, output)
        assert.match(output, /# fail 0/)
      } finally {
        clearTimeout(deadline)
        if (child.exitCode === null && child.signalCode === null) {
          stop()
          await closed.catch(() => {})
        }
        await rm(directory, { recursive: true, force: true })
      }
    },
  )
} else {
  const lockPath = process.env.NATIVE_ARTIFACT_TEST_LOCK_PATH!
  const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
  let root: string
  let projects: string
  let session: string
  let transcript: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agentremote-native-artifact-'))
    projects = join(root, 'projects')
    session = join(projects, 'project', sid)
    transcript = join(projects, 'project', `${sid}.jsonl`)
    await mkdir(projects, { mode: 0o700 })
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })
  function descriptor(path: string, bytes: Uint8Array | string): NativeArtifact {
    return {
      nativeSessionId: sid,
      relativePath: path,
      sizeBytes: Buffer.byteLength(bytes),
      sha256: digest(bytes),
    }
  }
  function options(
    artifact: NativeArtifact,
    bytes: Uint8Array | string,
    overrides: Partial<NativeArtifactInstall> = {},
  ): NativeArtifactInstall {
    return {
      sessionDirectory: session,
      nativeSessionId: sid,
      nativeWriterLockPath: lockPath,
      operationId: 'op-1',
      artifacts: [artifact],
      openSource: async function* () {
        yield Buffer.from(bytes)
      },
      ...overrides,
    }
  }
  async function append(
    config: NativeArtifactInstall,
    content = 'committed-reference\n',
  ): Promise<void> {
    await withSessionFile(
      transcript,
      { projectsDir: projects, sessionId: sid },
      true,
      async (file, patch) => {
        await patch((await file.stat()).size, Buffer.from(content), async (capability) => {
          await installNativeArtifacts(capability, config)
        })
      },
    )
  }

  test('actual producer layouts and checkpoint directories are supported without vendor ID prefixes', () => {
    const names = [
      'tool-results/call_a.txt',
      'tool-results/custom:7.json',
      `tool-results/${'a'.repeat(251)}.txt`,
      'tool-results/mcp-a-b-1730000000000.txt',
      'tool-results/mcp-very-long-name-blob-1-.bin',
      'tool-results/mcp-resource-1-23-abc123.docx',
      'tool-results/webfetch-1-abc123.mp4',
      `tool-results/pdf-${sid}/page-000123.jpg`,
    ]
    for (const path of names) {
      assert.equal(nativeToolArtifactPathAllowed(path), true, path)
      assert.equal(nativeSessionPathAllowed(`projects/project/${sid}/${path}`, sid), true, path)
    }
    assert.equal(
      nativeSessionPathAllowed(`projects/project/${sid}/tool-results/pdf-${sid}`, sid, 'directory'),
      true,
    )
    for (const path of [
      'projects/a',
      'subagents/agent-a0123456789abcdef.jsonl',
      'remote-agents/remote-agent-1.meta.json',
      'session-memory/summary.md',
      '/tool-results/x.txt',
      'tool-results/.x.txt',
      'tool-results/../x.txt',
      'tool-results/a/b.txt',
      'tool-results/a\\b.txt',
      'tool-results/a\0b.txt',
      'tool-results/raw.exe',
      `tool-results/${'a'.repeat(252)}.txt`,
      'tool-results//x.txt',
    ])
      assert.equal(nativeToolArtifactPathAllowed(path), false, path)
  })
  test('streamed binary larger than a wire frame and PDF outputs precede the durable JSONL reference', async () => {
    const count = 9 * 1024 * 1024
    const block = Buffer.alloc(65536, 71)
    const hash = createHash('sha256')
    for (let i = 0; i < count / block.length; i++) hash.update(block)
    const artifact: NativeArtifact = {
      nativeSessionId: sid,
      relativePath: 'tool-results/webfetch-1-abc123.bin',
      sizeBytes: count,
      sha256: hash.digest('hex'),
    }
    let chunks = 0
    await append(
      options(artifact, '', {
        openSource: async function* () {
          for (let i = 0; i < count / block.length; i++) {
            chunks++
            yield block
          }
        },
      }),
    )
    assert.equal(chunks, 144)
    assert.equal((await lstat(join(session, artifact.relativePath))).size, count)
    assert.equal(await readFile(transcript, 'utf8'), 'committed-reference\n')
    const pdf = descriptor(`tool-results/pdf-${sid}/page-001.jpg`, 'fake-jpeg')
    await append(options(pdf, 'fake-jpeg'), 'pdf-reference\n')
    assert.equal(await readFile(join(session, pdf.relativePath), 'utf8'), 'fake-jpeg')
  })
  test('same-content retry reuses the installed file without fetching or overwriting it', async () => {
    const artifact = descriptor('tool-results/call_1.txt', 'original')
    await append(options(artifact, 'original'))
    const before = await lstat(join(session, artifact.relativePath))
    await append(
      options(artifact, '', {
        openSource: async function* () {
          yield await Promise.reject(new Error('must not fetch committed bytes'))
        },
      }),
      'second-ref\n',
    )
    assert.equal((await lstat(join(session, artifact.relativePath))).ino, before.ino)
    assert.equal(
      nativeArtifactManifestHash([artifact]),
      nativeArtifactManifestHash([{ ...artifact }]),
    )
  })
  test('wrong hash, short/excess bytes, source interruption and duplicate paths never append a reference', async (t) => {
    for (const mode of ['hash', 'short', 'excess', 'interrupt', 'duplicate'])
      await t.test(mode, async () => {
        const artifact = descriptor(`tool-results/${mode}.txt`, 'expected')
        let config = options(
          artifact,
          mode === 'short' ? 'x' : mode === 'excess' ? 'too-long-output' : 'different',
        )
        if (mode === 'interrupt')
          config = {
            ...config,
            openSource: async function* () {
              yield Buffer.from('ex')
              throw new Error('synthetic-source-disconnect')
            },
          }
        if (mode === 'duplicate') config = { ...config, artifacts: [artifact, { ...artifact }] }
        await assert.rejects(append(config))
        assert.equal(await readFile(transcript, 'utf8'), '')
        await assert.rejects(lstat(join(session, artifact.relativePath)), { code: 'ENOENT' })
      })
  })
  test('conflicting existing output is retained and neither overwritten nor referenced', async () => {
    const artifact = descriptor('tool-results/call_2.txt', 'first')
    await append(options(artifact, 'first'))
    await assert.rejects(
      append(options(descriptor(artifact.relativePath, 'other'), 'other')),
      /native-artifact-conflict/,
    )
    assert.equal(await readFile(join(session, artifact.relativePath), 'utf8'), 'first')
    assert.equal(await readFile(transcript, 'utf8'), 'committed-reference\n')
  })
  test('forged/ended capabilities, wrong UUID lock, cross-session and transcript scope are rejected', async () => {
    const artifact = descriptor('tool-results/call_3.txt', 'bytes')
    await assert.rejects(
      installNativeArtifacts({} as SessionFileLeaseCapability, options(artifact, 'bytes')),
      { code: 'CCB_TRANSCRIPT_LEASE_INVALID' },
    )
    let saved!: SessionFileLeaseCapability
    await withSessionFile(
      transcript,
      { projectsDir: projects, sessionId: sid },
      true,
      async (_file, patch) => {
        await patch(0, Buffer.alloc(0), async (cap) => {
          saved = cap
        })
      },
    )
    assert.throws(() => assertSessionFileLease(saved), { code: 'CCB_TRANSCRIPT_LEASE_INVALID' })
    const notHeld = join(root, `${sid}.lock`)
    await writeFile(notHeld, '', { mode: 0o600 })
    await assert.rejects(
      append(options(artifact, 'bytes', { nativeWriterLockPath: notHeld })),
      /native-lock-not-held/,
    )
    await assert.rejects(
      append(
        options({ ...artifact, nativeSessionId: '00000000-0000-4000-8000-000000000004' }, 'bytes'),
      ),
      /native-artifact-path/,
    )
    const other = join(dirname(transcript), 'other.jsonl')
    await assert.rejects(
      withSessionFile(
        other,
        { projectsDir: projects, sessionId: sid, artifactId: 'other' },
        true,
        async (_file, patch) => {
          await patch(0, Buffer.from('bad'), async (cap) => {
            await installNativeArtifacts(cap, options(artifact, 'bytes'))
          })
        },
      ),
      /native-artifact-transcript-scope/,
    )
  })
  test('symlink directories/files and foreign hardlinks cannot become native output', async () => {
    await mkdir(session, { recursive: true, mode: 0o700 })
    const outside = join(root, 'outside')
    await mkdir(outside, { mode: 0o700 })
    await symlink(outside, join(session, 'tool-results'))
    const artifact = descriptor('tool-results/call_4.txt', 'bytes')
    await assert.rejects(append(options(artifact, 'bytes')), /native-artifact-directory/)
    await rm(join(session, 'tool-results'))
    await mkdir(join(session, 'tool-results'), { mode: 0o700 })
    const external = join(outside, 'file')
    await writeFile(external, 'bytes', { mode: 0o600 })
    await symlink(external, join(session, artifact.relativePath))
    await assert.rejects(append(options(artifact, 'bytes')))
    await rm(join(session, artifact.relativePath))
    await link(external, join(session, artifact.relativePath))
    await assert.rejects(append(options(artifact, 'bytes')), /native-artifact-file/)
    assert.equal(await readFile(transcript, 'utf8'), '')
  })
  test('recovers the exact hardlink stage/target crash layout and rejects unrelated extra links', async () => {
    const artifact = descriptor('tool-results/call_crash.txt', 'bytes')
    await withSessionFile(
      transcript,
      { projectsDir: projects, sessionId: sid },
      true,
      async (_file, patch) => {
        await patch(0, Buffer.alloc(0), async (capability) => {
          const identity = assertSessionFileLease(capability)
          await mkdir(identity.stagingDirectory, { mode: 0o700 })
          await mkdir(join(session, 'tool-results'), { recursive: true, mode: 0o700 })
          const stage = join(
            identity.stagingDirectory,
            `${digest(`op-1\n${artifact.relativePath}`)}.stage`,
          )
          const file = await open(stage, 'wx', 0o600)
          await file.writeFile('bytes')
          await file.sync()
          await file.close()
          await link(stage, join(session, artifact.relativePath))
          assert.equal((await lstat(stage)).nlink, 2)
          const result = await installNativeArtifacts(
            capability,
            options(artifact, '', {
              openSource: async function* () {
                yield await Promise.reject(new Error('should recover installed bytes'))
              },
            }),
          )
          assert.equal(result.artifactManifestHash, nativeArtifactManifestHash([artifact]))
          assert.deepEqual(await readdir(identity.stagingDirectory), [])
          assert.equal((await lstat(join(session, artifact.relativePath))).nlink, 1)
        })
      },
    )
  })
  test('a callback that omits await still cannot release the lease before installation and JSONL sync', async () => {
    const artifact = descriptor('tool-results/call_pending.txt', 'bytes')
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const ready = new Promise<void>((r) => {
      entered = r
    })
    let complete = false
    const writing = withSessionFile(
      transcript,
      { projectsDir: projects, sessionId: sid },
      true,
      async (_file, patch) => {
        void patch(0, Buffer.from('reference\n'), async (cap) => {
          entered()
          await gate
          await installNativeArtifacts(cap, options(artifact, 'bytes'))
        })
      },
    ).then(() => {
      complete = true
    })
    await ready
    assert.equal(complete, false)
    assert.equal(await readFile(transcript, 'utf8'), '')
    release()
    await writing
    assert.equal(await readFile(transcript, 'utf8'), 'reference\n')
  })

  test('synchronous dependency reentry cannot start a second mutation', async () => {
    await assert.rejects(
      withSessionFile(
        transcript,
        { projectsDir: projects, sessionId: sid },
        true,
        async (_file, patch) => {
          await patch(0, Buffer.from('outer\n'), async () => {
            void patch(0, Buffer.from('inner\n'))
          })
        },
      ),
      { code: 'CCB_TRANSCRIPT_CONCURRENT_MUTATION' },
    )
    assert.equal(await readFile(transcript, 'utf8'), '')
  })

  test('trusted canonical target accepts an actual cwd hardlink alias, never a copied transcript', async () => {
    const artifact = descriptor('tool-results/call_alias.txt', 'bytes')
    await append(options(artifact, 'bytes'))
    const alias = join(projects, 'newcwd', `${sid}.jsonl`)
    await mkdir(dirname(alias), { mode: 0o700 })
    await link(transcript, alias)
    await withSessionFile(
      alias,
      { projectsDir: projects, sessionId: sid },
      false,
      async (file, patch) => {
        await patch((await file.stat()).size, Buffer.from('alias-ref\n'), async (cap) => {
          await installNativeArtifacts(cap, options(artifact, ''))
        })
      },
    )
    assert.equal(await readFile(transcript, 'utf8'), 'committed-reference\nalias-ref\n')
    await rm(alias)
    await writeFile(alias, await readFile(transcript), { mode: 0o600 })
    await assert.rejects(
      withSessionFile(
        alias,
        { projectsDir: projects, sessionId: sid },
        false,
        async (_file, patch) => {
          await patch(0, Buffer.from('bad'), async (cap) => {
            await installNativeArtifacts(cap, options(artifact, 'bytes'))
          })
        },
      ),
      { code: 'CCB_TRANSCRIPT_ALIAS_DIVERGED' },
    )
  })

  test('real Writer SIGKILL after link or completed install recovers in a fresh process without refetching', async (t) => {
    for (const mode of ['link', 'installed'])
      await t.test(mode, async () => {
        const childRoot = join(root, mode)
        await mkdir(childRoot, { mode: 0o700 })
        const childSid = '00000000-0000-4000-8000-000000000005'
        const fixture = fileURLToPath(
          new URL('./fixtures/nativeArtifactWriter.ts', import.meta.url),
        )
        const launch = (phase: string) =>
          spawn(
            '/usr/bin/flock',
            [
              '--no-fork',
              join(childRoot, `${childSid}.lock`),
              process.execPath,
              '--import',
              'tsx',
              fixture,
              childRoot,
              phase,
            ],
            { stdio: ['ignore', 'pipe', 'pipe'] },
          )
        const child = launch(mode)
        const closed = once(child, 'close')
        let output = ''
        let errors = ''
        child.stderr.on('data', (chunk) => {
          errors += chunk.toString()
        })
        try {
          await new Promise<void>((accept, reject) => {
            const timer = setTimeout(
              () => reject(new Error(`writer barrier timeout: ${errors.slice(0, 1000)}`)),
              15000,
            )
            child.stdout.on('data', (chunk) => {
              output += chunk.toString()
              if (output.includes(mode === 'link' ? 'artifact-linked' : 'artifacts-installed')) {
                clearTimeout(timer)
                accept()
              }
            })
            child.once('error', (error) => {
              clearTimeout(timer)
              reject(error)
            })
            child.once('close', () => {
              clearTimeout(timer)
              reject(new Error(`writer exited before barrier: ${errors.slice(0, 1000)}`))
            })
          })
          child.kill('SIGKILL')
          const [, signal] = await closed
          assert.equal(signal, 'SIGKILL')
          const file = join(childRoot, 'projects', 'project', `${childSid}.jsonl`)
          const artifact = join(
            childRoot,
            'projects',
            'project',
            childSid,
            'tool-results',
            'call_crash.txt',
          )
          assert.equal(await readFile(file, 'utf8'), '')
          assert.equal((await lstat(artifact)).nlink, mode === 'link' ? 2 : 1)
          const recovery = launch('recover')
          let recovered = ''
          let failed = ''
          recovery.stdout.on('data', (chunk) => {
            recovered += chunk.toString()
          })
          recovery.stderr.on('data', (chunk) => {
            failed += chunk.toString()
          })
          const [code] = await once(recovery, 'close')
          assert.equal(code, 0, failed.slice(0, 1000))
          assert.match(recovered, /writer-committed/)
          assert.equal(await readFile(file, 'utf8'), 'one-reference\n')
          assert.equal(await readFile(artifact, 'utf8'), 'bytes')
          assert.equal((await lstat(artifact)).nlink, 1)
        } finally {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL')
            await closed
          }
        }
      })
  })
  test('existing PDF directory parent fsync failure prevents JSONL and a fresh lease retries every directory link', async () => {
    const artifact = descriptor(`tool-results/pdf-${sid}/page-003.jpg`, 'bytes')
    const pdf = join(session, `tool-results/pdf-${sid}`)
    const parent = dirname(pdf)
    await mkdir(pdf, { recursive: true, mode: 0o700 })
    const realOpen = fs.open
    let visitedPdf = false
    let failOnce = true
    let retryParents = 0
    mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
      const handle = await realOpen(...args)
      const path = String(args[0])
      if (typeof args[1] === 'number' && args[1] & constants.O_DIRECTORY) {
        const actualSync = handle.sync.bind(handle)
        mock.method(handle, 'sync', async () => {
          if (path === parent && visitedPdf) {
            if (failOnce) {
              failOnce = false
              throw Object.assign(new Error('synthetic-directory-fsync'), { code: 'EIO' })
            }
            retryParents++
          }
          await actualSync()
          if (path === pdf) visitedPdf = true
        })
      }
      return handle
    })
    syncBuiltinESMExports()
    try {
      await assert.rejects(append(options(artifact, 'bytes')), { code: 'EIO' })
      assert.equal(await readFile(transcript, 'utf8'), '')
      visitedPdf = false
      await append(options(artifact, 'bytes'))
      assert.ok(retryParents > 0)
      assert.equal(await readFile(transcript, 'utf8'), 'committed-reference\n')
    } finally {
      mock.restoreAll()
      syncBuiltinESMExports()
    }
  })
}
