import { ALLOWED_INBOUND_MODELS } from "@openclaude/gateway"

export interface WechatVisibleModel {
  id: string
}

export interface PickWechatInboundModelArgs {
  /** Raw user_preferences.default_model; may be stale or gateway-incompatible. */
  preferredModel: unknown
  /** Already filtered by pricing.listForUser(authz): enabled + visible/authorized. */
  visibleModels: readonly WechatVisibleModel[]
  /** Execution authorization check for a single model id. */
  canUseModel: (modelId: string) => boolean
  /** Gateway protocol allowlist; default mirrors packages/gateway/src/server.ts. */
  allowedModels?: ReadonlySet<string>
}

/**
 * Pick the model id to place on the broker → container WeChat inbound frame.
 *
 * WeChat follows the user's web default model when it is both authorized and
 * accepted by the container gateway's static InboundMessage.model allowlist.
 * If the preference is stale (disabled/unauthorized/unknown) or is not a
 * gateway-compatible id, fall back to the first enabled visible model that the
 * gateway can route. Returning null preserves legacy container-default behavior.
 */
export function pickWechatInboundModel(args: PickWechatInboundModelArgs): string | null {
  const allowed = args.allowedModels ?? ALLOWED_INBOUND_MODELS
  const preferred = typeof args.preferredModel === "string" ? args.preferredModel : null
  if (preferred && allowed.has(preferred) && args.canUseModel(preferred)) {
    return preferred
  }

  for (const model of args.visibleModels) {
    if (allowed.has(model.id) && args.canUseModel(model.id)) return model.id
  }
  return null
}
