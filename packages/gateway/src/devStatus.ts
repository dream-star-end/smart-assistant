// ── /api/dev-status:多会话并行开发看板(2026-07-18 并行开发审计 条6)──
//
// 动机:boss 同时开多个 codex/CC 会话进行 v5 开发,"现在谁在跑/跑多久了/占着哪个
// worktree/哪些锁被持有/最近报了什么错"只能 ps + sqlite 手查。本模块把这些聚合成
// 一个只读端点(JSON;?format=html 出自包含页面,不经前端 SW/构建管线)。
//
// 数据源均为只读:SessionManager.list() / ClaudeTerminalManager.listActive() /
// /var/lock/oc-*.lock × /proc/locks / /opt/openclaude/worktrees-registry.json /
// /var/log/openclaude.log 尾部。任何一路失败都降级为空列表,不让看板本身 500。

import { readFileSync, readdirSync, statSync, openSync, readSync, closeSync, fstatSync } from 'node:fs'
import { join } from 'node:path'

export interface DevStatusSessionRow {
  sessionKey: string
  agentId: string
  lastUsedAt: number
  turns: number
  totalCostUSD: number
  runnerRunning: boolean
  turnActiveSince: number | null
}

export interface DevStatusTerminalRow {
  sessionId: string
  userId: string
  createdAt: number
  cwd: string
  lastOutputAt: number | null
  outputBytes: number
}

export interface DevStatusLockRow {
  file: string
  mtimeMs: number
  heldByPid: number | null
}

export interface DevStatusWorktreeRow {
  dir: string
  repo: string
  branch: string
  owner: string
  purpose: string
  status: string
  updated: string
}

export interface DevStatusLogRow {
  ts: string
  level: string
  msg: string
  sessionKey?: string
}

export interface DevStatus {
  now: number
  uptimeSec: number
  memoryMB: number
  load: number[]
  inFlightTurns: number
  sessions: DevStatusSessionRow[]
  terminals: DevStatusTerminalRow[]
  locks: DevStatusLockRow[]
  worktrees: DevStatusWorktreeRow[]
  recentErrors: DevStatusLogRow[]
}

export interface DevStatusDeps {
  sessions: () => DevStatusSessionRow[]
  terminals: () => DevStatusTerminalRow[]
  lockDir?: string
  procLocksPath?: string
  registryPath?: string
  logPath?: string
  loadavg?: () => number[]
}

const LOCK_DIR = '/var/lock'
const PROC_LOCKS = '/proc/locks'
const REGISTRY = '/opt/openclaude/worktrees-registry.json'
const LOG_PATH = '/var/log/openclaude.log'
const LOG_TAIL_BYTES = 256 * 1024
const LOG_LIMIT = 25

/**
 * 解析 /proc/locks,按 inode 关联到给定文件集。
 * 行形如: `12: FLOCK  ADVISORY  WRITE 1234 fd:01:5678 0 EOF`
 * 只按 inode 匹配(dev 编码在 node 侧还原 major:minor 不可移植);观察集是
 * /var/lock 下十几个 oc-*.lock,同 inode 跨设备碰撞概率可忽略 —— 这是看板不是账本。
 */
export function parseProcLocks(
  procLocksText: string,
  inodeToFile: Map<number, string>,
): Map<string, number> {
  const held = new Map<string, number>()
  for (const line of procLocksText.split('\n')) {
    const m = /^\s*\d+:\s+\S+\s+\S+\s+\S+\s+(\d+)\s+[0-9a-fA-F]+:[0-9a-fA-F]+:(\d+)/.exec(line)
    if (!m) continue
    const pid = Number(m[1])
    const ino = Number(m[2])
    const file = inodeToFile.get(ino)
    if (file !== undefined && !held.has(file)) held.set(file, pid)
  }
  return held
}

/** 从日志尾部原文提取最近的 error/warn 结构化行(坏行跳过,永不 throw)。 */
export function extractLogErrors(raw: string, limit: number): DevStatusLogRow[] {
  const out: DevStatusLogRow[] = []
  const lines = raw.split('\n')
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const line = lines[i]
    if (!line.includes('"level":"error"') && !line.includes('"level":"warn"')) continue
    try {
      const d = JSON.parse(line)
      if (d.level !== 'error' && d.level !== 'warn') continue
      out.push({
        ts: String(d.ts ?? ''),
        level: String(d.level),
        msg: String(d.msg ?? '').slice(0, 200),
        ...(d.sessionKey ? { sessionKey: String(d.sessionKey) } : {}),
      })
    } catch {
      // 尾部第一行可能被截断 —— 跳过
    }
  }
  return out
}

