import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, cp, link, lstat, mkdtemp, readFile, readdir, symlink, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { initializeAuthorityGeneration } from '../authorityGeneration.js'
import { createContainerAuthorityStateReader, readSealedAuthorityStateAt } from '../authorityStateReader.js'
import { decodeManifest, decodeReceipt } from '../authorityGenerationCodec.js'
import { profileSnapshot } from '../userProfile.js'
const text = 'Fixture profile\r\n第二行\r\n'
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex')
async function setup() {
  const hostRoot = await mkdtemp(join(tmpdir(), 'oc-state-reader-host-'))
  const current = await initializeAuthorityGeneration({ hostRoot, userId: '765' }, text)
  const root = await mkdtemp(join(tmpdir(), 'oc-state-reader-only-'))
  const stateRoot = join(root, 'state')
  await cp(join(hostRoot, 'u765/state'), stateRoot, { recursive: true })
  const options = { stateRoot, userId: '765', ownerUid: process.getuid!() }
  const selected = join(stateRoot, 'generations', current.generation)
  const read = () => readSealedAuthorityStateAt(options)
  const snapshot = async () => {
    const out: Record<string, string> = {}
    const walk = async (dir: string) => { for (const item of await readdir(dir, { withFileTypes: true })) { const path = join(dir, item.name); if (item.isDirectory()) { out[`${path.slice(stateRoot.length)}/`] = 'directory'; await walk(path) } else out[path.slice(stateRoot.length)] = `${(await lstat(path)).mode}:${hash(await readFile(path))}` } }
    await walk(stateRoot)
    return out
  }
  return { stateRoot, selected, options, current, read, snapshot }
}
test('state-only reader captures verified bytes with no host parent/staging and does not write or repair', async () => {
  const t = await setup(); const before = await t.snapshot()
  const read = await t.read()
  assert.deepEqual(read, { userId: '765', generation: t.current.generation, manifestSha256: t.current.manifestSha256, profile: profileSnapshot(text) })
  assert.equal(Object.isFrozen(read) && Object.isFrozen(read.profile), true)
  assert.deepEqual(await t.snapshot(), before)
})
test('cross-user, noncanonical uid, root aliases and wrong expected owner are unavailable', async () => {
  const t = await setup()
  for (const userId of ['766', '0765', '0', '765\n', '9223372036854775808']) await assert.rejects(readSealedAuthorityStateAt({ ...t.options, userId }))
  await assert.rejects(readSealedAuthorityStateAt({ ...t.options, ownerUid: t.options.ownerUid + 1 }))
  await assert.rejects(readSealedAuthorityStateAt({ ...t.options, stateRoot: `${t.stateRoot}/..` }))
  const alias = `${t.stateRoot}-alias`; await symlink(t.stateRoot, alias)
  await assert.rejects(readSealedAuthorityStateAt({ ...t.options, stateRoot: alias }))
  for (const userId of ['0765', '765\n', '0']) assert.throws(() => createContainerAuthorityStateReader(userId))
  assert.deepEqual(Object.keys(createContainerAuthorityStateReader('765')), ['capture'])
})
for (const target of ['sealed.json', 'current.json', 'commits']) test(`missing or inconsistent ${target} never repairs/falls back`, async () => {
  const t = await setup()
  const path = target === 'commits' ? join(t.stateRoot, 'commits', `${t.current.manifestSha256}.json`) : join(t.stateRoot, target)
  await chmod(path, 0o600); await writeFile(path, '{}')
  const before = await t.snapshot()
  await assert.rejects(t.read())
  assert.deepEqual(await t.snapshot(), before)
})
test('missing mandatory profile is unavailable rather than an empty profile', async () => {
  const t = await setup(); await unlink(join(t.selected, 'data/user.md'))
  const before = await t.snapshot(); await assert.rejects(t.read()); assert.deepEqual(await t.snapshot(), before)
})
test('profile byte hash mismatch and added selected files are rejected', async () => {
  for (const kind of ['bytes', 'extra']) {
    const t = await setup()
    if (kind === 'bytes') { await chmod(join(t.selected, 'data/user.md'), 0o600); await writeFile(join(t.selected, 'data/user.md'), 'different') }
    else await writeFile(join(t.selected, 'data/unlisted.md'), 'different')
    const before = await t.snapshot(); await assert.rejects(t.read()); assert.deepEqual(await t.snapshot(), before)
  }
})
test('symlink, hardlink and group-writable profile cannot become formal context', async () => {
  for (const kind of ['symlink', 'hardlink', 'writable']) {
    const t = await setup(); const file = join(t.selected, 'data/user.md')
    if (kind === 'writable') await chmod(file, 0o666)
    else {
      const copy = `${t.stateRoot}-outside`; await writeFile(copy, text, { mode: 0o444 }); await unlink(file)
      if (kind === 'symlink') await symlink(copy, file); else await link(copy, file)
    }
    await assert.rejects(t.read())
  }
})
test('orphan generations and legitimate metadata temporary files are ignored, never selected', async () => {
  const t = await setup()
  await cp(t.selected, join(t.stateRoot, 'generations', '00000000-0000-0000-0000-000000000000'), { recursive: true })
  await writeFile(join(t.stateRoot, '.current.json-unpublished'), 'incomplete')
  const before = await t.snapshot(); const read = await t.read()
  assert.equal(read.generation, t.current.generation); assert.deepEqual(await t.snapshot(), before)
})
test('generation archive mismatch and unlisted receipt are rejected without cleanup', async () => {
  for (const kind of ['archive', 'receipt']) {
    const t = await setup()
    if (kind === 'archive') { await chmod(join(t.selected, 'manifest.json'), 0o600); await writeFile(join(t.selected, 'manifest.json'), '{}') }
    else await writeFile(join(t.selected, 'receipts', '00000000-0000-0000-0000-000000000000.json'), '{}')
    const before = await t.snapshot(); await assert.rejects(t.read()); assert.deepEqual(await t.snapshot(), before)
  }
})
test('shared codecs require canonical scalar metadata, including strict end-of-input for hashes and ids', async () => {
  const t = await setup(); const original = JSON.parse((await readFile(join(t.stateRoot, 'current.json'))).toString())
  for (const change of [{ generation: `${original.generation}\n` }, { generation: [original.generation] }, { parent: `${'a'.repeat(64)}\n` }, { parent: ['a'.repeat(64)] }]) {
    assert.throws(() => decodeManifest(Buffer.from(JSON.stringify({ ...original, ...change })), '765'))
  }
})

test('receipt codec rejects extra executable fields and malformed nested proofs', async () => {
  const t = await setup(); const id = 'b5be0795-e604-45ee-bd8b-a519324b5cf4'
  const receipt = { binding: { id, userId: '765', sessionId: 'fixture-session', agentId: 'main', operationId: 'memory.profile.update', operationVersion: 1, requestHash: 'a'.repeat(64), inputHash: 'b'.repeat(64) }, generation: t.current.generation, result: { version: profileSnapshot(text).version } }
  assert.equal(decodeReceipt(Buffer.from(JSON.stringify(receipt)), '765', id).binding.id, id)
  for (const invalid of [{ ...receipt, command: 'unexpected' }, { ...receipt, result: { ...receipt.result, extra: true } }, { ...receipt, binding: { ...receipt.binding, inputHash: `${'b'.repeat(64)}\n` } }]) {
    assert.throws(() => decodeReceipt(Buffer.from(JSON.stringify(invalid)), '765', id))
  }
})
