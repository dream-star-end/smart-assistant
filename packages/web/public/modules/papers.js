// OpenClaude — ScanSci PDF paper assistant modal
import { $ } from './dom.js?v=auto'
import { state } from './state.js?v=auto'
import { closeModal, openModal, toast } from './ui.js?v=auto'

const DEFAULT_LIMIT = 8

function _val(id) {
  const el = $(id)
  return el && typeof el.value === 'string' ? el.value.trim() : ''
}

function _lines(text) {
  return text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
}

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

function _submitPrompt(prompt) {
  const shouldSend = _setComposerPrompt(prompt)
  closeModal('papers-modal')
  if (shouldSend) {
    toast('已开始论文任务')
    setTimeout(() => $('send')?.click(), 0)
  } else {
    toast('已填入输入框，可检查后发送')
  }
}

function _buildDownloadPrompt() {
  const identifier = _val('papers-download-input')
  if (!identifier) {
    toast('请先输入 DOI、arXiv ID、论文标题或 URL', 'error')
    return ''
  }
  return [
    `请使用 scansci-pdf 帮我下载这篇论文：${identifier}`,
    '',
    '要求：',
    '- 优先开放获取 / OA / 合法来源；必要时再做来源诊断。',
    '- 成功后给出论文标题、来源/状态、PDF 绝对路径。',
    '- 如果能拿到引用信息，请附上 BibTeX。',
  ].join('\n')
}

function _buildSearchPrompt() {
  const query = _val('papers-search-input')
  if (!query) {
    toast('请先输入关键词、主题或作者', 'error')
    return ''
  }
  return [
    `请用 scansci-pdf 搜索论文：${query}`,
    '',
    `返回前 ${DEFAULT_LIMIT} 篇即可，列出题名、年份、作者、DOI/arXiv、开放获取状态。`,
    '先不要批量下载，等我选择要下载哪几篇。',
  ].join('\n')
}

function _buildBatchPrompt() {
  const items = _lines(_val('papers-batch-input'))
  if (items.length === 0) {
    toast('请每行输入一条 DOI、arXiv ID、标题或 URL', 'error')
    return ''
  }
  return [
    '请用 scansci-pdf 批量下载下面这些论文：',
    '',
    ...items.map((x) => `- ${x}`),
    '',
    '要求：每篇给出成功/失败状态、来源、PDF 绝对路径；失败项请给出下一步诊断建议。',
  ].join('\n')
}

function _buildCitationPrompt() {
  const identifier = _val('papers-citation-input')
  const format = _val('papers-citation-format') || 'bibtex'
  if (!identifier) {
    toast('请先输入 DOI、arXiv ID 或论文标题', 'error')
    return ''
  }
  return `请用 scansci-pdf 为这篇论文生成 ${format} 引用：${identifier}`
}

function _buildHealthPrompt() {
  return '请调用 scansci-pdf 做一次健康检查：检查论文下载来源、网络、OpenAlex/Crossref/Unpaywall/Sci-Hub/Tor 可用性，并用中文总结当前哪些通道可用、哪些不可用。'
}

function _buildBrowserPrompt() {
  return [
    '请检查 scansci-pdf 的机构访问 / WebVPN / 隐身浏览器相关能力状态。',
    '',
    '请先调用 health_check、network_diagnose 和 vpnsci_status（如可用），告诉我：',
    '- 当前核心下载/搜索/引用工具是否可用；',
    '- WebVPN/机构登录是否已配置；',
    '- 当前商业版是否已启用交互式远程隐身浏览器 sidecar。',
    '',
    '注意：如果交互式浏览器 sidecar 未启用，不要假装可以代我登录；请给出清晰下一步。',
  ].join('\n')
}

function _promptForAction(action) {
  if (action === 'download') return _buildDownloadPrompt()
  if (action === 'search') return _buildSearchPrompt()
  if (action === 'batch') return _buildBatchPrompt()
  if (action === 'citation') return _buildCitationPrompt()
  if (action === 'health') return _buildHealthPrompt()
  if (action === 'browser') return _buildBrowserPrompt()
  return ''
}

export function openPapersModal() {
  openModal('papers-modal')
  setTimeout(() => $('papers-download-input')?.focus(), 0)
}

export function initPapersAssistant() {
  const modal = $('papers-modal')
  if (!modal || modal.dataset.papersWired === '1') return
  modal.dataset.papersWired = '1'
  modal.addEventListener('click', (e) => {
    const btn = e.target.closest?.('[data-paper-action]')
    if (!btn) return
    const prompt = _promptForAction(btn.dataset.paperAction)
    if (prompt) _submitPrompt(prompt)
  })
}
