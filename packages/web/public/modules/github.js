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
import { apiGet, apiJson } from './api.js?v=8ecb0b2d'
import { $, htmlSafeEscape } from './dom.js?v=8ecb0b2d'
import { getSession, state } from './state.js?v=8ecb0b2d'
import { closeModal, confirmDialog, openModal, toast, toastOptsFromError } from './ui.js?v=8ecb0b2d'
import {
  clearRepoBindQueue,
  queueRepoBindFrame,
  sendRepoUnbindFrame,
} from './websocket.js?v=8ecb0b2d'

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
    // OAuth callback 阶段的错误码 — 来自 oauthGithub.ts githubErrorRedirect()
    state_mismatch: 'OAuth 回调状态不匹配,请重新连接',
    exchange_failed: 'GitHub 授权码兑换失败,请重新连接',
    account_already_linked: '该 GitHub 账号已绑定到另一个 OpenClaude 账号。请先在原账号解绑,或改用其他 GitHub 账号。',
    server_error: 'GitHub 连接服务异常,请稍后重试',
  }
  return dict[code] || code || '未知错误'
}

/**
 * 把 selection 状态翻译成 pill label + dot state。
 * 状态文字(准备中/克隆中/进度%)已移到 #repo-progress-banner,pill 只剩
 * 仓库名 + 颜色点。
 * - 未绑定:label = "仓库", dot = "none"
 * - 已绑定:label = "owner/repo @ branch", dot = status (pending/cloning/ready/failed)
 */
export function formatRepoLabel(sel) {
  if (!sel || !sel.selected) return { label: '仓库', dot: 'none' }
  const base = `${sel.owner}/${sel.repo} @ ${sel.branch}`
  const status = sel.status
  const dot = (status === 'ready' || status === 'cloning' || status === 'failed') ? status : 'pending'
  return { label: base, dot }
}

/**
 * 把 selection 翻译成 banner 渲染用的状态 bag。null = 不显示 banner。
 * - 未绑定 → null
 * - pending → { phase:'pending', text:'准备中…', name, showProgress:false }
 * - cloning → { phase:'cloning', text:'克隆中', name, showProgress:true }
 * - ready  → { phase:'ready',   text:'已就绪',  name, showProgress:false }
 * - failed → { phase:'failed',  text:'克隆失败', name, showProgress:false }
 * 未知 status 视为 pending fallback。
 */
export function formatBannerState(sel) {
  if (!sel || !sel.selected) return null
  const name = `${sel.owner}/${sel.repo} @ ${sel.branch}`
  switch (sel.status) {
    case 'ready':   return { phase: 'ready',   text: '已就绪',  name, showProgress: false }
    case 'cloning': return { phase: 'cloning', text: '克隆中',  name, showProgress: true }
    case 'failed':  return { phase: 'failed',  text: '克隆失败', name, showProgress: false }
    case 'pending':
    default:        return { phase: 'pending', text: '准备中…', name, showProgress: false }
  }
}

/**
 * 克隆进度估算曲线。后端不报 git clone 真实百分比,前端按 30s 期望窗口
 * 跑一条缓动曲线,封顶 90%(留 10% 给真正的 ready 帧)。
 *   pct = 90 * (1 - exp(-2.2 * t))   t = elapsed / 30000
 * t=0 → 0%;t=0.5(15s) → 60%;t=1(30s) → 80%;t=2(60s) → 89%。
 * 之后真实 ready 帧会跳到 100% + 自隐。
 */
