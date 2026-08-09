import * as defaultFs from 'node:fs/promises'
import path from 'node:path'

export const DEFAULT_WINDOW_STATE = Object.freeze({
  width: 1280,
  height: 820,
  maximized: false,
})

// 520×360 DIP still fits a 1366×768 display at 200% Windows scaling.
export const MIN_WINDOW_WIDTH = 520
export const MIN_WINDOW_HEIGHT = 360
const MAX_WINDOW_DIMENSION = 16_384

function finiteInteger(value) {
  return Number.isFinite(value) ? Math.round(value) : undefined
}

function normalizedDimension(value, fallback, minimum) {
  const candidate = finiteInteger(value)
  if (candidate === undefined || candidate <= 0) return fallback
  return Math.min(MAX_WINDOW_DIMENSION, Math.max(minimum, candidate))
}

export function normalizeWindowState(value, fallback = DEFAULT_WINDOW_STATE) {
  const candidate = value && typeof value === 'object' ? value : {}
  const safeFallback = fallback && typeof fallback === 'object' ? fallback : DEFAULT_WINDOW_STATE
  const fallbackWidth = normalizedDimension(
    safeFallback.width,
    DEFAULT_WINDOW_STATE.width,
    MIN_WINDOW_WIDTH,
  )
  const fallbackHeight = normalizedDimension(
    safeFallback.height,
    DEFAULT_WINDOW_STATE.height,
    MIN_WINDOW_HEIGHT,
  )
  const x = finiteInteger(candidate.x) ?? finiteInteger(safeFallback.x)
  const y = finiteInteger(candidate.y) ?? finiteInteger(safeFallback.y)

  const normalized = {
    width: normalizedDimension(candidate.width, fallbackWidth, MIN_WINDOW_WIDTH),
    height: normalizedDimension(candidate.height, fallbackHeight, MIN_WINDOW_HEIGHT),
    maximized:
      typeof candidate.maximized === 'boolean'
        ? candidate.maximized
        : safeFallback.maximized === true,
  }
  if (x !== undefined) normalized.x = x
  if (y !== undefined) normalized.y = y
  return normalized
}

function normalizeWorkArea(displayOrArea) {
  const candidate = displayOrArea?.workArea ?? displayOrArea
  if (!candidate || typeof candidate !== 'object') return null
  const x = finiteInteger(candidate.x)
  const y = finiteInteger(candidate.y)
  const width = finiteInteger(candidate.width)
  const height = finiteInteger(candidate.height)
  if (x === undefined || y === undefined || !width || !height || width < 1 || height < 1) {
    return null
  }
  return { x, y, width, height }
}

/** Fit a child window (OAuth/preview) inside the parent's current display work area. */
export function fitAuxiliaryWindowBounds(
  displayOrWorkArea,
  { width = 760, height = 720, minWidth = 520, minHeight = 360 } = {},
) {
  const workArea = normalizeWorkArea(displayOrWorkArea)
  const preferredWidth = Math.max(1, finiteInteger(width) ?? 760)
  const preferredHeight = Math.max(1, finiteInteger(height) ?? 720)
  const requestedMinWidth = Math.max(1, finiteInteger(minWidth) ?? 520)
  const requestedMinHeight = Math.max(1, finiteInteger(minHeight) ?? 360)
  if (!workArea) {
    return {
      width: Math.max(preferredWidth, requestedMinWidth),
      height: Math.max(preferredHeight, requestedMinHeight),
      minWidth: requestedMinWidth,
      minHeight: requestedMinHeight,
    }
  }

  const fittedWidth = Math.min(workArea.width, Math.max(preferredWidth, requestedMinWidth))
  const fittedHeight = Math.min(workArea.height, Math.max(preferredHeight, requestedMinHeight))
  return {
    x: workArea.x + Math.floor((workArea.width - fittedWidth) / 2),
    y: workArea.y + Math.floor((workArea.height - fittedHeight) / 2),
    width: fittedWidth,
    height: fittedHeight,
    minWidth: Math.min(requestedMinWidth, fittedWidth),
    minHeight: Math.min(requestedMinHeight, fittedHeight),
  }
}

