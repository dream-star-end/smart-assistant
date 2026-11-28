import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { Pool } from "pg";
import type { WebSocket } from "ws";
import type {
  GoalStateSnapshot,
  MessageReplyQuote,
  RemoteExecutionBackend,
  SessionWorkspaceMode,
} from "@openclaude/protocol";
import type { ModelCatalogSnapshot } from "../../billing/modelCatalog.js";
import type { ModelSwitchCostService } from "../../billing/modelSwitchCost.js";
import type { PreCheckRedis } from "../../billing/preCheck.js";
import type { PricingCache } from "../../billing/pricing.js";
import type { NodeAgentTarget } from "../../compute-pool/nodeAgentClient.js";
import type { AdmitUserTurnInput, AdmitUserTurnResult } from "../../db/pgSessionsBackend.js";
import type { Logger } from "../../logging/logger.js";
import type { SystemHelpIdentityScope } from "../../system-assistant/helpGrant.js";
import type { AgentModelResolver } from "../agentModelAuthority.js";
import type { ConnectionRegistry } from "../connections.js";
import type { ContainerLinkRegistry, ContainerLinkSnapshot } from "../containerLink.js";
import type { RemotePoolSealDeps, SealExecLike } from "../userChatBridgeRemotePoolSeal.js";
import type { BridgeMetricSink, BridgeModelAuthorityDeps } from "../userChatBridgeTypes.js";

export type ResolveContainerEndpoint = (
  uid: bigint,
) => Promise<{
  host: string;
  port: number;
  containerId?: number;
  coldStart?: boolean;
  tunnel?: {
    hostId: string;
    containerInternalId: string;
    nodeAgent: NodeAgentTarget;
  };
  desktop?: { containerId: number };
  bundleRev?: string;
}>;

export interface CodexBindingHandle {
  acquire(
    containerId: number,
    groupId?: string | null,
  ): Promise<{ account_id: bigint; slotId: string } | null>;
  renew?(account_id: bigint, slotId: string): boolean;
  release(account_id: bigint, slotId: string): void;
}

export interface CodexApiRelayRoute {
  kind?: "api_relay";
  engine?: "codex" | "grok";
  token: string;
  baseUrl: string;
  modelProvider: string;
  providerName?: string | null;
  wireApi?: "responses" | "chat";
  preferredAuthMethod?: "apikey" | "chatgpt";
  disableResponseStorage?: boolean;
  groupId: string;
  credentialId: string;
  accountId?: string;
  slotId?: string;
}

export interface CodexOfficialOAuthRoute {
  kind: "official_oauth";
  groupId: string;
}

export interface CodexRouteUnavailable {
  kind: "unavailable";
  reason: string;
}

export type CodexRouteDecision =
  | CodexApiRelayRoute
  | CodexOfficialOAuthRoute
  | CodexRouteUnavailable;

