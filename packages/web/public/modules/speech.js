// OpenClaude — Voice input
// Commercial v3 path: browser MediaRecorder → /ws/voice-transcribe → Deepgram Nova-3,
// then DeepSeek V4 Flash context polish after the user stops recording. The Deepgram
// API key never leaves the server. Browser SpeechRecognition remains as fallback.
import { $ } from './dom.js?v=384f7eca'
import { getSession, state } from './state.js?v=384f7eca'
import { toast } from './ui.js?v=384f7eca'

const VOICE_WS_PATH = '/ws/voice-transcribe'
const RECORDER_TIMESLICE_MS = 150
const POLISH_STALE_WINDOW_MS = 60_000
const PREWARM_IDLE_MS = 20_000
const SWIPE_CANCEL_PX = 70
const FIXED_KEYTERMS = [
  'OpenClaude',
  'ClaudeAI.chat',
  'claudeai.chat',
  'Deepgram Nova-3',
  'DeepSeek V4 Flash',
  'deepseek-v4-flash',
  'worktree',
  'DeepScientist',
  'Codex',
]

// autoResize lives in app.js (not yet extracted); injected via setAutoResize()
let autoResize = () => {}
export function setAutoResize(fn) {
  autoResize = fn
}

let legacyRecognition = null
let voiceRun = null
let voiceSeq = 0
let undoSnapshot = null
let undoInstalled = false
let voiceUiBound = false
let voiceMode = false

function inputEl() { return $('input') }
function voiceBtn() { return $('voice-btn') }
function voiceOverlay() { return $('voice-overlay') }
function voiceTranscriptText() { return $('voice-transcript-text') }
function voiceTranscriptDots() { return $('voice-transcript-dots') }
function voiceGestureHint() { return $('voice-gesture-hint') }
function composerRow() { return document.querySelector('.composer-input-row') }
function voiceHoldBtn() { return $('voice-hold-btn') }
function voiceKeyboardBtn() { return $('voice-keyboard-btn') }

function setVoiceButton(mode) {
  const btn = voiceBtn()
  if (!btn) return
  btn.classList.toggle('recording', mode === 'recording')
  btn.classList.toggle('polishing', mode === 'polishing')
  if (mode === 'recording') {
    btn.title = '正在语音输入'
    btn.setAttribute('aria-label', '正在语音输入')
  } else if (mode === 'polishing') {
    btn.title = '语音输入已就绪'
    btn.setAttribute('aria-label', '语音输入已就绪')
  } else {
    btn.title = '语音输入'
    btn.setAttribute('aria-label', '语音输入')
  }
}

function setHoldButton(text = '按住说话', mode = 'idle') {
  const btn = voiceHoldBtn()
  if (!btn) return
  btn.textContent = text
  btn.classList.toggle('is-ready', mode === 'ready')
  btn.classList.toggle('is-pressed', mode === 'pressed')
  btn.classList.toggle('is-cancel', mode === 'cancel')
  btn.classList.toggle('is-warming', mode === 'warming')
  btn.disabled = mode === 'disabled'
}

function setVoiceMode(active, label = '按住说话') {
  voiceMode = active
  composerRow()?.classList.toggle('voice-mode', active)
  if (active) {
    setHoldButton(label, label === '按住说话' || label === '麦克风已就绪' ? 'ready' : 'warming')
    setVoiceButton('polishing')
  } else {
    setHoldButton('按住说话', 'idle')
    setVoiceButton('idle')
  }
}

