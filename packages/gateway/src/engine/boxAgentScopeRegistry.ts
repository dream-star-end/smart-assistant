/** Non-financial, durable control registry. Only positive fenced receipts retire work. */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { acquireKernelFileLock, paths } from '@openclaude/storage'
import { parseBoxAgentScopeControl, parseBoxAgentScopeIdentity,
  type BoxAgentScopeControl, type BoxAgentScopeControlResult } from '@openclaude/protocol'
import { controlBoxAgentScope, type BoxScopeRemoteReceipt } from './boxAgentScopeClient.js'

export type BoxScopeOwner = {
  incarnation: string; generation: number; pid: number; startTicks: string
  bootId: string; containerInstance: string; rootSessionId: string
}
type RecordEntry = {
  request: BoxAgentScopeControl; owner: BoxScopeOwner
  background: boolean; parentScopeId: string | null
  intent: 'register' | 'cancel'; reason?: 'explicit-stop' | 'finish' | 'owner-lost'
  registered: boolean; stopped: boolean
  stopReceipt?: BoxScopeRemoteReceipt
}
type State = { version: 1; containerId: string; records: Record<string, RecordEntry>
  rootStops: Array<{ owner: BoxScopeOwner; turnKey: string }> }
const MAX_RECORDS = 4096

function processStart(pid: number): string {
  const raw = readFileSync(`/proc/${pid}/stat`, 'utf8')
  const end = raw.lastIndexOf(')')
  const field = raw.slice(end + 2).trim().split(/\s+/)[19]
  if (end < 1 || !field || !/^\d+$/.test(field)) throw new Error('BOX_SCOPE_PROCESS_IDENTITY_UNKNOWN')
  return field
}
export function captureBoxScopeOwner(pid: number, generation: number,
  incarnation: string, rootSessionId: string): BoxScopeOwner {
  return { pid, generation, incarnation, rootSessionId, startTicks: processStart(pid),
    bootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(), containerInstance: hostname() }
}
function sameOwner(a: BoxScopeOwner, b: BoxScopeOwner): boolean {
  return a.incarnation === b.incarnation && a.generation === b.generation && a.pid === b.pid
    && a.startTicks === b.startTicks && a.bootId === b.bootId
    && a.containerInstance === b.containerInstance && a.rootSessionId === b.rootSessionId
}
export function boxScopeOwnerState(owner: BoxScopeOwner): 'live' | 'gone' | 'unknown' {
  try {
    // A different PID namespace is not evidence that a process is dead.
    if (owner.containerInstance !== hostname()) return 'unknown'
    if (readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() !== owner.bootId) return 'gone'
    return processStart(owner.pid) === owner.startTicks ? 'live' : 'gone'
  } catch (error) {
    return ['ENOENT', 'ESRCH'].includes(String((error as NodeJS.ErrnoException).code)) ? 'gone' : 'unknown'
  }
}

export class BoxAgentScopeRegistry {
  private timer?: ReturnType<typeof setInterval>
  private pumping?: Promise<void>
  private pumpRequested = false
  constructor(private readonly deps: {
    file: string; containerId: string
    remote?: typeof controlBoxAgentScope
    ownerState?: typeof boxScopeOwnerState
  }) {}

