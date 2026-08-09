import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  DEFAULT_WINDOW_STATE,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  WindowStateStore,
  clampWindowStateToWorkAreas,
  fitAuxiliaryWindowBounds,
  normalizeWindowState,
  recoverWindowToWorkAreas,
} from '../src/window-state.mjs'

test('minimum bounds remain usable on a 1366x768 display at 200% scaling', () => {
  assert.equal(MIN_WINDOW_WIDTH, 520)
  assert.equal(MIN_WINDOW_HEIGHT, 360)
  assert.deepEqual(
    clampWindowStateToWorkAreas(DEFAULT_WINDOW_STATE, [{ x: 0, y: 0, width: 683, height: 360 }]),
    { x: 0, y: 0, width: 683, height: 360, maximized: false },
  )
})

test('OAuth and preview windows fit a 1366x768 display at 200% scaling', () => {
  assert.deepEqual(
    fitAuxiliaryWindowBounds(
      { workArea: { x: 0, y: 0, width: 683, height: 360 } },
      { width: 760, height: 820, minWidth: 520, minHeight: 360 },
    ),
    { x: 0, y: 0, width: 683, height: 360, minWidth: 520, minHeight: 360 },
  )
})

test('live display recovery moves a normal off-screen window but leaves maximized windows alone', () => {
  const calls = []
  const normalWindow = {
    getBounds: () => ({ x: 4000, y: -900, width: 900, height: 600 }),
    isDestroyed: () => false,
    isFullScreen: () => false,
    isMaximized: () => false,
    setBounds: (bounds) => calls.push(bounds),
  }
  assert.equal(
    recoverWindowToWorkAreas(normalWindow, [{ x: 0, y: 0, width: 1920, height: 1040 }]),
    true,
  )
  assert.deepEqual(calls, [{ x: 1020, y: 0, width: 900, height: 600 }])

  const maximizedWindow = { ...normalWindow, isMaximized: () => true }
  assert.equal(
    recoverWindowToWorkAreas(maximizedWindow, [{ x: 0, y: 0, width: 1920, height: 1040 }]),
    false,
  )
  assert.equal(calls.length, 1)
})

test('normalizeWindowState accepts only finite bounded geometry and boolean maximized', () => {
  assert.deepEqual(
    normalizeWindowState({
      x: 12.4,
      y: Number.POSITIVE_INFINITY,
      width: -4,
      height: 900.7,
      maximized: 'yes',
    }),
    { x: 12, width: 1280, height: 901, maximized: false },
  )
  assert.deepEqual(normalizeWindowState(null), DEFAULT_WINDOW_STATE)
})

test('clampWindowStateToWorkAreas recovers a window from a disconnected display', () => {
  assert.deepEqual(
    clampWindowStateToWorkAreas({ x: 4000, y: -900, width: 1200, height: 900, maximized: true }, [
      { workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
    ]),
    { x: 720, y: 0, width: 1200, height: 900, maximized: true },
  )
})

test('clampWindowStateToWorkAreas keeps a window on its attached secondary display', () => {
  assert.deepEqual(
    clampWindowStateToWorkAreas({ x: 2050, y: 100, width: 1000, height: 700, maximized: false }, [
      { x: 0, y: 0, width: 1920, height: 1040 },
      { x: 1920, y: 0, width: 1600, height: 900 },
    ]),
    { x: 2050, y: 100, width: 1000, height: 700, maximized: false },
  )
})

test('clampWindowStateToWorkAreas centers defaults and fits unusually small work areas', () => {
  assert.deepEqual(
    clampWindowStateToWorkAreas(DEFAULT_WINDOW_STATE, [
      { x: -800, y: 40, width: 600, height: 500 },
    ]),
    { x: -800, y: 40, width: 600, height: 500, maximized: false },
  )
})

test('WindowStateStore loads JSON and recovers corrupt state to a visible fallback', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aurora-window-state-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = new WindowStateStore(directory)
  await writeFile(
    path.join(directory, 'window-state.json'),
    JSON.stringify({ x: 4000, y: 10, width: 1000, height: 700, maximized: true }),
  )
  assert.deepEqual(await store.load({ workAreas: [{ x: 0, y: 0, width: 1920, height: 1040 }] }), {
    x: 920,
    y: 10,
    width: 1000,
    height: 700,
    maximized: true,
  })

  await writeFile(path.join(directory, 'window-state.json'), '{not-json')
  assert.deepEqual(await store.load({ workAreas: [{ x: 0, y: 0, width: 1920, height: 1040 }] }), {
    x: 320,
    y: 110,
    width: 1280,
    height: 820,
    maximized: false,
  })
})

test('WindowStateStore attach debounces window events and flush persists the latest normal bounds', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aurora-window-events-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const browserWindow = new EventEmitter()
  browserWindow.isDestroyed = () => false
  browserWindow.isMaximized = () => false
  let bounds = { x: 10, y: 20, width: 1000, height: 700 }
  browserWindow.getNormalBounds = () => bounds

  const store = new WindowStateStore({ userDataPath: directory, debounceMs: 60_000 })
  const detach = store.attach(browserWindow)
  browserWindow.emit('move')
  bounds = { x: 50, y: 70, width: 1100, height: 760 }
  browserWindow.emit('resize')
  await store.flush()

  assert.deepEqual(JSON.parse(await readFile(store.filePath, 'utf8')), {
    x: 50,
    y: 70,
    width: 1100,
    height: 760,
    maximized: false,
  })
  detach()
  bounds = { x: 999, y: 999, width: 1100, height: 760 }
  browserWindow.emit('move')
  assert.equal(store.pendingState, null)
  store.dispose()
})
