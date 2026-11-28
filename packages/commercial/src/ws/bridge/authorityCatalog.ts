import { grokExecutionUpstream, type ModelExecutionDescriptor } from "@openclaude/protocol";
import {
  platformAuxModels,
  type ModelCatalogCache,
  type ModelCatalogSnapshot,
  type ModelExecutionDescriptor as CatalogExecutionDescriptor,
} from "../../billing/modelCatalog.js";
import {
  BOX_NATIVE_CONTEXT_ROUTE_READY,
  signedCcbCapability,
} from "../../http/proxy/boxNativeContextOwner.js";
import type { AgentModelResolver } from "../agentModelAuthority.js";
import type { ModelCheckerHandle } from "../userChatBridgeTypes.js";
import { ModelNotAvailableError } from "./constants.js";
import { engineUsesAnthropicAuxModels, isGrokEngineKind } from "./enginePolicy.js";
import type {
  AgentModelResolverHandle,
  BridgeSharedState,
  ResolvedTurnExecution,
} from "./types.js";

type DescriptorJsonValue = ModelExecutionDescriptor["capabilityProfile"][string];

function buildSignedCcbCapability(d: CatalogExecutionDescriptor): Record<string, DescriptorJsonValue> {
  const ccb = signedCcbCapability({
    canonicalModel: d.canonicalModel,
    providerId: d.providerId,
    capabilityZero: d.capabilityProfile.ccb.capabilityZero,
    supportsThinking: d.capabilityProfile.ccb.supportsThinking,
    declaredContextOwner: d.capabilityProfile.ccb.contextOwner,
    routeReady: BOX_NATIVE_CONTEXT_ROUTE_READY,
  });
  const out: Record<string, DescriptorJsonValue> = {
    capabilityZero: ccb.capabilityZero,
    supportsThinking: ccb.supportsThinking,
  };
  if (ccb.contextOwner !== undefined) out.contextOwner = ccb.contextOwner;
  return out;
}

export function toProtocolDescriptor(d: CatalogExecutionDescriptor): ModelExecutionDescriptor {
  const profile = d.capabilityProfile;
  const capabilityProfile: Record<string, DescriptorJsonValue> = {
    supportsVision: profile.supportsVision,
    reasoning: {
      supported: [...profile.reasoning.supported],
      codexModelDefault: profile.reasoning.codexModelDefault,
    },
    ccb: buildSignedCcbCapability(d),
  };
  if (isGrokEngineKind(d.engine)) {
    capabilityProfile.grok = {
      upstreamModelId: grokExecutionUpstream(d.canonicalModel, d.upstreamModelId),
    };
  }
  return {
    capabilityProfile,
    capabilitySchemaVersion: d.capabilitySchemaVersion,
    contextWindow: d.contextWindow,
    supportedEfforts: [...profile.reasoning.supported],
    ...(profile.reasoning.codexModelDefault === null
      ? {}
      : { codexDefaultEffort: profile.reasoning.codexModelDefault }),
    supportsVision: profile.supportsVision,
  };
}

export async function resolveTurnExecution(
  catalog: ModelCatalogCache,
  modelIdOrAlias: string,
): Promise<ResolvedTurnExecution> {
  const snapshot: ModelCatalogSnapshot = await catalog.assertFresh();
  const canonicalModel = snapshot.aliasToCanonical(modelIdOrAlias);
  const descriptor = snapshot.resolve(canonicalModel);
  const pricing = snapshot.billingPricingFor(canonicalModel);
  if (descriptor === null || pricing === null) throw new ModelNotAvailableError(modelIdOrAlias);
  return {
    canonicalModel: descriptor.canonicalModel,
    engine: descriptor.engine,
    descriptor: toProtocolDescriptor(descriptor),
    pricing,
    billingRevision: snapshot.billingRevision,
    auxModels: engineUsesAnthropicAuxModels(descriptor.engine) ? platformAuxModels(snapshot) : [],
    executionRevision: snapshot.executionRevision,
    securityEpoch: Number(snapshot.securityEpoch),
    placement: descriptor.placement === "remote_pool" ? "remote_pool" : "local",
  };
}

export async function loadBridgeModelChecker(
  shared: BridgeSharedState,
  uid: bigint,
): Promise<ModelCheckerHandle | null> {
  const loader = shared.deps.loadAllowedModelChecker;
  if (!loader) return null;
  const observeEpoch = (): bigint => shared.deps.modelAuthority?.catalog.peek()?.securityEpoch ?? 0n;
  let inner: (modelId: string) => boolean = () => false;
  let checkerEpoch = 0n;
  let loadInflight: { minEpoch: bigint; p: Promise<void> } | null = null;
  const startLoad = (minEpoch: bigint): Promise<void> => {
    const entry: { minEpoch: bigint; p: Promise<void> } = { minEpoch, p: Promise.resolve() };
    entry.p = (async () => {
      const next = await loader(uid, minEpoch === 0n ? undefined : minEpoch);
      if (minEpoch >= checkerEpoch) {
        inner = next;
        checkerEpoch = minEpoch;
      }
    })().finally(() => {
      if (loadInflight === entry) loadInflight = null;
    });
    loadInflight = entry;
    return entry.p;
  };
  await startLoad(observeEpoch());
  return {
    isAllowed: (modelId) => inner(modelId),
    epoch: () => checkerEpoch,
    refresh: async () => {
      try {
        await startLoad(observeEpoch());
      } catch (err) {
        shared.log?.warn("user-chat-bridge: modelChecker refresh failed (keep last good)", {
          uid: uid.toString(),
          err,
        });
      }
    },
    reloadAtLeast: async (want) => {
      if (checkerEpoch >= want) return;
      const cur = loadInflight;
      await (cur !== null && cur.minEpoch >= want ? cur.p : startLoad(want));
      if (checkerEpoch < want) {
        throw new Error(`grants snapshot did not reach epoch ${want} (at ${checkerEpoch})`);
      }
    },
  };
}

export async function loadBridgeAgentModelResolver(
  shared: BridgeSharedState,
  uid: bigint,
  bundleRev: string | undefined,
): Promise<AgentModelResolverHandle | null> {
  const loadResolver = shared.deps.loadAgentModelResolver;
  if (!loadResolver) return null;
  const resolverOpts: { bundleRev?: string } = bundleRev !== undefined ? { bundleRev } : {};
  let innerResolve: AgentModelResolver = await loadResolver(uid, resolverOpts);
  let refreshInflight: Promise<void> | null = null;
  return {
    resolve: (agentId) => innerResolve(agentId),
    isRuntimeDenied: (agentId) => innerResolve.isRuntimeDenied?.(agentId) === true,
    isIdentityRegistered: (agentId) => innerResolve.isIdentityRegistered?.(agentId) ?? false,
    authorizeExecution: async (agentId) => {
      const current = innerResolve;
      if (current.authorizeExecution) return current.authorizeExecution(agentId);
      return {
        identity: {
          requestedId: agentId,
          executionAgentId: agentId,
          status: "no-registration" as const,
        },
        model: current(agentId),
      };
    },
    refresh: async () => {
      if (refreshInflight !== null) return refreshInflight;
      refreshInflight = (async () => {
        try {
          innerResolve = await loadResolver(uid, resolverOpts);
        } catch (err) {
          shared.log?.warn("user-chat-bridge: agentModelResolver refresh failed (keep last good)", {
            uid: uid.toString(),
            err,
          });
        }
      })().finally(() => {
        refreshInflight = null;
      });
      return refreshInflight;
    },
  };
}