function setVoiceOverlay(mode, text = '') {
  const overlay = voiceOverlay()
  if (!overlay) return
  const label = voiceTranscriptText()
  const dots = voiceTranscriptDots()
  const hint = voiceGestureHint()
  overlay.hidden = mode === 'hidden'
  overlay.setAttribute('aria-hidden', mode === 'hidden' ? 'true' : 'false')
  overlay.classList.toggle('voice-overlay-cancel', mode === 'cancel')
  overlay.classList.toggle('voice-overlay-polishing', mode === 'polishing')
  overlay.classList.toggle('voice-overlay-recording', mode === 'recording')
  document.body.classList.toggle('voice-overlay-open', mode !== 'hidden')
  if (label) {
    label.textContent = text || (
      mode === 'connecting' ? '正在打开麦克风…'
        : mode === 'polishing' ? '正在根据上下文修正…'
          : mode === 'cancel' ? '松开取消'
            : '正在听…'
    )
  }
  if (dots) dots.hidden = Boolean(text) || mode === 'cancel'
  if (hint) {
    hint.textContent = mode === 'cancel'
      ? '松开取消'
      : mode === 'polishing'
        ? '正在根据上下文修正，完成后自动填入输入框'
        : '上划取消，松开转文字'
  }
}

function updateVoiceOverlayText(run, text) {
  if (!isCurrentRun(run)) return
  const value = String(text || '').trim()
  setVoiceOverlay(run.polishing ? 'polishing' : (run.cancelIntent ? 'cancel' : 'recording'), value || '正在听…')
}

function hideVoiceOverlay() {
  setVoiceOverlay('hidden')
}

function normalizePrefix(value) {
  if (!value) return ''
  return /[\s\n]$/.test(value) ? value : `${value} `
}

function isCurrentRun(run) {
  return Boolean(run && voiceRun === run && !run.cleaned && run.seq === voiceSeq)
}

function applyVoiceText(run, text, opts = {}) {
  if (!isCurrentRun(run)) return false
  if (state.currentSessionId !== run.sessionId) return false
  const el = inputEl()
  const next = normalizePrefix(run.initialValue) + (text || '')
  if (opts.requireUnchanged) {
    const allowed = el.value === run.lastAppliedValue || el.value === run.initialValue
    if (!allowed) return false
  }
  el.value = next
  run.lastAppliedValue = next
  autoResize()
  return true
}

function stopTracks(run) {
  try { run?.stream?.getTracks?.().forEach((t) => t.stop()) } catch {}
  if (run) run.stream = null
}

function clearRunTimers(run) {
  if (run?.readyTimeout) clearTimeout(run.readyTimeout)
  if (run?.idleTimeout) clearTimeout(run.idleTimeout)
  if (run) {
    run.readyTimeout = null
    run.idleTimeout = null
  }
}

function armPrewarmIdle(run) {
  if (!isCurrentRun(run)) return
  if (run.idleTimeout) clearTimeout(run.idleTimeout)
  run.idleTimeout = setTimeout(() => {
    if (!isCurrentRun(run) || run.pressed || run.ws || run.recorder) return
    cleanupServerVoice(run)
  }, PREWARM_IDLE_MS)
}

function requestMicStream(run) {
  return navigator.mediaDevices.getUserMedia({ audio: true })
    .then((stream) => {
      if (!isCurrentRun(run)) {
        try { stream.getTracks().forEach((t) => t.stop()) } catch {}
        return null
      }
      run.stream = stream
      run.micReady = true
      if (voiceMode && !run.pressed) setHoldButton('按住说话', 'ready')
      return stream
    })
    .catch(() => {
      if (isCurrentRun(run)) {
        cleanupServerVoice(run)
        toast('无法访问麦克风，请检查浏览器权限', 'error')
      }
      return null
    })
}

function cleanupServerVoice(run) {
  if (!run || run.cleaned) return
  run.cleaned = true
  clearRunTimers(run)
  try {
    if (run.recorder && run.recorder.state === 'recording') run.recorder.stop()
  } catch {}
  stopTracks(run)
  try { run.ws?.close?.() } catch {}
  if (voiceRun === run) voiceRun = null
  state.recognizing = false
  setVoiceMode(false)
  hideVoiceOverlay()
}

