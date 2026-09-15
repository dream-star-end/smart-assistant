export type GlobalHotkeyAction = "search" | "new" | "stop" | "find" | null;

function isEditableTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

/** 弹层(Radix Dialog / AlertDialog / DropdownMenu)在 DOM 里的落点。Esc 归它们时全局不接管。 */
export const DIALOG_LAYER_SELECTOR = '[role="dialog"],[role="alertdialog"],[role="menu"]';

/** 此刻是否有弹层打开(Esc 的第一持有方)。SSR / 无 document 时视为没有。 */
export function isDialogLayerOpen(
  doc: Pick<Document, "querySelector"> | null | undefined = globalThis.document,
): boolean {
  return Boolean(doc?.querySelector(DIALOG_LAYER_SELECTOR));
}

/**
 * 全局快捷键分派：⌘K 搜索、⌘⇧O 新建、Esc(生成中)停止。
 *
 * Esc 有两个持有方:Radix 弹层的「关闭」与这里的「停止生成」。弹层打开时 Esc 只该关弹层 ——
 * 否则用户在生成中打开任意对话框再按 Esc 关掉,会连带掐掉正在生成的这一轮。
 * `dialogOpen` 由调用方在事件发生时刻算出(见 isDialogLayerOpen),这里只做纯判断。
 */
export function resolveGlobalHotkey(
  e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "target">,
  opts: { sending?: boolean; dialogOpen?: boolean } = {},
): GlobalHotkeyAction {
  if (e.key === "Escape") return opts.sending && !opts.dialogOpen ? "stop" : null;
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
  if ((e.key === "f" || e.key === "F") && !e.shiftKey) {
    if (isEditableTarget(e.target)) return null;
    return "find";
  }
  return null;
}
