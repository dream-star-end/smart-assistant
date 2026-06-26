export type User = { id: string; displayName: string; roles: string[] };

export type Session = {
  id: string;
  title: string;
  ownerUserId: string;
  updatedAt: string;
  messageCount: number;
};

export type Message = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  traceId?: string;
};

export type ToolCard = {
  id: string;
  title: string;
  status: string;
  evidence?: string[];
};

export type BillingLedgerEntry = {
  id: string;
  type: "seed_grant" | "topup_test" | "charge" | "refund" | "monthly_grant";
  amountCents: number;
  balanceAfterCents: number;
  currency: string;
  description: string;
  createdAt: string;
  traceId?: string;
};

/** 后端 /billing/summary 响应（扁平结构：余额 + 账单流水）。 */
export type Billing = {
  currency: string;
  balanceCents: number;
  ledger: BillingLedgerEntry[];
};

/**
 * 鉴权会话：access token 的唯一权威源（仅存内存，绝不落地）。
 * - getToken/setToken：api 层在静默刷新成功后回写新 token，App 持有同一引用即可读到最新值。
 * - onExpired：刷新失败（refresh 返回 401）时回调，App 据此清理鉴权状态并回到登录页。
 * api 的鉴权请求统一吃 AuthSession，命中 401 时透明走一次 refresh + 重放。
 */
export type AuthSession = {
  getToken: () => string;
  setToken: (t: string) => void;
  onExpired: () => void;
};

/** @deprecated 历史命名，等同 AuthSession；保留以减小调用点改动面。 */
export type Auth = AuthSession;

/** 后端 SSE error 帧 → 前端可见的错误（含追踪号，便于用户反馈/运维定位）。 */
export type StreamError = { code: string; message: string; requestId?: string };

export type StreamHandlers = {
  onDelta: (text: string) => void;
  onToolCard?: (card: ToolCard) => void;
  onError?: (err: StreamError) => void;
  onDone: (payload: { session: Session; messages: Message[] }) => void;
};
