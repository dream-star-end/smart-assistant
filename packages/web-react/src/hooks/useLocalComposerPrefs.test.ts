import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import {
  COMPOSER_PREFS_STORAGE_KEY,
  useLocalComposerPrefs,
} from "./useLocalComposerPrefs";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("useLocalComposerPrefs", () => {
  test("默认 sendKey=enter、fontSize=default", () => {
    const { result } = renderHook(() => useLocalComposerPrefs());
    expect(result.current.sendKey).toBe("enter");
    expect(result.current.fontSize).toBe("default");
  });

  test("从 localStorage 读取已保存偏好", () => {
    localStorage.setItem(
      COMPOSER_PREFS_STORAGE_KEY,
      JSON.stringify({ sendKey: "mod-enter", fontSize: "large" }),
    );
    const { result } = renderHook(() => useLocalComposerPrefs());
    expect(result.current.sendKey).toBe("mod-enter");
    expect(result.current.fontSize).toBe("large");
  });

  test("非法 JSON / 非法枚举回落到默认", () => {
    localStorage.setItem(COMPOSER_PREFS_STORAGE_KEY, "{not-json");
    const badJson = renderHook(() => useLocalComposerPrefs());
    expect(badJson.result.current.sendKey).toBe("enter");
    expect(badJson.result.current.fontSize).toBe("default");
    badJson.unmount();

    localStorage.setItem(
      COMPOSER_PREFS_STORAGE_KEY,
      JSON.stringify({ sendKey: "space", fontSize: "tiny" }),
    );
    const badEnum = renderHook(() => useLocalComposerPrefs());
    expect(badEnum.result.current.sendKey).toBe("enter");
    expect(badEnum.result.current.fontSize).toBe("default");
  });

  test("setSendKey / setFontSize 落盘并广播到另一处 hook", () => {
    const a = renderHook(() => useLocalComposerPrefs());
    const b = renderHook(() => useLocalComposerPrefs());
    act(() => {
      a.result.current.setSendKey("mod-enter");
      a.result.current.setFontSize("large");
    });
    expect(b.result.current.sendKey).toBe("mod-enter");
    expect(b.result.current.fontSize).toBe("large");
    expect(JSON.parse(localStorage.getItem(COMPOSER_PREFS_STORAGE_KEY) ?? "{}")).toEqual({
      sendKey: "mod-enter",
      fontSize: "large",
    });
  });
});
