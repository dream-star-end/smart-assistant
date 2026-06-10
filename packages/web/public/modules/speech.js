// OpenClaude — Voice input
// Commercial v3 path: browser MediaRecorder → /ws/voice-transcribe → Deepgram Nova-3,
// then DeepSeek V4 Flash context polish after the user stops recording. The Deepgram
// API key never leaves the server. Browser SpeechRecognition remains as fallback.
import { $ } from './dom.js?v=6f1294d3'
import { getSession, state } from './state.js?v=6f1294d3'
import { toast } from './ui.js?v=6f1294d3'

const VOICE_WS_PATH = '/ws/voice-transcribe'
const RECORDER_TIMESLICE_MS = 150
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
let voiceUiBound = false
let voiceMode = false

function inputEl() { return $('input') }
function voiceBtn() { return $('voice-btn') }
function voiceOverlay() { return $('voice-overlay') }
function voiceTranscriptText() { return $('voice-transcript-text') }
function voiceTranscriptDots() { return $('voice-transcript-dots') }
function voiceGestureHint() { return $('voice-gesture-hint') }
function voiceDraftInput() { return $('voice-draft-input') }
function composerRow() { return document.querySelector('.composer-input-row') }
function voiceHoldBtn() { return $('voice-hold-btn') }
function voiceKeyboardBtn() { return $('voice-keyboard-btn') }
function voiceContinueBtn() { return $('voice-continue-btn') }

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

