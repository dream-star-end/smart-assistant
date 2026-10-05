/**
 * Models of the Box model route (engine ccb, provider box_cli). The agent and
 * its tools stay in the user container; egress runs one tool-less `claude -p`
 * in the account's Box per model request.
 *
 * `upstreamModel` is the id passed to the Box CLI as `--model`, and also the
 * exact `message.model` the CLI then reports: the stream decoders compare the
 * two byte for byte. Haiku carries its dated id for that reason. The CLI
 * accepts the alias claude-haiku-4-5 but reports claude-haiku-4-5-20251001.
 * `maxOutputTokens` is the model's output cap. `supportsEffort` says whether a
 * request may carry thinking / output_config (mapped to the CLI's `--effort`).
 *
 * Every fence that used to name one model reads this table. A model that is
 * not listed cannot run on the route, whatever the catalog says.
 * Two files cannot import this package and keep a mirror of the ids:
 * claude-code-best/src/utils/model/boxNativeRemoteContext.ts (separate tree)
 * and packages/commercial/src/http/proxy/boxNativeContextOwner.ts (loaded
 * outside the workspace by the idle pipeline fixture). boxApiModels.test.ts
 * compares both with this table.
 */
export interface BoxApiModel {
  readonly id: string
  readonly upstreamModel: string
  readonly maxOutputTokens: number
  readonly supportsEffort: boolean
}

export const BOX_API_MODELS = [
  { id: 'box-api-claude-opus-5-5', upstreamModel: 'claude-opus-5-5', maxOutputTokens: 128_000, supportsEffort: true },
  { id: 'box-api-claude-sonnet-5-5', upstreamModel: 'claude-sonnet-5-5', maxOutputTokens: 128_000, supportsEffort: true },
  { id: 'box-api-claude-haiku-4-5', upstreamModel: 'claude-haiku-4-5-20251001', maxOutputTokens: 64_000, supportsEffort: false },
] as const satisfies readonly BoxApiModel[]

export type BoxApiModelId = (typeof BOX_API_MODELS)[number]['id']
export type BoxApiUpstreamModelId = (typeof BOX_API_MODELS)[number]['upstreamModel']

export const BOX_API_MODEL_IDS: readonly BoxApiModelId[] = BOX_API_MODELS.map((m) => m.id)
export const BOX_API_UPSTREAM_MODEL_IDS: readonly BoxApiUpstreamModelId[] =
  BOX_API_MODELS.map((m) => m.upstreamModel)

// The ids are also written into SQL lists and into the CLI argv.
for (const m of BOX_API_MODELS) {
  if (!/^box-api-claude-[a-z0-9-]{3,48}$/.test(m.id) || !/^claude-[a-z0-9-]{3,64}$/.test(m.upstreamModel)) {
    throw new Error(`BOX_API_MODELS entry has an invalid id: ${m.id}`)
  }
}

/** Exact canonical id of a Box route model. Not a prefix match. */
export function isBoxApiModel(model: unknown): model is BoxApiModelId {
  return typeof model === 'string' && (BOX_API_MODEL_IDS as readonly string[]).includes(model)
}

/** Exact id the Box CLI runs for one of the listed models. */
export function isBoxApiUpstreamModel(model: unknown): model is BoxApiUpstreamModelId {
  return typeof model === 'string' && (BOX_API_UPSTREAM_MODEL_IDS as readonly string[]).includes(model)
}

export function boxApiModelById(model: unknown): (typeof BOX_API_MODELS)[number] | undefined {
  return BOX_API_MODELS.find((m) => m.id === model)
}

/** Table row for a body that names either the canonical or the upstream id. */
export function boxApiModelByEitherId(model: unknown): (typeof BOX_API_MODELS)[number] | undefined {
  return BOX_API_MODELS.find((m) => m.id === model || m.upstreamModel === model)
}

export function boxApiUpstreamModelFor(model: unknown): BoxApiUpstreamModelId | undefined {
  return boxApiModelById(model)?.upstreamModel
}

/** True only for a listed canonical id together with its own upstream id. */
export function isBoxApiModelPair(model: unknown, upstreamModel: unknown): boolean {
  const row = boxApiModelById(model)
  return row !== undefined && row.upstreamModel === upstreamModel
}
