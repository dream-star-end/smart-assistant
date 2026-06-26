import { ArrowLeft, ArrowRight, Sparkles } from "lucide-react";
import { useState } from "react";
import type { Theme } from "../hooks/useTheme";
import { BRAND } from "../lib/brand";
import { ThemeToggle } from "./ThemeToggle";
import { Button, Input, Spinner } from "./ui";

export function AuthGate({
  onLogin,
  loading,
  error,
  onBack,
  theme,
  onCycleTheme,
}: {
  onLogin: (email: string, password: string) => void;
  loading?: boolean;
  error?: string | null;
  onBack?: () => void;
  theme: Theme;
  onCycleTheme: () => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-bg px-5">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-70"
        style={{
          background:
            "radial-gradient(60% 50% at 50% -10%, color-mix(in srgb, var(--accent) 16%, transparent), transparent 70%)",
        }}
      />
      {onBack && (
        <Button variant="ghost" size="sm" onClick={onBack} className="absolute left-4 top-4 gap-1.5 text-muted">
          <ArrowLeft size={15} />
          返回首页
        </Button>
      )}
      <div className="absolute right-4 top-4">
        <ThemeToggle theme={theme} onCycle={onCycleTheme} />
      </div>
      <div className="relative w-full max-w-[400px] animate-in">
        <div className="mb-7 flex flex-col items-center text-center">
          <span className="mb-4 flex size-12 items-center justify-center rounded-xl2 bg-grad-cta text-white shadow-float">
            <Sparkles size={24} />
          </span>
          <h1 className="text-[22px] font-semibold tracking-tight text-fg">欢迎使用 {BRAND.name}</h1>
          <p className="mt-1.5 text-[14px] text-muted">{BRAND.tagline}</p>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            onLogin(email.trim(), password);
          }}
          className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-5 shadow-soft"
        >
          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium text-muted">邮箱</span>
            <Input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              type="email"
              autoComplete="email"
              placeholder="邮箱"
              className="rounded-xl bg-bg"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium text-muted">密码</span>
            <Input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type="password"
              autoComplete="current-password"
              placeholder="密码"
              className="rounded-xl bg-bg"
            />
          </label>

          {error && (
            <div className="rounded-xl border border-danger/30 bg-danger-soft px-3.5 py-2.5 text-[13px] text-danger">
              {error}
            </div>
          )}

          <Button
            type="submit"
            variant="primary"
            disabled={loading || !email.trim() || !password}
            className="mt-1 w-full gap-2 rounded-xl text-[14.5px]"
          >
            {loading ? (
              <Spinner size={17} />
            ) : (
              <>
                登录
                <ArrowRight size={16} />
              </>
            )}
          </Button>
        </form>
        <p className="mt-4 text-center text-[12px] text-faint">
          预置智能体 · 流式对话 · 持久会话
        </p>
      </div>
    </div>
  );
}
