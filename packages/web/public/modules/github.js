// OpenClaude — Phase 6 GitHub 仓库绑定
//
// 数据流契约(后端 PASS 后冻结):
//  1. 用户在 modal 选 repo+branch → PUT /api/me/sessions/:sid/github-selection
//     {owner,repo,branch} → 后端 upsert + bump selection_version + 校验 push 权限
//     → 200 with { selected:true, selection_version, status:'pending', ... }
//  2. 前端拿到 selection_version → 通过 WS 发 inbound.control.session_repo_bind
//     {sessionId, selectionVersion, peer:{id:sessionId,kind:'dm'}, agentId, channel}
//     不带 token / owner / repo —— bridge 从 DB enrich。
//  3. 容器 → bridge → userWs 推 outbound.control.session_repo_status 多次:
//     pending → cloning → ready / failed。
//  4. 解绑:DELETE /api/me/sessions/:sid/github-selection 然后 WS 发
//     inbound.control.session_repo_unbind {sessionId, selectionVersion}。
//  5. 重连:bridge 自动按 DB active selections 重发 enriched bind,前端不重发。
//
// 错误帧 outbound.control.session_repo_bind_error 任意时刻可能来,
// 翻译表见 GITHUB_ERROR_TEXT。
import { apiGet, apiJson } from './api.js?v=47a41001'
import { $, htmlSafeEscape } from './dom.js?v=47a41001'
import { getSession, state } from './state.js?v=47a41001'
import { closeModal, openModal, toast, toastOptsFromError } from './ui.js?v=47a41001'
import { sendRepoBindFrame, sendRepoUnbindFrame } from './websocket.js?v=47a41001'

// ── Pure helpers (testable) ───────────────────────────────────────

/**
 * 把后端 / WS error code 翻译成中文 toast 文案。漏译 → 显示 code 本身,
 * 不抛错,保证 UX 不挂。
 */
export function githubErrorText(code) {
  const dict = {
    GITHUB_NOT_LINKED: '请先连接 GitHub 账号',
    GITHUB_TOKEN_INVALID: 'GitHub token 已失效,已自动解绑,请重新连接',
    GITHUB_REPO_NOT_FOUND: '仓库不存在或无访问权限',
    GITHUB_BRANCH_NOT_FOUND: '分支不存在',
    GITHUB_REPO_NO_WRITE: '你对该仓库没有写权限',
    GITHUB_UPSTREAM_FORBIDDEN: 'GitHub 拒绝请求(限流或 SSO 授权问题)',
    GITHUB_NETWORK: 'GitHub 网络错误,稍后重试',
    GITHUB_TOKEN_REVOKE_FAILED: '解绑失败,请稍后重试',
    STALE_OR_MISSING: '仓库选择已变更,请重新选择',
    INVALID_BIND_PAYLOAD: '请求格式异常,请重新选择仓库',
    INVALID_REF: '仓库名 / 分支名包含非法字符',
    INVALID_SESSION_ID: '会话 ID 异常',
    INVALID_VERSION: '版本号异常',
    token_invalid: 'GitHub token 已失效,会话已自动解绑',
    token_write_failed: '写入凭证失败,请重试',
  }
  return dict[code] || code || '未知错误'
}

/**
 * 把 selection 状态翻译成 pill label + dot state。
 * - 未绑定 → "仓库" + state none
 * - cloning → "octo/demo @ main · 克隆中" + state cloning
 * - ready → "octo/demo @ main" + state ready
 * - failed → "octo/demo @ main · 失败" + state failed
 * - pending → "octo/demo @ main · 准备中" + state pending
 */
export function formatRepoLabel(sel) {
  if (!sel || !sel.selected) return { label: '仓库', dot: 'none' }
  const base = `${sel.owner}/${sel.repo} @ ${sel.branch}`
  switch (sel.status) {
    case 'ready':   return { label: base, dot: 'ready' }
    case 'cloning': return { label: `${base} · 克隆中`, dot: 'cloning' }
    case 'failed':  return { label: `${base} · 失败`, dot: 'failed' }
    case 'pending':
    default:        return { label: `${base} · 准备中`, dot: 'pending' }
  }
}

