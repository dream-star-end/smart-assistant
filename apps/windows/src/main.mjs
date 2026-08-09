import assert from 'node:assert/strict'
import { stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  BaseWindow,
  BrowserWindow,
  Menu,
  WebContentsView,
  app,
  dialog,
  ipcMain,
  nativeTheme,
  protocol,
  screen,
  shell,
} from 'electron'

import { DownloadRegistry, taskbarProgressState } from './download-registry.mjs'
import { IPC_CHANNELS, isTrustedShellEvent, parseShellCommand } from './ipc-contract.mjs'
import { permissionDecision } from './permission-adapter.mjs'
import {
  PRODUCT_PARTITION,
  SMOKE_PRODUCT_PARTITION,
  closeWebContentsView,
  createProductView,
  productWebPreferences,
} from './product-view.mjs'
import {
  PINNED_APP_ORIGIN,
  classifyDownload,
  classifyTopLevelNavigation,
  classifyWindowOpen,
  downloadRisk,
  isOAuthFinalLanding,
  isOAuthReturn,
  isPinnedOrigin,
  resolveStartUrl,
  sanitizeWindowsFilename,
} from './security-policy.mjs'
import { canOpenDownloads, shellModeAfterDownloadsClose } from './shell-mode.mjs'
import {
  SHELL_ORIGIN,
  SHELL_URL,
  SMOKE_PRODUCT_ROUTE_URL,
  SMOKE_PRODUCT_URL,
  registerShellProtocol,
  registerShellScheme,
} from './shell-protocol.mjs'
import { TOOLBAR_HEIGHT, calculateViewBounds } from './window-layout.mjs'
import {
  DEFAULT_WINDOW_STATE,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  WindowStateStore,
  fitAuxiliaryWindowBounds,
  recoverWindowToWorkAreas,
} from './window-state.mjs'
import {
  applyWindowsAppearance,
  handleDesktopShortcut,
  installJumpList,
  parseLaunchIntent,
} from './windows-integration.mjs'

const APP_ID = 'chat.claudeai.aurora'
const APP_NAME = 'OpenClaude Aurora'
const SHELL_PARTITION = 'openclaude-v5-shell-v1'
const SMOKE_TIMEOUT_MS = 15_000
const ZOOM_MIN = 0.5
const ZOOM_MAX = 3
const ZOOM_STEP = 0.1
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SHELL_PRELOAD_PATH = path.join(__dirname, 'shell-preload.cjs')
const smokeTest = process.argv.includes('--smoke-test')

registerShellScheme(protocol)
app.enableSandbox()
app.setName(APP_NAME)
if (process.platform === 'win32') app.setAppUserModelId(APP_ID)

let mainWindow = null
let shellView = null
let productView = null
let productWebContents = null
let authWindow = null
let shellReady = false
let activeStartUrl = null
let shellMode = 'toolbar'
let windowStateStore = null
let detachWindowState = null
let removeWindowListeners = null
let creatingMainWindow = null

const viewerWindows = new Set()
const configuredProductSessions = new WeakSet()
const configuredShellSessions = new WeakSet()
const protocolSessions = new WeakSet()
const downloads = new DownloadRegistry()
const activeDownloadProgress = new Map()
const productState = {
  loading: false,
  network: 'unknown',
  error: null,
}

function isAlive(value) {
  return Boolean(value && !value.isDestroyed())
}

function originOf(value) {
  try {
    return new URL(value).origin
  } catch {
    return ''
  }
}

function shellWebPreferences() {
  return {
    partition: SHELL_PARTITION,
    preload: SHELL_PRELOAD_PATH,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    plugins: false,
    experimentalFeatures: false,
    enableWebSQL: false,
    navigateOnDragDrop: false,
    safeDialogs: true,
    safeDialogsMessage: '此页面正在尝试创建更多对话框。',
    devTools: !app.isPackaged,
  }
}

function ensureShellProtocol(desktopSession) {
  if (protocolSessions.has(desktopSession)) return
  registerShellProtocol(desktopSession.protocol)
  protocolSessions.add(desktopSession)
}

function configureShellSession(desktopSession) {
  if (configuredShellSessions.has(desktopSession)) return
  desktopSession.setPermissionCheckHandler(() => false)
  desktopSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false)
  })
  desktopSession.setDevicePermissionHandler(() => false)
  desktopSession.setDisplayMediaRequestHandler((_request, callback) => callback({}))
  configuredShellSessions.add(desktopSession)
}

function installWebContentsHardening(webContents) {
  webContents.on('will-attach-webview', (event) => event.preventDefault())
  webContents.on('select-bluetooth-device', (event, _devices, callback) => {
    event.preventDefault()
    callback('')
  })
}

function installShellHardening(webContents) {
  installWebContentsHardening(webContents)
  webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  webContents.on('will-navigate', (event, targetUrl) => {
    if (targetUrl !== SHELL_URL) event.preventDefault()
  })
  webContents.on('will-redirect', (event, targetUrl, _isInPlace, isMainFrame) => {
    if (isMainFrame && targetUrl !== SHELL_URL) event.preventDefault()
  })
}

function showMessage(owner, options) {
  if (isAlive(owner)) return dialog.showMessageBox(owner, options)
  return dialog.showMessageBox(options)
}

function showMessageSync(owner, options) {
  if (isAlive(owner)) return dialog.showMessageBoxSync(owner, options)
  return dialog.showMessageBoxSync(options)
}

