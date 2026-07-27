import type {
  ActivationStatus,
  AlertChannel,
  ChannelType,
  OutboxStatus,
  Severity,
} from "./types";

type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";

export const CHANNEL_TYPE_LABEL: Record<ChannelType, string> = {
  ilink_wechat: "微信 iLink",
  telegram: "Telegram",
  wecom_bot: "企业微信群机器人",
  wecom_aibot: "企业微信智能机器人",
};

// 事件分组中文标注 + 顺序(按业务重要性)。**含新增 ops.* 运维组**(旧 vanilla 的
// COVERAGE_GROUP_ORDER 漏了它,这里补上,否则 shell 监控写入的 ops 事件在覆盖矩阵里不显示)。
export const GROUP_LABEL: Record<string, string> = {
  account_pool: "账号池",
  payment: "支付",
  billing: "计费",
  container: "容器",
  risk: "风控",
  health: "健康",
  security: "安全",
  system: "系统",
  ops: "运维",
};
export const GROUP_ORDER = [
  "account_pool",
  "payment",
  "billing",
  "container",
  "risk",
  "health",
  "security",
  "system",
  "ops",
];

export function groupLabel(group: string): string {
  return GROUP_LABEL[group] ?? group;
}

/** 稳定排序:已知组按 GROUP_ORDER,未知组追加在后(保持后端给的顺序)。 */
export function orderedGroups(groups: string[]): string[] {
  const known = GROUP_ORDER.filter((g) => groups.includes(g));
  const unknown = groups.filter((g) => !GROUP_ORDER.includes(g));
  return [...known, ...unknown];
}

export const SEVERITY_MIN_OPTIONS: { label: string; value: Severity }[] = [
  { label: "info(所有)", value: "info" },
  { label: "warning(默认)", value: "warning" },
  { label: "critical(只发严重)", value: "critical" },
];

export const SEVERITY_TONE: Record<Severity, BadgeTone> = {
  critical: "danger",
  warning: "warning",
  info: "info",
};

export const OUTBOX_STATUS_META: Record<OutboxStatus, { label: string; tone: BadgeTone }> = {
  sent: { label: "sent", tone: "success" },
  failed: { label: "failed", tone: "danger" },
  pending: { label: "pending", tone: "warning" },
  suppressed: { label: "suppressed", tone: "neutral" },
  skipped: { label: "skipped", tone: "neutral" },
};

export const TRIGGER_LABEL: Record<string, string> = {
  polled: "轮询",
  passive: "被动",
  both: "两者",
};
export const TRIGGER_HINT: Record<string, string> = {
  polled: "轮询 scheduler",
  passive: "代码路径被动 enqueue",
  both: "轮询 + 被动 都有",
};

/**
 * 通道激活状态 → 徽标。移植 vanilla `_activationBadge`(admin.js 8014-8054)。
 * wecom_aibot 用「连接态 × 绑定态」双维度;iLink 用 activation_status × has_context_token;
 * Telegram/群机器人 创建即 active,只有永久错误落 error。
 */
export function activationBadge(c: AlertChannel): {
  tone: BadgeTone;
  text: string;
  title?: string;
} {
  if (c.channel_type === "wecom_aibot") {
    if (c.activation_status === "disabled") return { tone: "neutral", text: "已停用" };
    if (c.activation_status === "error") {
      return {
        tone: "danger",
        text: "鉴权失败",
        title: c.last_error || "Secret 被拒绝(订阅鉴权失败),请删除后用新 Secret 重建",
      };
    }
    const cs = c.aibot_conn_state || "unknown";
    const boundTxt = c.aibot_bound ? "已绑定" : "待绑定";
    if (cs === "connected") {
      return c.aibot_bound
        ? { tone: "success", text: "就绪(已连接·已绑定)" }
        : {
            tone: "warning",
            text: "已连接·待绑定",
            title: "长连接已就绪,但还没绑定推送会话。请在企业微信里给该机器人发一条消息完成绑定。",
          };
    }
    if (cs === "connecting" || cs === "reconnecting" || cs === "unknown") {
      return { tone: "warning", text: `连接中·${boundTxt}`, title: `长连接建立/重连中(${cs})。` };
    }
    return { tone: "danger", text: `未连接·${boundTxt}`, title: c.last_error || "" };
  }

  if (c.channel_type === "telegram" || c.channel_type === "wecom_bot") {
    if (c.activation_status === "active") return { tone: "success", text: "就绪" };
    if (c.activation_status === "disabled") return { tone: "neutral", text: "已停用" };
    return { tone: "danger", text: c.activation_status, title: c.last_error || "" };
  }

  // ilink_wechat
  if (c.activation_status === "active" && c.has_context_token) {
    return { tone: "success", text: "就绪" };
  }
  if (c.activation_status === "active" && !c.has_context_token) {
    return {
      tone: "warning",
      text: "已激活·待 token",
      title: "已激活但尚未捕获 context_token。请用微信再向该机器人发一条消息。",
    };
  }
  if (c.activation_status === "pending") {
    return {
      tone: "warning",
      text: "等待首次对话",
      title: "请用已扫码的微信向机器人发任意一句话,worker 会自动抓取 context_token。",
    };
  }
  if (c.activation_status === "disabled") return { tone: "neutral", text: "已停用" };
  return { tone: "danger", text: c.activation_status, title: c.last_error || "" };
}

/**
 * /test 常见 409 的中文 actionable 指引。移植 vanilla `_friendlyTestError`。
 * 优先看结构化 issues[].path==='activation',回落 message.includes。返回 null → 用原始 message。
 */
export function friendlyTestError(err: {
  message?: string;
  issue?: (path: string) => string | undefined;
}): string | null {
  const msg = String(err?.message || "");
  const issueMsg = String(err?.issue?.("activation") || "");
  if (issueMsg.includes("awaiting first inbound message") || msg.includes("channel not active: pending")) {
    return "通道还在等待激活 —— 请用扫码绑定的微信向机器人发任意一句话,worker 抓到首条消息会自动转为 active,几秒后再点测试";
  }
  if (msg.includes("channel not active: error")) {
    return "通道处于错误状态,请点「重新激活」后,再用微信发一条消息触发激活";
  }
  if (msg.includes("channel not active: disabled")) {
    return "通道处于 disabled 状态,请联系管理员或删除重建";
  }
  if (msg.includes("channel missing context_token")) {
    return "通道已激活,但还未抓到 context_token —— 请再用微信向机器人发一条消息触发抓取,几秒后再点测试";
  }
  if (msg.includes("channel disabled")) {
    return "通道未启用,请先点「启用」再测试";
  }
  return null;
}

export type { BadgeTone };