export interface UserChatBridgeDeps {
  cc5BackendSelector?: (input: {
    uid: number;
    containerId: number;
    sessionKey: string;
    canonicalModel: string;
    engine: string;
    placement: "local" | "remote_pool";
    requiredCapabilities?: import("@openclaude/protocol").RequiredTurnCapabilities;
    systemPromptSha256?: string;
  }) => Promise<RemoteExecutionBackend | undefined>;
  crossPoolFallbackSelector?: RemotePoolSealDeps<SealExecLike>["crossPoolFallbackSelector"];
  returnToRemoteGrantResolver?: RemotePoolSealDeps<SealExecLike>["returnToRemoteGrantResolver"];
  forcedLocalMigrationResolver?: RemotePoolSealDeps<SealExecLike>["forcedLocalMigrationResolver"];
  recordRemotePlacement?: RemotePoolSealDeps<SealExecLike>["recordRemotePlacement"];
  markPlacementMigrationInstalled?: (args: {
    uid: number;
    sessionKey: string;
    placementEpoch: number;
    migrationId: string;
    checkpointGeneration?: string | null;
    consumedByTurnKey?: string;
    requireWarmCheckpointMatch?: boolean;
  }) => Promise<boolean>;
  peekLogicalModelPoolTarget?: (
    rawModelId: string,
    catalogSnapshot?: Pick<ModelCatalogSnapshot, "resolve"> | null,
    isModelAllowed?: (canonicalModel: string) => boolean,
    uid?: number,
    sessionKey?: string | null,
  ) => string | null;
  resolveLogicalModelPoolTarget?: (args: {
    rawModelId: string;
    catalogSnapshot: Pick<ModelCatalogSnapshot, "resolve">;
    isModelAllowed?: (canonicalModel: string) => boolean;
    uid?: number;
    sessionKey?: string | null;
  }) => Promise<{ ok: true; canonicalModelId: string } | { ok: false; code: string }>;
  containerLinkEnabled?: boolean;
  containerLinkToolBrokerEnabled?: boolean;
  containerLinkHeartbeatMs?: number;
  resolveContainerLinkEndpoint?: (
    uid: bigint,
    containerId: number,
  ) => Promise<Awaited<ReturnType<ResolveContainerEndpoint>> | "pending" | null>;
  containerLinkRecovery?: {
    channel?: string;
    retryMs?: number;
    spacingMs?: number;
    maxAttempts?: number;
  };
  deferBackgroundActivation?: boolean;
  modelSwitchCost?: ModelSwitchCostService;
  jwtSecret: string | Uint8Array;
  issueSystemHelpBootstrap?: (scope: SystemHelpIdentityScope) => {
    token: string;
    expiresAt: number;
  };
  promptQueueEnabled?: boolean;
  promptQueuePreparationTimeoutMs?: number;
  dispatchLeaseHeartbeatMs?: number;
  admittedRenewMaxAgeMs?: number;
  deferContainerSendCompletionForTest?: (complete: () => void) => void;
  modelAuthority?: BridgeModelAuthorityDeps;
  resolveContainerEndpoint: ResolveContainerEndpoint;
  getFrontendBuildId?: () => string | null;
  frontendBuildReannounceMs?: number;
  maxPerUser?: number;
  maxFrameBytes?: number;
  maxBufferedBytes?: number;
  containerConnectTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  metrics?: BridgeMetricSink;
  logger?: Logger;
  createContainerSocket?: (host: string, port: number, signal: AbortSignal) => WebSocket;
  createTunnelContainerSocket?: (
    tunnel: { hostId: string; containerInternalId: string; nodeAgent: NodeAgentTarget },
    containerPort: number,
    signal: AbortSignal,
    connectionTraceId: string,
  ) => Promise<WebSocket>;
  markContainerActivity?: (containerId: number) => void;
  activityKeepaliveIntervalMs?: number;
  loadAllowedModelChecker?: (
    uid: bigint,
    requiredEpoch?: bigint,
  ) => Promise<(modelId: string) => boolean>;
  loadAgentModelResolver?: (
    uid: bigint,
    opts: { bundleRev?: string },
  ) => Promise<AgentModelResolver>;
  loadMasterSessionMessages?: (
    uid: bigint,
    sessionId: string,
    options: {
      contextWindow: number | null;
      engine: string;
      currentUserText: string;
      excludeClientMessageId?: string;
    },
  ) => Promise<unknown[] | null>;
  hasCompletedClientTurn?: (
    uid: bigint,
    sessionId: string,
    clientMessageId: string,
  ) => Promise<boolean>;
  loadGoalState?: (uid: bigint, sessionId: string) => Promise<GoalStateSnapshot | null>;
  updateGoalEngineMetrics?: (args: {
    uid: bigint;
    sessionId: string;
    goalId: string;
    stateRevision: number;
    engineStatus?: string;
    tokensUsed?: number;
    timeUsedSeconds?: number;
    engineUpdatedAt?: string;
  }) => Promise<unknown>;
  persistMasterUserMessage?: (
    uid: bigint,
    sessionId: string,
    message: {
      id: string;
      role: "user";
      text: string;
      ts: number;
      _media?: unknown[];
      _retryMedia?: unknown[];
      _imageEdit?: Record<string, unknown>;
      _modelText?: string;
      _replyTo?: MessageReplyQuote;
      _routing?: {
        model?: string;
        teamMode: boolean;
        swarmMode?: boolean;
        effortLevel: string | null;
      };
    },
  ) => Promise<{
    applied: boolean;
    reason?: "session_not_found" | "session_deleted" | "already_exists" | "malformed" | "oversized";
    workspaceMode?: SessionWorkspaceMode;
  }>;
  persistOutboundFrame?: (input: {
    uid: bigint;
    sessionId: string;
    clientMessageId: string | null;
    agentContainerId: number;
    sessionKey: string;
    frameSeq: number;
    payload: string;
  }) => Promise<void>;
  admitUserTurn?: (input: AdmitUserTurnInput) => Promise<AdmitUserTurnResult>;
  reconcileAutomaticRecoveryJobs?: (uid: bigint, limit?: number) => Promise<number>;
  loadSessionWorkspaceMode?: (
    uid: bigint,
    sessionId: string,
  ) => Promise<SessionWorkspaceMode | null>;
  codexBinding?: CodexBindingHandle;
  createCodexRoute?: (args: {
    containerId: number;
    userId: bigint;
    modelId: string;
    sessionId?: string;
  }) => Promise<CodexRouteDecision | null>;
  expireCodexRoute?: (token: string) => Promise<void>;
  releaseGrokRouteLease?: (accountId: bigint, slotId: string) => Promise<void>;
  mintZcodeRoute?: (args: {
    containerId: number;
    userId: bigint;
    requestId: string;
    modelId: string;
  }) => Promise<{ token: string; baseUrl: string }>;
  expireZcodeRoute?: (token: string) => void | Promise<void>;
  admitAntigravityTurn?: (args: {
    containerId: number;
    userId: bigint;
    requestId: string;
    modelId: string;
    budgetCredits: bigint;
    allowedModelIds?: readonly string[];
  }) => Promise<{
    token: string;
    baseUrl: string;
    accessToken: string;
    accessTokenExpiresAt: string;
    idToken: string | null;
    allowedModelIds?: readonly string[];
  }>;
  expireAntigravityRoute?: (token: string) => void | Promise<void>;
  expireAntigravityRouteForRequest?: (requestId: string, expectedUserId: bigint) => void | Promise<void>;
  selfHostId?: string | null;
  pgPool?: Pool;
  preCheckRedis?: PreCheckRedis;
  pricing?: PricingCache;
  appendCostCredits?: (
    requestId: string,
    userId: string,
    costCredits: string,
    sessionId?: string | null,
    parentSessionId?: string | null,
    delegateAgentId?: string | null,
    turnKey?: string | null,
    parentTurnKey?: string | null,
  ) => Promise<unknown>;
}

