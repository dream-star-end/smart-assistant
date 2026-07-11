// Skill-eval「AI 生成用例」的轻量 Job 状态机 —— 镜像 SkillEvalJobStore 的持久化范式
// (内存索引 + 落盘 + 重启把 active 收敛为 failed),但语义更轻:一个 job = 一个隔离生成
// turn,只有 running/done/failed 三态,不复用评测 run 的 arm/grader/benchmark 语义。
//
// 落盘:`~/.openclaude/skill-evals/gen-<runId>.json`(与评测 run 的 `<runId>/run.json`
// 子目录形态刻意区分,同目录共存互不干扰:gen 文件带 `.json` 后缀且 `gen-` 前缀,评测的
// loadAll 用 VALID_RUN_ID_RE 会因 `.` 跳过 gen 文件;本 store 的 loadAll 只认 gen-*.json)。
//
// 执行编排(采集素材 / 起 turn / 归一化)在 server.ts(_runSkillEvalGen);本模块不碰
// session/WS,便于单测。

import { randomUUID } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { paths, type SkillEvalCase } from '@openclaude/storage'
import { type SkillEvalUsage, emptyUsage } from './skillEval.js'

/** 落盘文件名:gen-<uuid>.json。runId 本身即 `gen-<uuid>`,故文件名 = `${runId}.json`。 */
const GEN_FILE_RE = /^(gen-[a-zA-Z0-9_-]{1,128})\.json$/
const VALID_RUN_ID_RE = /^gen-[a-zA-Z0-9_-]{1,128}$/

export type SkillEvalGenStatus = 'running' | 'done' | 'failed'

export interface SkillEvalGenRun {
  runId: string
  skillName: string
  userId: string
  model: string
  status: SkillEvalGenStatus
  /** done 时的草稿用例(仅本次生成的新用例,不含技能现有用例)。 */
  cases: SkillEvalCase[]
  /** 成功提示(素材来源/合并上限)或失败原因;前端提示条直接展示。 */
  note: string | null
  usage: SkillEvalUsage
  startedAt: number
  updatedAt: number
  finishedAt: number | null
}

const ACTIVE: ReadonlySet<SkillEvalGenStatus> = new Set(['running'])

export class SkillEvalGenJobStore {
  private readonly runs = new Map<string, SkillEvalGenRun>()
  private readonly maxConcurrent: number

  constructor(opts: { maxConcurrent?: number } = {}) {
    this.maxConcurrent = Math.max(1, opts.maxConcurrent ?? 1)
  }

  static newRunId(): string {
    return `gen-${randomUUID()}`
  }

  /** 本 store 内是否有该技能的活跃生成 run(供跨 store 互斥查询)。 */
  activeForSkill(skillName: string): boolean {
    for (const r of this.runs.values()) {
      if (ACTIVE.has(r.status) && r.skillName === skillName) return true
    }
    return false
  }

  /** 并发守卫:全局上限 + 同技能不并发(评测侧的互斥由调用方另查 skillEvalJobs)。 */
  canStart(skillName: string): { ok: boolean; reason?: string } {
    let active = 0
    for (const r of this.runs.values()) {
      if (!ACTIVE.has(r.status)) continue
      active++
      if (r.skillName === skillName) {
        return { ok: false, reason: `a generation for "${skillName}" is already in progress` }
      }
    }
    if (active >= this.maxConcurrent) {
      return { ok: false, reason: `too many concurrent generations (max ${this.maxConcurrent})` }
    }
    return { ok: true }
  }

  async create(input: {
    runId: string
    skillName: string
    userId: string
    model: string
    now: number
  }): Promise<SkillEvalGenRun> {
    const run: SkillEvalGenRun = {
      runId: input.runId,
      skillName: input.skillName,
      userId: input.userId,
      model: input.model,
      status: 'running',
      cases: [],
      note: null,
      usage: emptyUsage(),
      startedAt: input.now,
      updatedAt: input.now,
      finishedAt: null,
    }
    this.runs.set(run.runId, run)
    await this.persist(run)
    return run
  }

  get(runId: string): SkillEvalGenRun | undefined {
    return this.runs.get(runId)
  }

  /** 原地变更后统一落盘。 */
  async touch(run: SkillEvalGenRun, now: number): Promise<void> {
    run.updatedAt = now
    await this.persist(run)
  }

  async finishDone(
    run: SkillEvalGenRun,
    now: number,
    outcome: { cases: SkillEvalCase[]; note: string },
  ): Promise<void> {
    run.status = 'done'
    run.cases = outcome.cases
    run.note = outcome.note
    run.finishedAt = now
    await this.touch(run, now)
  }

  async finishFailed(run: SkillEvalGenRun, now: number, reason: string): Promise<void> {
    run.status = 'failed'
    run.note = reason
    run.finishedAt = now
    await this.touch(run, now)
  }

  /** 重启回收:落盘的 active(running)run 一律收敛 failed(生成 turn 无跨进程续跑语义)。 */
  async loadAll(now: number): Promise<void> {
    const root = this._safeRoot()
    if (!root || !existsSync(root)) return
    let entries: string[]
    try {
      entries = await readdir(root)
    } catch {
      return
    }
    for (const entry of entries) {
      const m = GEN_FILE_RE.exec(entry)
      if (!m) continue
      const runId = m[1]
      const file = join(root, entry)
      try {
        const realFile = await realpath(file)
        if (!realFile.startsWith(root + sep)) continue
        const parsed = JSON.parse(await readFile(realFile, 'utf-8')) as SkillEvalGenRun
        if (!parsed?.runId || parsed.runId !== runId) continue
        if (ACTIVE.has(parsed.status)) {
          parsed.status = 'failed'
          parsed.note = 'gateway restarted during generation'
          parsed.finishedAt = now
        }
        this.runs.set(parsed.runId, parsed)
      } catch {
        /* 损坏的落盘文件跳过 */
      }
    }
  }

  private _safeRoot(): string | null {
    const root = existsSync(paths.skillEvalsDir)
      ? realpathSync(paths.skillEvalsDir)
      : resolve(paths.skillEvalsDir)
    const home = existsSync(paths.home) ? realpathSync(paths.home) : resolve(paths.home)
    if (root !== home && !root.startsWith(home + sep)) return null
    return root
  }

  private async persist(run: SkillEvalGenRun): Promise<void> {
    try {
      if (!VALID_RUN_ID_RE.test(run.runId)) return
      await mkdir(paths.skillEvalsDir, { recursive: true })
      const root = this._safeRoot()
      if (!root) return
      const file = join(root, `${run.runId}.json`)
      const tmp = join(root, `.${run.runId}.json.tmp-${randomUUID()}`)
      await writeFile(tmp, `${JSON.stringify(run, null, 2)}\n`)
      await rename(tmp, file)
    } catch {
      /* best-effort;内存索引仍是本进程权威 */
    }
  }
}
