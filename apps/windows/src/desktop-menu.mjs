export const DESKTOP_COMMANDS = Object.freeze([
  Object.freeze({
    id: 'back',
    label: '后退',
    accelerator: 'Alt+Left',
    actionName: 'back',
    group: 'go',
    enableKey: 'canGoBack',
  }),
  Object.freeze({
    id: 'forward',
    label: '前进',
    accelerator: 'Alt+Right',
    actionName: 'forward',
    group: 'go',
    enableKey: 'canGoForward',
  }),
  Object.freeze({
    id: 'reload',
    label: '重新加载',
    accelerator: 'CmdOrCtrl+R',
    actionName: 'reload',
    group: 'go',
  }),
  Object.freeze({
    id: 'home',
    label: '主页',
    actionName: 'home',
    group: 'go',
  }),
  Object.freeze({
    id: 'zoom-in',
    label: '放大',
    accelerator: 'CmdOrCtrl+Plus',
    actionName: 'zoomIn',
    group: 'view',
  }),
  Object.freeze({
    id: 'zoom-out',
    label: '缩小',
    accelerator: 'CmdOrCtrl+-',
    actionName: 'zoomOut',
    group: 'view',
  }),
  Object.freeze({
    id: 'zoom-reset',
    label: '重置缩放',
    accelerator: 'CmdOrCtrl+0',
    actionName: 'zoomReset',
    group: 'view',
  }),
  Object.freeze({
    id: 'open-downloads-folder',
    label: '打开下载文件夹',
    actionName: 'openDownloadsFolder',
    group: 'file',
  }),
])

function omitAccelerators(platform) {
  return platform === 'darwin'
}

export function buildCommandMenuItem(
  command,
  { platform = typeof process !== 'undefined' ? process.platform : '', actions = {}, navigation = {} } = {},
) {
  if (!command || typeof command.id !== 'string') {
    throw new TypeError('buildCommandMenuItem requires a command descriptor')
  }

  const item = {
    id: command.id,
    label: command.label,
    click: () => {
      const action = actions[command.actionName]
      if (typeof action === 'function') action()
    },
  }

  if (command.enableKey) item.enabled = navigation[command.enableKey] === true
  if (!omitAccelerators(platform) && command.accelerator) {
    item.accelerator = command.accelerator
    item.registerAccelerator = false
  }
  return item
}

function commandsInGroup(group) {
  return DESKTOP_COMMANDS.filter((command) => command.group === group)
}

export function buildMoreMenuTemplate(options = {}) {
  const go = commandsInGroup('go').map((command) => buildCommandMenuItem(command, options))
  const view = commandsInGroup('view').map((command) => buildCommandMenuItem(command, options))
  const file = commandsInGroup('file').map((command) => buildCommandMenuItem(command, options))
  return [...go, { type: 'separator' }, ...view, { type: 'separator' }, ...file]
}

export function buildApplicationMenuTemplate(options = {}) {
  return [
    {
      label: '转到',
      submenu: commandsInGroup('go').map((command) => buildCommandMenuItem(command, options)),
    },
    {
      label: '查看',
      submenu: commandsInGroup('view').map((command) => buildCommandMenuItem(command, options)),
    },
    {
      label: '文件',
      submenu: commandsInGroup('file').map((command) => buildCommandMenuItem(command, options)),
    },
  ]
}

export function applyNavigationEnabled(menu, navigation = {}) {
  if (!menu || typeof menu.getMenuItemById !== 'function') return false
  for (const command of DESKTOP_COMMANDS) {
    if (!command.enableKey) continue
    const item = menu.getMenuItemById(command.id)
    if (item) item.enabled = navigation[command.enableKey] === true
  }
  return true
}
