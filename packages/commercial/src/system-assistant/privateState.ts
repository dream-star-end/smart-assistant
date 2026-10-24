/** Host-only state. Importing this module creates no directories or keys. */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import {
  closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync,
  openSync, readFileSync, realpathSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
const KEY_MAGIC = Buffer.from('OCSAKEY1')
const KEY_RECORD_BYTES = 72
function errorCode(e: unknown): string | undefined { return e && typeof e === 'object' && 'code' in e ? String(e.code) : undefined }
export function ensureSystemActionDirectory(path: string): void {
  if (!isAbsolute(path)) throw new Error('System action state requires an absolute private directory')
  // Creation is deliberately one level: composition initializes each private
  // parent explicitly. Always sync the parent, including an EEXIST race.
  try { mkdirSync(path, { mode: 0o700 }) } catch (e) { if (errorCode(e) !== 'EEXIST') throw e }
  const info = lstatSync(path)
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700 || info.uid !== process.getuid?.() || realpathSync(path) !== resolve(path)) throw new Error('Unsafe system action state directory')
  fsyncSystemActionDirectory(dirname(resolve(path)))
}
export function fsyncSystemActionDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { fsyncSync(fd) } finally { closeSync(fd) }
}
function hasLeaf(path: string): boolean {
  try { lstatSync(path); return true } catch (e) { if (errorCode(e) === 'ENOENT') return false; throw e }
}
function readKey(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  let record: Buffer | undefined
  try {
    const info = fstatSync(fd)
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600 || info.size !== KEY_RECORD_BYTES) throw new Error('Invalid system action key file')
    record = readFileSync(fd)
    if (record.length !== KEY_RECORD_BYTES || !record.subarray(0, 8).equals(KEY_MAGIC)) throw new Error('Unsupported system action key format')
    const expected = createHash('sha256').update(record.subarray(0, 40)).digest()
    if (!timingSafeEqual(expected, record.subarray(40))) throw new Error('Corrupt system action key file')
    return Buffer.from(record.subarray(8, 40))
  } finally { record?.fill(0); closeSync(fd) }
}
/** Atomic publication; missing/corrupt keys beside any existing ledger are never replaced. */
export function loadOrCreateSystemActionKey(root: string, ledgerPath = join(root, 'ledger.sqlite')): Buffer {
  ensureSystemActionDirectory(root)
  if (dirname(ledgerPath) !== root) throw new Error('System action ledger must share its private directory')
  const keyPath = join(root, 'key.bin')
  try { return readKey(keyPath) } catch (e) { if (errorCode(e) !== 'ENOENT') throw e }
  if ([ledgerPath, `${ledgerPath}-wal`, `${ledgerPath}-shm`].some(hasLeaf)) {
    // A concurrent starter may have published the key and opened the ledger after our first read.
    try { return readKey(keyPath) } catch (e) { if (errorCode(e) !== 'ENOENT') throw e }
    throw new Error('System action ledger exists without its key')
  }
  const temporary = join(root, `.key-${randomUUID()}.tmp`)
  const material = randomBytes(32)
  const header = Buffer.concat([KEY_MAGIC, material])
  const record = Buffer.concat([header, createHash('sha256').update(header).digest()])
  let created = false
  try {
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    created = true
    try { writeFileSync(fd, record); fsyncSync(fd) } finally { closeSync(fd) }
    try { linkSync(temporary, keyPath) } catch (e) { if (errorCode(e) !== 'EEXIST') throw e }
    fsyncSystemActionDirectory(root)
    return readKey(keyPath)
  } finally {
    material.fill(0); header.fill(0); record.fill(0)
    if (created) { unlinkSync(temporary); fsyncSystemActionDirectory(root) }
  }
}
