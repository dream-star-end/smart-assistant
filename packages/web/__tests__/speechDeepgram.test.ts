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
    assert.match(speechJs, /const RECORDER_TIMESLICE_MS = 150/, 'voice recorder timeslice should be tuned for low latency')
    assert.match(speechJs, /recorder\.start\(RECORDER_TIMESLICE_MS\)/, 'MediaRecorder.start must use timeslice for realtime ASR')
  })

  it('waits for queued final audio chunks before sending the stop control frame', () => {
    assert.match(speechJs, /audioChain:\s*Promise\.resolve\(\)/, 'voice run should initialize an ordered audio send chain')
    assert.match(speechJs, /run\.audioChain = \(run\.audioChain \|\| Promise\.resolve\(\)\)\.then\(async \(\) => \{/, 'audio chunks should be serialized')
    assert.match(speechJs, /recorder\.onstop = \(\) => sendStopAfterAudio\(run\)/, 'recorder stop should wait for queued chunks before stop')
    assert.doesNotMatch(speechJs, /recorder\.onstop = \(\) => sendStop\(run\)/, 'stop frame must not race final dataavailable chunks')
    assert.match(speechJs, /if \(!run\.ws \|\| run\.ws\.readyState !== WebSocket\.OPEN\) \{[\s\S]*?cleanupServerVoice\(run\)/, 'stop control must not be marked sent before the voice WS is open')
    assert.match(speechJs, /if \(!run\.ready \|\| !rec\) return cancelServerVoice\('说话时间太短'\)/, 'pre-ready release should cancel instead of starting recording later')
  })

  it('renders hold-to-talk voice mode and wires the voice button through the speech module', () => {
    assert.match(indexHtml, /id="voice-keyboard-btn"/, 'voice mode should include a keyboard return button')
    assert.match(indexHtml, /id="voice-hold-btn"[\s\S]*按住说话/, 'voice mode should include a hold-to-talk button')
    assert.match(indexHtml, /id="voice-overlay"/, 'voice overlay should be present in the shell')
    assert.match(indexHtml, /id="voice-transcript-text"/, 'voice overlay should include transcript text')
    assert.match(indexHtml, /id="voice-waveform"/, 'voice overlay should include waveform feedback')
    assert.match(indexHtml, /id="voice-cancel-btn"/, 'voice overlay should include cancel action')
    assert.match(indexHtml, /id="voice-confirm-btn"/, 'voice overlay should include confirm action')
    assert.match(indexHtml, /上划取消，松开转文字/, 'hold overlay should explain swipe-up cancel and release-to-transcribe')
    assert.doesNotMatch(indexHtml, /voice-mic-dock|voice-text-btn|仅发语音/, 'voice overlay should not expose the unsupported voice-message mode')
    assert.match(mainJs, /import \{ bindVoiceButton, setAutoResize \} from '\.\/speech\.js\?v=/, 'main should delegate voice button wiring to speech.js')
    assert.match(mainJs, /bindVoiceButton\(\$\('voice-btn'\)\)/, 'voice button should use bindVoiceButton')
  })

  it('prewarms microphone in visible voice mode and stops stale streams after cancel', () => {
    assert.match(speechJs, /const PREWARM_IDLE_MS = 20_000/, 'prewarmed mic should have a bounded idle lifetime')
    assert.match(speechJs, /setVoiceMode\(true, '正在打开麦克风…'\)/, 'voice button should enter visible mic prewarm mode')
    assert.match(speechJs, /run\.streamPromise = requestMicStream\(run\)/, 'voice flow should request microphone before waiting for Deepgram ready')
    assert.match(speechJs, /navigator\.mediaDevices\.getUserMedia\(\{ audio: true \}\)/, 'voice flow should use browser microphone permission API')
    assert.match(speechJs, /voiceRun === run && !run\.cleaned && run\.seq === voiceSeq/, 'late microphone stream should be checked against the active run')
    assert.match(speechJs, /stream\.getTracks\(\)\.forEach\(\(t\) => t\.stop\(\)\)/, 'stale microphone streams should be stopped')
    assert.match(speechJs, /if \(document\.hidden && voiceRun\) cleanupServerVoice\(voiceRun\)/, 'page backgrounding should release microphone resources')
  })

  it('uses hold-to-talk controls with swipe-up cancel guards', () => {
    assert.match(speechJs, /hold\?\.addEventListener\('pointerdown'/, 'hold button should start on pointerdown')
    assert.match(speechJs, /hold\?\.addEventListener\('pointermove'/, 'hold button should monitor swipe intent')
    assert.match(speechJs, /hold\?\.addEventListener\('pointerup'/, 'hold button should finish on release')
    assert.match(speechJs, /const SWIPE_CANCEL_PX = 70/, 'swipe-up cancel threshold should be explicit')
    assert.match(speechJs, /dy < -SWIPE_CANCEL_PX/, 'swipe-up should enter cancel intent')
    assert.match(speechJs, /!run\.pressed \|\| run\.cancelIntent \|\| !voiceMode \|\| !run\.ready/, 'late recorder start should require still-pressed active state')
  })

  it('keeps realtime transcript inside the overlay until final polish is applied', () => {
    assert.match(speechJs, /updateVoiceOverlayText\(run, run\.rawText\)/, 'realtime transcript should update the overlay')
    assert.doesNotMatch(speechJs, /applyVoiceText\(run, run\.rawText\)/, 'realtime transcript should not mutate the composer textarea')
    assert.match(speechJs, /msg\.type === 'polish_delta'/, 'context polish should stream visible deltas before final apply')
    assert.doesNotMatch(speechJs, /applyVoiceText\(run, run\.polishedText/, 'polish deltas should not mutate the composer textarea')
    assert.match(speechJs, /const before = run\.initialValue/, 'undo should restore the pre-recording composer text')
    assert.match(speechJs, /el\.value === run\.lastAppliedValue \|\| el\.value === run\.initialValue/, 'final polish should only apply when the input is unchanged')
  })

  it('keeps ESM imports cache-busted', () => {
    const imports = [...speechJs.matchAll(/from '\.\/[^']+\.js(\?v=[^']+)'/g)].map((m) => m[1])
    assert.ok(imports.length > 0, 'expected speech.js imports')
    assert.ok(imports.every((v) => v === '?v=auto' || /^\?v=[A-Za-z0-9_-]+$/.test(v)), 'all imports should include cache-bust query')
  })
})
