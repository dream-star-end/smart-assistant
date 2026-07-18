// 环境配置解析(单一权威):所有目标环境/凭据都从 env 注入,零硬编码账号密码。
// run.sh 负责建隧道并注入 OC_E2E_BASE_URL;此处只读取与校验。
//
// 必填:
//   OC_E2E_BASE_URL       目标环境 HTTP 根(如 http://127.0.0.1:18790,run.sh 建隧道后注入)
//   OC_E2E_PASSWORD       canary/预发专用账号密码(单一权威在 kl-mirror,run.sh 经 ssh 读)
// 选填:
//   OC_E2E_EMAIL          默认 v5-canary@claudeai.chat
//   OC_E2E_TURNSTILE      默认 "bypass"(bypass 环境占位串;AuthGate BYPASS_TOKEN 同值)
//   OC_E2E_MODEL          默认 gpt-5.6-sol(codex 引擎,与部署 smoke 同盲区面)
//   OC_E2E_TURN_TIMEOUT   单轮回复上限 ms,默认 120000
//   OC_E2E_PG_URL         §9 注入/种子用的 PG 连接串(仅预发;缺省 → 依赖 §9 的用例 skip)
//   OC_E2E_SESSION_PREFIX 种子会话 id 前缀,默认 e2e-(便于批量清理)

function required(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(
      `[e2e/env] 缺少必填环境变量 ${name}。请用 run.sh 启动,或手动注入(见 README 环境矩阵)。`,
    );
  }
  return v.trim();
}

export interface E2EConfig {
  baseUrl: string;
  wsBase: string;
  email: string;
  password: string;
  turnstile: string;
  model: string;
  turnTimeoutMs: number;
  pgUrl: string | null;
  sessionPrefix: string;
}

let cached: E2EConfig | null = null;

export function config(): E2EConfig {
  if (cached) return cached;
  const baseUrl = required('OC_E2E_BASE_URL').replace(/\/+$/, '');
  cached = {
    baseUrl,
    wsBase: baseUrl.replace(/^http/, 'ws'),
    email: process.env.OC_E2E_EMAIL?.trim() || 'v5-canary@claudeai.chat',
    password: required('OC_E2E_PASSWORD'),
    turnstile: process.env.OC_E2E_TURNSTILE?.trim() || 'bypass',
    model: process.env.OC_E2E_MODEL?.trim() || 'gpt-5.6-sol',
    turnTimeoutMs: Number(process.env.OC_E2E_TURN_TIMEOUT ?? 120_000),
    pgUrl: process.env.OC_E2E_PG_URL?.trim() || null,
    sessionPrefix: process.env.OC_E2E_SESSION_PREFIX?.trim() || 'e2e-',
  };
  return cached;
}

/** 生成一个带 e2e- 前缀、满足 [A-Za-z0-9_-]{8,50} 的会话 id(便于清理与追溯)。 */
export function mintSessionId(tag = ''): string {
  const cfg = config();
  const rand = Math.random().toString(36).slice(2, 8);
  const raw = `${cfg.sessionPrefix}${tag}${Date.now().toString(36)}${rand}`.replace(/[^A-Za-z0-9_-]/g, '');
  return raw.slice(0, 50).padEnd(8, '0');
}
