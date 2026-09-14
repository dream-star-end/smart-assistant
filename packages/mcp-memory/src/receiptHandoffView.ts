/** Metadata only: never a receipt locator, result or ACK. */
export type ReceiptHandoff = {
  status: 'receipt_handoff'; jobId: string; generation: number
  execution: 'running' | 'terminal'; delivery: 'pending' | 'notified' | 'ingested'
}
export function parseReceiptHandoff(value: unknown): ReceiptHandoff | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const v = value as Record<string, unknown>
  if (Object.keys(v).sort().join(',') !== 'delivery,execution,generation,jobId,status' ||
      v.status !== 'receipt_handoff' || typeof v.jobId !== 'string' || !/^dlgjob-[a-z0-9-]{1,150}$/.test(v.jobId) ||
      !Number.isSafeInteger(v.generation) || Number(v.generation) < 0 ||
      (v.execution !== 'running' && v.execution !== 'terminal') ||
      (v.delivery !== 'pending' && v.delivery !== 'notified' && v.delivery !== 'ingested') ||
      (v.execution === 'running' && v.delivery !== 'pending')) return undefined
  return { status: 'receipt_handoff', jobId: v.jobId, generation: Number(v.generation),
    execution: v.execution as ReceiptHandoff['execution'], delivery: v.delivery as ReceiptHandoff['delivery'] }
}
export function formatReceiptHandoff(view: ReceiptHandoff): string {
  const detail = view.delivery === 'notified' ? '原回调已确认接收；这不表示回调模型已执行。' :
    view.delivery === 'ingested' ? '原回合已持久接收结果；不再经原回调重复发送。' :
    view.execution === 'running' ? '旧回合委派仍在运行，结果仍由原回调交付。' :
    '旧回合委派已终止，原回调或持久接收仍在处理中，尚未确认交付。'
  return `交接状态 jobId=${view.jobId}：${detail}本次仅查询状态并结束等待，不重复原结果，不代表子任务业务成功；不要重新委派。`
}
