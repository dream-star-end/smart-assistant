import assert from 'node:assert/strict'
import { stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  BaseWindow,
  BrowserWindow,
  Menu,
  Notification,
  WebContentsView,
  app,
  dialog,
  ipcMain,
  nativeTheme,
  protocol,
  screen,
  shell,
} from 'electron'

import {
  applyCaptionOverlay,
  createWindowWithCaptionFallback,
} from './desktop-chrome.mjs'
import {
  applyNavigationEnabled,
  buildApplicationMenuTemplate,
  buildMoreMenuTemplate,
} from './desktop-menu.mjs'
import {
  canNotifyDownloadComplete,
  createDownloadCompletedNotification,
  shouldReleaseNotificationOnClose,
} from './download-notify.mjs'
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
import {
  canFocusProduct,
  canOpenDownloads,
  canOpenMoreMenu,
  normalizeShellMode,
  shellModeAfterDownloadsClose,
  shouldShowProduct,
} from './shell-mode.mjs'
import {
  SHELL_ORIGIN,
  SHELL_URL,
  SMOKE_PRODUCT_ROUTE_URL,
  SMOKE_PRODUCT_URL,
  registerShellProtocol,
  registerShellScheme,
} from './shell-protocol.mjs'
import {
  clickElementWithInput,
  sendKeyWithInput,
  waitForCondition,
  waitForViewLayout,
  waitForWebContentsEvent,
} from './smoke-harness.mjs'
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
const SMOKE_TIMEOUT_MS = 25_000
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
let smokeMenuOpenCount = 0
let overlayActive = false
let applicationMenu = null
const liveNotifications = new Set()

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
        const completed = downloads.complete(id, {
          filePath: item.getSavePath(),
          receivedBytes: item.getReceivedBytes(),
          totalBytes: item.getTotalBytes(),
        })
        if (
          canNotifyDownloadComplete({
            completed,
            windowAlive: isAlive(mainWindow),
            smokeTest,
          })
        ) {
          createDownloadCompletedNotification({
            NotificationImpl: Notification,
            id,
            registry: liveNotifications,
            releaseOnClose: shouldReleaseNotificationOnClose(process.platform),
            onShowDownload: (downloadId) => {
              if (!isAlive(mainWindow)) return
              void showRegisteredDownload(downloadId)
            },
          })
        }
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
    overlayActive,
  }
}

function pushShellState() {
  refreshApplicationMenuEnabled()
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

function setShellMode(nextMode, { focusProductOnToolbar = false } = {}) {
  const normalized = normalizeShellMode(nextMode)
  shellMode = normalized

  if (!shouldShowProduct(normalized)) {
    productView?.setVisible(false)
    layoutViews()
    focusShell()
    pushShellState()
    return
  }

  // Keep this order stable: reveal first, restore geometry second, and focus last.
  productView?.setVisible(true)
  layoutViews()
  if (focusProductOnToolbar) focusProduct()
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
  setShellMode(recoveredFromOffline ? 'toolbar' : shellMode, {
    focusProductOnToolbar: recoveredFromOffline,
  })
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

function focusShellAppBar() {
  const shellWebContents = shellView?.webContents
  if (!focusShell() || !shellWebContents || shellWebContents.isDestroyed()) return false
  void shellWebContents
    .executeJavaScript("document.querySelector('#downloads-button')?.focus()")
    .catch(() => {})
  return true
}

function focusProduct() {
  if (!canFocusProduct(shellMode) || !productView || productView.getVisible() !== true) return false
  if (!productWebContents || productWebContents.isDestroyed()) return false
  productWebContents.focus()
  return true
}

function focusForShellMode() {
  return canFocusProduct(shellMode) ? focusProduct() : focusShell()
}

function goBack() {
  const history = productWebContents?.navigationHistory
  if (!history?.canGoBack()) return false
  if (!canFocusProduct(shellMode)) focusShell()
  history.goBack()
  focusForShellMode()
  return true
}

function goForward() {
  const history = productWebContents?.navigationHistory
  if (!history?.canGoForward()) return false
  if (!canFocusProduct(shellMode)) focusShell()
  history.goForward()
  focusForShellMode()
  return true
}

function reloadProduct() {
  if (!productWebContents || productWebContents.isDestroyed()) return false
  if (!canFocusProduct(shellMode)) focusShell()
  markProductLoading()
  productWebContents.reload()
  focusForShellMode()
  return true
}

function homeProduct() {
  if (!activeStartUrl || !productWebContents || productWebContents.isDestroyed()) return false
  if (!canFocusProduct(shellMode)) focusShell()
  void loadProductUrl(activeStartUrl)
  focusForShellMode()
  return true
}

function setProductZoom(nextFactor) {
  if (!productWebContents || productWebContents.isDestroyed()) return false
  const normalized = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Number(nextFactor.toFixed(2))))
  productWebContents.setZoomFactor(normalized)
  pushShellState()
  focusForShellMode()
  return true
}

