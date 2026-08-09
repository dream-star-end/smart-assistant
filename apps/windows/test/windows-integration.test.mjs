import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyWindowsAppearance,
  buildJumpList,
  handleDesktopShortcut,
  installJumpList,
  parseLaunchIntent,
  shouldUseMica,
} from '../src/windows-integration.mjs'

test('parseLaunchIntent recognizes only the fixed privacy-safe home argument', () => {
  assert.deepEqual(parseLaunchIntent(['Aurora.exe', '--home']), { type: 'home' })
  assert.equal(parseLaunchIntent(['Aurora.exe', '--home=https://attacker.invalid']), null)
  assert.equal(parseLaunchIntent(['Aurora.exe', 'https://claudeai.chat/session/private']), null)
  assert.equal(parseLaunchIntent('not-an-array'), null)
})

test('buildJumpList contains one fixed home task and no user content', () => {
  assert.deepEqual(buildJumpList({ executablePath: 'C:\\Aurora\\Aurora.exe' }), [
    {
      type: 'tasks',
      items: [
        {
          type: 'task',
          program: 'C:\\Aurora\\Aurora.exe',
          args: '--home',
          iconPath: 'C:\\Aurora\\Aurora.exe',
          iconIndex: 0,
          title: '打开主页',
          description: '打开 OpenClaude Aurora 主页',
        },
      ],
    },
  ])
  assert.throws(() => buildJumpList(), /requires executablePath/)
})

test('installJumpList uses only the injected Electron app and degrades safely', () => {
  let installed
  const app = {
    getPath: (name) => (name === 'exe' ? 'C:\\Aurora\\Aurora.exe' : ''),
    setJumpList: (categories) => {
      installed = categories
      return 'ok'
    },
  }
  assert.equal(installJumpList({ app }), true)
  assert.equal(installed[0].items[0].args, '--home')
  assert.equal(installJumpList({ app: { setJumpList: () => 'error' } }), false)
  assert.equal(installJumpList(), false)
})

test('shouldUseMica is restricted to Windows 11 with accessibility-safe settings', () => {
  const base = { platform: 'win32', systemVersion: '10.0.22631' }
  assert.equal(shouldUseMica(base), true)
  assert.equal(shouldUseMica({ ...base, systemVersion: '10.0.22621' }), true)
  assert.equal(shouldUseMica({ ...base, systemVersion: '10.0.22000' }), false)
  assert.equal(shouldUseMica({ ...base, systemVersion: '10.0.19045' }), false)
  assert.equal(shouldUseMica({ ...base, platform: 'darwin' }), false)
  assert.equal(shouldUseMica({ ...base, forcedColors: true }), false)
  assert.equal(shouldUseMica({ ...base, transparencyEnabled: false }), false)
  assert.equal(shouldUseMica({ ...base, reduceTransparency: true }), false)
  assert.equal(shouldUseMica({ ...base, micaSupported: false }), false)
})

test('applyWindowsAppearance enables Mica when supported and uses opaque forced-color fallback', () => {
  const calls = []
  const window = {
    setBackgroundMaterial: (value) => calls.push(['material', value]),
    setBackgroundColor: (value) => calls.push(['color', value]),
  }
  assert.deepEqual(
    applyWindowsAppearance({
      window,
      nativeTheme: { shouldUseDarkColors: true, inForcedColorsMode: false },
      platform: 'win32',
      systemVersion: '10.0.22631',
    }),
    { usedMica: true, material: 'mica', backgroundColor: '#00000000' },
  )
  assert.deepEqual(calls, [
    ['material', 'mica'],
    ['color', '#00000000'],
  ])

  calls.length = 0
  assert.deepEqual(
    applyWindowsAppearance({
      window,
      nativeTheme: { shouldUseDarkColors: true, inForcedColorsMode: true },
      platform: 'win32',
      systemVersion: '10.0.22631',
    }),
    { usedMica: false, material: 'none', backgroundColor: '#000000' },
  )
  assert.deepEqual(calls, [
    ['material', 'none'],
    ['color', '#000000'],
  ])

  calls.length = 0
  assert.deepEqual(
    applyWindowsAppearance({
      window,
      nativeTheme: {
        shouldUseDarkColors: false,
        inForcedColorsMode: false,
        shouldUseHighContrastColors: true,
      },
      platform: 'win32',
      systemVersion: '10.0.22631',
    }),
    { usedMica: false, material: 'none', backgroundColor: '#ffffff' },
  )
  assert.deepEqual(calls, [
    ['material', 'none'],
    ['color', '#ffffff'],
  ])
})

