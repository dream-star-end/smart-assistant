export type GlobalHotkeyAction = "search" | "new" | "stop" | null;

function isEditableTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

/** 全局快捷键分派：⌘K 搜索、⌘⇧O 新建、Esc(生成中)停止。 */
export function resolveGlobalHotkey(
  e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "target">,
  opts: { sending?: boolean } = {},
): GlobalHotkeyAction {
  if (e.key === "Escape" && opts.sending) return "stop";
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return null;
  if ((e.key === "k" || e.key === "K") && !e.shiftKey) {
    if (isEditableTarget(e.target)) return null;
    return "search";
  }
  if ((e.key === "o" || e.key === "O") && e.shiftKey) {
    if (isEditableTarget(e.target)) return null;
    return "new";
  }
  return null;
}
