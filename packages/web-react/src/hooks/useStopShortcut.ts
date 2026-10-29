import { useEffect, useRef } from "react";
import { useConfirm } from "../components/ui/ConfirmDialog";
import { isDialogLayerOpen, resolveGlobalHotkey } from "../lib/hotkeys";

/** Esc only requests Stop. Confirmation belongs to the exact turn that opened it. */
export function useStopShortcut({ enabled, turnKey, getStopAction }: {
  enabled: boolean;
  turnKey: string;
  /** Capture an action bound to the live socket identity, not a render snapshot. */
  getStopAction: () => (() => void) | null;
}) {
  const [confirm, dialog] = useConfirm();
  const pending = useRef(false);
  const current = useRef({ enabled, turnKey, getStopAction });
  current.current = { enabled, turnKey, getStopAction };

  useEffect(() => {
    let valid = true;
    const onKey = async (event: KeyboardEvent) => {
      if (pending.current || resolveGlobalHotkey(event, {
        sending: enabled, dialogOpen: isDialogLayerOpen(),
      }) !== "stop") return;
      event.preventDefault();
      const stop = current.current.getStopAction();
      if (!stop) return;
      pending.current = true;
      try {
        const choice = await confirm({
          title: "停止当前任务？",
          body: "停止后会保留已生成的内容。已经消耗的用量仍会计费。",
          confirmText: "停止任务",
          cancelText: "继续运行",
          danger: true,
        });
        if (choice === true && valid && current.current.enabled && current.current.turnKey === turnKey) {
          stop();
        }
      } finally {
        pending.current = false;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      valid = false;
      window.removeEventListener("keydown", onKey);
    };
  }, [enabled, turnKey, confirm]);
  return dialog;
}

/** Load the shortcut with the workspace; the explicit Stop control is independent. */
export function StopShortcut(props: Parameters<typeof useStopShortcut>[0]) {
  return useStopShortcut(props);
}
