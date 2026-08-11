'use strict'

const { contextBridge, ipcRenderer } = require('electron')

const COMMAND_CHANNEL = 'aurora:shell-command'
const STATE_CHANNEL = 'aurora:shell-state'
const COMMAND_TYPES = new Set([
  'back',
  'downloads-close',
  'downloads-open',
  'focus-product',
  'forward',
  'home',
  'open-more-menu',
  'open-downloads-folder',
  'ready',
  'reload',
  'show-download',
  'zoom-in',
  'zoom-out',
  'zoom-reset',
])
const DOWNLOAD_COMMAND_TYPES = new Set(['show-download'])
const OPAQUE_DOWNLOAD_ID = /^[A-Za-z0-9_-]{1,128}$/

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function normalizeCommand(value) {
  if (!isPlainRecord(value) || !COMMAND_TYPES.has(value.type)) return null

  const keys = Object.keys(value)
  if (DOWNLOAD_COMMAND_TYPES.has(value.type)) {
    if (
      keys.length !== 2 ||
      !keys.includes('id') ||
      typeof value.id !== 'string' ||
      !OPAQUE_DOWNLOAD_ID.test(value.id)
    ) {
      return null
    }
    return Object.freeze({ type: value.type, id: value.id })
  }

  if (keys.length !== 1) return null
  return Object.freeze({ type: value.type })
}

function freezeClone(value, depth = 0) {
  if (depth > 8) return null
  if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) return value
  if (typeof value !== 'object') return null
  if (Array.isArray(value)) {
    return Object.freeze(value.slice(0, 100).map((entry) => freezeClone(entry, depth + 1)))
  }
  if (!isPlainRecord(value)) return null

  const result = Object.create(null)
  for (const [key, entry] of Object.entries(value).slice(0, 100)) {
    result[key] = freezeClone(entry, depth + 1)
  }
  return Object.freeze(result)
}

const api = Object.freeze({
  send(command) {
    const normalized = normalizeCommand(command)
    if (!normalized) throw new TypeError('Unsupported Aurora desktop command')
    ipcRenderer.send(COMMAND_CHANNEL, normalized)
    return true
  },

  subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('State listener must be a function')
    let active = true
    const handler = (_event, state) => {
      if (active) listener(freezeClone(state))
    }
    ipcRenderer.on(STATE_CHANNEL, handler)

    return Object.freeze(function unsubscribe() {
      if (!active) return
      active = false
      ipcRenderer.removeListener(STATE_CHANNEL, handler)
    })
  },
})

contextBridge.exposeInMainWorld('auroraDesktop', api)
