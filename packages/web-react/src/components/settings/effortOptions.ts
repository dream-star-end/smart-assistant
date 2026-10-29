// 推理强度选项。单独成模块：首屏的 ModelSelector 只需要它，不能把整个 labels.ts
// (计费/流水文案，只在按需加载的设置中心用)拉进首屏闭包(2026-10-30 首屏预算)。
/** 思考深度档位（preferences.default_effort 枚举；具体模型支持集由 API 决定）。 */
export const EFFORT_OPTIONS: {
  value: "low" | "medium" | "high" | "xhigh" | "max";
  label: string;
}[] = [
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
  { value: "xhigh", label: "很高" },
  { value: "max", label: "最高" },
];
