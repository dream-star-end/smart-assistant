import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

const speechJs = readFileSync(resolve(import.meta.dirname, '..', 'public', 'modules', 'speech.js'), 'utf-8')

describe('commercial voice input', () => {
  it('uses the commercial voice proxy instead of exposing Deepgram credentials in browser code', () => {
    assert.match(speechJs, /\/ws\/voice-transcribe/, 'speech.js should connect to the commercial voice WS')
    assert.doesNotMatch(speechJs, /api\.deepgram\.com/, 'browser must not connect to Deepgram directly')
    assert.doesNotMatch(speechJs, /DEEPGRAM_API_KEY|Authorization:\s*`?Token/i, 'browser must not contain Deepgram auth material')
  })

  it('authenticates the voice websocket with bearer subprotocol and not query token', () => {
    assert.match(speechJs, /new WebSocket\(url, \['bearer', state\.token\]\)/, 'voice WS should use Sec-WebSocket-Protocol bearer')
    assert.doesNotMatch(speechJs, /[?&]token=/, 'voice WS must not put access token in URL')
  })

  it('streams MediaRecorder chunks with an explicit low-latency timeslice', () => {
    assert.match(speechJs, /const RECORDER_TIMESLICE_MS = 250/, 'voice recorder timeslice should be explicit')
    assert.match(speechJs, /recorder\.start\(RECORDER_TIMESLICE_MS\)/, 'MediaRecorder.start must use timeslice for realtime ASR')
  })

  it('waits for queued final audio chunks before sending the stop control frame', () => {
    assert.match(speechJs, /audioChain:\s*Promise\.resolve\(\)/, 'voice run should initialize an ordered audio send chain')
    assert.match(speechJs, /run\.audioChain = \(run\.audioChain \|\| Promise\.resolve\(\)\)\.then\(async \(\) => \{/, 'audio chunks should be serialized')
    assert.match(speechJs, /recorder\.onstop = \(\) => sendStopAfterAudio\(run\)/, 'recorder stop should wait for queued chunks before stop')
    assert.doesNotMatch(speechJs, /recorder\.onstop = \(\) => sendStop\(run\)/, 'stop frame must not race final dataavailable chunks')
  })

  it('keeps ESM imports cache-busted', () => {
    const imports = [...speechJs.matchAll(/from '\.\/[^']+\.js(\?v=[^']+)'/g)].map((m) => m[1])
    assert.ok(imports.length > 0, 'expected speech.js imports')
    assert.ok(imports.every((v) => v === '?v=auto' || /^\?v=[A-Za-z0-9_-]+$/.test(v)), 'all imports should include cache-bust query')
  })
})
