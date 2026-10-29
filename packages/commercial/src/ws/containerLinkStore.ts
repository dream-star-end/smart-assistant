import { DISPATCH_LEASE_TTL_MS, type Queryable, type TurnDispatchRow } from "../dispatch/turnDispatchStore.js";

/** Renew one observed attempt; never revive terminal/rejecting or a replacement carrier. */
export async function renewContainerLinkLease(
  pool: Queryable, uid: bigint, containerId: number, row: Pick<TurnDispatchRow, "dispatchId" | "attemptNo" | "leaseEpoch">,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE turn_dispatches -- container_link_heartbeat
        SET lease_until = NOW() + ($6::bigint * INTERVAL '1 millisecond'),
            last_attempt_at = NOW()
      WHERE dispatch_id = $1 AND user_id = $2 AND agent_container_id = $3
        AND attempt_no = $4 AND lease_epoch = $5
        AND status IN ('admitted', 'accepted') AND terminal_at IS NULL`,
    [row.dispatchId, uid.toString(), containerId, row.attemptNo, String(row.leaseEpoch), DISPATCH_LEASE_TTL_MS],
  );
  return result.rowCount === 1;
}
