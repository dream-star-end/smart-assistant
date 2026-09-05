/**
 * OC_RESEARCH_WORKSPACE — R3.0 课题工作区灰度开关。
 * 对齐 OC_PROJECT_CONTEXT(storage/projectContext.ts):env 真值才开;
 * 还须 research_config.enabled,由调用方(proxy/handlers)组合判定。
 * 默认关:关时新路由 404、可选 projectId 忽略、CLI 旧用法字节不变。
 */
export const RESEARCH_WORKSPACE_FLAG = 'OC_RESEARCH_WORKSPACE'

export function isResearchWorkspaceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env[RESEARCH_WORKSPACE_FLAG] ?? '').trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}

/** GET /api/me/research/library?projectId= — flag 关时忽略参数。 */
export function libraryListProjectIdFromUrl(
  url: string | undefined,
  workspaceEnabled: boolean,
): string | undefined {
  if (!workspaceEnabled) return undefined
  try {
    const id = new URL(url ?? '/', 'http://x').searchParams.get('projectId')?.trim()
    return id || undefined
  } catch {
    return undefined
  }
}
