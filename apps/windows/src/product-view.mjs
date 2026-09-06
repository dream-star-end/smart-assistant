import { WebContentsView } from 'electron'

export const PRODUCT_PARTITION = 'persist:openclaude-v5-prod-v1'
export const SMOKE_PRODUCT_PARTITION = 'openclaude-v5-smoke-product-v1'

/**
 * Product renderers intentionally have no preload. The local shell is the only renderer that may
 * receive a narrow IPC bridge; keeping this object closed prevents future call sites from
 * accidentally extending product-page privileges through option spreading.
 */
export function productWebPreferences({ partition = PRODUCT_PARTITION, devTools = false } = {}) {
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
    devTools,
  }
}

export function createProductView(options = {}) {
  const view = new WebContentsView({
    webPreferences: productWebPreferences(options),
  })
  view.setBackgroundColor('#0c0c11')
  return view
}

/**
 * BaseWindow does not own child WebContents lifetimes. Close them explicitly before dropping the
 * view reference; this helper is idempotent so startup and teardown error paths can share it.
 */
export function closeWebContentsView(view) {
  if (!view?.webContents || view.webContents.isDestroyed()) return
  view.webContents.close()
}
