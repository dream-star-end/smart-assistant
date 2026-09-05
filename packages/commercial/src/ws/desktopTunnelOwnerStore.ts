/**
 * Shared owner directory for desktop reverse tunnels (W-05).
 *
 * The in-process mux handle still lives in MemoryDesktopTunnelRegistry.
 * This store is the cross-instance directory used for fail-loud miss
 * (`desktop_owned_elsewhere`) and crash leftover sweep.
 */

import { query, type QueryRunner } from "../db/queries.js";

export const DESKTOP_OWNER_STALE_MS = 90_000;

export interface DesktopTunnelOwnerRow {
  agentContainerId: number;
  instanceId: string;
  instanceAddr: string;
  attachedAt: Date;
  lastHeartbeatAt: Date;
  generation: number;
}

export interface DesktopTunnelOwnerStore {
  upsert(row: {
    agentContainerId: number;
    instanceId: string;
    instanceAddr: string;
    generation: number;
    attachedAt?: Date;
    lastHeartbeatAt?: Date;
  }): Promise<void>;
  deleteIfMatch(agentContainerId: number, instanceId: string, generation: number): Promise<boolean>;
  get(agentContainerId: number): Promise<DesktopTunnelOwnerRow | null>;
  sweepInstance(instanceId: string): Promise<number>;
  touchHeartbeat(
    agentContainerId: number,
    instanceId: string,
    generation: number,
    at: Date,
  ): Promise<void>;
}

export function ownerHeartbeatIsFresh(
  row: DesktopTunnelOwnerRow,
  now = Date.now(),
  staleMs = DESKTOP_OWNER_STALE_MS,
): boolean {
  return now - row.lastHeartbeatAt.getTime() <= staleMs;
}

export function createMemoryDesktopTunnelOwnerStore(): DesktopTunnelOwnerStore & {
  rows: Map<number, DesktopTunnelOwnerRow>;
} {
  const rows = new Map<number, DesktopTunnelOwnerRow>();
  return {
    rows,
    async upsert(row) {
      const now = new Date();
      rows.set(row.agentContainerId, {
        agentContainerId: row.agentContainerId,
        instanceId: row.instanceId,
        instanceAddr: row.instanceAddr,
        attachedAt: row.attachedAt ?? now,
        lastHeartbeatAt: row.lastHeartbeatAt ?? now,
        generation: row.generation,
      });
    },
    async deleteIfMatch(agentContainerId, instanceId, generation) {
      const cur = rows.get(agentContainerId);
      if (!cur || cur.instanceId !== instanceId || cur.generation !== generation) return false;
      rows.delete(agentContainerId);
      return true;
    },
    async get(agentContainerId) {
      return rows.get(agentContainerId) ?? null;
    },
    async sweepInstance(instanceId) {
      let n = 0;
      for (const [id, row] of rows) {
        if (row.instanceId === instanceId) {
          rows.delete(id);
          n += 1;
        }
      }
      return n;
    },
    async touchHeartbeat(agentContainerId, instanceId, generation, at) {
      const cur = rows.get(agentContainerId);
      if (!cur || cur.instanceId !== instanceId || cur.generation !== generation) return;
      rows.set(agentContainerId, { ...cur, lastHeartbeatAt: at });
    },
  };
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

export function createPgDesktopTunnelOwnerStore(
  runner?: QueryRunner,
): DesktopTunnelOwnerStore {
  const q = <Row extends Record<string, unknown>>(sql: string, params: ReadonlyArray<unknown> = []) =>
    runner ? runner.query<Row>(sql, params as never) : query<Row>(sql, params);

  return {
    async upsert(row) {
      await q(
        `INSERT INTO desktop_tunnel_owners (
           agent_container_id, instance_id, instance_addr, attached_at, last_heartbeat_at, generation
         ) VALUES ($1, $2, $3, COALESCE($4::timestamptz, NOW()), COALESCE($5::timestamptz, NOW()), $6)
         ON CONFLICT (agent_container_id) DO UPDATE SET
           instance_id = EXCLUDED.instance_id,
           instance_addr = EXCLUDED.instance_addr,
           attached_at = EXCLUDED.attached_at,
           last_heartbeat_at = EXCLUDED.last_heartbeat_at,
           generation = EXCLUDED.generation`,
        [
          row.agentContainerId,
          row.instanceId,
          row.instanceAddr,
          row.attachedAt ?? null,
          row.lastHeartbeatAt ?? null,
          row.generation,
        ],
      );
    },
    async deleteIfMatch(agentContainerId, instanceId, generation) {
      const r = await q(
        `DELETE FROM desktop_tunnel_owners
          WHERE agent_container_id = $1 AND instance_id = $2 AND generation = $3`,
        [agentContainerId, instanceId, generation],
      );
      return (r.rowCount ?? 0) > 0;
    },
    async get(agentContainerId) {
      const r = await q<{
        agent_container_id: string;
        instance_id: string;
        instance_addr: string;
        attached_at: Date | string;
        last_heartbeat_at: Date | string;
        generation: number;
      }>(
        `SELECT agent_container_id::text AS agent_container_id,
                instance_id, instance_addr, attached_at, last_heartbeat_at, generation
           FROM desktop_tunnel_owners
          WHERE agent_container_id = $1`,
        [agentContainerId],
      );
      const row = r.rows[0];
      if (!row) return null;
      return {
        agentContainerId: Number(row.agent_container_id),
        instanceId: row.instance_id,
        instanceAddr: row.instance_addr,
        attachedAt: asDate(row.attached_at),
        lastHeartbeatAt: asDate(row.last_heartbeat_at),
        generation: Number(row.generation),
      };
    },
    async sweepInstance(instanceId) {
      const r = await q(
        `DELETE FROM desktop_tunnel_owners WHERE instance_id = $1`,
        [instanceId],
      );
      return r.rowCount ?? 0;
    },
    async touchHeartbeat(agentContainerId, instanceId, generation, at) {
      await q(
        `UPDATE desktop_tunnel_owners
            SET last_heartbeat_at = $4
          WHERE agent_container_id = $1 AND instance_id = $2 AND generation = $3`,
        [agentContainerId, instanceId, generation, at],
      );
    },
  };
}
