// Skill marketplace (B2) — vanilla JS, self-contained overlay.
//
// Browser-only feature: browse/search the approved catalog, view a listing's
// FULL SKILL.md + static-scan risk flags, install (explicit confirm), manage
// installed skills, and publish one of your own skills (public-disclosure
// warning). Mirrors skillTrainPanel.js's self-contained-overlay style so it
// touches the big shared modules as little as possible.
//
// Backend (commercial master): GET /api/marketplace/search, GET /api/marketplace/:slug,
// POST /api/marketplace/install, GET /api/marketplace/installed,
// DELETE /api/marketplace/installed/:slug, POST /api/marketplace/publish.

import { apiFetch, apiGet, apiJson, authHeaders } from './api.js?v=4df2bda6'
import { htmlSafeEscape } from './dom.js?v=4df2bda6'
import { confirmDialog, toast } from './ui.js?v=4df2bda6'

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,63}$/
const VERSION_RE = /^\d+\.\d+\.\d+$/

const SEVERITY_LABEL = { high: '高', medium: '中', low: '低' }
const CATEGORY_LABEL = {
  secret: '密钥',
  internal: '内部基建',
  injection: '提示注入',
  html: 'HTML/XSS',
  obfuscation: '混淆字符',
  metadata: '元数据',
  size: '体积',
}

let _overlay = null
let _stylesInjected = false
let _view = 'browse' // browse | installed | detail | publish
let _installedMap = new Map() // slug -> { version, versionId }
let _publishPrefill = null

export function openMarketplace() {
  _ensureStyles()
  _ensureOverlay()
  _overlay.hidden = false
  _renderBrowse()
}

export function openMarketplacePublish(prefill) {
  _publishPrefill = prefill || null
  _ensureStyles()
  _ensureOverlay()
  _overlay.hidden = false
  _renderPublish()
}

function _close() {
  if (_overlay) _overlay.hidden = true
}

function _ensureOverlay() {
  if (_overlay) return
  _overlay = document.createElement('div')
  _overlay.className = 'mkt-backdrop'
  _overlay.hidden = true
  _overlay.innerHTML = `
    <div class="mkt-modal" role="dialog" aria-modal="true" aria-label="技能市场">
      <div class="mkt-head">
        <div class="mkt-tabs">
          <button type="button" class="mkt-tab" data-mkt-tab="browse">市场</button>
          <button type="button" class="mkt-tab" data-mkt-tab="installed">已安装</button>
        </div>
        <button type="button" class="mkt-x" aria-label="关闭">✕</button>
      </div>
      <div class="mkt-body"></div>
    </div>`
  _overlay.addEventListener('click', (e) => {
    if (e.target === _overlay) _close()
  })
  _overlay.querySelector('.mkt-x').addEventListener('click', () => _close())
  for (const btn of _overlay.querySelectorAll('[data-mkt-tab]')) {
    btn.addEventListener('click', () => {
      const t = btn.getAttribute('data-mkt-tab')
      if (t === 'browse') _renderBrowse()
      else _renderInstalled()
    })
  }
  document.body.appendChild(_overlay)
}

function _body() {
  return _overlay.querySelector('.mkt-body')
}

function _setActiveTab(tab) {
  for (const btn of _overlay.querySelectorAll('[data-mkt-tab]')) {
    btn.classList.toggle('active', btn.getAttribute('data-mkt-tab') === tab)
  }
}

async function _refreshInstalledMap() {
  try {
    const { installed } = await apiGet('/api/marketplace/installed')
    _installedMap = new Map(
      (installed || []).map((i) => [i.slug, { version: i.version, versionId: i.versionId }]),
    )
  } catch {
    /* non-fatal — installed badges just won't show */
  }
}

// ── Browse ──────────────────────────────────────────────────────────────────
async function _renderBrowse(q = '') {
  _view = 'browse'
  _setActiveTab('browse')
  _body().innerHTML = `
    <div class="mkt-searchbar">
      <input type="search" class="mkt-search" placeholder="搜索技能(语义检索)…" value="${htmlSafeEscape(q)}" />
    </div>
    <div class="mkt-list mkt-loading">加载中…</div>`
  const input = _body().querySelector('.mkt-search')
  let timer = null
  input.addEventListener('input', () => {
    clearTimeout(timer)
    timer = setTimeout(() => _loadBrowse(input.value.trim()), 300)
  })
  input.focus()
  await _refreshInstalledMap()
  await _loadBrowse(q)
}

