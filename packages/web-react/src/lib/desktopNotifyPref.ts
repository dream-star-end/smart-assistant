export type DesktopNotifyPermission = NotificationPermission | "unsupported";

export type DesktopNotifyState = {
  enabled: boolean;
  permission: DesktopNotifyPermission;
};

type ToggleHandler = (next: boolean) => Promise<void> | void;

const listeners = new Set<(state: DesktopNotifyState) => void>();
let currentState: DesktopNotifyState = {
  enabled: false,
  permission: typeof Notification === "undefined" ? "unsupported" : Notification.permission,
};
let activeToggleHandler: ToggleHandler | null = null;

export function getDesktopNotifyState(): DesktopNotifyState {
  return currentState;
}

export function publishDesktopNotifyState(next: DesktopNotifyState): void {
  if (currentState.enabled === next.enabled && currentState.permission === next.permission) return;
  currentState = next;
  for (const fn of listeners) fn(currentState);
}

export function registerDesktopNotifyToggle(handler: ToggleHandler | null): () => void {
  activeToggleHandler = handler;
  return () => {
    if (activeToggleHandler === handler) activeToggleHandler = null;
  };
}

export async function requestDesktopNotifyToggle(next: boolean): Promise<void> {
  if (activeToggleHandler) {
    await activeToggleHandler(next);
  }
}

export function subscribeDesktopNotifyState(
  fn: (state: DesktopNotifyState) => void,
): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
