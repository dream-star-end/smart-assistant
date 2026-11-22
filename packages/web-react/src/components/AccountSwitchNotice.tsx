import { ShieldAlert, UserCheck } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from './ui';

const IDENTITY_RECOVERY_RETRY_DELAYS_MS = [2_000, 5_000] as const;

export function AccountSwitchNotice({ name, ready, onAccept, onRetry }: {
  name: string; ready: boolean; onAccept: () => void; onRetry: () => void;
}) {
  return (
    <main className="flex h-full items-center justify-center bg-bg p-6 text-fg">
      <section
        className="oc-surface-card w-full max-w-md space-y-4 rounded-2xl p-6 animate-in"
        aria-labelledby="account-switch-title"
      >
        <div className="flex items-center gap-3">
          <span className="oc-icon-badge oc-icon-badge-accent flex size-9 shrink-0 items-center justify-center rounded-xl">
            <UserCheck size={17} strokeWidth={1.75} aria-hidden="true" />
          </span>
          <h1 id="account-switch-title" className="text-title font-semibold tracking-tight text-fg">
            登录账号已变化
          </h1>
        </div>
        <p className="text-body leading-relaxed text-muted">
          {ready ? `${name} 已通过核验。确认切换后载入该账号的工作区。` : '登录状态已更新，请重新核验账号。'}
        </p>
        <div className="pt-1">
          <Button
            variant="accent"
            className="oc-btn-tactile oc-btn-accent-craft"
            onClick={ready ? onAccept : onRetry}
          >
            {ready ? '切换到已验证账号' : '重新验证'}
          </Button>
        </div>
      </section>
    </main>
  );
}

export function IdentityRecoveryNotice({
  onRetry,
  retryDelaysMs = IDENTITY_RECOVERY_RETRY_DELAYS_MS,
}: {
  onRetry: () => void;
  /** 后台静默指数退避重试间隔；全部失败后才展示温和提示条。 */
  retryDelaysMs?: readonly number[];
}) {
  const [visible, setVisible] = useState(retryDelaysMs.length === 0);
  const onRetryRef = useRef(onRetry);
  onRetryRef.current = onRetry;

  useEffect(() => {
    if (retryDelaysMs.length === 0) {
      setVisible(true);
      return;
    }
    let cancelled = false;
    let attempt = 0;
    let timer: number | undefined;

    const scheduleNext = () => {
      if (cancelled) return;
      const delay = retryDelaysMs[attempt];
      if (delay === undefined) {
        setVisible(true);
        return;
      }
      timer = window.setTimeout(() => {
        if (cancelled) return;
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
          setVisible(true);
          return;
        }
        attempt += 1;
        onRetryRef.current();
        scheduleNext();
      }, delay);
    };

    scheduleNext();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [retryDelaysMs]);

  if (!visible) return null;

  return (
    <output
      data-testid="identity-recovery-notice"
      className="oc-callout oc-callout-warning flex items-center justify-between gap-3 px-4 py-2.5 text-body text-muted"
    >
      <span className="flex min-w-0 items-center gap-2.5">
        <span className="oc-icon-badge oc-icon-badge-warning flex size-6 shrink-0 items-center justify-center rounded-md">
          <ShieldAlert size={13} strokeWidth={1.75} aria-hidden="true" />
        </span>
        <span className="min-w-0 truncate">账号状态同步受阻，请重新验证。</span>
      </span>
      <Button
        variant="secondary"
        size="sm"
        className="oc-btn-tactile oc-btn-secondary-craft shrink-0"
        onClick={onRetry}
      >
        重新验证
      </Button>
    </output>
  );
}
