/**
 * GPT image model policy for the codex relay (OCV5-587).
 *
 * The relay used to hard-code `gpt-image-2`. OpenAI shipped GPT Image 2.5
 * (`gpt-image-2.5-flare` / `gpt-image-2.5-sunburst`); once Codex starts sending
 * one of those, a hard-coded relay would 400 every native image request. The
 * allowlist is now env-driven, defaulting to exactly today's behaviour.
 *
 *   OC_IMAGE2_ALLOWED_MODELS  comma list, default `gpt-image-2`
 *   OC_IMAGE2_EDIT_MODEL      model for annotated/outpaint edits, default `gpt-image-2`
 *
 * Only `gpt-image-*` ids are accepted, so a typo can never open the relay to an
 * arbitrary model. Billing stays a flat IMAGE2_UNIT_COST per image whatever the
 * model (user decision D6, 2026-10-23).
 */

export const DEFAULT_IMAGE_MODEL = 'gpt-image-2'
export const IMAGE_MODEL_RE = /^gpt-image-[0-9][0-9a-z.-]{0,40}$/

export interface ImageModelPolicy {
  allowed: ReadonlySet<string>
  editDefault: string
}

export function parseImageModelPolicy(
  env: NodeJS.ProcessEnv = process.env,
  warn: (msg: string) => void = () => {},
): ImageModelPolicy {
  const raw = env.OC_IMAGE2_ALLOWED_MODELS?.trim()
  const allowed = new Set<string>()
  if (raw) {
    for (const item of raw.split(',')) {
      const model = item.trim()
      if (!model) continue
      if (IMAGE_MODEL_RE.test(model)) allowed.add(model)
      else
        warn(
          `OC_IMAGE2_ALLOWED_MODELS: ignoring invalid model id ${JSON.stringify(model.slice(0, 64))}`,
        )
    }
  }
  if (allowed.size === 0) {
    if (raw) warn('OC_IMAGE2_ALLOWED_MODELS has no valid entries; falling back to gpt-image-2')
    allowed.add(DEFAULT_IMAGE_MODEL)
  }
  const fallbackEdit = allowed.has(DEFAULT_IMAGE_MODEL) ? DEFAULT_IMAGE_MODEL : [...allowed][0]!
  const editRaw = env.OC_IMAGE2_EDIT_MODEL?.trim()
  let editDefault = fallbackEdit
  if (editRaw) {
    if (allowed.has(editRaw)) editDefault = editRaw
    else
      warn(
        `OC_IMAGE2_EDIT_MODEL ${JSON.stringify(editRaw.slice(0, 64))} is not in the allowlist; using ${fallbackEdit}`,
      )
  }
  return { allowed, editDefault }
}
