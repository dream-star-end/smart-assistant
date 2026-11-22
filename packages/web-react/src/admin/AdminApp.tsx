import { ShieldAlert } from "lucide-react";
import { useCallback, useEffect } from "react";
import { MediaSignProvider } from "../components/chat/media";
import { Button, Spinner } from "../components/ui";
import { api } from "../lib/api";
import { AdminShell } from "./AdminShell";
import { adminSession, useAdminAuth } from "./auth";

/**
 * 鉴权引导壳：
 *  - 引导中（!ready）→ 极简加载态（居中 Spinner）。
 *  - 引导完成但非 admin（未登录 / role!=='admin'）→ 跳用户端首页 '/'（不做独立登录页，
 *    语义与旧 vanilla admin 一致）。
 *  - admin → 渲染 AdminShell。
 */
export function AdminApp() {
  const { user, ready, authed, recoverable, retry, logout } = useAdminAuth();
  const signMedia = useCallback(
    (paths: string[]) => api.mediaSign(adminSession, paths).then((result) => result.urls),
    [],
  );

  // 引导完成且无权限时跳首页。放 effect 里避免在 render 阶段做副作用（StrictMode 双调用安全）。
  useEffect(() => {
    if (ready && !authed && !recoverable) window.location.replace("/");
  }, [ready, authed, recoverable]);

  if (ready && recoverable) {
    return (
      <div className="flex h-dvh items-center justify-center bg-bg px-6">
        <div className="oc-surface-card flex max-w-sm flex-col items-center gap-3.5 rounded-2xl p-6 text-center">
          <span className="oc-icon-badge oc-icon-badge-warning size-11 rounded-xl">
            <ShieldAlert size={20} strokeWidth={1.9} />
          </span>
          <div className="space-y-1">
            <p className="text-title font-semibold text-fg">会话状态暂未恢复</p>
            <p className="text-body leading-relaxed text-muted">
              管理后台登录状态暂时无法恢复，请检查网络后重试。
            </p>
          </div>
          <Button variant="primary" onClick={retry} className="mt-1">
            重试恢复
          </Button>
        </div>
      </div>
    );
  }

  if (!ready || !authed) {
    return (
      <div className="flex h-dvh items-center justify-center bg-bg text-muted">
        <div className="oc-surface-card flex items-center gap-3 rounded-xl px-5 py-3.5">
          <Spinner size={20} />
          <span className="text-body font-medium text-muted">正在验证管理权限…</span>
        </div>
      </div>
    );
  }

  return (
    <MediaSignProvider sign={signMedia} authKey={user?.id ?? "admin"}>
      <AdminShell user={user} onLogout={logout} />
    </MediaSignProvider>
  );
}
