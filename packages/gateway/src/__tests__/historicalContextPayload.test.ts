import assert from 'node:assert/strict'
import test from 'node:test'
import { buildHistoricalContextPayload } from '../historicalContextPayload.js'
import { shouldAttemptHistoricalContextInjection } from '../sessionManager.js'

const input = [
  { type: 'text', text: 'CURRENT_IMAGE_QUESTION' },
  { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
  { type: 'text', text: 'SECOND_DETAIL' },
]
const history = [
  { role: 'user', text: 'remember teal comet' },
  { role: 'assistant', text: 'saved teal comet' },
  { role: 'tool', toolName: 'Bash', inputJson: { command: 'pwd' }, output: '/work/answer' },
  { role: 'user', text: 'CURRENT_IMAGE_QUESTION\nSECOND_DETAIL', status: 'sending' },
]

test('multimodal switch replays semantic history and preserves every current block in order', () => {
  assert.equal(shouldAttemptHistoricalContextInjection({ channel: 'webchat', userTextOrBlocks: input }), true)
  const result = buildHistoricalContextPayload(history, input)
  assert.ok(Array.isArray(result))
  assert.deepEqual(result.slice(1), input)
  assert.equal(result[2], input[1], 'the original image is kept, not reconstructed')
  assert.match(String(result[0]?.text), /saved teal comet/)
  assert.match(String(result[0]?.text), /Tool record:.*\/work\/answer/)
  assert.doesNotMatch(String(result[0]?.text), /CURRENT_IMAGE_QUESTION|SECOND_DETAIL/)
  assert.ok(result.every((block) => block.type === 'text' || block.type === 'image'))
})

test('bounded history never truncates the current image or emits a false successful rebuild', () => {
  assert.equal(buildHistoricalContextPayload(history, input, 30), null)
  const result = buildHistoricalContextPayload(history, input, 4_000)
  assert.ok(Array.isArray(result))
  assert.ok(Buffer.byteLength(String(result[0]?.text)) + Buffer.byteLength(JSON.stringify(input)) < 4_000)
  assert.equal(buildHistoricalContextPayload([history[3]], input), null)
  assert.deepEqual(input[1]?.source, { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' })
})