  private async locked<T>(mutate: (state: State) => T | Promise<T>): Promise<T> {
    const lock = await acquireKernelFileLock(`${this.deps.file}.lock`)
    try {
      let state: State
      try { state = JSON.parse(await readFile(this.deps.file, 'utf8')) as State }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('BOX_SCOPE_REGISTRY_UNREADABLE')
        state = { version: 1, containerId: this.deps.containerId, records: {}, rootStops: [] }
      }
      if (state.version !== 1 || state.containerId !== this.deps.containerId || !state.records
        || typeof state.records !== 'object' || Array.isArray(state.records)
        || !Array.isArray(state.rootStops) || state.rootStops.length > MAX_RECORDS
        || Object.keys(state.records).length > MAX_RECORDS) throw new Error('BOX_SCOPE_REGISTRY_INVALID')
      for (const [id, entry] of Object.entries(state.records)) {
        if (!entry || !parseBoxAgentScopeControl(entry.request) || entry.request.scopeId !== id
          || !entry.owner || !Number.isSafeInteger(entry.owner.pid) || entry.owner.pid < 1
          || typeof entry.owner.startTicks !== 'string' || !/^\d+$/.test(entry.owner.startTicks)
          || typeof entry.owner.rootSessionId !== 'string' || entry.owner.rootSessionId !== entry.request.rootSessionId
          || typeof entry.stopped !== 'boolean' || typeof entry.registered !== 'boolean'
          || !['register', 'cancel'].includes(entry.intent)
          || (entry.stopped && (entry.stopReceipt?.scopeId !== id || entry.stopReceipt.status !== 'stopped'
            || entry.stopReceipt.fence !== 'cancelled'
            || !['prelaunch_cancelled','all_physical_runs_terminal'].includes(String(entry.stopReceipt.proof))))) throw new Error('BOX_SCOPE_REGISTRY_INVALID')
      }
      const result = await mutate(state)
      await mkdir(dirname(this.deps.file), { recursive: true })
      const tmp = `${this.deps.file}.${randomUUID()}.tmp`
      let file: Awaited<ReturnType<typeof open>> | undefined
      try {
        file = await open(tmp, 'wx', 0o600)
        await file.writeFile(JSON.stringify(state) + '\n')
        await file.sync(); await file.close(); file = undefined
        await rename(tmp, this.deps.file)
        const dir = await open(dirname(this.deps.file), 'r')
        try { await dir.sync() } finally { await dir.close() }
      } finally { await file?.close().catch(() => {}); await unlink(tmp).catch(() => {}) }
      return result
    } finally { await lock.release() }
  }

  private cancelTree(state: State, roots: Set<string>, reason: RecordEntry['reason']): void {
    let changed = true
    while (changed) {
      changed = false
      for (const [id, entry] of Object.entries(state.records)) {
        if (entry.parentScopeId && roots.has(entry.parentScopeId) && !roots.has(id)) {
          roots.add(id); changed = true
        }
      }
    }
    for (const id of roots) {
      const entry = state.records[id]
      if (entry && !entry.stopped) { entry.intent = 'cancel'; entry.reason ??= reason }
    }
  }

  async handle(value: unknown, owner: BoxScopeOwner): Promise<BoxAgentScopeControlResult> {
    const request = parseBoxAgentScopeControl(value)
    if (!request || request.rootSessionId !== owner.rootSessionId) throw new Error('BOX_SCOPE_CONTROL_INVALID')
    await this.locked(state => {
      let entry = state.records[request.scopeId]
      if (!entry) {
        if (request.operation !== 'register') throw new Error('BOX_SCOPE_NOT_REGISTERED')
        if (Object.keys(state.records).length >= MAX_RECORDS) {
          // Only positively proven records may be evicted. Unknown/pending never expire.
          const retired = Object.entries(state.records).find(([, row]) => row.stopped)
          if (retired) delete state.records[retired[0]]
        }
        if (Object.keys(state.records).length >= MAX_RECORDS) throw new Error('BOX_SCOPE_REGISTRY_FULL')
        if (request.parentScopeId) {
          const parent = state.records[request.parentScopeId]
          if (!parent || !sameOwner(parent.owner, owner) || parent.intent === 'cancel' || parent.stopped) throw new Error('BOX_SCOPE_PARENT_INACTIVE')
        }
        entry = { request, owner, background: request.background, parentScopeId: request.parentScopeId,
          intent: 'register', registered: false, stopped: false }
        state.records[request.scopeId] = entry
        if (!request.background && state.rootStops.some(stop => sameOwner(stop.owner,owner)
          && stop.turnKey === request.turnKey)) {
          let ancestor: RecordEntry | undefined = entry
          const seen = new Set<string>()
          while (ancestor?.parentScopeId && !ancestor.background) {
            if (seen.has(ancestor.request.scopeId)) throw new Error('BOX_SCOPE_LINEAGE_INVALID')
            seen.add(ancestor.request.scopeId); ancestor = state.records[ancestor.parentScopeId]
          }
          if (ancestor && !ancestor.background) { entry.intent = 'cancel'; entry.reason = 'explicit-stop' }
        }
      } else {
        const a = parseBoxAgentScopeIdentity(entry.request)!, b = parseBoxAgentScopeIdentity(request)!
        if (!sameOwner(entry.owner, owner) || JSON.stringify(a) !== JSON.stringify(b)
          || request.sequence < entry.request.sequence
          || (request.sequence === entry.request.sequence && JSON.stringify(request) !== JSON.stringify(entry.request))) {
          throw new Error('BOX_SCOPE_CONTROL_CONFLICT')
        }
        entry.request = request
      }
      if (request.operation === 'detach') {
        if (entry.intent === 'cancel' || entry.stopped) throw new Error('BOX_SCOPE_ALREADY_CANCELLED')
        entry.background = true; entry.parentScopeId = null
      } else if (request.operation === 'explicit-stop' || request.operation === 'finish') {
        this.cancelTree(state, new Set([request.scopeId]), request.operation)
      }
    })
    // Local cancellation ACK confirms durable intent only. The independent
    // outbox obtains the future fence and original physical proof afterwards.
    if (request.operation === 'explicit-stop' || request.operation === 'finish') {
      const stopped = await this.locked(state => state.records[request.scopeId]?.stopped === true)
      void this.pump().catch(() => {})
      return {scopeId:request.scopeId,sequence:request.sequence,status:stopped ? 'stopped' : 'pending'}
    }
    // Durable local intent precedes remote register and the CCB's ACK.
    const receipt = await this.flushOne(request.scopeId)
    const cancelled = await this.locked(state => state.records[request.scopeId]?.intent === 'cancel')
    return { scopeId: request.scopeId, sequence: request.sequence,
      status: cancelled && receipt?.status === 'active' ? 'pending' : receipt?.status ?? 'pending' }
  }

  private async flushOne(scopeId: string): Promise<BoxScopeRemoteReceipt | undefined> {
    const snapshot = await this.locked(state => {
      const entry = state.records[scopeId]
      return entry ? structuredClone(entry) : undefined
    })
    if (!snapshot) return undefined
    const identity = parseBoxAgentScopeIdentity(snapshot.request)!
    const remote = this.deps.remote ?? controlBoxAgentScope
    if (!snapshot.registered) {
      const registered = await remote(identity, 'register')
      await this.locked(state => {
        const entry = state.records[scopeId]
        if (entry && sameOwner(entry.owner, snapshot.owner)) entry.registered = true
      })
      if (registered.status !== 'active' && snapshot.intent !== 'cancel') return registered
    }
    const latest = await this.locked(state => structuredClone(state.records[scopeId]))
    if (!latest) return undefined
    const receipt = await remote(identity, latest.intent === 'cancel' ? 'cancel' : 'status', latest.reason)
    await this.locked(state => {
      const entry = state.records[scopeId]
      if (entry && sameOwner(entry.owner, snapshot.owner) && receipt.status === 'stopped'
        && receipt.fence === 'cancelled' && receipt.proof) {
        entry.stopped = true; entry.stopReceipt = receipt
      }
    })
    return receipt
  }

  /** Must resolve before a user interrupt can reach the captured CCB. */
  async prepareRootStop(owner: BoxScopeOwner, turnKey: string): Promise<void> {
    await this.prepareRootStops([{owner,turnKey}])
  }

  /** One durable write fences a whole captured Stop tree before any abort. */
  async prepareRootStops(targets:Array<{owner:BoxScopeOwner;turnKey:string}>):Promise<void> {
    await this.locked(state => {
      for (const {owner,turnKey} of targets) {
      if (!/^[a-f0-9]{64}$/.test(turnKey)) throw new Error('BOX_SCOPE_TURN_INVALID')
      if (!state.rootStops.some(stop => sameOwner(stop.owner,owner) && stop.turnKey === turnKey)) {
        if (state.rootStops.length >= MAX_RECORDS) throw new Error('BOX_SCOPE_ROOT_FENCE_FULL')
        state.rootStops.push({ owner,turnKey })
      }
      const roots = new Set<string>()
      for (const [id, entry] of Object.entries(state.records)) {
        if (!sameOwner(entry.owner, owner) || entry.request.turnKey !== turnKey || entry.background) continue
        let cursor: RecordEntry | undefined = entry
        const seen = new Set<string>()
        while (cursor?.parentScopeId && !cursor.background) {
          if (seen.has(cursor.request.scopeId)) throw new Error('BOX_SCOPE_LINEAGE_INVALID')
          seen.add(cursor.request.scopeId); cursor = state.records[cursor.parentScopeId]
          if (!cursor) throw new Error('BOX_SCOPE_LINEAGE_INVALID')
        }
        if (cursor && !cursor.background) roots.add(id)
      }
      this.cancelTree(state, roots, 'explicit-stop')
      }
    })
    void this.pump().catch(() => {})
  }

  async ownerExited(owner: BoxScopeOwner): Promise<void> {
    await this.locked(state => {
      const targets = new Set(Object.entries(state.records).filter(([, entry]) => sameOwner(entry.owner, owner)).map(([id]) => id))
      this.cancelTree(state, targets, 'owner-lost')
    })
    void this.pump().catch(() => {})
  }

  async pump(): Promise<void> {
    this.pumpRequested = true
    if (this.pumping) return this.pumping
    const work = (async () => {
      do {
      this.pumpRequested = false
      const pending = await this.locked(state => {
        state.rootStops = state.rootStops.filter(stop => (this.deps.ownerState ?? boxScopeOwnerState)(stop.owner) !== 'gone'
          || Object.values(state.records).some(entry => sameOwner(entry.owner,stop.owner) && !entry.stopped))
        for (const entry of Object.values(state.records)) {
          if (!entry.stopped && entry.intent !== 'cancel'
            && (this.deps.ownerState ?? boxScopeOwnerState)(entry.owner) === 'gone') {
            entry.intent = 'cancel'; entry.reason = 'owner-lost'
          }
        }
        return Object.entries(state.records).filter(([, entry]) => !entry.stopped
          && (entry.intent === 'cancel' || !entry.registered)).map(([id]) => id)
      })
      // Control retries only. No failed model/tool request is replayed.
      for (const id of pending) await this.flushOne(id).catch(() => {})
      } while (this.pumpRequested)
    })()
    this.pumping = work
    try { await work } finally { if (this.pumping === work) this.pumping = undefined }
  }
  start(): void {
    if (this.timer) return
    void this.pump().catch(() => {})
    this.timer = setInterval(() => { void this.pump().catch(() => {}) }, 5_000)
    this.timer.unref()
  }
}

let singleton: BoxAgentScopeRegistry | undefined
export function getBoxAgentScopeRegistry(): BoxAgentScopeRegistry {
  const containerId = process.env.OC_CONTAINER_ID
  if (!containerId || !/^[1-9][0-9]*$/.test(containerId)) throw new Error('BOX_SCOPE_CONTAINER_ID_UNKNOWN')
  if (!singleton) {
    singleton = new BoxAgentScopeRegistry({ containerId,
      file: join(paths.agentDir('_platform'), `box-agent-scopes-${containerId}.json`) })
    singleton.start()
  }
  return singleton
}
