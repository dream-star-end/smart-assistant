import { Alert, Button } from "../ui";

export function TurnCostReminder({
  credits,
  onStop,
}: {
  credits: string;
  onStop: () => void;
}) {
  return (
    <Alert
      tone="warning"
      density="compact"
      title="本轮消费提醒"
      action={
        <Button size="sm" variant="secondary" onClick={onStop}>
          停止本轮
        </Button>
      }
    >
      本轮多步骤任务已累计消耗 {credits} 积分，任务仍在继续。
    </Alert>
  );
}
