#!/usr/bin/env tsx
/**
 * 存量迁移：把 per-agent 自建 skill 提升到「用户级共享库」(~/.openclaude/skills)。
 *
 * 背景见 PLAN-shared-skill-library.md。SkillStore 已从 per-agent 两层改为四层
 * overlay(baseline ro > agent-seed ro > shared rw > legacy ro)，写源统一为 shared。
 * 本脚本把历史 `agents/<id>/skills/<name>` 里的「用户自建」skill 一次性复制到
 * shared，使其立即对该用户所有 agent 可见可复用；平台 seed 残留则清理。
 *
 * 作用域：单个用户 volume 根(容器内 ~/.openclaude，或 host 上挂载的 volume)。
 * 批量(所有 oc-v3-data-u* volume)由外层运维循环对每个根调用本脚本。
 *
 * 识别规则(权威 seed 来源 = 新 entrypoint 已落地的 seed-skills 目录，零清单漂移)：
 *   对每个 legacy `agents/<id>/skills/<name>`：
 *     - 若 `agents/<id>/seed-skills/<name>` 存在(=该 name 是平台 seed)：
 *         · 内容与 seed-skills 版一致 → DROP(seed 残留，seed-skills 已权威提供)
 *         · 内容不同(用户改过 seed) → 迁 shared，但**改名** `<name>-user`
 *           (不能同名写 shared：overlay 里 agent-seed > shared，同名会被遮蔽不可见)
 *     - 否则(普通用户 skill) → 迁 shared，保留原名
 *   迁 shared 时若发生同名(多 agent 同名 / 撞已存在)：updated_at(缺则 mtime)最新者
 *   得原名，其余加 `--<agentId>` 后缀(不丢数据)，并在报告中列出 losers。
 *
 * 安全：复制非移动(复制并校验后才考虑清理旧 legacy，本脚本默认保留 legacy)、
 *   拒绝/不跟随 symlink、realpath 包含校验、ledger 幂等可重跑、**默认 dry-run**。
 *
 * 用法：
 *   tsx migrate-skills-to-shared.ts                 # dry-run，打印计划
 *   tsx migrate-skills-to-shared.ts --home <path>   # 指定 volume 根(默认 paths.home)
 *   tsx migrate-skills-to-shared.ts --apply         # 实际执行
 *
 * 部署顺序前提：先部署新 runtime image + recycle 容器(entrypoint 填充 seed-skills)，
 *   再跑本脚本——否则 seed-skills 不存在，seed-name 的旧 skill 会被当普通 skill 迁
 *   shared(无害但会在 shared 留一份 seed 内容副本)。脚本会在缺 seed-skills 时告警。
 */

import { randomUUID } from 'node:crypto'
import { type Dirent, existsSync, lstatSync } from 'node:fs'
import { cp, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'
import {
  MAX_SKILL_NAME_LENGTH,
  formatFrontmatter,
  parseFrontmatter,
  paths,
  validateSkillName,
} from '@openclaude/storage'

interface PlanItem {
  agentId: string
  name: string
  srcDir: string
  action: 'drop' | 'migrate'
  /** 迁移目标 shared skill 名(冲突解决后)。 */
  target?: string
  /** 改名原因：'user-modified-seed' | 'name-conflict' | undefined(原名)。 */
  renameReason?: string
  updatedAt: number
  /** 上一次(崩溃前)已成功复制到 shared 但未记账 → 本次只补 ledger，不重复迁移。 */
  alreadyMigrated?: boolean
}

interface Ledger {
  version: 1
  processed: Record<string, { action: string; target?: string; ts: string }>
}

function parseArgs(argv: string[]): { home: string; apply: boolean } {
  let home = paths.home
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
  return { home, apply }
}

/** Read SKILL.md within a root with symlink/containment guards. Returns null if unsafe/absent. */
async function safeReadSkillMd(skillDir: string, root: string): Promise<string | null> {
  const md = join(skillDir, 'SKILL.md')
  if (!existsSync(md)) return null
  try {
    const st = lstatSync(md)
    if (!st.isFile()) return null // reject symlink/dir
    const realMd = await realpath(md)
    const realRoot = await realpath(root)
    if (!realMd.startsWith(realRoot + sep)) return null
    return await readFile(realMd, 'utf-8')
  } catch {
    return null
  }
}

/** Build a frontmatter copy without the given keys (no delete operator → lint-clean). */
function omitKeys(meta: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(meta)) {
    if (!keys.includes(k)) out[k] = v
  }
  return out
}