function intersectionArea(bounds, workArea) {
  const left = Math.max(bounds.x, workArea.x)
  const top = Math.max(bounds.y, workArea.y)
  const right = Math.min(bounds.x + bounds.width, workArea.x + workArea.width)
  const bottom = Math.min(bounds.y + bounds.height, workArea.y + workArea.height)
  return Math.max(0, right - left) * Math.max(0, bottom - top)
}

function centerDistanceSquared(bounds, workArea) {
  const boundsX = bounds.x + bounds.width / 2
  const boundsY = bounds.y + bounds.height / 2
  const areaX = workArea.x + workArea.width / 2
  const areaY = workArea.y + workArea.height / 2
  return (boundsX - areaX) ** 2 + (boundsY - areaY) ** 2
}

function selectWorkArea(state, workAreas) {
  if (state.x === undefined || state.y === undefined) return workAreas[0]

  let selected = workAreas[0]
  let selectedIntersection = -1
  let selectedDistance = Number.POSITIVE_INFINITY
  for (const workArea of workAreas) {
    const overlap = intersectionArea(state, workArea)
    const distance = centerDistanceSquared(state, workArea)
    if (
      overlap > selectedIntersection ||
      (overlap === selectedIntersection && distance < selectedDistance)
    ) {
      selected = workArea
      selectedIntersection = overlap
      selectedDistance = distance
    }
  }
  return selected
}

/** Clamp a normalized window to one currently attached display's work area. */
export function clampWindowStateToWorkAreas(state, displaysOrWorkAreas = []) {
  const normalized = normalizeWindowState(state)
  const workAreas = displaysOrWorkAreas.map(normalizeWorkArea).filter(Boolean)
  if (workAreas.length === 0) return normalized

  const workArea = selectWorkArea(normalized, workAreas)
  const width = Math.min(workArea.width, normalized.width)
  const height = Math.min(workArea.height, normalized.height)
  const centeredX = workArea.x + Math.floor((workArea.width - width) / 2)
  const centeredY = workArea.y + Math.floor((workArea.height - height) / 2)
  const requestedX = normalized.x ?? centeredX
  const requestedY = normalized.y ?? centeredY
  const x = Math.min(workArea.x + workArea.width - width, Math.max(workArea.x, requestedX))
  const y = Math.min(workArea.y + workArea.height - height, Math.max(workArea.y, requestedY))

  return { x, y, width, height, maximized: normalized.maximized }
}

/** Recover a live normal window after monitor removal or DPI/work-area changes. */
export function recoverWindowToWorkAreas(browserWindow, displaysOrWorkAreas = []) {
  if (
    !browserWindow ||
    browserWindow.isDestroyed?.() === true ||
    browserWindow.isMaximized?.() === true ||
    browserWindow.isFullScreen?.() === true ||
    typeof browserWindow.getBounds !== 'function' ||
    typeof browserWindow.setBounds !== 'function'
  ) {
    return false
  }

  const current = browserWindow.getBounds()
  const recovered = clampWindowStateToWorkAreas(
    { ...current, maximized: false },
    displaysOrWorkAreas,
  )
  if (
    current.x === recovered.x &&
    current.y === recovered.y &&
    current.width === recovered.width &&
    current.height === recovered.height
  ) {
    return false
  }
  browserWindow.setBounds({
    x: recovered.x,
    y: recovered.y,
    width: recovered.width,
    height: recovered.height,
  })
  return true
}

function snapshotWindow(browserWindow) {
  if (!browserWindow || browserWindow.isDestroyed?.()) return null
  const bounds =
    browserWindow.getNormalBounds?.() ?? browserWindow.getBounds?.() ?? DEFAULT_WINDOW_STATE
  return normalizeWindowState({
    ...bounds,
    maximized: browserWindow.isMaximized?.() === true,
  })
}