// ── Module-private state ──────────────────────────────────────────
let _currentSid = null            // modal 当前操作的 sessionId
let _selectedRepo = null          // {owner, repo, default_branch} — modal 内已选仓库
let _selectedBranch = null        // 已选分支名
let _existingSelection = null     // 当前 session 的现有 selection(决定是否显示解绑按钮)
let _allRepos = []                // 拉到的全部 repos(模糊搜索源)

// ── Per-session selection_version cache(版本权威跟随后端) ───────
// 用途:过滤过期 outbound.control.session_repo_status / _bind_error 帧。
// 写入路径:GET / PUT(本地 confirm)/ DELETE(本地 unbind 升到 +Infinity 标记
// 已清空)/ 收到的 status 帧带 ≥ 已知版本。读取路径:status / error 帧的
// version-gate。Map 键 = sessionId, 值 = number(普通版本)或 +Infinity(已 unbind 哨兵)。
const _knownVersion = new Map()

/** 内部:取已知版本,未知返回 -1(任何 ≥0 的来帧都视为新)。 */
function _getKnownVersion(sid) {
  return _knownVersion.has(sid) ? _knownVersion.get(sid) : -1
}

/** 内部:把已知版本提升到 max(known, ver)。 */
function _bumpKnownVersion(sid, ver) {
  if (typeof ver !== 'number' || !Number.isFinite(ver)) return
  const cur = _getKnownVersion(sid)
  if (cur === Number.POSITIVE_INFINITY) return // 已 unbind 哨兵不被普通版本回退
  if (ver > cur) _knownVersion.set(sid, ver)
}

// ── Modal 入口 ────────────────────────────────────────────────────

export async function openGithubModal(sessionId) {
  _currentSid = sessionId || getSession()?.id
  if (!_currentSid) {
    toast('请先选择会话', 'error')
    return
  }
  _selectedRepo = null
  _selectedBranch = null
  _allRepos = []
  $('github-confirm-btn').disabled = true
  $('github-modal-body').hidden = true
  $('github-unbind-btn').hidden = true
  $('github-account-bar').innerHTML =
    '<p style="color:var(--fg-muted);font-size:var(--text-sm);margin:0">加载中…</p>'
  openModal('github-modal')

  // 并行拉账号状态 + 当前 session selection
  let link, sel
  try {
    ;[link, sel] = await Promise.all([
      apiGet('/api/me/github').catch((err) => {
        // 404 = 未连接,正常路径
        if (err && err.status === 404) return null
        throw err
      }),
      apiGet(`/api/me/sessions/${encodeURIComponent(_currentSid)}/github-selection`),
    ])
  } catch (err) {
    $('github-account-bar').innerHTML =
      `<p style="color:var(--danger);font-size:var(--text-sm);margin:0">加载失败:${htmlSafeEscape(String(err?.message || err))}</p>`
    return
  }

  _existingSelection = sel && sel.selected ? sel : null
  if (_existingSelection && typeof _existingSelection.selection_version === 'number') {
    // GET 是后端权威 —— 直接 set 覆盖任何本地 +Infinity 哨兵(允许 unbind→reopen 流程)。
    _knownVersion.set(_currentSid, _existingSelection.selection_version)
  }
  renderAccountBar(link)

  if (link && link.login) {
    $('github-modal-body').hidden = false
    if (_existingSelection) $('github-unbind-btn').hidden = false
    await loadRepos()
  }
}

