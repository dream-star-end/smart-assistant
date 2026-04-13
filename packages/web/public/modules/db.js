// OpenClaude — IndexedDB persistence
const DB_NAME = 'openclaude'
const DB_VERSION = 1
let _db = null

export function openDB() {
  if (_db) return Promise.resolve(_db)
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('sessions'))
        db.createObjectStore('sessions', { keyPath: 'id' })
    }
    req.onsuccess = () => {
      _db = req.result
      res(_db)
    }
    req.onerror = () => rej(req.error)
  })
}

export async function dbGetAll() {
  const db = await openDB()
  return new Promise((res, rej) => {
    const tx = db.transaction('sessions', 'readonly')
    const req = tx.objectStore('sessions').getAll()
    req.onsuccess = () => res(req.result || [])
    req.onerror = () => rej(req.error)
  })
}

export async function dbPut(obj) {
  const db = await openDB()
  return new Promise((res, rej) => {
    const tx = db.transaction('sessions', 'readwrite')
    tx.objectStore('sessions').put(obj)
    tx.oncomplete = () => res()
    tx.onerror = () => rej(tx.error)
  })
}

export async function dbDelete(id) {
  const db = await openDB()
  return new Promise((res, rej) => {
    const tx = db.transaction('sessions', 'readwrite')
    tx.objectStore('sessions').delete(id)
    tx.oncomplete = () => res()
    tx.onerror = () => rej(tx.error)
  })
}
