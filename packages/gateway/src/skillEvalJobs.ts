// Skill-eval Job registry — 评测 run 的持久化状态(镜像 SkillTrainJobStore 的模式:
// 内存索引 + run.json 落盘 + 重启把 active 收敛为 failed)。执行编排在 server.ts
// (_runSkillEval);本模块只管状态,不知道 session/WS,便于单测。

import { randomUUID } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { paths, type SkillEvalCase } from '@openclaude/storage'
import type {
  SkillEvalArm,
  SkillEvalBenchmark,
  SkillEvalCaseResult,
  SkillEvalUsage,
} from './skillEval.js'
import { emptyUsage } from './skillEval.js'

const VALID_RUN_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/

export type SkillEvalStatus = 'queued' | 'running' | 'grading' | 'done' | 'failed'

export type SkillEvalMode = 'baseline' | 'draft'

export interface SkillEvalRun {
  runId: string
  skillName: string
  userId: string
  /** baseline = with vs without;draft = draft vs with(SkillOpt 评测门)。 */
  mode: SkillEvalMode
  /** draft 模式:所属训练 run(草稿来源)。 */
  trainRunId: string | null
  model: string
  status: SkillEvalStatus
  /** 进度:已完成的 case-arm 会话数 / 总数。 */
  progress: { done: number; total: number }
  cases: SkillEvalCase[]
  results: SkillEvalCaseResult[]
  benchmark: SkillEvalBenchmark | null
  /** 全 run 累计用量(被测会话 + grader,含 turns 数)——前端据公开费率折算积分展示。 */
  usage: SkillEvalUsage
  error: string | null
  startedAt: number
  updatedAt: number
  finishedAt: number | null
}

const ACTIVE: ReadonlySet<SkillEvalStatus> = new Set(['queued', 'running', 'grading'])

export function armsForMode(mode: SkillEvalMode): SkillEvalArm[] {
  return mode === 'draft' ? ['with', 'draft'] : ['without', 'with']
}

export class SkillEvalJobStore {
  private readonly runs = new Map<string, SkillEvalRun>()
  private readonly maxConcurrent: number

  constructor(opts: { maxConcurrent?: number } = {}) {
    this.maxConcurrent = Math.max(1, opts.maxConcurrent ?? 1)
  }

  static newRunId(): string {
    return `eval-${randomUUID()}`
  }

  /**
   * 本 store 内是否有该技能的活跃评测 run。供「生成」侧做同技能互斥查询 —— 只看**同技能**,
   * 不受全局并发上限干扰(canStart 会把别的技能占满上限也算 false,不适合跨 store 互斥)。
   */
  activeForSkill(skillName: string): boolean {
    for (const r of this.runs.values()) {
      if (ACTIVE.has(r.status) && r.skillName === skillName) return true
    }
    return false
  }

  /** 并发守卫:全局上限 + 同技能不并发(防同一技能两跑互相当噪声)。 */
  canStart(skillName: string): { ok: boolean; reason?: string } {
    let active = 0
    for (const r of this.runs.values()) {
      if (!ACTIVE.has(r.status)) continue
      active++
      if (r.skillName === skillName) {
        return { ok: false, reason: `an eval run for "${skillName}" is already in progress` }
      }
    }
    if (active >= this.maxConcurrent) {
      return { ok: false, reason: `too many concurrent eval runs (max ${this.maxConcurrent})` }
    }
    return { ok: true }
  }

  async create(input: {
    runId: string
    skillName: string
    userId: string
    mode: SkillEvalMode
    trainRunId?: string | null
    model: string
    cases: SkillEvalCase[]
    now: number
  }): Promise<SkillEvalRun> {
    const arms = armsForMode(input.mode)
    const run: SkillEvalRun = {
      runId: input.runId,
      skillName: input.skillName,
      userId: input.userId,
      mode: input.mode,
      trainRunId: input.trainRunId ?? null,
      model: input.model,
      status: 'queued',
      progress: { done: 0, total: input.cases.length * arms.length },
      cases: input.cases,
      results: [],
      benchmark: null,
      usage: emptyUsage(),
      error: null,
      startedAt: input.now,
      updatedAt: input.now,
      finishedAt: null,
    }
    this.runs.set(run.runId, run)
    await this.persist(run)
    return run
  }

  get(runId: string): SkillEvalRun | undefined {
    return this.runs.get(runId)
  }

  /** 状态/进度/结果原地变更后统一走这里落盘。 */
  async touch(run: SkillEvalRun, now: number): Promise<void> {
    run.updatedAt = now
    await this.persist(run)
  }

  async finish(
    run: SkillEvalRun,
    now: number,
    outcome: { benchmark?: SkillEvalBenchmark; error?: string },
  ): Promise<void> {
    if (outcome.error) {
      run.status = 'failed'
      run.error = outcome.error
    } else {
      run.status = 'done'
      run.benchmark = outcome.benchmark ?? null
    }
    run.finishedAt = now
    await this.touch(run, now)
  }

  /** 重启回收:落盘的 active run 一律收敛 failed(评测会话没跨进程续跑语义)。 */
  async loadAll(now: number): Promise<void> {
    const root = this._safeRoot()
    if (!root || !existsSync(root)) return
    let dirs: string[]
    try {
      dirs = await readdir(root)
    } catch {
      return
    }
    for (const runId of dirs) {
      if (!VALID_RUN_ID_RE.test(runId)) continue
      const file = join(root, runId, 'run.json')
      if (!existsSync(file)) continue
      try {
        const realFile = await realpath(file)
        if (!realFile.startsWith(root + sep)) continue
        const parsed = JSON.parse(await readFile(realFile, 'utf-8')) as SkillEvalRun
        if (!parsed?.runId || parsed.runId !== runId) continue
        if (ACTIVE.has(parsed.status)) {
          parsed.status = 'failed'
          parsed.error = 'gateway restarted during eval'
          parsed.finishedAt = now
        }
        this.runs.set(parsed.runId, parsed)
      } catch {}
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

  private async persist(run: SkillEvalRun): Promise<void> {
    try {
      if (!VALID_RUN_ID_RE.test(run.runId)) return
      const root = this._safeRoot()
      if (!root) return
      const dir = paths.skillEvalRunDir(run.runId)
      await mkdir(dir, { recursive: true })
      const realDir = await realpath(dir)
      if (!realDir.startsWith(root + sep)) return
      const file = join(realDir, 'run.json')
      const tmp = join(realDir, `.run.json.tmp-${randomUUID()}`)
      await writeFile(tmp, `${JSON.stringify(run, null, 2)}\n`)
      await rename(tmp, file)
    } catch {
      /* best-effort;内存索引仍是本进程权威 */
    }
  }
}
