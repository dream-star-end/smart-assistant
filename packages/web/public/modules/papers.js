// OpenClaude — chat-native ScanSci PDF helpers
import { $ } from './dom.js?v=f082d8ba'
import { state } from './state.js?v=f082d8ba'
import { closeModal, openModal, toast } from './ui.js?v=f082d8ba'

function _hasAttachments() {
  return Array.isArray(state.attachments) && state.attachments.length > 0
}

function _setComposerPrompt(prompt) {
  const ta = $('input')
  if (!ta) return false
  const existing = ta.value.trim()
  ta.value = existing ? `${existing}\n\n${prompt}` : prompt
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  ta.focus()
  ta.setSelectionRange(ta.value.length, ta.value.length)
  return !existing && !_hasAttachments() && !state.sendingInFlight
}

function _submitPrompt(prompt, toastText) {
  const shouldSend = _setComposerPrompt(prompt)
  closeModal('papers-modal')
  if (shouldSend) {
    toast(toastText || '已开始论文任务')
    setTimeout(() => $('send')?.click(), 0)
  } else {
    toast('已填入输入框，可检查后发送')
  }
}

function _identifierFromButton(btn) {
  return (btn.dataset.paperIdentifier || btn.dataset.paperTitle || '').trim()
}

function _buildChatActionPrompt(action, identifier) {
  if (action === 'health') {
    return '请调用 scansci-pdf 做一次论文源健康检查，并用中文总结当前哪些搜索、下载、引用通道可用。'
  }
  if (action === 'browser') {
    return '请检查 scansci-pdf 的机构访问 / WebVPN / 隐身浏览器相关能力状态，并说明当前商业版可用边界。'
  }
  if (!identifier) return ''
  if (action === 'citation') {
    return `请用 scansci-pdf 为这篇论文生成 BibTeX 引用：${identifier}`
  }
  if (action === 'search') {
    return [
      `请用 scansci-pdf 搜索论文：${identifier}`,
      '',
      '先列出候选并说明 DOI/arXiv、年份、作者和开放获取状态，不要擅自批量下载。',
    ].join('\n')
  }
  return [
    `请用 scansci-pdf 下载这篇论文：${identifier}`,
    '',
    '要求：优先开放获取 / OA / 合法来源；成功后给出论文标题、来源/状态、PDF 绝对路径。',
    '如果能拿到引用信息，请附上 BibTeX。',
  ].join('\n')
}

export function openPapersModal() {
  openModal('papers-modal')
}

let _wired = false
export function initPapersAssistant() {
  if (_wired) return
  _wired = true
  document.addEventListener('click', (e) => {
    const btn = e.target.closest?.('[data-paper-chat-action]')
    if (!btn) return
    const prompt = _buildChatActionPrompt(btn.dataset.paperChatAction, _identifierFromButton(btn))
    if (!prompt) {
      toast('这条论文结果缺少可用标识，请直接在聊天里说明要处理哪篇', 'warning')
      return
    }
    _submitPrompt(prompt, '已开始处理这篇论文')
  })
}
