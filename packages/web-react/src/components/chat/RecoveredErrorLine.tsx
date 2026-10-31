/** A server-proven recovered step is history, with no action or new retry. */
export function RecoveredErrorLine({ code, detail }: { code: string; detail?: string }) {
  const labels: Record<string, string> = {
    network_error: "网络波动，本轮已恢复",
    rate_limited: "服务繁忙，本轮已恢复",
    box_capacity_held: "上一轮收尾占用已解除，本轮已继续",
    platform_credential_expired: "访问凭证已更新，本轮已继续",
    service_restart: "服务已恢复，本轮已继续",
  };
  return (
    <output
      className="mt-2 block text-meta text-faint"
      data-testid="automatic-recovery-record"
      title={[code, detail].filter(Boolean).join("\n")}
    >
      {labels[code] ?? "服务短暂中断，本轮已恢复"}
    </output>
  );
}
