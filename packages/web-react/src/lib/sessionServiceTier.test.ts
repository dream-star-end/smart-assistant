import { afterEach, describe, expect, test, vi } from "vitest";
import {
  clearSessionServiceTier,
  readSessionServiceTier,
  serviceTierSessionKey,
  subscribeSessionServiceTier,
  writeSessionServiceTier,
} from "./sessionServiceTier";

afterEach(() => {
  localStorage.clear();
});

describe("sessionServiceTier", () => {
  test("clearSessionServiceTier removes stored key for deleted session", () => {
    writeSessionServiceTier("s1", "ultrafast");
    expect(readSessionServiceTier("s1")).toBe("ultrafast");
    clearSessionServiceTier("s1");
    expect(readSessionServiceTier("s1")).toBeNull();
    expect(localStorage.getItem(serviceTierSessionKey("s1"))).toBeNull();
  });

  test("subscribeSessionServiceTier propagates cross-tab storage changes for the same session only", () => {
    const onChange = vi.fn();
    const unsub = subscribeSessionServiceTier("s1", onChange);

    window.dispatchEvent(
      new StorageEvent("storage", {
        key: serviceTierSessionKey("s2"),
        newValue: "fast",
      }),
    );
    expect(onChange).not.toHaveBeenCalled();

    window.dispatchEvent(
      new StorageEvent("storage", {
        key: serviceTierSessionKey("s1"),
        newValue: "ultrafast",
      }),
    );
    expect(onChange).toHaveBeenCalledWith("ultrafast");

    window.dispatchEvent(
      new StorageEvent("storage", {
        key: serviceTierSessionKey("s1"),
        newValue: null,
      }),
    );
    expect(onChange).toHaveBeenCalledWith(null);

    unsub();
  });
});