function openExternal(targetUrl) {
  void shell.openExternal(targetUrl, { activate: true }).catch(() => {
    void showMessage(mainWindow, {
      type: 'error',
      title: APP_NAME,
      message: '无法打开外部链接',
      detail: '请确认系统已配置可用的默认浏览器或邮件应用。',
    })
  })
}

function installWindowOpenPolicy(webContents, windowKind, appOrigin) {
  webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    const action = classifyWindowOpen({
      windowKind,
      currentUrl: webContents.getURL(),
      targetUrl,
      appOrigin,
    })

    if (action === 'blob-view') createBlobViewer(targetUrl, appOrigin)
    if (action === 'external') openExternal(targetUrl)
    return { action: 'deny' }
  })
}

function installAuxiliaryWindowRecovery(window) {
  const recover = () => recoverWindowToWorkAreas(window, screen.getAllDisplays())
  for (const eventName of ['display-added', 'display-removed', 'display-metrics-changed']) {
    screen.on(eventName, recover)
  }
  window.once('closed', () => {
    for (const eventName of ['display-added', 'display-removed', 'display-metrics-changed']) {
      screen.removeListener(eventName, recover)
    }
  })
}

function createBlobViewer(targetUrl, appOrigin) {
  if (!isAlive(mainWindow)) return

  const viewerBounds = fitAuxiliaryWindowBounds(screen.getDisplayMatching(mainWindow.getBounds()), {
    width: 1040,
    height: 760,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
  })

  const viewer = new BrowserWindow({
    parent: mainWindow,
    ...viewerBounds,
    show: false,
    autoHideMenuBar: true,
    title: `${APP_NAME} - 预览`,
    backgroundColor: '#0c0c11',
    webPreferences: productWebPreferences({
      partition: PRODUCT_PARTITION,
      devTools: !app.isPackaged,
    }),
  })
  viewerWindows.add(viewer)
  installAuxiliaryWindowRecovery(viewer)
  installWebContentsHardening(viewer.webContents)
  installWindowOpenPolicy(viewer.webContents, 'viewer', appOrigin)
  viewer.webContents.on('page-title-updated', (event) => event.preventDefault())

  viewer.webContents.on('will-navigate', (event, navigationUrl) => {
    event.preventDefault()
    const action = classifyWindowOpen({
      windowKind: 'viewer',
      currentUrl: viewer.webContents.getURL(),
      targetUrl: navigationUrl,
      appOrigin,
    })
    if (action === 'external') openExternal(navigationUrl)
  })
  viewer.once('ready-to-show', () => viewer.show())
  viewer.once('closed', () => viewerWindows.delete(viewer))
  void viewer.loadURL(targetUrl).catch(() => {
    if (!viewer.isDestroyed()) viewer.destroy()
  })
}

function handleNavigation(webContents, windowKind, targetUrl, event, appOrigin) {
  const action = classifyTopLevelNavigation({
    windowKind,
    currentUrl: webContents.getURL(),
    targetUrl,
    appOrigin,
  })

  if (action === 'allow' || action === 'oauth-return' || action === 'oauth-final') return action

  event.preventDefault()
  if (action === 'oauth') openOAuthWindow(targetUrl, appOrigin)
  if (action === 'external') openExternal(targetUrl)
  return action
}

function installNavigationPolicy(webContents, windowKind, appOrigin) {
  webContents.on('will-navigate', (event, targetUrl) => {
    handleNavigation(webContents, windowKind, targetUrl, event, appOrigin)
  })
  webContents.on('will-redirect', (event, targetUrl, _isInPlace, isMainFrame) => {
    if (isMainFrame) handleNavigation(webContents, windowKind, targetUrl, event, appOrigin)
  })
}

function openOAuthWindow(authorizeUrl, appOrigin) {
  if (!isAlive(mainWindow)) return
  if (authWindow && !authWindow.isDestroyed()) {
    authWindow.focus()
    return
  }

  let callbackSeen = false
  let completed = false
  const oauthBounds = fitAuxiliaryWindowBounds(screen.getDisplayMatching(mainWindow.getBounds()), {
    width: 760,
    height: 820,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
  })
  const oauth = new BrowserWindow({
    parent: mainWindow,
    ...oauthBounds,
    show: false,
    autoHideMenuBar: true,
    title: `${APP_NAME} - 安全授权`,
    backgroundColor: '#0c0c11',
    webPreferences: productWebPreferences({
      partition: PRODUCT_PARTITION,
      devTools: !app.isPackaged,
    }),
  })
  authWindow = oauth
  installAuxiliaryWindowRecovery(oauth)
  installWebContentsHardening(oauth.webContents)
  installNavigationPolicy(oauth.webContents, 'auth', appOrigin)
  installWindowOpenPolicy(oauth.webContents, 'auth', appOrigin)

  oauth.webContents.on('did-start-navigation', (_event, targetUrl, _isInPlace, isMainFrame) => {
    if (isMainFrame && isOAuthReturn(targetUrl, appOrigin)) callbackSeen = true
  })
  oauth.webContents.on('will-redirect', (_event, targetUrl, _isInPlace, isMainFrame) => {
    if (isMainFrame && isOAuthReturn(targetUrl, appOrigin)) callbackSeen = true
  })
  oauth.webContents.on('page-title-updated', (event) => event.preventDefault())
  oauth.webContents.on('did-navigate', (_event, targetUrl) => {
    try {
      oauth.setTitle(`${APP_NAME} - ${new URL(targetUrl).hostname}`)
    } catch {
      oauth.setTitle(`${APP_NAME} - 安全授权`)
    }

    if (!completed && callbackSeen && isOAuthFinalLanding(targetUrl, appOrigin)) {
      completed = true
      void loadProductUrl(targetUrl).finally(() => {
        if (!oauth.isDestroyed()) oauth.close()
      })
    }
  })
  oauth.once('ready-to-show', () => oauth.show())
  oauth.once('closed', () => {
    if (authWindow === oauth) authWindow = null
  })
  void oauth.loadURL(authorizeUrl).catch(() => {
    if (!oauth.isDestroyed()) oauth.close()
    void showMessage(mainWindow, {
      type: 'error',
      title: APP_NAME,
      message: '无法打开授权页面',
      detail: '请检查网络连接后重试。',
    })
  })
}

