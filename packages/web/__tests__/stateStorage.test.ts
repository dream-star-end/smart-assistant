import * as assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

class MemoryStorage {
  private data = new Map<string, string>()
  constructor(seed: Record<string, string> = {}, private opts: { throwSet?: boolean; throwGet?: boolean; throwRemove?: boolean } = {}) {
    for (const [k, v] of Object.entries(seed)) this.data.set(k, v)
  }
  getItem(key: string) {
    if (this.opts.throwGet) throw new Error('get blocked')
    return this.data.has(key) ? this.data.get(key)! : null
  }
  setItem(key: string, value: string) {
    if (this.opts.throwSet) throw new Error('set blocked')
    this.data.set(key, String(value))
  }
  removeItem(key: string) {
    if (this.opts.throwRemove) throw new Error('remove blocked')
    this.data.delete(key)
  }
}

let seq = 0
async function importFreshState(localStorage: MemoryStorage, sessionStorage: MemoryStorage) {
  Object.defineProperty(globalThis, 'localStorage', { value: localStorage, configurable: true })
  Object.defineProperty(globalThis, 'sessionStorage', { value: sessionStorage, configurable: true })
  Object.defineProperty(globalThis, 'document', { value: { hasFocus: () => true }, configurable: true })
  const url = pathToFileURL(resolve(import.meta.dirname, '..', 'public', 'modules', 'state.js')).href
  return import(`${url}?state-storage-test=${Date.now()}-${++seq}`)
}

describe('state token storage migration', () => {
  it('removes legacy localStorage access token even when sessionStorage.setItem throws', async () => {
    const local = new MemoryStorage({
      openclaude_access_token: 'legacy-access',
      openclaude_access_exp: '1700000000',
    })
    const session = new MemoryStorage({}, { throwSet: true })

    const mod = await importFreshState(local, session)

    assert.equal(mod.state.token, 'legacy-access')
    assert.equal(mod.state.tokenExp, 1700000000)
    assert.equal(local.getItem('openclaude_access_token'), null)
    assert.equal(local.getItem('openclaude_access_exp'), null)
  })

  it('uses safe storage wrappers when storage reads throw', async () => {
    const local = new MemoryStorage({}, { throwGet: true })
    const session = new MemoryStorage({}, { throwGet: true })

    const mod = await importFreshState(local, session)

    assert.equal(mod.state.token, '')
    assert.equal(mod.state.tokenExp, 0)
  })
})
