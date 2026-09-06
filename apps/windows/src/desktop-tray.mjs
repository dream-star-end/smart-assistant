import path from 'node:path'

import { localModeTrayLabel } from './localMode.mjs'

export function shouldHideInsteadOfClose({ isQuitting, closeToTray, smokeTest } = {}) {
  return smokeTest !== true && isQuitting !== true && closeToTray === true
}

export function resolveTrayIconCandidates({ moduleDir, resourcesPath, execPath } = {}) {
  const candidates = []
  if (typeof moduleDir === 'string' && moduleDir.length > 0) {
    candidates.push(path.join(moduleDir, '../../../packages/web-react/public/icons/icon-512.png'))
  }
  if (typeof resourcesPath === 'string' && resourcesPath.length > 0) {
    candidates.push(path.join(resourcesPath, 'icon-512.png'))
  }
  if (typeof execPath === 'string' && execPath.length > 0) {
    candidates.push(execPath)
  }
  return candidates
}

export async function loadTrayIcon(
  nativeImage,
  { app, isPackaged, execPath, moduleDir, resourcesPath } = {},
) {
  if (isPackaged && typeof app?.getFileIcon === 'function' && typeof execPath === 'string') {
    try {
      const exeIcon = await app.getFileIcon(execPath, { size: 'small' })
      if (exeIcon && exeIcon.isEmpty?.() !== true) return exeIcon
    } catch {
      // Fall through to packaged/dev PNG candidates.
    }
  }

  for (const candidate of resolveTrayIconCandidates({ moduleDir, resourcesPath, execPath })) {
    try {
      const image = nativeImage.createFromPath(candidate)
      if (image && image.isEmpty?.() !== true) return image
    } catch {
      // Try the next existing icon resource.
    }
  }
  return nativeImage.createEmpty()
}

export function tunnelStateLabel(state) {
  switch (state) {
    case 'connecting':
      return '本地模式：连接中'
    case 'registered':
      return '本地模式：已连接'
    case 'degraded':
      return '本地模式：降级'
    case 'offline':
      return '本地模式：离线'
    default:
      return null
  }
}

export function buildTrayMenuTemplate({
  windowVisible,
  closeToTray,
  tunnelState,
  localModeEnabled,
  localMode,
  onShow,
  onHide,
  onToggleCloseToTray,
  onToggleLocalMode,
  onQuit,
} = {}) {
  const items = [
    {
      label: windowVisible === true ? '隐藏主窗口' : '显示主窗口',
      click: windowVisible === true ? onHide : onShow,
    },
    {
      type: 'checkbox',
      label: '关闭时最小化到托盘',
      checked: closeToTray === true,
      click: (menuItem) => {
        onToggleCloseToTray?.(menuItem?.checked === true)
      },
    },
  ]
  items.push({ type: 'separator' })
  items.push({
    type: 'checkbox',
    label: localModeTrayLabel(localMode, { desired: localModeEnabled === true }),
    checked: localModeEnabled === true,
    click: (menuItem) => {
      onToggleLocalMode?.(menuItem?.checked === true)
    },
  })
  const status = tunnelStateLabel(tunnelState)
  if (status) {
    items.push({ label: status, enabled: false })
  }
  items.push(
    { type: 'separator' },
    {
      label: '退出',
      click: onQuit,
    },
  )
  return items
}

export function createDesktopTray({
  Tray,
  Menu,
  icon,
  tooltip,
  getState,
  onShow,
  onHide,
  onToggleCloseToTray,
  onToggleLocalMode,
  onQuit,
} = {}) {
  if (typeof Tray !== 'function' || typeof Menu?.buildFromTemplate !== 'function') {
    throw new TypeError('createDesktopTray requires Tray and Menu.buildFromTemplate')
  }
  const tray = new Tray(icon)
  const rebuild = () => {
    const state = typeof getState === 'function' ? getState() : {}
    tray.setContextMenu(
      Menu.buildFromTemplate(
        buildTrayMenuTemplate({
          windowVisible: state.windowVisible === true,
          closeToTray: state.closeToTray === true,
          tunnelState: state.tunnelState,
          localModeEnabled: state.localModeEnabled === true,
          localMode: state.localMode,
          onShow,
          onHide,
          onToggleCloseToTray: (value) => {
            onToggleCloseToTray?.(value)
            rebuild()
          },
          onToggleLocalMode: (value) => {
            onToggleLocalMode?.(value)
            rebuild()
          },
          onQuit,
        }),
      ),
    )
    if (typeof tray.setToolTip === 'function') {
      const status = tunnelStateLabel(state.tunnelState)
      const mode = localModeTrayLabel(state.localMode, { desired: state.localModeEnabled === true })
      const base = typeof tooltip === 'string' ? tooltip : ''
      const bits = [base, mode, status].filter(Boolean)
      const next = bits.join(' · ')
      if (next) tray.setToolTip(next)
    }
  }
  if (typeof tooltip === 'string' && tooltip.length > 0 && typeof tray.setToolTip === 'function') {
    tray.setToolTip(tooltip)
  }
  if (typeof tray.on === 'function') tray.on('click', () => onShow?.())
  rebuild()
  return { tray, rebuild }
}
