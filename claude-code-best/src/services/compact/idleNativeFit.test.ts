import { afterAll, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import type { Message } from '../../types/message.js'
import { buildIdleNativeFit } from './idleNativeFit.js'
import { outerHistoryNeedsCompact, readIdleNativeFile, runIdleCompact, writeIdleNativeFile } from './idleRecover.js'

const MODEL = 'box-claude-haiku-5-5'
const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex')
const envFor = (contextWindow = 1_000_000, canonicalModel = MODEL): NodeJS.ProcessEnv => ({
  OC_MODEL_EXECUTION_DESCRIPTOR: JSON.stringify({ canonicalModel, contextWindow,
    capabilityZero: false, supportsThinking: true, supportsVision: true, supportedEfforts: [] }),
})
const asMessages = (v: unknown): Message[] => v as Message[]
const text = (value: string) => asMessages([
  { type: 'user', uuid: 'u', message: { role: 'user', content: value } },
  { type: 'assistant', uuid: 'a', message: { id: 'low-inner', role: 'assistant',
    content: [{ type: 'text', text: 'done' }], usage: {
      input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    } } },
])
const roots: string[] = []
afterAll(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }) })

async function imageFixture() {
  const pixels = Buffer.alloc(512 * 512 * 3)
  let seed = 0x607
  for (let i = 0; i < pixels.length; i++) {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5
    pixels[i] = seed & 255
  }
  const jpeg = await sharp(pixels, { raw: { width: 512, height: 512, channels: 3 } })
    .jpeg({ quality: 80 }).toBuffer()
  const images = Array.from({ length: 91 }, () => ({ type: 'image', source: {
    type: 'base64', media_type: 'image/jpeg', data: jpeg.toString('base64'),
  } }))
  const messages = asMessages([
    { type: 'assistant', uuid: 'call', message: { id: 'call', role: 'assistant', content: [
      { type: 'tool_use', id: 'toolu_images', name: 'Read', input: { file_path: 'owned-fixture' } },
    ] } },
    { type: 'user', uuid: 'result', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'toolu_images', content: images },
    ] }, toolUseResult: { content: images } },
    { type: 'assistant', uuid: 'final', message: { id: 'final', role: 'assistant',
      content: [{ type: 'text', text: '91 results read' }], usage: {
        input_tokens: 2, output_tokens: 492, cache_read_input_tokens: 176344,
        cache_creation_input_tokens: 5442,
      } } },
  ])
  return { jpeg, images, messages }
}

async function idleFile(modelStarted = false) {
  const home = await mkdtemp(join(tmpdir(), 'idle-native-fit-')); roots.push(home)
  const sessionId = 'fit-session'
  const path = join(home, 'idle-native', sessionId, 'revision.json')
  writeIdleNativeFile(path, { v: 1, opId: 'a'.repeat(64), revision: 'revision',
    sessionId, modelCalls: 0, ...(modelStarted ? { modelStarted: true } : {}),
    frozenTail: [], attachments: [] })
  return { home, sessionId, path }
}

test('1M native idle keeps all 91 bounded JPEGs and mirror bytes without summary or transcript writes', async () => {
  const { jpeg, images, messages } = await imageFixture()
  const original = sha(messages)
  const media = sha(images)
  expect(Buffer.byteLength(JSON.stringify(messages))).toBeGreaterThan(16 * 1024 * 1024)
  expect(outerHistoryNeedsCompact(messages)).toBe(true)
  const fit = await buildIdleNativeFit(messages, MODEL, envFor())
  expect(fit?.inputBudget).toBe(822000)
  expect(fit?.inputTokens).toBeGreaterThanOrEqual(91 * 8192)
  expect(fit?.inputTokens).toBeLessThan(822000)
  expect(outerHistoryNeedsCompact(messages, fit)).toBe(false)
  const file = await idleFile()
  const counts = { summarize: 0, record: 0, flush: 0, load: 0 }
  const result = await runIdleCompact({ ...file, messages, fit,
    summarize: async () => { counts.summarize++; throw new Error('must not summarize') },
    record: async () => { counts.record++ },
    flush: async () => { counts.flush++ },
    load: async () => { counts.load++; return null },
  })
  expect(result).toBe('short')
  expect(counts).toEqual({ summarize: 0, record: 0, flush: 0, load: 0 })
  const native = readIdleNativeFile(file.path)
  expect(native.applied).toBe(true)
  expect(native.modelStarted).toBeUndefined()
  expect(native.modelCalls).toBe(0)
  expect(native.summaryText).toBeUndefined()
  expect(native.artifact).toBeUndefined()
  expect(sha(messages)).toBe(original)
  expect(sha(images)).toBe(media)
  expect(images.length).toBe(91)
  expect(images.reduce((n, image) => n + Buffer.from(image.source.data, 'base64').length, 0)).toBe(jpeg.length * 91)
})

