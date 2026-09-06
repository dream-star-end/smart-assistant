import { describe, expect, test } from "vitest";
import { resolveGlobalHotkey } from "./hotkeys";

function key(
  over: Partial<KeyboardEvent> & Pick<KeyboardEvent, "key">,
): Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "target"> {
  return {
    key: over.key,
    metaKey: over.metaKey ?? false,
    ctrlKey: over.ctrlKey ?? false,
    shiftKey: over.shiftKey ?? false,
    target: over.target ?? document.body,
  };
}

describe("resolveGlobalHotkey", () => {
  test("⌘/Ctrl+K 搜索，不触发新建", () => {
    expect(resolveGlobalHotkey(key({ key: "k", metaKey: true }))).toBe("search");
    expect(resolveGlobalHotkey(key({ key: "K", ctrlKey: true }))).toBe("search");
  });

  test("⌘/Ctrl+Shift+O 新建会话", () => {
    expect(resolveGlobalHotkey(key({ key: "o", metaKey: true, shiftKey: true }))).toBe("new");
    expect(resolveGlobalHotkey(key({ key: "O", ctrlKey: true, shiftKey: true }))).toBe("new");
  });

  test("Esc 仅在生成中停止", () => {
    expect(resolveGlobalHotkey(key({ key: "Escape" }))).toBeNull();
    expect(resolveGlobalHotkey(key({ key: "Escape" }), { sending: true })).toBe("stop");
  });

  test("输入框内忽略搜索/新建", () => {
    const input = document.createElement("input");
    expect(resolveGlobalHotkey(key({ key: "k", metaKey: true, target: input }))).toBeNull();
    expect(
      resolveGlobalHotkey(key({ key: "o", metaKey: true, shiftKey: true, target: input })),
    ).toBeNull();
  });
});