/** Normalize SKILL.md for seed-equality comparison: ignore volatile timestamp fields. */
function normalizeForCompare(raw: string): string {
  const { meta, body } = parseFrontmatter(raw)
  const stable = omitKeys(meta as Record<string, unknown>, ['created_at', 'updated_at', 'version'])
  return JSON.stringify({ meta: stable, body: body.trim() })
}

/** Like normalizeForCompare but also ignores `name` (a renamed migration rewrites it). */
function normalizeIgnoreName(raw: string): string {
  const { meta, body } = parseFrontmatter(raw)
  const stable = omitKeys(meta as Record<string, unknown>, [
    'name',
    'created_at',
    'updated_at',
    'version',
  ])
  return JSON.stringify({ meta: stable, body: body.trim() })
}

/**
 * Collect every regular file under `dir` as relPath → content (Buffer), with a
 * realpath containment check. Returns null if ANY entry is a symlink, a non-regular
 * file, or unreadable — so such dirs never match (we won't claim them as migrated).
 */
async function collectFiles(dir: string): Promise<Map<string, Buffer> | null> {
  let realDir: string
  try {
    realDir = await realpath(dir)
  } catch {
    return null
  }
  const out = new Map<string, Buffer>()
  const walk = async (cur: string, rel: string): Promise<boolean> => {
    let entries: Dirent[]
    try {
      entries = await readdir(cur, { withFileTypes: true })
    } catch {
      return false
    }
    for (const e of entries) {
      const full = join(cur, e.name)
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isSymbolicLink()) return false
      if (e.isDirectory()) {
        if (!(await walk(full, r))) return false
      } else if (e.isFile()) {
        let real: string
        try {
          real = await realpath(full)
        } catch {
          return false
        }
        if (!real.startsWith(realDir + sep)) return false
        try {
          out.set(r, await readFile(real))
        } catch {
          return false
        }
      } else {
        return false // non-regular (fifo/socket/device)
      }
    }
    return true
  }
  return (await walk(dir, '')) ? out : null
}

/**
 * Crash-recovery probe: is shared/<name> a COMPLETE copy of THIS legacy source?
 * Compares the full file tree (same relative paths + identical bytes; SKILL.md ignores
 * name/created_at/updated_at/version). Any symlink/non-regular/unreadable file → false.
 * Atomic publish (tmp-dir + rename) guarantees an existing dest is whole, so a true
 * result means a prior (crashed-before-ledger) run already migrated this exact skill.
 */
async function sharedSkillMatches(
  sharedRoot: string,
  name: string,
  srcDir: string,
): Promise<boolean> {
  const destDir = join(sharedRoot, name)
  if (!existsSync(destDir)) return false
  const [destFiles, srcFiles] = await Promise.all([collectFiles(destDir), collectFiles(srcDir)])
  if (destFiles == null || srcFiles == null) return false
  if (destFiles.size !== srcFiles.size) return false
  for (const [rel, srcBuf] of srcFiles) {
    const destBuf = destFiles.get(rel)
    if (destBuf == null) return false
    if (rel === 'SKILL.md') {
      if (
        normalizeIgnoreName(srcBuf.toString('utf-8')) !==
        normalizeIgnoreName(destBuf.toString('utf-8'))
      )
        return false
    } else if (!srcBuf.equals(destBuf)) {
      return false
    }
  }
  return true
}

