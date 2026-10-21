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
    displayName: 'GPT-6-Astra-Pro',
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

/**
 * Exclusive owner user_id for personal-edition `box-gpt-6-astra-pro`.
 * Both catalog visibility and server-side execution enforce `user_id === 3`.
 */
export const BOX_GPT_WEB_OWNER_UID = 3
export const BOX_GPT_WEB_OWNER_UID_STR = '3'

/**
 * Global concurrency limit for `box-gpt-6-astra-pro` (single real Chrome tab on Box).
 */
export const BOX_GPT_WEB_MAX_CONCURRENCY = 1
export const BOX_GPT_WEB_BUSY_CODE = 'BOX_GPT_WEB_BUSY'
export const BOX_GPT_WEB_BUSY_MESSAGE =
  'Pro 通道忙：当前已有 gpt-6-astra-pro 对话正在执行，一次只能运行一个 Pro 对话，请等待当前对话完成后再试。'

export function isBoxGptWebModel(model: unknown): model is BoxGptWebModelId {
  return typeof model === 'string' && (BOX_GPT_WEB_MODEL_IDS as readonly string[]).includes(model)
}

export function boxGptWebModelById(model: unknown): BoxGptWebModel | undefined {
  return typeof model === 'string' ? BOX_GPT_WEB_MODELS.find((m) => m.id === model) : undefined
}

export function isBoxGptWebOwnerUid(uid: string | number | bigint | null | undefined): boolean {
  if (uid === BOX_GPT_WEB_OWNER_UID || uid === 3n) return true
  if (typeof uid === 'string') {
    return uid.trim() === BOX_GPT_WEB_OWNER_UID_STR
  }
  return false
}

/**
 * Selfhost catalog stage plan (reference SQL matching migration 0314).
 */
export const BOX_GPT_WEB_CATALOG_SQL_PLAN = `
-- OCV5-551: Stage box-gpt-6-astra-pro in selfhost model_catalog (exclusive to user_id=3)
INSERT INTO model_catalog (
  model_id, display_name, engine, provider_id, upstream_model_id, state, context_window, capability_profile
) VALUES (
  'box-gpt-6-astra-pro',
  'GPT-6-Astra-Pro',
  'cursor',
  'cursor',
  'gpt-6-astra-pro',
  'staged',
  400000,
  '{"supports_vision":true,"supports_thinking":true,"box_runner":"chatgpt-web-pro"}'::jsonb
) ON CONFLICT (model_id) DO NOTHING;
`.trim()
