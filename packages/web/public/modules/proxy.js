// OpenClaude — outbound proxy and local sing-box subscription node UI.
import { apiGet, apiJson } from './api.js'
import { $ } from './dom.js'
import { closeModal, openModal, toast } from './ui.js'

let _nodes = []
let _status = null
let _healthByIdx = new Map()
let _busy = false

function setBusy(busy) {
  _busy = busy
  for (const id of [
    'egress-refresh-btn',
    'egress-test-active-btn',
    'egress-test-list-btn',
    'save-proxy-btn',
  ]) {
    const el = $(id)
    if (el) el.disabled = busy
  }
  document.querySelectorAll('[data-egress-select]').forEach((btn) => {
    btn.disabled =
      busy ||
      !_status?.mutationsEnabled ||
      btn.dataset.active === 'true' ||
      btn.dataset.supported !== 'true'
  })
}

function text(el, value) {
  if (el) el.textContent = value == null || value === '' ? '—' : String(value)
}

function formatMs(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) return '—'
  return n >= 1000 ? `${(n / 1000).toFixed(2)}s` : `${Math.round(n)}ms`
}

function healthLabel(health) {
  if (!health) return '未测速'
  if (health.healthy) return `✅ ${formatMs(health.scoreMs)}`
  return `⚠️ ${health.anthropicCode || health.cfCode || health.error || '失败'}`
}

function nodeMeta(node) {
  const parts = []
  if (node.server) parts.push(`${node.server}${node.port ? `:${node.port}` : ''}`)
  if (node.transport || node.security)
    parts.push(`${node.transport || '-'} + ${node.security || '-'}`)
  if (!node.supported && node.error) parts.push(node.error)
  return parts.join(' · ')
}

function selectedNodesForTest() {
  const q = $('egress-node-filter')?.value.trim().toLowerCase() || ''
  const filtered = _nodes.filter((n) => {
    if (!n.supported) return false
    if (!q) return true
    return `${n.idx} ${n.name} ${n.server || ''}`.toLowerCase().includes(q)
  })
  return filtered.slice(0, 20)
}

function renderStatus() {
  const active = _status?.active || {}
  text($('egress-service-state'), _status?.service?.active ? '运行中' : '未运行/未知')
  text($('egress-local-proxy'), _status?.localProxy)
  text($('egress-active-node'), active.idx ? `#${active.idx} ${active.name || ''}` : '未选择')
  text($('egress-active-server'), active.server)
  text($('egress-updated-at'), active.updatedAt)
  text($('egress-mutation-state'), _status?.mutationsEnabled ? '允许切换' : '只读')
  const hint = $('egress-readonly-hint')
  if (hint) {
    hint.hidden = !!_status?.mutationsEnabled
    hint.textContent = _status?.mutationDisabledReason
      ? `当前环境禁止切换节点：${_status.mutationDisabledReason}`
      : '当前环境禁止切换节点。'
  }
  const activeHealth = _healthByIdx.get(active.idx) || active.health
  text($('egress-active-health'), healthLabel(activeHealth))
}

function renderNodes() {
  const list = $('egress-node-list')
  if (!list) return
  list.textContent = ''
  const q = $('egress-node-filter')?.value.trim().toLowerCase() || ''
  const filtered = _nodes.filter((node) => {
    if (!q) return true
    return `${node.idx} ${node.name} ${node.server || ''}`.toLowerCase().includes(q)
  })
  text($('egress-node-count'), `${filtered.length}/${_nodes.length} 个节点`)
  if (!filtered.length) {
    const empty = document.createElement('div')
    empty.className = 'proxy-node-empty'
    empty.textContent = _nodes.length
      ? '没有匹配的节点'
      : '还没有节点列表，点“更新订阅 / 刷新列表”。'
    list.appendChild(empty)
    return
  }
  for (const node of filtered) {
    const row = document.createElement('div')
    row.className = `proxy-node-row${node.active ? ' active' : ''}${node.supported ? '' : ' unsupported'}`

    const main = document.createElement('div')
    main.className = 'proxy-node-main'
    const title = document.createElement('div')
    title.className = 'proxy-node-title'
    title.textContent = `#${node.idx} ${node.name}`
    const meta = document.createElement('div')
    meta.className = 'proxy-node-meta'
    meta.textContent = nodeMeta(node)
    main.append(title, meta)

    const health = document.createElement('div')
    health.className = 'proxy-node-health'
    const h = _healthByIdx.get(node.idx)
    health.textContent = healthLabel(h)
    if (h?.ip || h?.country || h?.org) {
      const detail = document.createElement('div')
      detail.className = 'proxy-node-health-detail'
      detail.textContent = [h.ip, h.country, h.city, h.org].filter(Boolean).join(' · ')
      health.appendChild(detail)
    }

    const btn = document.createElement('button')
    btn.className = 'btn btn-secondary proxy-node-select'
    btn.type = 'button'
    btn.dataset.egressSelect = String(node.idx)
    btn.dataset.active = node.active ? 'true' : 'false'
    btn.dataset.supported = node.supported ? 'true' : 'false'
    btn.disabled = _busy || node.active || !node.supported || !_status?.mutationsEnabled
    btn.textContent = node.active ? '当前' : '切换'
    btn.onclick = () => selectNode(node)

    row.append(main, health, btn)
    list.appendChild(row)
  }
}

