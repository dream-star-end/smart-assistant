import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, test } from 'node:test'

import {
  COMPILED_KNOWLEDGE_PLANET_PLUGIN,
  KNOWLEDGE_PLANET_PLUGIN_CONTRACT,
  KNOWLEDGE_PLANET_WORKER_DIGEST,
} from './knowledgePlanet.js'
import {
  type KnowledgePlanetVerificationExpected,
  deleteKnowledgePlanetVerificationHandoff,
  readKnowledgePlanetVerificationHandoff,
  writeKnowledgePlanetVerificationHandoff,
} from './knowledgePlanetVerificationHandoff.js'

const roots: string[] = []
const env = { OPENCLAUDE_KMS_KEY: randomBytes(32).toString('base64') }
const now = Date.parse('2026-07-17T03:00:00.000Z')
const secret = 'kp-secret-cookie-that-must-not-appear-on-disk'
const state = {
  cookies: [
    {
      name: 'zsxq_access_token',
      value: secret,
      domain: '.api.zsxq.com',
      path: '/',
      expires: -1,
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    },
  ],
  origins: [],
}

const expected: KnowledgePlanetVerificationExpected = {
  artifactHash: COMPILED_KNOWLEDGE_PLANET_PLUGIN.artifactHash,
  execContractHash: COMPILED_KNOWLEDGE_PLANET_PLUGIN.execContractHash,
  workerDigest: KNOWLEDGE_PLANET_WORKER_DIGEST,
  imageId: `sha256:${'1'.repeat(64)}`,
  sourceCommit: '2'.repeat(40),
  actionIds: KNOWLEDGE_PLANET_PLUGIN_CONTRACT.actions.map((action) => action.id),
  contract: KNOWLEDGE_PLANET_PLUGIN_CONTRACT,
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'kp-handoff-'))
  roots.push(root)
  const path = join(root, 'private', 'handoff.json')
  return { path, expectedOwnerUid: process.getuid?.() ?? 0 }
}

async function writeValid(file: Awaited<ReturnType<typeof fixture>>) {
  return writeKnowledgePlanetVerificationHandoff({
    expected,
    userId: 1,
    verification: 'qr-login',
    replaceExistingAccount: false,
    expectedExistingAccountInstanceId: null,
    replacementAccountInstanceId: null,
    passedActionIds: expected.actionIds,
    storageState: state,
    env,
    now,
    file,
  })
}

