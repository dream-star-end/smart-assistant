import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile, rename, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, type TestContext } from 'node:test'
import Database from 'better-sqlite3'
import protobuf from 'protobufjs'
import {
  ANTIGRAVITY_NATIVE_CLI_SHA256,
  prepareAntigravityNativeTrajectory as prepare,
  recoverAntigravityNativeTrajectory as recover,
  verifyAntigravityNativeBinary,
  type AntigravityNativeDependencies,
} from '../engine/antigravityNativeTrajectory.js'
import { antigravityNativeSchema } from '../engine/antigravityNativeSchema.js'

const ID = '92625904-66cb-46b2-9d69-01085e445125'
const OTHER = '82625904-66cb-46b2-9d69-01085e445125'
const CONTENT = '真实 stdin\r\n🙂 e\u0301'
const ANSWER = '最终正文\n不包含 thinking。'
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const root = protobuf.Root.fromJSON(antigravityNativeSchema).resolveAll()
const stepType = root.lookupType('gemini_coder_Step')
const metadataType = root.lookupType('exa_cortex_pb_CortexStepMetadata')
const user = (text = CONTENT) => ({ type: 14, status: 3, user_input: { user_response: text } })
const final = (response: Record<string, unknown> = {}) => ({ type: 15, status: 3,
  planner_response: { response: ANSWER, modified_response: ANSWER, stop_reason: 2, ...response } })
