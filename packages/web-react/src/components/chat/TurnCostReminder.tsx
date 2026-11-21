import { Coins } from "lucide-react";
import { Alert } from "../ui";

export function TurnCostReminder({ credits }: { credits: string }) {
  return (
    <Alert
      tone="warning"
      density="compact"
      className="oc-callout shadow-soft"
      icon={
        <span className="oc-icon-badge oc-icon-badge-warning flex size-6 items-center justify-center rounded-md">
          <Coins size={13} strokeWidth={1.75} />
        </span>
      }
      title="本轮消费提醒"
    >
      本轮多步骤任务已累计消耗 <span className="font-mono font-semibold tabular-nums text-fg">{credits}</span> 积分，任务仍在继续。
    </Alert>
  );
}
