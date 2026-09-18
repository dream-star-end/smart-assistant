import { createHash, randomBytes } from 'node:crypto'
import os from 'node:os'

import { formatApprovalDetail } from './approvalWindow.mjs'
import { parseOpenClaudeDeepLink } from './desktop-protocol.mjs'
import { redactSecrets } from './identity.mjs'
import { LOCAL_HOST_ORIGIN } from './ipc-contract.mjs'

export { LOCAL_HOST_ORIGIN, formatApprovalDetail }
export const DESKTOP_APP_ID = 'chat.claudeai.clarvy'
export const LOCAL_HOST_PARTITION = 'persist:clarvy-local'
export const LOCAL_HOST_URL = `${LOCAL_HOST_ORIGIN}/index.html`
export const ENROLL_TTL_MS = 10 * 60 * 1000

const LOCAL_INDEX_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>从简 · 本地模式</title>
</head>
<body>
<main>
<h1>本地模式</h1>
<p>此窗口用于设备注册、工作区授权与破坏性操作审批。</p>
<p id="status">本地通道就绪</p>
<p id="mode-status"></p>
<button id="start-enroll" type="button">启用本地模式</button>
<button id="choose-workspace" type="button">选择工作区</button>
<button id="fallback-cloud" type="button">回落云端</button>
<section id="approval" hidden>
  <h2>待审批操作</h2>
  <p id="approval-detail"></p>
  <button id="approve-op" type="button">允许</button>
  <button id="deny-op" type="button">拒绝</button>
</section>
</main>
<script src="./local.mjs"></script>
</body>
</html>
`

const LOCAL_SCRIPT = `const status = document.getElementById('status')
const modeStatus = document.getElementById('mode-status')
const approvalSection = document.getElementById('approval')
const approvalDetail = document.getElementById('approval-detail')
const startEnrollButton = document.getElementById('start-enroll')
const invoke = (payload) => window.clarvyLocalHost?.invoke(payload)
let currentOpId = null
let hideTimer = null

function formatApprovalDetail(summary) {
  const tool = String((summary && summary.tool) || '')
  const command = String((summary && summary.command) || '')
  const workspaceRoot = String((summary && summary.workspaceRoot) || '')
  return '工具：' + tool + '\\n命令：' + command + '\\n工作区：' + workspaceRoot
}

function hideApproval() {
  if (hideTimer) {
    clearTimeout(hideTimer)
    hideTimer = null
  }
  currentOpId = null
  if (approvalSection) approvalSection.hidden = true
  if (approvalDetail) approvalDetail.textContent = ''
}

function showApproval(payload) {
  if (!payload || typeof payload.opId !== 'string') return
  currentOpId = payload.opId
  if (approvalDetail) approvalDetail.textContent = formatApprovalDetail(payload.summary || {})
  if (approvalSection) approvalSection.hidden = false
  const deadlineAt = Number(payload.deadlineAt) || 0
  const remain = Math.max(0, deadlineAt - Date.now())
  if (hideTimer) clearTimeout(hideTimer)
  hideTimer = setTimeout(hideApproval, remain || 120000)
}

async function refreshStatus() {
  try {
    const result = await invoke({ type: 'get-status' })
    if (result?.ok && result.status) {
      const bootstrapDisabled = result.status.bootstrapDisabled === true
      if (bootstrapDisabled) {
        modeStatus.textContent = '服务端未开放本地模式'
        if (startEnrollButton) startEnrollButton.disabled = true
      } else {
        const mode = result.status.localMode || result.status.phase || ''
        const pending = Number(result.status.pendingApprovals) || 0
        const pendingLabel = pending > 0 ? (' · 待审批 ' + pending) : ''
        modeStatus.textContent = mode ? ('状态：' + mode + pendingLabel) : pendingLabel.slice(3)
        if (startEnrollButton) startEnrollButton.disabled = false
      }
    }
  } catch {
    /* */
  }
}