function renderAccountBar(link) {
  const bar = $('github-account-bar')
  if (!link || !link.login) {
    bar.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px">
        <span style="color:var(--fg-muted);font-size:var(--text-sm)">尚未连接 GitHub 账号。</span>
        <button id="github-link-btn" class="btn btn-primary" style="padding:6px 14px;min-height:36px;font-size:var(--text-sm)">连接 GitHub</button>
      </div>`
    $('github-link-btn').onclick = () => linkGithub()
    return
  }
  const avatar = link.avatar_url
    ? `<img src="${htmlSafeEscape(link.avatar_url)}" alt="" width="22" height="22" style="border-radius:50%" />`
    : ''
  bar.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px">
      ${avatar}
      <span style="font-size:var(--text-sm)">已连接:<strong>@${htmlSafeEscape(link.login)}</strong></span>
      <span style="color:var(--fg-muted);font-size:var(--text-xs)">${htmlSafeEscape(link.scopes || '')}</span>
      <button id="github-unlink-btn" class="btn btn-ghost" style="margin-left:auto;padding:4px 12px;min-height:32px;font-size:var(--text-xs)">解绑账号</button>
    </div>`
  $('github-unlink-btn').onclick = () => unlinkGithub()
}

// ── OAuth link / unlink ───────────────────────────────────────────

export async function linkGithub() {
  try {
    const res = await apiJson('POST', '/api/auth/github/start', {})
    if (res && res.authorizeUrl) {
      // 让浏览器跳到 GitHub 授权页;回跳后会带 ?github_linked=1 或 ?github_error=
      window.location.href = res.authorizeUrl
    } else {
      toast('启动 GitHub 授权失败', 'error')
    }
  } catch (err) {
    toast(String(err), 'error', toastOptsFromError(err))
  }
}

export async function unlinkGithub() {
  if (!confirm('解绑 GitHub 账号?所有会话的仓库选择会清空,正在克隆的会话会停止。')) return
  try {
    const res = await apiJson('DELETE', '/api/me/github')
    toast(`已解绑${res && res.sessionsCleared ? ` · ${res.sessionsCleared} 个会话已清空` : ''}`, 'success')
    closeModal('github-modal')
    refreshGithubPill(getSession()?.id)
  } catch (err) {
    toast(String(err), 'error', toastOptsFromError(err))
  }
}

// ── Repo / branch 列表 ────────────────────────────────────────────

async function loadRepos() {
  const wrap = $('github-repo-list')
  wrap.innerHTML = '<p style="color:var(--fg-muted);font-size:var(--text-sm);padding:12px">加载仓库…</p>'
  try {
    // per_page=100 拉一页就够了大多数用户;后端默认按 pushed 排序,常用仓库在前
    const data = await apiGet('/api/me/github/repos?per_page=100&sort=pushed&type=owner')
    _allRepos = (data && Array.isArray(data.items) ? data.items : []).map((r) => ({
      owner: r.owner?.login || r.full_name?.split('/')[0],
      repo: r.name,
      full_name: r.full_name,
      default_branch: r.default_branch,
      private: r.private,
      pushed_at: r.pushed_at,
    }))
    renderRepoList(_allRepos)
  } catch (err) {
    wrap.innerHTML = `<p style="color:var(--danger);font-size:var(--text-sm);padding:12px">${htmlSafeEscape(String(err?.message || err))}</p>`
  }
}

function renderRepoList(repos) {
  const wrap = $('github-repo-list')
  if (!repos.length) {
    wrap.innerHTML = '<p style="color:var(--fg-muted);font-size:var(--text-sm);padding:12px">没有匹配的仓库。</p>'
    return
  }
  wrap.innerHTML = ''
  for (const r of repos) {
    const row = document.createElement('div')
    row.className = 'github-row'
    row.setAttribute('role', 'option')
    row.setAttribute('aria-selected', 'false')
    row.dataset.fullName = r.full_name
    row.innerHTML = `
      <span class="github-row-name">${htmlSafeEscape(r.full_name)}</span>
      ${r.private ? '<span class="github-row-sub">private</span>' : ''}
    `
    row.onclick = () => onRepoClick(r, row)
    wrap.appendChild(row)
  }
}

function onRepoClick(r, row) {
  // 单选:取消其他 row 的 selected
  const list = $('github-repo-list')
  for (const child of list.children) child.setAttribute('aria-selected', 'false')
  row.setAttribute('aria-selected', 'true')
  _selectedRepo = r
  _selectedBranch = null
  $('github-confirm-btn').disabled = true
  loadBranches(r.owner, r.repo, r.default_branch)
}

async function loadBranches(owner, repo, defaultBranch) {
  const header = $('github-branch-header')
  const wrap = $('github-branch-list')
  header.textContent = `${owner}/${repo} 的分支`
  wrap.innerHTML = '<p style="color:var(--fg-muted);font-size:var(--text-sm);padding:12px">加载分支…</p>'
  try {
    const data = await apiGet(
      `/api/me/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?per_page=100`,
    )
    const branches = data && Array.isArray(data.items) ? data.items : []
    if (!branches.length) {
      wrap.innerHTML = '<p style="color:var(--fg-muted);font-size:var(--text-sm);padding:12px">该仓库无分支?</p>'
      return
    }
    wrap.innerHTML = ''
    // default branch 顶置
    branches.sort((a, b) => {
      if (a.name === defaultBranch) return -1
      if (b.name === defaultBranch) return 1
      return a.name.localeCompare(b.name)
    })
    for (const b of branches) {
      const row = document.createElement('div')
      row.className = 'github-row'
      row.setAttribute('role', 'option')
      row.setAttribute('aria-selected', 'false')
      row.dataset.branch = b.name
      row.innerHTML = `
        <span class="github-row-name">${htmlSafeEscape(b.name)}</span>
        ${b.name === defaultBranch ? '<span class="github-row-sub">default</span>' : ''}
      `
      row.onclick = () => onBranchClick(b.name, row)
      wrap.appendChild(row)
    }
  } catch (err) {
    wrap.innerHTML = `<p style="color:var(--danger);font-size:var(--text-sm);padding:12px">${htmlSafeEscape(String(err?.message || err))}</p>`
  }
}

function onBranchClick(name, row) {
  const list = $('github-branch-list')
  for (const child of list.children) child.setAttribute('aria-selected', 'false')
  row.setAttribute('aria-selected', 'true')
  _selectedBranch = name
  $('github-confirm-btn').disabled = false
}

// ── Confirm / unbind 按钮处理 ─────────────────────────────────────

export async function confirmSelectRepo() {
  if (!_currentSid || !_selectedRepo || !_selectedBranch) return
  const btn = $('github-confirm-btn')
  btn.disabled = true
  const oldText = btn.textContent
  btn.textContent = '校验中…'
  try {
    const res = await apiJson(
      'PUT',
      `/api/me/sessions/${encodeURIComponent(_currentSid)}/github-selection`,
      { owner: _selectedRepo.owner, repo: _selectedRepo.repo, branch: _selectedBranch },
    )
    if (!res || typeof res.selection_version !== 'number') {
      throw new Error('后端响应格式异常')
    }
    // PUT 成功 = 后端权威新版本,直接 set 覆盖任何 +Infinity 哨兵(unbind→rebind 同一 tab)。
    _knownVersion.set(_currentSid, res.selection_version)
    // WS bind 帧。失败也不阻塞 UX —— bridge 在下次 reconnect 自动重发。
    sendRepoBindFrame(_currentSid, res.selection_version)
    closeModal('github-modal')
    // 立即用本地态更新 pill(避免等 status 帧),后端推 cloning/ready 时再覆盖
    applyPillFromSelection({
      selected: true,
      owner: res.owner,
      repo: res.repo,
      branch: res.branch,
      status: res.status || 'pending',
      selection_version: res.selection_version,
    }, _currentSid)
  } catch (err) {
    toast(String(err?.message || err), 'error', toastOptsFromError(err))
  } finally {
    btn.textContent = oldText
    btn.disabled = false
  }
}

export async function unbindCurrent() {
  if (!_currentSid || !_existingSelection) return
  if (!confirm(`解除当前会话与 ${_existingSelection.owner}/${_existingSelection.repo} @ ${_existingSelection.branch} 的绑定?`)) return
  const ver = _existingSelection.selection_version
  try {
    await apiJson('DELETE', `/api/me/sessions/${encodeURIComponent(_currentSid)}/github-selection`)
    sendRepoUnbindFrame(_currentSid, ver)
    // unbind 后任何延迟到达的旧版本 status/error 帧都不该再生效。
    // 后端 DELETE 不返回新版本号 —— 用 +Infinity 哨兵把已知版本封顶,
    // 直到下一次 PUT/GET 用真实版本覆盖。
    _knownVersion.set(_currentSid, Number.POSITIVE_INFINITY)
    closeModal('github-modal')
    applyPillFromSelection({ selected: false }, _currentSid)
  } catch (err) {
    toast(String(err?.message || err), 'error', toastOptsFromError(err))
  }
}

// ── Pill state 管理 ───────────────────────────────────────────────

/** Phase 6:把 selection 落到 #github-trigger 的 label + dot。 */
function applyPillFromSelection(sel, sid) {
  // 只在 sid === 当前 session 时更新 pill;切 session 时由 sessions.js 调用 refresh。
  const cur = getSession()?.id
  if (sid && cur && sid !== cur) return
  const { label, dot } = formatRepoLabel(sel)
  const labelEl = $('github-pill-label')
  const dotEl = $('github-pill-dot')
  if (labelEl) labelEl.textContent = label
  if (dotEl) dotEl.dataset.state = dot
}

/** 切 session / boot 时调:从后端拉一次 selection 来渲染 pill。 */
export async function refreshGithubPill(sessionId) {
  const sid = sessionId || getSession()?.id
  if (!sid) {
    applyPillFromSelection({ selected: false }, sid)
    return
  }
  try {
    const sel = await apiGet(`/api/me/sessions/${encodeURIComponent(sid)}/github-selection`)
    if (sel && sel.selected && typeof sel.selection_version === 'number') {
      // GET 是后端权威 —— 直接覆盖任何本地哨兵 / 旧值。
      _knownVersion.set(sid, sel.selection_version)
    } else {
      // 后端无 selection。把哨兵打到 +Infinity,避免延迟到达的旧 status 重画 pill。
      _knownVersion.set(sid, Number.POSITIVE_INFINITY)
    }
    applyPillFromSelection(sel || { selected: false }, sid)
  } catch (err) {
    // 401/404 等都视为未绑定;不打 toast 避免每次切 session 都骚扰
    applyPillFromSelection({ selected: false }, sid)
  }
}

// ── WS 帧 handlers(由 main.js 通过 setWsDeps 注入到 websocket.js) ─

/** outbound.control.session_repo_status — 容器侧状态推送。 */
export function handleRepoStatusFrame(frame) {
  if (!frame || typeof frame !== 'object') return
  const sid = frame.sessionId
  if (!sid) return
  // Version gate:本地已知版本严格大于来帧版本则丢弃(防 stale 回滚)。
  // 等于的也接受 —— 后端会对同一版本推 pending → cloning → ready 多次。
  const ver = typeof frame.selectionVersion === 'number' ? frame.selectionVersion : -1
  const known = _getKnownVersion(sid)
  if (known > ver) return
  _bumpKnownVersion(sid, ver)
  // 只更新当前 session 的 pill;其他 session 的状态在切换时再 refresh。
  const cur = getSession()?.id
  if (sid !== cur) return
  applyPillFromSelection({
    selected: true,
    owner: frame.owner || _existingSelection?.owner || '',
    repo: frame.repo || _existingSelection?.repo || '',
    branch: frame.branch || _existingSelection?.branch || '',
    status: frame.status,
    selection_version: ver,
  }, sid)
  if (frame.status === 'failed' && frame.errorCode) {
    toast(githubErrorText(frame.errorCode), 'error')
  }
}

/** outbound.control.session_repo_bind_error — bridge 校验失败。 */
export function handleRepoBindErrorFrame(frame) {
  if (!frame || typeof frame !== 'object') return
  const sid = frame.sessionId
  if (!sid) return
  // Version gate:同 status 帧。stale 错误不该 toast / 清当前 pill。
  const ver = typeof frame.selectionVersion === 'number' ? frame.selectionVersion : -1
  const known = _getKnownVersion(sid)
  if (known > ver) return
  toast(githubErrorText(frame.errorCode), 'error')
  // 当前 session 失败时清空 pill(后端已 cleared / 拒绝)
  const cur = getSession()?.id
  if (sid === cur) {
    applyPillFromSelection({ selected: false }, sid)
  }
}

/** boot 时如果 URL 带 ?github_linked=1 / ?github_error=...,toast + 清 query。 */
export function handleBootGithubParams() {
  const params = new URLSearchParams(window.location.search)
  let touched = false
  if (params.has('github_linked')) {
    toast('GitHub 账号已连接', 'success')
    params.delete('github_linked')
    touched = true
  }
  if (params.has('github_error')) {
    const code = params.get('github_error')
    toast(`GitHub 连接失败:${githubErrorText(code)}`, 'error')
    params.delete('github_error')
    touched = true
  }
  if (touched) {
    const q = params.toString()
    const newUrl = window.location.pathname + (q ? `?${q}` : '') + window.location.hash
    window.history.replaceState({}, '', newUrl)
  }
}

// ── Modal 内部按钮 wiring(由 main.js 在 boot 时调一次) ───────────

export function wireGithubModalButtons() {
  $('github-confirm-btn').onclick = () => confirmSelectRepo()
  $('github-unbind-btn').onclick = () => unbindCurrent()
  $('github-repo-search').addEventListener('input', (e) => {
    const q = String(e.target.value || '').trim().toLowerCase()
    if (!q) {
      renderRepoList(_allRepos)
      return
    }
    renderRepoList(_allRepos.filter((r) => r.full_name.toLowerCase().includes(q)))
  })
}
