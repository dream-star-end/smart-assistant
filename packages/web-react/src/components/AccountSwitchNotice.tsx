import { ShieldAlert, UserCheck } from 'lucide-react';
import { Button } from './ui';

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
            {ready ? '切换到已验证账号' : '继续'}
          </Button>
        </div>
      </section>
    </main>
  );
}

export function IdentityRecoveryNotice({ onRetry }: { onRetry: () => void }) {
  return (
    <output className="oc-callout oc-callout-warning flex items-center justify-between gap-3 px-4 py-2.5 text-body text-muted">
      <span className="flex min-w-0 items-center gap-2.5">
        <span className="oc-icon-badge oc-icon-badge-warning flex size-6 shrink-0 items-center justify-center rounded-md">
          <ShieldAlert size={13} strokeWidth={1.75} aria-hidden="true" />
        </span>
        <span className="min-w-0 truncate">登录状态暂未核验完成，核验后恢复操作权限。</span>
      </span>
      <Button
        variant="secondary"
        size="sm"
        className="oc-btn-tactile oc-btn-secondary-craft shrink-0"
        onClick={onRetry}
      >
        继续
      </Button>
    </output>
  );
}