function installPermissionPolicy(desktopSession, appOrigin) {
  desktopSession.setPermissionCheckHandler(
    (webContents, permission, requestingOrigin, details = {}) =>
      permissionDecision({
        webContents,
        mainWebContents: productWebContents,
        permission,
        details,
        appOrigin,
        checkOrigin: requestingOrigin,
      }) === 'allow',
  )
  desktopSession.setPermissionRequestHandler((webContents, permission, callback, details = {}) => {
    callback(
      permissionDecision({
        webContents,
        mainWebContents: productWebContents,
        permission,
        details,
        appOrigin,
      }) === 'allow',
    )
  })
  desktopSession.setDevicePermissionHandler(() => false)
  desktopSession.setDisplayMediaRequestHandler((_request, callback) => callback({}))
}

function isTrustedDownloadContext(webContents, appOrigin) {
  if (!webContents || webContents.isDestroyed()) return false
  if (webContents === productWebContents) return isPinnedOrigin(webContents.getURL(), appOrigin)
  for (const viewer of viewerWindows) {
    if (!viewer.isDestroyed() && viewer.webContents === webContents) {
      return classifyDownload(webContents.getURL(), appOrigin) === 'allow'
    }
  }
  return false
}

function publicDownloads() {
  return downloads.list().map((entry) => ({
    id: entry.id,
    name: entry.fileName,
    state: entry.state,
    progress: entry.totalBytes > 0 ? Math.min(1, entry.receivedBytes / entry.totalBytes) : null,
    canShow: downloads.resolveCompletedPath(entry.id) !== null,
  }))
}

