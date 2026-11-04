/** Commercial builds can hide the taskboard while keeping the shared code/API intact. */
export function taskboardEnabledFromBuildEnv(raw: unknown): boolean {
  return raw !== "0";
}

/** Selfhost/default stays enabled; official commercial deploy sets the flag to 0. */
export const TASKBOARD_ENABLED = taskboardEnabledFromBuildEnv(
  import.meta.env.VITE_TASKBOARD_ENABLED,
);

export const TICKET_TYPES = ["bug", "feature", "spike", "chore"] as const;
export type TicketType = (typeof TICKET_TYPES)[number];

type TicketApprovalEntry = {
  pending: boolean;
  version: number;
};

const ticketApprovalPendingMap = new Map<string, TicketApprovalEntry>();
const ticketApprovalListeners = new Set<() => void>();
let ticketApprovalVersion = 0;

function normalizeTicketKey(ticketId: string): string {
  return ticketId.trim().toUpperCase();
}

export function recordTicketApprovalPending(
  ticketId: string,
  pending: boolean,
  version?: number,
): void {
  const key = normalizeTicketKey(ticketId);
  if (!key) return;
  const ver = typeof version === "number" && Number.isFinite(version) ? version : null;
  const prev = ticketApprovalPendingMap.get(key);
  if (prev && ver !== null && ver < prev.version) {
    return;
  }
  const nextVersion = ver !== null ? ver : (prev?.version ?? 0);
  if (prev && prev.pending === pending && prev.version === nextVersion) return;
  const pendingChanged = !prev || prev.pending !== pending;
  ticketApprovalPendingMap.set(key, { pending, version: nextVersion });
  if (pendingChanged) {
    ticketApprovalVersion += 1;
    for (const listener of ticketApprovalListeners) listener();
  }
}

export function syncTicketApprovalFromTicket(
  ticket:
    | { id?: unknown; identifier?: unknown; status?: unknown; version?: unknown }
    | null
    | undefined,
): void {
  if (!ticket || typeof ticket !== "object") return;
  if (typeof ticket.status !== "string" || !ticket.status) return;
  const pending = ticket.status === "backlog" || ticket.status === "waiting_human";
  const ver =
    typeof ticket.version === "number" && Number.isFinite(ticket.version)
      ? ticket.version
      : undefined;
  if (typeof ticket.id === "string" && ticket.id.trim()) {
    recordTicketApprovalPending(ticket.id, pending, ver);
  }
  if (typeof ticket.identifier === "string" && ticket.identifier.trim()) {
    recordTicketApprovalPending(ticket.identifier, pending, ver);
  }
}

export function isTicketApprovalKnownResolved(ticketId: string): boolean {
  const key = normalizeTicketKey(ticketId);
  if (!key) return false;
  return ticketApprovalPendingMap.get(key)?.pending === false;
}

export function clearTicketApprovalPendingCacheForTest(): void {
  ticketApprovalPendingMap.clear();
  ticketApprovalVersion += 1;
}

export function subscribeTicketApprovalPending(listener: () => void): () => void {
  ticketApprovalListeners.add(listener);
  return () => {
    ticketApprovalListeners.delete(listener);
  };
}

export function getTicketApprovalPendingVersion(): number {
  return ticketApprovalVersion;
}
