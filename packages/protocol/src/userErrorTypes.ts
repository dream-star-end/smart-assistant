/** Public presentation metadata. It never authorizes a retry, charge or write. */
export type UserErrorCategory =
  | 'auth' | 'permission' | 'input' | 'size' | 'context' | 'capacity'
  | 'model' | 'connection' | 'execution' | 'storage' | 'billing'
  | 'cancelled' | 'configuration' | 'state' | 'conflict' | 'not_found' | 'unknown'

export type UserErrorAction =
  | 'retry' | 'switch_model' | 'contact_admin' | 'edit_message' | 'relogin'
  | 'refresh' | 'topup' | 'new_session' | 'wait' | 'check_settings' | 'split_upload'

export interface UserError {
  /** Catalog key; machine metadata, never message body. */
  code: string
  category: UserErrorCategory
  /** Display hint only. Existing admission and exact replay gates still apply. */
  retryable: boolean
  userMessageKey: string
  message: string
  actions: readonly UserErrorAction[]
}

export interface AutomaticRetryStatus {
  state: 'scheduled' | 'running' | 'paused' | 'exhausted' | 'declined'
  /** Omitted on old jobs/early refusals when the server has no proven count. */
  attempt?: number
  maxAttempts?: number
  message: string
  actions: readonly UserErrorAction[]
}
