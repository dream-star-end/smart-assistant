// Browser live-preview panel.
// Renders a fixed-position iframe on the right side that embeds the self-hosted
// Steel browser UI. Steel runs at 127.0.0.1:5173 on the server, exposed via a
// cloudflared quick tunnel (URL changes on each tunnel restart) with nginx
// basic auth in front. The URL is fetched from GET /api/browser/iframe-url.
//
// The iframe loads a cross-origin page (trycloudflare.com), so the first
// request will prompt the user for basic-auth credentials in the native
// browser dialog. Credentials are cached by the browser for the session.

import { apiGet } from './api.js'

let panelEl = null
let iframeEl = null
let statusEl = null
let toggleBtn = null
// Monotonic load token: bumps on every loadUrl() call. Lets in-flight
// requests / iframe events detect they've been superseded and bail out.
let loadToken = 0

/** Build DOM on first use and append to document.body. */
function ensurePanel() {
  if (panelEl) return panelEl
  panelEl = document.createElement('aside')
  panelEl.id = 'browser-panel'
  panelEl.className = 'browser-panel'
  panelEl.hidden = true
  panelEl.innerHTML = `
    <div class="browser-panel-head">
      <span class="browser-panel-title">浏览器预览 <span class="browser-panel-hint">Steel · 实时</span></span>
      <button type="button" class="icon-btn browser-panel-reload" title="刷新" aria-label="刷新">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
      </button>
      <button type="button" class="icon-btn browser-panel-close" title="关闭" aria-label="关闭">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
    <div class="browser-panel-body">
      <div class="browser-panel-status" role="status"></div>
      <iframe class="browser-panel-iframe" title="Steel browser preview" referrerpolicy="no-referrer"
              sandbox="allow-scripts allow-forms allow-popups allow-same-origin"
              hidden></iframe>
    </div>
  `
  document.body.appendChild(panelEl)
  iframeEl = panelEl.querySelector('.browser-panel-iframe')
  statusEl = panelEl.querySelector('.browser-panel-status')
  panelEl.querySelector('.browser-panel-close').addEventListener('click', hide)
  panelEl.querySelector('.browser-panel-reload').addEventListener('click', () => {
    loadUrl().catch((e) => setStatus(`加载失败: ${e.message || e}`, 'error'))
  })
  // iframe.load fires both on successful nav and on error pages (the browser
  // navigates to the tunnel's 401/502 response). We can't read the response
  // status from a cross-origin iframe, so just clear the "首次加载..." hint
  // on first successful-ish load. Every src assignment stamps the iframe's
  // dataset.loadToken; late-arriving events from a superseded navigation
  // compare mismatched tokens and bail before touching DOM.
  iframeEl.addEventListener('load', () => {
    if (!statusEl) return
    if (Number(iframeEl.dataset.loadToken) !== loadToken) return
    // Only clear "info" hints (the basic-auth note). Keep errors.
    if (statusEl.dataset.kind === 'info') setStatus('', 'info')
  })
  // Note: `error` on cross-origin iframes almost never fires (browser navigates
  // to an error document instead of raising). We rely on the user seeing a
  // blank/error page and clicking reload. Keep the handler anyway so the
  // panel stays responsive if the sandbox blocks navigation entirely.
  iframeEl.addEventListener('error', () => {
    if (Number(iframeEl.dataset.loadToken) !== loadToken) return
    setStatus('iframe 加载失败,请点击刷新重试。', 'error')
  })
  return panelEl
}

function setStatus(text, kind = 'info') {
  if (!statusEl) return
  statusEl.textContent = text || ''
  statusEl.dataset.kind = kind
  statusEl.hidden = !text
}

async function loadUrl() {
  // Bump token: any prior in-flight request will see `myToken !== loadToken`
  // on return and skip DOM mutations. This also guards against a slow request
  // completing after the user has closed + reopened the panel.
  const myToken = ++loadToken
  setStatus('获取 tunnel URL…', 'info')
  iframeEl.hidden = true
  iframeEl.dataset.loadToken = String(myToken)
  iframeEl.src = 'about:blank'
  let data
  try {
    data = await apiGet('/api/browser/iframe-url')
  } catch (e) {
    if (myToken !== loadToken) return
    setStatus(`服务端不可达: ${e.message || e}`, 'error')
    return
  }
  if (myToken !== loadToken) return
  if (!data?.ok) {
    const reason = data?.reason || 'unknown'
    setStatus(
      reason === 'not_ready'
        ? 'Tunnel 尚未就绪,稍后重试'
        : reason === 'not_configured'
        ? 'Steel tunnel 未配置 (检查 steel-tunnel.service)'
        : `未就绪 (${reason})`,
      'error',
    )
    return
  }
  setStatus('首次加载会弹出 basic auth 登录框,输入后面板内即实时看到 AI 操作的浏览器。', 'info')
  iframeEl.hidden = false
  iframeEl.dataset.loadToken = String(myToken)
  iframeEl.src = data.url + '/'
}

function show() {
  ensurePanel()
  panelEl.hidden = false
  document.body.classList.add('has-browser-panel')
  toggleBtn?.classList.add('active')
  // Always refetch on show(): the tunnel URL rotates on every cloudflared
  // restart, so a cached URL is likely stale after any gap since last open.
  loadUrl().catch((e) => setStatus(`加载失败: ${e.message || e}`, 'error'))
}

function hide() {
  if (!panelEl) return
  panelEl.hidden = true
  document.body.classList.remove('has-browser-panel')
  toggleBtn?.classList.remove('active')
  // Drop the iframe reference so the cross-origin connection is torn down;
  // reopening will trigger a fresh loadUrl() and fresh iframe navigation.
  // Bump token first so the about:blank navigation's own load event is
  // treated as stale and cannot mutate status.
  loadToken++
  iframeEl.dataset.loadToken = String(loadToken)
  iframeEl.src = 'about:blank'
  iframeEl.hidden = true
}

function toggle() {
  if (!panelEl || panelEl.hidden) show()
  else hide()
}

/**
 * Wire a header-button toggle. Call once from main.js after DOM is ready.
 */
export function initBrowserPanel() {
  toggleBtn = document.getElementById('browser-panel-btn')
  if (!toggleBtn) return
  toggleBtn.addEventListener('click', toggle)
}

export const _testing = { toggle, show, hide, loadUrl }
