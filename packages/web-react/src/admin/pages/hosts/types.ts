// 虚机池数据契约 —— 形状对齐 commercial ComputeHostView / BaselineVersionView /
// BootstrapLogView / diagnostic / DistributeHostResult（packages/commercial/src/admin/computeHosts.ts）。

export type HostStatus =
  | 'ready'
  | 'bootstrapping'
  | 'draining'
  | 'quarantined'
  | 'broken'
  | 'removed'
  | 'revoked'
  | string

/** GET /api/admin/v3/compute-hosts → { hosts: HostRow[] }。 */
export type HostRow = {
  id: string
  name: string
  host: string
  ssh_port: number
  ssh_user: string
  agent_port: number
  status: HostStatus
  max_containers: number
  active_containers: number
  cert_not_before: string | null
  cert_not_after: string | null
  last_health_at: string | null
  last_health_ok: boolean | null
  last_health_err: string | null
  consecutive_health_ok: number
  consecutive_health_fail: number
  last_bootstrap_at: string | null
  last_bootstrap_err: string | null
  expires_at: string | null
  created_at: string
  updated_at: string
  loaded_image_id: string | null
  desired_image_id: string | null
  last_health_endpoint_ok: boolean | null
  last_uplink_ok: boolean | null
  last_egress_probe_ok: boolean | null
  last_health_poll_at: string | null
  last_uplink_at: string | null
  last_egress_probe_at: string | null
  placement_gate_open: boolean
  disk_pct: number | null
  mem_pct: number | null
  load1: number | null
  cpu_count: number | null
  metrics_at: string | null
  req_5m: number
}

/** GET /api/admin/v3/baseline-version。 */
export type BaselineView = {
  master_version: string | null
  master_err: string | null
  per_host: {
    host_id: string
    name: string
    remote_version: string | null
    err: string | null
  }[]
}

/** GET /api/admin/v3/compute-hosts/:id/bootstrap-log。 */
export type BootstrapLogView = {
  status: HostStatus
  failed_step?: string | null
  last_bootstrap_at: string | null
  last_bootstrap_err: string | null
}

/** GET /api/admin/v3/compute-hosts/:id/diagnostic。 */
export type HostDiagnostic = {
  host: Record<string, unknown> & {
    id?: string
    status?: string
    placement_gate_open?: boolean
    loaded_image_id?: string | null
    desired_image_id?: string | null
  }
  audit: {
    created_at?: string
    createdAt?: string
    action?: string
    event?: string
    details?: unknown
    after?: unknown
    before?: unknown
  }[]
  pool: {
    desiredImageId: string | null
    desiredImageTag?: string | null
    masterEpoch: string
    updatedAt: string
  }
}

/** POST /api/admin/v3/compute-hosts/add body。 */
export type AddHostInput = {
  name: string
  host: string
  ssh_port: number
  ssh_user: string
  password: string
  agent_port: number
  bridge_cidr: string
  max_containers: number
  expires_at: string | null
}

/** distribute-image per-host result（DistributeHostResult）。 */
export type DistributeResult = {
  hostId: string
  hostName: string
  outcome: 'already' | 'loaded' | 'skipped' | 'error'
  durationMs: number
  bytes?: number
  error?: string
  errorSource?: string
}
