export {
  createContainer,
  stopContainer,
  removeContainer,
  getContainerStatus,
  containerNameFor,
} from "./supervisor.js";
export { ensureAgentNetwork } from "./network.js";
export {
  ensureUserVolumes,
  removeUserVolumes,
  volumeNamesFor,
  type VolumePair,
} from "./volumes.js";
export {
  SupervisorError,
  type SupervisorErrorCode,
  type ProvisionOptions,
  type ProvisionResult,
  type ContainerStatus,
} from "./types.js";

// V3 Phase 3C — per-user openclaude-runtime supervisor(独立于 v2 createContainer)
export {
  provisionV3Container,
  stopAndRemoveV3Container,
  getV3ContainerStatus,
  markV3ContainerActivity,
  removeV3Volume,
  v3ContainerNameFor,
  v3VolumeNameFor,
  V3_NETWORK_NAME,
  V3_SUBNET_CIDR,
  V3_GATEWAY_IP,
  V3_INTERNAL_PROXY_URL,
  V3_CONTAINER_PORT,
  V3_CONFIG_TMPFS_PATH,
  V3_VOLUME_MOUNT,
  type V3SupervisorDeps,
  type ProvisionedV3Container,
  type V3ContainerStatus,
} from "./v3supervisor.js";

// V3 Phase 3D — bridge(/ws/user-chat-bridge)resolveContainerEndpoint 实现
export {
  makeV3EnsureRunning,
  ENSURE_RUNNING_DEFAULTS,
  type EnsureRunningOptions,
} from "./v3ensureRunning.js";

// V3 Phase 3E — readiness probe(HTTP /healthz + WS upgrade)
export {
  waitContainerReady,
  probeHealthzHttp,
  probeWsUpgrade,
  DEFAULT_READINESS_TIMEOUT_MS,
  DEFAULT_READINESS_INTERVAL_MS,
  DEFAULT_HTTP_PROBE_MS,
  DEFAULT_WS_PROBE_MS,
  type WaitContainerReadyOptions,
} from "./v3readiness.js";

// V3 Phase 3F — idle 30min sweep(ephemeral 单轨)
export {
  startIdleSweepScheduler,
  runIdleSweepTick,
  DEFAULT_IDLE_SWEEP_INTERVAL_MS,
  DEFAULT_IDLE_CUTOFF_MIN,
  DEFAULT_SWEEP_BATCH_LIMIT,
  type IdleSweepLogger,
  type IdleSweepTickOptions,
  type IdleSweepTickResult,
  type StartIdleSweepSchedulerOptions,
  type IdleSweepScheduler,
} from "./v3idleSweep.js";

// V3 Phase 3G — volume GC(banned 7d / no-login 90d)
export {
  startVolumeGcScheduler,
  runVolumeGcTick,
  DEFAULT_VOLUME_GC_INTERVAL_MS,
  DEFAULT_BANNED_RETAIN_DAYS,
  DEFAULT_NO_LOGIN_RETAIN_DAYS,
  DEFAULT_VOLUME_GC_BATCH_LIMIT,
  type VolumeGcLogger,
  type VolumeGcReason,
  type VolumeGcTickOptions,
  type VolumeGcTickResult,
  type StartVolumeGcSchedulerOptions,
  type VolumeGcScheduler,
} from "./v3volumeGc.js";