function installDownloadPolicy(desktopSession, appOrigin) {
  desktopSession.on('will-download', (event, item, webContents) => {
    const urlChain = item.getURLChain?.() ?? []
    const candidateUrls = [...urlChain, item.getURL()].filter(Boolean)
    const allowed =
      isTrustedDownloadContext(webContents, appOrigin) &&
      candidateUrls.length > 0 &&
      candidateUrls.every((targetUrl) => classifyDownload(targetUrl, appOrigin) === 'allow')
    if (!allowed) {
      event.preventDefault()
      return
    }

    const owner = BrowserWindow.fromWebContents(webContents) || mainWindow
    const filename = sanitizeWindowsFilename(item.getFilename())
    if (
      downloadRisk(filename) === 'dangerous' &&
      showMessageSync(owner, {
        type: 'warning',
        title: '危险文件类型',
        message: `“${filename}” 可能运行程序或脚本。`,
        detail: '只有在你确认文件来源和用途时才继续。OpenClaude 不会自动打开它。',
        buttons: ['取消', '仍然下载'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      }) !== 1
    ) {
      event.preventDefault()
      return
    }

    item.setSaveDialogOptions({
      title: '保存 OpenClaude 下载',
      defaultPath: path.join(app.getPath('downloads'), filename),
      buttonLabel: '保存',
    })

    const id = downloads.register({ fileName: filename, totalBytes: item.getTotalBytes() })
    activeDownloadProgress.set(id, {
      state: 'progressing',
      receivedBytes: 0,
      totalBytes: item.getTotalBytes(),
    })
    updateTaskbarProgress()
    pushShellState()
    item.on('updated', (_updateEvent, state) => {
      const receivedBytes = item.getReceivedBytes()
      const totalBytes = item.getTotalBytes()
      downloads.update(id, { receivedBytes, totalBytes })
      activeDownloadProgress.set(id, { state, receivedBytes, totalBytes })
      updateTaskbarProgress()
      pushShellState()
    })
    item.once('done', (_doneEvent, state) => {
      if (state === 'completed') {
        downloads.complete(id, {
          filePath: item.getSavePath(),
          receivedBytes: item.getReceivedBytes(),
          totalBytes: item.getTotalBytes(),
        })
      } else {
        downloads.fail(id, state === 'cancelled' ? 'cancelled' : 'interrupted')
      }
      activeDownloadProgress.delete(id)
      updateTaskbarProgress()
      pushShellState()
    })
  })
}

function updateTaskbarProgress() {
  if (!isAlive(mainWindow)) return
  const progress = taskbarProgressState(activeDownloadProgress.values())
  mainWindow.setProgressBar(progress.value, progress.options)
}

function configureProductSession(desktopSession, appOrigin) {
  if (configuredProductSessions.has(desktopSession)) return
  installPermissionPolicy(desktopSession, appOrigin)
  installDownloadPolicy(desktopSession, appOrigin)
  configuredProductSessions.add(desktopSession)
}

function navigationSnapshot() {
  if (!productWebContents || productWebContents.isDestroyed()) {
    return { canGoBack: false, canGoForward: false }
  }
  try {
    return {
      canGoBack: productWebContents.navigationHistory.canGoBack(),
      canGoForward: productWebContents.navigationHistory.canGoForward(),
    }
  } catch {
    return { canGoBack: false, canGoForward: false }
  }
}

function shellStateSnapshot() {
  const dark = nativeTheme.shouldUseDarkColors === true
  let zoomFactor = 1
  try {
    if (productWebContents && !productWebContents.isDestroyed()) {
      zoomFactor = productWebContents.getZoomFactor()
    }
  } catch {
    zoomFactor = 1
  }
  return {
    navigation: navigationSnapshot(),
    loading: { active: productState.loading },
    network: productState.network,
    theme: {
      mode: dark ? 'dark' : 'light',
      forcedColors:
        nativeTheme.inForcedColorsMode === true || nativeTheme.shouldUseHighContrastColors === true,
      reduceTransparency: nativeTheme.prefersReducedTransparency === true,
    },
    downloads: publicDownloads(),
    error: productState.error,
    shellMode,
    zoomFactor,
  }
}

function pushShellState() {
  const shellWebContents = shellView?.webContents
  if (!shellReady || !shellWebContents || shellWebContents.isDestroyed()) return
  shellWebContents.send(IPC_CHANNELS.state, shellStateSnapshot())
}

function layoutViews() {
  if (!isAlive(mainWindow) || !shellView || !productView) return
  const bounds = mainWindow.getContentBounds()
  const layout = calculateViewBounds(bounds, { shellMode })
  productView.setBounds(layout.product)
  shellView.setBounds(layout.shell)
}

function setShellMode(nextMode) {
  const normalized = ['toolbar', 'downloads', 'offline'].includes(nextMode) ? nextMode : 'toolbar'
  if (shellMode === normalized) {
    if (normalized !== 'toolbar') focusShell()
    pushShellState()
    return
  }
  shellMode = normalized
  layoutViews()
  if (normalized !== 'toolbar') focusShell()
  pushShellState()
}

function markProductLoading() {
  productState.loading = true
  pushShellState()
}

function markProductReady() {
  productState.loading = false
  productState.network = 'online'
  productState.error = null
  const recoveredFromOffline = shellMode === 'offline'
  if (recoveredFromOffline) shellMode = 'toolbar'
  layoutViews()
  if (recoveredFromOffline) focusProduct()
  pushShellState()
}

function markProductFailed(kind = 'load-failed') {
  productState.loading = false
  productState.network = kind === 'offline' ? 'offline' : 'unknown'
  productState.error = {
    kind,
    message:
      kind === 'offline' ? '网络连接不可用，请检查后重试。' : '产品页面暂时无法加载，请重试。',
  }
  setShellMode('offline')
}

function focusShell() {
  const shellWebContents = shellView?.webContents
  if (!shellWebContents || shellWebContents.isDestroyed()) return false
  shellWebContents.focus()
  return true
}

function focusProduct() {
  if (!productWebContents || productWebContents.isDestroyed()) return false
  productWebContents.focus()
  return true
}

function goBack() {
  const history = productWebContents?.navigationHistory
  if (!history?.canGoBack()) return false
  history.goBack()
  focusProduct()
  return true
}

function goForward() {
  const history = productWebContents?.navigationHistory
  if (!history?.canGoForward()) return false
  history.goForward()
  focusProduct()
  return true
}

function reloadProduct() {
  if (!productWebContents || productWebContents.isDestroyed()) return false
  markProductLoading()
  productWebContents.reload()
  focusProduct()
  return true
}

function homeProduct() {
  if (!activeStartUrl || !productWebContents || productWebContents.isDestroyed()) return false
  if (shellMode === 'downloads') setShellMode('toolbar')
  void loadProductUrl(activeStartUrl)
  focusProduct()
  return true
}

function setProductZoom(nextFactor) {
  if (!productWebContents || productWebContents.isDestroyed()) return false
  const normalized = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Number(nextFactor.toFixed(2))))
  productWebContents.setZoomFactor(normalized)
  pushShellState()
  focusProduct()
  return true
}

function adjustProductZoom(delta) {
  if (!productWebContents || productWebContents.isDestroyed()) return false
  return setProductZoom(productWebContents.getZoomFactor() + delta)
}

function desktopActions() {
  return {
    back: goBack,
    forward: goForward,
    reload: reloadProduct,
    zoomIn: () => adjustProductZoom(ZOOM_STEP),
    zoomOut: () => adjustProductZoom(-ZOOM_STEP),
    zoomReset: () => setProductZoom(1),
  }
}

function openDownloadsFolder() {
  void shell.openPath(app.getPath('downloads')).then((errorMessage) => {
    if (!errorMessage) return
    void showMessage(mainWindow, {
      type: 'error',
      title: APP_NAME,
      message: '无法打开下载文件夹',
      detail: errorMessage,
    })
  })
}

async function showRegisteredDownload(id) {
  const filePath = downloads.resolveCompletedPath(id)
  if (!filePath) return false
  try {
    const metadata = await stat(filePath)
    if (!metadata.isFile()) throw new Error('registered download is no longer a file')
    shell.showItemInFolder(filePath)
    return true
  } catch {
    downloads.fail(id, 'failed')
    pushShellState()
    return false
  }
}