const deps: AntigravityNativeDependencies = { verifyBinary: async (_path, expected) => {
  assert.equal(expected, ANTIGRAVITY_NATIVE_CLI_SHA256)
  return true
} }
function createDb(filename: string, id = ID) {
  const db = new Database(filename)
  db.exec(`CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER NOT NULL, status INTEGER NOT NULL,
    step_payload BLOB, metadata BLOB, step_format INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE trajectory_meta (trajectory_id TEXT PRIMARY KEY, cascade_id TEXT);`)
  db.prepare('INSERT INTO trajectory_meta VALUES (?, ?)').run('trajectory', id)
  return db
}
function insert(db: Database.Database, idx: number, step: Record<string, unknown>,
  overrides: { type?: number; status?: number; format?: number; payload?: Buffer; metadata?: Record<string, unknown> } = {}) {
  db.prepare('INSERT INTO steps VALUES (?, ?, ?, ?, ?, ?)').run(idx, overrides.type ?? step.type,
    overrides.status ?? step.status, overrides.payload ?? Buffer.from(stepType.encode(step).finish()),
    overrides.metadata ? Buffer.from(metadataType.encode(overrides.metadata).finish()) : null, overrides.format ?? 0)
}
async function fixture(t: TestContext) {
  const dir = await mkdtemp(path.join(tmpdir(), 'agy-native-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return { dir, filename: path.join(dir, `${ID}.db`),
    input: { cliPath: path.join(dir, 'fake-cli'), conversationsDir: dir, message: { content: CONTENT } } }
}

test('fresh launch recovers exact UTF-8 answer, leaves SQLite bytes unchanged, and never needs CLI', async t => {
  const f = await fixture(t)
  const binding = await prepare(f.input, deps)
  assert.equal(binding.baseline, -1)
  // Keep this positive fixture unambiguously beyond the filesystem birthtime
  // clock tick; ambiguous immediate creations must remain fail-closed.
  await new Promise(resolve => setTimeout(resolve, 20))
  const db = createDb(f.filename)
  insert(db, 0, user()); insert(db, 1, final({ thinking: 'secret thinking', raw_thinking: 'not an answer' })); db.close()
  const before = hash(await readFile(f.filename))
  assert.deepEqual(await recover(binding, ID, ID), { ok: true, text: ANSWER, stepIndex: 1, hash: hash(ANSWER) })
  assert.equal(hash(await readFile(f.filename)), before)
})

test('resume baseline excludes old round and binds exact new stdin, not prompt snippets', async t => {
  const f = await fixture(t), db = createDb(f.filename)
  insert(db, 0, user('old')); insert(db, 1, final({ response: 'old', modified_response: 'old' }))
  const binding = await prepare({ ...f.input, requestedResumeId: ID }, deps)
  assert.equal(binding.baseline, 1)
  insert(db, 2, user()); insert(db, 3, final()); db.close()
  assert.deepEqual(await recover(binding, ID, ID), { ok: true, text: ANSWER, stepIndex: 3, hash: hash(ANSWER) })
})

test('tool call must have one subsequent terminal result, terminal ERROR is not unfinished', async t => {
  const f = await fixture(t), db = createDb(f.filename)
  const binding = await prepare({ ...f.input, requestedResumeId: ID }, deps)
  insert(db, 0, user())
  insert(db, 1, final({ response: '', modified_response: '', tool_calls: [{ id: 'call-1', name: 'write_file' }] }))
  insert(db, 2, { type: 132, status: 7, generic: { result: { result: 'failed tool' } } },
    { metadata: { tool_call: { id: 'call-1' } } })
  insert(db, 3, final()); db.close()
  assert.equal((await recover(binding, ID, ID)).ok, true)
})

const invalidCases: [string, (db: Database.Database) => void][] = [
  ['thinking-only', db => { insert(db, 0, user()); insert(db, 1, final({ response: '', modified_response: '', thinking: 'hidden', raw_thinking: 'hidden2' })) }],
  ['conflicting answer', db => { insert(db, 0, user()); insert(db, 1, final({ modified_response: 'different' })) }],
  ['input normalization mismatch', db => { insert(db, 0, user(CONTENT.normalize('NFC'))); insert(db, 1, final()) }],
  ['two user boundaries', db => { insert(db, 0, user()); insert(db, 1, user()); insert(db, 2, final()) }],
  ['missing user boundary', db => { insert(db, 0, final()); insert(db, 1, final()) }],
  ['late user boundary', db => { insert(db, 0, final()); insert(db, 1, user()); insert(db, 2, final()) }],
  ['unknown format', db => { insert(db, 0, user()); insert(db, 1, final(), { format: 1 }) }],
  ['SQL type conflict', db => { insert(db, 0, user()); insert(db, 1, final(), { type: 14 }) }],
  ['SQL status conflict', db => { insert(db, 0, user()); insert(db, 1, final(), { status: 7 }) }],
  ['unknown enum', db => { insert(db, 0, user()); insert(db, 1, final({ stop_reason: 999 })) }],
  ['canceled stop', db => { insert(db, 0, user()); insert(db, 1, final({ stop_reason: 16 })) }],
  ['max tokens stop', db => { insert(db, 0, user()); insert(db, 1, final({ stop_reason: 3 })) }],
  ['missing stop', db => { insert(db, 0, user()); const s = final(); delete (s.planner_response as Record<string, unknown>).stop_reason; insert(db, 1, s) }],
  ['unknown field', db => { insert(db, 0, user()); insert(db, 1, final(), { payload: Buffer.concat([Buffer.from(stepType.encode(final()).finish()), Buffer.from([0xf8, 0x7f, 1])]) }) }],
  ['truncated message', db => { insert(db, 0, user()); insert(db, 1, final(), { payload: Buffer.from(stepType.encode(final()).finish()).subarray(0, -1) }) }],
  ['duplicate singular field', db => { insert(db, 0, user()); insert(db, 1, final(), { payload: Buffer.concat([Buffer.from(stepType.encode(final()).finish()), Buffer.from([8, 15])]) }) }],
  ['wrong wire type', db => { insert(db, 0, user()); insert(db, 1, final(), { payload: Buffer.from([10, 1, 15, 32, 3]) }) }],
  ['index gap', db => { insert(db, 0, user()); insert(db, 2, final()) }],
  ['unknown step type', db => { insert(db, 0, user()); insert(db, 1, { ...final(), type: 999 }) }],
  ['unfinished tool', db => { insert(db, 0, user()); insert(db, 1, final({ tool_calls: [{ id: 'pending' }] })); insert(db, 2, final()) }],
  ['running tool', db => { insert(db, 0, user()); insert(db, 1, final({ tool_calls: [{ id: 'pending' }] })); insert(db, 2, { type: 132, status: 2, generic: {} }, { metadata: { tool_call: { id: 'pending' } } }); insert(db, 3, final()) }],
  ['unmatched tool result', db => { insert(db, 0, user()); insert(db, 1, { type: 132, status: 3, generic: {} }, { metadata: { tool_call: { id: 'orphan' } } }); insert(db, 2, final()) }],
  ['mixed payload kinds', db => { insert(db, 0, user()); insert(db, 1, { ...final(), generic: {} }) }],
]
for (const [name, populate] of invalidCases) test(`fail closed: ${name}`, async t => {
  // Exercise the invalid payload itself, not an unrelated fresh-file clock fence.
  const f = await fixture(t), db = createDb(f.filename)
  const binding = await prepare({ ...f.input, requestedResumeId: ID }, deps)
  assert.equal(binding.baseline, -1)
  populate(db); db.close()
  assert.equal((await recover(binding, ID, ID)).ok, false)
})

for (const which of ['response', 'modified_response']) test(`accept sole ${which}`, async t => {
  // Isolate answer selection from the fresh-file timestamp fence using an empty
  // resume database (baseline -1). Fresh-launch behavior has separate coverage.
  const f = await fixture(t), db = createDb(f.filename)
  const binding = await prepare({ ...f.input, requestedResumeId: ID }, deps)
  assert.equal(binding.baseline, -1)
  insert(db, 0, user()); insert(db, 1, final({ response: '', modified_response: '', [which]: ANSWER })); db.close()
  assert.deepEqual(await recover(binding, ID, ID), { ok: true, text: ANSWER, stepIndex: 1, hash: hash(ANSWER) })
})

test('hash unknown still exposes resume MAX(idx), but cannot recover', async t => {
  const f = await fixture(t), db = createDb(f.filename)
  insert(db, 0, user()); insert(db, 1, final())
  const binding = await prepare({ ...f.input, requestedResumeId: ID }, { verifyBinary: async () => false })
  assert.equal(binding.baseline, 1); assert.equal(binding.binaryVerified, false)
  insert(db, 2, user()); insert(db, 3, final()); db.close()
  assert.deepEqual(await recover(binding, ID, ID), { ok: false, reason: 'binary-unverified' })
})

test('unknown baseline disables recovery without creating a missing DB', async t => {
  const f = await fixture(t), binding = await prepare({ ...f.input, requestedResumeId: ID }, deps)
  assert.equal(binding.baseline, null)
  assert.equal((await recover(binding, ID, ID)).ok, false)
  await assert.rejects(readFile(f.filename), { code: 'ENOENT' })
})

test('fresh launch cannot recover a DB present at prepare even with identical prompt', async t => {
  const f = await fixture(t), db = createDb(f.filename)
  insert(db, 0, user()); insert(db, 1, final()); db.close()
  const binding = await prepare(f.input, deps)
  assert.deepEqual(await recover(binding, ID, ID), { ok: false, reason: 'preexisting-conversation' })
})

test('fresh launch rejects an older DB moved into directory after prepare', async t => {
  const f = await fixture(t)
  const staging = path.join(f.dir, 'old.db'), db = createDb(staging)
  insert(db, 0, user()); insert(db, 1, final()); db.close()
  await new Promise(resolve => setTimeout(resolve, 15))
  const binding = await prepare(f.input, deps)
  await rename(staging, f.filename)
  assert.deepEqual(await recover(binding, ID, ID), { ok: false, reason: 'prelaunch-database' })
})

test('resume rejects unchanged old round, baseline rewrite, replaced DB, and mismatched IDs', async t => {
  const f = await fixture(t), db = createDb(f.filename)
  insert(db, 0, user()); insert(db, 1, final())
  const binding = await prepare({ ...f.input, requestedResumeId: ID }, deps)
  assert.equal((await recover(binding, ID, ID)).ok, false)
  insert(db, 2, user()); insert(db, 3, final())
  for (const [init, result] of [[ID, OTHER], [OTHER, OTHER], [undefined, ID], [ID, undefined], ['../x', '../x']]) {
    assert.deepEqual(await recover(binding, init, result), { ok: false, reason: 'conversation-mismatch' })
  }
  db.prepare('UPDATE steps SET status = 7 WHERE idx = 1').run()
  assert.deepEqual(await recover(binding, ID, ID), { ok: false, reason: 'baseline-changed' }); db.close()
  await rename(f.filename, path.join(f.dir, 'replaced.db'))
  const replacement = createDb(f.filename); insert(replacement, 0, user()); insert(replacement, 1, final()); replacement.close()
  assert.deepEqual(await recover(binding, ID, ID), { ok: false, reason: 'database-replaced' })
})

test('read failures, bad schema, symlinks and verifier exceptions never escape', async t => {
  const f = await fixture(t)
  const bad = await prepare(f.input, { verifyBinary: async () => { throw new Error('private error') } })
  assert.equal(bad.binaryVerified, false)
  assert.equal((await recover(bad, ID, ID)).ok, false)
  const binding = await prepare(f.input, deps)
  await writeFile(f.filename, 'not sqlite')
  assert.deepEqual(await recover(binding, ID, ID), { ok: false, reason: 'native-read-failed' })
  await rename(f.filename, path.join(f.dir, 'target.db')); await symlink(path.join(f.dir, 'target.db'), f.filename)
  assert.equal((await recover(binding, ID, ID)).ok, false)
})

test('binary verifier streams content, detects replacement and missing path, no process needed', async t => {
  const f = await fixture(t), binary = f.input.cliPath
  await writeFile(binary, 'first content')
  assert.equal(await verifyAntigravityNativeBinary(binary, hash('first content')), true)
  assert.equal(await verifyAntigravityNativeBinary(binary), false) // cached pinned-hash rejection
  await writeFile(binary, 'other content')
  assert.equal(await verifyAntigravityNativeBinary(binary, hash('first content')), false)
  assert.equal(await verifyAntigravityNativeBinary(binary, hash('other content')), true)
  await rename(binary, `${binary}.old`); await writeFile(binary, 'new inode')
  assert.equal(await verifyAntigravityNativeBinary(binary, hash('other content')), false)
  assert.equal(await verifyAntigravityNativeBinary(`${binary}.missing`), false)
})

test('binary identity is reverified at recovery, dependency failure fails closed', async t => {
  const f = await fixture(t)
  let calls = 0
  const binding = await prepare(f.input, { verifyBinary: async () => ++calls === 1 })
  const db = createDb(f.filename); insert(db, 0, user()); insert(db, 1, final()); db.close()
  assert.deepEqual(await recover(binding, ID, ID), { ok: false, reason: 'binary-unverified' })
  assert.equal(calls, 2)
})


test('strict protobuf validation rejects unterminated 10-byte DONE varint rather than truncating to 3', async t => {
  const f = await fixture(t), db = createDb(f.filename)
  const binding = await prepare({ ...f.input, requestedResumeId: ID }, deps)
  insert(db, 0, user())
  const good = Buffer.from(stepType.encode(final()).finish())
  const status = good.indexOf(Buffer.from([0x20, 3]))
  assert.ok(status >= 0)
  const corrupt = Buffer.concat([good.subarray(0, status + 1),
    Buffer.from([0x83, ...Array(9).fill(0x80)]), good.subarray(status + 2)])
  insert(db, 1, final(), { payload: corrupt }); db.close()
  assert.deepEqual(await recover(binding, ID, ID), { ok: false, reason: 'native-read-failed' })
})

test('fresh missing conversations directory stays read-only and still exposes -1', async t => {
  const f = await fixture(t), missing = path.join(f.dir, 'nested', 'conversations')
  const binding = await prepare({ ...f.input, conversationsDir: missing }, deps)
  assert.equal(binding.baseline, -1)
  await assert.rejects(readFile(missing), { code: 'ENOENT' })
  assert.equal(binding.binaryVerified, true)
  assert.equal(binding.reason, undefined)
})


test('overlong status cannot redirect standard decoder into thinking_signature bytes', async t => {
  const f = await fixture(t), db = createDb(f.filename)
  const binding = await prepare({ ...f.input, requestedResumeId: ID }, deps)
  insert(db, 0, user())
  const corrupt = Buffer.concat([
    Buffer.from([0x08, 0x0f, 0x20, 0x83, 0x80, 0x80, 0x80, 0x80, 0x00,
      0xa2, 0x01, 0x23, 0x72, 0x21, 0x03, 0xa2, 0x01, 0x1d, 0x0a, 0x19]),
    Buffer.alloc(25, 0x41), Buffer.from([0x60, 0x02]),
  ])
  insert(db, 1, final(), { payload: corrupt }); db.close()
  assert.deepEqual(await recover(binding, ID, ID), { ok: false, reason: 'native-read-failed' })
})

test('valid signed int32 remains accepted while an overflowing int32 is rejected', async t => {
  const f = await fixture(t), db = createDb(f.filename)
  const binding = await prepare({ ...f.input, requestedResumeId: ID }, deps)
  insert(db, 0, user())
  insert(db, 1, { ...final(), metadata: { flow_credits_used: -1 } })
  assert.deepEqual(await recover(binding, ID, ID), { ok: true, text: ANSWER, stepIndex: 1, hash: hash(ANSWER) })
  const overflow = Buffer.from(protobuf.Writer.create().uint32(14 << 3).uint64('34359738368').finish())
  const payload = Buffer.concat([Buffer.from(stepType.encode(final()).finish()),
    Buffer.from(protobuf.Writer.create().uint32(5 << 3 | 2).bytes(overflow).finish())])
  db.prepare('UPDATE steps SET step_payload = ? WHERE idx = 1').run(payload); db.close()
  assert.deepEqual(await recover(binding, ID, ID), { ok: false, reason: 'native-read-failed' })
})