test('full long outer content cannot be hidden by a low inner usage count', async () => {
  const messages = text('x'.repeat(4_000_000))
  const fit = await buildIdleNativeFit(messages, MODEL, envFor())
  expect(fit).toBeDefined()
  expect(outerHistoryNeedsCompact(messages, fit)).toBe(true)
  const smallWindow = await buildIdleNativeFit(text('x'.repeat(200_000)), MODEL, envFor(200_000))
  expect(smallWindow?.inputBudget).toBe(22000)
  expect(outerHistoryNeedsCompact(text('x'.repeat(200_000)), smallWindow)).toBe(true)
})

test('missing malformed wrong-model and user 1m descriptors cannot grant a larger budget', async () => {
  const messages = text('owned')
  expect(await buildIdleNativeFit(messages, MODEL, {})).toBeUndefined()
  expect(await buildIdleNativeFit(messages, MODEL, { OC_MODEL_EXECUTION_DESCRIPTOR: '{' })).toBeUndefined()
  expect(await buildIdleNativeFit(messages, MODEL, envFor(1_000_000, 'box-claude-opus-5-5'))).toBeUndefined()
  expect(await buildIdleNativeFit(messages, `${MODEL}[1m]`, envFor())).toBeUndefined()
  expect(await buildIdleNativeFit(messages, MODEL, envFor(0))).toBeUndefined()
  const upperCase = await buildIdleNativeFit(messages, ' BOX-CLAUDE-HAIKU-5-5 ', envFor())
  expect(upperCase?.inputBudget).toBe(822000)
})

test('missing internal message payloads cannot produce a native fit', async () => {
  for (const type of ['user', 'assistant', 'attachment']) {
    expect(await buildIdleNativeFit(asMessages([{ type, uuid: 'missing' }]), MODEL, envFor()))
      .toBeUndefined()
  }
})

test('PDF URL unknown corrupt and oversized media keep the conservative old path', async () => {
  const wide = await sharp({ create: { width: 2001, height: 2, channels: 3,
    background: { r: 0, g: 0, b: 0 } } }).jpeg().toBuffer()
  for (const block of [
    { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'AAAA' } },
    { type: 'image', source: { type: 'url', url: 'https://invalid.example/owned' } },
    { type: 'image', source: { type: 'base64', media_type: 'image/gif', data: 'AAAA' } },
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } },
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: wide.toString('base64') } },
    { type: 'future_unknown', data: 'owned' },
  ]) {
    const messages = asMessages([{ type: 'user', uuid: 'u', message: { role: 'user', content: [block] } }])
    expect(await buildIdleNativeFit(messages, MODEL, envFor())).toBeUndefined()
  }
})

test('a modelStarted idle op cannot become short or dispatch again from new fit evidence', async () => {
  const messages = text('small and fully preserved')
  const fit = await buildIdleNativeFit(messages, MODEL, envFor())
  expect(fit).toBeDefined()
  const file = await idleFile(true)
  let summaries = 0; let writes = 0
  await expect(runIdleCompact({ ...file, messages, fit,
    summarize: async () => { summaries++; return 'forbidden' },
    record: async () => { writes++ }, flush: async () => { writes++ }, load: async () => null,
  })).rejects.toThrow('IDLE_HISTORY_PENDING')
  expect(summaries).toBe(0)
  expect(writes).toBe(0)
  expect(readIdleNativeFile(file.path).modelStarted).toBe(true)
  expect(readIdleNativeFile(file.path).applied).not.toBe(true)
})
