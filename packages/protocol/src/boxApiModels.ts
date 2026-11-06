/**
 * Models of the Box model route (engine ccb, provider box_cli). The agent and
 * its tools stay in the user container; egress runs one tool-less Claude Code
 * in the account's Box per model request. `runner` says how that Box process
 * runs: `print` is `claude -p`; `interactive` is the same argv and stdio
 * contract served by an interactive Claude Code in tmux (box-bridge-mod
 * host.py, print mode), which may run under any enabled login of the Box.
 *
 * `upstreamModel` is the id passed to the Box CLI as `--model`, and also the
 * exact `message.model` the CLI then reports: the stream decoders compare the
 * two byte for byte. Haiku carries its dated id for that reason. The CLI
 * accepts the alias claude-haiku-4-5 but reports claude-haiku-4-5-20251001.
 * Haiku 5.5 has a fixed id with no date suffix, and the CLI (2.1.294) reports
 * claude-haiku-5-5 as passed.
 * `maxOutputTokens` is the model's output cap. `supportsEffort` says whether a
 * request may carry thinking / output_config (mapped to the CLI's `--effort`).
 * Two rows may run the same upstream model on different runners; they then
 * agree on every attribute a lookup by upstream id reads (cap, effort). The
 * runner is read by canonical id only.
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
  readonly runner: BoxApiRunner
}

export type BoxApiRunner = 'print' | 'interactive'

export const BOX_API_MODELS = [
  { id: 'box-api-claude-opus-5-5', upstreamModel: 'claude-opus-5-5', maxOutputTokens: 128_000, supportsEffort: true, runner: 'print' },
  { id: 'box-api-claude-sonnet-5-5', upstreamModel: 'claude-sonnet-5-5', maxOutputTokens: 128_000, supportsEffort: true, runner: 'print' },
  { id: 'box-api-claude-haiku-4-5', upstreamModel: 'claude-haiku-4-5-20251001', maxOutputTokens: 64_000, supportsEffort: false, runner: 'print' },
  { id: 'box-api-claude-haiku-5-5', upstreamModel: 'claude-haiku-5-5', maxOutputTokens: 128_000, supportsEffort: true, runner: 'print' },
  // OCV5-378: the personal edition's Box Claude models (operator rule: Box logins serve product
  // turns only interactively). Same route and contract as box-api-*: the container is the agent.
  { id: 'box-claude-opus-5-5', upstreamModel: 'claude-opus-5-5', maxOutputTokens: 128_000, supportsEffort: true, runner: 'interactive' },
  { id: 'box-claude-sonnet-5', upstreamModel: 'claude-sonnet-5', maxOutputTokens: 128_000, supportsEffort: true, runner: 'interactive' },
  { id: 'box-claude-haiku-5-5', upstreamModel: 'claude-haiku-5-5', maxOutputTokens: 128_000, supportsEffort: true, runner: 'interactive' },
] as const satisfies readonly BoxApiModel[]

export type BoxApiModelId = (typeof BOX_API_MODELS)[number]['id']
export type BoxApiUpstreamModelId = (typeof BOX_API_MODELS)[number]['upstreamModel']

export const BOX_API_MODEL_IDS: readonly BoxApiModelId[] = BOX_API_MODELS.map((m) => m.id)
export const BOX_API_UPSTREAM_MODEL_IDS: readonly BoxApiUpstreamModelId[] =
  [...new Set(BOX_API_MODELS.map((m) => m.upstreamModel))]

// The ids are also written into SQL lists and into the CLI argv.
for (const m of BOX_API_MODELS) {
  if (!/^box-(?:api-)?claude-[a-z0-9-]{3,48}$/.test(m.id) || !/^claude-[a-z0-9-]{3,64}$/.test(m.upstreamModel)
    || m.id.startsWith('box-api-') !== (m.runner === 'print')) {
    throw new Error(`BOX_API_MODELS entry has an invalid id: ${m.id}`)
  }
  for (const n of BOX_API_MODELS) {
    if (n.upstreamModel === m.upstreamModel
      && (n.maxOutputTokens !== m.maxOutputTokens || n.supportsEffort !== m.supportsEffort)) {
      throw new Error(`BOX_API_MODELS rows sharing ${m.upstreamModel} disagree`)
    }
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

/** How the Box runs a listed canonical model; undefined for anything else. */
export function boxApiRunnerFor(model: unknown): BoxApiRunner | undefined {
  return boxApiModelById(model)?.runner
}

/** True only for a listed canonical id together with its own upstream id. */
export function isBoxApiModelPair(model: unknown, upstreamModel: unknown): boolean {
  const row = boxApiModelById(model)
  return row !== undefined && row.upstreamModel === upstreamModel
}