function updatedAtMs(raw: string, fallbackMtime: number): number {
  const { meta } = parseFrontmatter(raw)
  if (meta.updated_at) {
    const t = Date.parse(meta.updated_at)
    if (!Number.isNaN(t)) return t
  }
  return fallbackMtime
}

async function buildPlan(home: string): Promise<{ items: PlanItem[]; warnings: string[] }> {
  const agentsDir = join(home, 'agents')
  const warnings: string[] = []
  const raw: PlanItem[] = []
  if (!existsSync(agentsDir)) return { items: [], warnings: ['no agents dir'] }

  for (const ent of await readdir(agentsDir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue
    const agentId = ent.name
    const skillsRoot = join(agentsDir, agentId, 'skills')
    const seedRoot = join(agentsDir, agentId, 'seed-skills')
    if (!existsSync(skillsRoot)) continue

    for (const sk of await readdir(skillsRoot, { withFileTypes: true })) {
      if (!sk.isDirectory() || sk.name.startsWith('.')) continue
      const name = sk.name
      if (!validateSkillName(name).ok) {
        warnings.push(`skip invalid skill name: ${agentId}/${name}`)
        continue
      }
      const srcDir = join(skillsRoot, name)
      // Reject symlinked skill dir outright.
      if (lstatSync(srcDir).isSymbolicLink()) {
        warnings.push(`skip symlinked skill dir: ${agentId}/${name}`)
        continue
      }
      const srcRaw = await safeReadSkillMd(srcDir, skillsRoot)
      if (srcRaw == null) {
        warnings.push(`skip unreadable/unsafe SKILL.md: ${agentId}/${name}`)
        continue
      }
      const mtime = lstatSync(join(srcDir, 'SKILL.md')).mtimeMs
      const updatedAt = updatedAtMs(srcRaw, mtime)

      const seedDir = join(seedRoot, name)
      const seedRaw = existsSync(seedDir) ? await safeReadSkillMd(seedDir, seedRoot) : null
      if (seedRaw != null) {
        // This name is a platform seed (authoritative copy now lives in seed-skills).
        if (normalizeForCompare(srcRaw) === normalizeForCompare(seedRaw)) {
          raw.push({ agentId, name, srcDir, action: 'drop', updatedAt })
        } else {
          raw.push({
            agentId,
            name,
            srcDir,
            action: 'migrate',
            target: `${name}-user`,
            renameReason: 'user-modified-seed',
            updatedAt,
          })
        }
      } else {
        raw.push({ agentId, name, srcDir, action: 'migrate', target: name, updatedAt })
      }
    }
  }

  // Resolve shared-name conflicts among migrate items (and vs already-existing shared dirs).
  const sharedRoot = join(home, 'skills')
  const taken = new Set<string>()
  if (existsSync(sharedRoot)) {
    for (const e of await readdir(sharedRoot, { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith('.')) taken.add(e.name)
    }
  }
  // Group migrate items by desired target; newest updated_at wins the bare name.
  const migrates = raw.filter((i) => i.action === 'migrate')
  const byTarget = new Map<string, PlanItem[]>()
  for (const it of migrates) {
    const k = it.target as string
    ;(byTarget.get(k) ?? byTarget.set(k, []).get(k)!).push(it)
  }
  for (const [base, group] of byTarget) {
    group.sort((a, b) => b.updatedAt - a.updatedAt)
    for (let idx = 0; idx < group.length; idx++) {
      const it = group[idx]
      const suffix = sanitizeSuffix(it.agentId)
      // Newest updated_at wins the bare name; the rest get a sanitized agent suffix.
      // Always clamp + validateSkillName so we never emit an invalid shared dir name.
      let candidate = clampName(idx === 0 ? base : `${base}--${suffix}`)
      let n = 2
      while (true) {
        if (validateSkillName(candidate).ok) {
          if (!taken.has(candidate)) break
          // Taken — but if a pre-existing shared dir of this name already holds THIS
          // legacy's content, it's our own prior (crashed-before-ledger) migration:
          // claim it as done instead of re-copying under a fresh suffix.
          if (await sharedSkillMatches(sharedRoot, candidate, it.srcDir)) {
            it.alreadyMigrated = true
            break
          }
        }
        candidate = clampName(`${base}--${suffix}-${n}`)
        if (n++ > 9999) throw new Error(`cannot allocate shared name for ${it.agentId}/${it.name}`)
      }
      taken.add(candidate)
      if (candidate !== base && !it.renameReason) it.renameReason = 'name-conflict'
      it.target = candidate
    }
  }

  return { items: raw, warnings }
}

/** Copy a skill dir into shared, rewriting frontmatter name if renamed. */
/** Recursively detect any symlink inside a skill dir (we refuse to migrate those). */
async function hasSymlinkInside(dir: string): Promise<boolean> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isSymbolicLink()) return true
    if (e.isDirectory() && (await hasSymlinkInside(join(dir, e.name)))) return true
  }
  return false
}

