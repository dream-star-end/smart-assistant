/**
 * Engine-specific tool naming hints used by TOOLS prompt slots.
 * Lives in `gateway-engines` so provider branching stays inside the engine
 * adapter boundary instead of leaking into `promptSlots.ts` (R3-special-case).
 */
export interface EngineToolsPromptDialect {
  readonly webSearchTools: string
  readonly fileRecoveryHint: string
}

const DEFAULT_TOOLS_PROMPT_DIALECT: EngineToolsPromptDialect = {
  webSearchTools: '`WebSearch` / `WebFetch` / Bash `oc-web extract <url>`',
  fileRecoveryHint: 'Read/Edit 失败先重新 Read 或 Glob 拿最新内容再试',
}

const ANTIGRAVITY_TOOLS_PROMPT_DIALECT: EngineToolsPromptDialect = {
  webSearchTools: '`search_web` / Bash `oc-web extract <url>`',
  fileRecoveryHint: '`read_file`/`edit_file` 失败先重新 `read_file` 或 `oc_glob` 拿最新内容再试',
}

export function resolveEngineToolsPromptDialect(
  provider: string | undefined,
): EngineToolsPromptDialect {
  if (provider === 'antigravity') return ANTIGRAVITY_TOOLS_PROMPT_DIALECT
  return DEFAULT_TOOLS_PROMPT_DIALECT
}
