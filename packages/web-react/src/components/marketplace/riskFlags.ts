import type { MarketplaceRiskFlag } from "../../lib/types";

/**
 * 把后端静态扫描器(skillScanner)的 RiskFlag 翻译成用户能懂的中文提示。
 * 发布被拦截(block)时按类别给出可操作的修正建议;非 block 的命中作为温和提醒。
 */

const CATEGORY_LABEL: Record<string, string> = {
  secret: "疑似密钥/凭证",
  internal: "内部地址/令牌",
  injection: "疑似提示词注入",
  html: "内联脚本/HTML",
  obfuscation: "隐藏/不可见字符",
  metadata: "元数据格式问题",
  size: "内容过大",
  script: "脚本风险",
};

const CATEGORY_HINT: Record<string, string> = {
  secret: "请移除 API Key、token、私钥等敏感信息后重新发布。",
  internal: "请移除内网地址、内部域名或内部令牌。",
  injection: "请去掉「忽略以上指令」「对用户隐瞒」等可能操纵模型的措辞。",
  html: "请移除 <script>/<iframe> 等可执行标记。",
  obfuscation: "请移除零宽字符、双向控制符等不可见内容。",
  metadata: "名称/描述需为纯文本,不能含换行或 HTML。",
  size: "技能正文过大,请精简到 64KB 以内。",
  script: "脚本命中危险/可疑模式:毁灭性命令与远程管道执行会被直接拦截;可疑模式需说明用途,审核者会逐行查看。",
};

export type FriendlyFlag = {
  tone: "danger" | "warning";
  label: string;
  message: string;
  hint?: string;
  sample?: string;
};

export function friendlyRiskFlags(flags: MarketplaceRiskFlag[] | undefined): FriendlyFlag[] {
  if (!flags?.length) return [];
  // 同类只展示一次(取最严重的),避免刷屏。
  const byCategory = new Map<string, MarketplaceRiskFlag>();
  for (const f of flags) {
    const prev = byCategory.get(f.category);
    if (!prev || (f.block && !prev.block)) byCategory.set(f.category, f);
  }
  return [...byCategory.values()].map((f) => ({
    tone: f.block ? "danger" : "warning",
    label: CATEGORY_LABEL[f.category] ?? f.category,
    message: f.message,
    hint: CATEGORY_HINT[f.category],
    sample: f.sample,
  }));
}