test('applyWindowsAppearance catches unavailable Mica and still applies opaque fallback', () => {
  const calls = []
  const window = {
    setBackgroundMaterial: (value) => {
      calls.push(['material', value])
      if (value === 'mica') throw new Error('unsupported')
    },
    setBackgroundColor: (value) => calls.push(['color', value]),
  }
  assert.deepEqual(
    applyWindowsAppearance({
      window,
      nativeTheme: { shouldUseDarkColors: false },
      platform: 'win32',
      systemVersion: '10.0.22631',
    }),
    { usedMica: false, material: 'none', backgroundColor: '#f7f7f7' },
  )
  assert.deepEqual(calls, [
    ['material', 'mica'],
    ['material', 'none'],
    ['color', '#f7f7f7'],
  ])
})

test('handleDesktopShortcut maps Windows navigation, reload, and zoom keys', () => {
  const calls = []
  const actions = {
    back: () => calls.push('back'),
    forward: () => calls.push('forward'),
    reload: () => calls.push('reload'),
    zoomIn: () => calls.push('zoom-in'),
    zoomOut: () => calls.push('zoom-out'),
    zoomReset: () => calls.push('zoom-reset'),
  }
  assert.equal(
    handleDesktopShortcut({ type: 'keyDown', alt: true, key: 'ArrowLeft' }, actions),
    true,
  )
  assert.equal(
    handleDesktopShortcut({ type: 'keyDown', alt: true, key: 'ArrowRight' }, actions),
    true,
  )
  assert.equal(handleDesktopShortcut({ type: 'keyDown', control: true, key: 'r' }, actions), true)
  assert.equal(
    handleDesktopShortcut({ type: 'keyDown', control: true, shift: true, key: '+' }, actions),
    true,
  )
  assert.equal(handleDesktopShortcut({ type: 'keyDown', control: true, key: '-' }, actions), true)
  assert.equal(handleDesktopShortcut({ type: 'keyDown', control: true, key: '0' }, actions), true)
  assert.deepEqual(calls, ['back', 'forward', 'reload', 'zoom-in', 'zoom-out', 'zoom-reset'])
})

test('handleDesktopShortcut does not interfere with IME, AltGr, key-up, or unknown keys', () => {
  const actions = { reload: () => assert.fail('must not run') }
  assert.equal(
    handleDesktopShortcut(
      { type: 'keyDown', control: true, key: 'Process', isComposing: true },
      actions,
    ),
    false,
  )
  assert.equal(
    handleDesktopShortcut({ type: 'keyDown', control: true, key: 'r', keyCode: '229' }, actions),
    false,
  )
  assert.equal(
    handleDesktopShortcut(
      { type: 'keyDown', control: true, key: 'r', keyCode: 'ProcessKey' },
      actions,
    ),
    false,
  )
  assert.equal(
    handleDesktopShortcut({ type: 'keyDown', control: true, alt: true, key: 'r' }, actions),
    false,
  )
  assert.equal(handleDesktopShortcut({ type: 'keyUp', control: true, key: 'r' }, actions), false)
  assert.equal(
    handleDesktopShortcut({ type: 'keyDown', control: true, shift: true, key: 'r' }, actions),
    false,
  )
})
