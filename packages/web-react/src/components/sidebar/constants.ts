/** 会话超过此条数（拍平后的 items）才窗口化渲染。测试可经 props 覆盖。 */
export const VIRTUALIZE_THRESHOLD = 120;

/** 会话行固定为单行（含触控 ≥44px）。 */
export const SESSION_ROW_HEIGHT = 44;

export const GROUP_HEADER_HEIGHT = 32;
export const PROJECT_ROW_HEIGHT = 44;
export const HINT_ROW_HEIGHT = 36;
export const SEARCH_HIT_HEIGHT = 62;

export const SESSION_DRAG_TYPE = "application/x-openclaude-session-id";
export const PROJECT_DRAG_TYPE = "application/x-openclaude-project-id";

export const PAGE_SIZE = 50;
export const SEARCH_DEBOUNCE_MS = 250;

/** 前端虚拟分组：无 projectId 的会话归入此组。不写入数据库。 */
export const DEFAULT_PROJECT_ID = "__oc_virtual_default__";
export const DEFAULT_PROJECT_NAME = "未分类";

/** 运行中会话的累计用时刷新间隔。不要每秒重渲整个列表。 */
export const SIDEBAR_DURATION_TICK_MS = 30_000;
