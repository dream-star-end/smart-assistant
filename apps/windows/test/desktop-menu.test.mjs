import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DESKTOP_COMMANDS,
  applyNavigationEnabled,
  buildApplicationMenuTemplate,
  buildCommandMenuItem,
  buildMoreMenuTemplate,
} from '../src/desktop-menu.mjs'

function actionsSpy() {
  const calls = []
  const actions = Object.fromEntries(
    DESKTOP_COMMANDS.map((command) => [
      command.actionName,
      () => {
        calls.push(command.actionName)
      },
    ]),
  )
  return { actions, calls }
}

test('command descriptors are closed and contain no URL or path fields', () => {
  assert.deepEqual(
    DESKTOP_COMMANDS.map((command) => command.id),
    ['back', 'forward', 'reload', 'home', 'zoom-in', 'zoom-out', 'zoom-reset', 'open-downloads-folder'],
  )
  for (const command of DESKTOP_COMMANDS) {
    assert.equal('url' in command, false)
    assert.equal('path' in command, false)
    assert.equal(typeof command.actionName, 'string')
  }
})

test('Windows menu items show accelerators but do not register them', () => {
  const { actions, calls } = actionsSpy()
  const item = buildCommandMenuItem(DESKTOP_COMMANDS[2], {
    platform: 'win32',
    actions,
    navigation: {},
  })
  assert.equal(item.accelerator, 'CmdOrCtrl+R')
  assert.equal(item.registerAccelerator, false)
  item.click()
  assert.deepEqual(calls, ['reload'])
})

test('macOS menu items omit accelerators entirely', () => {
  const item = buildCommandMenuItem(DESKTOP_COMMANDS[2], { platform: 'darwin', actions: {} })
  assert.equal('accelerator' in item, false)
  assert.equal('registerAccelerator' in item, false)

  const more = buildMoreMenuTemplate({ platform: 'darwin', actions: {}, navigation: {} })
  const application = buildApplicationMenuTemplate({
    platform: 'darwin',
    actions: {},
    navigation: {},
  })
  const darwinItems = [
    ...more.filter((entry) => entry.type !== 'separator'),
    ...application.flatMap((group) => group.submenu),
  ]
  for (const entry of darwinItems) {
    assert.equal('accelerator' in entry, false, entry.id)
  }
})

test('Linux menu items keep visible accelerators without registering them', () => {
  const item = buildCommandMenuItem(DESKTOP_COMMANDS[0], {
    platform: 'linux',
    actions: {},
    navigation: { canGoBack: true },
  })
  assert.equal(item.accelerator, 'Alt+Left')
  assert.equal(item.registerAccelerator, false)
  assert.equal(item.enabled, true)
})

test('More and application menus share descriptors and update enabled state by id', () => {
  const more = buildMoreMenuTemplate({
    platform: 'win32',
    actions: {},
    navigation: { canGoBack: false, canGoForward: true },
  })
  const labels = more.filter((item) => item.type !== 'separator').map((item) => item.label)
  assert.deepEqual(labels, [
    '后退',
    '前进',
    '重新加载',
    '主页',
    '放大',
    '缩小',
    '重置缩放',
    '打开下载文件夹',
  ])
  assert.equal(more[0].enabled, false)
  assert.equal(more[1].enabled, true)

  const application = buildApplicationMenuTemplate({
    platform: 'win32',
    actions: {},
    navigation: { canGoBack: false, canGoForward: false },
  })
  assert.deepEqual(
    application.map((group) => group.label),
    ['转到', '查看', '文件'],
  )

  const items = new Map()
  const menu = {
    getMenuItemById: (id) => items.get(id),
  }
  items.set('back', { enabled: false })
  items.set('forward', { enabled: false })
  applyNavigationEnabled(menu, { canGoBack: true, canGoForward: false })
  assert.equal(items.get('back').enabled, true)
  assert.equal(items.get('forward').enabled, false)
})
