// The director model (plan, interpret, visual QA). Default stays grok-build.
// The id is checked again at run time against the user's model permission.

export const DIRECTOR_MODEL_DEFAULT = 'grok-build'

const MODEL_RE = /^[A-Za-z0-9._:-]{1,64}$/

export function directorModelOf(settings: { directorModel?: unknown } | null | undefined): string {
  const v = typeof settings?.directorModel === 'string' ? settings.directorModel.trim() : ''
  return MODEL_RE.test(v) ? v : DIRECTOR_MODEL_DEFAULT
}
