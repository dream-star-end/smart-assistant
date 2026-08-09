import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { app, BrowserWindow, dialog, Menu, session, shell } from 'electron'

import { permissionDecision } from './permission-adapter.mjs'
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

const APP_ID = 'chat.claudeai.aurora'
const APP_NAME = 'OpenClaude Aurora'
const PRODUCTION_PARTITION = 'persist:openclaude-v5-prod-v1'
const DEVELOPMENT_PARTITION = 'openclaude-v5-dev-v1'
const SMOKE_TIMEOUT_MS = 10_000
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OFFLINE_PAGE_PATH = path.join(__dirname, 'offline.html')
const smokeTest = process.argv.includes('--smoke-test')

app.enableSandbox()
app.setName(APP_NAME)
if (process.platform === 'win32') app.setAppUserModelId(APP_ID)

let mainWindow = null
let authWindow = null
let showingOfflinePage = false
const viewerWindows = new Set()
const configuredSessions = new WeakSet()

function secureWebPreferences(partition) {
  return {
    partition,
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

function originOf(value) {
  try {
    return new URL(value).origin
  } catch {
    return ''
  }
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

function showMessage(owner, options) {
  if (owner && !owner.isDestroyed()) return dialog.showMessageBox(owner, options)
  return dialog.showMessageBox(options)
}

function showMessageSync(owner, options) {
  if (owner && !owner.isDestroyed()) return dialog.showMessageBoxSync(owner, options)
  return dialog.showMessageBoxSync(options)
}

function installWebContentsHardening(webContents) {
  webContents.on('will-attach-webview', (event) => event.preventDefault())
  webContents.on('select-bluetooth-device', (event, _devices, callback) => {
    event.preventDefault()
    callback('')
  })
}

function installWindowOpenPolicy(browserWindow, windowKind, appOrigin) {
  browserWindow.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    const action = classifyWindowOpen({
      windowKind,
      currentUrl: browserWindow.webContents.getURL(),
      targetUrl,
      appOrigin,
    })

    if (action === 'blob-view') createBlobViewer(targetUrl, appOrigin)
    if (action === 'external') openExternal(targetUrl)
    return { action: 'deny' }
  })
}

function createBlobViewer(targetUrl, appOrigin) {
  if (!mainWindow || mainWindow.isDestroyed()) return

  const viewer = new BrowserWindow({
    parent: mainWindow,
    width: 1040,
    height: 760,
    minWidth: 640,
    minHeight: 480,
    show: false,
    autoHideMenuBar: true,
    title: `${APP_NAME} - 预览`,
    backgroundColor: '#0c0c11',
    webPreferences: secureWebPreferences(
      app.isPackaged ? PRODUCTION_PARTITION : DEVELOPMENT_PARTITION,
    ),
  })
  viewerWindows.add(viewer)
  installWebContentsHardening(viewer.webContents)
  installWindowOpenPolicy(viewer, 'viewer', appOrigin)

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

function handleNavigation(browserWindow, windowKind, targetUrl, event, appOrigin) {
  const action = classifyTopLevelNavigation({
    windowKind,
    currentUrl: browserWindow.webContents.getURL(),
    targetUrl,
    appOrigin,
  })

  if (action === 'allow' || action === 'oauth-return' || action === 'oauth-final') {
    if (windowKind === 'main' && action === 'allow') showingOfflinePage = false
    return action
  }

  event.preventDefault()
  if (action === 'oauth') openOAuthWindow(targetUrl, appOrigin)
  if (action === 'external') openExternal(targetUrl)
  return action
}

function installNavigationPolicy(browserWindow, windowKind, appOrigin) {
  browserWindow.webContents.on('will-navigate', (event, targetUrl) => {
    handleNavigation(browserWindow, windowKind, targetUrl, event, appOrigin)
  })
  browserWindow.webContents.on(
    'will-redirect',
    (event, targetUrl, _isInPlace, isMainFrame) => {
      if (isMainFrame) handleNavigation(browserWindow, windowKind, targetUrl, event, appOrigin)
    },
  )
}

function openOAuthWindow(authorizeUrl, appOrigin) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (authWindow && !authWindow.isDestroyed()) {
    authWindow.focus()
    return
  }

  let callbackSeen = false
  let completed = false
  const oauth = new BrowserWindow({
    parent: mainWindow,
    width: 760,
    height: 820,
    minWidth: 520,
    minHeight: 620,
    show: false,
    autoHideMenuBar: true,
    title: `${APP_NAME} - 安全授权`,
    backgroundColor: '#0c0c11',
    webPreferences: secureWebPreferences(
      app.isPackaged ? PRODUCTION_PARTITION : DEVELOPMENT_PARTITION,
    ),
  })
  authWindow = oauth
  installWebContentsHardening(oauth.webContents)
  installNavigationPolicy(oauth, 'auth', appOrigin)
  installWindowOpenPolicy(oauth, 'auth', appOrigin)

  oauth.webContents.on('did-start-navigation', (_event, targetUrl, _isInPlace, isMainFrame) => {
    if (isMainFrame && isOAuthReturn(targetUrl, appOrigin)) callbackSeen = true
  })
  oauth.webContents.on('will-redirect', (_event, targetUrl, _isInPlace, isMainFrame) => {
    if (isMainFrame && isOAuthReturn(targetUrl, appOrigin)) callbackSeen = true
  })
  oauth.webContents.on('page-title-updated', (event) => event.preventDefault())
  oauth.webContents.on('did-navigate', (_event, targetUrl) => {
    try {
      const hostname = new URL(targetUrl).hostname
      oauth.setTitle(`${APP_NAME} - ${hostname}`)
    } catch {
      oauth.setTitle(`${APP_NAME} - 安全授权`)
    }

    if (!completed && callbackSeen && isOAuthFinalLanding(targetUrl, appOrigin)) {
      completed = true
      void loadMainUrl(targetUrl).finally(() => {
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
        mainWebContents: mainWindow?.webContents,
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
        mainWebContents: mainWindow?.webContents,
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
  if (mainWindow?.webContents === webContents) return isPinnedOrigin(webContents.getURL(), appOrigin)
  for (const viewer of viewerWindows) {
    if (!viewer.isDestroyed() && viewer.webContents === webContents) {
      return classifyDownload(webContents.getURL(), appOrigin) === 'allow'
    }
  }
  return false
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

    item.on('updated', (_updateEvent, state) => {
      if (!owner || owner.isDestroyed()) return
      const total = item.getTotalBytes()
      if (state === 'progressing' && total > 0) {
        owner.setProgressBar(Math.min(1, item.getReceivedBytes() / total))
      } else if (state === 'interrupted') {
        owner.setProgressBar(2, { mode: 'error' })
      }
    })
    item.once('done', (_doneEvent, state) => {
      if (owner && !owner.isDestroyed()) owner.setProgressBar(-1)
      if (state === 'completed') {
        void showMessage(owner, {
          type: 'info',
          title: APP_NAME,
          message: '下载完成',
          detail: filename,
        })
      } else if (state !== 'cancelled') {
        void showMessage(owner, {
          type: 'error',
          title: APP_NAME,
          message: '下载未完成',
          detail: '网络中断或目标文件不可用，请重试。',
        })
      }
    })
  })
}

async function showOffline() {
  if (!mainWindow || mainWindow.isDestroyed() || showingOfflinePage) return
  showingOfflinePage = true
  try {
    await mainWindow.loadFile(OFFLINE_PAGE_PATH)
  } catch {
    showingOfflinePage = false
    await showMessage(mainWindow, {
      type: 'error',
      title: APP_NAME,
      message: '无法加载 OpenClaude',
      detail: '请检查网络连接后重新启动应用。',
    })
  }
}

async function loadMainUrl(targetUrl) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  showingOfflinePage = false
  try {
    await mainWindow.loadURL(targetUrl)
  } catch {
    await showOffline()
  }
}

async function createMainWindow(startUrl, appOrigin) {
  const partition = app.isPackaged ? PRODUCTION_PARTITION : DEVELOPMENT_PARTITION
  const desktopSession = session.fromPartition(partition, { cache: true })
  if (!configuredSessions.has(desktopSession)) {
    installPermissionPolicy(desktopSession, appOrigin)
    installDownloadPolicy(desktopSession, appOrigin)
    configuredSessions.add(desktopSession)
  }

  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    title: APP_NAME,
    backgroundColor: '#0c0c11',
    webPreferences: secureWebPreferences(partition),
  })
  mainWindow = window
  installWebContentsHardening(window.webContents)
  installNavigationPolicy(window, 'main', appOrigin)
  installWindowOpenPolicy(window, 'main', appOrigin)

  window.webContents.on(
    'did-fail-load',
    (_event, errorCode, _description, validatedUrl, isMainFrame) => {
      if (
        isMainFrame &&
        errorCode !== -3 &&
        isPinnedOrigin(validatedUrl, appOrigin) &&
        !showingOfflinePage
      ) {
        void showOffline()
      }
    },
  )
  window.webContents.on('did-finish-load', () => {
    if (isPinnedOrigin(window.webContents.getURL(), appOrigin)) showingOfflinePage = false
  })
  window.once('ready-to-show', () => window.show())
  window.once('closed', () => {
    if (mainWindow === window) mainWindow = null
    if (authWindow && !authWindow.isDestroyed()) authWindow.close()
    for (const viewer of viewerWindows) {
      if (!viewer.isDestroyed()) viewer.close()
    }
  })
  await loadMainUrl(startUrl)
}

function runSmokeTest() {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      resolve(1)
    }, SMOKE_TIMEOUT_MS)
    const smokeWindow = new BrowserWindow({
      show: false,
      webPreferences: secureWebPreferences('openclaude-v5-smoke'),
    })
    smokeWindow.webContents.once('did-finish-load', () => {
      clearTimeout(timeout)
      if (!smokeWindow.isDestroyed()) smokeWindow.destroy()
      resolve(0)
    })
    void smokeWindow.loadURL('about:blank').catch(() => {
      clearTimeout(timeout)
      if (!smokeWindow.isDestroyed()) smokeWindow.destroy()
      resolve(1)
    })
  })
}

const hasSingleInstanceLock = smokeTest || app.requestSingleInstanceLock()

if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  app.whenReady()
    .then(async () => {
      if (smokeTest) {
        const exitCode = await runSmokeTest()
        app.exit(exitCode)
        return
      }

      Menu.setApplicationMenu(null)
      const startUrl = resolveStartUrl({
        isPackaged: app.isPackaged,
        devUrl: process.env.OPENCLAUDE_DESKTOP_DEV_URL,
      })
      const appOrigin = originOf(startUrl) || PINNED_APP_ORIGIN
      await createMainWindow(startUrl, appOrigin)
    })
    .catch((error) => {
      console.error('[desktop] startup failed:', error instanceof Error ? error.message : error)
      app.exit(1)
    })
}

app.on('activate', () => {
  if (!smokeTest && BrowserWindow.getAllWindows().length === 0) {
    const startUrl = resolveStartUrl({
      isPackaged: app.isPackaged,
      devUrl: process.env.OPENCLAUDE_DESKTOP_DEV_URL,
    })
    void createMainWindow(startUrl, originOf(startUrl) || PINNED_APP_ORIGIN)
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
