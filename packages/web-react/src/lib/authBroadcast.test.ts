import { afterEach, expect, test, vi } from "vitest";
import { publishAuthLogout, subscribeAuthLogout } from "./authBroadcast";

class StubBroadcastChannel {
  static instances: StubBroadcastChannel[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  posted: unknown[] = [];
  closed = false;

  constructor(readonly name: string) {
    StubBroadcastChannel.instances.push(this);
  }

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  close(): void {
    this.closed = true;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  StubBroadcastChannel.instances = [];
});

test("logout signal uses BroadcastChannel without carrying credentials", () => {
  vi.stubGlobal("BroadcastChannel", StubBroadcastChannel);
  const received = vi.fn();
  const unsubscribe = subscribeAuthLogout(received);

  publishAuthLogout();
  const channel = StubBroadcastChannel.instances[0];
  expect(channel.name).toBe("oc-auth");
  expect(channel.posted).toHaveLength(1);
  expect(channel.posted[0]).toMatchObject({ type: "logout" });
  expect(JSON.stringify(channel.posted[0])).not.toMatch(/token|credential/i);

  channel.onmessage?.({ data: { type: "logout", senderTabId: "other-tab", ts: Date.now() } } as MessageEvent);
  expect(received).toHaveBeenCalledTimes(1);
  unsubscribe();
  expect(channel.closed).toBe(true);
});

test("BroadcastChannel unavailable falls back to a token-free storage event", () => {
  vi.stubGlobal("BroadcastChannel", undefined);
  const setItem = vi.spyOn(Storage.prototype, "setItem");
  const removeItem = vi.spyOn(Storage.prototype, "removeItem");
  const received = vi.fn();
  const unsubscribe = subscribeAuthLogout(received);

  publishAuthLogout();
  expect(setItem).toHaveBeenCalledWith("oc_auth_logout_signal", expect.any(String));
  expect(removeItem).toHaveBeenCalledWith("oc_auth_logout_signal");
  expect(setItem.mock.calls[0]?.[1]).toMatch(/^\d+$/);
  window.dispatchEvent(
    new StorageEvent("storage", { key: "oc_auth_logout_signal", newValue: String(Date.now()) }),
  );
  expect(received).toHaveBeenCalledTimes(1);
  unsubscribe();
});