export class WindowStateStore {
  constructor(options) {
    const normalizedOptions =
      typeof options === 'string' ? { userDataPath: options } : (options ?? {})
    const {
      userDataPath,
      fileName = 'window-state.json',
      debounceMs = 250,
      fsImpl = defaultFs,
      timers = { setTimeout, clearTimeout },
      onError = () => {},
    } = normalizedOptions
    if (typeof userDataPath !== 'string' || userDataPath.length === 0) {
      throw new TypeError('WindowStateStore requires a userDataPath')
    }

    this.filePath = path.join(userDataPath, fileName)
    this.debounceMs = Math.max(0, finiteInteger(debounceMs) ?? 250)
    this.fs = fsImpl
    this.timers = timers
    this.onError = onError
    this.pendingState = null
    this.timer = null
    this.writeSerial = 0
    this.lastWriteError = null
    this.writeChain = Promise.resolve()
    this.detachCallbacks = new Set()
  }

  async load(options = {}) {
    const normalizedOptions = Array.isArray(options) ? { workAreas: options } : options
    const { workAreas = [], fallback = DEFAULT_WINDOW_STATE } = normalizedOptions
    let state = fallback
    try {
      const raw = await this.fs.readFile(this.filePath, 'utf8')
      state = JSON.parse(raw)
    } catch {
      // Missing, unreadable, and corrupt state all recover to a visible default.
    }
    return clampWindowStateToWorkAreas(normalizeWindowState(state, fallback), workAreas)
  }

  scheduleSave(state) {
    this.pendingState = normalizeWindowState(state)
    if (this.timer !== null) this.timers.clearTimeout(this.timer)
    this.timer = this.timers.setTimeout(() => {
      this.timer = null
      const pending = this.pendingState
      this.pendingState = null
      if (pending) this.#queueWrite(pending)
    }, this.debounceMs)
    this.timer?.unref?.()
  }

  attach(browserWindow) {
    if (!browserWindow || typeof browserWindow.on !== 'function') {
      throw new TypeError('attach requires an event-emitting window')
    }
    const save = () => {
      const state = snapshotWindow(browserWindow)
      if (state) this.scheduleSave(state)
    }
    const events = ['move', 'resize', 'maximize', 'unmaximize']
    for (const eventName of events) browserWindow.on(eventName, save)

    let detached = false
    const detach = () => {
      if (detached) return
      detached = true
      for (const eventName of events) browserWindow.removeListener?.(eventName, save)
      this.detachCallbacks.delete(detach)
    }
    this.detachCallbacks.add(detach)
    return detach
  }

  async flush() {
    if (this.timer !== null) {
      this.timers.clearTimeout(this.timer)
      this.timer = null
    }
    if (this.pendingState) {
      const pending = this.pendingState
      this.pendingState = null
      this.#queueWrite(pending)
    }
    await this.writeChain
    if (this.lastWriteError) throw this.lastWriteError
  }

  dispose() {
    if (this.timer !== null) this.timers.clearTimeout(this.timer)
    this.timer = null
    for (const detach of [...this.detachCallbacks]) detach()
  }

  #queueWrite(state) {
    const task = this.writeChain.then(() => this.#persist(state))
    this.writeChain = task.catch((error) => {
      this.lastWriteError = error
      this.onError(error)
    })
    return task
  }

  async #persist(state) {
    const directory = path.dirname(this.filePath)
    const temporaryPath = `${this.filePath}.tmp-${process.pid}-${++this.writeSerial}`
    await this.fs.mkdir(directory, { recursive: true })
    try {
      await this.fs.writeFile(temporaryPath, `${JSON.stringify(state)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      })
      await this.fs.rename(temporaryPath, this.filePath)
      this.lastWriteError = null
    } catch (error) {
      await this.fs.rm?.(temporaryPath, { force: true }).catch?.(() => {})
      throw error
    }
  }
}
