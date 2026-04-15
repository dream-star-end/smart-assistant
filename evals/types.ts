// Evaluation framework types.
// Tasks are defined in YAML; the runner loads, executes, and judges them.

export type TaskCategory =
  | 'memory'
  | 'skill'
  | 'event'
  | 'session'
  | 'security'
  | 'config'
  | 'cost'

export type Difficulty = 'easy' | 'medium' | 'hard'

export type JudgeType = 'contains' | 'not_contains' | 'regex' | 'exact' | 'truthy' | 'throws'

export interface Assertion {
  type: JudgeType
  value: string | string[] | boolean
}

export interface SetupStep {
  action: string
  args: Record<string, unknown>
}

export interface TaskDef {
  id: string
  category: TaskCategory
  difficulty: Difficulty
  description: string
  /** Optional setup steps run before the main action */
  setup?: SetupStep[]
  /** The main action to execute */
  action: string
  /** Arguments passed to the action */
  args: Record<string, unknown>
  /** Assertions to verify against the result */
  assertions: Assertion[]
  /** Timeout in ms (default 10000) */
  timeout_ms?: number
  tags?: string[]
  /** Mark as expected failure — test runs but does not fail the suite */
  expected_failure?: boolean
}

export interface TaskResult {
  id: string
  category: TaskCategory
  difficulty: Difficulty
  passed: boolean
  duration_ms: number
  /** Which assertions failed */
  failures: string[]
  error?: string
}

export interface EvalReport {
  timestamp: string
  total: number
  passed: number
  failed: number
  xfail: number
  pass_rate: number
  by_category: Record<string, { total: number; passed: number; pass_rate: number }>
  by_difficulty: Record<string, { total: number; passed: number; pass_rate: number }>
  results: TaskResult[]
}
