// 后端响应形状（对齐 commercial admin/users.ts + usersStats.ts；只列消费字段）。

export type UserStatus = 'active' | 'banned' | 'deleting' | 'deleted'
export type UserRole = 'user' | 'admin'

/** with_stats=1 的用户行。 */
export type UserRow = {
  id: string
  email: string
  email_verified: boolean
  display_name: string | null
  avatar_url: string | null
  role: UserRole
  credits: string
  status: UserStatus
  created_at: string
  updated_at: string
  deleted_at: string | null
  today_requests: number
  today_errors: number
  total_topup_cents: string
  last_active_at: string | null
  containers_active: number
}

export type ListUsersResult = { rows: UserRow[]; next_cursor: string | null }

export type UsersStats = {
  total_users: number
  active_users: number
  banned_users: number
  deleted_users: number
  new_7d: number
  active_7d: number
  paying_7d: number
  avg_credits_cents: string
  total_credits_cents: string
}

export type FunnelStats = {
  days: number
  cohort_total: number
  verified: number
  first_topup: number
  first_attempt: number
  first_success: number
  eligible_for_d1: number
  eligible_for_d7: number
  d1_retained: number
  d7_retained: number
  rolling_d1_7_retained: number
}

export type UserDetail = {
  user: UserRow
  lifecycle: {
    first_topup_at: string | null
    first_request_at: string | null
    last_active_at: string | null
  }
  topups: Array<{ id: string; delta: string; memo: string | null; created_at: string }>
  recent_requests: Array<{
    id: string
    model: string
    status: 'success' | 'billing_failed' | 'error'
    cost_credits: string
    session_id: string | null
    created_at: string
  }>
  recent_sessions: UserSessionSummary[]
}

export type UserSessionSummary = {
  session_id: string
  title: string
  agent_id: string
  message_count: number
  created_at: string
  last_at: string
  updated_at: string
}

export type ModelGrant = {
  id: string
  model_id: string
  granted_at: string
  granted_by: string | null
}
