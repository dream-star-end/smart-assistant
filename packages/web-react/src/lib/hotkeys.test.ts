import { describe, expect, test } from "vitest";
import { isDialogLayerOpen, resolveGlobalHotkey } from "./hotkeys";

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

  test("Esc 归弹层:生成中但有对话框/菜单打开时不停止(S-02)", () => {
    expect(resolveGlobalHotkey(key({ key: "Escape" }), { sending: true, dialogOpen: true })).toBeNull();
    expect(resolveGlobalHotkey(key({ key: "Escape" }), { sending: true, dialogOpen: false })).toBe("stop");
    // 未生成时不论弹层与否都不接管
    expect(resolveGlobalHotkey(key({ key: "Escape" }), { sending: false, dialogOpen: true })).toBeNull();
  });

  test("isDialogLayerOpen 只认 dialog / alertdialog / menu,不把 toast 的 alert/status 当弹层", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    try {
      host.innerHTML = '<div role="status">已保存</div><div role="alert">失败</div>';
      expect(isDialogLayerOpen(document)).toBe(false);
      host.innerHTML = '<div role="dialog">x</div>';
      expect(isDialogLayerOpen(document)).toBe(true);
      host.innerHTML = '<div role="alertdialog">x</div>';
      expect(isDialogLayerOpen(document)).toBe(true);
      host.innerHTML = '<div role="menu">x</div>';
      expect(isDialogLayerOpen(document)).toBe(true);
      expect(isDialogLayerOpen(null)).toBe(false);
    } finally {
      host.remove();
    }
  });

  test("输入框内忽略搜索/新建", () => {
    const input = document.createElement("input");
    expect(resolveGlobalHotkey(key({ key: "k", metaKey: true, target: input }))).toBeNull();
    expect(
      resolveGlobalHotkey(key({ key: "o", metaKey: true, shiftKey: true, target: input })),
    ).toBeNull();
  });

  test("⌘/Ctrl+F 会话内查找，输入框内忽略，Shift 不触发", () => {
    expect(resolveGlobalHotkey(key({ key: "f", metaKey: true }))).toBe("find");
    expect(resolveGlobalHotkey(key({ key: "F", ctrlKey: true }))).toBe("find");
    expect(resolveGlobalHotkey(key({ key: "f", metaKey: true, shiftKey: true }))).toBeNull();
    const input = document.createElement("input");
    expect(resolveGlobalHotkey(key({ key: "f", metaKey: true, target: input }))).toBeNull();
  });
});
