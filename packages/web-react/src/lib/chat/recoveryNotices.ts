/** User-facing reasons for rejected server-authoritative recovery. */
/** Human feedback for a server-authoritative recovery rejection. Keep the
 * optimistic child disposable, but never make the user's click look inert. */
export function recoverySkippedNotice(reason?: string): string {
  switch (reason) {
    case "source_not_latest":
      return "未从断点继续：会话已有更新，原任务仍已保留。请在最新消息后再试。";
    case "source_not_recoverable":
    case "source_tape_completed":
      return "未从断点继续：服务端没有确认到可恢复的中断断点，原任务仍已保留。";
    case "completed_replay_forbidden":
    case "automatic_replay_not_proven":
    case "source_not_safely_replayable":
      return "没有重放原请求：服务端无法证明它尚未执行。原任务仍已保留，可从已保存的断点继续。";
    case "source_tape_malformed":
      return "没法从保存的进度继续。任务内容还在，请刷新后再试。";
    case "recovery_mode_mismatch":
      return "没法从断点继续。这句没有发出去，点重试再发一次。";
    case "automatic_checkpoint_unsafe":
      return "自动续跑已跳过。这句没有发出去，请手动从进度继续，或点重试再发一次。";
    case "automatic_retry_exhausted":
      return "自动恢复已达到次数上限，原任务仍已保留。请在错误卡上手动重试。";
    case "capability_unavailable":
      return "暂时无法从断点继续：当前服务版本不支持这次恢复。原任务仍已保留，请刷新后再试。";
    case "invalid_lineage":
    case "identity_mismatch":
    case "identity_reused":
    case "automatic_lineage_mismatch":
    case "automatic_attempt_mismatch":
      return "未从断点继续：这次恢复请求已经过期或与当前会话不一致。原任务仍已保留，请刷新后再试。";
    case "INSUFFICIENT_CREDITS":
    case "ERR_INSUFFICIENT_CREDITS":
    case "insufficient_credits":
      return "自动恢复已暂停：账户可用积分不足，原任务仍已保留。请充值后在错误卡上继续。";
    case "UNAUTHORIZED_MODEL":
    case "MODEL_NOT_AVAILABLE":
    case "ERR_MODEL_UNAUTHORIZED":
    case "antigravity_authority_rejected":
      return "自动恢复已暂停：当前模型不可用或无权限，原任务仍已保留。请切换模型后继续。";
    default:
      return "未从断点继续：服务端安全校验未通过。原任务仍已保留，请刷新后再试。";
  }
}
