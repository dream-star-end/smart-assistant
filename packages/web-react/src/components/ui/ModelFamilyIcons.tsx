import type { JSX } from "react";
import { type IconSpec, RenderIconSpec } from "./AtelierIcons";

export type ModelFamilyKind =
  | "claude"
  | "gemini"
  | "gpt"
  | "orchestrator"
  | "grok"
  | "deepseek"
  | "kimi"
  | "qwen"
  | "glm"
  | "minimax"
  | "default";

const FAMILY_RULES: ReadonlyArray<readonly [ModelFamilyKind, RegExp]> = [
  ["orchestrator", /(?:orchestrat|swarm|coordinat|router|multi[-_ ]?model|智能编排|自动调度|蜂群|协同)|\bauto\b/i],
  ["claude", /claude|anthropic|opus|sonnet|haiku/i],
  ["gemini", /gemini|google|gemma/i],
  ["gpt", /\bgpt\b|gpt-|openai|chatgpt|\bo[134](?:-mini|-pro|-preview)?\b|codex/i],
  ["grok", /grok|\bxai\b|x-ai/i],
  ["deepseek", /deepseek|\bds[-_ ]?[vr]\d/i],
  ["kimi", /kimi|moonshot/i],
  ["qwen", /qwen|qwq|tongyi|千问|通义/i],
  ["glm", /\bglm\b|glm-|chatglm|zhipu|智谱/i],
  ["minimax", /minimax|abab/i],
];

export function detectModelFamily(idOrLabel: string): ModelFamilyKind {
  const s = idOrLabel.trim();
  if (!s) return "default";
  for (const [family, pattern] of FAMILY_RULES) {
    if (pattern.test(s)) return family;
  }
  return "default";
}

const FAMILY_SPECS: Record<ModelFamilyKind, IconSpec> = {
  claude: {
    c: [[12, 12, 7.6, 1], [12, 12, 1.5]],
    s: "M12 3.2v5M12 15.8v5M3.2 12h5M15.8 12h5M5.8 5.8l3.5 3.5M14.7 14.7l3.5 3.5M18.2 5.8l-3.5 3.5M9.3 14.7l-3.5 3.5",
  },
  gemini: {
    o: [["M10.2 5.8C10.9 10 13.2 12.3 17.4 13C13.2 13.7 10.9 16 10.2 20.2C9.5 16 7.2 13.7 3 13C7.2 12.3 9.5 10 10.2 5.8Z", 0.22]],
    f: [["M18.2 3.2C18.5 4.8 19.2 5.5 20.8 5.8C19.2 6.1 18.5 6.8 18.2 8.4C17.9 6.8 17.2 6.1 15.6 5.8C17.2 5.5 17.9 4.8 18.2 3.2Z", 1]],
  },
  gpt: {
    o: [["M12 3.5c2.2 0 4 1.6 4.2 3.8 1.9.8 3.2 2.7 3.2 4.9 0 2.1-1.2 4-3 4.9-.5 2.1-2.3 3.6-4.4 3.6s-3.9-1.5-4.4-3.6c-1.8-.9-3-2.8-3-4.9 0-2.2 1.3-4.1 3.2-4.9C8 5.1 9.8 3.5 12 3.5Z", 0.14]],
    s: "M12 8.3l3.3 1.9v3.8L12 15.9 8.7 14v-3.8ZM12 3.8v4.5M18.6 10.2l-3.3 1.9M15.3 14l2.5 3.4M12 20.2v-4.3M5.4 13.8l3.3-1.9M8.7 10.2L6.2 6.8",
  },
  orchestrator: {
    e: [[12, 12, 9, 4.3, -24, 0.14]],
    so: "M7.2 6.3a8.2 8.2 0 0 1 9.6 0M16.8 17.7a8.2 8.2 0 0 1-9.6 0",
    c: [[12, 12, 2.6, 2], [12, 12, 1.15], [19.6, 8.6, 1.45], [4.4, 15.4, 1.45], [11.2, 4.4, 1.3]],
  },
  grok: {
    c: [[12, 12, 7.5, 1], [12, 12, 1.7]],
    s: "M17.2 6.8a7.4 7.4 0 1 0 1.9 7.4M5.4 18.6L19.2 4.8",
  },
  deepseek: {
    o: [["M12 3.2L19.6 9.5 12 20.8 4.4 9.5Z", 0.16]],
    s: "M4.4 9.5h15.2M12 3.2 8.8 9.5 12 20.8l3.2-11.3Z",
  },
  kimi: {
    o: [["M16.8 15.2A7.2 7.2 0 0 1 8.8 7.2a7.2 7.2 0 1 0 8 8Z", 0.18]],
    f: [["M17.5 4.2l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7Z", 1]],
  },
  qwen: {
    o: [
      ["M12 3.2l7.2 4.2v9.2L12 20.8l-7.2-4.2V7.4Z", 0.15],
      ["M12 7.2c.5 2.7 1.9 4.1 4.6 4.8-2.7.7-4.1 2.1-4.6 4.8-.5-2.7-1.9-4.1-4.6-4.8 2.7-.7 4.1-2.1 4.6-4.8Z", 0.22],
    ],
  },
  glm: {
    r: [[6.2, 6.2, 11.6, 11.6, 2.6, 0.15, 45], [8.8, 8.8, 6.4, 6.4, 1.4, 0.2]],
    c: [[12, 12, 1.15]],
  },
  minimax: {
    r: [[3.5, 4.5, 17, 15, 5.5, 0.14]],
    s: "M7.2 14.6v-3.8a2.3 2.3 0 0 1 4.6 0v3.8M11.8 11.4a2.5 2.5 0 0 1 5-.2v3.4",
  },
  default: {
    o: [["M12 3.5l7.5 4.8v7.4L12 20.5l-7.5-4.8V8.3Z", 0.15]],
    s: "M12 3.5v17M4.5 8.3L12 12l7.5-3.7",
    c: [[12, 12, 1.4]],
  },
};

export function ModelFamilyIcon({
  model,
  family,
  size = 16,
  className,
}: {
  model?: string;
  family?: ModelFamilyKind;
  size?: number;
  className?: string;
}): JSX.Element {
  return <RenderIconSpec spec={FAMILY_SPECS[family ?? detectModelFamily(model ?? "")]} size={size} className={className} />;
}
