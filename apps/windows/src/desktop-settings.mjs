import * as defaultFs from 'node:fs/promises'
import path from 'node:path'

export const DESKTOP_SETTINGS_FILE = 'desktop-settings.json'
export const DEFAULT_DESKTOP_SETTINGS = Object.freeze({
  closeToTray: false,
})

export function normalizeDesktopSettings(value) {
  return {
    closeToTray: value != null && typeof value === 'object' && value.closeToTray === true,
  }
}

export class DesktopSettingsStore {
  constructor(options = {}) {
    const {
      userDataPath,
      fileName = DESKTOP_SETTINGS_FILE,
      fsImpl = defaultFs,
      onError = () => {},
    } = options
    if (typeof userDataPath !== 'string' || userDataPath.length === 0) {
      throw new TypeError('DesktopSettingsStore requires a userDataPath')
    }

    this.filePath = path.join(userDataPath, fileName)
    this.fs = fsImpl
    this.onError = onError
    this.settings = { ...DEFAULT_DESKTOP_SETTINGS }
    this.writeChain = Promise.resolve()
    this.writeSerial = 0
  }

  async load() {
    try {
      const raw = await this.fs.readFile(this.filePath, 'utf8')
      this.settings = normalizeDesktopSettings(JSON.parse(raw))
    } catch {
      this.settings = { ...DEFAULT_DESKTOP_SETTINGS }
    }
    return { ...this.settings }
  }

  get closeToTray() {
    return this.settings.closeToTray === true
  }

  async setCloseToTray(value) {
    this.settings = normalizeDesktopSettings({ closeToTray: value === true })
    await this.#persist()
    return { ...this.settings }
  }

  async #persist() {
    const task = this.writeChain.then(async () => {
      const directory = path.dirname(this.filePath)
      const temporaryPath = `${this.filePath}.tmp-${process.pid}-${++this.writeSerial}`
      await this.fs.mkdir(directory, { recursive: true })
      try {
        await this.fs.writeFile(temporaryPath, `${JSON.stringify(this.settings)}\n`, {
          encoding: 'utf8',
          mode: 0o600,
        })
        await this.fs.rename(temporaryPath, this.filePath)
      } catch (error) {
        await this.fs.rm?.(temporaryPath, { force: true }).catch?.(() => {})
        throw error
      }
    })
    this.writeChain = task.catch((error) => {
      this.onError(error)
    })
    await this.writeChain
  }
}