export function estimateCloningProgress(startTime, now) {
  if (!Number.isFinite(startTime) || !Number.isFinite(now)) return 0
  const t = Math.max(0, (now - startTime) / 30000)
  return Math.min(90, Math.round(90 * (1 - Math.exp(-2.2 * t))))
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

// ── Per-session banner 进度计时器 ───────────────────────────────
// _knownVersion 只存版本号 —— 切 session 回来时不能恢复"这个 session
// 的克隆已经跑了 12s"。因此独立 Map 持久化 startTime + interval。
// 切 session 时 timer 不停(后端仍在 clone),只是 tick 早 return DOM 更新;
// 切回来时复用同一 startTime 继续算 elapsed,曲线不被重置。
const _repoProgressBySid = new Map()       // sid -> { startTime: number, timer: number }
const _repoReadyHideTimerBySid = new Map() // sid -> number(setTimeout id)

function _clearProgressTimer(sid) {
  const entry = _repoProgressBySid.get(sid)
  if (entry && entry.timer) clearInterval(entry.timer)
  _repoProgressBySid.delete(sid)
}
function _clearReadyHideTimer(sid) {
  const t = _repoReadyHideTimerBySid.get(sid)
  if (t) clearTimeout(t)
  _repoReadyHideTimerBySid.delete(sid)
}
function _startProgressTimer(sid) {
  // 已有则不重启 —— 保留累计 elapsed,避免切 session 来回时进度被重置。
  if (_repoProgressBySid.has(sid)) return
  const startTime = Date.now()
  const tick = () => {
    const cur = getSession()?.id
    if (cur !== sid) return // 不在当前 session,timer 继续跑但不动 DOM
    const pct = estimateCloningProgress(startTime, Date.now())
    _renderBannerProgress(pct)
  }
  tick()
  const timer = setInterval(tick, 200)
  _repoProgressBySid.set(sid, { startTime, timer })
}

/** banner DOM 进度刷新(纯渲染,不动 timer 状态)。 */
function _renderBannerProgress(pct) {
  const trackEl = $('repo-banner-progress')
  if (trackEl) {
    trackEl.setAttribute('aria-valuenow', String(pct))
    const fillEl = trackEl.querySelector('.repo-banner-progress-fill')
    if (fillEl) fillEl.style.width = `${pct}%`
  }
  const banner = $('repo-progress-banner')
  const pctEl = banner ? banner.querySelector('.repo-banner-progress-pct') : null
  if (pctEl) pctEl.textContent = `${pct}%`
}

/** 只隐藏 banner DOM,timer 状态不动 —— 用在 ready 自隐 / unbind / no-selection。 */
function _hideBannerOnly() {
  const banner = $('repo-progress-banner')
  if (banner) banner.hidden = true
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
  if (
    !(await confirmDialog({
      title: '解绑 GitHub 账号?',
      body: '所有会话的仓库选择会清空,正在克隆的会话会停止。',
      confirmText: '解绑',
      danger: true,
    }))
  )
    return
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
    // v1.0.94:走待确认队列,内部立即尝试一次,失败/卡顿由 onopen flush + 30s GET 兜底,
    // 直到收到 cloning/ready/failed/bind_error 才清队列。
    queueRepoBindFrame(_currentSid, res.selection_version)
    closeModal('github-modal')
    // 立即用本地态更新 pill + banner(避免等 status 帧),后端推 cloning/ready 时再覆盖
    const localSel = {
      selected: true,
      owner: res.owner,
      repo: res.repo,
      branch: res.branch,
      status: res.status || 'pending',
      selection_version: res.selection_version,
    }
    applyPillFromSelection(localSel, _currentSid)
    applyBannerFromState(localSel, _currentSid)
  } catch (err) {
    toast(String(err?.message || err), 'error', toastOptsFromError(err))
  } finally {
    btn.textContent = oldText
    btn.disabled = false
  }
}

export async function unbindCurrent() {
  // U3:确认弹窗是 async,先把会话/选择快照下来,避免 await 期间模块态(切会话等)
  // 改变后用到 stale 的 _currentSid / _existingSelection。
  const sid = _currentSid
  const sel = _existingSelection
  if (!sid || !sel) return
  if (
    !(await confirmDialog({
      title: '解除仓库绑定?',
      body: `解除当前会话与 ${sel.owner}/${sel.repo} @ ${sel.branch} 的绑定?`,
      confirmText: '解除绑定',
      danger: true,
    }))
  )
    return
  const ver = sel.selection_version
  try {
    await apiJson('DELETE', `/api/me/sessions/${encodeURIComponent(sid)}/github-selection`)
    // v1.0.94:DELETE 之后先清待确认队列,避免后续 status 帧迟到时 stale entry 被错配。
    clearRepoBindQueue(sid)
    sendRepoUnbindFrame(sid, ver)
    // unbind 后任何延迟到达的旧版本 status/error 帧都不该再生效。
    // 后端 DELETE 不返回新版本号 —— 用 +Infinity 哨兵把已知版本封顶,
    // 直到下一次 PUT/GET 用真实版本覆盖。
    _knownVersion.set(sid, Number.POSITIVE_INFINITY)
    closeModal('github-modal')
    applyPillFromSelection({ selected: false }, sid)
    applyBannerFromState({ selected: false }, sid)
  } catch (err) {
    toast(String(err?.message || err), 'error', toastOptsFromError(err))
  }
}

// ── Pill / banner state 管理 ──────────────────────────────────────

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

/**
 * 把 selection 应用到 #repo-progress-banner。Timer 状态(进度 / ready 自隐)
 * 即便 sid !== current session 也要更新 —— 否则不在前台的 cloning timer
 * 会泄漏。DOM 更新仅在 sid === current 时执行。
 *
 * opts.suppressReadyShow:初始 GET / 切 session 时已是 ready 不显示 banner
 *                         (避免每次开页面闪一下"已就绪")。
 */