function setVoiceActionState(mode) {
  const cancel = $('voice-cancel-btn')
  const confirm = $('voice-confirm-btn')
  const cont = voiceContinueBtn()
  const confirmLabel = confirm?.querySelector('span')
  const confirmIcon = confirm?.querySelector('svg')
  if (cont) cont.hidden = mode !== 'draft'
  if (confirmLabel) confirmLabel.textContent = mode === 'draft' ? '插入输入框' : '完成转文字'
  if (confirm) {
    confirm.setAttribute('aria-label', mode === 'draft' ? '插入语音文字到输入框' : '完成录音并转为文字')
    confirm.classList.toggle('voice-action-primary', true)
  }
  if (confirmIcon) confirmIcon.setAttribute('aria-hidden', 'true')
  if (cancel) cancel.setAttribute('aria-label', mode === 'draft' ? '取消语音文字' : '取消语音输入')
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
  overlay.classList.toggle('voice-overlay-draft', mode === 'draft')
  document.body.classList.toggle('voice-overlay-open', mode !== 'hidden')
  setVoiceActionState(mode)
  const draft = voiceDraftInput()
  if (draft) draft.hidden = mode !== 'draft'
  if (label) {
    label.textContent = text || (
      mode === 'connecting' ? '正在打开麦克风…'
        : mode === 'polishing' ? '正在根据上下文修正…'
          : mode === 'draft' ? '语音转文字完成'
          : mode === 'cancel' ? '松开取消'
            : '正在听…'
    )
  }
  if (dots) dots.hidden = Boolean(text) || mode === 'cancel' || mode === 'draft'
  if (hint) {
    hint.textContent = mode === 'cancel'
      ? '松开取消'
      : mode === 'polishing'
        ? '正在根据上下文修正…'
        : mode === 'draft'
          ? '可修改文字，继续说会追加到下方草稿'
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

function shouldJoinWithoutSpace(left, right) {
  if (!left || !right) return true
  if (/[\s([{（《「『]$/.test(left)) return true
  if (/^[\s，。！？、,.!?;；:：）)\]》」』]/.test(right)) return true
  return /[\u4e00-\u9fff]$/.test(left) && /^[\u4e00-\u9fff]/.test(right)
}

function mergeVoiceDraft(base, addition) {
  const left = String(base || '').trim()
  const right = String(addition || '').trim()
  if (!left) return right
  if (!right) return left
  return shouldJoinWithoutSpace(left, right) ? `${left}${right}` : `${left} ${right}`
}

function isCurrentRun(run) {
  return Boolean(run && voiceRun === run && !run.cleaned && run.seq === voiceSeq)
}

function currentDraftValue(run) {
  const draft = voiceDraftInput()
  if (draft && !draft.hidden) return draft.value
  return run?.draftText || ''
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
  if (run) {
    run.stream = null
    run.streamPromise = null
    run.micReady = false
  }
}

function clearRunTimers(run) {
  if (run?.readyTimeout) clearTimeout(run.readyTimeout)
  if (run?.idleTimeout) clearTimeout(run.idleTimeout)
  if (run) {
    run.readyTimeout = null
    run.idleTimeout = null
  }
}

function detachVoiceSocket(run) {
  if (!run || run.cleaned) return
  if (run.readyTimeout) clearTimeout(run.readyTimeout)
  run.readyTimeout = null
  const ws = run.ws
  run.ws = null
  run.ready = false
  run.stopSent = false
  run.stopping = false
  try { ws?.close?.() } catch {}
}

function releasePrewarmResources(run) {
  if (!run || run.cleaned) return
  const recorder = run.recorder
  if (recorder) {
    recorder.ondataavailable = null
    recorder.onstop = null
  }
  try {
    if (recorder && recorder.state === 'recording') recorder.stop()
  } catch {}
  run.recorder = null
  stopTracks(run)
  run.micReady = false
  detachVoiceSocket(run)
}

function armPrewarmIdle(run) {
  if (!isCurrentRun(run)) return
  if (run.idleTimeout) clearTimeout(run.idleTimeout)
  run.idleTimeout = setTimeout(() => {
    if (!isCurrentRun(run) || run.pressed || run.recorder || run.polishing) return
    if (run.draftMode) {
      releasePrewarmResources(run)
      return
    }
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

function prepareVoicePrewarm(run, label = '正在打开麦克风…') {
  if (!isCurrentRun(run)) return
  if (!run.streamPromise) {
    run.micReady = false
    run.streamPromise = requestMicStream(run)
  }
  const wsOpenOrConnecting = run.ws && run.ws.readyState < WebSocket.CLOSING
  if (!wsOpenOrConnecting) attachVoiceSocket(run)
  if (voiceMode && !run.pressed && !run.draftMode) setHoldButton(label, run.ready && run.micReady ? 'ready' : 'warming')
  armPrewarmIdle(run)
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
  setVoiceOverlay('polishing', mergeVoiceDraft(run.segmentBase, run.rawText) || '正在根据上下文修正…')
  try { run.ws?.send(JSON.stringify({ type: 'stop' })) } catch {}
}

function sendStopAfterAudio(run) {
  if (!isCurrentRun(run) || run.stopSent) return
  void (run.audioChain || Promise.resolve()).then(() => sendStop(run))
}

function showVoiceDraft(run, text, opts = {}) {
  if (!isCurrentRun(run)) return false
  const value = String(text || '').trim()
  run.draftMode = true
  run.draftText = value
  run.segmentBase = value
  run.rawText = ''
  run.polishedText = ''
  run.pressed = false
  run.cancelIntent = false
  run.stopping = false
  run.polishing = false
  detachVoiceSocket(run)
  state.recognizing = false
  setVoiceButton('polishing')
  setHoldButton('按住说话', 'ready')
  const draft = voiceDraftInput()
  if (draft) {
    draft.value = value
    draft.hidden = false
    setTimeout(() => {
      try {
        draft.focus({ preventScroll: true })
        draft.setSelectionRange(draft.value.length, draft.value.length)
      } catch {}
    }, 0)
  }
  setVoiceOverlay('draft', value)
  if (opts.prewarmNext) {
    run.draftPrewarmPending = false
    setTimeout(() => {
      if (isCurrentRun(run) && run.draftMode) prepareVoicePrewarm(run, '按住继续说')
    }, 0)
  }
  return true
}

function insertVoiceDraft(run) {
  if (!isCurrentRun(run)) return false
  const text = currentDraftValue(run).trim()
  if (!text) {
    toast('没有可插入的语音文字', 'warn')
    return false
  }
  const applied = applyVoiceText(run, text, { requireUnchanged: true })
  if (applied) toast('语音文字已插入输入框')
  else toast('输入框已被修改，未自动覆盖', 'warn')
  cleanupServerVoice(run)
  return applied
}

function cancelCurrentSegment(run, reason = '已取消本段语音') {
  if (!isCurrentRun(run)) return false
  const draft = (run.segmentBase || run.draftText || currentDraftValue(run)).trim()
  if (!draft) return cancelServerVoice(reason)
  try { run.ws?.send(JSON.stringify({ type: 'cancel' })) } catch {}
  releasePrewarmResources(run)
  showVoiceDraft(run, draft)
  if (reason) toast(reason, 'warn')
  return true
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
  setVoiceOverlay('polishing', mergeVoiceDraft(run.segmentBase, run.rawText) || '正在转文字…')
  const rec = run.recorder
  if (!run.ready || !rec) return cancelCurrentSegment(run, '说话时间太短')
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
  setVoiceOverlay('recording', mergeVoiceDraft(run.segmentBase, run.rawText) || '正在听…')
}

function attachVoiceSocket(run) {
  if (!isCurrentRun(run)) return
  if (run.ws && run.ws.readyState < WebSocket.CLOSING) return
  run.ws = null
  run.ready = false
  const url = `${(location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host}${VOICE_WS_PATH}`
  const ws = new WebSocket(url, ['bearer', state.token])
  run.ws = ws
  run.readyTimeout = setTimeout(() => {
    if (!isCurrentRun(run) || run.ready) return
    cleanupServerVoice(run)
    startLegacySpeech()
  }, 8000)

  ws.onopen = () => {
    if (!isCurrentRun(run) || run.ws !== ws) return
    try {
      ws.send(JSON.stringify({ type: 'start', mimeType: run.mimeType, context: run.context, keyterms: run.keyterms }))
    } catch {}
  }
  ws.onmessage = (ev) => {
    let msg
    try { msg = JSON.parse(ev.data) } catch { return }
    if (!isCurrentRun(run)) return
    if (run.ws !== ws) return
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
      updateVoiceOverlayText(run, mergeVoiceDraft(run.segmentBase, run.rawText))
      return
    }
    if (msg.type === 'stopping' || msg.type === 'polish_start') {
      run.polishing = true
      setVoiceButton('polishing')
      setHoldButton('正在修正…', 'warming')
      setVoiceOverlay('polishing', mergeVoiceDraft(run.segmentBase, msg.rawText || run.rawText) || '正在根据上下文修正…')
      return
    }
    if (msg.type === 'polish_delta') {
      run.polishing = true
      run.polishedText = msg.text || run.polishedText || ''
      setVoiceOverlay('polishing', mergeVoiceDraft(run.segmentBase, run.polishedText) || '正在根据上下文修正…')
      return
    }
    if (msg.type === 'polish') {
      const polished = msg.text || msg.rawText || run.rawText || ''
      if (!String(polished).trim()) {
        toast('未识别到有效语音', 'warn')
        if (run.segmentBase || run.draftText) showVoiceDraft(run, run.segmentBase || run.draftText)
        else cleanupServerVoice(run)
        return
      }
      showVoiceDraft(run, mergeVoiceDraft(run.segmentBase, polished), { prewarmNext: true })
      toast(msg.changed ? '语音转写已根据上下文优化，可修改后插入' : '语音转写完成，可修改后插入')
      return
    }
    if (msg.type === 'error') {
      const code = msg.code || ''
      if (code === 'VOICE_NO_AUDIO_TIMEOUT' && !run.pressed) {
        if (run.draftMode) releasePrewarmResources(run)
        else cleanupServerVoice(run)
        return
      }
      if (run.segmentBase || run.draftText) {
        cancelCurrentSegment(run, msg.message || '本段语音识别失败')
      } else {
        cleanupServerVoice(run)
        if (code === 'VOICE_NOT_CONFIGURED') startLegacySpeech()
        else toast(msg.message || '语音识别出错', 'error', { code })
      }
    }
  }
  ws.onerror = () => {
    if (!isCurrentRun(run)) return
    if (run.ws !== ws) return
    if (run.segmentBase || run.draftText) {
      cancelCurrentSegment(run, '本段语音识别连接失败')
      return
    }
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
    if (run.ws !== ws) return
    run.ws = null
    if (run.draftMode) {
      run.ready = false
      run.stopSent = false
      run.stopping = false
      if (run.draftPrewarmPending) {
        run.draftPrewarmPending = false
        prepareVoicePrewarm(run, '按住继续说')
      }
      return
    }
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
    draftText: '',
    draftMode: false,
    segmentBase: '',
    draftPrewarmPending: false,
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
  prepareVoicePrewarm(run, '正在打开麦克风…')
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
  if (run.draftMode) {
    const draft = currentDraftValue(run).trim()
    run.draftText = draft
    run.segmentBase = draft
    run.draftMode = false
    run.draftPrewarmPending = false
    run.rawText = ''
    run.polishedText = ''
    run.stopSent = false
    run.stopping = false
    run.polishing = false
    run.recorder = null
    setVoiceOverlay('connecting', draft || '正在准备继续说…')
  }
  run.pressed = true
  run.cancelIntent = false
  run.startY = e.clientY || 0
  setHoldButton('松开转文字', 'pressed')
  setVoiceOverlay('connecting', run.micReady && run.ready ? (run.segmentBase || '正在听…') : (run.micReady ? '正在连接语音识别…' : '正在打开麦克风…'))
  try { e.currentTarget?.setPointerCapture?.(e.pointerId) } catch {}
  prepareVoicePrewarm(run, '正在连接语音识别…')
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
    setVoiceOverlay('cancel', mergeVoiceDraft(run.segmentBase, run.rawText) || '松开取消')
  } else {
    setHoldButton('松开转文字', 'pressed')
    setVoiceOverlay(run.polishing ? 'polishing' : 'recording', mergeVoiceDraft(run.segmentBase, run.rawText) || '正在听…')
  }
}

function finishHoldRecording() {
  const run = voiceRun
  if (!isCurrentRun(run) || !run.pressed) return
  if (run.cancelIntent) {
    run.pressed = false
    cancelCurrentSegment(run, run.segmentBase || run.draftText ? '已取消本段语音' : '已取消语音输入')
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
  $('voice-confirm-btn')?.addEventListener('click', () => {
    const run = voiceRun
    if (run?.draftMode) insertVoiceDraft(run)
    else stopServerVoice()
  })
  const bindHoldTarget = (target) => {
    if (!target) return
    target.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      startHoldRecording(e)
    })
    target.addEventListener('pointermove', (e) => updateHoldCancelIntent(e))
    target.addEventListener('pointerup', (e) => {
      e.preventDefault()
      finishHoldRecording()
    })
    target.addEventListener('pointercancel', () => {
      const run = voiceRun
      if (run?.segmentBase || run?.draftText) cancelCurrentSegment(run, '已取消本段语音')
      else cancelServerVoice('已取消语音输入')
    })
    for (const evt of ['contextmenu', 'selectstart', 'dragstart']) {
      target.addEventListener(evt, (e) => e.preventDefault())
    }
  }
  const hold = voiceHoldBtn()
  bindHoldTarget(hold)
  bindHoldTarget(voiceContinueBtn())
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
