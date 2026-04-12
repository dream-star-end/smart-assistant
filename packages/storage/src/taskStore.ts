/**
 * Task Store — persistent task definitions and execution records.
 *
 * Provides a higher-level abstraction than cron jobs, supporting:
 * - Standing orders (persistent rules that fire on events or schedules)
 * - Background tasks with status tracking (pending → running → completed/failed)
 * - Execution history for audit and debugging
 *
 * Storage: ~/.openclaude/tasks.json
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { paths } from './paths.js'

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'disabled'
export type TaskTrigger = 'schedule' | 'webhook' | 'manual' | 'event'

export interface TaskDef {
  id: string
  title: string
  description?: string
  agent: string
  prompt: string
  trigger: TaskTrigger
  // Schedule trigger (cron expression)
  schedule?: string
  // Webhook trigger
  webhookId?: string
  // Event trigger
  eventType?: string
  // State
  status: TaskStatus
  createdAt: number
  updatedAt?: number
  // Execution limits
  maxRuns?: number
  runCount: number
  // Latest execution record
  lastRunAt?: number
  lastOutput?: string // truncated to 500 chars
  lastError?: string
}

export interface TaskExecution {
  taskId: string
  startedAt: number
  completedAt?: number
  status: 'running' | 'completed' | 'failed'
  output?: string
  error?: string
}

interface TaskFile {
  tasks: TaskDef[]
  executions: TaskExecution[] // last N executions for audit
}

const TASK_FILE = `${paths.home}/tasks.json`
const MAX_EXECUTIONS = 50 // keep last 50 execution records

async function loadTaskFile(): Promise<TaskFile> {
  try {
    if (existsSync(TASK_FILE)) {
      const raw = await readFile(TASK_FILE, 'utf-8')
      return JSON.parse(raw) as TaskFile
    }
  } catch {}
  return { tasks: [], executions: [] }
}

async function saveTaskFile(file: TaskFile): Promise<void> {
  await mkdir(dirname(TASK_FILE), { recursive: true })
  // Trim execution history
  if (file.executions.length > MAX_EXECUTIONS) {
    file.executions = file.executions.slice(-MAX_EXECUTIONS)
  }
  await writeFile(TASK_FILE, JSON.stringify(file, null, 2))
}

export class TaskStore {
  private file: TaskFile = { tasks: [], executions: [] }
  private loaded = false

  async load(): Promise<void> {
    this.file = await loadTaskFile()
    this.loaded = true
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load()
  }

  async list(): Promise<TaskDef[]> {
    await this.ensureLoaded()
    return this.file.tasks
  }

  async get(id: string): Promise<TaskDef | null> {
    await this.ensureLoaded()
    return this.file.tasks.find((t) => t.id === id) ?? null
  }

  async create(
    task: Omit<TaskDef, 'createdAt' | 'runCount' | 'status'> & { status?: TaskStatus },
  ): Promise<TaskDef> {
    await this.ensureLoaded()
    const full: TaskDef = {
      ...task,
      status: task.status ?? 'pending',
      createdAt: Date.now(),
      runCount: 0,
    }
    // Replace if same ID
    this.file.tasks = this.file.tasks.filter((t) => t.id !== full.id)
    this.file.tasks.push(full)
    await saveTaskFile(this.file)
    return full
  }

  async update(
    id: string,
    updates: Partial<
      Pick<
        TaskDef,
        | 'status'
        | 'title'
        | 'prompt'
        | 'schedule'
        | 'lastRunAt'
        | 'lastOutput'
        | 'lastError'
        | 'runCount'
      >
    >,
  ): Promise<boolean> {
    await this.ensureLoaded()
    const task = this.file.tasks.find((t) => t.id === id)
    if (!task) return false
    Object.assign(task, updates, { updatedAt: Date.now() })
    await saveTaskFile(this.file)
    return true
  }

  async remove(id: string): Promise<boolean> {
    await this.ensureLoaded()
    const before = this.file.tasks.length
    this.file.tasks = this.file.tasks.filter((t) => t.id !== id)
    if (this.file.tasks.length === before) return false
    await saveTaskFile(this.file)
    return true
  }

  async recordExecution(exec: TaskExecution): Promise<void> {
    await this.ensureLoaded()
    this.file.executions.push(exec)
    // Also update the task's last run info
    const task = this.file.tasks.find((t) => t.id === exec.taskId)
    if (task) {
      task.lastRunAt = exec.startedAt
      task.runCount += 1
      if (exec.output) task.lastOutput = exec.output.slice(0, 500)
      if (exec.error) task.lastError = exec.error
      task.status = exec.status === 'failed' ? 'failed' : 'completed'
      // Check max runs
      if (task.maxRuns && task.runCount >= task.maxRuns) {
        task.status = 'disabled'
      }
    }
    await saveTaskFile(this.file)
  }

  async recentExecutions(limit = 20): Promise<TaskExecution[]> {
    await this.ensureLoaded()
    return this.file.executions.slice(-limit)
  }
}
