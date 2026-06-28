export type Plan = {
  id: string;
  name: string;
  price: number; // 元 / 月
  credits: number; // 每月积分
  tagline: string;
  features: string[];
  highlight?: boolean;
  cta: string;
};

export const PLANS: Plan[] = [
  {
    id: "free",
    name: "体验版",
    price: 0,
    credits: 300,
    tagline: "免费开始，先用起来",
    cta: "免费开始",
    features: ["每月 300 积分", "全能助手 + 市场技能", "标准响应速度", "对话历史云端保存"],
  },
  {
    id: "basic",
    name: "基础版",
    price: 39,
    credits: 8000,
    tagline: "日常高频使用",
    cta: "选择基础版",
    features: ["每月 8,000 积分", "全能助手 + 市场技能与智能体", "标准响应速度", "对话历史无限保存", "文件上传"],
  },
  {
    id: "pro",
    name: "专业版",
    price: 99,
    credits: 30000,
    tagline: "重度使用 · 最受欢迎",
    cta: "选择专业版",
    highlight: true,
    features: [
      "每月 30,000 积分",
      "全能助手 + 市场技能与智能体",
      "优先响应速度",
      "更长上下文记忆",
      "文件 / 联网增强",
      "优先体验新智能体",
    ],
  },
  {
    id: "ultra",
    name: "旗舰版",
    price: 299,
    credits: 120000,
    tagline: "团队与专业工作流",
    cta: "选择旗舰版",
    features: [
      "每月 120,000 积分",
      "全能助手 + 市场技能与智能体",
      "最高优先级算力",
      "超长上下文",
      "专属客服支持",
      "积分当月不限速使用",
    ],
  },
];

/** 年付立享 8 折 */
export const ANNUAL_DISCOUNT = 0.8;
