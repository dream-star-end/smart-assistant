import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

const speechJs = readFileSync(resolve(import.meta.dirname, '..', 'public', 'modules', 'speech.js'), 'utf-8')
const mainJs = readFileSync(resolve(import.meta.dirname, '..', 'public', 'modules', 'main.js'), 'utf-8')
const indexHtml = readFileSync(resolve(import.meta.dirname, '..', 'public', 'index.html'), 'utf-8')

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
    assert.match(speechJs, /if \(!run\.ws \|\| run\.ws\.readyState !== WebSocket\.OPEN\) \{[\s\S]*?cleanupServerVoice\(run\)/, 'stop control must not be marked sent before the voice WS is open')
    assert.match(speechJs, /if \(!run\.ready \|\| !rec\) \{[\s\S]*?cancelServerVoice\('已取消语音输入'\)/, 'pre-ready stop should cancel instead of starting recording later')
  })

  it('renders a compact voice overlay and wires the voice button through the speech module', () => {
    assert.match(indexHtml, /id="voice-overlay"/, 'voice overlay should be present in the shell')
    assert.match(indexHtml, /id="voice-transcript-text"/, 'voice overlay should include transcript text')
    assert.match(indexHtml, /id="voice-waveform"/, 'voice overlay should include waveform feedback')
    assert.match(indexHtml, /id="voice-cancel-btn"/, 'voice overlay should include cancel action')
    assert.match(indexHtml, /id="voice-confirm-btn"/, 'voice overlay should include confirm action')
    assert.doesNotMatch(indexHtml, /松开转文字|上滑取消|voice-gesture-hint|voice-mic-dock|voice-text-btn/, 'voice overlay should not expose unsupported hold/swipe controls')
    assert.match(mainJs, /import \{ bindVoiceButton, setAutoResize \} from '\.\/speech\.js\?v=/, 'main should delegate voice button wiring to speech.js')
    assert.match(mainJs, /bindVoiceButton\(\$\('voice-btn'\)\)/, 'voice button should use bindVoiceButton')
  })

  it('requests microphone immediately and stops stale streams after cancel', () => {
    assert.match(speechJs, /run\.streamPromise = requestMicStream\(run\)/, 'voice flow should request microphone before waiting for Deepgram ready')
    assert.match(speechJs, /navigator\.mediaDevices\.getUserMedia\(\{ audio: true \}\)/, 'voice flow should use browser microphone permission API')
    assert.match(speechJs, /voiceRun !== run \|\| run\.cleaned \|\| run\.seq !== voiceSeq/, 'late microphone stream should be checked against the active run')
    assert.match(speechJs, /stream\.getTracks\(\)\.forEach\(\(t\) => t\.stop\(\)\)/, 'stale microphone streams should be stopped')
    assert.match(speechJs, /const stream = await run\.streamPromise/, 'recorder should reuse the early microphone request')
  })

  it('uses simple tap controls without hold-to-record or swipe-cancel gestures', () => {
    assert.doesNotMatch(speechJs, /holdGesture|ignoreNextVoiceClick|pointerdown|pointermove|pointerup|pointercancel/, 'voice button should not use unsupported hold/swipe gestures')
    assert.match(speechJs, /btn\.addEventListener\('click', \(\) => toggleVoice\(\)\)/, 'voice button should use simple click/tap toggle')
  })

  it('keeps realtime transcript inside the overlay until final polish is applied', () => {
    assert.match(speechJs, /updateVoiceOverlayText\(run, run\.rawText\)/, 'realtime transcript should update the overlay')
    assert.doesNotMatch(speechJs, /applyVoiceText\(run, run\.rawText\)/, 'realtime transcript should not mutate the composer textarea')
    assert.match(speechJs, /const before = run\.initialValue/, 'undo should restore the pre-recording composer text')
    assert.match(speechJs, /el\.value === run\.lastAppliedValue \|\| el\.value === run\.initialValue/, 'final polish should only apply when the input is unchanged')
  })

  it('keeps ESM imports cache-busted', () => {
    const imports = [...speechJs.matchAll(/from '\.\/[^']+\.js(\?v=[^']+)'/g)].map((m) => m[1])
    assert.ok(imports.length > 0, 'expected speech.js imports')
    assert.ok(imports.every((v) => v === '?v=auto' || /^\?v=[A-Za-z0-9_-]+$/.test(v)), 'all imports should include cache-bust query')
  })
})
