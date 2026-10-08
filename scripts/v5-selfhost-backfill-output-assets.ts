#!/usr/bin/env tsx
/**
 * One-off backfill (M1): copy session-output assets that the container output
 * collector wrote into its own local SQLite into the master PG, where the web
 * UI reads them. Before the collector fix they were invisible.
 *
 * Dry-run by default: reads both stores and writes a JSON report. --apply
 * inserts, in one transaction, only the rows the dry-run classified as
 * `insert`. Nothing is updated or deleted, in either store. Re-running is a
 * no-op for rows already present (same id, or same container path for the
 * tenant). Reversal: DELETE the ids listed under `inserted` in the report.
 *
 * Project: the session's current chat project in PG. That is the best
 * available attribution for history (no move log exists); rows whose asset
 * predates the project are counted under `assetOlderThanProject` so the
 * report shows how much of it is retrospective grouping.
 *
 * Usage (on the host; DATABASE_URL from the env file, never printed):
 *   DATABASE_URL=... npx tsx scripts/v5-selfhost-backfill-output-assets.ts \
 *     --container-db <snapshot of volume/sessions.db> --volume-root <volume> \
 *     --tenant c:3 [--container-user default] --report <file.json> [--apply]
 */
import { existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import pg from "pg";

const GENERATED_PREFIX = "/home/agent/.openclaude/generated/";
const CONTAINER_HOME = "/home/agent/.openclaude";
const PER_PROJECT_LIMIT = 500;

interface Args {
  containerDb: string;
  volumeRoot: string;
  tenant: string;
  containerUser: string;
  report: string;
  apply: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const containerDb = get("--container-db");
  const volumeRoot = get("--volume-root");
  const tenant = get("--tenant");
  const report = get("--report");
  if (!containerDb || !volumeRoot || !tenant || !report) {
    throw new Error("required: --container-db --volume-root --tenant --report");
  }
  if (!/^c:[0-9]+$/.test(tenant)) throw new Error("--tenant must look like c:<uid>");
  return {
    containerDb,
    volumeRoot,
    tenant,
    containerUser: get("--container-user") ?? "default",
    report,
    apply: argv.includes("--apply"),
  };
}

interface ContainerRow {
  id: string;
  user_id: string;
  session_id: string | null;
  name: string;
  url: string | null;
  container_path: string | null;
  mime: string | null;
  size_bytes: number | null;
  digest: string | null;
  excerpt: string | null;
  created_at: number;
  updated_at: number;
}

type Outcome =
  | "insert"
  | "already_registered"
  | "file_missing"
  | "bad_path"
  | "no_session"
  | "session_missing"
  | "session_foreign"
  | "session_deleted"
  | "project_limit";

interface Planned {
  row: ContainerRow;
  outcome: Outcome;
  projectId: string | null;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");

  // Pass a snapshot (sqlite3 <live> ".backup <snapshot>"), not the live file:
  // the container keeps writing it, and the snapshot doubles as the backup.
  const sqlite = new Database(args.containerDb, { readonly: true, fileMustExist: true });
  const rows = sqlite
    .prepare(
      `SELECT id, user_id, session_id, name, url, container_path, mime, size_bytes, digest, excerpt, created_at, updated_at
         FROM project_assets
        WHERE source = 'output' AND deleted_at IS NULL AND user_id = ?
        ORDER BY created_at`,
    )
    .all(args.containerUser) as ContainerRow[];
  const otherUsers = sqlite
    .prepare(`SELECT user_id, count(*) AS n FROM project_assets WHERE source = 'output' AND user_id <> ? GROUP BY user_id`)
    .all(args.containerUser) as Array<{ user_id: string; n: number }>;
  sqlite.close();

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const sessionIds = [...new Set(rows.map((r) => r.session_id).filter((s): s is string => Boolean(s)))];
    const sessions = new Map<string, { user_id: string; project_id: string | null; deleted_at: string | null }>();
    if (sessionIds.length > 0) {
      const res = await client.query(
        "SELECT id, user_id, project_id, deleted_at FROM client_sessions WHERE id = ANY($1::text[])",
        [sessionIds],
      );
      for (const r of res.rows) sessions.set(r.id, r);
    }
    const projects = new Map<string, { name: string; created_at: string }>();
    for (const r of (
      await client.query(
        "SELECT id, name, created_at FROM chat_projects WHERE user_id = $1 AND deleted_at IS NULL",
        [args.tenant],
      )
    ).rows) {
      projects.set(r.id, { name: r.name, created_at: r.created_at });
    }
    const existing = await client.query(
      "SELECT id, container_path FROM project_assets WHERE user_id = $1 AND source = 'output' AND deleted_at IS NULL",
      [args.tenant],
    );
    const existingIds = new Set(existing.rows.map((r) => r.id as string));
    const existingPaths = new Set(existing.rows.map((r) => r.container_path as string | null).filter(Boolean));
    const projectCounts = new Map<string | null, number>();
    for (const r of (
      await client.query(
        "SELECT project_id, count(*)::int AS n FROM project_assets WHERE user_id = $1 AND deleted_at IS NULL GROUP BY project_id",
        [args.tenant],
      )
    ).rows) {
      projectCounts.set(r.project_id, r.n);
    }

    const plan: Planned[] = [];
    const seenPaths = new Set<string>();
    for (const row of rows) {
      const p = row.container_path;
      if (!p || !p.startsWith(GENERATED_PREFIX) || p.includes("..")) {
        plan.push({ row, outcome: "bad_path", projectId: null });
        continue;
      }
      if (existingIds.has(row.id) || existingPaths.has(p) || seenPaths.has(p)) {
        plan.push({ row, outcome: "already_registered", projectId: null });
        continue;
      }
      const onDisk = join(args.volumeRoot, p.slice(CONTAINER_HOME.length));
      if (!existsSync(onDisk) || !statSync(onDisk).isFile()) {
        plan.push({ row, outcome: "file_missing", projectId: null });
        continue;
      }
      if (!row.session_id) {
        plan.push({ row, outcome: "no_session", projectId: null });
        continue;
      }
      const sess = sessions.get(row.session_id);
      if (!sess) {
        plan.push({ row, outcome: "session_missing", projectId: null });
        continue;
      }
      if (sess.user_id !== args.tenant) {
        plan.push({ row, outcome: "session_foreign", projectId: null });
        continue;
      }
      if (sess.deleted_at != null) {
        plan.push({ row, outcome: "session_deleted", projectId: null });
        continue;
      }
      const projectId = sess.project_id && projects.has(sess.project_id) ? sess.project_id : null;
      const count = projectCounts.get(projectId) ?? 0;
      if (count >= PER_PROJECT_LIMIT) {
        plan.push({ row, outcome: "project_limit", projectId });
        continue;
      }
      projectCounts.set(projectId, count + 1);
      seenPaths.add(p);
      plan.push({ row, outcome: "insert", projectId });
    }

    const toInsert = plan.filter((x) => x.outcome === "insert");
    const outcomes: Record<string, number> = {};
    for (const x of plan) outcomes[x.outcome] = (outcomes[x.outcome] ?? 0) + 1;
    const byProject: Record<string, { name: string | null; count: number; assetOlderThanProject: number }> = {};
    for (const x of toInsert) {
      const key = x.projectId ?? "(未分类)";
      const proj = x.projectId ? projects.get(x.projectId) : undefined;
      const entry = (byProject[key] ??= { name: proj?.name ?? null, count: 0, assetOlderThanProject: 0 });
      entry.count += 1;
      if (proj && Number(x.row.created_at) < Number(proj.created_at)) entry.assetOlderThanProject += 1;
    }

    let inserted: string[] = [];
    if (args.apply && toInsert.length > 0) {
      await client.query("BEGIN");
      try {
        for (const x of toInsert) {
          const r = x.row;
          const res = await client.query(
            `INSERT INTO project_assets (
               id, user_id, project_id, source, session_id, name, url, container_path,
               mime, size_bytes, digest, excerpt, pinned, created_at, updated_at, deleted_at
             ) VALUES ($1,$2,$3,'output',$4,$5,$6,$7,$8,$9,$10,$11,FALSE,$12,$13,NULL)
             ON CONFLICT (id) DO NOTHING
             RETURNING id`,
            [
              r.id, args.tenant, x.projectId, r.session_id, r.name, r.url, r.container_path,
              r.mime, r.size_bytes, r.digest, r.excerpt, r.created_at, r.updated_at,
            ],
          );
          if (res.rowCount === 1) inserted.push(r.id);
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        inserted = [];
        throw err;
      }
    }

    const report = {
      mode: args.apply ? "apply" : "dry-run",
      at: new Date().toISOString(),
      tenant: args.tenant,
      containerUser: args.containerUser,
      containerRows: rows.length,
      skippedOtherContainerUsers: otherUsers,
      outcomes,
      byProject,
      wouldInsert: toInsert.length,
      inserted,
      reversal: inserted.length > 0
        ? "DELETE FROM project_assets WHERE user_id = '<tenant>' AND id = ANY('<inserted ids>')"
        : null,
      rows: plan.map((x) => ({
        id: x.row.id,
        sessionId: x.row.session_id,
        name: x.row.name,
        outcome: x.outcome,
        projectId: x.projectId,
      })),
    };
    writeFileSync(args.report, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    console.log(JSON.stringify({ mode: report.mode, containerRows: rows.length, outcomes, byProject, inserted: inserted.length }));
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(`[backfill-output-assets] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
