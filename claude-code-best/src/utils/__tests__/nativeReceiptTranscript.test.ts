import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendNativeReceiptRecord,
  observeNativeReceiptRecord,
  prepareNativeReceiptRecord,
  serializeTranscriptWrite,
} from '../nativeReceiptTranscript.js'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true })
})
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'receipt-native-'))
  dirs.push(dir)
  const file = join(dir, 'session.jsonl')
  await writeFile(file, '{"uuid":"parent","type":"assistant"}\n')
  const line = JSON.stringify({
    type: 'user',
    uuid: 'result',
    sessionId: 'session',
    isSidechain: false,
    parentUuid: 'parent',
    message: { role: 'user', content: '真实结果中文' },
  })
  return prepareNativeReceiptRecord(file, 'session', 'result', line)
}

test('strict commit is exact, present needs native recovery, and duplicate writes fail', async () => {
  const record = await fixture()
  expect(
    await observeNativeReceiptRecord(record.proof, async () => true),
  ).toEqual({ kind: 'absent' })
  await appendNativeReceiptRecord(record)
  expect(
    (await readFile(record.file, 'utf8')).split('\n').filter(Boolean),
  ).toHaveLength(2)
  expect(
    await observeNativeReceiptRecord(record.proof, async () => false),
  ).toEqual({ kind: 'unknown' })
  expect(
    await observeNativeReceiptRecord(record.proof, async () => true),
  ).toEqual({ kind: 'present', proof: record.proof })
  await expect(appendNativeReceiptRecord(record)).rejects.toThrow(
    'already exists',
  )
})

test('complete append with failed fsync is UNKNOWN; recovery retries real sync', async () => {
  const record = await fixture()
  const probe = await open(record.file, 'r+')
  const proto = Object.getPrototypeOf(probe)
  const original = proto.sync
  proto.sync = async function () {
    if ((await this.stat()).isFile()) throw new Error('injected fsync failure')
    return original.call(this)
  }
  try {
    await expect(appendNativeReceiptRecord(record)).rejects.toThrow(
      'fsync failure',
    )
    expect(await readFile(record.file, 'utf8')).toContain(record.line + '\n')
    expect(
      await observeNativeReceiptRecord(record.proof, async () => true),
    ).toEqual({ kind: 'unknown' })
  } finally {
    proto.sync = original
    await probe.close()
  }
  expect(
    await observeNativeReceiptRecord(record.proof, async () => true),
  ).toEqual({ kind: 'present', proof: record.proof })
})

test('partial or conflicting record is UNKNOWN rather than permission to notify', async () => {
  const record = await fixture()
  await writeFile(record.file, record.line.slice(0, -1))
  expect(
    await observeNativeReceiptRecord(record.proof, async () => true),
  ).toEqual({ kind: 'unknown' })
  await writeFile(
    record.file,
    record.line.replace('真实结果中文', 'different') + '\n',
  )
  expect(
    await observeNativeReceiptRecord(record.proof, async () => true),
  ).toEqual({ kind: 'unknown' })
})

test('receipt and ordinary queue writes cannot interleave', async () => {
  const record = await fixture()
  let release!: () => void
  const blocked = new Promise<void>(r => {
    release = r
  })
  let started!: () => void
  const ready = new Promise<void>(r => {
    started = r
  })
  const a = serializeTranscriptWrite(record.file, async () => {
    started()
    await blocked
    await appendNativeReceiptRecord(record)
  })
  await ready
  let second = false
  const b = serializeTranscriptWrite(record.file, async () => {
    second = true
  })
  await Promise.resolve()
  expect(second).toBe(false)
  release()
  await Promise.all([a, b])
  expect(second).toBe(true)
})

test('after-append/before-fsync SIGKILL has a resynchronizable exact record', async () => {
  const record = await fixture()
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      `
    import {open} from 'node:fs/promises';
    import {appendNativeReceiptRecord} from ${JSON.stringify(new URL('../nativeReceiptTranscript.ts', import.meta.url).pathname)};
    const record=JSON.parse(process.env.RECORD);
    const h=await open(record.file,'r+');
    Object.getPrototypeOf(h).sync=async()=>{ process.stdout.write('SYNC_BARRIER\\n'); await new Promise(()=>{}); };
    await appendNativeReceiptRecord(record);
  `,
    ],
    {
      env: { PATH: process.env.PATH!, RECORD: JSON.stringify(record) },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const reader = child.stdout.getReader()
  try {
    const { value } = await reader.read()
    expect(new TextDecoder().decode(value)).toContain('SYNC_BARRIER')
    child.kill('SIGKILL')
    await child.exited
    expect(
      await observeNativeReceiptRecord(record.proof, async () => true),
    ).toEqual({ kind: 'present', proof: record.proof })
  } finally {
    child.kill('SIGKILL')
    reader.releaseLock()
    await child.exited
  }
})
