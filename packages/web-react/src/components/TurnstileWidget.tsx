/**
 * Cloudflare Turnstile widget（explicit render）。
 *
 * 生产硬 cutover blocker：关闭 TURNSTILE_TEST_BYPASS 后，登录/注册必须携带真实
 * Turnstile token。本组件动态加载官方脚本（全局单例 loader，避免重复注入），用
 * 后端下发的 site key 显式 render，token 通过 onToken 回传；过期/出错回调让上层清掉
 * 旧 token 并禁用提交。
 *
 * 注：headless 环境无法完成真实 CF 挑战，本组件仅保证「脚本加载 + render + 回调接线 +
 * 卸载清理」正确；真实挑战的端到端验证待 canary 关闭 bypass 后在浏览器侧确认。
 */
import { useEffect, useRef } from "react";

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js";

/** 官方 window.turnstile 的最小契约（只声明本组件用到的方法）。*/
type TurnstileApi = {
  render: (
    el: HTMLElement,
    opts: {
      sitekey: string;
      callback: (token: string) => void;
      "expired-callback"?: () => void;
      "error-callback"?: () => void;
      "timeout-callback"?: () => void;
      theme?: "light" | "dark" | "auto";
      size?: "normal" | "compact" | "flexible";
    },
  ) => string;
  remove: (widgetId: string) => void;
  reset: (widgetId?: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let scriptPromise: Promise<TurnstileApi> | null = null;

/** 全局单例加载官方脚本；多个 widget 共享同一次注入。失败 reject 由上层吞掉。*/
function loadTurnstile(): Promise<TurnstileApi> {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return Promise.reject(new Error("no-dom"));
  }
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<TurnstileApi>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${SCRIPT_SRC}"]`);
    const onReady = () => {
      if (window.turnstile) resolve(window.turnstile);
      else reject(new Error("turnstile-unavailable"));
    };
    if (existing) {
      if (window.turnstile) resolve(window.turnstile);
      else {
        existing.addEventListener("load", onReady, { once: true });
        existing.addEventListener("error", () => reject(new Error("turnstile-script-error")), {
          once: true,
        });
      }
      return;
    }
    const s = document.createElement("script");
    s.src = SCRIPT_SRC;
    s.async = true;
    s.defer = true;
    s.addEventListener("load", onReady, { once: true });
    s.addEventListener("error", () => {
      // 加载失败：作废单例 promise，允许下次重试。
      scriptPromise = null;
      reject(new Error("turnstile-script-error"));
    });
    document.head.appendChild(s);
  });
  return scriptPromise;
}

export function TurnstileWidget({
  siteKey,
  onToken,
  onExpire,
  onError,
  theme = "auto",
  className,
}: {
  siteKey: string;
  onToken: (token: string) => void;
  onExpire?: () => void;
  onError?: () => void;
  theme?: "light" | "dark" | "auto";
  className?: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  // 回调以 ref 持有，避免 token/expire 变更触发 widget 重建（render 一次即可）。
  const cbRef = useRef({ onToken, onExpire, onError });
  cbRef.current = { onToken, onExpire, onError };

  useEffect(() => {
    let widgetId: string | null = null;
    let cancelled = false;
    if (!siteKey) return;

    loadTurnstile()
      .then((api) => {
        if (cancelled || !hostRef.current) return;
        widgetId = api.render(hostRef.current, {
          sitekey: siteKey,
          theme,
          callback: (token: string) => cbRef.current.onToken(token),
          "expired-callback": () => cbRef.current.onExpire?.(),
          "error-callback": () => cbRef.current.onError?.(),
          "timeout-callback": () => cbRef.current.onExpire?.(),
        });
      })
      .catch(() => {
        if (!cancelled) cbRef.current.onError?.();
      });

    return () => {
      cancelled = true;
      if (widgetId && window.turnstile) {
        try {
          window.turnstile.remove(widgetId);
        } catch {
          /* ignore */
        }
      }
    };
    // siteKey/theme 变更才重建 widget；回调走 ref 不进 deps。
  }, [siteKey, theme]);

  return <div ref={hostRef} className={className} data-testid="turnstile-widget" />;
}
