import { useRef } from "react";
import type { DelegateFailureController, FailureInboxState } from "../../lib/delegateFailureController";
import {
  DelegateFailureApiError, failureErrorText, failureKey, failureSummaryText, retryStateText,
  type DelegateFailure,
} from "../../lib/delegateFailures";
import type { Session } from "../../lib/types";
import { Alert, Badge, Button, Modal, useConfirm } from "../ui";

/** Only navigate a currently known, account-owned client row; never manufacture a parent. */
export function knownFailureParentId(parentKey: string, sessions: readonly Session[], userId: string): string | null {
  const match = /^agent:([^:]+):webchat:dm:([A-Za-z0-9_-]{1,128})$/.exec(parentKey);
  if (!match) return null;
  const row = sessions.find(s => s.id === match[2] && s.ownerUserId === userId);
  if (!row || (row.agentId && row.agentId !== match[1])) return null;
  return row.id;
}

/** One durable failure feedback surface: badge and dialog use the same account snapshot. */
export function DelegateFailureInbox({ state, controller, onOpenParent }: {
  state: FailureInboxState;
  controller: DelegateFailureController;
  onOpenParent: (parentKey: string) => boolean;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [confirm, confirmElement] = useConfirm();
  const total = state.summary;
  const label = total
    ? `后台任务 ${total.running} 运行中 / ${total.queued} 排队 / ${total.unacknowledgedFailures} 失败`
    : "后台任务 · 状态待确认";
  const repeat = async (row: DelegateFailure) => {
    const accepted = await confirm({ title: "确认同一次继续？", confirmText: "确认并重发同一请求",
      body: "用于上次请求中断或结果不确定。会使用同一个请求编号；若此前未受理，可能开始执行原子会话。不会新建第二次继续，也不会确认这条失败。" });
    if (accepted === true) await controller.retry(row, true);
  };
  const openParent = async (row: DelegateFailure) => {
    if (onOpenParent(row.parentSessionKey)) controller.setOpen(false);
    else await confirm({ title: "原会话暂不在当前列表中", body: "请先从会话列表找到原会话。不会自动创建或恢复会话，这条失败仍保留。", confirmText: "知道了" });
  };
  return <>
    <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-2 px-4 pb-2" data-testid="delegate-failure-footer">
      <Button ref={trigger} size="sm" variant="ghost" onClick={() => controller.setOpen(true)} aria-label={label} className="h-auto min-w-0 max-w-full whitespace-normal">
        <span className="min-w-0 break-words text-left text-meta">{label}</span>
        {!!total?.unacknowledgedFailures && <Badge tone="danger">待确认</Badge>}
      </Button>
      {state.error && <span className="text-meta text-muted" role="status">状态可能未更新</span>}
    </div>
    <Modal open={state.open} onOpenChange={controller.setOpen} title="后台任务失败收件箱" size="lg" mobile="sheet"
      description="失败会保留到你明确点击“知道了”。查看、跳转或继续任务都不会自动确认。"
      onCloseAutoFocus={event => { event.preventDefault(); trigger.current?.focus(); }}
      footer={<>
        <Button variant="ghost" size="sm" disabled={state.loading} onClick={controller.firstPage}>回到首页</Button>
        <Button variant="secondary" size="sm" disabled={state.loading || !state.previous.length} onClick={controller.previousPage}>上一页</Button>
        <Button variant="secondary" size="sm" disabled={state.loading || !state.page?.nextCursor || state.previous.length >= 100} onClick={controller.nextPage}>下一页</Button>
      </>}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <span className="text-meta text-muted">{state.page ? `${state.page.count} 条未确认 · 本页 ${state.page.items.length} 条` : "正在读取失败记录"}</span>
        <Button variant="ghost" size="sm" disabled={state.loading} onClick={() => void controller.refresh()}>刷新</Button>
      </div>
      {state.error && <Alert tone="warning">{state.error}。已有记录会保留，不代表没有失败。</Alert>}
      {state.loading && <p role="status" className="text-meta text-muted">正在更新…</p>}
      {!state.loading && !state.error && state.page?.items.length === 0 && <p className="text-body text-muted">本页没有未确认失败{state.before ? "，可返回首页查看" : ""}。</p>}
      <ul className="flex flex-col gap-3">
        {state.page?.items.map(row => {
          const key = failureKey(row), pending = state.pending[key], retry = state.retries[key];
          return <li key={key} data-job-id={row.jobId} className="rounded-lg border border-border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <strong className="text-body text-danger">{failureSummaryText(row)}</strong>
              <time className="text-meta text-muted" dateTime={new Date(row.failedAt).toISOString()}>{new Date(row.failedAt).toLocaleString()}</time>
            </div>
            <p className="mt-1 break-all text-meta text-muted">任务 {row.jobId}</p>
            {retry && <p role="status" className="mt-2 text-meta">{retryStateText(retry.state)} · {retry.jobId}</p>}
            {!row.retry.available && <p className="mt-2 text-meta text-muted">{failureErrorText(new DelegateFailureApiError(row.retry.reason ?? "retry_not_ready"))}</p>}
            {state.messages[key] && <p role="alert" className="mt-2 text-meta text-danger">{state.messages[key]}</p>}
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" disabled={!!pending} onClick={() => void openParent(row)}>查看原会话</Button>
              <Button size="sm" variant="secondary" disabled={!!pending || !row.retry.available} onClick={() => void controller.retry(row)}>{pending === "retry" ? "正在确认…" : "继续原子会话"}</Button>
              <Button size="sm" variant="ghost" disabled={!!pending} onClick={() => void repeat(row)}>确认上次继续</Button>
              <Button size="sm" variant="ghost" disabled={!!pending} onClick={() => void controller.acknowledge(row)}>{pending === "ack" ? "确认中…" : "知道了"}</Button>
            </div>
          </li>;
        })}
      </ul>
    </Modal>
    {confirmElement}
  </>;
}
