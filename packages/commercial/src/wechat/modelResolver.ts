import { ALLOWED_INBOUND_MODELS } from "@openclaude/gateway"

export interface WechatVisibleModel {
  id: string
  display_name?: string
  displayName?: string
}

export interface WechatInboundModelOption {
  id: string
  displayName: string
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

  const fallback = listWechatInboundModels(args)[0]
  if (fallback) return fallback.id
  return null
}

export function listWechatInboundModels(args: PickWechatInboundModelArgs): WechatInboundModelOption[] {
  const allowed = args.allowedModels ?? ALLOWED_INBOUND_MODELS
  const out: WechatInboundModelOption[] = []
  const seen = new Set<string>()
  for (const model of args.visibleModels) {
    if (seen.has(model.id)) continue
    seen.add(model.id)
    if (!allowed.has(model.id)) continue
    if (!args.canUseModel(model.id)) continue
    out.push({
      id: model.id,
      displayName: model.displayName ?? model.display_name ?? model.id,
    })
  }
  return out
}

export function pickWechatModelByUserInput(
  rawInput: string,
  models: readonly WechatInboundModelOption[],
): WechatInboundModelOption | null {
  const input = rawInput.trim()
  if (!input) return null
  if (/^[1-9][0-9]*$/.test(input)) {
    const idx = Number(input) - 1
    return models[idx] ?? null
  }
  return models.find((m) => m.id === input) ?? null
}