function sendStop(run) {
  if (!isCurrentRun(run) || run.stopSent) return
  if (!run.ws || run.ws.readyState !== WebSocket.OPEN) {
    cleanupServerVoice(run)
    return
  }
  run.stopSent = true
  run.polishing = true
  state.recognizing = false
  setVoiceButton('polishing')
  setHoldButton('正在修正…', 'warming')
  setVoiceOverlay('polishing', run.rawText || '正在根据上下文修正…')
  try { run.ws?.send(JSON.stringify({ type: 'stop' })) } catch {}
}

function sendStopAfterAudio(run) {
  if (!isCurrentRun(run) || run.stopSent) return
  void (run.audioChain || Promise.resolve()).then(() => sendStop(run))
}

function cancelServerVoice(reason = '已取消语音输入') {
  const run = voiceRun
  if (!run) return false
  try { run.ws?.send(JSON.stringify({ type: 'cancel' })) } catch {}
  cleanupServerVoice(run)
  if (reason) toast(reason, 'warn')
  return true
}

function stopServerVoice() {
  const run = voiceRun
  if (!isCurrentRun(run)) return false
  if (run.polishing) return cancelServerVoice('已取消语音优化')
  run.pressed = false
  run.stopping = true
  state.recognizing = false
  setVoiceButton('polishing')
  setHoldButton('正在转文字…', 'warming')
  setVoiceOverlay('polishing', run.rawText || '正在转文字…')
  const rec = run.recorder
  if (!run.ready || !rec) return cancelServerVoice('说话时间太短')
  if (rec && rec.state === 'recording') {
    try { rec.requestData?.() } catch {}
    try { rec.stop() } catch { sendStopAfterAudio(run) }
  } else {
    sendStopAfterAudio(run)
  }
  stopTracks(run)
  return true
}

function chooseMimeType() {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4',
  ]
  if (!window.MediaRecorder) return ''
  for (const t of candidates) {
    try { if (MediaRecorder.isTypeSupported(t)) return t } catch {}
  }
  return ''
}

function extractTextFromMessage(msg) {
  if (!msg || typeof msg !== 'object') return ''
  if (typeof msg.text === 'string') return msg.text
  if (typeof msg.content === 'string') return msg.content
  if (Array.isArray(msg.content)) {
    return msg.content.map((p) => {
      if (!p || typeof p !== 'object') return ''
      return typeof p.text === 'string' ? p.text : ''
    }).filter(Boolean).join('\n')
  }
  return ''
}

function collectVoiceContext() {
  const sess = getSession()
  const messages = Array.isArray(sess?.messages) ? sess.messages : []
  const context = []
  for (const msg of messages.slice(-12)) {
    const role = msg?.role === 'assistant' ? 'assistant' : 'user'
    const text = extractTextFromMessage(msg).replace(/\s+/g, ' ').trim().slice(0, 1000)
    if (text) context.push({ role, text })
  }
  return context
}

function collectKeyterms(context) {
  const terms = new Map()
  const add = (term) => {
    const t = String(term || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
    if (!t || t.length > 80) return
    const key = t.toLowerCase()
    if (!terms.has(key)) terms.set(key, t)
  }
  FIXED_KEYTERMS.forEach(add)
  const text = context.map((m) => m.text).join('\n')
  const patterns = [
    /[A-Za-z][A-Za-z0-9._-]{1,}(?:\s+[A-Za-z0-9._-]{1,}){0,3}/g,
    /[A-Z][A-Z0-9]{1,}(?:-[A-Z0-9]{1,})*/g,
    /[\u4e00-\u9fa5]{2,}(?:[A-Za-z0-9][A-Za-z0-9._-]*)+[\u4e00-\u9fa5A-Za-z0-9._-]*/g,
    /[A-Za-z]+[\u4e00-\u9fa5]+[A-Za-z0-9._-]*/g,
    /(?:GJBZ|GJB|GB|T)\s*[0-9-]{2,}/gi,
  ]
  for (const re of patterns) {
    for (const m of text.matchAll(re)) add(m[0])
  }
  return [...terms.values()].slice(0, 50)
}

function installUndoShortcut() {
  if (undoInstalled) return
  undoInstalled = true
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.key?.toLowerCase() !== 'z') return
    if (!undoSnapshot || Date.now() - undoSnapshot.at > POLISH_STALE_WINDOW_MS) return
    const el = inputEl()
    if (document.activeElement !== el) return
    if (el.value !== undoSnapshot.after) return
    e.preventDefault()
    el.value = undoSnapshot.before
    autoResize()
    undoSnapshot = null
    toast('已撤销语音优化')
  })
}

