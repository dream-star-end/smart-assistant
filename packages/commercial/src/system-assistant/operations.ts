/** Trusted operation implementations. An operation ID never becomes an arbitrary URL or command. */
import type { ZodTypeAny } from 'zod'
import { isDeepStrictEqual } from 'node:util'
import type { SystemActionExecutor, SystemActionPreview, SystemActionResult } from '@openclaude/protocol'
import type { SystemActionExecution } from '@openclaude/storage'
export interface SystemActor {
  userId: string
  role: 'user' | 'admin'
  sessionId: string
  agentId: string
}
export interface SystemOperationDescriptor {
  id: string
  version: number
  title: string
  topic: string
  effect: 'read' | 'write'
  executor: SystemActionExecutor
  /** Static data-format description; full help remains in the on-demand skill. */
  input: Readonly<Record<string, unknown>>
}
export interface PreparedOperation {
  args: unknown
  resourceKey: string
  preview: SystemActionPreview
  expectedVersion?: string
  quoteHash?: string
}
export interface SystemOperation extends SystemOperationDescriptor {
  roles: readonly SystemActor['role'][]
  schema: ZodTypeAny
  /** Frozen shape is separate from public input; validation may not transform stored values. */
  frozenSchema?: ZodTypeAny
  visible?(actor: SystemActor): Promise<boolean>
  authorize(actor: SystemActor, args: unknown): Promise<void>
  authorizeExecution?(actor: SystemActor, execution: SystemActionExecution): Promise<void>
  read?(actor: SystemActor, args: unknown): Promise<unknown>
  prepare?(actor: SystemActor, args: unknown): Promise<PreparedOperation>
  /** Must retain original business ACL and atomically check the frozen snapshot/quote at the write. */
  execute?(actor: SystemActor, execution: SystemActionExecution): Promise<SystemActionResult>
}
/** Only throw this when no business side effect occurred. Ambiguous outcomes must remain unknown. */
export class SystemOperationRejected extends Error {
  constructor(readonly code: 'FORBIDDEN' | 'CONFLICT' | 'UNAVAILABLE' | 'INVALID_INPUT') { super(code) }
}
export class SystemOperationRegistry {
  private readonly entries = new Map<string, SystemOperation>()
  constructor(operations: readonly SystemOperation[]) {
    for (const operation of operations) {
      if (!/^[a-z][a-z0-9.-]{1,99}$/.test(operation.id) || this.entries.has(operation.id) || !Number.isSafeInteger(operation.version) || operation.version < 1 ||
        (operation.effect === 'read' ? !operation.read : !operation.prepare || !operation.execute || !operation.frozenSchema || !operation.authorizeExecution)) throw new Error('Invalid system operation registration')
      this.entries.set(operation.id, Object.freeze({ ...operation }))
    }
  }
  private async find(actor: SystemActor, id: string): Promise<SystemOperation> {
    const operation = this.entries.get(id)
    if (!operation || !operation.roles.includes(actor.role) || (operation.visible && !await operation.visible(actor))) throw new SystemOperationRejected('FORBIDDEN')
    return operation
  }
  async catalog(actor: SystemActor, after = '', limit = 30): Promise<{ items: SystemOperationDescriptor[]; next: string | null }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 || after.length > 100) throw new SystemOperationRejected('INVALID_INPUT')
    const visible: SystemOperationDescriptor[] = []
    for (const operation of [...this.entries.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
      if (operation.id <= after || !operation.roles.includes(actor.role) || (operation.visible && !await operation.visible(actor))) continue
      const { id, version, title, topic, effect, executor, input } = operation
      visible.push({ id, version, title, topic, effect, executor, input })
      if (visible.length > limit) break
    }
    const items = visible.slice(0, limit)
    return { items, next: visible.length > limit ? items.at(-1)?.id ?? null : null }
  }
  private parse(operation: SystemOperation, raw: unknown): unknown {
    const result = operation.schema.safeParse(raw)
    if (!result.success) throw new SystemOperationRejected('INVALID_INPUT')
    return result.data
  }
  private frozen(operation: SystemOperation, args: unknown): unknown {
    const result = operation.frozenSchema?.safeParse(args)
    if (!result?.success || !isDeepStrictEqual(result.data, args)) throw new SystemOperationRejected('INVALID_INPUT')
    return args
  }
  async read(actor: SystemActor, id: string, raw: unknown): Promise<unknown> {
    const operation = await this.find(actor, id)
    if (operation.effect !== 'read' || !operation.read) throw new SystemOperationRejected('INVALID_INPUT')
    const args = this.parse(operation, raw)
    await operation.authorize(actor, args)
    return operation.read(actor, args)
  }
  /** Fresh permission and input validation also precede an owner-only idempotent receipt replay. */
  async authorizePreparation(actor: SystemActor, id: string, raw: unknown): Promise<void> {
    const operation = await this.find(actor, id)
    if (operation.effect !== 'write') throw new SystemOperationRejected('INVALID_INPUT')
    await operation.authorize(actor, this.parse(operation, raw))
  }
  async prepare(actor: SystemActor, id: string, raw: unknown): Promise<{ operation: SystemOperationDescriptor; prepared: PreparedOperation }> {
    const operation = await this.find(actor, id)
    if (operation.effect !== 'write' || !operation.prepare) throw new SystemOperationRejected('INVALID_INPUT')
    const args = this.parse(operation, raw)
    await operation.authorize(actor, args)
    const prepared = await operation.prepare(actor, args)
    this.frozen(operation, prepared.args)
    const { version, title, topic, effect, executor, input } = operation
    return { operation: { id, version, title, topic, effect, executor, input }, prepared }
  }
  async execute(actor: SystemActor, execution: SystemActionExecution): Promise<SystemActionResult> {
    if (actor.userId !== execution.userId) throw new SystemOperationRejected('FORBIDDEN')
    const operation = await this.find(actor, execution.operationId)
    if (operation.effect !== 'write' || !operation.execute || !operation.authorizeExecution || operation.version !== execution.operationVersion) throw new SystemOperationRejected('CONFLICT')
    const args = this.frozen(operation, execution.args)
    const frozenExecution = { ...execution, args }
    await operation.authorizeExecution(actor, frozenExecution)
    return operation.execute(actor, frozenExecution)
  }
}
