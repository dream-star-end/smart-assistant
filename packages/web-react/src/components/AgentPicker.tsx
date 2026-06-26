import { Check } from "lucide-react";
import { type Agent, AGENTS } from "../lib/agents";
import { cn } from "../lib/utils";
import { Modal } from "./ui";

export function AgentPicker({
  open,
  current,
  onClose,
  onPick,
}: {
  open: boolean;
  current: Agent;
  onClose: () => void;
  onPick: (a: Agent) => void;
}) {
  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="选择智能体"
      description="每位专家都已调校好，挑一个直接开聊。"
      className="max-w-2xl"
    >
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        {AGENTS.map((a) => {
          const active = a.id === current.id;
          return (
            <button
              key={a.id}
              onClick={() => onPick(a)}
              className={cn(
                "group flex items-start gap-3 rounded-xl border p-3.5 text-left outline-none transition-[transform,box-shadow,border-color,background-color] duration-150 ease-standard focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
                active
                  ? "border-accent bg-accent-soft"
                  : "border-border bg-surface hover:-translate-y-0.5 hover:border-border-strong hover:shadow-soft",
              )}
            >
              <span
                className={`flex size-10 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br ${a.grad} text-white shadow-sm`}
              >
                <a.icon size={19} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="text-[14.5px] font-semibold text-fg">{a.name}</span>
                  {active && <Check size={14} className="text-accent" />}
                </span>
                <span className="mt-0.5 line-clamp-2 text-[12.5px] leading-snug text-muted">
                  {a.description}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </Modal>
  );
}
