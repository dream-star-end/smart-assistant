import { afterEach, describe, expect, test, vi } from "vitest";
import {
  dismissPermissionUi,
  isDocumentForeground,
  markPermissionDisplayed,
  reopenPermissionUi,
  resetPermissionPopupCoordinator,
  shouldAutoOpenPermission,
  yieldActiveModal,
} from "./permissionPopupCoordinator";

afterEach(() => {
  resetPermissionPopupCoordinator();
  vi.unstubAllGlobals();
});

describe("permissionPopupCoordinator", () => {
  test("foreground live prompts auto-open until dismissed or displayed", () => {
    expect(shouldAutoOpenPermission({ requestId: "r1", livePrompt: true })).toBe(true);
    markPermissionDisplayed("r1");
    expect(shouldAutoOpenPermission({ requestId: "r1", livePrompt: true })).toBe(false);
    dismissPermissionUi("r1");
    expect(shouldAutoOpenPermission({ requestId: "r1", livePrompt: true })).toBe(false);
    reopenPermissionUi("r1");
    expect(shouldAutoOpenPermission({ requestId: "r1", livePrompt: true })).toBe(true);
  });

  test("only one modal auto-opens at a time", () => {
    markPermissionDisplayed("first");
    expect(shouldAutoOpenPermission({ requestId: "second", livePrompt: true })).toBe(false);
  });

  test("background tabs do not auto-open and do not mark displayed", () => {
    vi.stubGlobal("document", { visibilityState: "hidden" });
    expect(isDocumentForeground()).toBe(false);
    expect(shouldAutoOpenPermission({ requestId: "bg", livePrompt: true })).toBe(false);
    markPermissionDisplayed("bg");
    vi.stubGlobal("document", { visibilityState: "visible" });
    expect(shouldAutoOpenPermission({ requestId: "bg", livePrompt: true })).toBe(true);
  });

  test("non-live prompts never auto-open", () => {
    expect(shouldAutoOpenPermission({ requestId: "hist", livePrompt: false })).toBe(false);
  });

  test("yielding a settled modal lets the next request auto-open", () => {
    markPermissionDisplayed("first");
    expect(shouldAutoOpenPermission({ requestId: "second", livePrompt: true })).toBe(false);
    yieldActiveModal("first");
    expect(shouldAutoOpenPermission({ requestId: "second", livePrompt: true })).toBe(true);
  });
});
