/** Own inbox writes use the exact approved IDs and the shared PG receipt transaction. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { SystemActionExecution } from '@openclaude/storage'
import type { SystemActionResult } from '@openclaude/protocol'
import { InboxError } from '../inbox/inbox.js'
import { InboxApprovalConflict, snapshotInboxRead, markApprovedInboxRead } from '../inbox/readApproval.js'
import type { QueryRunner } from '../db/queries.js'
import { withPgActionReceipt } from './pgReceipts.js'
import { SystemOperationRejected, type SystemActor, type SystemOperation } from './operations.js'
const id = z.string().regex(/^[1-9][0-9]{0,18}$/).refine(value => BigInt(value) <= 9223372036854775807n)
const single = z.object({ messageId: id }).strict()
const empty = z.object({}).strict()
const frozen = z.object({ messages: z.array(z.object({ id, version: z.string().regex(/^[0-9]{1,10}$/) }).strict()), title: z.string().max(200).optional() }).strict()
const digest = (messages: unknown) => createHash('sha256').update(JSON.stringify(messages)).digest('hex')
export interface NotificationOperationDeps {
  authorize(actor: SystemActor): Promise<void>
  snapshot?: typeof snapshotInboxRead
  write?: typeof markApprovedInboxRead
  effect?: (actor: SystemActor, execution: SystemActionExecution, work: (runner: QueryRunner) => Promise<SystemActionResult>) => Promise<SystemActionResult>
}
async function translate<T>(work: () => Promise<T>): Promise<T> {
  try { return await work() } catch (error) {
    if (error instanceof InboxApprovalConflict) throw new SystemOperationRejected('CONFLICT')
    if (error instanceof InboxError) throw new SystemOperationRejected(error.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'INVALID_INPUT')
    throw error
  }
}
export function notificationOperations(deps: NotificationOperationDeps): SystemOperation[] {
  const snapshot = deps.snapshot ?? snapshotInboxRead, write = deps.write ?? markApprovedInboxRead
  const effect = deps.effect ?? withPgActionReceipt
  return [false, true].map<SystemOperation>(all => ({
    id: all ? 'notifications.read-all' : 'notifications.mark-read', title: all ? '将本次未读通知全部标为已读' : '将通知标为已读',
    version: 1, topic: 'sharing-notices', effect: 'write', executor: 'master', roles: ['user','admin'],
    schema: all ? empty : single, frozenSchema: frozen,
    input: all ? {} : { messageId: 'positive decimal notification ID' }, authorize: deps.authorize,
    prepare: async (actor, raw) => {
      const result = await translate(() => snapshot(actor.userId, all ? null : (raw as z.infer<typeof single>).messageId))
      const args = { messages: result.messages, ...(all ? {} : { title: (result.title ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 200) }) }
      return { args, resourceKey: `notifications:${actor.userId}`, expectedVersion: digest(args.messages), preview: {
        title: all ? '将本次未读通知全部标为已读' : '将通知标为已读', description: all ? `本次冻结 ${args.messages.length} 条通知；此后新增通知不在范围内。` : '仅修改下列通知的本人已读状态。',
        scope: '本人站内通知', before: [{ label: all ? '本次未读数量' : '通知标题', value: all ? String(args.messages.length) : args.title! }],
        after: [{ label: '目标状态', value: '已读' }], consequences: ['保留通知内容，不删除通知，不发送邮件或外部消息。', '仅处理这次审批冻结的通知；删除、过期或版本变化需要重新审批。'],
        destructive: false, price: { kind: 'none', label: '标记已读不收费' },
      } }
    },
    authorizeExecution: async (actor, execution) => {
      await deps.authorize(actor)
      const args = frozen.parse(execution.args)
      if ((!all && args.messages.length !== 1) || execution.expectedVersion !== digest(args.messages)) throw new SystemOperationRejected('CONFLICT')
    },
    execute: async (actor, execution) => effect(actor, execution, async runner => {
      const args = frozen.parse(execution.args)
      const result = await translate(() => write(actor.userId, args.messages, runner))
      return { summary: result.inserted ? `已将 ${result.inserted} 条通知标记为已读。` : '这些通知已是已读，本次无需新增标记。', completion: 'done' }
    }),
  }))
}