async function _loadBrowse(q) {
  const host = _body().querySelector('.mkt-list')
  if (!host) return
  host.classList.add('mkt-loading')
  host.textContent = '加载中…'
  try {
    const data = await apiGet(`/api/marketplace/search?q=${encodeURIComponent(q)}`)
    const results = data.results || []
    host.classList.remove('mkt-loading')
    if (results.length === 0) {
      host.innerHTML = `<div class="mkt-empty">${q ? '没有匹配的技能' : '市场暂无已上架技能'}</div>`
      return
    }
    host.innerHTML = ''
    for (const r of results) host.appendChild(_browseCard(r))
  } catch (err) {
    host.classList.remove('mkt-loading')
    host.innerHTML = `<div class="mkt-empty mkt-err">加载失败:${htmlSafeEscape(String(err))}</div>`
  }
}

function _browseCard(r) {
  const card = document.createElement('button')
  card.type = 'button'
  card.className = 'mkt-card'
  const inst = _installedMap.get(r.slug)
  const badge = inst ? '<span class="mkt-badge mkt-badge-ok">已安装</span>' : ''
  card.innerHTML = `
    <span class="mkt-card-top">
      <strong>${htmlSafeEscape(r.name || r.slug)}</strong>
      ${badge}
    </span>
    <span class="mkt-card-slug">${htmlSafeEscape(r.slug)}</span>
    <span class="mkt-card-desc">${htmlSafeEscape(r.description || '无描述')}</span>
    <span class="mkt-card-tags">${(r.tags || [])
      .slice(0, 5)
      .map((t) => `<span>${htmlSafeEscape(t)}</span>`)
      .join('')}</span>`
  card.addEventListener('click', () => _openDetail(r.slug))
  return card
}

// ── Detail (doubles as the install-confirm surface) ──────────────────────────
async function _openDetail(slug) {
  _view = 'detail'
  _body().innerHTML = '<div class="mkt-list mkt-loading">加载中…</div>'
  let detail
  try {
    const data = await apiGet(`/api/marketplace/${encodeURIComponent(slug)}`)
    detail = data.detail
  } catch (err) {
    _body().innerHTML = `<div class="mkt-empty mkt-err">加载失败:${htmlSafeEscape(String(err))}</div>`
    return
  }
  if (!detail) {
    _body().innerHTML = '<div class="mkt-empty">技能不存在或已下架</div>'
    return
  }
  const inst = _installedMap.get(detail.slug)
  const installedSameVersion = inst && inst.version === detail.version
  const updatable = inst && inst.version !== detail.version

  const flags = detail.riskFlags || []
  const installBtn = installedSameVersion
    ? '<button type="button" class="mkt-btn" disabled>已安装(最新)</button>'
    : `<button type="button" class="mkt-btn mkt-btn-primary mkt-install">${updatable ? '更新到此版本' : '安装'}</button>`

  _body().innerHTML = `
    <div class="mkt-detail">
      <button type="button" class="mkt-link mkt-back">← 返回</button>
      <div class="mkt-detail-head">
        <div>
          <h3>${htmlSafeEscape(detail.name || detail.slug)}</h3>
          <div class="mkt-detail-meta">
            <code>${htmlSafeEscape(detail.slug)}</code> · v${htmlSafeEscape(detail.version)}
            · 已安装 ${detail.installCount} 人
            ${updatable ? `<span class="mkt-badge mkt-badge-upd">可从 v${htmlSafeEscape(inst.version)} 更新</span>` : ''}
          </div>
        </div>
        ${installBtn}
      </div>
      <p class="mkt-detail-desc">${htmlSafeEscape(detail.description || '')}</p>
      <div class="mkt-detail-tags">${(detail.tags || [])
        .map((t) => `<span>${htmlSafeEscape(t)}</span>`)
        .join('')}</div>
      ${_riskFlagsHtml(flags)}
      <div class="mkt-srclabel">安装前请通读完整 SKILL.md(将作为 prompt 在你的会话中对 AI 生效):</div>
      <pre class="mkt-skillmd">${htmlSafeEscape(detail.rawSkillMd || '')}</pre>
    </div>`
  _body()
    .querySelector('.mkt-back')
    .addEventListener('click', () => _renderBrowse())
  const ib = _body().querySelector('.mkt-install')
  if (ib) ib.addEventListener('click', () => _install(detail))
}

