// OpenClaude — IndexedDB persistence with in-memory fallback
//
// IndexedDB is the primary offline store for sessions. But it can be
// unavailable for several reasons:
//   • Private/Incognito browsing (some Firefox/Safari versions)
//   • Corrupted profile (user permission reset, full disk, etc.)
//   • Synchronous throw on indexedDB.open (rare but possible on iOS)
//
// When IDB is flat-out unavailable we fall back to an in-memory Map so the
// UI still works for the lifetime of the tab. The user is warned once so
// they don't assume their sessions are being persisted. Transient errors
// (quota, tx conflicts) on an otherwise-working IDB still reject normally
// so upstream retry logic (see sessions.js _scheduleSaveRetry) can kick in.

const DB_NAME = 'openclaude'
const DB_VERSION = 1

// Init state: 'pending' (not yet attempted), 'ok' (IDB usable),
// 'unavailable' (permanent fallback to memory).
let _initState = 'pending'
let _db = null
let _openPromise = null  // single-flight guard so concurrent openDB()
                         // calls share one indexedDB.open request instead
                         // of racing multiple upgrades.
const _memoryStore = new Map()
let _onUnavailable = null
// Whether we have successfully notified the UI. Separate from _initState
// so a late-registered listener still receives the notification.
let _uiNotified = false

// UI layer registers a callback (e.g. show a warning toast). Fires exactly
// once per tab session — either synchronously inside this call if IDB is
// already known unavailable, or later when the openDB() path discovers it.
export function onIdbUnavailable(cb) {
  _onUnavailable = cb
  if (_initState === 'unavailable' && !_uiNotified) _fireUnavailable()
}

function _fireUnavailable() {
  // Only flip _uiNotified when we actually deliver the notification. If no
  // listener is registered yet we leave the flag false so a later
  // onIdbUnavailable() call can still fire the callback.
  if (_uiNotified) return
  if (!_onUnavailable) return
  _uiNotified = true
  try { _onUnavailable() } catch {}
}

function _markUnavailable() {
  _initState = 'unavailable'
  _db = null
  _openPromise = null
  _fireUnavailable()
}

export function openDB() {
  if (_initState === 'ok' && _db) return Promise.resolve(_db)
  if (_initState === 'unavailable') return Promise.reject(new Error('IDB unavailable'))
  if (_openPromise) return _openPromise
  _openPromise = new Promise((res, rej) => {
    let req
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION)
    } catch (err) {
      // indexedDB.open can throw synchronously (private mode, disabled, etc.)
      _markUnavailable()
      rej(err)
      return
    }
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('sessions'))
        db.createObjectStore('sessions', { keyPath: 'id' })
    }
    req.onsuccess = () => {
      _db = req.result
      _initState = 'ok'
      // Operational failures after a successful open — usually browser
      // evicting the DB (storage pressure, user clearing site data). Mark
      // as unavailable so future ops use memory fallback instead of endlessly
      // retrying a broken connection.
      _db.onerror = (ev) => {
        console.error('[db] IDB runtime error', ev)
      }
      _db.onclose = () => {
        _markUnavailable()
      }
      res(_db)
    }
    req.onerror = () => {
      _markUnavailable()
      rej(req.error)
    }
    req.onblocked = () => {
      // Another tab holds an older-version open handle preventing upgrade.
      // We treat this as unavailable for THIS load; a reload (or the other
      // tab closing) usually resolves it.
      _markUnavailable()
      rej(new Error('IDB blocked by another tab'))
    }
  }).finally(() => {
    // Clear the single-flight slot once open resolves either way. On success
    // we cache _db so subsequent openDB() short-circuits to it; on failure
    // _initState is 'unavailable' and openDB() returns the rejection directly.
    _openPromise = null
  })
  return _openPromise
}

export async function dbGetAll() {
  if (_initState === 'unavailable') return [..._memoryStore.values()]
  try {
    const db = await openDB()
    return await new Promise((res, rej) => {
      const tx = db.transaction('sessions', 'readonly')
      const req = tx.objectStore('sessions').getAll()
      req.onsuccess = () => res(req.result || [])
      req.onerror = () => rej(req.error)
    })
  } catch {
    // openDB failed or transaction errored — fall back to whatever is in memory
    return [..._memoryStore.values()]
  }
}

export async function dbPut(obj) {
  // Mirror to memory first, regardless of IDB state. If IDB rejects (e.g.
  // quota) the caller can still read back from memory via dbGetAll() during
  // this tab's lifetime, and the retry loop in sessions.js can retry IDB.
  if (obj?.id) _memoryStore.set(obj.id, obj)
  if (_initState === 'unavailable') return
  const db = await openDB()  // throws → caller's retry path handles it
  return new Promise((res, rej) => {
    const tx = db.transaction('sessions', 'readwrite')
    tx.objectStore('sessions').put(obj)
    tx.oncomplete = () => res()
    tx.onerror = () => rej(tx.error)
    tx.onabort = () => rej(tx.error || new Error('IDB transaction aborted'))
  })
}

export async function dbDelete(id) {
  _memoryStore.delete(id)
  if (_initState === 'unavailable') return
  const db = await openDB()
  return new Promise((res, rej) => {
    const tx = db.transaction('sessions', 'readwrite')
    tx.objectStore('sessions').delete(id)
    tx.oncomplete = () => res()
    tx.onerror = () => rej(tx.error)
    tx.onabort = () => rej(tx.error || new Error('IDB transaction aborted'))
  })
}
