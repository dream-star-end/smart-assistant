import { useEffect, useRef } from "react";
import { useConfirm } from "../components/ui/ConfirmDialog";
import { isDialogLayerOpen, resolveGlobalHotkey } from "../lib/hotkeys";

/** Esc only requests Stop. Confirmation belongs to the exact turn that opened it. */
export function useStopShortcut({ enabled, turnKey, onStop }: {
  enabled: boolean;
  turnKey: string;
  onStop: () => void;
}) {
  const [confirm, dialog] = useConfirm();
  const pending = useRef(false);
  const current = useRef({ enabled, turnKey, onStop });
  current.current = { enabled, turnKey, onStop };

  useEffect(() => {
    let valid = true;
    const onKey = async (event: KeyboardEvent) => {
      if (pending.current || resolveGlobalHotkey(event, {
        sending: enabled, dialogOpen: isDialogLayerOpen(),
      }) !== "stop") return;
      event.preventDefault();
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
          current.current.onStop();
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
