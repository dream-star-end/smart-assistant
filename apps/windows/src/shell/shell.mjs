import { attachWcoGeometryListeners, isPositiveTitlebarGeometry } from './wco-geometry.mjs'

const fixtureName = document.documentElement.dataset.auroraFixture

if (fixtureName === 'smoke-product') {
  initializeSmokeProduct()
} else {
  initializeShell()
}

function initializeSmokeProduct() {
  const probes = [
    ['probe-process', typeof globalThis.process === 'undefined'],
    ['probe-require', typeof globalThis.require === 'undefined'],
    ['probe-bridge', typeof globalThis.auroraDesktop === 'undefined'],
  ]
  for (const [id, safe] of probes) {
    const output = document.getElementById(id)
    if (!output) continue
    output.dataset.safe = String(safe)
    output.value = safe ? '不可用（已隔离）' : '意外可用'
    output.textContent = output.value
  }

  const routeOutput = document.getElementById('fixture-route')
  const reloadOutput = document.getElementById('fixture-reload-count')
  const pushButton = document.getElementById('fixture-push-route')
  const reloadKey = 'aurora-smoke-product-reloads'
  const routeUrl = 'app://aurora-shell/smoke-product-route.html'
  const nextReloadCount =
    Math.max(0, Number.parseInt(sessionStorage.getItem(reloadKey) || '0', 10)) + 1
  sessionStorage.setItem(reloadKey, String(nextReloadCount))
  reloadOutput.textContent = String(nextReloadCount)

  function currentRoute() {
    return location.pathname === '/smoke-product-route.html' ? 1 : 0
  }

  function renderRoute() {
    routeOutput.textContent = String(currentRoute())
  }

  pushButton.addEventListener('click', () => {
    location.assign(routeUrl)
  })
  renderRoute()
  document.documentElement.dataset.smokeReady = 'true'
}

