/** 「Agent 电脑」面板折叠（rail）偏好，跨会话沿用（PRD F1.4；键名 ★2 定稿 d-2327）。 */
export const AGENT_PANEL_COLLAPSED_KEY = "oc_v5_agent_panel_collapsed";

export function readAgentPanelCollapsed(): boolean {
  try {
    return localStorage.getItem(AGENT_PANEL_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeAgentPanelCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(AGENT_PANEL_COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
    /* private mode / quota */
  }
}
