/**
 * 团队模式(v5 轻量组队)开关的**会话级**持久化。
 *
 * 权威语义:
 *  - 每个会话有独立的开关记忆,键 `oc_v5_team_mode:<sessionId>`,存显式 `"1"`/`"0"`
 *    (关掉的会话必须落地 `"0"`,不能删键 —— 否则读取会回退到全局默认,被别处会话的
 *    开关翻动,破坏「A 会话关掉不影响其它会话」的语义)。
 *  - 全局键 `oc_v5_team_mode` 是「用户偏好默认值」:镜像用户最近一次选择,供**新会话**
 *    继承(老用户习惯不变:上次开着 → 新会话默认开着)。会话一旦有了自己的 per-session
 *    键,即以 per-session 为准,不再受全局默认或其它会话开关影响。
 *  - sessionId 为空(空会话态):只读/只写全局默认;首条消息创建会话后由 App 把当前
 *    intent 落地为该会话的 per-session 键。
 *
 * 后端零改动:teamMode 本就是 turn 级帧字段,本模块只管前端持久化与继承规则。
 * localStorage 键数量与会话数同阶(可接受);会话删除时 App 调 clearTeamModeForSession 清键。
 */
export const TEAM_MODE_GLOBAL_KEY = "oc_v5_team_mode";

/** 某会话的 per-session 键名。 */
export function teamModeSessionKey(sessionId: string): string {
  return `${TEAM_MODE_GLOBAL_KEY}:${sessionId}`;
}

/**
 * 读某会话的团队模式:per-session 键优先(显式 `"1"`/`"0"`),缺失才回退全局偏好默认值。
 * sessionId 为空 → 只看全局默认。localStorage 不可用时保守回退 false。
 */
export function readTeamModeForSession(sessionId: string | undefined): boolean {
  try {
    if (sessionId) {
      const v = localStorage.getItem(teamModeSessionKey(sessionId));
      if (v !== null) return v === "1";
    }
    return localStorage.getItem(TEAM_MODE_GLOBAL_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * 写团队模式:落地 per-session 键(显式 `"1"`/`"0"`,仅当有 sessionId)+ 更新全局偏好
 * 默认值(镜像最近一次选择,供新会话继承)。best-effort,失败不抛(保持内存开关响应)。
 */
export function writeTeamMode(sessionId: string | undefined, enabled: boolean): void {
  try {
    if (sessionId) localStorage.setItem(teamModeSessionKey(sessionId), enabled ? "1" : "0");
    // 全局默认值始终镜像用户最近一次选择(与旧的设备级单键行为一致:开=写 "1",关=删键)。
    if (enabled) localStorage.setItem(TEAM_MODE_GLOBAL_KEY, "1");
    else localStorage.removeItem(TEAM_MODE_GLOBAL_KEY);
  } catch {
    // Storage 只是最佳努力;写失败不影响内存开关。
  }
}

/** 删除某会话的 per-session 键(会话删除时顺手清,避免键无限堆积)。best-effort。 */
export function clearTeamModeForSession(sessionId: string): void {
  try {
    localStorage.removeItem(teamModeSessionKey(sessionId));
  } catch {
    // best-effort
  }
}
