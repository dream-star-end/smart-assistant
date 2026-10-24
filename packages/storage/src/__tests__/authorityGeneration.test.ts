import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, link, lstat, mkdtemp, readFile, rename, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { findProfileGenerationReceipt, initializeAuthorityGeneration, publishProfileGeneration, readAuthorityGeneration, recoverBaselineAuthorityGeneration, recoverProfileGeneration, type AuthorityStore } from '../authorityGeneration.js'
import { profileSnapshot } from '../userProfile.js'
import type { SystemActionReceiptBinding } from '../systemActions.js'
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
async function setup() {
  const hostRoot = await mkdtemp(join(tmpdir(), 'oc-authority-gen-'))
  await chmod(hostRoot, 0o700)
  const store: AuthorityStore = { hostRoot, userId: '765' }
  const base = await initializeAuthorityGeneration(store, 'original profile')
  return { store, base }
}
function binding(): SystemActionReceiptBinding {
  return { id: randomUUID(), userId: '765', sessionId: 'synthetic-session', agentId: 'default', operationId: 'profile.update', operationVersion: 1, requestHash: sha('request'), inputHash: sha('frozen-input') }
}
test('publishes profile+exact receipt together, keeps old snapshot unchanged and retains historical idempotency', async () => {
  const { store, base } = await setup()
  const action = binding()
  const first = await publishProfileGeneration(store, { baseManifestSha256: base.manifestSha256, expectedVersion: profileSnapshot('original profile').version, text: 'first approved', binding: action })
  assert.equal(await readFile(base.paths.sharedUserMd, 'utf8'), 'original profile')
  assert.equal((await lstat(base.paths.sharedUserMd)).nlink, 1)
  const next = await readAuthorityGeneration(store)
  assert.equal(await readFile(next.paths.sharedUserMd, 'utf8'), 'first approved')
  assert.deepEqual(await findProfileGenerationReceipt(store, action), first)
  await publishProfileGeneration(store, { baseManifestSha256: next.manifestSha256, expectedVersion: profileSnapshot('first approved').version, text: 'second approved', binding: binding() })
  assert.deepEqual(await publishProfileGeneration(store, { baseManifestSha256: base.manifestSha256, expectedVersion: '0'.repeat(16), text: 'must not execute', binding: action }), first)
  assert.equal(await readFile((await readAuthorityGeneration(store)).paths.sharedUserMd, 'utf8'), 'second approved')
  await assert.rejects(findProfileGenerationReceipt(store, { ...action, inputHash: sha('different') }), /unknown/)
})
test('per-user kernel flock serializes competing CAS updates, exactly one generation wins', async () => {
  const { store, base } = await setup()
  const input = { baseManifestSha256: base.manifestSha256, expectedVersion: profileSnapshot('original profile').version }
  const results = await Promise.allSettled(['one', 'two'].map(text => publishProfileGeneration(store, { ...input, text, binding: binding() })))
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal(results.filter(r => r.status === 'rejected').length, 1)
  assert.ok(['one', 'two'].includes(await readFile((await readAuthorityGeneration(store)).paths.sharedUserMd, 'utf8')))
})
for (const phase of ['manifest-visible', 'manifest-durable', 'seal-prepared'] as const) test(`${phase}: visible receipt stays unknown until trusted recovery completes durability without reapplying business data`, async () => {
  const { store, base } = await setup()
  const action = binding()
  await assert.rejects(publishProfileGeneration(store, { baseManifestSha256: base.manifestSha256, expectedVersion: profileSnapshot('original profile').version, text: 'approved after crash', binding: action }, { faultAfter: phase }), /unknown/)
  await assert.rejects(readAuthorityGeneration(store))
  await assert.rejects(findProfileGenerationReceipt(store, action))
  const state = join(store.hostRoot, 'u765/state')
  const manifestSha256 = sha(await readFile(join(state, 'current.json'), 'utf8'))
  if (phase === 'seal-prepared') await assert.rejects(readFile(join(state, 'commits', `${manifestSha256}.json`)), { code: 'ENOENT' })
  const permit = { manifestSha256, parentManifestSha256: base.manifestSha256, binding: action, profileSha256: sha('approved after crash') }
  await assert.rejects(recoverProfileGeneration(store, { ...permit, binding: { ...action, inputHash: sha('wrong') } }), /unknown/)
  await assert.rejects(findProfileGenerationReceipt(store, action))
  const recovered = await recoverProfileGeneration(store, permit)
  assert.deepEqual(await findProfileGenerationReceipt(store, action), recovered)
  assert.equal(await readFile((await readAuthorityGeneration(store)).paths.sharedUserMd, 'utf8'), 'approved after crash')
})
test('pre-activation crash leaves prior snapshot authoritative; post-commit lost reply reconciles the exact receipt', async () => {
  const { store, base } = await setup()
  const before = binding()
  const input = { baseManifestSha256: base.manifestSha256, expectedVersion: profileSnapshot('original profile').version, text: 'new profile' }
  await assert.rejects(publishProfileGeneration(store, { ...input, binding: before }, { faultAfter: 'generation-durable' }))
  assert.equal((await readAuthorityGeneration(store)).manifestSha256, base.manifestSha256)
  assert.equal(await findProfileGenerationReceipt(store, before), null)
  const after = binding()
  await assert.rejects(publishProfileGeneration(store, { ...input, binding: after }, { faultAfter: 'seal-durable' }))
  assert.equal((await findProfileGenerationReceipt(store, after))?.binding.id, after.id)
  assert.equal(await findProfileGenerationReceipt(store, before), null)
})
test('missing/corrupt current or seal never initializes a fallback; cross-uid reads are rejected', async () => {
  const { store } = await setup()
  await assert.rejects(readAuthorityGeneration({ ...store, userId: '766' }))
  const current = join(store.hostRoot, 'u765/state/current.json')
  await chmod(current, 0o600)
  await writeFile(current, '{}')
  await assert.rejects(readAuthorityGeneration(store))
  await assert.rejects(initializeAuthorityGeneration(store, 'must not reset'))
})
test('symlink and external hardlink payloads fail closed without repairing the tree', async () => {
  for (const kind of ['symlink', 'hardlink'] as const) {
    const { store, base } = await setup()
    const other = join(store.hostRoot, 'outside')
    if (kind === 'symlink') {
      await rename(base.paths.sharedUserMd, other)
      await symlink(other, base.paths.sharedUserMd)
      await assert.rejects(readAuthorityGeneration(store))
    } else {
      await link(base.paths.sharedUserMd, other)
      await assert.rejects(readAuthorityGeneration(store))
    }
    assert.equal(await readFile(base.paths.sharedUserMd, 'utf8'), 'original profile')
  }
})

