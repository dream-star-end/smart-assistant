import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_DESKTOP_SETTINGS,
  DESKTOP_SETTINGS_FILE,
  DesktopSettingsStore,
  normalizeDesktopSettings,
} from '../src/desktop-settings.mjs'

test('normalizeDesktopSettings defaults closeToTray to false and only accepts true', () => {
  assert.deepEqual(normalizeDesktopSettings(undefined), DEFAULT_DESKTOP_SETTINGS)
  assert.deepEqual(normalizeDesktopSettings(null), { closeToTray: false, localModeEnabled: false })
  assert.deepEqual(normalizeDesktopSettings({ closeToTray: false }), { closeToTray: false, localModeEnabled: false })
  assert.deepEqual(normalizeDesktopSettings({ closeToTray: true }), { closeToTray: true, localModeEnabled: false })
  assert.deepEqual(normalizeDesktopSettings({ closeToTray: 'true' }), { closeToTray: false, localModeEnabled: false })
  assert.deepEqual(normalizeDesktopSettings({ closeToTray: 1 }), { closeToTray: false, localModeEnabled: false })
  assert.deepEqual(normalizeDesktopSettings({ closeToTray: true, extra: 'drop' }), {
    closeToTray: true,
    localModeEnabled: false,
  })
})

test('DesktopSettingsStore loads missing or corrupt files as the safe default', async () => {
  const missing = new DesktopSettingsStore({
    userDataPath: '/tmp/clarvy-desktop-settings-missing',
    fsImpl: {
      readFile: async () => {
        throw Object.assign(new Error('enoent'), { code: 'ENOENT' })
      },
    },
  })
  assert.equal(missing.filePath.endsWith(DESKTOP_SETTINGS_FILE), true)
  assert.deepEqual(await missing.load(), { closeToTray: false, localModeEnabled: false })
  assert.equal(missing.closeToTray, false)

  const corrupt = new DesktopSettingsStore({
    userDataPath: '/tmp/clarvy-desktop-settings-corrupt',
    fsImpl: {
      readFile: async () => '{not-json',
    },
  })
  assert.deepEqual(await corrupt.load(), { closeToTray: false, localModeEnabled: false })
})

test('DesktopSettingsStore persists closeToTray and localModeEnabled atomically', async () => {
  const files = new Map()
  const fsImpl = {
    mkdir: async () => {},
    writeFile: async (filePath, contents) => {
      files.set(filePath, contents)
    },
    rename: async (from, to) => {
      files.set(to, files.get(from))
      files.delete(from)
    },
    readFile: async (filePath) => {
      if (!files.has(filePath)) throw Object.assign(new Error('enoent'), { code: 'ENOENT' })
      return files.get(filePath)
    },
    rm: async (filePath) => {
      files.delete(filePath)
    },
  }

  const store = new DesktopSettingsStore({
    userDataPath: 'C:\\Users\\test\\AppData\\Roaming\\Clarvy',
    fsImpl,
  })
  assert.deepEqual(await store.load(), { closeToTray: false, localModeEnabled: false })
  assert.deepEqual(await store.setCloseToTray(true), { closeToTray: true, localModeEnabled: false })
  assert.equal(store.closeToTray, true)
  assert.equal(files.get(store.filePath), '{"closeToTray":true,"localModeEnabled":false}\n')
  assert.equal([...files.keys()].some((key) => key.includes('.tmp-')), false)

  assert.deepEqual(await store.setLocalModeEnabled(true), { closeToTray: true, localModeEnabled: true })
  assert.equal(store.localModeEnabled, true)

  const reloaded = new DesktopSettingsStore({
    userDataPath: 'C:\\Users\\test\\AppData\\Roaming\\Clarvy',
    fsImpl,
  })
  assert.deepEqual(await reloaded.load(), { closeToTray: true, localModeEnabled: true })
  assert.deepEqual(await reloaded.setCloseToTray(false), { closeToTray: false, localModeEnabled: true })
  assert.equal(files.get(reloaded.filePath), '{"closeToTray":false,"localModeEnabled":true}\n')
})

test('DesktopSettingsStore constructor requires userDataPath', () => {
  assert.throws(() => new DesktopSettingsStore(), /requires a userDataPath/)
  assert.throws(() => new DesktopSettingsStore({ userDataPath: '' }), /requires a userDataPath/)
})
