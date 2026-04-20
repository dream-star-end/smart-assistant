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
