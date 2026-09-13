import { readFileSync, readlinkSync } from 'node:fs'

/** Kernel evidence for restart reconciliation, NOT native tool identity. */
export type ReceiptParentProcess = Readonly<{ pid: number; startTicks: string; bootId: string; pidNamespace: string }>
const uuid = /^[a-f0-9-]{36}$/
export function checkedReceiptParentProcess(value: unknown): ReceiptParentProcess {
  const p = value as ReceiptParentProcess | null
  if (!p || !Number.isSafeInteger(p.pid) || p.pid < 1 || typeof p.startTicks !== 'string' || !/^\d+$/.test(p.startTicks) ||
      typeof p.bootId !== 'string' || !uuid.test(p.bootId) || typeof p.pidNamespace !== 'string' || !/^pid:\[\d+\]$/.test(p.pidNamespace)) {
    throw new Error('invalid receipt parent process')
  }
  return Object.freeze({ pid: p.pid, startTicks: p.startTicks, bootId: p.bootId, pidNamespace: p.pidNamespace })
}
function stat(pid: number) {
  const text = readFileSync(`/proc/${pid}/stat`, 'utf8')
  const end = text.lastIndexOf(')')
  if (end < 0 || !text.startsWith(`${pid} (`)) throw new Error('invalid process stat')
  const fields = text.slice(end + 2).trim().split(/\s+/)
  if (!/^\d+$/.test(fields[19] ?? '')) throw new Error('missing process start ticks')
  return { state: fields[0], startTicks: fields[19]! }
}
export function captureReceiptParentProcess(pid: unknown): ReceiptParentProcess | undefined {
  if (process.platform !== 'linux' || !Number.isSafeInteger(pid) || Number(pid) < 1) return undefined
  try {
    const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
    const pidNamespace = readlinkSync(`/proc/${pid}/ns/pid`)
    // A PID in another namespace cannot be reconciled using our numeric /proc view.
    if (pidNamespace !== readlinkSync('/proc/self/ns/pid')) return undefined
    return checkedReceiptParentProcess({ pid, bootId, pidNamespace, startTicks: stat(Number(pid)).startTicks })
  } catch { return undefined }
}
export function receiptParentDeathState(value: unknown): 'inactive' | 'unknown' {
  if (process.platform !== 'linux') return 'unknown'
  try {
    const p = checkedReceiptParentProcess(value)
    const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
    if (!uuid.test(boot)) return 'unknown'
    if (boot !== p.bootId) return 'inactive'
    if (readlinkSync('/proc/self/ns/pid') !== p.pidNamespace) return 'unknown'
    try {
      const current = stat(p.pid)
      return current.startTicks !== p.startTicks || current.state === 'Z' || current.state === 'X' ? 'inactive' : 'unknown'
    } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'inactive' : 'unknown' }
  } catch { return 'unknown' }
}