function readLogTail(path: string, maxBytes: number): string {
  let fd: number | null = null
  try {
    fd = openSync(path, 'r')
    const size = fstatSync(fd).size
    const start = Math.max(0, size - maxBytes)
    const buf = Buffer.alloc(Math.min(maxBytes, size))
    readSync(fd, buf, 0, buf.length, start)
    return buf.toString('utf8')
  } catch {
    return ''
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

function collectLocks(lockDir: string, procLocksPath: string): DevStatusLockRow[] {
  try {
    const files = readdirSync(lockDir).filter((f) => /^(oc-|v3-).*\.lock$/.test(f))
    const inodeToFile = new Map<number, string>()
    const rows: DevStatusLockRow[] = []
    for (const f of files) {
      const p = join(lockDir, f)
      try {
        const st = statSync(p)
        inodeToFile.set(st.ino, f)
        rows.push({ file: f, mtimeMs: st.mtimeMs, heldByPid: null })
      } catch {}
    }
    let held = new Map<string, number>()
    try {
      held = parseProcLocks(readFileSync(procLocksPath, 'utf8'), inodeToFile)
    } catch {}
    for (const r of rows) {
      const pid = held.get(r.file)
      if (pid !== undefined) r.heldByPid = pid
    }
    // 被持有的排前面,其余按 mtime 新→旧
    return rows.sort((a, b) => Number(b.heldByPid !== null) - Number(a.heldByPid !== null) || b.mtimeMs - a.mtimeMs)
  } catch {
    return []
  }
}

function collectWorktrees(registryPath: string): DevStatusWorktreeRow[] {
  try {
    const reg = JSON.parse(readFileSync(registryPath, 'utf8'))
    const rows: DevStatusWorktreeRow[] = []
    for (const [dir, e] of Object.entries<any>(reg?.worktrees ?? {})) {
      if (!e || e.status === 'removed') continue
      rows.push({
        dir,
        repo: String(e.repo ?? '?'),
        branch: String(e.branch ?? '?'),
        owner: String(e.owner ?? '-'),
        purpose: String(e.purpose ?? ''),
        status: String(e.status ?? '?'),
        updated: String(e.updated ?? ''),
      })
    }
    return rows.sort((a, b) => (a.status === b.status ? a.dir.localeCompare(b.dir) : a.status === 'active' ? -1 : 1))
  } catch {
    return []
  }
}

export function collectDevStatus(deps: DevStatusDeps): DevStatus {
  let sessions: DevStatusSessionRow[] = []
  try {
    sessions = deps.sessions()
  } catch {}
  let terminals: DevStatusTerminalRow[] = []
  try {
    terminals = deps.terminals()
  } catch {}
  const inFlight = sessions.filter((s) => s.turnActiveSince !== null).length
  return {
    now: Date.now(),
    uptimeSec: Math.round(process.uptime()),
    memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    load: deps.loadavg ? deps.loadavg() : [],
    inFlightTurns: inFlight,
    sessions: sessions.sort(
      (a, b) => Number(b.turnActiveSince !== null) - Number(a.turnActiveSince !== null) || b.lastUsedAt - a.lastUsedAt,
    ),
    terminals: terminals.sort((a, b) => (b.lastOutputAt ?? 0) - (a.lastOutputAt ?? 0)),
    locks: collectLocks(deps.lockDir ?? LOCK_DIR, deps.procLocksPath ?? PROC_LOCKS),
    worktrees: collectWorktrees(deps.registryPath ?? REGISTRY),
    recentErrors: extractLogErrors(readLogTail(deps.logPath ?? LOG_PATH, LOG_TAIL_BYTES), LOG_LIMIT),
  }
}

function esc(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

function ago(now: number, ts: number | null | undefined): string {
  if (!ts) return '-'
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 90) return `${s}s`
  if (s < 5400) return `${Math.round(s / 60)}m`
  return `${(s / 3600).toFixed(1)}h`
}

/** 自包含 HTML(内联样式,15s 自刷新);服务端渲染,不经 web 构建/SW 管线。 */
export function renderDevStatusHtml(s: DevStatus): string {
  const busyRow = (b: boolean) => (b ? ' style="background:#2d2416"' : '')
  const sess = s.sessions
    .map((r) => {
      const active = r.turnActiveSince !== null
      return `<tr${busyRow(active)}><td>${esc(r.sessionKey)}</td><td>${esc(r.agentId)}</td><td>${
        active ? `<b>RUNNING ${ago(s.now, r.turnActiveSince)}</b>` : 'idle'
      }</td><td>${ago(s.now, r.lastUsedAt)}</td><td>${r.turns}</td><td>$${r.totalCostUSD.toFixed(2)}</td></tr>`
    })
    .join('')
  const term = s.terminals
    .map((r) => {
      const busy = r.lastOutputAt !== null && s.now - r.lastOutputAt < 120_000
      return `<tr${busyRow(busy)}><td>${esc(r.sessionId)}</td><td>${esc(r.userId)}</td><td>${esc(r.cwd)}</td><td>${
        busy ? '<b>ACTIVE</b>' : 'quiet'
      }</td><td>${ago(s.now, r.lastOutputAt)}</td><td>${ago(s.now, r.createdAt)}</td></tr>`
    })
    .join('')
  const locks = s.locks
    .map(
      (r) =>
        `<tr${busyRow(r.heldByPid !== null)}><td>${esc(r.file)}</td><td>${
          r.heldByPid !== null ? `<b>held by ${r.heldByPid}</b>` : 'free'
        }</td><td>${ago(s.now, r.mtimeMs)}</td></tr>`,
    )
    .join('')
  const wts = s.worktrees
    .map(
      (r) =>
        `<tr><td>${esc(r.dir.replace('/opt/openclaude/', ''))}</td><td>${esc(r.branch)}</td><td>${esc(
          r.status,
        )}</td><td>${esc(r.owner)}</td><td>${esc(r.purpose.slice(0, 60))}</td></tr>`,
    )
    .join('')
  const errs = s.recentErrors
    .map(
      (r) =>
        `<tr><td>${esc(r.ts)}</td><td>${esc(r.level)}</td><td>${esc(r.msg)}</td><td>${esc(
          r.sessionKey?.slice(-30) ?? '',
        )}</td></tr>`,
    )
    .join('')
  const table = (title: string, head: string, body: string) =>
    `<h2>${title}</h2><table><thead><tr>${head
      .split('|')
      .map((h) => `<th>${h}</th>`)
      .join('')}</tr></thead><tbody>${body || '<tr><td colspan="9">(空)</td></tr>'}</tbody></table>`
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="15">
<title>OpenClaude 并行开发看板</title><style>
body{background:#14161a;color:#d8dee6;font:13px/1.5 ui-monospace,monospace;margin:16px}
h1{font-size:16px}h2{font-size:13px;margin:18px 0 6px;color:#8ab4f8}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #2a2e35;padding:3px 8px;text-align:left;word-break:break-all}
th{color:#9aa4b2;background:#1b1e24}b{color:#f0b429}.meta{color:#9aa4b2}
</style></head><body>
<h1>并行开发看板 <span class="meta">— in-flight turns: <b>${s.inFlightTurns}</b> · uptime ${Math.round(
    s.uptimeSec / 3600,
  )}h · heap ${s.memoryMB}MB · load ${s.load.map((n) => n.toFixed(1)).join(' ')} · ${new Date(
    s.now,
  ).toISOString()}</span></h1>
${table('Runner 会话(webchat/cron/delegate)', 'sessionKey|engine|turn|last|turns|cost', sess)}
${table('CC 终端会话', 'sessionId|user|cwd|state|lastOut|created', term)}
${table('锁(/var/lock)', 'lock|holder|mtime', locks)}
${table('Worktree 注册表', 'dir|branch|status|owner|purpose', wts)}
${table('最近 error/warn(日志尾 256KB)', 'ts|level|msg|session', errs)}
</body></html>`
}
