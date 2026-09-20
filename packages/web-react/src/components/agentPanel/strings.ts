/**
 * 「Agent 电脑」面板全部可见文案（DESIGN_MANUS_A §13 T-01…T-42）。
 * 面板名改选时只改 PANEL_NAME 一处；其余模板围绕它拼接。
 */
export const PANEL_NAME = "Agent 电脑"; // T-01

export const AGENT_PANEL_STRINGS = {
  panelName: PANEL_NAME, // T-01
  live: "实时", // T-02
  pinned: "已固定", // T-03
  backToLatest: "回到最新", // T-04
  collapse: "折叠面板", // T-05
  close: `关闭 ${PANEL_NAME}`, // T-06
  prev: "上一步", // T-10
  next: "下一步", // T-11
  progressToggle: "进度列表", // C 栏折叠钮可访问名（aria-expanded 表示状态）
  openPreview: "打开预览", // T-20
  copyLink: "复制链接", // T-21
  copyLinkHint: "复制容器内地址（仅本机容器可访问）", // T-22
  kinds: {
    terminal: "终端", // T-30
    file: "文件", // T-31
    web: "网页", // T-32
    search: "搜索", // T-33
    other: "其他", // T-34
  },
  tabProcess: "过程", // T-40
  tabFiles: "文件", // T-41
  tabsLabel: `${PANEL_NAME}页签`, // T-42
  running: "运行中", // 沿用 tool/status 文案
} as const;

export type ActionKindKey = keyof typeof AGENT_PANEL_STRINGS.kinds;

/** T-07 rail aria-label：「展开 Agent 电脑：终端 · 步骤 4/7 · 运行中」 */
export function railLabel(kind: string, k: number, n: number, status: string): string {
  const step = n > 0 && k > 0 ? ` · ${stepLabel(k, n)}` : "";
  return `展开 ${PANEL_NAME}：${kind}${step} · ${status}`;
}

/** T-08 窄屏 chip：「Agent 电脑 · 终端 · 4/7」 */
export function chipLabel(kind: string, k: number, n: number): string {
  return n > 0 && k > 0 ? `${PANEL_NAME} · ${kind} · ${k}/${n}` : `${PANEL_NAME} · ${kind}`;
}

/** T-09 aria-live：「已切换到步骤 4/7：终端」 */
export function liveAnnounce(k: number, n: number, label: string): string {
  return n > 0 && k > 0 ? `已切换到步骤 ${k}/${n}：${label}` : `已切换到：${label}`;
}

/** T-12 步进计数：「步骤 4/7」 */
export function stepLabel(k: number, n: number): string {
  return `步骤 ${k}/${n}`;
}

/** T-13 面板进度行：「进度 3/7 · 正在构建静态站」 */
export function progressLabel(c: number, n: number, step: string): string {
  return step ? `进度 ${c}/${n} · ${step}` : `进度 ${c}/${n}`;
}
