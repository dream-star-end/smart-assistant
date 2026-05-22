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
  v3ProjectsVolumeNameFor,
  v3CodexVolumeNameFor,
  v3UserLocalVolumeNameFor,
  v3UserConfigVolumeNameFor,
  V3_NETWORK_NAME,
  V3_SUBNET_CIDR,
  V3_GATEWAY_IP,
  V3_INTERNAL_PROXY_URL,
  gatewayIpFromV3Cidr,
  V3_CONTAINER_PORT,
  V3_CONFIG_TMPFS_PATH,
  V3_VOLUME_MOUNT,
  V3_PROJECTS_MOUNT,
  V3_CODEX_HOME_MOUNT,
  V3_USER_LOCAL_MOUNT,
  V3_USER_CONFIG_MOUNT,
  // V3 image preheat(per-host cap admission 现在直接读 compute_hosts.max_containers,
  // 无全局 cap 常量需要 re-export)
  preheatV3Image,
  // CCB 平台基线(只读注入容器的身份/守则/自省 skill)
  DEFAULT_V3_CCB_BASELINE_DIR,
  V3_CCB_BASELINE_SKILL_NAMES,
  resolveCcbBaselineMounts,
  type V3SupervisorDeps,
  type ProvisionedV3Container,
  type V3ContainerStatus,
  type V3ImagePreheatResult,
  type V3VolumeBundle,
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
  DEFAULT_READINESS_TIMEOUT_REMOTE_MS,
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

// V3 Phase 3H — orphan reconcile(gateway 启动 + 1h tick,docker↔DB 双向)
export {
  startOrphanReconcileScheduler,
  runOrphanReconcileTick,
  DEFAULT_ORPHAN_RECONCILE_INTERVAL_MS,
  DEFAULT_RECONCILE_BATCH_LIMIT,
  SAFETY_RACE_WINDOW_SEC,
  type OrphanReconcileLogger,
  type OrphanReconcileTickOptions,
  type OrphanReconcileTickResult,
  type StartOrphanReconcileSchedulerOptions,
  type OrphanReconcileScheduler,
} from "./v3orphanReconcile.js";

// T-63 Phase 2 — docker container event stream 订阅:OOM → admin 告警
export {
  startV3ContainerEventsWorker,
  handleContainerEvent,
  uidFromContainerName,
  createDedupeCache,
  type V3ContainerEventsWorker,
  type StartV3ContainerEventsWorkerOptions,
  type ContainerEventsLogger,
  type DockerContainerEvent,
  type HandleResult,
  type HandleContainerEventDeps,
  type OomInspectFn,
} from "./v3containerEvents.js";

// 邮箱验证后 fire-and-forget 容器 pre-warm helper
export { makePrewarmContainer } from "./v3prewarm.js";

// v1.0.191 per-uid singleflight wrapper:HTTP `/api/media-signed` 与 WS bridge
// `resolveContainerEndpoint` 默认共享同一闭包,合并 reload 同瞬间的 ensure race。
// 详见 ensureContainerSingleflight.ts 文件头注释 + index.ts `sharedEnsureRunning`。
export { makeUidSingleflight } from "./ensureContainerSingleflight.js";

// V3 multi-tenant media resolver — gateway 用它把 `/api/uploads` 写路径 +
// `/api/media` 读路径(同时覆盖 codex image_gen 输出的 generated/ 子目录)
// 路由到具体用户的 docker volume host path,避免 master/container 单租户
// paths.uploadsDir / paths.generatedDir 假设造成的 "媒体不存在或不可读" /
// "图像 404" 双视图 bug。详见 userMedia.ts 头注释。
export {
  createUserMediaResolver,
  buildUserMediaHostDir,
  parseCommercialUid,
  isUserVolumeMediaPath,
  USER_VOLUME_MEDIA_HOST_PREFIX,
  USER_VOLUME_UPLOADS_SUBPATH,
  USER_VOLUME_GENERATED_SUBPATH,
  USER_VOLUME_MEDIA_DIR_REGEX,
  USER_VOLUME_MEDIA_FILE_REGEX,
  type MediaKind,
  type UserMediaLocation,
  type PoolLike as UserMediaPoolLike,
  type DockerLike as UserMediaDockerLike,
} from "./userMedia.js";