function adjustProductZoom(delta) {
  if (!productWebContents || productWebContents.isDestroyed()) return false
  return setProductZoom(productWebContents.getZoomFactor() + delta)
}

function menuActions() {
  return {
    back: goBack,
    forward: goForward,
    reload: reloadProduct,
    home: homeProduct,
    zoomIn: () => adjustProductZoom(ZOOM_STEP),
    zoomOut: () => adjustProductZoom(-ZOOM_STEP),
    zoomReset: () => setProductZoom(1),
    openDownloadsFolder,
  }
}

function refreshApplicationMenuEnabled() {
  if (!applicationMenu) return
  applyNavigationEnabled(applicationMenu, navigationSnapshot())
}

function installApplicationMenu() {
  applicationMenu = Menu.buildFromTemplate(
    buildApplicationMenuTemplate({
      platform: process.platform,
      actions: menuActions(),
      navigation: navigationSnapshot(),
    }),
  )
  Menu.setApplicationMenu(applicationMenu)
}

function desktopActions(source = 'product') {
  return {
    back: goBack,
    forward: goForward,
    focusNextPane: source === 'shell' ? focusProduct : focusShellAppBar,
    reload: reloadProduct,
    zoomIn: () => adjustProductZoom(ZOOM_STEP),
    zoomOut: () => adjustProductZoom(-ZOOM_STEP),
    zoomReset: () => setProductZoom(1),
  }
}

