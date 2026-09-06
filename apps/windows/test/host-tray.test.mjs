import assert from 'node:assert/strict'
import test from 'node:test'

import { buildTrayMenuTemplate, tunnelStateLabel } from '../src/desktop-tray.mjs'

test('tray omits tunnel status unless tunnelState is provided (P0 menu order)', () => {
  const hidden = buildTrayMenuTemplate({
    windowVisible: false,
    closeToTray: false,
    onShow: () => {},
    onQuit: () => {},
  })
  assert.equal(hidden[0].label, '显示主窗口')
  assert.equal(hidden[1].type, 'checkbox')
  assert.equal(hidden[2].type, 'separator')
  assert.equal(hidden[3].type, 'checkbox')
  assert.equal(hidden[3].label, '本地模式:关')
  assert.equal(hidden.at(-1).label, '退出')
})

test('tray shows TunnelState labels when local mode is active', () => {
  assert.equal(tunnelStateLabel('connecting'), '本地模式：连接中')
  assert.equal(tunnelStateLabel('registered'), '本地模式：已连接')
  assert.equal(tunnelStateLabel('degraded'), '本地模式：降级')
  assert.equal(tunnelStateLabel('offline'), '本地模式：离线')
  const menu = buildTrayMenuTemplate({
    windowVisible: true,
    closeToTray: true,
    tunnelState: 'registered',
    localModeEnabled: true,
    localMode: 'local',
  })
  assert.equal(menu[0].label, '隐藏主窗口')
  assert.equal(menu[3].label, '本地模式:开')
  const status = menu.find((item) => item.label === '本地模式：已连接')
  assert.ok(status)
  assert.equal(status.enabled, false)
  assert.equal(menu.at(-1).label, '退出')
})
