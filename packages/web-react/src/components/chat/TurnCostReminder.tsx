import { Alert } from "../ui";

export function TurnCostReminder({ credits }: { credits: string }) {
  return (
    <Alert
      tone="warning"
      density="compact"
      title="本轮消费提醒"
    >
      本轮多步骤任务已累计消耗 {credits} 积分，任务仍在继续。
    </Alert>
  );
}