function _riskFlagsHtml(flags) {
  if (!flags || flags.length === 0) {
    return '<div class="mkt-flags mkt-flags-clean">✓ 静态安全扫描未发现风险项</div>'
  }
  const rows = flags
    .map((f) => {
      const cls = f.block ? 'mkt-flag-block' : `mkt-flag-${f.severity}`
      const cat = CATEGORY_LABEL[f.category] || f.category
      const sev = SEVERITY_LABEL[f.severity] || f.severity
      const sample = f.sample ? `<code>${htmlSafeEscape(f.sample)}</code>` : ''
      return `<li class="mkt-flag ${cls}">
        <span class="mkt-flag-sev">${htmlSafeEscape(sev)}</span>
        <span class="mkt-flag-cat">${htmlSafeEscape(cat)}</span>
        <span class="mkt-flag-msg">${htmlSafeEscape(f.message)} ${sample}</span>
      </li>`
    })
    .join('')
  return `<div class="mkt-flags">
    <div class="mkt-flags-head">⚠ 安全扫描标记(${flags.length})—— 这些是该技能可能让 AI 执行的敏感行为,安装即表示你已知悉:</div>
    <ul>${rows}</ul>
  </div>`
}

async function _install(detail) {
  const flags = detail.riskFlags || []
  const flagNote =
    flags.length > 0
      ? `\n\n该技能有 ${flags.length} 条安全扫描标记,请确认你已通读上方完整内容。`
      : ''
  const ok = await confirmDialog({
    title: `安装 ${detail.name || detail.slug}?`,
    body: `安装后该技能会在你的下一次会话中对 AI 可用,其 SKILL.md 内容会作为 prompt 生效。${flagNote}`,
    confirmText: '确认安装',
    cancelText: '取消',
    danger: flags.length > 0,
    icon: '📦',
  })
  if (!ok) return
  try {
    const r = await apiJson('POST', '/api/marketplace/install', { versionId: detail.versionId })
    toast(r.note || '已安装', 'success')
    await _refreshInstalledMap()
    _openDetail(detail.slug)
  } catch (err) {
    toast(`安装失败:${String(err)}`, 'error')
  }
}

// ── Installed ────────────────────────────────────────────────────────────────
async function _renderInstalled() {
  _view = 'installed'
  _setActiveTab('installed')
  _body().innerHTML = '<div class="mkt-list mkt-loading">加载中…</div>'
  let installed
  try {
    const data = await apiGet('/api/marketplace/installed')
    installed = data.installed || []
    _installedMap = new Map(
      installed.map((i) => [i.slug, { version: i.version, versionId: i.versionId }]),
    )
  } catch (err) {
    _body().innerHTML = `<div class="mkt-empty mkt-err">加载失败:${htmlSafeEscape(String(err))}</div>`
    return
  }
  if (installed.length === 0) {
    _body().innerHTML = '<div class="mkt-empty">你还没有安装任何市场技能</div>'
    return
  }
  const host = document.createElement('div')
  host.className = 'mkt-list'
  for (const i of installed) {
    const row = document.createElement('div')
    row.className = 'mkt-inst-row'
    const revoked = i.listingState && i.listingState !== 'active'
    row.innerHTML = `
      <div class="mkt-inst-info">
        <strong>${htmlSafeEscape(i.name || i.slug)}</strong>
        <span class="mkt-inst-meta"><code>${htmlSafeEscape(i.slug)}</code> · v${htmlSafeEscape(i.version)}${
          revoked ? ' · <span class="mkt-badge mkt-badge-rev">已被平台下架</span>' : ''
        }</span>
      </div>
      <div class="mkt-inst-actions">
        <button type="button" class="mkt-link mkt-inst-detail">详情</button>
        <button type="button" class="mkt-link mkt-inst-rm">卸载</button>
      </div>`
    row.querySelector('.mkt-inst-detail').addEventListener('click', () => _openDetail(i.slug))
    row.querySelector('.mkt-inst-rm').addEventListener('click', () => _uninstall(i.slug, i.name))
    host.appendChild(row)
  }
  _body().innerHTML = ''
  _body().appendChild(host)
}

