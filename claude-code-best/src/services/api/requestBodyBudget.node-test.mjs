import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { readFileInRange } from '../../utils/readFileInRange.ts'
import { CCB_REQUEST_BYTE_LIMITS, createCcbBudgetFetch, prepareCcbRequestBody, RequestBodyBudgetError } from './requestBodyBudget.ts'
import { PROXY_BYTE_BUDGET_LEGACY } from '../../../../packages/commercial/src/http/proxy/shared.ts'
import { BOX_API_MODEL_IDS } from '../../../../packages/protocol/src/boxApiModels.ts'

const BOX_MODELS = BOX_API_MODEL_IDS
const MIB = 1024 * 1024
const tools = [{ name: 'Read', input_schema: { type: 'object', properties: {} } }]
const user = content => ({ role: 'user', content })
const assistant = content => ({ role: 'assistant', content })
const text = value => ({ type: 'text', text: value })
const media = (data, mime) => ({ type: mime === 'application/pdf' ? 'document' : 'image', source: { type: 'base64', media_type: mime, data: data.toString('base64') } })
const payload = messages => ({ model: 'claude-sonnet-4-5', tools, messages, stream: true, max_tokens: 1000 })
const allText = messages => messages.flatMap(m => typeof m.content === 'string' ? [m.content] : m.content.flatMap(b => b.type === 'text' ? [b.text] : b.type === 'tool_result' ? (typeof b.content === 'string' ? [b.content] : b.content.filter(c => c.type === 'text').map(c => c.text)) : []))
const paths = messages => allText(messages).flatMap(t => [...t.matchAll(/workspace file ("[^"\n]+") \(/g)].map(m => JSON.parse(m[1])))
function assertFits(raw) {
  const body = JSON.parse(raw)
  assert.ok(Buffer.byteLength(raw) < CCB_REQUEST_BYTE_LIMITS.body)
  assert.ok(Buffer.byteLength(JSON.stringify(body.messages)) < CCB_REQUEST_BYTE_LIMITS.messages)
  assert.ok(Buffer.byteLength(raw) < 20_000_000)
  return body
}
async function harness(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'ccb-body-budget-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const events = []
  const sent = []
  const fetch = createCcbBudgetFetch(async (_input, init) => {
    sent.push(init)
    return new Response('offline stub', { status: 200 })
  }, { enabled: () => true, remoteOwnsHistory: model => BOX_MODELS.includes(model), cwd: () => cwd, sessionId: () => 'same-native-session', onEvent: e => events.push(e) })
  return { cwd, events, sent, fetch, opts: { cwd, sessionId: 'same-native-session', onEvent: e => events.push(e) } }
}

test('budget matches the ordinary proxy authority without changing any gate', () => {
  assert.deepEqual(CCB_REQUEST_BYTE_LIMITS, { body: PROXY_BYTE_BUDGET_LEGACY.totalBody, messages: PROXY_BYTE_BUDGET_LEGACY.messages, system: PROXY_BYTE_BUDGET_LEGACY.system, tools: PROXY_BYTE_BUDGET_LEGACY.tools })
})

test('>20MB history with multiple images/PDFs keeps exact attachments and continues in one native session', async t => {
  const h = await harness(t)
  const originals = [Buffer.alloc(3 * MIB, 1), Buffer.alloc(3 * MIB, 2), Buffer.alloc(3 * MIB, 3), Buffer.alloc(8 * MIB, 4)]
  const history = [user([text('Keep the original engineering decision: use 42.'), ...originals.map((b, i) => media(b, i === 3 ? 'application/pdf' : 'image/png'))]), assistant([text('Decision acknowledged')])]
  const originalJson = JSON.stringify(history)
  const currentImage = Buffer.alloc(100_000, 5)
  let firstPaths
  for (let turn = 0; turn < 4; turn++) {
    const current = user([text(`Question ${turn}: 根据原始 PDF 和图，继续 "42" 😀`), media(currentImage, 'image/png')])
    const raw = JSON.stringify(payload([...history, current]))
    assert.ok(Buffer.byteLength(raw) > 20_000_000)
    const result = await h.fetch('https://offline.invalid/v1/messages?beta=true', { method: 'POST', headers: { 'content-length': String(Buffer.byteLength(raw)) }, body: raw })
    assert.equal(result.status, 200)
    const wire = assertFits(h.sent.at(-1).body)
    assert.deepEqual(wire.messages.at(-1), current)
    assert.equal(wire.messages[0].content[0].text, history[0].content[0].text)
    const files = paths(wire.messages)
    assert.equal(files.length, originals.length)
    if (!firstPaths) firstPaths = files
    else assert.deepEqual(files, firstPaths, 'same native session reuses attachment references')
    for (let i = 0; i < files.length; i++) {
      assert.deepEqual(await readFile(files[i]), originals[i])
      assert.equal((await stat(files[i])).mode & 0o777, 0o600)
      assert.equal((await stat(join(files[i], '..'))).mode & 0o777, 0o700)
    }
    assert.equal(h.sent.at(-1).headers.get('content-length'), null)
  }
  assert.equal(JSON.stringify(history), originalJson, 'native source history stays unchanged')
  assert.equal((await readdir(h.cwd)).length, 4)
  assert.deepEqual(h.events.map(e => e.kind), Array.from({ length: 4 }, () => ['context_pressure', 'context_compacted']).flat())
  assert.ok(h.events[0].pressure.usedRatio > 1)
  assert.equal(h.events[0].pressure.scope, 'native_context')
  for (const e of h.events.filter(e => e.kind === 'context_compacted')) {
    assert.equal(e.compaction.strategy, 'file_reference')
    assert.equal(e.compaction.droppedEntries, 0)
  }
  assert.doesNotMatch(JSON.stringify(h.events), /content\.pdf|workspace|base64/)
})

test('old nested tool-result media is referenced even below the pressure threshold; active tool pair is preserved', async t => {
  const h = await harness(t)
  const image = Buffer.alloc(300_000, 6)
  const oldCall = assistant([{ type: 'tool_use', id: 'old', name: 'Read', input: { file_path: 'x.png' } }])
  const activeCall = assistant([{ type: 'tool_use', id: 'active', name: 'Read', input: { file_path: 'current.png' } }, { type: 'thinking', thinking: 'signed thought', signature: 'untouched' }])
  const currentResult = user([{ type: 'tool_result', tool_use_id: 'active', content: [media(image, 'image/png')], is_error: false }])
  const raw = JSON.stringify(payload([user('old question'), oldCall, user([{ type: 'tool_result', tool_use_id: 'old', content: [text('caption'), media(image, 'image/png')], is_error: false }]), assistant('done'), user('new question'), activeCall, currentResult]))
  const wire = assertFits(await prepareCcbRequestBody(raw, h.opts))
  assert.deepEqual(wire.messages[1], oldCall)
  assert.equal(wire.messages[2].content[0].tool_use_id, 'old')
  assert.equal(wire.messages[2].content[0].is_error, false)
  assert.equal(wire.messages[2].content[0].content[0].text, 'caption')
  assert.deepEqual(wire.messages.at(-2), activeCall)
  assert.deepEqual(wire.messages.at(-1), currentResult)
  assert.deepEqual(await readFile(paths(wire.messages)[0]), image)
  assert.deepEqual(h.events.map(e => e.kind), ['context_compacted'])
})

test('long text history archives complete turns and preserves the exact active tool chain', async t => {
  const h = await harness(t)
  const history = Array.from({ length: 100 }, (_, i) => [user(`decision${i}:${'中文\n"😀'.repeat(8000)}`), assistant('acknowledged')]).flat()
  const current = [user('continue from the early decisions'), assistant([{ type: 'tool_use', id: 'pending', name: 'Read', input: { file_path: 'current' } }]), user([{ type: 'tool_result', tool_use_id: 'pending', content: 'small current result' }])]
  const wire = assertFits(await prepareCcbRequestBody(JSON.stringify(payload([...history, ...current])), h.opts))
  assert.deepEqual(wire.messages.slice(1), current)
  const file = paths(wire.messages)[0]
  assert.deepEqual((await readFile(file, 'utf8')).split('\n').map(line => JSON.parse(line)), history)
})

test('thousands of small turns remain bounded without dropping original messages', async t => {
  const h = await harness(t)
  const history = Array.from({ length: 1100 }, (_, i) => [user(`remember ${i}`), assistant(`ack ${i}`)]).flat()
  const current = user('recall 0 and 1099')
  const wire = assertFits(await prepareCcbRequestBody(JSON.stringify(payload([...history, current])), h.opts))
  assert.equal(wire.messages.length, 2)
  assert.deepEqual(wire.messages[1], current)
  assert.deepEqual((await readFile(paths(wire.messages)[0], 'utf8')).split('\n').map(line => JSON.parse(line)), history)
})

test('single oversized current PDF and tool output use complete file references', async t => {
  const h = await harness(t)
  const pdf = Buffer.alloc(7 * MIB, 7)
  const rawText = '重要结果\n"\\😀'.repeat(600_000)
  for (const content of [[text('analyze this'), media(pdf, 'application/pdf')], [{ type: 'tool_result', tool_use_id: 'a', content: rawText, is_error: true }]]) {
    const messages = content[0].type === 'tool_result' ? [user('run'), assistant([{ type: 'tool_use', id: 'a', name: 'Bash', input: {} }]), user(content)] : [user(content)]
    const wire = assertFits(await prepareCcbRequestBody(JSON.stringify(payload(messages)), h.opts))
    const file = paths(wire.messages)[0]
    assert.deepEqual(await readFile(file), content[0].type === 'tool_result' ? Buffer.from(rawText) : pdf)
    if (content[0].type === 'tool_result') {
      assert.equal(wire.messages.at(-1).content[0].tool_use_id, 'a')
      assert.equal(wire.messages.at(-1).content[0].is_error, true)
      assert.deepEqual(wire.messages[1], messages[1])
    }
  }
})

test('warning measures final escaped UTF-8 bytes without a false completion', async t => {
  const h = await harness(t)
  const raw = JSON.stringify(payload([user('x'.repeat(7 * MIB))]))
  assert.equal(await prepareCcbRequestBody(raw, h.opts), raw)
  assert.deepEqual(h.events.map(e => e.kind), ['context_pressure'])
  assert.equal(h.events[0].pressure.level, 'warning')
  assert.equal(h.events[0].pressure.usedRatio, Buffer.byteLength(JSON.stringify(JSON.parse(raw).messages)) / CCB_REQUEST_BYTE_LIMITS.messages)
})

test('small request is byte-identical and creates no files', async t => {
  const h = await harness(t)
  const raw = JSON.stringify(payload([user('hello')]), null, 2)
  assert.equal(await prepareCcbRequestBody(raw, h.opts), raw)
  assert.deepEqual(h.events, [])
  assert.deepEqual(await readdir(h.cwd), [])
})

test('all exact Box models and non-message HTTP bypass budget and file IO', async t => {
  const h = await harness(t)
  const rawMessage = user('x'.repeat(9 * MIB))
  for (const model of BOX_MODELS) {
    const raw = JSON.stringify({ ...payload([rawMessage]), model })
    assert.equal((await h.fetch('https://offline.invalid/v1/messages', { method: 'POST', body: raw })).status, 200)
    assert.equal(h.sent.at(-1).body, raw)
  }
  const raw = JSON.stringify(payload([rawMessage]))
  await h.fetch('https://offline.invalid/v1/messages/count_tokens', { method: 'POST', body: raw })
  assert.equal(h.sent.at(-1).body, raw)
  assert.deepEqual(h.events, [])
  assert.deepEqual(await readdir(h.cwd), [])
})

test('unreadable tool-less summary/fixed envelope fails locally with 413 and no success/network call', async t => {
  const h = await harness(t)
  for (const body of [
    { ...payload([user('x'.repeat(9 * MIB))]), tools: [] },
    { ...payload([user('hello')]), system: 's'.repeat(2 * MIB) },
    payload([assistant([{ type: 'tool_use', id: 'huge', name: 'Write', input: { content: 'x'.repeat(9 * MIB) } }])]),
  ]) {
    const response = await h.fetch('https://offline.invalid/v1/messages', { method: 'POST', body: JSON.stringify(body) })
    assert.equal(response.status, 413)
    assert.equal((await response.json()).error.type, 'request_too_large')
  }
  assert.equal(h.sent.length, 0)
  assert.equal(h.events.some(e => e.kind === 'context_compacted'), false)
})

test('abort and file IO failure never send a request or claim successful compaction', async t => {
  const h = await harness(t)
  const controller = new AbortController()
  const raw = JSON.stringify(payload([user([media(Buffer.alloc(7 * MIB, 8), 'application/pdf')])]))
  await assert.rejects(prepareCcbRequestBody(raw, { ...h.opts, signal: controller.signal, onEvent: e => { h.events.push(e); controller.abort() } }), { name: 'AbortError' })
  await assert.rejects(prepareCcbRequestBody(raw, { ...h.opts, cwd: join(h.cwd, 'missing') }), { code: 'ENOENT' })
  assert.equal(h.sent.length, 0)
  assert.equal(h.events.some(e => e.kind === 'context_compacted'), false)
  assert.deepEqual(await readdir(h.cwd), [])
  assert.ok(new RequestBodyBudgetError().message.startsWith('request_too_large'))
})

test('more than 100 small media items retain file references instead of being silently removed', async t => {
  const h = await harness(t)
  const originals = Array.from({ length: 105 }, (_, i) => Buffer.alloc(32, i))
  const raw = JSON.stringify(payload([user(originals.map(b => media(b, 'image/png'))), assistant('seen'), user('continue')]))
  const wire = assertFits(await prepareCcbRequestBody(raw, h.opts))
  assert.equal(wire.messages[0].content.length, 105)
  assert.equal(wire.messages[0].content.filter(b => b.type === 'image').length, 100)
  const files = paths(wire.messages)
  assert.equal(files.length, 5)
  for (let i = 0; i < 5; i++) assert.deepEqual(await readFile(files[i]), originals[i])
})


test('Read-only tools can page lossless references for huge single lines and JSONL messages', async t => {
  const h = await harness(t)
  // Include lone surrogates/CRLF/BOM as well as astral/CJK text: JSON fragments
  // must round-trip even when a UTF-16 pair is split at the chunk boundary.
  const original = '\ufeff' + '中😀\r\n\u0000\ud800'.repeat(900_000)
  for (const messages of [[user('x'.repeat(9 * MIB))], [user(original), assistant('remembered'), user('continue')]]) {
    const wire = assertFits(await prepareCcbRequestBody(JSON.stringify(payload(messages)), h.opts))
    const note = allText(wire.messages).find(v => v.includes('Readable view:'))
    const pageFile = JSON.parse(note.match(/Readable view: ("[^"\n]+")/)[1])
    const expected = messages.length === 1 ? messages[0].content : messages.slice(0, -1).map(m => JSON.stringify(m)).join('\n')
    const lines = (await readFile(pageFile, 'utf8')).split('\n')
    assert.equal(lines.map(line => JSON.parse(line)).join(''), expected)
    assert.ok(lines.every(line => Buffer.byteLength(line) <= 6146))
    for (const offset of [0, Math.floor(lines.length / 2), lines.length - 1]) {
      // Same line-reader used by Read when offset/limit are supplied.
      const page = await readFileInRange(pageFile, offset, 4)
      assert.ok(Buffer.byteLength(page.content) < 25_000)
      assert.equal(page.content, lines.slice(offset, offset + 4).join('\n'))
    }
    assert.match(note, /offset=1, limit=4/)
  }
})