document.getElementById('start-enroll')?.addEventListener('click', async (event) => {
  event.target.disabled = true
  try {
    const result = await invoke({ type: 'start-enroll' })
    status.textContent = result?.ok ? '已打开浏览器，请在网页确认这台电脑' : (result?.error || '失败')
  } catch {
    status.textContent = '失败'
  } finally {
    event.target.disabled = false
    void refreshStatus()
  }
})
document.getElementById('choose-workspace')?.addEventListener('click', async () => {
  try {
    const result = await invoke({ type: 'choose-workspace' })
    status.textContent = result?.ok ? ('工作区：' + (result.path || '')) : (result?.error || '未选择')
  } catch {
    status.textContent = '选择工作区失败'
  }
})
document.getElementById('fallback-cloud')?.addEventListener('click', async () => {
  try {
    const result = await invoke({ type: 'fallback-cloud' })
    status.textContent = result?.ok ? '已回落云端薄壳' : (result?.error || '失败')
  } catch {
    status.textContent = '回落失败'
  }
  void refreshStatus()
})
document.getElementById('approve-op')?.addEventListener('click', async () => {
  if (!currentOpId) return
  const opId = currentOpId
  try {
    await invoke({ type: 'approve-op', id: opId })
  } catch {
    /* */
  }
  hideApproval()
  void refreshStatus()
})
document.getElementById('deny-op')?.addEventListener('click', async () => {
  if (!currentOpId) return
  const opId = currentOpId
  try {
    await invoke({ type: 'deny-op', id: opId })
  } catch {
    /* */
  }
  hideApproval()
  void refreshStatus()
})
window.clarvyLocalHost?.onApprovalPending?.(showApproval)
void refreshStatus()
`

const LOCAL_ASSETS = new Map([
  ['/', Object.freeze({ mime: 'text/html; charset=utf-8', body: LOCAL_INDEX_HTML })],
  ['/index.html', Object.freeze({ mime: 'text/html; charset=utf-8', body: LOCAL_INDEX_HTML })],
  ['/local.mjs', Object.freeze({ mime: 'text/javascript; charset=utf-8', body: LOCAL_SCRIPT })],
])

const LOCAL_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
})

function plainResponse(status, body, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: {
      ...LOCAL_HEADERS,
      'Content-Type': 'text/plain; charset=utf-8',
      ...extraHeaders,
    },
  })
}

export function generatePkceVerifier() {
  return randomBytes(48).toString('base64url')
}

export function pkceChallengeS256(verifier) {
  if (typeof verifier !== 'string' || verifier.length < 43 || verifier.length > 128) {
    throw new TypeError('invalid pkce verifier')
  }
  return createHash('sha256').update(verifier, 'ascii').digest('base64url')
}

export function resolveLocalHostAsset(requestUrl) {
  if (typeof requestUrl !== 'string' || requestUrl.length === 0 || requestUrl !== requestUrl.trim()) {
    return null
  }
  let parsed
  try {
    parsed = new URL(requestUrl)
  } catch {
    return null
  }
  if (
    parsed.protocol !== 'app:' ||
    parsed.hostname !== 'clarvy-local' ||
    parsed.port !== '' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    return null
  }
  const pathname = parsed.pathname || '/'
  if (pathname.includes('//') || pathname.includes('\\') || pathname.includes('%')) return null
  if (pathname.split('/').some((segment) => segment === '.' || segment === '..')) return null
  return LOCAL_ASSETS.get(pathname) ?? null
}

export function createLocalHostResponse(request) {
  if (!request || request.method !== 'GET') {
    return plainResponse(405, 'Method Not Allowed', { Allow: 'GET' })
  }
  const asset = resolveLocalHostAsset(request.url)
  if (!asset) return plainResponse(404, 'Not Found')
  return new Response(asset.body, {
    status: 200,
    headers: {
      ...LOCAL_HEADERS,
      'Content-Type': asset.mime,
    },
  })
}

export function registerLocalHostProtocol(protocolModule) {
  if (!protocolModule || typeof protocolModule.handle !== 'function') {
    throw new TypeError('Electron protocol.handle is required')
  }
  const handler = (request) => createLocalHostResponse(request)
  protocolModule.handle('app', handler)
  return handler
}

async function readJsonResponse(response) {
  const text = await response.text()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return { error: { code: 'INVALID_JSON', message: 'non-json response' } }
  }
}

export function createEnrollmentController({
  origin = 'https://claudeai.chat',
  appId = DESKTOP_APP_ID,
  platform = 'windows',
  publicName,
  fetchImpl = globalThis.fetch,
  identityStore,
  openExternal = () => {},
  now = () => Date.now(),
  audit = () => {},
} = {}) {
  if (!identityStore || typeof identityStore.save !== 'function') {
    throw new TypeError('identityStore.save is required')
  }
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('fetchImpl is required')
  }

  let inFlight = null
  let phase = 'idle'
  let hasIdentity = false

  function emit(event, fields = {}) {
    try {
      audit(event, redactSecrets(fields))
    } catch {
      audit(event)
    }
  }

  async function postJson(pathname, body) {
    const response = await fetchImpl(`${origin}${pathname}`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    const json = await readJsonResponse(response)
    if (!response.ok) {
      const error = new Error(json?.error?.message || `http ${response.status}`)
      error.status = response.status
      error.code = json?.error?.code || 'HTTP_ERROR'
      throw error
    }
    return json
  }

  return {
    getStatus() {
      return {
        phase,
        hasIdentity,
        enrollmentId: inFlight?.enrollmentId ?? null,
      }
    },

    async start() {
      const verifier = generatePkceVerifier()
      const pkce_challenge = pkceChallengeS256(verifier)
      const name = String(publicName ?? os.hostname() ?? 'Clarvy').slice(0, 128)
      const json = await postJson('/api/desktop/enroll/start', {
        pkce_challenge,
        app_id: appId,
        public_name: name,
        platform,
      })
      const enrollmentId = typeof json.enrollment_id === 'string' ? json.enrollment_id : ''
      const authUrl = typeof json.auth_url === 'string' ? json.auth_url : ''
      if (!enrollmentId || !authUrl) {
        throw new Error('invalid enroll start response')
      }
      const expiresAt = Date.parse(json.expires_at) || now() + ENROLL_TTL_MS
      inFlight = { enrollmentId, verifier, expiresAt }
      phase = 'awaiting-callback'
      emit('enroll_start', { enrollmentId })
      openExternal(authUrl)
      return { enrollmentId, authUrl, expiresAt }
    },

    async handleCallback(parsed) {
      if (!parsed || parsed.action !== 'enroll-callback') {
        emit('enroll_callback_ignored', { reason: parsed?.reason || 'not-enroll' })
        return { ok: false, reason: parsed?.reason || 'not-enroll' }
      }
      if (!inFlight) {
        emit('enroll_callback_ignored', { reason: 'no-inflight' })
        return { ok: false, reason: 'no-inflight' }
      }
      if (parsed.enrollmentId !== inFlight.enrollmentId) {
        emit('enroll_callback_ignored', { reason: 'id-mismatch' })
        return { ok: false, reason: 'id-mismatch' }
      }
      if (now() > inFlight.expiresAt) {
        emit('enroll_callback_ignored', { reason: 'expired' })
        inFlight = null
        phase = 'error'
        return { ok: false, reason: 'expired' }
      }

      const { enrollmentId, verifier } = inFlight
      try {
        const json = await postJson('/api/desktop/enroll/finish', {
          enrollment_id: enrollmentId,
          code: parsed.code,
          pkce_verifier: verifier,
        })
        await identityStore.save({
          deviceId: json.deviceId,
          containerId: json.containerId,
          device_cert: json.device_cert,
          device_key: json.device_key,
          device_credential: json.device_credential,
        })
        inFlight = null
        phase = 'enrolled'
        hasIdentity = true
        emit('enroll_finish', { deviceId: json.deviceId, containerId: json.containerId })
        return { ok: true, deviceId: json.deviceId, containerId: json.containerId }
      } catch (error) {
        emit('enroll_finish_failed', { reason: error.code || 'http' })
        if (error.status === 409) {
          inFlight = null
          phase = 'error'
        }
        return { ok: false, reason: error.code || 'http' }
      }
    },

    async handleDeepLink(raw) {
      return this.handleCallback(parseOpenClaudeDeepLink(raw))
    },
  }
}
