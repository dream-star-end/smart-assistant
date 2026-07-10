// userProfile — 共享用户画像 ~/.openclaude/user.md 的读写(memdir 去 § 化)。
//
// 旧模型:user.md 是 §-blob(条目以 `\n§\n` 分隔 + 2000 字符硬预算)。memdir 下
// user.md 改为**纯 markdown**(无 § 分隔、无硬预算,注入侧 cap)。用户级共享:任一
// agent 学到的用户事实对该用户所有 agent 生效,故所有写都取共享 user.md 跨进程锁。
//
// 读时懒去 §:检测到存量 `\n§\n` → 锁内重读并改写为 `- ` bullet 列表(幂等,一次性)。
// 写侧整体 scanMemoryContent(注入安全)+ sha16 version 乐观并发(三态,与 memoryDir.write 对齐)。

import { createHash, randomUUID } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { acquireFileLock, scanMemoryContent } from './memoryShared.js'
import { paths } from './paths.js'

type WriteResult =
  | { ok: true; version: string }
  | { ok: false; conflict: { current: string; version: string } }
  | { ok: false; error: string }

function sha16(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16)
}

function normalizeEol(s: string): string {
  return s.replace(/\r\n/g, '\n')
}

/** 把存量 §-blob 去 § 化为 bullet 列表:每条 → 单行 `- ...`(内部换行压平成空格)。 */
function deSection(s: string): string {
  return s
    .split('\n§\n')
    .map((e) => e.trim())
    .filter(Boolean)
    .map(
      (e) =>
        `- ${e
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .join(' ')}`,
    )
    .join('\n')
}

async function atomicWrite(fullPath: string, content: string): Promise<void> {
  const tmp = `${fullPath}.tmp-${randomUUID()}`
  try {
    await writeFile(tmp, content)
    await rename(tmp, fullPath)
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}

/**
 * 读用户画像。返回归一化文本 + version。
 * 懒去 §:若不含 `\n§\n` → 直接返回(不触锁、不改盘)。若含 § → 取锁重读(可能别的进程
 * 已改)、去 § 化、锁内改写一次,返回改写后文本。
 */
export async function readUserProfile(): Promise<{ text: string; version: string }> {
  let raw = ''
  try {
    raw = await readFile(paths.sharedUserMd, 'utf-8')
  } catch {
    return { text: '', version: sha16('') }
  }
  const normalized = normalizeEol(raw)
  if (!normalized.includes('\n§\n')) {
    return { text: normalized, version: sha16(normalized) }
  }
  // 含 § → 锁内改写(幂等)。
  const release = await acquireFileLock(paths.sharedUserLock)
  try {
    let cur = ''
    try {
      cur = await readFile(paths.sharedUserMd, 'utf-8')
    } catch {
      cur = ''
    }
    const curNorm = normalizeEol(cur)
    if (!curNorm.includes('\n§\n')) {
      // 别的进程已去 § → 直接用最新盘上内容。
      return { text: curNorm, version: sha16(curNorm) }
    }
    const converted = deSection(curNorm)
    await atomicWrite(paths.sharedUserMd, converted)
    return { text: converted, version: sha16(converted) }
  } finally {
    await release()
  }
}

/**
 * 写用户画像(受控三态,与 memoryDir.write 语义对齐):
 *  - 整体 scan 命中 → { ok:false, error }。
 *  - expectedVersion 传入且 != 盘上当前(归一化后)version → { ok:false, conflict }(不写盘)。
 *  - 未传 expectedVersion → last-writer-wins 直接写。
 * version 一律对**归一化后**文本计算,与 readUserProfile 返回的 version 一致。
 */
export async function writeUserProfile(
  text: string,
  expectedVersion?: string,
): Promise<WriteResult> {
  const scan = scanMemoryContent(text)
  if (!scan.ok) return { ok: false, error: `rejected: ${scan.reason}` }
  const release = await acquireFileLock(paths.sharedUserLock)
  try {
    let cur = ''
    try {
      cur = await readFile(paths.sharedUserMd, 'utf-8')
    } catch {
      cur = ''
    }
    const current = normalizeEol(cur)
    const currentVersion = sha16(current)
    if (expectedVersion !== undefined && expectedVersion !== currentVersion) {
      return { ok: false, conflict: { current, version: currentVersion } }
    }
    await atomicWrite(paths.sharedUserMd, text)
    return { ok: true, version: sha16(normalizeEol(text)) }
  } finally {
    await release()
  }
}