describe('Knowledge Planet encrypted verification handoff', () => {
  test('round-trips canonical state without writing plaintext and deletes idempotently', async () => {
    const file = await fixture()
    const metadata = await writeValid(file)
    const raw = await readFile(file.path, 'utf8')
    assert.equal(raw.includes(secret), false)
    assert.equal((await lstat(file.path)).mode & 0o777, 0o600)
    assert.equal((await lstat(dirname(file.path))).mode & 0o777, 0o700)

    const opened = await readKnowledgePlanetVerificationHandoff({
      expected,
      env,
      now: now + 1,
      file,
    })
    assert.equal(opened.metadata.userId, 1)
    assert.equal(opened.metadata.expiresAt, metadata.expiresAt)
    assert.equal(opened.storageState.cookies[0]!.value, secret)

    const oldAccountInstanceId = '00000000-0000-4000-8000-000000000001'
    const replacementAccountInstanceId = '00000000-0000-4000-8000-000000000002'
    await writeKnowledgePlanetVerificationHandoff({
      expected,
      userId: 1,
      verification: 'qr-login',
      replaceExistingAccount: true,
      expectedExistingAccountInstanceId: oldAccountInstanceId,
      replacementAccountInstanceId,
      passedActionIds: expected.actionIds,
      storageState: state,
      env,
      now,
      file,
    })
    const replacement = await readKnowledgePlanetVerificationHandoff({
      expected,
      env,
      now: now + 1,
      file,
    })
    assert.equal(replacement.metadata.expectedExistingAccountInstanceId, oldAccountInstanceId)
    assert.equal(replacement.metadata.replacementAccountInstanceId, replacementAccountInstanceId)
    await assert.rejects(
      writeKnowledgePlanetVerificationHandoff({
        expected,
        userId: 1,
        verification: 'qr-login',
        replaceExistingAccount: true,
        expectedExistingAccountInstanceId: oldAccountInstanceId,
        replacementAccountInstanceId: oldAccountInstanceId,
        passedActionIds: expected.actionIds,
        storageState: state,
        env,
        now,
        file,
      }),
      /result is invalid/,
    )

    await deleteKnowledgePlanetVerificationHandoff(file)
    await deleteKnowledgePlanetVerificationHandoff(file)
    await assert.rejects(
      readKnowledgePlanetVerificationHandoff({ expected, env, now, file }),
      /valid Knowledge Planet verification handoff is required/,
    )
  })

  test('authenticates metadata/ciphertext and rejects another image, artifact, or source commit', async () => {
    const file = await fixture()
    await writeValid(file)
    const original = JSON.parse(await readFile(file.path, 'utf8')) as Record<string, unknown>

    for (const mutation of [
      { userId: 2 },
      { expectedExistingAccountInstanceId: '00000000-0000-4000-8000-000000000001' },
      { replacementAccountInstanceId: '00000000-0000-4000-8000-000000000002' },
      { passedActionIds: [...expected.actionIds].reverse() },
      { cleanupVerified: false },
      { ciphertext: `${String(original.ciphertext).slice(0, -4)}AAAA` },
    ]) {
      await writeFile(file.path, `${JSON.stringify({ ...original, ...mutation })}\n`, {
        mode: 0o600,
      })
      await assert.rejects(
        readKnowledgePlanetVerificationHandoff({ expected, env, now, file }),
        /does not match|authentication failed/,
      )
    }

    await writeFile(file.path, `${JSON.stringify(original)}\n`, { mode: 0o600 })
    for (const mismatch of [
      { imageId: `sha256:${'3'.repeat(64)}` },
      { artifactHash: '4'.repeat(64) },
      { sourceCommit: '5'.repeat(40) },
    ]) {
      await assert.rejects(
        readKnowledgePlanetVerificationHandoff({
          expected: { ...expected, ...mismatch },
          env,
          now,
          file,
        }),
        /does not match/,
      )
    }
  })

  test('rejects expiry, future timestamps, malformed base64, and oversized files', async () => {
    const file = await fixture()
    const metadata = await writeValid(file)
    await assert.rejects(
      readKnowledgePlanetVerificationHandoff({
        expected,
        env,
        now: Date.parse(metadata.expiresAt) + 1,
        file,
      }),
      /expired/,
    )
    await assert.rejects(
      readKnowledgePlanetVerificationHandoff({ expected, env, now: now - 31_000, file }),
      /expired/,
    )

    const raw = JSON.parse(await readFile(file.path, 'utf8')) as Record<string, unknown>
    await writeFile(file.path, `${JSON.stringify({ ...raw, nonce: '!!!!' })}\n`, { mode: 0o600 })
    await assert.rejects(
      readKnowledgePlanetVerificationHandoff({ expected, env, now, file }),
      /nonce is invalid/,
    )

    await writeFile(file.path, Buffer.alloc(512 * 1024 + 1), { mode: 0o600 })
    await assert.rejects(
      readKnowledgePlanetVerificationHandoff({ expected, env, now, file }),
      /file is unsafe|byte limit/,
    )
  })

  test('rejects unsafe root/file modes, owners, and symlinks', async () => {
    const file = await fixture()
    await writeValid(file)
    await chmod(file.path, 0o644)
    await assert.rejects(
      readKnowledgePlanetVerificationHandoff({ expected, env, now, file }),
      /file is unsafe/,
    )

    await chmod(file.path, 0o600)
    await chmod(dirname(file.path), 0o755)
    await assert.rejects(
      readKnowledgePlanetVerificationHandoff({ expected, env, now, file }),
      /root is unsafe/,
    )

    await chmod(dirname(file.path), 0o700)
    const target = join(dirname(file.path), 'target')
    await writeFile(target, '{}', { mode: 0o600 })
    await rm(file.path)
    await symlink(target, file.path)
    await assert.rejects(
      readKnowledgePlanetVerificationHandoff({ expected, env, now, file }),
      /valid Knowledge Planet verification handoff is required/,
    )

    const wrongOwner = { ...file, expectedOwnerUid: file.expectedOwnerUid + 1 }
    await mkdir(dirname(file.path), { recursive: true })
    await assert.rejects(
      writeKnowledgePlanetVerificationHandoff({
        expected,
        userId: 1,
        verification: 'existing-account',
        replaceExistingAccount: false,
        expectedExistingAccountInstanceId: null,
        replacementAccountInstanceId: null,
        passedActionIds: expected.actionIds,
        storageState: state,
        env,
        now,
        file: wrongOwner,
      }),
      /root is unsafe/,
    )
  })
})
