import type { RepoSelection, RepoStatus } from "./types";

/**
 * GitHub 仓库绑定的纯逻辑层（框架无关、可单测）。
 * 从 v3 packages/web/public/modules/github.js 移植：克隆进度估算、pill 标签、
 * 错误码文案、版本门控哨兵。UI/hook 只调用这里，保证与 v3 行为一致。
 */

/** 已 unbind / 无选择的版本哨兵：封顶已知版本，丢弃任何延迟到达的旧 status 帧。 */
export const VERSION_SENTINEL_CLEARED = Number.POSITIVE_INFINITY;

/**
 * 克隆进度本地估算（后端不推真实百分比）。曲线封顶 90%，真正的 ready 帧跳 100%。
 * t=0→0%；t=0.5(15s)→60%；t=1(30s)→80%；t=2(60s)→89%。对齐 v3 estimateCloningProgress。
 */
export function estimateCloningProgress(startMs: number, nowMs: number): number {
  if (!Number.isFinite(startMs) || !Number.isFinite(nowMs)) return 0;
  const t = Math.max(0, (nowMs - startMs) / 30_000);
  return Math.min(90, Math.round(90 * (1 - Math.exp(-2.2 * t))));
}

/** 状态 dot：未绑 'none'，否则跟随 status。 */
export type RepoDot = RepoStatus | "none";

/** pill 标签 + 状态点（仓库未绑显示"仓库"，已绑显示 owner/repo@branch）。 */
export function formatRepoLabel(sel: RepoSelection | null | undefined): { label: string; dot: RepoDot } {
  if (!sel || !sel.selected) return { label: "仓库", dot: "none" };
  return { label: `${sel.owner}/${sel.repo} @ ${sel.branch}`, dot: sel.status };
}

/** banner 文案。 */
export function repoStatusText(status: RepoStatus): string {
  switch (status) {
    case "pending":
      return "准备中…";
    case "cloning":
      return "正在克隆仓库…";
    case "ready":
      return "仓库已就绪";
    case "failed":
      return "仓库克隆失败";
    default:
      return "";
  }
}

const GITHUB_ERROR_TEXT: Record<string, string> = {
  // 后端 selection / token 校验
  GITHUB_NOT_LINKED: "请先连接 GitHub 账号",
  GITHUB_TOKEN_INVALID: "GitHub token 已失效，已自动解绑，请重新连接",
  GITHUB_REPO_NOT_FOUND: "仓库不存在或无访问权限",
  GITHUB_BRANCH_NOT_FOUND: "分支不存在",
  GITHUB_REPO_NO_WRITE: "你对该仓库没有写权限",
  GITHUB_TOKEN_REVOKE_FAILED: "解绑失败，请稍后重试",
  // bridge 绑定校验
  STALE_OR_MISSING: "仓库选择已变更，请重新选择",
  INVALID_BIND_PAYLOAD: "绑定请求异常，请重试",
  INVALID_SESSION_ID: "会话异常，请刷新后重试",
  // 容器克隆失败
  token_invalid: "GitHub token 已失效，已自动解绑，请重新连接",
  clone_failed: "仓库克隆失败，请稍后重试",
  // OAuth 回调
  state_mismatch: "OAuth 回调状态不匹配，请重试",
  exchange_failed: "GitHub 授权码兑换失败，请重试",
  account_already_linked: "该 GitHub 账号已绑定到另一个账号",
  oauth_not_configured: "服务端未配置 GitHub OAuth",
};

/** 错误码 → 友好中文文案（未知码回退通用文案，不暴露裸码）。 */
export function githubErrorText(code: string | null | undefined): string {
  if (!code) return "操作失败，请重试";
  return GITHUB_ERROR_TEXT[code] ?? "操作失败，请重试";
}

/**
 * 版本门控：本地已知版本严格大于来帧版本则丢弃（防 stale 回滚）。
 * 等于的接受 —— 后端会对同一 selection_version 推 pending→cloning→ready 多次。
 * 对齐 v3 handleRepoStatusFrame 的 `known > ver` 判定。
 */
export function shouldDropFrame(known: number, incomingVersion: number): boolean {
  const ver = Number.isFinite(incomingVersion) ? incomingVersion : -1;
  return known > ver;
}