/** Atomically persist the ledger (temp + rename) so reruns are crash-safe. */
async function writeLedger(home: string, ledger: Ledger): Promise<void> {
  const dir = join(home, 'skills')
  await mkdir(dir, { recursive: true })
  const tmp = join(dir, `.skill-migration-ledger.json.tmp-${randomUUID()}`)
  await writeFile(tmp, JSON.stringify(ledger, null, 2))
  await rename(tmp, join(dir, '.skill-migration-ledger.json'))
}

async function migrateOne(home: string, it: PlanItem): Promise<void> {
  // Refuse to copy a skill dir that contains any symlink (cp dereference:false would
  // otherwise carry the link into shared); leave legacy intact and report a failure.
  if (await hasSymlinkInside(it.srcDir)) {
    throw new Error('skill dir contains a symlink; refusing to migrate')
  }
  const sharedRoot = join(home, 'skills')
  await mkdir(sharedRoot, { recursive: true })
  const realShared = await realpath(sharedRoot)
  const dest = join(sharedRoot, it.target as string)
  if (existsSync(dest)) throw new Error(`dest already exists: ${dest}`)
  // Stage into a hidden temp dir (SkillStore skips dot-dirs), finish ALL copying +
  // frontmatter rewrite, then rename into place. Atomic publish: a kill mid-copy can
  // only leave a hidden temp dir, never a half-written shared/<target>. So the
  // alreadyMigrated probe can trust that an existing dest dir is complete.
  const tmpDest = join(sharedRoot, `.${it.target}.tmp-${randomUUID()}`)
  try {
    await cp(it.srcDir, tmpDest, { recursive: true, dereference: false, errorOnExist: true })
    if (it.target !== it.name) {
      const md = join(tmpDest, 'SKILL.md')
      const raw = await readFile(md, 'utf-8')
      const { meta, body } = parseFrontmatter(raw)
      const newMeta = { ...meta, name: it.target as string }
      await writeFile(md, `${formatFrontmatter(newMeta as any)}\n\n${body.trim()}\n`)
    }
    const realTmp = await realpath(tmpDest)
    if (!realTmp.startsWith(realShared + sep)) throw new Error('temp dir escapes shared root')
    await rename(tmpDest, dest)
  } catch (err) {
    await rm(tmpDest, { recursive: true, force: true }).catch(() => {})
    throw err
  }
}

