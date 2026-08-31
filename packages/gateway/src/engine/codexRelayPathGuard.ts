/**
 * Codex app-server MCP (rmcp) 把 chatgpt_base_url 指到容器 loopback relay 后,
 * 不在 allowlist 的 HTTP MCP/遥测路径会被 master 打回 PATH_NOT_ALLOWED。
 * rmcp worker 退出再重连,stderr 一直刷,若把这些行当成 lastActivityAt,
 * idle timeout 永不触发,taskboard 就会空转撞 50min 租约墙。
 *
 * 本模块只做识别 + 阈值,不负责杀进程。
 */

export const CODEX_RELAY_PATH_DENIED_CODE = 'PATH_NOT_ALLOWED'
export const CODEX_RELAY_PATH_DENIED_MESSAGE = 'codex relay path not allowed'
/** 连续拒绝几次后中止当前 turn,避免空转耗租约。 */
export const CODEX_RELAY_PATH_DENIED_ABORT_AFTER = 3

export function isCodexRelayPathDeniedLine(line: string): boolean {
  if (!line) return false
  return (
    line.includes(CODEX_RELAY_PATH_DENIED_CODE) &&
    line.includes(CODEX_RELAY_PATH_DENIED_MESSAGE)
  )
}

export function shouldAbortOnRelayPathDenied(consecutiveDenied: number): boolean {
  return consecutiveDenied >= CODEX_RELAY_PATH_DENIED_ABORT_AFTER
}