function executeShellCommand(command) {
  switch (command.type) {
    case 'ready':
      pushShellState()
      return true
    case 'back':
      return goBack()
    case 'forward':
      return goForward()
    case 'reload':
      return reloadProduct()
    case 'home':
      return homeProduct()
    case 'focus-product':
      return focusProduct()
    case 'downloads-open':
      if (!canOpenDownloads(productState)) return false
      setShellMode('downloads')
      return true
    case 'downloads-close': {
      const nextMode = shellModeAfterDownloadsClose(productState)
      setShellMode(nextMode)
      if (nextMode === 'toolbar') focusProduct()
      return true
    }
    case 'open-downloads-folder':
      openDownloadsFolder()
      return true
    case 'show-download': {
      void showRegisteredDownload(command.id)
      return downloads.resolveCompletedPath(command.id) !== null
    }
    case 'zoom-in':
      return adjustProductZoom(ZOOM_STEP)
    case 'zoom-out':
      return adjustProductZoom(-ZOOM_STEP)
    case 'zoom-reset':
      return setProductZoom(1)
    default:
      return false
  }
}

function onShellCommand(event, payload) {
  const shellWebContents = shellView?.webContents
  if (!shellWebContents || !isTrustedShellEvent(event, shellWebContents, SHELL_ORIGIN)) return
  const command = parseShellCommand(payload)
  if (!command) return
  executeShellCommand(command)
}

function installProductEvents(webContents, { appOrigin, isSmoke }) {
  installWebContentsHardening(webContents)
  installWindowOpenPolicy(webContents, 'main', appOrigin)
  if (!isSmoke) installNavigationPolicy(webContents, 'main', appOrigin)

  webContents.on('did-start-loading', markProductLoading)
  webContents.on('did-stop-loading', () => {
    productState.loading = false
    pushShellState()
  })
  webContents.on('did-finish-load', markProductReady)
  webContents.on('did-navigate', pushShellState)
  webContents.on('did-navigate-in-page', pushShellState)
  webContents.on('did-fail-load', (_event, errorCode, _description, validatedUrl, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return
    if (isSmoke || isPinnedOrigin(validatedUrl, appOrigin)) {
      const offlineCodes = new Set([-2, -6, -7, -21, -105, -106, -109])
      markProductFailed(offlineCodes.has(errorCode) ? 'offline' : 'load-failed')
    }
  })
  webContents.on('render-process-gone', () => markProductFailed('load-failed'))
  webContents.on('before-input-event', (event, input) => {
    if (handleDesktopShortcut(input, desktopActions())) event.preventDefault()
  })
}

async function loadProductUrl(targetUrl, { throwOnFailure = false } = {}) {
  if (!productWebContents || productWebContents.isDestroyed()) return false
  markProductLoading()
  try {
    await productWebContents.loadURL(targetUrl)
    return true
  } catch (error) {
    if (!productState.error) markProductFailed('load-failed')
    if (throwOnFailure) throw error
    return false
  }
}

function installWindowLifecycle(window, localShellView, localProductView) {
  const relayout = () => layoutViews()
  const updateAppearance = () => {
    const reduceTransparency = nativeTheme.prefersReducedTransparency === true
    applyWindowsAppearance({
      window,
      nativeTheme,
      platform: process.platform,
      systemVersion: process.getSystemVersion?.() ?? os.release(),
      transparencyEnabled: !reduceTransparency,
      reduceTransparency,
    })
    pushShellState()
  }
  const onDisplayChanged = () => {
    recoverWindowToWorkAreas(window, screen.getAllDisplays())
    layoutViews()
  }
  const onAppCommand = (_event, command) => {
    if (command === 'browser-backward') goBack()
    if (command === 'browser-forward') goForward()
  }

  for (const eventName of [
    'resize',
    'maximize',
    'unmaximize',
    'enter-full-screen',
    'leave-full-screen',
  ]) {
    window.on(eventName, relayout)
  }
  window.on('app-command', onAppCommand)
  screen.on('display-added', onDisplayChanged)
  screen.on('display-removed', onDisplayChanged)
  screen.on('display-metrics-changed', onDisplayChanged)
  nativeTheme.on('updated', updateAppearance)
  updateAppearance()

  removeWindowListeners = () => {
    for (const eventName of [
      'resize',
      'maximize',
      'unmaximize',
      'enter-full-screen',
      'leave-full-screen',
    ]) {
      window.removeListener(eventName, relayout)
    }
    window.removeListener('app-command', onAppCommand)
    screen.removeListener('display-added', onDisplayChanged)
    screen.removeListener('display-removed', onDisplayChanged)
    screen.removeListener('display-metrics-changed', onDisplayChanged)
    nativeTheme.removeListener('updated', updateAppearance)
  }

  window.once('close', () => {
    if (authWindow && !authWindow.isDestroyed()) authWindow.close()
    for (const viewer of viewerWindows) {
      if (!viewer.isDestroyed()) viewer.close()
    }
  })
  window.once('closed', () => {
    removeWindowListeners?.()
    removeWindowListeners = null
    detachWindowState?.()
    detachWindowState = null
    if (windowStateStore) {
      void windowStateStore.flush().catch(() => {})
      windowStateStore.dispose()
      windowStateStore = null
    }

    closeWebContentsView(localShellView)
    closeWebContentsView(localProductView)
    downloads.clear()
    shellReady = false
    if (mainWindow === window) mainWindow = null
    if (shellView === localShellView) shellView = null
    if (productView === localProductView) productView = null
    if (productWebContents === localProductView.webContents) productWebContents = null
  })
}

