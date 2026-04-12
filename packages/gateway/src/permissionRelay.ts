// PermissionRelay — the bridge between the guard.py PreToolUse hook and the
// user's frontends (web, Telegram, etc.).
//
// How it works:
//   1. subprocessRunner sets OPENCLAUDE_PENDING_DIR=/tmp/openclaude-pending/<agentId>
//      in the CCB subprocess environment.
//   2. When guard.py rejects a tool call, instead of denying directly it writes
//      <pending>/<reqId>.req.json and polls for <reqId>.resp.json.
//   3. This relay polls the pending dirs every 250 ms. When a new req.json shows
//      up, it reads the payload and broadcasts an outbound.message frame with a
//      permissionRequest field to all connected WS clients.
//   4. When a frontend sends back an inbound.permission_response, we write the
//      matching .resp.json file, which unblocks the guard.
//   5. If no one responds within 3 minutes, guard's own timeout fires and the
//      operation is denied.
//
// Pending dir layout:
//   /tmp/openclaude-pending/<agentId>/
//     <reqId>.req.json        ← guard writes
//     <reqId>.resp.json       ← relay writes after user decides

import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'

export const PENDING_ROOT = resolve(tmpdir(), 'openclaude-pending')

export function agentPendingDir(agentId: string): string {
  return join(PENDING_ROOT, agentId)
}

export interface PermissionRequest {
  reqId: string
  agentId: string
  sessionKey: string
  toolName: string
  toolInput: Record<string, unknown>
  reason: string
  detail: string
  summary: string
  ts: number
}

export type DecisionKind = 'allow' | 'deny' | 'allow_always'

export class PermissionRelay extends EventEmitter {
  private timer: NodeJS.Timeout | null = null
  private seen = new Set<string>() // reqIds we've already broadcast
  private pending = new Map<string, PermissionRequest>() // live outstanding requests

  async start(): Promise<void> {
    await mkdir(PENDING_ROOT, { recursive: true })
    this.timer = setInterval(() => this.tick().catch(() => {}), 250)
    console.log('[permission-relay] watching', PENDING_ROOT)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private async tick(): Promise<void> {
    if (!existsSync(PENDING_ROOT)) return
    const agentDirs = await readdir(PENDING_ROOT, { withFileTypes: true }).catch(() => [])
    for (const ad of agentDirs) {
      if (!ad.isDirectory()) continue
      const dir = join(PENDING_ROOT, ad.name)
      let files: string[]
      try {
        files = await readdir(dir)
      } catch {
        continue
      }
      // Cleanup orphans: if resp.json exists the req.json has been consumed; if
      // req.json has been removed but we still think it's pending, drop it.
      const active = new Set<string>()
      for (const f of files) {
        if (f.endsWith('.req.json')) {
          const reqId = f.slice(0, -'.req.json'.length)
          active.add(reqId)
          if (this.seen.has(reqId)) continue
          this.seen.add(reqId)
          try {
            const raw = await readFile(join(dir, f), 'utf-8')
            const req = JSON.parse(raw) as PermissionRequest
            this.pending.set(reqId, req)
            this.emit('request', req)
          } catch (err) {
            console.warn('[permission-relay] bad req file', f, err)
          }
        }
      }
      // Drop requests whose req file disappeared (guard timed out and cleaned up)
      for (const [reqId, req] of this.pending) {
        if (req.agentId === ad.name && !active.has(reqId)) {
          this.pending.delete(reqId)
          this.emit('expired', req)
        }
      }
    }
  }

  getPending(): PermissionRequest[] {
    return [...this.pending.values()]
  }

  async respond(reqId: string, decision: DecisionKind, note?: string): Promise<boolean> {
    const req = this.pending.get(reqId)
    if (!req) return false
    const respPath = join(agentPendingDir(req.agentId), `${reqId}.resp.json`)
    const payload = { reqId, decision, note: note ?? '', ts: Date.now() }
    try {
      await mkdir(dirname(respPath), { recursive: true })
      await writeFile(respPath, JSON.stringify(payload))
      this.pending.delete(reqId)
      this.emit('resolved', { reqId, decision, note })
      return true
    } catch (err) {
      console.warn('[permission-relay] write resp failed', err)
      return false
    }
  }
}