function initializeShell() {
  const bridge = globalThis.auroraDesktop
  const elements = {
    commandSurface: document.querySelector('.command-surface'),
    connectionLabel: document.getElementById('connection-label'),
    connectionStatus: document.getElementById('connection-status'),
    downloadsBadge: document.getElementById('downloads-badge'),
    downloadsButton: document.getElementById('downloads-button'),
    downloadsClose: document.getElementById('downloads-close'),
    downloadsDialog: document.getElementById('downloads-dialog'),
    downloadsEmpty: document.getElementById('downloads-empty'),
    downloadsLayer: document.getElementById('downloads-layer'),
    downloadsList: document.getElementById('downloads-list'),
    downloadsScrim: document.getElementById('downloads-scrim'),
    loadingTrack: document.getElementById('loading-track'),
    moreMenuButton: document.getElementById('more-menu-button'),
    offlineMessage: document.getElementById('offline-message'),
    offlineNetwork: document.getElementById('offline-network'),
    offlineRetry: document.getElementById('offline-retry'),
    offlineTitle: document.getElementById('offline-title'),
    offlineWorkspace: document.getElementById('offline-workspace'),
    openDownloadsFolder: document.getElementById('open-downloads-folder'),
  }

  const initialState = {
    navigation: { canGoBack: false, canGoForward: false },
    loading: { active: true },
    network: navigator.onLine ? 'unknown' : 'offline',
    theme: { mode: 'light', forcedColors: false, reduceTransparency: true },
    downloads: [],
    error: null,
    shellMode: 'toolbar',
    zoomFactor: 1,
    overlayActive: false,
  }
  let state = initialState
  let previousMode = initialState.shellMode

  function measureWcoReady(overlayIsActive) {
    if (overlayIsActive !== true) return false
    const probe = document.createElement('div')
    probe.style.position = 'absolute'
    probe.style.width = 'env(titlebar-area-width, -1px)'
    probe.style.height = 'env(titlebar-area-height, -1px)'
    document.body.append(probe)
    const style = getComputedStyle(probe)
    const width = Number.parseFloat(style.width)
    const height = Number.parseFloat(style.height)
    probe.remove()
    return isPositiveTitlebarGeometry(width, height)
  }

  function syncWcoReady() {
    document.documentElement.dataset.wcoReady = String(measureWcoReady(state.overlayActive === true))
    const next = Number.parseInt(document.documentElement.dataset.wcoSyncCount || '0', 10) + 1
    document.documentElement.dataset.wcoSyncCount = String(Number.isFinite(next) ? next : 1)
  }

  function send(type, details = null) {
    try {
      const payload = details ? { type, ...details } : { type }
      return bridge?.send(payload) === true
    } catch {
      renderBridgeFailure()
      return false
    }
  }

  function renderBridgeFailure() {
    elements.connectionStatus.dataset.state = 'offline'
    elements.connectionLabel.textContent = '桌面连接不可用'
  }

  function normalizedState(value) {
    if (!value || typeof value !== 'object') return state
    const navigation =
      value.navigation && typeof value.navigation === 'object' ? value.navigation : {}
    const loading = value.loading && typeof value.loading === 'object' ? value.loading : {}
    const theme = value.theme && typeof value.theme === 'object' ? value.theme : {}
    const error = value.error && typeof value.error === 'object' ? value.error : null
    const shellMode = ['toolbar', 'downloads', 'offline'].includes(value.shellMode)
      ? value.shellMode
      : 'toolbar'
    return {
      navigation: {
        canGoBack: navigation.canGoBack === true,
        canGoForward: navigation.canGoForward === true,
      },
      loading: { active: loading.active === true },
      network: ['online', 'offline', 'unknown'].includes(value.network) ? value.network : 'unknown',
      theme: {
        mode: theme.mode === 'dark' ? 'dark' : 'light',
        forcedColors: theme.forcedColors === true,
        reduceTransparency: theme.reduceTransparency === true,
      },
      downloads: Array.isArray(value.downloads) ? value.downloads.slice(0, 100) : [],
      error:
        error && ['offline', 'load-failed'].includes(error.kind)
          ? {
              kind: error.kind,
              message:
                typeof error.message === 'string' && error.message.length <= 500
                  ? error.message
                  : '请检查网络连接，然后重试。',
            }
          : null,
      shellMode,
      zoomFactor:
        typeof value.zoomFactor === 'number' && Number.isFinite(value.zoomFactor)
          ? value.zoomFactor
          : 1,
      overlayActive: value.overlayActive === true,
    }
  }

  function renderConnection() {
    let label = '正在连接'
    let status = 'unknown'
    if (state.network === 'offline' || state.error?.kind === 'offline') {
      label = '网络已断开'
      status = 'offline'
    } else if (state.loading.active) {
      label = '正在载入'
      status = 'loading'
    } else if (state.error?.kind === 'load-failed') {
      label = '载入失败'
      status = 'offline'
    } else if (state.network === 'online') {
      label = '已连接'
      status = 'online'
    }
    elements.connectionStatus.dataset.state = status
    elements.connectionLabel.textContent = label
    elements.loadingTrack.hidden = !state.loading.active
  }

  function downloadStatus(download) {
    if (download.state === 'completed') return '已完成'
    if (download.state === 'interrupted') return '已中断'
    if (download.state === 'cancelled') return '已取消'
    if (download.state === 'failed') return '文件不可用'
    const progress = download.progress
    if (typeof progress === 'number' && Number.isFinite(progress)) {
      return `${Math.round(Math.min(1, Math.max(0, progress)) * 100)}%`
    }
    return '正在下载'
  }

  function createDownloadItem(download) {
    if (!download || typeof download !== 'object') return null
    if (typeof download.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(download.id)) return null

    const item = document.createElement('li')
    item.className = 'download-item'
    item.dataset.downloadId = download.id
    item.dataset.state = typeof download.state === 'string' ? download.state : 'progressing'

    const icon = document.createElement('span')
    icon.className = 'download-icon'
    icon.setAttribute('aria-hidden', 'true')
    const fileIcon = document.createElement('span')
    fileIcon.className = 'fluent-icon icon-document'
    icon.append(fileIcon)

    const copy = document.createElement('div')
    copy.className = 'download-copy'
    const name = document.createElement('p')
    name.className = 'download-name'
    name.textContent =
      typeof download.name === 'string' && download.name ? download.name.slice(0, 240) : '下载文件'
    name.title = name.textContent
    const meta = document.createElement('div')
    meta.className = 'download-meta'
    const status = document.createElement('span')
    status.textContent = downloadStatus(download)
    meta.append(status)

    if (download.state === 'progressing') {
      const progress = document.createElement('progress')
      progress.max = 1
      if (typeof download.progress === 'number' && Number.isFinite(download.progress)) {
        progress.value = Math.min(1, Math.max(0, download.progress))
      }
      progress.setAttribute('aria-label', `${name.textContent} 下载进度`)
      meta.prepend(progress)
    }
    copy.append(name, meta)
    item.append(icon, copy)

    if (download.canShow === true && download.state === 'completed') {
      const showButton = document.createElement('button')
      showButton.className = 'show-download-button'
      showButton.type = 'button'
      showButton.textContent = '显示位置'
      showButton.setAttribute('aria-label', `在文件夹中显示 ${name.textContent}`)
      showButton.addEventListener('click', () => send('show-download', { id: download.id }))
      item.append(showButton)
    }
    return item
  }

  function renderDownloads() {
    const focusedElement = document.activeElement
    const focusedDownloadId = focusedElement
      ?.closest?.('.download-item')
      ?.getAttribute('data-download-id')
    const restoreDownloadAction = focusedElement?.classList?.contains('show-download-button')
    const focusWasInDialog = elements.downloadsDialog.contains(focusedElement)
    const fragment = document.createDocumentFragment()
    let renderedCount = 0
    for (const download of state.downloads) {
      const item = createDownloadItem(download)
      if (!item) continue
      fragment.append(item)
      renderedCount += 1
    }
    elements.downloadsList.replaceChildren(fragment)
    elements.downloadsEmpty.hidden = renderedCount !== 0
    elements.downloadsBadge.hidden = renderedCount === 0
    elements.downloadsBadge.textContent = renderedCount > 99 ? '99+' : String(renderedCount)
    elements.downloadsButton.setAttribute(
      'aria-label',
      renderedCount === 0 ? '下载，没有记录' : `下载，${renderedCount} 项记录`,
    )

    if (state.shellMode !== 'downloads' || !focusWasInDialog) return
    if (restoreDownloadAction && focusedDownloadId) {
      const restoredItem = [...elements.downloadsList.querySelectorAll('.download-item')].find(
        (item) => item.dataset.downloadId === focusedDownloadId,
      )
      const restoredAction = restoredItem?.querySelector('.show-download-button')
      if (restoredAction) {
        restoredAction.focus()
        return
      }
    }
    if (!elements.downloadsDialog.contains(document.activeElement)) elements.downloadsClose.focus()
  }

  function renderMode() {
    const mode = state.shellMode
    document.body.dataset.shellMode = mode
    const downloadsOpen = mode === 'downloads'
    const offlineOpen = mode === 'offline'
    elements.downloadsLayer.hidden = !downloadsOpen
    elements.downloadsButton.setAttribute('aria-expanded', String(downloadsOpen))
    elements.downloadsButton.disabled = offlineOpen
    elements.moreMenuButton.disabled = mode !== 'toolbar'
    elements.offlineWorkspace.hidden = !offlineOpen

    if (offlineOpen) {
      elements.offlineTitle.textContent =
        state.error?.kind === 'load-failed' ? '页面加载失败' : '暂时无法连接'
      elements.offlineMessage.textContent = state.error?.message || '请检查网络连接，然后重试。'
      elements.offlineNetwork.textContent =
        state.error?.kind === 'load-failed'
          ? '网络可能可用，但产品页面未能完成加载。'
          : state.network === 'online'
            ? '网络已恢复，可以重新连接。'
            : state.network === 'offline'
              ? 'Windows 当前显示为离线。'
              : '正在检查网络状态。'
    }

    if (mode !== previousMode) {
      previousMode = mode
      const modalFocusTarget = downloadsOpen
        ? elements.downloadsClose
        : offlineOpen
          ? elements.offlineRetry
          : null
      modalFocusTarget?.focus({ preventScroll: true })
      queueMicrotask(() => {
        if (state.shellMode === mode && modalFocusTarget && document.activeElement !== modalFocusTarget) {
          modalFocusTarget.focus({ preventScroll: true })
        }
      })
    }
  }

  function render(nextState) {
    state = normalizedState(nextState)
    document.documentElement.dataset.theme = state.theme.mode
    document.documentElement.dataset.forcedColors = String(state.theme.forcedColors)
    document.documentElement.dataset.reduceTransparency = String(state.theme.reduceTransparency)
    document.documentElement.dataset.overlayActive = String(state.overlayActive === true)
    syncWcoReady()
    const transparencyAllowed = !state.theme.forcedColors && !state.theme.reduceTransparency
    elements.commandSurface.classList.toggle('allow-transparency', transparencyAllowed)
    elements.commandSurface.classList.toggle('reduce-transparency', !transparencyAllowed)
    renderConnection()
    renderDownloads()
    renderMode()
  }

  function closeDownloads() {
    if (state.shellMode === 'downloads') send('downloads-close')
  }

  elements.downloadsButton.addEventListener('click', () => {
    send(state.shellMode === 'downloads' ? 'downloads-close' : 'downloads-open')
  })
  elements.moreMenuButton.addEventListener('click', () => send('open-more-menu'))
  elements.downloadsClose.addEventListener('click', closeDownloads)
  elements.downloadsScrim.addEventListener('click', closeDownloads)
  elements.openDownloadsFolder.addEventListener('click', () => send('open-downloads-folder'))
  elements.offlineRetry.addEventListener('click', () => send('reload'))

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.shellMode === 'downloads') {
      event.preventDefault()
      closeDownloads()
    }
    if (event.key === 'Tab' && state.shellMode === 'downloads') {
      const focusable = [
        ...elements.downloadsDialog.querySelectorAll('button:not(:disabled), [tabindex="0"]'),
      ]
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
  })

  window.addEventListener('offline', () => render({ ...state, network: 'offline' }))
  window.addEventListener('online', () => render({ ...state, network: 'online' }))
  attachWcoGeometryListeners({
    window,
    overlay: globalThis.navigator?.windowControlsOverlay,
    onChange: syncWcoReady,
  })

  render(initialState)
  document.documentElement.dataset.initialTransparencyAllowed = String(
    elements.commandSurface.classList.contains('allow-transparency'),
  )
  if (!bridge || typeof bridge.send !== 'function' || typeof bridge.subscribe !== 'function') {
    renderBridgeFailure()
    return
  }
  bridge.subscribe(render)
  send('ready')
}
