/**
 * OCV5-551: Personal-edition (selfhost) Box ChatGPT Web Pro model registry (L0).
 *
 * `gpt-6-astra-pro` is exclusively available on the ChatGPT Web UI (`chatgpt.com`)
 * under a logged-in ChatGPT Pro session. The personal edition drives a persistent
 * real Google Chrome profile inside the Box (`/home/box/.chatgpt-pro-<profile>`)
 * over the Box interactive execution channel (`cursorBoxCcExec` + `box-gpt-web-mod`).
 *
 * Pure L0 definitions: zero I/O, zero external imports.
 */

export type BoxGptWebThinkingMode = 'instant' | 'standard' | 'extended' | 'extra_high' | 'pro'

export interface BoxGptWebModel {
  readonly id: string
  readonly displayName: string
  readonly upstreamModel: string
  readonly thinkingMode: BoxGptWebThinkingMode
  readonly contextWindow: number
  readonly maxOutputTokens: number
  readonly supportsVision: boolean
  readonly runner: 'chatgpt-web-pro'
}

export const BOX_GPT_WEB_MODELS = [
  {
    id: 'box-gpt-6-astra-pro',
    displayName: 'GPT-6 Astra Pro (Web)',
    upstreamModel: 'gpt-6-astra-pro',
    thinkingMode: 'pro',
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    supportsVision: true,
    runner: 'chatgpt-web-pro',
  },
] as const satisfies readonly BoxGptWebModel[]

export type BoxGptWebModelId = (typeof BOX_GPT_WEB_MODELS)[number]['id']
export type BoxGptWebUpstreamModelId = (typeof BOX_GPT_WEB_MODELS)[number]['upstreamModel']

export const BOX_GPT_WEB_MODEL_IDS: readonly BoxGptWebModelId[] = BOX_GPT_WEB_MODELS.map(
  (m) => m.id,
)

export const BOX_GPT_WEB_DISPLAY_DEFAULT = ':1'
export const BOX_GPT_WEB_FALLBACK_DISPLAY = ':99'
export const BOX_GPT_WEB_CDP_PORT_DEFAULT = 9229
export const BOX_GPT_WEB_LOCAL_PROXY_DEFAULT = 'socks5://127.0.0.1:18992'
export const BOX_GPT_WEB_FORBIDDEN_PROXY_PORTS: readonly number[] = [18991, 19095]

export function isBoxGptWebModel(model: unknown): model is BoxGptWebModelId {
  return typeof model === 'string' && (BOX_GPT_WEB_MODEL_IDS as readonly string[]).includes(model)
}

export function boxGptWebModelById(model: unknown): BoxGptWebModel | undefined {
  return typeof model === 'string' ? BOX_GPT_WEB_MODELS.find((m) => m.id === model) : undefined
}

/**
 * Selfhost catalog stage plan (plan-only constant for operator execution after
 * manual Box desktop login; never executed automatically).
 */
export const BOX_GPT_WEB_CATALOG_SQL_PLAN = `
-- OCV5-551: Stage box-gpt-6-astra-pro in selfhost model_catalog (plan only; do not run until Box Chrome login is verified)
INSERT INTO model_catalog (
  model_id, display_name, engine, provider_id, upstream_model_id, state, context_window, capability_profile
) VALUES (
  'box-gpt-6-astra-pro',
  'GPT-6 Astra Pro (Web)',
  'cursor',
  'cursor',
  'gpt-6-astra-pro',
  'staged',
  400000,
  '{"supports_vision":true,"supports_thinking":true,"box_runner":"chatgpt-web-pro"}'::jsonb
) ON CONFLICT (model_id) DO NOTHING;
`.trim()