for (const faultAfter of ['manifest-visible', 'seal-prepared'] as const) test(`initial baseline interrupted at ${faultAfter} only recovers with an exact authorized baseline permit`, async () => {
  const hostRoot = await mkdtemp(join(tmpdir(), 'oc-authority-baseline-'))
  await chmod(hostRoot, 0o700)
  const store = { hostRoot, userId: '765' }
  await assert.rejects(initializeAuthorityGeneration(store, 'baseline', { faultAfter }))
  await assert.rejects(readAuthorityGeneration(store))
  await assert.rejects(initializeAuthorityGeneration(store, 'replacement'))
  const manifestSha256 = sha(await readFile(join(hostRoot, 'u765/state/current.json'), 'utf8'))
  await assert.rejects(recoverBaselineAuthorityGeneration(store, { manifestSha256, profileSha256: sha('wrong') }))
  await assert.rejects(readAuthorityGeneration(store))
  const recovered = await recoverBaselineAuthorityGeneration(store, { manifestSha256, profileSha256: sha('baseline') })
  assert.equal(await readFile(recovered.paths.sharedUserMd, 'utf8'), 'baseline')
})
test('legacy null request hashes are refused before staging a non-reconcilable mutation', async () => {
  const { store, base } = await setup()
  await assert.rejects(publishProfileGeneration(store, { baseManifestSha256: base.manifestSha256, expectedVersion: profileSnapshot('original profile').version, text: 'must not write', binding: { ...binding(), requestHash: null } }))
  assert.equal((await readAuthorityGeneration(store)).manifestSha256, base.manifestSha256)
})
