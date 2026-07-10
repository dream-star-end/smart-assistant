#!/usr/bin/env tsx
/**
 * 存量迁移：把各 agent 的 legacy per-agent USER.md + 现有 shared user.md 合并到用户级
 * `~/.openclaude/user.md`。USER.md 改为用户级共享后(MemoryStore.pathFor('user')→shared)，
 * 历史用户画像散落在 agents/<id>/USER.md；合并后任一 agent 学到的用户事实对所有 agent 生效。
 * MEMORY.md 保持 per-agent，不动。
 *
 * 安全：
 *   - 取 user.md 写锁(acquireUserLock，与容器内运行时 mcp-memory 写共享 user.md 互斥)
 *   - **把现有 shared user.md 也作为输入合并**(部署顺序里新代码可能已写过 shared，不能覆盖)
 *   - Set 去重(保序) + scanMemoryContent threat 过滤 + 2000 char budget(超出的 entry 跳过)
 *   - 拒 symlink、原子写(temp+rename)、复制非移动(保留 legacy per-agent USER.md 供旧容器过渡)
 *   - 幂等：合并是确定性的(去重)，重跑得同结果；apply 前若合并结果 == 现有 shared 则跳过
 *   - dry-run 默认
 *
 * 用法：
 *   tsx migrate-user-memory-to-shared.ts --home <volume _data path>            # dry-run
 *   tsx migrate-user-memory-to-shared.ts --home <volume _data path> --apply
 *
 * 不依赖容器 recycle / seed-skills(共享 user.md 路径由 MemoryStore 首次写自动创建)，可立即
 * 对所有 volume 跑；旧容器仍读 per-agent USER.md(复制非移动)，recycle 到新镜像后读共享。
 */

import { randomUUID } from 'node:crypto'
import { type Dirent, existsSync, lstatSync } from 'node:fs'
import { mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { acquireUserLock, scanMemoryContent } from '@openclaude/storage'

// memdir 重构删除了 storage 的 DEFAULT_LIMITS / ENTRY_DELIMITER(§-blob 预算模型退役)。
// 本脚本是 v3→v5 legacy §-格式 USER.md 的一次性迁移,读的是**存量** § 格式文件,仍需按
// 旧 § 语义解析,故就地内联这两个历史常量(值与旧 DEFAULT_LIMITS.userChars /
// ENTRY_DELIMITER 完全一致,行为不变)。锁 + scan 仍复用 storage 导出。
const ENTRY_DELIMITER = '\n§\n'
const USER_BUDGET = 2000

function parseArgs(argv: string[]): { home: string; apply: boolean } {
  let home = ''
  let apply = false
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--apply') apply = true
    else if (a === '--home') home = argv[++i]
    else if (a.startsWith('--home=')) home = a.slice('--home='.length)
    else {
      console.error(`unknown arg: ${a}`)
      process.exit(2)
    }
  }
  if (!home) {
    console.error('--home <volume _data path> required')
    process.exit(2)
  }
  return { home, apply }
}

/** Read USER.md entries with symlink + containment guard. Returns [] on absence/unsafe. */
async function readUserEntries(filePath: string, root: string): Promise<string[]> {
  if (!existsSync(filePath)) return []
  try {
    if (lstatSync(filePath).isSymbolicLink()) return [] // never follow symlink
    const real = await realpath(filePath)
    const realRoot = await realpath(root)
    if (real !== realRoot && !real.startsWith(realRoot + sep)) return []
    const raw = await readFile(real, 'utf-8')
    return raw
      .split(ENTRY_DELIMITER)
      .map((s) => s.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

interface MigrateResult {
  agents: number
  mergedEntries: number
  chars: number
  changed: boolean
}

async function migrateOne(home: string, apply: boolean): Promise<MigrateResult> {
  const lockPath = join(home, 'user.md.lock')
  const sharedPath = join(home, 'user.md')
  const agentsDir = join(home, 'agents')
  const release = await acquireUserLock(lockPath)
  try {
    const collected: string[] = []
    // 1) existing shared first — don't lose anything already written under new code.
    collected.push(...(await readUserEntries(sharedPath, home)))
    // 2) each agent's legacy per-agent USER.md, deterministic (sorted agentId) order.
    let agentNames: string[] = []
    if (existsSync(agentsDir)) {
      let entries: Dirent[] = []
      try {
        entries = await readdir(agentsDir, { withFileTypes: true })
      } catch {
        entries = []
      }
      agentNames = entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort()
    }
    for (const a of agentNames) {
      const agentRoot = join(agentsDir, a)
      collected.push(...(await readUserEntries(join(agentRoot, 'USER.md'), agentRoot)))
    }

    // Dedupe (preserve first-seen order) + threat scan + char budget.
    const seen = new Set<string>()
    const fitted: string[] = []
    for (const e of collected) {
      if (seen.has(e)) continue
      if (!scanMemoryContent(e).ok) continue
      const projected = [...fitted, e].join(ENTRY_DELIMITER).length
      if (projected > USER_BUDGET) continue // skip overflowing entry, keep earlier ones
      seen.add(e)
      fitted.push(e)
    }
    const content = fitted.join(ENTRY_DELIMITER)

    // Idempotent: if shared already equals the merged content, nothing to do.
    const current = (await readUserEntries(sharedPath, home)).join(ENTRY_DELIMITER)
    const changed = current !== content
    if (apply && changed) {
      await mkdir(home, { recursive: true })
      const tmp = `${sharedPath}.tmp-${randomUUID()}`
      try {
        await writeFile(tmp, content)
        await rename(tmp, sharedPath)
      } catch (err) {
        await rm(tmp, { force: true }).catch(() => {})
        throw err
      }
    }
    return { agents: agentNames.length, mergedEntries: fitted.length, chars: content.length, changed }
  } finally {
    await release()
  }
}

async function main(): Promise<void> {
  const { home, apply } = parseArgs(process.argv)
  if (!existsSync(home)) {
    console.error(`home not found: ${home}`)
    process.exit(1)
  }
  const r = await migrateOne(home, apply)
  console.log(
    `[migrate-user-memory] home=${home} mode=${apply ? 'APPLY' : 'dry-run'} ` +
      `agents=${r.agents} merged-entries=${r.mergedEntries} chars=${r.chars}/${USER_BUDGET} ` +
      `${r.changed ? (apply ? 'WROTE shared user.md' : 'would-write') : 'no-change(idempotent)'}`,
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
