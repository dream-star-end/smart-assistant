import { z } from 'zod'
import type { SystemActionExecution } from '@openclaude/storage'
import type { SystemActionResult } from '@openclaude/protocol'
import type { QueryRunner } from '../db/queries.js'
import { readSessionMetadata, patchSessionMetadataInTx, SessionMetadataConflict } from '../db/sessionMetadataApproval.js'
import { withPgActionReceipt } from './pgReceipts.js'
import { SystemOperationRejected, type SystemActor, type SystemOperation } from './operations.js'
const id = z.string().min(1).max(160).refine(value => !value.includes('\0'))
const patch = z.object({ title: z.string().trim().min(1).max(120).optional(), pinned: z.boolean().optional() }).strict().refine(value => value.title !== undefined || value.pinned !== undefined)
const input = z.object({ sessionId: id, patch }).strict()
const frozen = z.object({ sessionId: id, patch, before: z.object({ title: z.string(), pinned: z.boolean() }).strict(), version: z.string().regex(/^[0-9]{1,10}$/) }).strict()
export interface SessionMetadataOperationDeps {
  pgSessionsReady?: boolean
  authorize(actor: SystemActor): Promise<void>
  snapshot?: typeof readSessionMetadata
  write?: typeof patchSessionMetadataInTx
  effect?: (actor: SystemActor, execution: SystemActionExecution, work: (runner: QueryRunner) => Promise<SystemActionResult>) => Promise<SystemActionResult>
}
export function sessionMetadataOperations(deps: SessionMetadataOperationDeps): SystemOperation[] {
  const requirePg = () => { if (deps.pgSessionsReady !== true) throw new SystemOperationRejected('UNAVAILABLE') }
  const read = deps.snapshot ?? readSessionMetadata
  const write = deps.write ?? patchSessionMetadataInTx
  const effect = deps.effect ?? withPgActionReceipt
  return [{ id: 'sessions.metadata.update', version: 1, topic: 'sessions-goals', title: '更改会话名称或置顶', executor: 'master', effect: 'write', roles: ['user','admin'],
    schema: input, frozenSchema: frozen, input: { sessionId: 'owned session ID', patch: { title: 'optional new title,1-120 characters', pinned: 'optional boolean' } }, authorize: deps.authorize,
    prepare: async (actor, raw) => {
      requirePg()
      const parsed = input.parse(raw)
      const current = await read(`c:${actor.userId}`, parsed.sessionId)
      if (!current) throw new SystemOperationRejected('NOT_FOUND')
      const args = { ...parsed, before: { title: current.title, pinned: current.pinned }, version: current.version }
      const before = [{ label: '会话', value: current.title }, { label: '置顶', value: current.pinned ? '是' : '否' }]
      const after = [{ label: '会话', value: parsed.patch.title ?? current.title }, { label: '置顶', value: (parsed.patch.pinned ?? current.pinned) ? '是' : '否' }]
      return { args, expectedVersion: current.version, resourceKey: `session-metadata:${actor.userId}:${parsed.sessionId}`, preview: { title: '更改会话名称或置顶', description: '仅修改本人指定会话的侧栏信息。', scope: parsed.sessionId,
        before, after, consequences: ['不改消息、当前模型、项目归属或运行中的回合。', '其他设备改变这条会话后，需要重新审批。'], price: { kind: 'none', label: '更改名称或置顶不收费' }, destructive: false } }
    },
    authorizeExecution: async (actor, execution) => { await deps.authorize(actor); requirePg(); const args = frozen.parse(execution.args); if (execution.expectedVersion !== args.version) throw new SystemOperationRejected('CONFLICT') },
    execute: async (actor, execution) => { requirePg(); return effect(actor, execution, async runner => {
      const args = frozen.parse(execution.args)
      try {
        const result = await write(runner, args.sessionId, `c:${actor.userId}`, args.patch, args.version)
        if (!result.ok) throw new SystemOperationRejected('NOT_FOUND')
        return { completion: 'done', summary: '已更新会话名称和置顶状态。', effectReference: `session:${args.sessionId}` }
      } catch (error) { if (error instanceof SessionMetadataConflict) throw new SystemOperationRejected('CONFLICT'); throw error }
    }) },
  }]
}
