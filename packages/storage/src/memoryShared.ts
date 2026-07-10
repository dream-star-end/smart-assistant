// memoryShared — 记忆子系统的跨模块共享原语:跨进程文件锁 + 注入安全扫描。
//
// 历史上这些逻辑内联在 memoryStore.ts(§-blob 版 MemoryStore)。memdir 重构把
// MemoryStore 整个删除(Core 记忆改为 memoryDir.ts 的「一条记忆一个文件」范式),
// 但**锁与扫描是范式无关的通用原语**:memoryDir(per-agent MEMORY.md 索引 + 记忆
// 文件目录)、userProfile(共享 user.md)、以及包外的存量迁移脚本都要用。故独立成
// 本模块,并从包入口(index.ts)继续导出,消费方 import 路径尽量不断。
//
// 权威源约束:注入侧安全扫描只此一份(scanMemoryContent)——模型直写文件会绕过写侧
// 校验,读侧(renderForInjection / userProfile 整体 scan)才是权威兜底。

import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'

// Threat patterns — reject writes that match. These files are injected into
// the model's system prompt so they're a prime target for self-injection.
const THREAT_PATTERNS: Array<[RegExp, string]> = [
  [/ignore\s+(previous|all|above|prior)\s+instructions/i, 'prompt_injection'],
  [/you\s+are\s+now\s+/i, 'role_hijack'],
  [/do\s+not\s+tell\s+the\s+user/i, 'deception_hide'],
  [/system\s+prompt\s+override/i, 'sys_prompt_override'],
  [/disregard\s+(your|all|any)\s+(instructions|rules|guidelines)/i, 'disregard_rules'],
  [
    /act\s+as\s+(if|though)\s+you\s+(have\s+no|don['’]t\s+have)\s+(restrictions|limits|rules)/i,
    'bypass_restrictions',
  ],
  [/curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, 'exfil_curl'],
  [/wget\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, 'exfil_wget'],
  [/cat\s+[^\n]*(\.env|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)/i, 'read_secrets'],
  [/authorized_keys/i, 'ssh_backdoor'],
]

// 常见零宽/双向控制不可见字符的码点(U+200B..U+200F 区与 BOM)。用码点构造避免源码里
// 直接嵌入不可见字符导致无法审阅/被编辑器吞掉。
const INVISIBLE_CHARS = [
  0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e,
].map((cp) => String.fromCharCode(cp))

export interface ScanResult {
  ok: boolean
  reason?: string
}

/**
 * 注入/外泄安全扫描。命中不可见 unicode 或威胁模式即 ok:false。这些文本会被注入模型
 * system prompt,是自注入的主要目标。memdir 下按**行**扫描索引、按**整体**扫描
 * user.md(见 memoryDir.renderForInjection / userProfile)。
 */
export function scanMemoryContent(content: string): ScanResult {
  for (const ch of INVISIBLE_CHARS) {
    if (content.includes(ch)) {
      return {
        ok: false,
        reason: `invisible unicode character U+${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
      }
    }
  }
  for (const [re, id] of THREAT_PATTERNS) {
    if (re.test(content)) return { ok: false, reason: `threat pattern: ${id}` }
  }
  return { ok: true }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * 通用跨进程建议锁,基于 O_CREAT|O_EXCL 独占创建 lockfile。用于任何"多进程写同一份
 * memory 文件"的场景(user.md 的多 agent 共享,以及 per-agent MEMORY.md 索引 /
 * 记忆目录的 gateway/mcp-memory 双进程写)。返回 release 函数。持有者崩溃时靠 mtime
 * 过期(超过 STALE_MS)偷锁自愈;ACQUIRE_TIMEOUT_MS 内抢不到则抛错。
 */
export async function acquireFileLock(lockPath: string): Promise<() => Promise<void>> {
  const STALE_MS = 15_000
  const ACQUIRE_TIMEOUT_MS = 8_000
  const myToken = randomUUID()
  const start = Date.now()
  // per-agent MEMORY.md.lock 位于 agents/<id>/ 目录,首次写时该目录可能还不存在,
  // 会让下面的 open(...,'wx') 抛 ENOENT。先确保锁的父目录存在(对 sharedUserLock
  // 而言父目录是 HOME,恒存在,mkdir 为幂等 no-op)。
  await mkdir(dirname(lockPath), { recursive: true }).catch(() => {})
  for (;;) {
    try {
      const fh = await open(lockPath, 'wx') // O_CREAT | O_EXCL — atomic create
      // Write an owner token so that if another writer later steals this lock (judging
      // us stale), our release won't unlink THEIR lock.
      await fh.writeFile(myToken).catch(() => {})
      await fh.close().catch(() => {})
      let released = false
      return async () => {
        if (released) return
        released = true
        // Only remove the lock if we still own it. If it was stolen+recreated by another
        // writer, leave their lock intact so mutual exclusion is preserved.
        try {
          const cur = await readFile(lockPath, 'utf-8')
          if (cur.trim() === myToken) await rm(lockPath, { force: true })
        } catch {
          /* lock already gone */
        }
      }
    } catch (err: any) {
      if (err?.code !== 'EEXIST') throw err
      // Steal if stale (previous holder crashed without releasing).
      try {
        const st = await stat(lockPath)
        if (Date.now() - st.mtimeMs > STALE_MS) {
          await rm(lockPath, { force: true }).catch(() => {})
          continue
        }
      } catch {
        // lock vanished between EEXIST and stat — retry immediately
        continue
      }
      if (Date.now() - start > ACQUIRE_TIMEOUT_MS) {
        throw new Error('memory file lock acquire timeout')
      }
      await sleep(15 + Math.floor(Math.random() * 25))
    }
  }
}

/**
 * 向后兼容别名:旧名 `acquireUserLock` 仍被包外引用
 * (packages/commercial/scripts/migrate-user-memory-to-shared.ts)。锁机制本身与
 * target 无关,新代码请用 `acquireFileLock`。
 */
export const acquireUserLock = acquireFileLock