function startLegacySpeech() {
  if (!legacyRecognition) legacyRecognition = initLegacySpeech()
  if (!legacyRecognition) {
    toast('当前浏览器不支持语音转文字，建议使用最新版 Safari/Chrome/Edge', 'error')
    return false
  }
  state.recognition = legacyRecognition
  try {
    legacyRecognition.start()
    return true
  } catch {
    return true
  }
}

async function maybeStartRecorder(run) {
  if (!isCurrentRun(run) || !run.pressed || run.cancelIntent || !voiceMode || !run.ready) return
  if (run.recorder) return
  const stream = await run.streamPromise
  if (!stream) return
  if (!isCurrentRun(run) || !run.pressed || run.cancelIntent || !voiceMode || !run.ready) return
  run.stream = stream
  let recorder
  try {
    recorder = new MediaRecorder(stream, { mimeType: run.mimeType })
  } catch {
    cleanupServerVoice(run)
    startLegacySpeech()
    return
  }
  run.recorder = recorder
  recorder.ondataavailable = (ev) => {
    if (!ev.data || ev.data.size <= 0) return
    run.audioChain = (run.audioChain || Promise.resolve()).then(async () => {
      const buf = await ev.data.arrayBuffer()
      if (run.ws?.readyState === WebSocket.OPEN && !run.stopSent) run.ws.send(buf)
    }).catch(() => {})
  }
  recorder.onstop = () => sendStopAfterAudio(run)
  try {
    recorder.start(RECORDER_TIMESLICE_MS)
  } catch {
    cleanupServerVoice(run)
    startLegacySpeech()
    return
  }
  state.recognizing = true
  setVoiceButton('recording')
  setHoldButton('松开转文字', 'pressed')
  setVoiceOverlay('recording', run.rawText || '正在听…')
}

