/** Same token as protocol BOX_NATIVE_CONTEXT_OWNER. Kept local so this package does not require a new protocol export at test resolution time. */
export const BOX_NATIVE_CONTEXT_OWNER = "box-native-v1" as const;
export type BoxNativeContextOwner = typeof BOX_NATIVE_CONTEXT_OWNER;
export const BOX_NATIVE_CONTEXT_MODEL = "box-api-claude-opus-5-5";

/**
 * Production route-ready projection. Default off.
 * Callers must pass this constant; request body and process env are not a source.
 */
export const BOX_NATIVE_CONTEXT_ROUTE_READY = false;

/** Real gate fields. `kind` / `profile` are not on ModelAuthorityDecision. */
export interface BoxNativeContextGate {
  authorityKind?: string | null;
  /**
   * Copied from a verified full authority envelope only.
   * Null on lease-only: that credential does not carry capabilityProfile.
   */
  verifiedSignedContextOwner?: string | null;
  descriptor?: {
    canonicalModel?: string;
    providerId?: string | null;
    capabilityProfile?: { ccb?: { contextOwner?: string } };
  } | null;
}

export interface BoxNativeContextRoute {
  kind: string;
}

export interface SignedCcbCapability {
  capabilityZero: boolean;
  supportsThinking: boolean;
  contextOwner?: BoxNativeContextOwner;
}

/**
 * Put the token on the signed descriptor only when the server route is ready,
 * the catalog provider is the Box route, the canonical model is the exact Box
 * model, and the catalog itself declared the same token. A client body or env
 * value is not an input.
 */
export function issueBoxNativeContextOwner(input: {
  canonicalModel: string;
  providerId: string | null;
  declared: string | undefined;
  routeReady: boolean;
}): BoxNativeContextOwner | undefined {
  if (input.routeReady !== true) return undefined;
  if (input.providerId !== "box_cli") return undefined;
  if (input.canonicalModel !== BOX_NATIVE_CONTEXT_MODEL) return undefined;
  if (input.declared !== BOX_NATIVE_CONTEXT_OWNER) return undefined;
  return BOX_NATIVE_CONTEXT_OWNER;
}

/** Wire shape copied into the signed execution descriptor. */
export function signedCcbCapability(input: {
  canonicalModel: string;
  providerId: string | null;
  capabilityZero: boolean;
  supportsThinking: boolean;
  declaredContextOwner?: string;
  routeReady?: boolean;
}): SignedCcbCapability {
  const contextOwner = issueBoxNativeContextOwner({
    canonicalModel: input.canonicalModel,
    providerId: input.providerId,
    declared: input.declaredContextOwner,
    routeReady: input.routeReady ?? BOX_NATIVE_CONTEXT_ROUTE_READY,
  });
  return {
    capabilityZero: input.capabilityZero,
    supportsThinking: input.supportsThinking,
    ...(contextOwner === undefined ? {} : { contextOwner }),
  };
}

/**
 * Budget grant. Issuance rules stay in `issueBoxNativeContextOwner`.
 * Catalog declaration alone is not enough: the full authority envelope must
 * have carried the same token. Lease-only leaves `verifiedSignedContextOwner`
 * null and stays legacy. `routeReady` is the issuance constant, not
 * `OC_BOX_MODEL_API`.
 */
export function verifiedBoxNativeContextOwner(input: {
  authorityKind?: string | null;
  routeKind?: string | null;
  canonicalModel?: string | null;
  providerId?: string | null;
  declaredContextOwner?: string;
  verifiedSignedContextOwner?: string | null;
  routeReady: boolean;
}): BoxNativeContextOwner | null {
  if (input.authorityKind !== "bridge_signed") return null;
  if (input.routeKind !== "box") return null;
  if (input.verifiedSignedContextOwner !== BOX_NATIVE_CONTEXT_OWNER) return null;
  return issueBoxNativeContextOwner({
    canonicalModel: input.canonicalModel ?? "",
    providerId: input.providerId ?? null,
    declared: input.declaredContextOwner,
    routeReady: input.routeReady,
  }) ?? null;
}

/**
 * Byte-budget eligibility. This is not live-chain ownership.
 * Bridge still needs the signed contextOwner. A verified local_catalog gate
 * can select the same limited budget for an exact ready Box route, but
 * `getBoxNativeContextOwner` stays null and `verifiedSignedContextOwner`
 * must remain null. Local is not idle-only: any authorized container request
 * on this route gets the same ceiling.
 */
export function selectBoxNativeByteBudget(input: {
  authorityKind?: string | null;
  routeKind?: string | null;
  canonicalModel?: string | null;
  providerId?: string | null;
  declaredContextOwner?: string;
  verifiedSignedContextOwner?: string | null;
  routeReady: boolean;
  containerId?: bigint | null;
  externalApiKey?: boolean;
  transportConfigured?: boolean;
}): "legacy" | "box-native-v1" {
  if (verifiedBoxNativeContextOwner(input) !== null) return "box-native-v1";
  if (input.authorityKind !== "local_catalog") return "legacy";
  if (input.containerId == null || input.externalApiKey === true) return "legacy";
  if (input.transportConfigured !== true) return "legacy";
  if (input.routeKind !== "box") return "legacy";
  const declared = issueBoxNativeContextOwner({
    canonicalModel: input.canonicalModel ?? "",
    providerId: input.providerId ?? null,
    declared: input.declaredContextOwner,
    routeReady: input.routeReady,
  });
  return declared === BOX_NATIVE_CONTEXT_OWNER ? "box-native-v1" : "legacy";
}

/**
 * Read API aligned with ModelAuthorityDecision. Default `routeReady` is the
 * production constant (false). Does not read body or env.
 * local_catalog never returns the live-chain token.
 */
export function getBoxNativeContextOwner(
  gate: BoxNativeContextGate,
  route: BoxNativeContextRoute,
  routeReady: boolean = BOX_NATIVE_CONTEXT_ROUTE_READY,
): BoxNativeContextOwner | null {
  return verifiedBoxNativeContextOwner({
    authorityKind: gate.authorityKind,
    routeKind: route.kind,
    canonicalModel: gate.descriptor?.canonicalModel,
    providerId: gate.descriptor?.providerId,
    declaredContextOwner: gate.descriptor?.capabilityProfile?.ccb?.contextOwner,
    verifiedSignedContextOwner: gate.verifiedSignedContextOwner,
    routeReady,
  });
}
