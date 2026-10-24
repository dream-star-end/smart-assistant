import { Button } from './ui';

export function AccountSwitchNotice({ name, ready, onAccept, onRetry }: {
  name: string; ready: boolean; onAccept: () => void; onRetry: () => void;
}) {
  return <main className="flex h-full items-center justify-center bg-bg p-6 text-fg">
    <section className="w-full max-w-md space-y-4 rounded-xl border border-border bg-surface p-6" aria-labelledby="account-switch-title">
      <h1 id="account-switch-title" className="text-title font-semibold">登录账号已变化</h1>
      <p className="text-body text-muted">{ready ? `${name} 已通过核验。确认切换后载入该账号的工作区。` : '登录状态已更新，请重新核验账号。'}</p>
      <Button variant="accent" onClick={ready ? onAccept : onRetry}>{ready ? '切换到已验证账号' : '重新核验账号'}</Button>
    </section>
  </main>;
}
