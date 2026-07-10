import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

const SIDECAR = readFileSync(
  resolve(import.meta.dirname, '..', '..', 'scripts', 'chatgpt-browser-sidecar.mjs'),
  'utf8',
)
const SETUP = readFileSync(
  resolve(import.meta.dirname, '..', '..', 'scripts', 'setup-chatgpt-browser-sidecar.sh'),
  'utf8',
)
const SUPERVISOR = readFileSync(
  resolve(import.meta.dirname, '..', 'chatgptBrowserSidecar.ts'),
  'utf8',
)
const SMOKE = readFileSync(
  resolve(import.meta.dirname, '..', '..', 'scripts', 'chatgpt-browser-webrtc-smoke.mjs'),
  'utf8',
)

function extractFunction(source: string, name: string): string {
  const start = source.search(new RegExp(`function\\s+${name}\\s*\\(`))
  if (start < 0) throw new Error(`function ${name} not found`)
  const brace = source.indexOf('{', start)
  let depth = 0
  let quote = ''
  let escaped = false
  for (let i = brace; i < source.length; i++) {
    const ch = source[i]
    if (quote) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) return source.slice(start, i + 1)
  }
  throw new Error(`unterminated function ${name}`)
}

const qualityHelpers = new Function(`
  const QUALITY_MODES = new Set(['auto', 'fluent', 'clear'])
  const MAX_CAPTURE_WIDTH = 3200
  const MAX_CAPTURE_HEIGHT = 3200
  ${extractFunction(SIDECAR, 'num')}
  ${extractFunction(SIDECAR, 'clampNum')}
  ${extractFunction(SIDECAR, 'qualitySettings')}
  return { qualitySettings }
`)() as {
  qualitySettings: (
    mode: string,
    dpr: number,
    rtc: boolean,
    width: number,
    height: number,
  ) => { mode: string; scale: number; quality: number; maxFps: number }
}

describe('ChatGPT browser HiDPI/WebRTC transport', () => {
  it('keeps fluent mode at 1x and raises clear/connected-auto to bounded HiDPI', () => {
    assert.deepEqual(qualityHelpers.qualitySettings('fluent', 3, true, 428, 674), {
      mode: 'fluent',
      dpr: 3,
      scale: 1,
      quality: 60,
      maxFps: 30,
    })
    assert.equal(qualityHelpers.qualitySettings('clear', 3, true, 428, 674).scale, 2)
    assert.equal(qualityHelpers.qualitySettings('clear', 3, true, 428, 674).quality, 82)
    assert.equal(qualityHelpers.qualitySettings('auto', 3, false, 428, 674).scale, 1)
    assert.equal(qualityHelpers.qualitySettings('auto', 3, true, 428, 674).scale, 2)
    assert.ok(qualityHelpers.qualitySettings('clear', 3, true, 2000, 2000).scale <= 1.6)
  })

  it('uses screencast only as dirty trigger and captures the DPR-aware surface', () => {
    assert.match(SIDECAR, /Emulation\.setDeviceMetricsOverride/)
    assert.match(SIDECAR, /deviceScaleFactor:\s*this\.renderScale/)
    assert.match(SIDECAR, /Page\.captureScreenshot/)
    assert.match(SIDECAR, /captureBeyondViewport:\s*false/)
    assert.match(SIDECAR, /this\.captureBusy/)
    assert.match(SIDECAR, /this\.captureDirty/)
    assert.match(SIDECAR, /if \(this\.resizing\) \{/)
    assert.match(SIDECAR, /Never publish e\.data directly/)
    assert.doesNotMatch(SIDECAR, /_publishFrame\(Buffer\.from\(e\.data/)
  })

  it('negotiates VP9-first WebRTC with two scoped input channels and JPEG fallback', () => {
    assert.match(SIDECAR, /new wrtc\.nonstandard\.RTCVideoSource/)
    assert.match(SIDECAR, /\['video\/vp9', 'video\/h264', 'video\/vp8', 'video\/av1'\]/)
    assert.match(
      SIDECAR,
      /createDataChannel\('cgb-fast', \{ ordered: false, maxRetransmits: 0 \}\)/,
    )
    assert.match(SIDECAR, /createDataChannel\('cgb-control'\)/)
    assert.match(SIDECAR, /this\.viewers\.has\(ws\)/)
    assert.match(SIDECAR, /MAX_WEBRTC_PEERS = 2/)
    assert.match(SIDECAR, /webrtc-state', state: 'fallback'/)
    assert.match(SIDECAR, /this\.rtcActiveViewers\.has\(ws\)/)
    assert.match(SIDECAR, /remoteDescriptionSet: false/)
    assert.match(SIDECAR, /pendingRemoteCandidates/)
  })

  it('provisions optional native media dependencies and passes bounded ICE configuration', () => {
    assert.match(SETUP, /@roamhq\/wrtc@0\.10\.0/)
    assert.match(SETUP, /sharp@0\.34\.5/)
    assert.match(SUPERVISOR, /OC_CGB_WEBRTC_ENABLED/)
    assert.match(SUPERVISOR, /OC_CGB_WEBRTC_ICE_SERVERS/)
    assert.match(SUPERVISOR, /OC_CGB_WEBRTC_PORT_MIN/)
    assert.match(SUPERVISOR, /OC_CGB_WEBRTC_PORT_MAX/)
    assert.match(SMOKE, /RTCVideoSink/)
    assert.match(SMOKE, /fallbackJpeg/)
    assert.match(SMOKE, /frame\.width === expectedWidth/)
    assert.match(SMOKE, /OC_CGB_SMOKE_USER must use a disposable smoke-\* identity/)
  })
})
