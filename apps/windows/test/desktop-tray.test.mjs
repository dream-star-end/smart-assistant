import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildTrayMenuTemplate,
  createDesktopTray,
  loadTrayIcon,
  resolveTrayIconCandidates,
  shouldHideInsteadOfClose,
} from '../src/desktop-tray.mjs'

test('shouldHideInsteadOfClose only intercepts close when the persisted toggle is on', () => {
  assert.equal(shouldHideInsteadOfClose({ closeToTray: true }), true)
  assert.equal(shouldHideInsteadOfClose({ closeToTray: true, isQuitting: false, smokeTest: false }), true)
  assert.equal(shouldHideInsteadOfClose({ closeToTray: false }), false)
  assert.equal(shouldHideInsteadOfClose({ closeToTray: true, isQuitting: true }), false)
  assert.equal(shouldHideInsteadOfClose({ closeToTray: true, smokeTest: true }), false)
  assert.equal(shouldHideInsteadOfClose({}), false)
})

test('resolveTrayIconCandidates prefers the existing packaged PNG then the executable', () => {
  assert.deepEqual(
    resolveTrayIconCandidates({
      moduleDir: '/repo/apps/windows/src',
      resourcesPath: '/repo/resources',
      execPath: 'C:\\Clarvy\\Clarvy.exe',
    }),
    [
      '/repo/packages/web-react/public/icons/icon-512.png',
      '/repo/resources/icon-512.png',
      'C:\\Clarvy\\Clarvy.exe',
    ],
  )
  assert.deepEqual(resolveTrayIconCandidates({}), [])
})

test('loadTrayIcon uses the packaged executable icon and never throws on empty candidates', async () => {
  const calls = []
  const packed = await loadTrayIcon(
    {
      createFromPath: () => assert.fail('must use getFileIcon in packaged mode'),
      createEmpty: () => ({ empty: true }),
    },
    {
      isPackaged: true,
      execPath: 'C:\\Clarvy\\Clarvy.exe',
      app: {
        getFileIcon: async (execPath, options) => {
          calls.push([execPath, options])
          return { isEmpty: () => false, source: 'exe' }
        },
      },
    },
  )
  assert.deepEqual(calls, [['C:\\Clarvy\\Clarvy.exe', { size: 'small' }]])
  assert.equal(packed.source, 'exe')

  const empty = await loadTrayIcon(
    {
      createFromPath: () => {
        throw new Error('missing png')
      },
      createEmpty: () => ({ empty: true }),
    },
    { isPackaged: false, moduleDir: '/missing' },
  )
  assert.deepEqual(empty, { empty: true })
})

test('buildTrayMenuTemplate exposes show/hide, the persisted close-to-tray toggle, and quit', () => {
  const calls = []
  const hidden = buildTrayMenuTemplate({
    windowVisible: false,
    closeToTray: false,
    onShow: () => calls.push('show'),
    onHide: () => calls.push('hide'),
    onToggleCloseToTray: (value) => calls.push(['toggle', value]),
    onQuit: () => calls.push('quit'),
  })
  assert.equal(hidden[0].label, '显示主窗口')
  hidden[0].click()
  assert.equal(hidden[1].type, 'checkbox')
  assert.equal(hidden[1].label, '关闭时最小化到托盘')
  assert.equal(hidden[1].checked, false)
  hidden[1].click({ checked: true })
  assert.equal(hidden[2].type, 'separator')
  hidden[3].click()
  assert.deepEqual(calls, ['show', ['toggle', true], 'quit'])

  const visible = buildTrayMenuTemplate({
    windowVisible: true,
    closeToTray: true,
    onHide: () => calls.push('hide'),
  })
  assert.equal(visible[0].label, '隐藏主窗口')
  visible[0].click()
  assert.equal(visible[1].checked, true)
  assert.deepEqual(calls.at(-1), 'hide')
})

test('createDesktopTray rebuilds the menu, shows on click, and does not invent IPC', () => {
  const menus = []
  const handlers = new Map()
  class FakeTray {
    constructor(icon) {
      this.icon = icon
    }
    setContextMenu(menu) {
      menus.push(menu)
    }
    setToolTip(value) {
      this.tooltip = value
    }
    on(eventName, handler) {
      handlers.set(eventName, handler)
    }
  }
  const trayApi = createDesktopTray({
    Tray: FakeTray,
    Menu: {
      buildFromTemplate: (template) => template,
    },
    icon: { id: 'icon' },
    tooltip: 'Clarvy',
    getState: () => ({ windowVisible: false, closeToTray: false }),
    onShow: () => menus.push('shown'),
    onHide: () => {},
    onToggleCloseToTray: () => {},
    onQuit: () => {},
  })
  assert.equal(trayApi.tray.icon.id, 'icon')
  assert.equal(trayApi.tray.tooltip, 'Clarvy')
  assert.equal(menus[0][0].label, '显示主窗口')
  handlers.get('click')()
  assert.equal(menus.includes('shown'), true)
})
