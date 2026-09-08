/** Master-authored durable pending recovery projection. Never a replay authorization. */
export interface PendingPreparationRecovery {
  cause: 'preparation'
  mode: 'replay'
  sourceClientMessageId: string
  rootClientMessageId: string
  /** Absent while queued before first child admission. */
  clientMessageId?: string
  attempt: number
  max: number
  retryAt?: number
  agentId?: string
  model?: string
}