async function createMainWindow({ startUrl, appOrigin, isSmoke = false } = {}) {
  activeStartUrl = startUrl
  shellMode = 'toolbar'
  productState.loading = true
  productState.network = 'unknown'
  productState.error = null

  let initialState = { ...DEFAULT_WINDOW_STATE }
  if (isSmoke) {
    initialState = { width: 1000, height: 700, maximized: false }
  } else {
    windowStateStore = new WindowStateStore({
      userDataPath: app.getPath('userData'),
      onError: (error) => console.error('[windows] window state save failed:', error.message),
    })
    initialState = await windowStateStore.load({ workAreas: screen.getAllDisplays() })
  }

  const window = new BaseWindow({
    ...(Number.isFinite(initialState.x) ? { x: initialState.x } : {}),
    ...(Number.isFinite(initialState.y) ? { y: initialState.y } : {}),
    width: initialState.width,
    height: initialState.height,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    show: false,
    autoHideMenuBar: true,
    title: APP_NAME,
    backgroundColor: '#202020',
  })
  window.accessibleTitle = APP_NAME
  mainWindow = window

  const localProductView = createProductView({
    partition: isSmoke ? SMOKE_PRODUCT_PARTITION : PRODUCT_PARTITION,
    devTools: !app.isPackaged,
  })
  const localShellView = new WebContentsView({ webPreferences: shellWebPreferences() })
  localShellView.setBackgroundColor('#00000000')
  productView = localProductView
  shellView = localShellView
  productWebContents = localProductView.webContents

  const shellSession = localShellView.webContents.session
  ensureShellProtocol(shellSession)
  configureShellSession(shellSession)
  if (isSmoke) ensureShellProtocol(localProductView.webContents.session)
  configureProductSession(localProductView.webContents.session, appOrigin)

  installShellHardening(localShellView.webContents)
  installProductEvents(localProductView.webContents, { appOrigin, isSmoke })
  localShellView.webContents.on('before-input-event', (event, input) => {
    if (handleDesktopShortcut(input, desktopActions())) event.preventDefault()
  })
  localShellView.webContents.on('did-finish-load', () => {
    shellReady = true
    pushShellState()
  })

  window.contentView.addChildView(localProductView)
  window.contentView.addChildView(localShellView)
  layoutViews()
  installWindowLifecycle(window, localShellView, localProductView)
  if (windowStateStore) detachWindowState = windowStateStore.attach(window)
  if (initialState.maximized) window.maximize()

  const productLoad = loadProductUrl(startUrl, { throwOnFailure: isSmoke })
  try {
    await localShellView.webContents.loadURL(SHELL_URL)
  } catch (error) {
    window.close()
    throw error
  }
  if (!window.isDestroyed()) {
    window.show()
    window.focus()
  }
  if (isSmoke) await productLoad
  else void productLoad

  return { window, shellView: localShellView, productView: localProductView }
}

function waitForCondition(check, message, timeoutMs = 4_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    const poll = async () => {
      try {
        if (await check()) {
          resolve()
          return
        }
      } catch (error) {
        reject(error)
        return
      }
      if (Date.now() >= deadline) {
        reject(new Error(message))
        return
      }
      setTimeout(poll, 25)
    }
    void poll()
  })
}

function waitForWebContentsEvent(webContents, eventName, timeoutMs = 4_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      webContents.removeListener(eventName, onEvent)
      reject(new Error(`timed out waiting for ${eventName}`))
    }, timeoutMs)
    const onEvent = (...args) => {
      clearTimeout(timeout)
      resolve(args)
    }
    webContents.once(eventName, onEvent)
  })
}

