// 容器页数据契约 —— 形状对齐 commercial serializeContainer / getContainersPoolStats /
// handleAdminContainerLogs（packages/commercial/src/http/admin/containers.ts）。

/** GET /api/admin/agent-containers → { rows: ContainerRow[] } 中的一行。 */
export type ContainerRow = {
  id: number
  user_id: number | string | null
  user_email: string | null
  subscription_id: number | string | null
  subscription_status: string | null
  subscription_end_at: string | null
  docker_id: string | null
  docker_name: string | null
  workspace_volume: string | null
  home_volume: string | null
  image: string | null
  status: string | null
  state: string | null
  lifecycle: string | null
  row_kind: string | null
  last_started_at: string | null
  last_stopped_at: string | null
  volume_gc_at: string | null
  last_error: string | null
  created_at: string
  updated_at: string
  host_uuid: string | null
  host_name: string | null
}

/** GET /api/admin/agent-containers/stats（ContainersPoolStats）。 */
export type ContainerStats = {
  total: number
  running: number
  provisioning: number
  stopped: number
  error: number
  gone: number
  v2: number
  v3: number
  expiring_7d: number
  with_last_error: number
}

/** GET /api/admin/agent-containers/:id/logs?lines=N。 */
export type ContainerLogs = {
  id: string
  lines: number
  stdout: string
  stderr: string
  combined: string
  docker_ref: string | null
  missing: boolean
  partial?: 'bytes_truncated' | 'stream_error' | null
}

/** 生命周期动作（path segment，无 body）。 */
export type ContainerAction = 'restart' | 'stop' | 'remove'