function attachVoiceSocket(run) {
  if (!isCurrentRun(run) || run.ws) return
  const url = `${(location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host}${VOICE_WS_PATH}`
  const ws = new WebSocket(url, ['bearer', state.token])
  run.ws = ws
  run.readyTimeout = setTimeout(() => {
    if (!isCurrentRun(run) || run.ready) return
    cleanupServerVoice(run)
    startLegacySpeech()
  }, 8000)

  ws.onopen = () => {
    if (!isCurrentRun(run)) return
    try {
      ws.send(JSON.stringify({ type: 'start', mimeType: run.mimeType, context: run.context, keyterms: run.keyterms }))
    } catch {}
  }
  ws.onmessage = (ev) => {
    let msg
    try { msg = JSON.parse(ev.data) } catch { return }
    if (!isCurrentRun(run)) return
    if (msg.type === 'ready') {
      run.ready = true
      if (run.readyTimeout) clearTimeout(run.readyTimeout)
      run.readyTimeout = null
      void maybeStartRecorder(run)
      return
    }
    if (msg.type === 'transcript') {
      const raw = msg.finalText || msg.text || ''
      run.rawText = raw || run.rawText
      run.expectedRawValue = normalizePrefix(run.initialValue) + run.rawText
      updateVoiceOverlayText(run, run.rawText)
      return
    }
    if (msg.type === 'stopping' || msg.type === 'polish_start') {
      run.polishing = true
      setVoiceButton('polishing')
      setHoldButton('正在修正…', 'warming')
      setVoiceOverlay('polishing', msg.rawText || run.rawText || '正在根据上下文修正…')
      return
    }
    if (msg.type === 'polish_delta') {
      run.polishing = true
      run.polishedText = msg.text || run.polishedText || ''
      setVoiceOverlay('polishing', run.polishedText || '正在根据上下文修正…')
      return
    }
    if (msg.type === 'polish') {
      const before = run.initialValue
      const polished = msg.text || msg.rawText || run.rawText || ''
      if (!String(polished).trim()) {
        toast('未识别到有效语音', 'warn')
        cleanupServerVoice(run)
        return
      }
      const applied = applyVoiceText(run, polished, { requireUnchanged: true })
      if (applied) {
        undoSnapshot = { before, after: inputEl().value, at: Date.now() }
        toast(msg.changed ? '语音转写已根据上下文优化，按 Ctrl/⌘+Z 可撤销' : '语音转写完成')
      } else {
        toast('语音优化完成，但输入框已被修改，未自动覆盖', 'warn')
      }
      cleanupServerVoice(run)
      return
    }
    if (msg.type === 'error') {
      const code = msg.code || ''
      cleanupServerVoice(run)
      if (code === 'VOICE_NOT_CONFIGURED') startLegacySpeech()
      else toast(msg.message || '语音识别出错', 'error', { code })
    }
  }
  ws.onerror = () => {
    if (!isCurrentRun(run)) return
    if (!run.ready) {
      cleanupServerVoice(run)
      startLegacySpeech()
    } else {
      cleanupServerVoice(run)
      toast('语音识别连接失败', 'error')
    }
  }
  ws.onclose = () => {
    if (!isCurrentRun(run)) return
    if (!run.ready) {
      cleanupServerVoice(run)
      startLegacySpeech()
    } else if (!run.polishing) {
      cleanupServerVoice(run)
    } else {
      setTimeout(() => {
        if (!isCurrentRun(run)) return
        cleanupServerVoice(run)
        toast('语音修正连接已断开', 'error')
      }, 1200)
    }
  }
}

function createVoiceRun() {
  installUndoShortcut()
  const seq = ++voiceSeq
  const context = collectVoiceContext()
  const keyterms = collectKeyterms(context)
  const run = {
    seq,
    ws: null,
    recorder: null,
    stream: null,
    streamPromise: null,
    mimeType: chooseMimeType(),
    sessionId: state.currentSessionId,
    initialValue: inputEl().value,
    rawText: '',
    polishedText: '',
    expectedRawValue: normalizePrefix(inputEl().value),
    lastAppliedValue: inputEl().value,
    audioChain: Promise.resolve(),
    stopSent: false,
    stopping: false,
    polishing: false,
    cleaned: false,
    ready: false,
    micReady: false,
    pressed: false,
    cancelIntent: false,
    startY: 0,
    readyTimeout: null,
    idleTimeout: null,
    context,
    keyterms,
  }
  voiceRun = run
  return run
}

function enterVoiceMode() {
  if (!window.MediaRecorder || !navigator.mediaDevices?.getUserMedia || !window.WebSocket) return false
  if (!state.token) {
    toast('请先登录后再使用语音输入', 'warn')
    return true
  }
  const mimeType = chooseMimeType()
  if (!mimeType) return false
  if (voiceRun) cleanupServerVoice(voiceRun)
  const run = createVoiceRun()
  run.mimeType = mimeType
  setVoiceMode(true, '正在打开麦克风…')
  run.streamPromise = requestMicStream(run)
  armPrewarmIdle(run)
  return true
}

function exitVoiceMode() {
  if (voiceRun) cleanupServerVoice(voiceRun)
  else setVoiceMode(false)
}