async function runSmokeContract() {
  const context = await createMainWindow({
    startUrl: SMOKE_PRODUCT_URL,
    appOrigin: PINNED_APP_ORIGIN,
    isSmoke: true,
  })
  const { window, shellView: smokeShellView, productView: smokeProductView } = context
  const shellContents = smokeShellView.webContents
  const productContents = smokeProductView.webContents

  assert.notStrictEqual(shellContents.session, productContents.session)
  assert.equal(window.contentView.children.length, 2)
  assert.strictEqual(window.contentView.children[0], smokeProductView)
  assert.strictEqual(window.contentView.children[1], smokeShellView)

  const bridgeShape = await shellContents.executeJavaScript(`(() => {
    const bridge = window.auroraDesktop
    window.__auroraSmokeStates = []
    window.__auroraSmokeUnsubscribe = bridge.subscribe((state) => {
      window.__auroraSmokeStates.push(state)
    })
    bridge.send({ type: 'ready' })
    return {
      frozen: Object.isFrozen(bridge),
      keys: Object.keys(bridge).sort(),
      send: typeof bridge.send,
      subscribe: typeof bridge.subscribe,
    }
  })()`)
  assert.equal(bridgeShape.frozen, true)
  assert.deepEqual(bridgeShape.keys, ['send', 'subscribe'])
  assert.equal(bridgeShape.send, 'function')
  assert.equal(bridgeShape.subscribe, 'function')
  await waitForCondition(
    () => shellContents.executeJavaScript('window.__auroraSmokeStates.length > 0'),
    'trusted shell did not receive an initial state snapshot',
  )

  await shellContents.executeJavaScript(`(() => {
    window.__auroraReducedTransparencyProbe = new Promise((resolve, reject) => {
      let timer
      const observer = new MutationObserver(() => capture())
      const capture = () => {
        if (document.documentElement.dataset.reduceTransparency !== 'true') return
        const style = getComputedStyle(document.querySelector('.command-surface'))
        observer.disconnect()
        clearTimeout(timer)
        resolve({
          attribute: document.documentElement.dataset.reduceTransparency,
          backdropFilter: style.backdropFilter,
          backgroundColor: style.backgroundColor,
        })
      }
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-reduce-transparency'],
      })
      timer = setTimeout(() => {
        observer.disconnect()
        reject(new Error('reduced-transparency state was not observed'))
      }, 2000)
      capture()
    })
  })()`)
  shellContents.send(IPC_CHANNELS.state, {
    ...shellStateSnapshot(),
    theme: { mode: 'dark', forcedColors: false, reduceTransparency: true },
  })
  const reducedTransparencyStyle = await shellContents.executeJavaScript(
    'window.__auroraReducedTransparencyProbe',
  )
  assert.equal(reducedTransparencyStyle.attribute, 'true')
  assert.equal(reducedTransparencyStyle.backdropFilter, 'none')
  assert.notEqual(reducedTransparencyStyle.backgroundColor, 'rgba(0, 0, 0, 0)')
  await shellContents.executeJavaScript('delete window.__auroraReducedTransparencyProbe')

  shellContents.send(IPC_CHANNELS.state, {
    ...shellStateSnapshot(),
    downloads: [
      {
        id: 'smoke-progressing',
        name: 'unknown-size.zip',
        state: 'progressing',
        progress: null,
        canShow: false,
      },
      {
        id: 'smoke-failed',
        name: 'moved.txt',
        state: 'failed',
        progress: null,
        canShow: false,
      },
    ],
  })
  await waitForCondition(
    () =>
      shellContents.executeJavaScript("document.querySelectorAll('.download-item').length === 2"),
    'shell did not render sanitized download states',
  )
  assert.deepEqual(
    await shellContents.executeJavaScript(
      "[...document.querySelectorAll('.download-meta > span')].map((node) => node.textContent)",
    ),
    ['正在下载', '文件不可用'],
  )
  pushShellState()

  const productGlobals = await productContents.executeJavaScript(`({
    process: typeof globalThis.process,
    require: typeof globalThis.require,
    bridge: typeof globalThis.auroraDesktop,
    processProbe: document.querySelector('#probe-process')?.dataset.safe,
    requireProbe: document.querySelector('#probe-require')?.dataset.safe,
    bridgeProbe: document.querySelector('#probe-bridge')?.dataset.safe,
  })`)
  assert.equal(productGlobals.process, 'undefined')
  assert.equal(productGlobals.require, 'undefined')
  assert.equal(productGlobals.bridge, 'undefined')
  assert.equal(productGlobals.processProbe, 'true')
  assert.equal(productGlobals.requireProbe, 'true')
  assert.equal(productGlobals.bridgeProbe, 'true')

  const initialRoute = await productContents.executeJavaScript(
    "document.querySelector('#fixture-route').textContent",
  )
  await productContents.loadURL(SMOKE_PRODUCT_ROUTE_URL)
  await waitForCondition(
    () => productContents.navigationHistory.canGoBack(),
    'fixture route navigation did not create a back entry',
  )
  const pushedRoute = await productContents.executeJavaScript(
    "document.querySelector('#fixture-route').textContent",
  )
  assert.notEqual(pushedRoute, initialRoute)

  await shellContents.executeJavaScript("window.auroraDesktop.send({ type: 'back' })")
  await waitForCondition(
    async () =>
      (await productContents.executeJavaScript(
        "document.querySelector('#fixture-route').textContent",
      )) === initialRoute,
    'shell back command did not navigate the product fixture',
  )
  assert.equal(productContents.navigationHistory.canGoForward(), true)

  await shellContents.executeJavaScript("window.auroraDesktop.send({ type: 'forward' })")
  await waitForCondition(
    async () =>
      (await productContents.executeJavaScript(
        "document.querySelector('#fixture-route').textContent",
      )) === pushedRoute,
    'shell forward command did not navigate the product fixture',
  )

  const reloadCount = Number(
    await productContents.executeJavaScript(
      "document.querySelector('#fixture-reload-count').textContent",
    ),
  )
  const didReload = waitForWebContentsEvent(productContents, 'did-finish-load')
  await shellContents.executeJavaScript("window.auroraDesktop.send({ type: 'reload' })")
  await didReload
  const nextReloadCount = Number(
    await productContents.executeJavaScript(
      "document.querySelector('#fixture-reload-count').textContent",
    ),
  )
  assert.ok(nextReloadCount > reloadCount)

  await shellContents.executeJavaScript("window.auroraDesktop.send({ type: 'downloads-open' })")
  await waitForCondition(
    () => smokeShellView.getBounds().height > TOOLBAR_HEIGHT,
    'downloads command did not expand the shell view',
  )
  await waitForCondition(
    async () =>
      shellContents.isFocused() &&
      (await shellContents.executeJavaScript(`
          document.body.dataset.shellMode === 'downloads' &&
          document.querySelector('#downloads-button')?.getAttribute('aria-expanded') === 'true' &&
          document.activeElement?.id === 'downloads-close'
        `)),
    'downloads drawer did not expose modal state and keyboard focus',
  )
  const expandedLayout = calculateViewBounds(window.getContentBounds(), {
    shellMode: 'downloads',
  })
  assert.deepEqual(smokeShellView.getBounds(), expandedLayout.shell)
  assert.deepEqual(smokeProductView.getBounds(), expandedLayout.product)

  await shellContents.executeJavaScript("window.auroraDesktop.send({ type: 'downloads-close' })")
  await waitForCondition(
    () => smokeShellView.getBounds().height === TOOLBAR_HEIGHT,
    'downloads close command did not collapse the shell view',
  )
  await waitForCondition(
    async () =>
      await shellContents.executeJavaScript(
        "document.body.dataset.shellMode === 'toolbar' && document.querySelector('#downloads-button')?.getAttribute('aria-expanded') === 'false'",
      ),
    'downloads close did not restore toolbar state',
  )
  await shellContents.executeJavaScript(
    'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
  )
  assert.equal(productContents.isFocused(), true, 'downloads close did not keep product focus')
  assert.equal(shellContents.isFocused(), false, 'shell stole focus after downloads close')

  markProductFailed('load-failed')
  await waitForCondition(
    async () =>
      shellContents.isFocused() &&
      (await shellContents.executeJavaScript(
        "document.body.dataset.shellMode === 'offline' && document.querySelector('#offline-title')?.textContent === '页面加载失败'",
      )),
    'non-network load failure did not show the focused recovery surface',
  )
  await shellContents.executeJavaScript("window.auroraDesktop.send({ type: 'downloads-open' })")
  await shellContents.executeJavaScript("window.auroraDesktop.send({ type: 'downloads-close' })")
  await shellContents.executeJavaScript(
    'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
  )
  assert.equal(shellMode, 'offline', 'downloads command escaped a product recovery state')
  assert.equal(shellContents.isFocused(), true, 'product recovery surface lost native focus')
  markProductReady()
  await waitForCondition(
    () => shellContents.executeJavaScript("document.body.dataset.shellMode === 'toolbar'"),
    'ready product did not dismiss the recovery surface',
  )

  window.setContentSize(1120, 760)
  await waitForCondition(() => {
    const expected = calculateViewBounds(window.getContentBounds(), {
      shellMode: 'toolbar',
    })
    return (
      JSON.stringify(smokeShellView.getBounds()) === JSON.stringify(expected.shell) &&
      JSON.stringify(smokeProductView.getBounds()) === JSON.stringify(expected.product)
    )
  }, 'child view bounds did not follow BaseWindow resize')

  await shellContents.executeJavaScript('window.__auroraSmokeUnsubscribe()')
  window.close()
  await waitForCondition(
    () => shellContents.isDestroyed() && productContents.isDestroyed(),
    'closing BaseWindow did not destroy both child webContents',
  )
}