function applyBannerFromState(sel, sid, opts) {
  const suppressReadyShow = !!(opts && opts.suppressReadyShow)
  const st = formatBannerState(sel)
  const cur = getSession()?.id
  const isCurrent = !!(sid && cur && sid === cur) || (!sid && cur)
  const banner = $('repo-progress-banner')

  // ── Timer 状态机(无视 isCurrent,泄漏防护)──
  if (!st) {
    _clearProgressTimer(sid)
    _clearReadyHideTimer(sid)
  } else if (st.phase === 'cloning') {
    _clearReadyHideTimer(sid)
    _startProgressTimer(sid) // 已有则 noop
  } else {
    _clearProgressTimer(sid)
    if (st.phase === 'ready' && !suppressReadyShow) {
      _clearReadyHideTimer(sid)
      const t = setTimeout(() => {
        _repoReadyHideTimerBySid.delete(sid)
        const cur2 = getSession()?.id
        if (cur2 === sid) _hideBannerOnly()
      }, 3000)
      _repoReadyHideTimerBySid.set(sid, t)
    } else {
      // pending / failed / suppressed-ready:无 ready 自隐计时
      _clearReadyHideTimer(sid)
    }
  }

  // ── DOM 更新(仅当前 session)──
  if (!isCurrent || !banner) return
  if (!st || (st.phase === 'ready' && suppressReadyShow)) {
    banner.hidden = true
    return
  }
  banner.hidden = false
  banner.dataset.state = st.phase
  const iconEl = banner.querySelector('.repo-banner-icon')
  const nameEl = banner.querySelector('.repo-banner-name')
  const statusEl = banner.querySelector('.repo-banner-status')
  const progressEl = banner.querySelector('.repo-banner-progress')
  if (iconEl) iconEl.dataset.state = st.phase
  if (nameEl) nameEl.textContent = st.name
  if (statusEl) statusEl.textContent = st.text
  if (progressEl) progressEl.hidden = !st.showProgress
  if (st.phase === 'ready') {
    _renderBannerProgress(100)
  } else if (!st.showProgress) {
    _renderBannerProgress(0)
  }
  // cloning 的进度由 timer.tick 自己刷新,这里不动
}

/** 切 session / boot 时调:从后端拉一次 selection 来渲染 pill + banner。 */
export async function refreshGithubPill(sessionId) {
  const sid = sessionId || getSession()?.id
  if (!sid) {
    applyPillFromSelection({ selected: false }, sid)
    applyBannerFromState({ selected: false }, sid)
    return
  }
  // 切 session race:若新 session 是当前 session,先**同步**隐藏 banner DOM,
  // 避免在 await GET 期间用户看到上个 session 的状态(克隆中 65% 这种)。
  // 注意只动 DOM 不清 timer —— 上个 session 的 cloning timer 仍可能存活,
  // 走它自己的 sid 路径;本 session 的 timer 还没建立,这里也无可清。
  const cur = getSession()?.id
  if (sid === cur) _hideBannerOnly()
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
    // 初次 / 切回:已是 ready 直接收 banner,不闪"已就绪"
    applyBannerFromState(sel || { selected: false }, sid, { suppressReadyShow: true })
  } catch (err) {
    // 401/404 等都视为未绑定;不打 toast 避免每次切 session 都骚扰
    applyPillFromSelection({ selected: false }, sid)
    applyBannerFromState({ selected: false }, sid)
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
  const sel = {
    selected: true,
    owner: frame.owner || _existingSelection?.owner || '',
    repo: frame.repo || _existingSelection?.repo || '',
    branch: frame.branch || _existingSelection?.branch || '',
    status: frame.status,
    selection_version: ver,
  }
  // Pill 仅当前 session 才更新;banner timer 状态对所有 session 都要更新
  // (否则 cloning timer 会泄漏)。applyBannerFromState 内部会按 isCurrent 决定
  // 是否动 DOM。
  applyPillFromSelection(sel, sid)
  applyBannerFromState(sel, sid)
  if (frame.status === 'failed' && frame.errorCode) {
    const cur = getSession()?.id
    if (sid === cur) toast(githubErrorText(frame.errorCode), 'error')
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
  const cur = getSession()?.id
  if (sid === cur) toast(githubErrorText(frame.errorCode), 'error')
  // 失败时清空 pill + banner 状态(后端已 cleared / 拒绝)。
  // 关键:把 _knownVersion 升到 +Infinity 哨兵 —— status 帧 version-gate
  // 用 `known > ver`(同版本接受多次以支持 pending→cloning→ready),所以
  // 不升哨兵的话,同 selection_version 的延迟 status 帧会"复活"已清的 UI。
  // 直到下一次 PUT/GET 用真实新版本号覆盖哨兵为止。
  _knownVersion.set(sid, Number.POSITIVE_INFINITY)
  applyPillFromSelection({ selected: false }, sid)
  applyBannerFromState({ selected: false }, sid)
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