export type CronOriginExecutorClaimResult =
  | { kind: "claimed" }
  | { kind: "not_claimed" }
  | { kind: "rejected" }
  | { kind: "delivery_unknown" };

export type CronOriginExecutor = ((payload: {
  encoded: Buffer;
  admitted: {
    clientMessageId: string;
    sessionId: string;
    agentId: string;
    dispatchId: string;
    billingRequestId: string;
    attemptNo: number;
    leaseEpoch: number;
    leaseOwnerId: string;
    anchorSeq: bigint | null;
    requestHash: string;
  };
}) => CronOriginExecutorClaimResult | Promise<CronOriginExecutorClaimResult>) & {
  agentContainerId?: number | null;
  runtimeKind?: "docker" | "desktop" | null;
  isAvailable?: () => boolean;
};

export interface UserChatBridgeHandler {
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  shutdown(reason?: string): Promise<void>;
  registry: ConnectionRegistry;
  readonly containerLinkEnabled?: boolean;
  containerLinkSnapshots?(): ContainerLinkSnapshot[];
  rebuildContainerLinks?(): Promise<void>;
  createBrokerFrameLinkOpener?(): ReturnType<ContainerLinkRegistry["createBrokerFrameLinkOpener"]> | null;
  setBackgroundRoleActive?(active: boolean): Promise<void>;
  setActiveLeader?(active: boolean): Promise<void>;
  drainBrowserWebSockets?(): number;
  broadcastToUser(uid: bigint, payload: unknown): number;
  syncGoalToContainers(uid: bigint, goal: unknown): number;
  drainRecoveryForUser(uid: bigint): Promise<void>;
  drainControlsForUser?(uid: bigint): Promise<void>;
  broadcastAll(payload: unknown): number;
  broadcastToUsers(uids: string[], payload: unknown): number;
  onlineUserSubset(uids: string[]): string[];
  injectCronOriginTurn(input: CronOriginInjectInput): Promise<CronOriginInjectResult>;
  _testRegisterCronOriginExecutor(uid: string, executor: CronOriginExecutor): void;
  _testGetCronOriginExecutor(uid: string): CronOriginExecutor | null;
}

export type CronOriginInjectInput = {
  uid: bigint;
  sessionId: string;
  text: string;
  clientMessageId: string;
  agentId: string;
};

export type CronOriginInjectResult =
  | { kind: "injected" }
  | { kind: "gone" }
  | { kind: "in_flight" }
  | { kind: "no_transport" }
  | { kind: "failed"; reason: string };

export type TurnGoalResolution =
  | { kind: "ok"; goalState: GoalStateSnapshot | null }
  | { kind: "unavailable"; err: unknown };
