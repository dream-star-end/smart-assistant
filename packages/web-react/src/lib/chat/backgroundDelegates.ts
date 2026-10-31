/** Background delegates share durable chat storage; only their presentation waits for confirmation. */
import type { StoredPendingControl } from "../persist";
import type { InflightDelegateItem } from "./inflightDelegates";
import { isDelegateTerminalState as isTerminalDelegateState } from "@openclaude/protocol/browser";
import type { ChatMessage } from "./model";

/** Recognize only the gateway's explicit receipt, including MCP/CLI text envelopes. */
export function backgroundDelegateReceiptIds(output: unknown, outputJson?: unknown): string[] {
  const ids = new Set<string>();
  const visit = (raw: unknown, depth: number): void => {
    if (depth > 6 || raw == null) return;
    if (typeof raw === "string") {
      if (!raw.includes("resultDelivery")) return;
      const lines = raw.split(/\r?\n/);
      for (const line of [raw, ...lines]) {
        try { visit(JSON.parse(line), depth + 1); } catch { /* prose is not a receipt */ }
      }
      return;
    }
    if (Array.isArray(raw)) { for (const item of raw) visit(item, depth + 1); return; }
    if (typeof raw !== "object") return;
    const value = raw as Record<string, unknown>;
    if (value.resultDelivery === "background" && (value.status === "running" || value.status === "queued") &&
      typeof value.jobId === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value.jobId)) ids.add(value.jobId);
    for (const key of ["content", "result", "text", "stdout", "success"]) visit(value[key], depth + 1);
  };
  visit(outputJson, 0); visit(output, 0);
  return [...ids].slice(0, 32);
}

export function stampBackgroundDelegateReceipt(message: ChatMessage): void {
  const ids = backgroundDelegateReceiptIds(message.output, message.outputJson);
  if (ids.length === 0) return;
  message._backgroundDelegate = true;
  if (message.role === "agent-group") {
    message._background = true;
    message._delegateJobId = ids[0];
  }
}

function isBackgroundDelegateRow(message: ChatMessage): boolean {
  return message._backgroundDelegate === true ||
    (message.role === "tool" && backgroundDelegateReceiptIds(message.output, message.outputJson).length > 0);
}

export function isBackgroundDelegateFrame(frame: { isFinal?: boolean; blocks?: readonly { kind?: string; background?: boolean }[] }): boolean {
  return frame.isFinal !== true && !!frame.blocks?.length &&
    frame.blocks.every((block) => block.kind === "delegate_progress" && block.background === true);
}

export function hasPendingBackgroundConfirmation(messages: readonly ChatMessage[], now = Date.now()): boolean {
  return messages.some((message) => message.role === "permission" && message._resolved !== true &&
    !(typeof message._askUserExpiresAt === "number" && message._askUserExpiresAt <= now));
}

/** Keep the stored rows intact, including while a durable answer awaits its receipt. */
export function projectBackgroundDelegateRows(messages: ChatMessage[], now = Date.now()): ChatMessage[] {
  if (!hasPendingBackgroundConfirmation(messages, now)) return messages;
  return messages.some((message) => isBackgroundDelegateRow(message))
    ? messages.filter((message) => !isBackgroundDelegateRow(message))
    : messages;
}

export function visibleBackgroundDelegateItems(items: InflightDelegateItem[], messages: readonly ChatMessage[]): InflightDelegateItem[] {
  return hasPendingBackgroundConfirmation(messages)
    ? items.filter((item) => item.background !== true || !isTerminalDelegateState(item.state))
    : items;
}

/** Capture exact jobs at the user's Stop boundary; a replay cannot target a later job. */
export function activeBackgroundDelegateJobIds(items: readonly InflightDelegateItem[], messages: readonly ChatMessage[]): string[] {
  const authoritative = new Set(items.map((item) => item.jobId));
  const terminal = new Set(items.filter((item) => isTerminalDelegateState(item.state)).map((item) => item.jobId));
  for (const message of messages) {
    if (message._backgroundDelegate === true && (message._completed || message._payloadDeferred === true) &&
      message._delegateJobId && !authoritative.has(message._delegateJobId)) terminal.add(message._delegateJobId);
  }
  // A result card may commit before process retirement finishes. Server jobs
  // remain stoppable until their authoritative terminal, even if the HUD is done.
  const ids = items.filter((item) => item.background === true && !isTerminalDelegateState(item.state)).map((item) => item.jobId);
  for (const message of messages) {
    if (message.role === "tool" || message.role === "agent-group") ids.push(...backgroundDelegateReceiptIds(message.output, message.outputJson).filter((id) => !terminal.has(id)));
    if (message._backgroundDelegate === true && message._delegateJobId && !message._completed && !terminal.has(message._delegateJobId)) {
      ids.push(message._delegateJobId);
    }
  }
  return [...new Set(ids)].filter((id) => /^[A-Za-z0-9._:-]{1,128}$/.test(id)).slice(0, 32);
}

export function stableControlId(kind: "stop" | "permission", identity: string): string {
  const readable = `control:${kind}:${identity}`;
  if (/^[A-Za-z0-9._:-]{1,128}$/.test(readable)) return readable;
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < identity.length; i++) {
    hash ^= BigInt(identity.charCodeAt(i));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `control:${kind}:h${hash.toString(36)}`;
}

export function buildStopControl(args: {
  sessId: string;
  agentId: string;
  controlId: string;
  clientMessageId?: string;
  fenceOnly?: true;
  backgroundJobIds?: string[];
}): StoredPendingControl & { status: "queued" } {
  const backgroundOnly = !!args.backgroundJobIds?.length && !args.clientMessageId;
  return {
    kind: "control", sessId: args.sessId, controlId: args.controlId, controlKind: "stop", agentId: args.agentId,
    ...(args.clientMessageId ? { clientMessageId: args.clientMessageId } : {}),
    ...(args.fenceOnly ? { fenceOnly: true } : {}),
    ...(backgroundOnly ? { backgroundOnly: true } : {}),
    payload: {
      type: "inbound.control.stop", controlId: args.controlId, channel: "webchat",
      peer: { id: args.sessId, kind: "dm" }, agentId: args.agentId,
      ...(args.clientMessageId ? { clientMessageId: args.clientMessageId } : {}),
      ...(args.backgroundJobIds?.length ? { backgroundJobIds: [...args.backgroundJobIds] } : {}),
    },
    enqueuedAt: Date.now(), attempt: 0, status: "queued",
  };
}

export function backgroundStopControl(sessId: string, agentId: string, rawIds: readonly string[]): (StoredPendingControl & { status: "queued" }) | null {
  const ids = [...new Set(rawIds)].filter((id) => /^[A-Za-z0-9._:-]{1,128}$/.test(id)).slice(0, 32).sort();
  if (ids.length === 0) return null;
  return buildStopControl({ sessId, agentId, controlId: stableControlId("stop", `background:${JSON.stringify([sessId, ids])}`), backgroundJobIds: ids });
}