function openMoreMenu() {
  if (!canOpenMoreMenu(shellMode) || !isAlive(mainWindow)) return false
  if (smokeTest) {
    smokeMenuOpenCount += 1
    focusProduct()
    return true
  }

  const menu = Menu.buildFromTemplate(
    buildMoreMenuTemplate({
      platform: process.platform,
      actions: menuActions(),
      navigation: navigationSnapshot(),
    }),
  )
  menu.popup({
    window: mainWindow,
    callback: () => focusProduct(),
  })
  return true
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
    case 'open-more-menu':
      return openMoreMenu()
    case 'focus-product':
      return focusProduct()
    case 'downloads-open':
      if (!canOpenDownloads(productState)) return false
      setShellMode('downloads')
      return true
    case 'downloads-close': {
      const nextMode = shellModeAfterDownloadsClose(productState)
      setShellMode(nextMode, { focusProductOnToolbar: nextMode === 'toolbar' })
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
    if (handleDesktopShortcut(input, desktopActions('product'))) event.preventDefault()
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
    applyCaptionOverlay(window, { overlayActive, nativeTheme })
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
    liveNotifications.clear()
    shellReady = false
    overlayActive = false
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

  const { window, overlayActive: createdOverlay } = createWindowWithCaptionFallback({
    platform: process.platform,
    theme: {
      dark: nativeTheme.shouldUseDarkColors === true,
      forcedColors:
        nativeTheme.inForcedColorsMode === true || nativeTheme.shouldUseHighContrastColors === true,
    },
    extraOptions: {
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
    },
    createWindow: (options) => new BaseWindow(options),
  })
  overlayActive = createdOverlay
  window.accessibleTitle = APP_NAME
  mainWindow = window

  const localProductView = createProductView({
    partition: isSmoke ? SMOKE_PRODUCT_PARTITION : PRODUCT_PARTITION,
    devTools: !app.isPackaged,
  })
  const localShellView = new WebContentsView({ webPreferences: shellWebPreferences() })
  localShellView.setBackgroundColor('#00000000')
  localProductView.setVisible(true)
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
    if (handleDesktopShortcut(input, desktopActions('shell'))) event.preventDefault()
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

async function writeOptionalSmokeScreenshot({
  window,
  shell,
  product,
  shellContents,
  productContents,
}) {
  const screenshotPath = process.env.OPENCLAUDE_SMOKE_SCREENSHOT_PATH
  if (screenshotPath === undefined || screenshotPath === '') return false
  assert.equal(
    path.isAbsolute(screenshotPath),
    true,
    'OPENCLAUDE_SMOKE_SCREENSHOT_PATH must be an absolute path',
  )
  assert.ok(
    [SMOKE_PRODUCT_URL, SMOKE_PRODUCT_ROUTE_URL].includes(productContents.getURL()),
    'visual smoke capture must use the local product fixture',
  )
  assert.equal(shellMode, 'downloads', 'visual smoke capture requires the downloads surface')
  assert.equal(product.getVisible(), false, 'visual smoke capture must hide the product view')

  await waitForViewLayout(window, shell, product, 1280, 800, 'downloads')
  productContents.setZoomFactor(1)
  shellContents.setZoomFactor(1)
  shellContents.send(IPC_CHANNELS.state, {
    ...shellStateSnapshot(),
    shellMode: 'downloads',
    theme: { mode: 'light', forcedColors: false, reduceTransparency: true },
  })
  await shellContents.executeJavaScript(`new Promise((resolve) => {
    document.documentElement.dataset.visualCapture = 'true'
    requestAnimationFrame(() => requestAnimationFrame(resolve))
  })`)

  try {
    assert.equal(
      await shellContents.executeJavaScript(
        "document.documentElement.dataset.theme === 'light' && document.body.dataset.shellMode === 'downloads'",
      ),
      true,
      'visual smoke capture did not settle into its canonical light downloads state',
    )
    const image = await shellContents.capturePage()
    const png = image.toPNG()
    assert.ok(png.length > 0, 'visual smoke capture produced an empty PNG')
    await writeFile(screenshotPath, png, { mode: 0o600 })
  } finally {
    await shellContents.executeJavaScript(
      "delete document.documentElement.dataset.visualCapture",
    )
    pushShellState()
  }
  return true
}

function companionScreenshotPath(screenshotPath, suffix) {
  const parsed = path.parse(screenshotPath)
  return path.join(parsed.dir, `${parsed.name}-${suffix}${parsed.ext || '.png'}`)
}

async function writeOptionalToolbarScreenshots({
  window,
  shell,
  product,
  shellContents,
  productContents,
}) {
  const screenshotPath = process.env.OPENCLAUDE_SMOKE_SCREENSHOT_PATH
  if (screenshotPath === undefined || screenshotPath === '') return false
  assert.equal(
    path.isAbsolute(screenshotPath),
    true,
    'OPENCLAUDE_SMOKE_SCREENSHOT_PATH must be an absolute path',
  )
  assert.ok(
    [SMOKE_PRODUCT_URL, SMOKE_PRODUCT_ROUTE_URL].includes(productContents.getURL()),
    'toolbar capture must use the local product fixture',
  )
  assert.equal(shellMode, 'toolbar', 'toolbar capture requires the normal workspace surface')
  assert.equal(product.getVisible(), true, 'toolbar capture requires the visible product view')

  await waitForViewLayout(window, shell, product, 1280, 800, 'toolbar')
  productContents.setZoomFactor(1)
  shellContents.setZoomFactor(1)
  shellContents.send(IPC_CHANNELS.state, {
    ...shellStateSnapshot(),
    shellMode: 'toolbar',
    theme: { mode: 'light', forcedColors: false, reduceTransparency: true },
  })
  await Promise.all([
    shellContents.executeJavaScript(`new Promise((resolve) => {
      document.documentElement.dataset.visualCapture = 'true'
      requestAnimationFrame(() => requestAnimationFrame(resolve))
    })`),
    productContents.executeJavaScript(`new Promise((resolve) => {
      document.documentElement.dataset.visualCapture = 'true'
      requestAnimationFrame(() => requestAnimationFrame(resolve))
    })`),
  ])

  try {
    assert.equal(
      await shellContents.executeJavaScript(
        "document.documentElement.dataset.theme === 'light' && document.body.dataset.shellMode === 'toolbar'",
      ),
      true,
      'toolbar capture did not settle into its canonical light state',
    )
    const [shellImage, productImage] = await Promise.all([
      shellContents.capturePage(),
      productContents.capturePage(),
    ])
    assert.deepEqual(shellImage.getSize(), { width: 1280, height: TOOLBAR_HEIGHT })
    assert.deepEqual(productImage.getSize(), {
      width: 1280,
      height: 800 - TOOLBAR_HEIGHT,
    })
    const toolbarPath = companionScreenshotPath(screenshotPath, 'toolbar')
    const productPath = companionScreenshotPath(screenshotPath, 'product')
    await Promise.all([
      writeFile(toolbarPath, shellImage.toPNG(), { mode: 0o600 }),
      writeFile(productPath, productImage.toPNG(), { mode: 0o600 }),
    ])
  } finally {
    await Promise.all([
      shellContents.executeJavaScript("delete document.documentElement.dataset.visualCapture"),
      productContents.executeJavaScript("delete document.documentElement.dataset.visualCapture"),
    ])
    pushShellState()
  }
  return true
}

const SHELL_CHROME_CONTRACT_SCRIPT = `(() => {
  const overlayActive = document.documentElement.dataset.overlayActive === 'true'
  const region = (selector) => getComputedStyle(document.querySelector(selector)).webkitAppRegion
  const hitRect = (selector) => {
    const bounds = document.querySelector(selector).getBoundingClientRect()
    return { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom }
  }
  function envNumber(name) {
    const probe = document.createElement('div')
    probe.style.position = 'absolute'
    probe.style.width = 'env(' + name + ', -1px)'
    document.body.append(probe)
    const value = Number.parseFloat(getComputedStyle(probe).width)
    probe.remove()
    return Number.isFinite(value) ? value : -1
  }
  return {
    overlayActive,
    brandRegion: region('.brand'),
    spacerRegion: region('.command-spacer'),
    downloadsRegion: region('#downloads-button'),
    moreRegion: region('#more-menu-button'),
    statusRegion: region('#connection-status'),
    downloads: hitRect('#downloads-button'),
    more: hitRect('#more-menu-button'),
    status: hitRect('#connection-status'),
    brand: hitRect('.brand'),
    statusVisible: document.querySelector('#connection-status').getBoundingClientRect().width > 0,
    titlebarAreaX: envNumber('titlebar-area-x'),
    titlebarAreaWidth: envNumber('titlebar-area-width'),
    titlebarAreaHeight: envNumber('titlebar-area-height'),
    wcoReady: document.documentElement.dataset.wcoReady,
  }
})()`

function assertShellChromeContract(chromeContract, overlayIsActive) {
  assert.equal(chromeContract.overlayActive, overlayIsActive)
  assert.equal(chromeContract.downloadsRegion, 'no-drag')
  assert.equal(chromeContract.moreRegion, 'no-drag')
  assert.equal(chromeContract.statusRegion, 'no-drag')
  if (overlayIsActive) {
    assert.equal(chromeContract.wcoReady, 'true')
    assert.ok(chromeContract.titlebarAreaWidth > 0, 'win32 overlay must expose a positive WCO width')
    assert.ok(
      chromeContract.titlebarAreaHeight > 0,
      'win32 overlay must expose a positive WCO height',
    )
    assert.equal(chromeContract.brandRegion, 'drag')
    assert.equal(chromeContract.spacerRegion, 'drag')
    const safeLeft = chromeContract.titlebarAreaX
    const safeRight = chromeContract.titlebarAreaX + chromeContract.titlebarAreaWidth
    const safeTop = 0
    const safeBottom = chromeContract.titlebarAreaHeight
    const names = ['downloads', 'more', 'brand']
    if (chromeContract.statusVisible) names.push('status')
    for (const name of names) {
      assert.ok(chromeContract[name].left >= safeLeft - 1, `${name} left escaped WCO safe area`)
      assert.ok(chromeContract[name].right <= safeRight + 1, `${name} right escaped WCO safe area`)
      assert.ok(chromeContract[name].top >= safeTop - 1, `${name} top escaped WCO safe area`)
      assert.ok(chromeContract[name].bottom <= safeBottom + 1, `${name} bottom escaped WCO safe area`)
    }
  } else {
    assert.equal(chromeContract.wcoReady, 'false')
    assert.notEqual(chromeContract.brandRegion, 'drag')
    assert.notEqual(chromeContract.spacerRegion, 'drag')
  }
}

async function waitForShellChromeContract(shellContents, overlayIsActive, message) {
  let chromeContract = null
  await waitForCondition(
    async () => {
      chromeContract = await shellContents.executeJavaScript(SHELL_CHROME_CONTRACT_SCRIPT)
      return (
        chromeContract &&
        chromeContract.overlayActive === overlayIsActive &&
        chromeContract.wcoReady === (overlayIsActive ? 'true' : 'false')
      )
    },
    message,
  ).catch((error) => {
    throw new Error(`${error.message}; last state: ${JSON.stringify(chromeContract)}`)
  })
  assertShellChromeContract(chromeContract, overlayIsActive)
  return chromeContract
}

async function runSmokeContract() {
  smokeMenuOpenCount = 0
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
  assert.equal(
    await shellContents.executeJavaScript(
      'document.documentElement.dataset.initialTransparencyAllowed',
    ),
    'false',
    'shell enabled transparency before receiving an authoritative native theme',
  )
  await waitForCondition(
    () => shellContents.executeJavaScript('window.__auroraSmokeStates.length > 0'),
    'trusted shell did not receive an initial state snapshot',
  )

  await waitForShellChromeContract(
    shellContents,
    overlayActive,
    'shell did not report caption overlay chrome contract',
  )

  let unreadyOverlay = null
  await waitForCondition(
    async () => {
      unreadyOverlay = await shellContents.executeJavaScript(`(() => {
        const root = document.documentElement
        root.dataset.overlayActive = 'true'
        root.dataset.wcoReady = 'false'
        const surface = document.querySelector('.command-surface')
        const more = document.querySelector('#more-menu-button').getBoundingClientRect()
        const surfaceBox = surface.getBoundingClientRect()
        return {
          brandRegion: getComputedStyle(document.querySelector('.brand')).webkitAppRegion,
          moreRegion: getComputedStyle(document.querySelector('#more-menu-button')).webkitAppRegion,
          paddingRight: Number.parseFloat(getComputedStyle(surface).paddingRight),
          moreRight: more.right,
          surfaceRight: surfaceBox.right,
        }
      })()`)
      return (
        unreadyOverlay &&
        unreadyOverlay.paddingRight >= 139 &&
        unreadyOverlay.brandRegion !== 'drag' &&
        unreadyOverlay.moreRegion === 'no-drag'
      )
    },
    'unready overlay did not keep controls out of the caption-button reserve',
  ).catch((error) => {
    throw new Error(`${error.message}; last state: ${JSON.stringify(unreadyOverlay)}`)
  })
  assert.ok(
    unreadyOverlay.moreRight <= unreadyOverlay.surfaceRight - 139,
    'More button entered the unready caption reserve',
  )
  pushShellState()
  await waitForShellChromeContract(
    shellContents,
    overlayActive,
    'shell did not restore chrome contract after unready overlay probe',
  )

  const wcoSyncBefore = Number.parseInt(
    await shellContents.executeJavaScript('document.documentElement.dataset.wcoSyncCount || "0"'),
    10,
  )
  const overlayApiPresent = await shellContents.executeJavaScript(
    'Boolean(navigator.windowControlsOverlay && typeof navigator.windowControlsOverlay.addEventListener === "function")',
  )
  await shellContents.executeJavaScript(`(() => {
    window.dispatchEvent(new Event('resize'))
    const overlay = navigator.windowControlsOverlay
    if (overlay && typeof overlay.dispatchEvent === 'function') {
      overlay.dispatchEvent(new Event('geometrychange'))
    }
  })()`)
  await waitForCondition(
    async () => {
      const count = Number.parseInt(
        await shellContents.executeJavaScript('document.documentElement.dataset.wcoSyncCount || "0"'),
        10,
      )
      return count >= wcoSyncBefore + (overlayApiPresent ? 2 : 1)
    },
    'WCO geometry listeners did not remeasure after resize/geometrychange',
  )

  shellContents.send(IPC_CHANNELS.state, {
    ...shellStateSnapshot(),
    theme: { mode: 'dark', forcedColors: false, reduceTransparency: true },
  })
  let reducedTransparencyStyle = null
  await waitForCondition(
    async () => {
      reducedTransparencyStyle = await shellContents.executeJavaScript(`(() => {
        const surface = document.querySelector('.command-surface')
        const style = getComputedStyle(surface)
        return {
          attribute: document.documentElement.dataset.reduceTransparency,
          allowTransparencyClass: surface.classList.contains('allow-transparency'),
          modifierClass: surface.classList.contains('reduce-transparency'),
          backdropFilter: style.backdropFilter,
          backgroundColor: style.backgroundColor,
        }
      })()`)
      return (
        reducedTransparencyStyle.attribute === 'true' &&
        reducedTransparencyStyle.allowTransparencyClass === false &&
        reducedTransparencyStyle.modifierClass === true &&
        reducedTransparencyStyle.backdropFilter === 'none' &&
        reducedTransparencyStyle.backgroundColor !== 'rgba(0, 0, 0, 0)'
      )
    },
    'reduced-transparency CSS did not settle into its opaque state',
  ).catch((error) => {
    throw new Error(`${error.message}; last state: ${JSON.stringify(reducedTransparencyStyle)}`)
  })
  assert.equal(reducedTransparencyStyle.attribute, 'true')
  assert.equal(reducedTransparencyStyle.allowTransparencyClass, false)
  assert.equal(reducedTransparencyStyle.modifierClass, true)
  assert.equal(reducedTransparencyStyle.backdropFilter, 'none')
  assert.notEqual(reducedTransparencyStyle.backgroundColor, 'rgba(0, 0, 0, 0)')
  shellContents.send(IPC_CHANNELS.state, {
    ...shellStateSnapshot(),
    theme: { mode: 'light', forcedColors: true, reduceTransparency: false },
  })
  let forcedColorsStyle = null
  await waitForCondition(
    async () => {
      forcedColorsStyle = await shellContents.executeJavaScript(`(() => {
        const surface = document.querySelector('.command-surface')
        const style = getComputedStyle(surface)
        const iconStyle = getComputedStyle(document.querySelector('#more-menu-button .fluent-icon'))
        return {
          attribute: document.documentElement.dataset.forcedColors,
          allowTransparencyClass: surface.classList.contains('allow-transparency'),
          backdropFilter: style.backdropFilter,
          backgroundColor: style.backgroundColor,
          iconBackgroundColor: iconStyle.backgroundColor,
          iconForcedColorAdjust: iconStyle.forcedColorAdjust,
        }
      })()`)
      return (
        forcedColorsStyle.attribute === 'true' &&
        forcedColorsStyle.allowTransparencyClass === false &&
        forcedColorsStyle.backdropFilter === 'none' &&
        forcedColorsStyle.backgroundColor !== 'rgba(0, 0, 0, 0)' &&
        forcedColorsStyle.iconBackgroundColor !== 'rgba(0, 0, 0, 0)' &&
        forcedColorsStyle.iconForcedColorAdjust === 'none'
      )
    },
    'forced-colors CSS did not settle into its opaque system-color state',
  ).catch((error) => {
    throw new Error(`${error.message}; last state: ${JSON.stringify(forcedColorsStyle)}`)
  })
  assert.equal(forcedColorsStyle.attribute, 'true')
  assert.equal(forcedColorsStyle.allowTransparencyClass, false)
  assert.equal(forcedColorsStyle.backdropFilter, 'none')
  assert.notEqual(forcedColorsStyle.backgroundColor, 'rgba(0, 0, 0, 0)')
  assert.notEqual(forcedColorsStyle.iconBackgroundColor, 'rgba(0, 0, 0, 0)')
  assert.equal(forcedColorsStyle.iconForcedColorAdjust, 'none')
  pushShellState()

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
  assert.deepEqual(
    await shellContents.executeJavaScript(`(() => {
      const progress = document.querySelector(
        '.download-item[data-state="progressing"] .download-meta progress',
      )
      return { exists: Boolean(progress), hasValue: progress?.hasAttribute('value') ?? true }
    })()`),
    { exists: true, hasValue: false },
    'unknown-size download must render an indeterminate progress element',
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

  const menuTemplate = buildMoreMenuTemplate({
    platform: process.platform,
    actions: menuActions(),
    navigation: navigationSnapshot(),
  })
  assert.equal(buildMoreMenuTemplate.length, 0)
  assert.equal(openMoreMenu.length, 0)
  assert.deepEqual(
    menuTemplate.filter((item) => item.type !== 'separator').map((item) => item.label),
    ['后退', '前进', '重新加载', '主页', '放大', '缩小', '重置缩放', '打开下载文件夹'],
  )
  if (process.platform === 'darwin') {
    assert.equal(menuTemplate.filter((item) => item.accelerator).length, 0)
  } else {
    assert.deepEqual(
      menuTemplate.filter((item) => item.accelerator).map((item) => item.accelerator),
      ['Alt+Left', 'Alt+Right', 'CmdOrCtrl+R', 'CmdOrCtrl+Plus', 'CmdOrCtrl+-', 'CmdOrCtrl+0'],
    )
    assert.equal(
      menuTemplate.filter((item) => item.accelerator).every((item) => item.registerAccelerator === false),
      true,
    )
  }
  assert.equal(menuTemplate.filter((item) => typeof item.click === 'function').length, 8)
  assert.equal(menuTemplate[0].enabled, navigationSnapshot().canGoBack)
  assert.equal(menuTemplate[1].enabled, navigationSnapshot().canGoForward)

  const previousMenuOpenCount = smokeMenuOpenCount
  await clickElementWithInput(window, shellContents, '#more-menu-button')
  await waitForCondition(
    () => smokeMenuOpenCount === previousMenuOpenCount + 1,
    'More button did not invoke the native-menu command stub',
  )
  assert.equal(shellMode, 'toolbar', 'native More menu changed the shell mode')

  await clickElementWithInput(window, shellContents, '#downloads-button')
  await waitForCondition(
    () => smokeShellView.getBounds().height > TOOLBAR_HEIGHT,
    'downloads button did not expand the shell view',
  )
  let downloadsFocusSnapshot = null
  await waitForCondition(
    async () => {
      downloadsFocusSnapshot = await shellContents.executeJavaScript(`({
        shellMode: document.body.dataset.shellMode,
        ariaExpanded: document.querySelector('#downloads-button')?.getAttribute('aria-expanded'),
        activeElement: document.activeElement?.id || document.activeElement?.tagName || null,
      })`)
      downloadsFocusSnapshot.shellFocused = shellContents.isFocused()
      return (
        downloadsFocusSnapshot.shellFocused === true &&
        downloadsFocusSnapshot.shellMode === 'downloads' &&
        downloadsFocusSnapshot.ariaExpanded === 'true' &&
        downloadsFocusSnapshot.activeElement === 'downloads-close'
      )
    },
    'downloads drawer did not expose modal state and keyboard focus',
  ).catch((error) => {
    throw new Error(`${error.message}; last state: ${JSON.stringify(downloadsFocusSnapshot)}`)
  })
  const expandedLayout = calculateViewBounds(window.getContentBounds(), {
    shellMode: 'downloads',
  })
  assert.deepEqual(smokeShellView.getBounds(), expandedLayout.shell)
  assert.deepEqual(smokeProductView.getBounds(), expandedLayout.product)
  assert.equal(smokeProductView.getVisible(), false, 'downloads did not hide the product view')
  assert.equal(productContents.isFocused(), false, 'hidden product retained native focus')

  const completedDownload = {
    id: 'smoke-completed',
    name: 'Aurora-notes.txt',
    state: 'completed',
    progress: 1,
    canShow: true,
  }
  shellContents.send(IPC_CHANNELS.state, {
    ...shellStateSnapshot(),
    downloads: [completedDownload, { id: 'smoke-live', name: 'archive.zip', state: 'progressing', progress: 0.25, canShow: false }],
  })
  await waitForCondition(
    () =>
      shellContents.executeJavaScript(
        "document.querySelector('.show-download-button') !== null",
      ),
    'downloads drawer did not render the focus restoration fixture',
  )
  await shellContents.executeJavaScript("document.querySelector('.show-download-button').focus()")
  shellContents.send(IPC_CHANNELS.state, {
    ...shellStateSnapshot(),
    downloads: [completedDownload, { id: 'smoke-live', name: 'archive.zip', state: 'progressing', progress: 0.5, canShow: false }],
  })
  await waitForCondition(
    () =>
      shellContents.executeJavaScript(`
        document.activeElement?.classList.contains('show-download-button') === true &&
        document.activeElement.closest('.download-item')?.dataset.downloadId === 'smoke-completed'
      `),
    'download refresh did not preserve focus inside the modal dialog',
  )
  pushShellState()

  await sendKeyWithInput(window, shellContents, '0', ['control'])
  await shellContents.executeJavaScript(
    'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
  )
  assert.equal(shellMode, 'downloads', 'modal shortcut dismissed the downloads surface')
  assert.equal(smokeProductView.getVisible(), false, 'modal shortcut revealed the product view')
  assert.equal(productContents.isFocused(), false, 'modal shortcut focused the hidden product view')
  assert.equal(shellContents.isFocused(), true, 'modal shortcut moved focus out of the shell')
  await sendKeyWithInput(window, shellContents, 'F6')
  await shellContents.executeJavaScript(
    'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
  )
  assert.equal(shellMode, 'downloads', 'modal F6 dismissed the downloads surface')
  assert.equal(smokeProductView.getVisible(), false, 'modal F6 revealed the product view')
  assert.equal(productContents.isFocused(), false, 'modal F6 focused the hidden product view')
  assert.equal(shellContents.isFocused(), true, 'modal F6 moved focus out of the shell')

  await waitForViewLayout(window, smokeShellView, smokeProductView, 520, 360, 'downloads')
  assert.deepEqual(
    await shellContents.executeJavaScript(`(() => {
      const dialog = document.querySelector('#downloads-dialog')
      const empty = document.querySelector('#downloads-empty')
      const bounds = dialog.getBoundingClientRect()
      return {
        insideViewport:
          bounds.left >= 0 &&
          bounds.top >= ${TOOLBAR_HEIGHT} &&
          bounds.right <= innerWidth &&
          bounds.bottom <= innerHeight,
        noHorizontalOverflow: document.documentElement.scrollWidth === innerWidth,
        emptyVisible: empty.hidden === false && empty.clientHeight > 0,
        emptyFits: empty.scrollHeight <= empty.clientHeight,
        statusTextPresent:
          getComputedStyle(document.querySelector('#connection-label')).display !== 'none' &&
          document.querySelector('#connection-label').textContent.trim().length > 0,
      }
    })()`),
    {
      insideViewport: true,
      noHorizontalOverflow: true,
      emptyVisible: true,
      emptyFits: true,
      statusTextPresent: true,
    },
    '520x360 downloads surface clipped or overflowed',
  )
  await waitForViewLayout(window, smokeShellView, smokeProductView, 1000, 700, 'downloads')

  await writeOptionalSmokeScreenshot({
    window,
    shell: smokeShellView,
    product: smokeProductView,
    shellContents,
    productContents,
  })

  await sendKeyWithInput(window, shellContents, 'Escape')
  await waitForCondition(
    () => smokeShellView.getBounds().height === TOOLBAR_HEIGHT,
    'Escape did not collapse the downloads view',
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
  assert.equal(smokeProductView.getVisible(), true, 'downloads close did not reveal the product')

  markProductFailed('load-failed')
  await waitForCondition(
    async () =>
      shellContents.isFocused() &&
      (await shellContents.executeJavaScript(
        "document.body.dataset.shellMode === 'offline' && document.querySelector('#offline-title')?.textContent === '页面加载失败'",
      )),
    'non-network load failure did not show the focused recovery surface',
  )
  assert.equal(smokeProductView.getVisible(), false, 'recovery did not hide the product view')
  assert.equal(productContents.isFocused(), false, 'recovery left the product focused')

  const offlineLoadingSnapshot = new Promise((resolve) => {
    productContents.once('did-start-loading', () => {
      resolve({
        shellMode,
        productVisible: smokeProductView.getVisible(),
        productFocused: productContents.isFocused(),
        shellFocused: shellContents.isFocused(),
      })
    })
  })
  const offlineReloadFinished = waitForWebContentsEvent(productContents, 'did-finish-load')
  await clickElementWithInput(window, shellContents, '#offline-retry')
  assert.deepEqual(
    await offlineLoadingSnapshot,
    {
      shellMode: 'offline',
      productVisible: false,
      productFocused: false,
      shellFocused: true,
    },
    'offline retry did not preserve recovery focus while the product started loading',
  )
  await offlineReloadFinished
  await waitForCondition(
    async () =>
      smokeProductView.getVisible() === true &&
      productContents.isFocused() &&
      (await shellContents.executeJavaScript("document.body.dataset.shellMode === 'toolbar'")),
    'successful retry did not restore the visible, focused product',
  )

  const recoveredHome = waitForWebContentsEvent(productContents, 'did-finish-load')
  assert.equal(homeProduct(), true, 'recovered product did not accept the Home action')
  await recoveredHome
  await clickElementWithInput(window, productContents, '#fixture-push-route')
  await waitForCondition(
    async () =>
      (await productContents.executeJavaScript(
        "document.querySelector('#fixture-route').textContent",
      )) === pushedRoute,
    'recovered product view did not accept real pointer input',
  )

  await sendKeyWithInput(window, productContents, 'F6')
  await waitForCondition(
    async () =>
      shellContents.isFocused() &&
      (await shellContents.executeJavaScript(
        "document.activeElement?.id === 'downloads-button'",
      )),
    'F6 did not move focus from the product view into the desktop app bar',
  )
  await sendKeyWithInput(window, shellContents, 'F6')
  await waitForCondition(
    () => productContents.isFocused(),
    'F6 did not return focus from the desktop app bar to the product view',
  )

  await writeOptionalToolbarScreenshots({
    window,
    shell: smokeShellView,
    product: smokeProductView,
    shellContents,
    productContents,
  })

  window.setMinimumSize(1, 1)
  await waitForViewLayout(window, smokeShellView, smokeProductView, 520, 360, 'toolbar')
  await waitForViewLayout(window, smokeShellView, smokeProductView, 1366, 768, 'toolbar')
  await shellContents.executeJavaScript('window.dispatchEvent(new Event("resize"))')
  await waitForShellChromeContract(
    shellContents,
    overlayActive,
    'shell chrome contract drifted after resize',
  )
  if (overlayActive && typeof window.maximize === 'function' && typeof window.unmaximize === 'function') {
    window.maximize()
    await waitForCondition(
      () => window.isMaximized() === true,
      'window did not enter maximized state',
    )
    await shellContents.executeJavaScript('window.dispatchEvent(new Event("resize"))')
    await waitForShellChromeContract(
      shellContents,
      overlayActive,
      'shell chrome contract drifted after maximize',
    )
    window.unmaximize()
    await waitForCondition(
      () => window.isMaximized() === false,
      'window did not leave maximized state',
    )
    await waitForViewLayout(window, smokeShellView, smokeProductView, 1366, 768, 'toolbar')
    await waitForShellChromeContract(
      shellContents,
      overlayActive,
      'shell chrome contract drifted after unmaximize',
    )
  }

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
      installApplicationMenu()
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
