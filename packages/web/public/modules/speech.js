// OpenClaude — Speech Recognition
import { $ } from './dom.js?v=0346148'
import { state } from './state.js?v=0346148'
import { toast } from './ui.js?v=0346148'

// autoResize lives in app.js (not yet extracted); injected via setAutoResize()
let autoResize = () => {}
export function setAutoResize(fn) {
  autoResize = fn
}

export function initSpeech() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition
  if (!SR) return null
  const rec = new SR()
  rec.lang = 'zh-CN'
  rec.continuous = true
  rec.interimResults = true
  let finalText = ''
  rec.onstart = () => {
    state.recognizing = true
    $('voice-btn').classList.add('recording')
    finalText = $('input').value
    if (finalText && !finalText.endsWith(' ')) finalText += ' '
  }
  rec.onresult = (ev) => {
    let interim = ''
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const txt = ev.results[i][0].transcript
      if (ev.results[i].isFinal) finalText += txt
      else interim += txt
    }
    $('input').value = finalText + interim
    autoResize()
  }
  rec.onerror = (ev) => {
    toast(`语音识别出错: ${ev.error}`, 'error')
  }
  rec.onend = () => {
    state.recognizing = false
    $('voice-btn').classList.remove('recording')
  }
  return rec
}
export function toggleVoice() {
  if (!state.recognition) state.recognition = initSpeech()
  if (!state.recognition) {
    toast('浏览器不支持语音识别 (建议 Chrome/Edge)', 'error')
    return
  }
  if (state.recognizing) state.recognition.stop()
  else
    try {
      state.recognition.start()
    } catch {}
}
