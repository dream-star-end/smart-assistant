'use strict'

const { contextBridge, ipcRenderer } = require('electron')

const LOCAL_HOST_CHANNEL = 'clarvy:local-host'
const COMMAND_TYPES = new Set([
  'approve-op',
  'choose-workspace',
  'deny-op',
  'fallback-cloud',
  'get-status',
  'set-workspace',
  'start-enroll',
])
const OPAQUE_ID = /^[A-Za-z0-9_-]{1,128}$/
const MAX_PATH_LENGTH = 4096

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function normalizeCommand(value) {
  if (!isPlainRecord(value) || !COMMAND_TYPES.has(value.type)) return null
  const keys = Object.keys(value)

  if (value.type === 'set-workspace') {
    if (
      keys.length !== 2 ||
      typeof value.path !== 'string' ||
      value.path.length < 1 ||
      value.path.length > MAX_PATH_LENGTH
    ) {
      return null
    }
    return Object.freeze({ type: 'set-workspace', path: value.path })
  }

  if (value.type === 'approve-op' || value.type === 'deny-op') {
    if (keys.length !== 2 || typeof value.id !== 'string' || !OPAQUE_ID.test(value.id)) return null
    return Object.freeze({ type: value.type, id: value.id })
  }

  if (keys.length !== 1) return null
  return Object.freeze({ type: value.type })
}

const api = Object.freeze({
  invoke(payload) {
    const normalized = normalizeCommand(payload)
    if (!normalized) throw new TypeError('Unsupported Clarvy local-host command')
    return ipcRenderer.invoke(LOCAL_HOST_CHANNEL, normalized)
  },
})

contextBridge.exposeInMainWorld('clarvyLocalHost', api)