function startHoldRecording(e) {
  let run = voiceRun
  if (!voiceMode || !isCurrentRun(run)) {
    if (!enterVoiceMode()) {
      startLegacySpeech()
      return
    }
    run = voiceRun
  }
  if (!isCurrentRun(run)) return
  if (run.idleTimeout) clearTimeout(run.idleTimeout)
  run.pressed = true
  run.cancelIntent = false
  run.startY = e.clientY || 0
  setHoldButton('松开转文字', 'pressed')
  setVoiceOverlay('connecting', run.micReady ? '正在连接语音识别…' : '正在打开麦克风…')
  try { voiceHoldBtn()?.setPointerCapture?.(e.pointerId) } catch {}
  attachVoiceSocket(run)
  void maybeStartRecorder(run)
}

function updateHoldCancelIntent(e) {
  const run = voiceRun
  if (!isCurrentRun(run) || !run.pressed) return
  const dy = (e.clientY || 0) - run.startY
  const cancel = dy < -SWIPE_CANCEL_PX
  if (cancel === run.cancelIntent) return
  run.cancelIntent = cancel
  if (cancel) {
    setHoldButton('松开取消', 'cancel')
    setVoiceOverlay('cancel', run.rawText || '松开取消')
  } else {
    setHoldButton('松开转文字', 'pressed')
    setVoiceOverlay(run.polishing ? 'polishing' : 'recording', run.rawText || '正在听…')
  }
}

function finishHoldRecording() {
  const run = voiceRun
  if (!isCurrentRun(run) || !run.pressed) return
  if (run.cancelIntent) {
    run.pressed = false
    cancelServerVoice('已取消语音输入')
    return
  }
  stopServerVoice()
}

function initLegacySpeech() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition
  if (!SR) return null
  const rec = new SR()
  rec.lang = 'zh-CN'
  rec.continuous = true
  rec.interimResults = true
  let finalText = ''
  rec.onstart = () => {
    state.recognizing = true
    setVoiceButton('recording')
    finalText = inputEl().value
    if (finalText && !finalText.endsWith(' ')) finalText += ' '
  }
  rec.onresult = (ev) => {
    let interim = ''
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const txt = ev.results[i][0].transcript
      if (ev.results[i].isFinal) finalText += txt
      else interim += txt
    }
    inputEl().value = finalText + interim
    autoResize()
  }
  rec.onerror = (ev) => {
    toast(`语音识别出错: ${ev.error}`, 'error')
  }
  rec.onend = () => {
    state.recognizing = false
    setVoiceButton('idle')
  }
  return rec
}

export function initSpeech() {
  legacyRecognition = initLegacySpeech()
  return legacyRecognition
}

function bindVoiceUi() {
  if (voiceUiBound) return
  voiceUiBound = true
  voiceKeyboardBtn()?.addEventListener('click', () => exitVoiceMode())
  $('voice-cancel-btn')?.addEventListener('click', () => cancelServerVoice())
  $('voice-confirm-btn')?.addEventListener('click', () => stopServerVoice())
  const hold = voiceHoldBtn()
  hold?.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    startHoldRecording(e)
  })
  hold?.addEventListener('pointermove', (e) => updateHoldCancelIntent(e))
  hold?.addEventListener('pointerup', (e) => {
    e.preventDefault()
    finishHoldRecording()
  })
  hold?.addEventListener('pointercancel', () => cancelServerVoice('已取消语音输入'))
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && voiceRun) cleanupServerVoice(voiceRun)
  })
  window.addEventListener('pagehide', () => {
    if (voiceRun) cleanupServerVoice(voiceRun)
  })
}

export function bindVoiceButton(btn = voiceBtn()) {
  bindVoiceUi()
  if (!btn || btn.dataset.voiceBound === '1') return
  btn.dataset.voiceBound = '1'
  btn.addEventListener('click', () => toggleVoice())
}

export function toggleVoice() {
  bindVoiceUi()
  if (voiceMode || voiceRun) {
    exitVoiceMode()
    return
  }
  if (state.recognizing && legacyRecognition) {
    legacyRecognition.stop()
    return
  }
  if (enterVoiceMode()) return
  startLegacySpeech()
}
