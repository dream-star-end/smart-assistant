import { type ResizableWidth, useResizableWidth } from "./useResizableWidth";

export const SIDEBAR_WIDTH_DEFAULT = 268;
export const SIDEBAR_WIDTH_MIN = 220;
export const SIDEBAR_WIDTH_MAX = 460;
export const SIDEBAR_WIDTH_STORAGE_KEY = "oc_v5_sidebar_width";
/** 键盘调宽步长（← / →）；按住 Shift 走大步。 */
export const SIDEBAR_WIDTH_KEY_STEP = 16;
export const SIDEBAR_WIDTH_KEY_STEP_LARGE = 64;

const SIDEBAR_WIDTH_OPTIONS = {
  storageKey: SIDEBAR_WIDTH_STORAGE_KEY,
  defaultWidth: SIDEBAR_WIDTH_DEFAULT,
  min: SIDEBAR_WIDTH_MIN,
  max: SIDEBAR_WIDTH_MAX,
  edge: "right",
  keyStep: SIDEBAR_WIDTH_KEY_STEP,
  keyStepLarge: SIDEBAR_WIDTH_KEY_STEP_LARGE,
} as const;

/**
 * 侧栏宽度：Pointer Events 拖拽 + 键盘（← → 步进，Home/End 最小/最大，Shift 大步）+ localStorage 持久化。
 * 窄屏是否采用返回值由调用方决定。实现与详情面板共用 useResizableWidth。
 */
export function useSidebarWidth(): ResizableWidth {
  return useResizableWidth(SIDEBAR_WIDTH_OPTIONS);
}