async function _uninstall(slug, name) {
  const ok = await confirmDialog({
    title: `卸载 ${name || slug}?`,
    body: '卸载后该技能会在你的下一次会话中从 AI 移除(不影响已发布的市场条目)。',
    confirmText: '卸载',
    danger: true,
  })
  if (!ok) return
  try {
    await apiJson('DELETE', `/api/marketplace/installed/${encodeURIComponent(slug)}`)
    toast('已卸载', 'success')
    await _renderInstalled()
  } catch (err) {
    toast(`卸载失败:${String(err)}`, 'error')
  }
}

// ── Publish ──────────────────────────────────────────────────────────────────
function _renderPublish() {
  _view = 'publish'
  _setActiveTab('')
  const p = _publishPrefill || {}
  const tags = Array.isArray(p.tags) ? p.tags.join(', ') : ''
  _body().innerHTML = `
    <div class="mkt-publish">
      <button type="button" class="mkt-link mkt-back">← 返回市场</button>
      <div class="mkt-disclosure">
        <strong>发布 = 公开披露。</strong>提交后内容将经平台人工审核,通过后<strong>对所有用户可见、可安装</strong>。
        请勿包含任何密钥、个人隐私或内部路径——发布前会做静态安全扫描,命中高危项会被拦截。
      </div>
      <label class="mkt-field">slug(市场唯一标识,小写字母数字连字符,2-64)
        <input type="text" class="mkt-in-slug" value="${htmlSafeEscape(p.slug || '')}" placeholder="例如 pdf-helper" />
      </label>
      <label class="mkt-field">版本(语义化 N.N.N)
        <input type="text" class="mkt-in-version" value="${htmlSafeEscape(p.version || '1.0.0')}" placeholder="1.0.0" />
      </label>
      <label class="mkt-field">展示名
        <input type="text" class="mkt-in-name" value="${htmlSafeEscape(p.name || '')}" placeholder="技能展示名" />
      </label>
      <label class="mkt-field">描述(单行纯文本)
        <input type="text" class="mkt-in-desc" value="${htmlSafeEscape(p.description || '')}" placeholder="一句话说明这个技能做什么" />
      </label>
      <label class="mkt-field">标签(逗号分隔,可选)
        <input type="text" class="mkt-in-tags" value="${htmlSafeEscape(tags)}" placeholder="research, pdf" />
      </label>
      <label class="mkt-field">SKILL.md 正文
        <textarea class="mkt-in-body" rows="12" placeholder="# 标题&#10;&#10;步骤…">${htmlSafeEscape(p.body || '')}</textarea>
      </label>
      <div class="mkt-publish-flags"></div>
      <div class="mkt-actions">
        <button type="button" class="mkt-btn mkt-btn-primary mkt-submit">提交审核</button>
      </div>
    </div>`
  _body()
    .querySelector('.mkt-back')
    .addEventListener('click', () => _renderBrowse())
  _body()
    .querySelector('.mkt-submit')
    .addEventListener('click', () => _submitPublish())
}

