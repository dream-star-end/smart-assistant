// OpenClaude — Voice input
// Commercial v3 path: browser MediaRecorder → /ws/voice-transcribe → Deepgram Nova-3,
// then DeepSeek V4 Flash context polish after the user stops recording. The Deepgram
// API key never leaves the server. Browser SpeechRecognition remains as fallback.
import { $ } from './dom.js?v=auto'
import { getSession, state } from './state.js?v=auto'
import { toast } from './ui.js?v=auto'

const VOICE_WS_PATH = '/ws/voice-transcribe'
const RECORDER_TIMESLICE_MS = 250
const POLISH_STALE_WINDOW_MS = 60_000
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

function inputEl() { return $('input') }
function voiceBtn() { return $('voice-btn') }

function setVoiceButton(mode) {
  const btn = voiceBtn()
  if (!btn) return
  btn.classList.toggle('recording', mode === 'recording')
  btn.classList.toggle('polishing', mode === 'polishing')
  if (mode === 'recording') {
    btn.title = '停止语音输入'
    btn.setAttribute('aria-label', '停止语音输入')
  } else if (mode === 'polishing') {
    btn.title = '正在根据上下文优化转写'
    btn.setAttribute('aria-label', '正在优化语音转写')
  } else {
    btn.title = '语音输入'
    btn.setAttribute('aria-label', '语音输入')
  }
}

function normalizePrefix(value) {
  if (!value) return ''
  return /[\s\n]$/.test(value) ? value : `${value} `
}

function applyVoiceText(run, text, opts = {}) {
  if (!run || run.seq !== voiceSeq) return false
  if (state.currentSessionId !== run.sessionId) return false
  const el = inputEl()
  const next = normalizePrefix(run.initialValue) + (text || '')
  if (opts.requireUnchanged) {
    const allowed = el.value === run.lastAppliedValue || el.value === run.expectedRawValue
    if (!allowed) return false
  }
  el.value = next
  run.lastAppliedValue = next
  autoResize()
  return true
}

function stopTracks(run) {
  try { run.stream?.getTracks?.().forEach((t) => t.stop()) } catch {}
  run.stream = null
}

function cleanupServerVoice(run) {
  if (!run || run.cleaned) return
  run.cleaned = true
  if (run.readyTimeout) clearTimeout(run.readyTimeout)
  stopTracks(run)
  try { run.ws?.close?.() } catch {}
  if (voiceRun === run) voiceRun = null
  state.recognizing = false
  setVoiceButton('idle')
}

function sendStop(run) {
  if (!run || run.stopSent) return
  run.stopSent = true
  run.polishing = true
  state.recognizing = false
  setVoiceButton('polishing')
  try { run.ws?.send(JSON.stringify({ type: 'stop' })) } catch {}
}

function sendStopAfterAudio(run) {
  if (!run || run.stopSent) return
  void (run.audioChain || Promise.resolve()).then(() => sendStop(run))
}

function stopServerVoice() {
  const run = voiceRun
  if (!run) return false
  if (run.polishing) {
    try { run.ws?.send(JSON.stringify({ type: 'cancel' })) } catch {}
    cleanupServerVoice(run)
    toast('已取消语音优化', 'warn')
    return true
  }
  run.stopping = true
  state.recognizing = false
  setVoiceButton('polishing')
  const rec = run.recorder
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
    toast('浏览器不支持语音识别 (建议 Chrome/Edge)', 'error')
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

async function startRecorderAfterReady(run) {
  if (!run || run.seq !== voiceSeq) return
  let stream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  } catch {
    cleanupServerVoice(run)
    toast('无法访问麦克风，请检查浏览器权限', 'error')
    return
  }
  if (run.seq !== voiceSeq || run.cleaned) {
    try { stream.getTracks().forEach((t) => t.stop()) } catch {}
    return
  }
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
}

function startServerVoice() {
  if (!window.MediaRecorder || !navigator.mediaDevices?.getUserMedia || !window.WebSocket) return false
  if (!state.token) {
    toast('请先登录后再使用语音输入', 'warn')
    return true
  }
  const mimeType = chooseMimeType()
  if (!mimeType) return false

  installUndoShortcut()
  const seq = ++voiceSeq
  const context = collectVoiceContext()
  const keyterms = collectKeyterms(context)
  const sessionId = state.currentSessionId
  const initialValue = inputEl().value
  const url = `${(location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host}${VOICE_WS_PATH}`
  const ws = new WebSocket(url, ['bearer', state.token])
  const run = {
    seq,
    ws,
    recorder: null,
    stream: null,
    mimeType,
    sessionId,
    initialValue,
    rawText: '',
    expectedRawValue: normalizePrefix(initialValue),
    lastAppliedValue: inputEl().value,
    audioChain: Promise.resolve(),
    stopSent: false,
    stopping: false,
    polishing: false,
    cleaned: false,
    ready: false,
    readyTimeout: null,
  }
  voiceRun = run
  state.recognizing = false
  setVoiceButton('polishing')

  run.readyTimeout = setTimeout(() => {
    if (run.ready) return
    cleanupServerVoice(run)
    startLegacySpeech()
  }, 8000)

  ws.onopen = () => {
    try {
      ws.send(JSON.stringify({ type: 'start', mimeType, context, keyterms }))
    } catch {}
  }
  ws.onmessage = (ev) => {
    let msg
    try { msg = JSON.parse(ev.data) } catch { return }
    if (!voiceRun || voiceRun.seq !== seq) return
    if (msg.type === 'ready') {
      run.ready = true
      if (run.readyTimeout) clearTimeout(run.readyTimeout)
      void startRecorderAfterReady(run)
      return
    }
    if (msg.type === 'transcript') {
      const raw = msg.finalText || msg.text || ''
      run.rawText = raw || run.rawText
      run.expectedRawValue = normalizePrefix(run.initialValue) + run.rawText
      if (!run.stopping) applyVoiceText(run, run.rawText)
      return
    }
    if (msg.type === 'stopping' || msg.type === 'polish_start') {
      run.polishing = true
      setVoiceButton('polishing')
      return
    }
    if (msg.type === 'polish') {
      const before = run.expectedRawValue || (normalizePrefix(run.initialValue) + (msg.rawText || run.rawText || ''))
      const polished = msg.text || msg.rawText || run.rawText || ''
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
      if (code === 'VOICE_NOT_CONFIGURED') {
        startLegacySpeech()
      } else {
        toast(msg.message || '语音识别出错', 'error', { code })
      }
    }
  }
  ws.onerror = () => {
    if (!run.ready) {
      cleanupServerVoice(run)
      startLegacySpeech()
    } else {
      cleanupServerVoice(run)
      toast('语音识别连接失败', 'error')
    }
  }
  ws.onclose = () => {
    if (!run.cleaned && !run.ready) {
      cleanupServerVoice(run)
      startLegacySpeech()
    } else if (!run.cleaned && !run.polishing) {
      cleanupServerVoice(run)
    }
  }
  return true
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

export function toggleVoice() {
  if (voiceRun) {
    stopServerVoice()
    return
  }
  if (state.recognizing && legacyRecognition) {
    legacyRecognition.stop()
    return
  }
  if (startServerVoice()) return
  startLegacySpeech()
}