/** Safely remove a seed-residue legacy dir (agents/<id>/skills/<name>). */
async function dropResidue(it: PlanItem): Promise<void> {
  const skillsRoot = dirname(it.srcDir) // agents/<id>/skills
  if (lstatSync(it.srcDir).isSymbolicLink()) throw new Error('refuse to delete symlinked skill dir')
  const realDir = await realpath(it.srcDir)
  const realRoot = await realpath(skillsRoot)
  if (!realDir.startsWith(realRoot + sep)) throw new Error('skill dir escapes skills root')
  await rm(realDir, { recursive: true, force: true })
}

/** Lowercase + collapse illegal chars so a suffix is a valid skill-name fragment. */
function sanitizeSuffix(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'x'
  )
}

/** Clamp a candidate skill name to the max length, trimming trailing hyphens. */
function clampName(name: string): string {
  return name.length > MAX_SKILL_NAME_LENGTH
    ? name.slice(0, MAX_SKILL_NAME_LENGTH).replace(/-+$/, '')
    : name
}

async function main(): Promise<void> {
  const { home, apply } = parseArgs(process.argv)
  console.log(`[migrate-skills] home=${home} mode=${apply ? 'APPLY' : 'dry-run'}`)

  const agentsDir = join(home, 'agents')
  if (existsSync(agentsDir)) {
    const anySeed = (await readdir(agentsDir, { withFileTypes: true })).some(
      (e) => e.isDirectory() && existsSync(join(agentsDir, e.name, 'seed-skills')),
    )
    if (!anySeed) {
      console.warn(
        '[migrate-skills] WARN: no seed-skills dirs found — run AFTER deploying the new ' +
          'runtime image and recycling containers, else platform seeds may be copied into shared.',
      )
    }
  }

  const { items, warnings } = await buildPlan(home)
  for (const w of warnings) console.warn(`[migrate-skills] WARN ${w}`)

  const ledgerPath = join(home, 'skills', '.skill-migration-ledger.json')
  let ledger: Ledger = { version: 1, processed: {} }
  if (existsSync(ledgerPath)) {
    try {
      ledger = JSON.parse(await readFile(ledgerPath, 'utf-8'))
    } catch {
      console.warn('[migrate-skills] WARN: unreadable ledger, starting fresh')
    }
  }

  let migrated = 0
  let dropped = 0
  let skipped = 0
  const now = new Date().toISOString()
  for (const it of items) {
    const key = `${it.agentId}/${it.name}`
    if (ledger.processed[key]) {
      skipped++
      continue
    }
    if (it.alreadyMigrated) {
      // Copied to shared on a prior (crashed) run before the ledger was written.
      console.log(`  ${apply ? '' : '[dry] '}DONE(prev-run) ${key} → skills/${it.target}`)
      if (apply) {
        ledger.processed[key] = { action: it.action, target: it.target, ts: now }
        await writeLedger(home, ledger)
      }
      skipped++
      continue
    }
    const label =
      it.action === 'drop'
        ? `DROP   ${key} (seed residue)`
        : `MIGRATE ${key} → skills/${it.target}${it.renameReason ? ` [${it.renameReason}]` : ''}`
    console.log(`  ${apply ? '' : '[dry] '}${label}`)
    if (!apply) continue
    try {
      if (it.action === 'migrate') {
        await migrateOne(home, it)
        migrated++
      } else {
        await dropResidue(it) // seed residue: seed-skills is now authoritative, remove old copy
        dropped++
      }
      ledger.processed[key] = { action: it.action, target: it.target, ts: now }
      // Persist after EACH successful item so a crash mid-run never re-plans a
      // already-applied migrate/drop on rerun (which could create dup -suffix copies).
      await writeLedger(home, ledger)
    } catch (err) {
      console.error(`[migrate-skills] FAIL ${key}: ${(err as Error).message}`)
    }
  }

  console.log(
    `[migrate-skills] done: ${apply ? 'migrated' : 'would-migrate'}=${apply ? migrated : items.filter((i) => i.action === 'migrate').length} ` +
      `drop=${apply ? dropped : items.filter((i) => i.action === 'drop').length} skipped(ledger)=${skipped}`,
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