async function _submitPublish() {
  const g = (sel) => _body().querySelector(sel)
  const slug = g('.mkt-in-slug').value.trim()
  const version = g('.mkt-in-version').value.trim()
  const name = g('.mkt-in-name').value.trim()
  const description = g('.mkt-in-desc').value.trim()
  const body = g('.mkt-in-body').value
  const tags = g('.mkt-in-tags')
    .value.split(',')
    .map((t) => t.trim())
    .filter(Boolean)

  if (!SLUG_RE.test(slug)) return toast('slug 须为小写字母数字连字符(2-64)', 'error')
  if (!VERSION_RE.test(version)) return toast('版本须为 N.N.N', 'error')
  if (!name) return toast('请填写展示名', 'error')
  if (!description) return toast('请填写描述', 'error')
  if (!body.trim()) return toast('SKILL.md 正文不能为空', 'error')

  const flagsHost = g('.mkt-publish-flags')
  flagsHost.innerHTML = ''
  const btn = g('.mkt-submit')
  btn.disabled = true
  btn.textContent = '提交中…'
  try {
    // Use apiFetch directly: a 422 SCAN_BLOCKED carries riskFlags in the body,
    // which apiJson would discard when it throws on !ok.
    const res = await apiFetch('/api/marketplace/publish', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ slug, version, name, description, tags, body }),
    })
    const data = await res.json().catch(() => ({}))
    if (res.ok) {
      toast(data.note || '已提交审核', 'success')
      if ((data.riskFlags || []).length) flagsHost.innerHTML = _riskFlagsHtml(data.riskFlags)
      else _renderBrowse()
      return
    }
    if (res.status === 422 && data.riskFlags) {
      flagsHost.innerHTML = `<div class="mkt-block-note">发布被静态安全扫描拦截,请修正下列高危项后重试:</div>${_riskFlagsHtml(data.riskFlags)}`
      return
    }
    toast(`发布失败:${data?.error?.message || res.status}`, 'error')
  } catch (err) {
    toast(`发布失败:${String(err)}`, 'error')
  } finally {
    btn.disabled = false
    btn.textContent = '提交审核'
  }
}