async function loadManualProxyConfig() {
  const input = $('proxy-url-input')
  input.value = ''
  input.dataset.initial = ''
  try {
    const cfg = await apiGet('/api/config')
    const value = cfg.proxyUrl ?? ''
    input.value = value
    input.dataset.initial = value
  } catch (err) {
    toast(`读取代理配置失败: ${String(err)}`, 'error')
  }
}

async function loadStatus() {
  _status = await apiGet('/api/egress-proxy/status')
  renderStatus()
  renderNodes()
}

async function refreshNodes({ silent = false } = {}) {
  setBusy(true)
  try {
    const data = await apiJson('POST', '/api/egress-proxy/refresh', {})
    _nodes = Array.isArray(data.nodes) ? data.nodes : []
    _status = data.status || _status
    _healthByIdx = new Map()
    if (!silent) toast(`已刷新 ${_nodes.length} 个订阅节点`, 'success')
    renderStatus()
    renderNodes()
  } catch (err) {
    toast(`刷新订阅失败: ${String(err)}`, 'error')
  } finally {
    setBusy(false)
  }
}

async function testActive() {
  setBusy(true)
  try {
    const data = await apiJson('POST', '/api/egress-proxy/test', {}, { timeout: 60000 })
    if (data.active) {
      const idx = _status?.active?.idx
      if (idx) _healthByIdx.set(idx, data.active)
      toast(
        `当前节点测速完成：${healthLabel(data.active)}`,
        data.active.healthy ? 'success' : 'error',
      )
    }
    renderStatus()
    renderNodes()
  } catch (err) {
    toast(`当前节点测速失败: ${String(err)}`, 'error')
  } finally {
    setBusy(false)
  }
}

async function testVisibleNodes() {
  const selected = selectedNodesForTest()
  if (!selected.length) {
    toast('没有可测速的支持节点', 'error')
    return
  }
  setBusy(true)
  try {
    const data = await apiJson(
      'POST',
      '/api/egress-proxy/test',
      { idxs: selected.map((n) => n.idx) },
      { timeout: 180000 },
    )
    let ok = 0
    for (const r of data.results || []) {
      if (r.health) {
        _healthByIdx.set(r.idx, r.health)
        if (r.health.healthy) ok++
      } else {
        _healthByIdx.set(r.idx, { healthy: false, error: r.error, scoreMs: 0 })
      }
    }
    toast(`测速完成：${ok}/${selected.length} 可用`, ok ? 'success' : 'error')
    renderStatus()
    renderNodes()
  } catch (err) {
    toast(`测速失败: ${String(err)}`, 'error')
  } finally {
    setBusy(false)
  }
}

async function selectNode(node) {
  if (!node.supported || node.active || !_status?.mutationsEnabled) return
  const ok = window.confirm(
    `切换到 #${node.idx} ${node.name}？\n会先测速该节点，通过后重启本机 egress 代理。`,
  )
  if (!ok) return
  setBusy(true)
  try {
    const data = await apiJson(
      'POST',
      '/api/egress-proxy/select',
      { idx: node.idx },
      { timeout: 90000 },
    )
    if (data.health) _healthByIdx.set(node.idx, data.health)
    _status = data.status || (await apiGet('/api/egress-proxy/status'))
    _nodes = _nodes.map((n) => ({ ...n, active: n.idx === node.idx }))
    toast(`已切换到 #${node.idx}`, 'success')
    renderStatus()
    renderNodes()
  } catch (err) {
    toast(`切换失败: ${String(err)}`, 'error')
  } finally {
    setBusy(false)
  }
}

async function saveManualProxy() {
  const input = $('proxy-url-input')
  const initial = input.dataset.initial ?? ''
  const current = input.value
  if (current === initial) {
    toast('未做修改', 'info')
    closeModal('proxy-modal')
    return
  }
  setBusy(true)
  try {
    await apiJson('PUT', '/api/config', { proxyUrl: current })
    input.dataset.initial = current
    toast('已保存', 'success')
    closeModal('proxy-modal')
  } catch (err) {
    toast(String(err), 'error')
  } finally {
    setBusy(false)
  }
}

export async function openProxyModal() {
  openModal('proxy-modal')
  await Promise.all([
    loadManualProxyConfig(),
    loadStatus().catch((err) => toast(String(err), 'error')),
  ])
  if (!_nodes.length) refreshNodes({ silent: true }).catch(() => {})
  setTimeout(() => $('proxy-url-input')?.focus(), 50)
}

export function initProxyUi() {
  $('save-proxy-btn').onclick = saveManualProxy
  $('egress-refresh-btn').onclick = () => refreshNodes()
  $('egress-test-active-btn').onclick = testActive
  $('egress-test-list-btn').onclick = testVisibleNodes
  $('egress-node-filter').addEventListener('input', renderNodes)
}
