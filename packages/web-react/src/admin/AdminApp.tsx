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
      <div className="flex h-dvh flex-col items-center justify-center gap-3 bg-bg px-6 text-center">
        <p className="text-sm text-muted">管理后台登录状态暂时无法恢复，请检查网络后重试。</p>
        <Button variant="primary" onClick={retry}>重试恢复</Button>
      </div>
    );
  }

  if (!ready || !authed) {
    return (
      <div className="flex h-dvh items-center justify-center bg-bg text-muted">
        <Spinner size={22} />
      </div>
    );
  }

  return (
    <MediaSignProvider sign={signMedia} authKey={user?.id ?? "admin"}>
      <AdminShell user={user} onLogout={logout} />
    </MediaSignProvider>
  );
}