async function runSmokeTest() {
  let timeout
  try {
    await Promise.race([
      runSmokeContract(),
      new Promise((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error('desktop smoke exceeded its hard timeout')),
          SMOKE_TIMEOUT_MS,
        )
      }),
    ])
    return 0
  } catch (error) {
    console.error('[windows] smoke failed:', error instanceof Error ? error.stack : error)
    await writeSmokeFailureReport('smoke', error)
    if (isAlive(mainWindow)) mainWindow.close()
    return 1
  } finally {
    clearTimeout(timeout)
  }
}

async function writeSmokeFailureReport(stage, error) {
  if (!smokeTest) return
  const reportPath = process.env.OPENCLAUDE_SMOKE_REPORT_PATH
  if (typeof reportPath !== 'string' || reportPath.length === 0 || reportPath.length > 32_767)
    return

  const detail = error instanceof Error ? error.stack || error.message : String(error)
  try {
    await writeFile(reportPath, `[windows] ${stage} failed:\n${detail}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
  } catch (reportError) {
    console.error(
      '[windows] could not write smoke report:',
      reportError instanceof Error ? reportError.message : reportError,
    )
  }
}

function normalStartUrl() {
  return resolveStartUrl({
    isPackaged: app.isPackaged,
    devUrl: process.env.OPENCLAUDE_DESKTOP_DEV_URL,
  })
}

async function ensureNormalMainWindow() {
  if (isAlive(mainWindow)) return mainWindow
  if (creatingMainWindow) return creatingMainWindow
  const startUrl = normalStartUrl()
  creatingMainWindow = createMainWindow({
    startUrl,
    appOrigin: originOf(startUrl) || PINNED_APP_ORIGIN,
  })
    .then(({ window }) => window)
    .finally(() => {
      creatingMainWindow = null
    })
  return creatingMainWindow
}

ipcMain.on(IPC_CHANNELS.command, onShellCommand)

const hasSingleInstanceLock = smokeTest || app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    const intent = parseLaunchIntent(argv)
    if (!isAlive(mainWindow)) {
      void ensureNormalMainWindow()
      return
    }
    if (intent?.type === 'home') homeProduct()
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  app
    .whenReady()
    .then(async () => {
      Menu.setApplicationMenu(null)
      if (!smokeTest && process.platform === 'win32') installJumpList({ app })
      if (smokeTest) {
        const exitCode = await runSmokeTest()
        app.exit(exitCode)
        return
      }
      await ensureNormalMainWindow()
    })
    .catch(async (error) => {
      console.error('[windows] startup failed:', error instanceof Error ? error.stack : error)
      await writeSmokeFailureReport('startup', error)
      app.exit(1)
    })
}

app.on('activate', () => {
  if (!smokeTest && !isAlive(mainWindow)) void ensureNormalMainWindow()
})

app.on('before-quit', () => {
  void windowStateStore?.flush().catch(() => {})
})

app.on('window-all-closed', () => {
  if (!smokeTest && process.platform !== 'darwin') app.quit()
})