function _ensureStyles() {
  if (_stylesInjected) return
  _stylesInjected = true
  const css = `
.mkt-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:1200}
.mkt-modal{background:var(--bg-elevated,#212125);color:var(--text-primary,#eceae6);width:min(820px,95vw);max-height:90vh;border-radius:14px;display:flex;flex-direction:column;box-shadow:0 12px 48px rgba(0,0,0,.45);border:1px solid var(--border,#32323a)}
.mkt-head{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--border,#32323a)}
.mkt-tabs{display:flex;gap:4px}
.mkt-tab{background:none;border:none;color:var(--text-secondary,#9f9c96);font-size:14px;padding:6px 12px;border-radius:8px;cursor:pointer}
.mkt-tab.active{background:var(--bg-tertiary,#2a2a30);color:var(--text-primary,#eceae6)}
.mkt-x{background:none;border:none;color:var(--text-secondary,#9f9c96);font-size:16px;cursor:pointer}
.mkt-x:hover{color:var(--text-primary,#eceae6)}
.mkt-body{padding:16px;overflow:auto;color:var(--text-primary,#eceae6)}
.mkt-searchbar{margin-bottom:12px}
.mkt-search,.mkt-field input,.mkt-field textarea{width:100%;box-sizing:border-box;background:var(--bg-secondary,#2a2a30);color:var(--text-primary,#eceae6);border:1px solid var(--border,#32323a);border-radius:8px;padding:9px 11px;font:inherit}
.mkt-list{display:flex;flex-direction:column;gap:10px}
.mkt-loading,.mkt-empty{color:var(--text-secondary,#9f9c96);text-align:center;padding:24px 0;font-size:13px}
.mkt-err{color:var(--danger,#e06c6c)}
.mkt-card{text-align:left;display:flex;flex-direction:column;gap:5px;background:var(--bg-secondary,#2a2a30);border:1px solid var(--border,#32323a);border-radius:10px;padding:12px;cursor:pointer;color:inherit;font:inherit}
.mkt-card:hover{border-color:var(--accent,#d97757)}
.mkt-card-top{display:flex;align-items:center;gap:8px}
.mkt-card-top strong{font-size:14px}
.mkt-card-slug{font-size:11px;color:var(--text-secondary,#9f9c96);font-family:var(--font-mono,monospace)}
.mkt-card-desc{font-size:13px;color:var(--text-secondary,#9f9c96);line-height:1.5}
.mkt-card-tags,.mkt-detail-tags{display:flex;flex-wrap:wrap;gap:5px}
.mkt-card-tags span,.mkt-detail-tags span{font-size:11px;background:var(--bg-tertiary,#33333b);color:var(--text-secondary,#9f9c96);border-radius:8px;padding:1px 8px}
.mkt-badge{font-size:10px;padding:1px 7px;border-radius:9px;font-weight:600}
.mkt-badge-ok{background:#1f5132;color:#9fe7b8}
.mkt-badge-upd{background:#1f3a63;color:#9fc2ff}
.mkt-badge-rev{background:#5a2530;color:#ffb3bd}
.mkt-link{background:none;border:none;color:var(--accent,#d97757);cursor:pointer;font-size:12px;padding:0}
.mkt-back{margin-bottom:12px}
.mkt-detail-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.mkt-detail-head h3{margin:0 0 4px;font-size:16px}
.mkt-detail-meta{font-size:12px;color:var(--text-secondary,#9f9c96);display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.mkt-detail-desc{font-size:13px;line-height:1.6;color:var(--text-secondary,#9f9c96);margin:10px 0}
.mkt-btn{background:var(--bg-tertiary,#2a2a30);color:var(--text-primary,#eceae6);border:1px solid var(--border,#32323a);border-radius:8px;padding:7px 16px;font-size:13px;cursor:pointer;flex-shrink:0}
.mkt-btn:hover:not(:disabled){filter:brightness(1.08)}
.mkt-btn:disabled{opacity:.5;cursor:default}
.mkt-btn-primary{background:var(--accent,#d97757);border-color:var(--accent,#d97757);color:#fff}
.mkt-flags{margin:14px 0;border:1px solid var(--border,#32323a);border-radius:10px;padding:10px 12px;background:var(--bg-secondary,#26262c)}
.mkt-flags-clean{color:#9fe7b8;font-size:12px}
.mkt-flags-head{font-size:12px;color:var(--text-secondary,#9f9c96);margin-bottom:8px;line-height:1.5}
.mkt-flags ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.mkt-flag{display:flex;gap:8px;align-items:baseline;font-size:12px;line-height:1.5}
.mkt-flag-sev{flex-shrink:0;width:1.6em;text-align:center;border-radius:6px;font-size:10px;padding:1px 0}
.mkt-flag-high .mkt-flag-sev{background:#5a2530;color:#ffb3bd}
.mkt-flag-medium .mkt-flag-sev{background:#5a4a20;color:#ffd98a}
.mkt-flag-low .mkt-flag-sev{background:#2a3a4a;color:#9fc2ff}
.mkt-flag-block{color:#ffb3bd}
.mkt-flag-block .mkt-flag-sev{background:#b3202f;color:#fff}
.mkt-flag-cat{flex-shrink:0;color:var(--text-secondary,#9f9c96)}
.mkt-flag-msg code{font-size:11px;background:var(--bg-tertiary,#33333b);border-radius:4px;padding:0 4px}
.mkt-srclabel{font-size:12px;color:var(--text-secondary,#9f9c96);margin:8px 0 6px}
.mkt-skillmd{font-family:var(--font-mono,ui-monospace,Menlo,Consolas,monospace);font-size:12px;background:var(--bg-secondary,#1e1e22);color:var(--text-primary,#eceae6);border:1px solid var(--border-subtle,#26262c);border-radius:8px;padding:10px;max-height:380px;overflow:auto;white-space:pre-wrap;word-break:break-word;margin:0}
.mkt-inst-row{display:flex;align-items:center;justify-content:space-between;gap:12px;background:var(--bg-secondary,#2a2a30);border:1px solid var(--border,#32323a);border-radius:10px;padding:10px 12px}
.mkt-inst-info strong{font-size:14px}
.mkt-inst-meta{display:block;font-size:11px;color:var(--text-secondary,#9f9c96);margin-top:2px}
.mkt-inst-actions{display:flex;gap:12px;flex-shrink:0}
.mkt-disclosure{font-size:12px;line-height:1.6;color:var(--text-secondary,#9f9c96);background:var(--bg-secondary,#26262c);border:1px solid var(--border,#32323a);border-left:3px solid var(--accent,#d97757);border-radius:8px;padding:10px 12px;margin-bottom:14px}
.mkt-field{display:block;font-size:12px;color:var(--text-secondary,#9f9c96);margin-bottom:12px}
.mkt-field input,.mkt-field textarea{margin-top:6px}
.mkt-actions{display:flex;gap:10px;justify-content:flex-end;margin-top:6px}
.mkt-block-note{color:#ffb3bd;font-size:12px;margin-bottom:8px}
@media (max-width:640px){.mkt-modal{width:100vw;height:100%;max-height:100%;border-radius:0}.mkt-detail-head{flex-direction:column}}`
  const style = document.createElement('style')
  style.id = 'mkt-styles'
  style.textContent = css
  document.head.appendChild(style)
}
