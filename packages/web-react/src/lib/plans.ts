/**
 * 营销展示用的套餐/加量包数据（落地页 Pricing 区唯一权威源）。
 *
 * 重要语义边界：v5 计费后端是「按量计费（per-turn）+ 积分余额 + 充值加量包」
 * （/api/payment/plans，TopupDialog 消费）。下面的「包月套餐」是**落地页营销展示**，
 * 价格/月度积分以产品定档为准；落地页 CTA 统一引导到注册（onStart），不在此处接真实
 * 订阅下单——真实进账走 App 内的充值加量包流程，避免落地页与后端权威源出现第二套并行机制。
 *
 * 数字若需调整，只改本文件这一处，落地页与任何展示位都读它。
 */
export type Plan = {
  id: string;
  name: string;
  /** 元 / 月（0 = 免费）。 */
  price: number;
  /** 每月可用积分。 */
  credits: number;
  tagline: string;
  features: string[];
  highlight?: boolean;
  cta: string;
};

export const PLANS: Plan[] = [
  {
    id: "free",
    name: "免费版",
    price: 0,
    credits: 300,
    tagline: "零门槛，先用起来",
    cta: "免费开始",
    features: [
      "每月 300 积分",
      "全能助手开箱即用",
      "AI 市场技能 / 智能体随用随装",
      "长期记忆，越用越懂你",
      "对话历史云端保存",
    ],
  },
  {
    id: "pro",
    name: "Pro",
    price: 88,
    credits: 10000,
    tagline: "日常高频，主力之选",
    cta: "选择 Pro",
    features: [
      "每月 10,000 积分",
      "免费版全部能力",
      "标准响应速度",
      "文件 / 图片上传识别",
      "联网搜索 · 定时任务",
    ],
  },
  {
    id: "max",
    name: "Max",
    price: 298,
    credits: 35000,
    tagline: "重度使用 · 最受欢迎",
    cta: "选择 Max",
    highlight: true,
    features: [
      "每月 35,000 积分",
      "Pro 全部能力",
      "优先响应速度",
      "更长上下文记忆",
      "GitHub 仓库直连",
      "优先体验新模型与新智能体",
    ],
  },
  {
    id: "ultra",
    name: "Ultra",
    price: 498,
    credits: 60000,
    tagline: "专业工作流 · 算力拉满",
    cta: "选择 Ultra",
    features: [
      "每月 60,000 积分",
      "Max 全部能力",
      "最高优先级算力",
      "超长上下文",
      "专属客服支持",
    ],
  },
];

/**
 * 积分加量包：套餐用量不够时按需购买，仅在**当前套餐有效期内**可用（不跨期结转）。
 * 与包月套餐解耦——可在任意付费档叠加。
 */
export const TOPUP_PACK = {
  price: 50,
  credits: 5000,
  note: "套餐有效期内可用，用完即止，不跨期结转",
} as const;
