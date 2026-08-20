/** 会话超过此条数（拍平后的 items）才窗口化渲染。测试可经 props 覆盖。 */
export const VIRTUALIZE_THRESHOLD = 120;

/** 会话行固定高度（含触控 ≥44px）。无摘要时用此值。 */
export const SESSION_ROW_HEIGHT = 44;

/** 统一开启摘要行后的会话行高。虚拟滚动要求同一列表内行高一致。 */
export const SESSION_ROW_HEIGHT_PREVIEW = 62;

export const GROUP_HEADER_HEIGHT = 32;
export const PROJECT_ROW_HEIGHT = 44;
export const HINT_ROW_HEIGHT = 36;
export const SEARCH_HIT_HEIGHT = 62;

export const SESSION_DRAG_TYPE = "application/x-openclaude-session-id";
export const PROJECT_DRAG_TYPE = "application/x-openclaude-project-id";

export const PAGE_SIZE = 50;
export const SEARCH_DEBOUNCE_MS = 250;
