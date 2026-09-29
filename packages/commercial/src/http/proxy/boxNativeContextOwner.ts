/** Same token as protocol BOX_NATIVE_CONTEXT_OWNER. Kept local so this package does not require a new protocol export at test resolution time. */
export const BOX_NATIVE_CONTEXT_OWNER = "box-native-v1" as const;
export type BoxNativeContextOwner = typeof BOX_NATIVE_CONTEXT_OWNER;
export const BOX_NATIVE_CONTEXT_MODEL = "box-api-claude-opus-5-5";

/**
 * Production route-ready projection. Default off.
 * Callers must pass this constant; request body and process env are not a source.
 */
export const BOX_NATIVE_CONTEXT_ROUTE_READY = false;

export interface BoxNativeContextGate {
  kind: string;
  profile?: {
    ccb?: {
      contextOwner?: string;
    };
  };
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
 * Read API for the later envelope gate. True only for a bridge-signed profile
 * that already carries the exact token and a box route. Does not read body or env.
 */
export function getBoxNativeContextOwner(
  gate: BoxNativeContextGate,
  route: BoxNativeContextRoute,
): BoxNativeContextOwner | null {
  if (gate.kind !== "bridge_signed") return null;
  if (gate.profile?.ccb?.contextOwner !== BOX_NATIVE_CONTEXT_OWNER) return null;
  if (route.kind !== "box") return null;
  return BOX_NATIVE_CONTEXT_OWNER;
}
