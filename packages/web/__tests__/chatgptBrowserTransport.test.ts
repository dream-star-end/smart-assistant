import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

const MAIN = readFileSync(
  resolve(import.meta.dirname, '..', 'public', 'modules', 'main.js'),
  'utf8',
)
const INDEX = readFileSync(resolve(import.meta.dirname, '..', 'public', 'index.html'), 'utf8')
const STYLE = readFileSync(resolve(import.meta.dirname, '..', 'public', 'style.css'), 'utf8')
const SW = readFileSync(resolve(import.meta.dirname, '..', 'public', 'sw.js'), 'utf8')

describe('ChatGPT browser frontend WebRTC/HiDPI behavior', () => {
  it('offers persistent auto/fluent/clear quality modes and a video/canvas fallback stack', () => {
    assert.match(INDEX, /id="chatgpt-browser-quality"/)
    assert.match(INDEX, /option value="auto"/)
    assert.match(INDEX, /option value="fluent"/)
    assert.match(INDEX, /option value="clear"/)
    assert.match(INDEX, /id="chatgpt-browser-video"[^>]*autoplay[^>]*playsinline[^>]*muted/)
    assert.match(MAIN, /openclaude_cgb_quality/)
    assert.match(STYLE, /\.chatgpt-browser-video/)
  })

  it('sends CSS viewport, DPR and mode while keeping pointer mapping transport-agnostic', () => {
    assert.match(MAIN, /devicePixelRatio \|\| 1/)
    assert.match(MAIN, /mode: _cgbQualityMode/)
    assert.match(MAIN, /function _cgbActiveMedia\(\)/)
    assert.match(MAIN, /media\.videoWidth \|\| media\.width/)
  })

  it('uses VP9-first WebRTC, split data channels and activates only after a decoded frame', () => {
    assert.match(MAIN, /\['video\/vp9', 'video\/h264', 'video\/vp8', 'video\/av1'\]/)
    assert.match(MAIN, /event\.channel\.label === 'cgb-fast'/)
    assert.match(MAIN, /event\.channel\.label === 'cgb-control'/)
    assert.match(MAIN, /requestVideoFrameCallback\(\(\) => _cgbActivateRtc\(pc\)\)/)
    assert.match(MAIN, /_cgbSendWs\(\{ t: 'webrtc-active' \}\)/)
    assert.match(MAIN, /_cgbSendWs\(\{ t: 'webrtc-fallback', reason \}\)/)
  })

  it('keeps JPEG fallback and retries WebRTC after visibility/network recovery', () => {
    assert.match(MAIN, /else if \(_cgbModalOpen\(\) && !_cgbRtcActive/)
    assert.match(MAIN, /_cgbScheduleRtcRetry\(\)/)
    assert.match(MAIN, /_cgbSetTransport\('jpeg'\)/)
    assert.match(MAIN, /createImageBitmap\(blob\)/)
    assert.match(MAIN, /isAppleMobile/)
    assert.match(MAIN, /decodeGen !== _cgbDecodeGen/)
    assert.match(MAIN, /_cgbPendingBlob = null/)
  })

  it('cache-busts the changed frontend assets consistently', () => {
    assert.match(INDEX, /\/style\.css\?v=71/)
    assert.match(INDEX, /\/modules\/main\.js\?v=88/)
    assert.match(INDEX, /sw-flush-v29/)
    assert.match(SW, /openclaude-v115/)
    assert.match(SW, /\/style\.css\?v=71/)
    assert.match(SW, /\/modules\/main\.js\?v=88/)
  })
})
