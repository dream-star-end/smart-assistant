#!/usr/bin/env python3
"""Host-side READ ONLY snapshot for OCV5 project-layer dry-run.

No DATABASE_URL in the container. Talks to:
  - sudo -u postgres psql -d openclaude_v5_selfhost  (uid3 sessions/usage/assets)
  - uid3 docker volume + docker exec                 (cron.yaml / taskboard / projects)

Never INSERT/UPDATE/DELETE user tables. Temp tables are rolled back.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import stat
import subprocess
import sys
from pathlib import Path

DB = "openclaude_v5_selfhost"
USER_ID = "c:3"
USAGE_USER = "3"
OCV5 = "852859fa-cf1d-481c-96fd-23f2966b8b5f"
UID3_VOL = "/var/lib/docker/volumes/oc-v5-data-u3/_data"
ID_RE = re.compile(r"^[A-Za-z0-9._:-]{8,80}$")


def sh(args: list[str], stdin: str | None = None, check: bool = True) -> str:
    p = subprocess.run(
        args,
        input=stdin,
        text=True,
        capture_output=True,
        check=False,
    )
    if check and p.returncode != 0:
        raise RuntimeError(f"{args[0]} failed: {p.stderr.strip() or p.stdout.strip()}")
    return p.stdout


def psql(sql: str) -> str:
    return sh(
        ["sudo", "-u", "postgres", "psql", "-d", DB, "-v", "ON_ERROR_STOP=1", "-A", "-t", "-q", "-c", sql],
        check=True,
    )


def sql_text_array(ids: list[str]) -> str:
    return "ARRAY[" + ",".join("'" + i.replace("'", "''") + "'" for i in ids) + "]::text[]"


def clean_ids(raw: list[str]) -> list[str]:
    out = []
    for x in raw:
        s = str(x).strip()
        if ID_RE.match(s):
            out.append(s)
    return out


def json_or_empty(text: str):
    t = text.strip()
    if not t or t == "":
        return []
    return json.loads(t)


def pg_has_usage_board_col() -> bool:
    out = psql(
        "SELECT COUNT(*) FROM information_schema.columns "
        "WHERE table_name='usage_records' AND column_name='board_project_id';"
    ).strip()
    return out == "1"


def query_sessions(ids: list[str]) -> list[dict]:
    if not ids:
        return []
    arr = sql_text_array(ids)
    sql = f"""
SELECT COALESCE(json_agg(row_to_json(t) ORDER BY t.id), '[]'::json)
FROM (
  SELECT cs.id,
         cs.project_id AS "projectId",
         cs.updated_at AS "updatedAt",
         cs.deleted_at AS "deletedAt",
         cs.archived_at AS "archivedAt",
         cs.user_id AS "userId"
    FROM client_sessions cs
   WHERE cs.user_id = '{USER_ID}'
     AND cs.id = ANY({arr})
) t;
"""
    return json_or_empty(psql(sql))


def query_chat_projects() -> list[dict]:
    sql = f"""
SELECT COALESCE(json_agg(row_to_json(t) ORDER BY t.id), '[]'::json)
FROM (
  SELECT id, name, board_project_id AS "boardProjectId",
         deleted_at AS "deletedAt"
    FROM chat_projects
   WHERE user_id = '{USER_ID}'
) t;
"""
    return json_or_empty(psql(sql))


def query_usage(ids: list[str], has_board: bool) -> list[dict]:
    if not ids:
        return []
    board_cols = (
        "ur.board_project_id AS \"boardProjectId\", ur.board_project_source AS source"
        if has_board
        else "NULL::text AS \"boardProjectId\", NULL::text AS source"
    )
    board_null = " AND ur.board_project_id IS NULL" if has_board else ""
    arr = sql_text_array(ids)
    sql = f"""
SELECT COALESCE(json_agg(row_to_json(t) ORDER BY t.id), '[]'::json)
FROM (
  SELECT ur.id::text AS id,
         ur.session_id AS "sessionId",
         ur.parent_session_id AS "parentSessionId",
         {board_cols},
         ur.status
    FROM usage_records ur
   WHERE ur.user_id = {USAGE_USER}::bigint
     AND ur.status = 'success'
     {board_null}
     AND (
       ur.session_id = ANY({arr})
       OR ur.parent_session_id = ANY({arr})
     )
) t;
"""
    return json_or_empty(psql(sql))


def query_assets() -> list[dict]:
    sql = f"""
SELECT COALESCE(json_agg(row_to_json(t) ORDER BY t.id), '[]'::json)
FROM (
  SELECT id, name, session_id AS "sessionId",
         container_path AS "containerPath", digest, project_id AS "projectId",
         pinned, deleted_at AS "deletedAt", source
    FROM project_assets
   WHERE user_id = '{USER_ID}'
) t;
"""
    return json_or_empty(psql(sql))


def read_cron() -> list[dict]:
    raw = sh(["docker", "exec", "oc-v5-u3", "cat", "/home/agent/.openclaude/cron.yaml"], check=False)
    jobs = []
    cur: dict | None = None
    for line in raw.splitlines():
        if re.match(r"^\s*-\s+id:", line):
            if cur and cur.get("id"):
                jobs.append(cur)
            cur = {"id": line.split("id:", 1)[1].strip().strip("'\""), "projectMode": "follow_session"}
            continue
        if cur is None:
            continue
        m = re.match(r"^\s+(projectMode|boardProjectId|sourceSessionKey|enabled):\s*(.*)$", line)
        if not m:
            continue
        k, v = m.group(1), m.group(2).strip().strip("'\"")
        if k == "enabled":
            cur[k] = v.lower() in ("true", "yes", "1")
        else:
            cur[k] = v or None
    if cur and cur.get("id"):
        jobs.append(cur)
    return jobs


def read_board(board_id: str) -> dict | None:
    db = Path(UID3_VOL) / "taskboard.db"
    if not db.is_file():
        return None
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    try:
        row = con.execute(
            "SELECT id, key, archived_at, context_version FROM tb_project WHERE id = ?",
            (board_id,),
        ).fetchone()
        if not row:
            return None
        return {
            "id": row[0],
            "key": row[1],
            "archivedAt": row[2],
            "contextVersion": row[3] or 0,
        }
    finally:
        con.close()


def read_project_context(board_id: str) -> dict:
    root = Path(UID3_VOL) / "projects" / board_id
    meta_path = root / "meta.json"
    out = {
        "path": str(root),
        "exists": root.is_dir(),
        "metaExists": meta_path.is_file(),
        "contextVersion": 0,
        "skillNames": [],
        "uid": None,
        "gid": None,
        "mode": None,
        "candidateFiles": [],
    }
    if root.exists():
        st = root.stat()
        out["uid"] = st.st_uid
        out["gid"] = st.st_gid
        out["mode"] = stat.S_IMODE(st.st_mode)
    if meta_path.is_file():
        try:
            meta = json.loads(meta_path.read_text())
            out["contextVersion"] = int(meta.get("schemaVersion") and meta.get("version") or meta.get("version") or 0)
            skills = meta.get("contentManifest", {}).get("skills") or meta.get("skillNames") or []
            if isinstance(skills, list):
                names = []
                for s in skills:
                    if isinstance(s, str):
                        names.append(s)
                    elif isinstance(s, dict) and s.get("name"):
                        names.append(str(s["name"]))
                out["skillNames"] = names
        except Exception as e:
            out["metaError"] = str(e)
    cand = root / "memory-candidates"
    if cand.is_dir():
        out["candidateFiles"] = sorted(p.name for p in cand.iterdir() if p.is_file())
    return out


def require_apply_armed() -> None:
    if os.environ.get("OPENCLAUDE_PROJECT_LAYER_APPLY") != "1":
        raise SystemExit("apply_disabled: OPENCLAUDE_PROJECT_LAYER_APPLY!=1")


def apply_create_facade(name: str) -> dict:
    require_apply_armed()
    name_sql = name.replace("'", "''")
    sql = f"""
INSERT INTO chat_projects (id, user_id, name, created_at, updated_at)
VALUES (gen_random_uuid()::text, '{USER_ID}', '{name_sql}',
        (EXTRACT(EPOCH FROM NOW())*1000)::bigint, (EXTRACT(EPOCH FROM NOW())*1000)::bigint)
RETURNING id;
"""
    return {"id": psql(sql).strip()}


def apply_bind_facade(chat_id: str, board_id: str) -> dict:
    require_apply_armed()
    if not ID_RE.match(chat_id) or not ID_RE.match(board_id):
        raise SystemExit("invalid id")
    sql = f"""
UPDATE chat_projects
   SET board_project_id = '{board_id}',
       updated_at = (EXTRACT(EPOCH FROM NOW())*1000)::bigint
 WHERE id = '{chat_id}' AND user_id = '{USER_ID}' AND deleted_at IS NULL
   AND (board_project_id IS NULL OR board_project_id = '{board_id}')
RETURNING id;
"""
    got = psql(sql).strip()
    if not got:
        raise SystemExit("bind_failed")
    return {"id": got}


def apply_move_sessions(payload: dict) -> dict:
    require_apply_armed()
    ids = clean_ids(payload.get("ids") or [])
    expected = payload.get("expected") or []
    project_id = str(payload.get("projectId") or "")
    if not ID_RE.match(project_id):
        raise SystemExit("invalid projectId")
    stale = []
    live = {s["id"]: s for s in query_sessions(ids)}
    for exp in expected:
        row = live.get(exp["id"])
        if (
            not row
            or row.get("deletedAt")
            or row.get("updatedAt") != exp.get("updatedAt")
            or (row.get("projectId") or None) != (exp.get("projectId") or None)
        ):
            stale.append(exp["id"])
    if stale:
        return {"ok": False, "error": "stale_session", "staleIds": stale}
    arr = sql_text_array(ids)
    sql = f"""
UPDATE client_sessions
   SET project_id = '{project_id}',
       updated_at = (EXTRACT(EPOCH FROM NOW())*1000)::bigint
 WHERE user_id = '{USER_ID}' AND deleted_at IS NULL AND id = ANY({arr});
SELECT COUNT(*) FROM client_sessions
 WHERE user_id = '{USER_ID}' AND project_id = '{project_id}' AND id = ANY({arr});
"""
    n = psql(sql).strip().splitlines()[-1]
    return {"ok": True, "updated": int(n)}


def apply_usage_backfill(payload: dict) -> dict:
    require_apply_armed()
    if not pg_has_usage_board_col():
        raise SystemExit("usage_board_column_missing")
    row_ids = clean_ids(payload.get("rowIds") or [])
    board = str(payload.get("boardProjectId") or "")
    if not row_ids:
        return {"rows": []}
    if not ID_RE.match(board):
        raise SystemExit("invalid boardProjectId")
    arr = sql_text_array(row_ids)
    sql = f"""
UPDATE usage_records
   SET board_project_id = '{board}',
       board_project_source = 'migration_backfill',
       board_project_captured_at = NOW()
 WHERE user_id = {USAGE_USER}::bigint
   AND board_project_id IS NULL
   AND id::text = ANY({arr})
RETURNING id::text AS id, NULL::text AS "oldBoardProjectId";
"""
    raw = psql(sql).strip()
    rows = []
    if raw.startswith("["):
        rows = json.loads(raw)
    return {"rows": rows}


def apply_usage_restore(payload: dict) -> dict:
    require_apply_armed()
    if not pg_has_usage_board_col():
        raise SystemExit("usage_board_column_missing")
    row_ids = clean_ids([r.get("id") for r in (payload.get("rows") or []) if r.get("id")])
    board = str(payload.get("boardProjectId") or "")
    if not row_ids:
        return {"restored": 0}
    arr = sql_text_array(row_ids)
    sql = f"""
UPDATE usage_records
   SET board_project_id = NULL,
       board_project_source = NULL,
       board_project_captured_at = NULL
 WHERE user_id = {USAGE_USER}::bigint
   AND board_project_source = 'migration_backfill'
   AND board_project_id = '{board}'
   AND id::text = ANY({arr});
SELECT ROW_COUNT();
"""
    # ROW_COUNT() isn't a thing; use GET DIAGNOSTICS via CTE returning
    sql = f"""
WITH u AS (
  UPDATE usage_records
     SET board_project_id = NULL,
         board_project_source = NULL,
         board_project_captured_at = NULL
   WHERE user_id = {USAGE_USER}::bigint
     AND board_project_source = 'migration_backfill'
     AND board_project_id = '{board}'
     AND id::text = ANY({arr})
  RETURNING id
)
SELECT COUNT(*) FROM u;
"""
    return {"restored": int(psql(sql).strip() or 0)}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--board", default=OCV5)
    ap.add_argument("--ids-json", default="-")
    ap.add_argument(
        "--mode",
        default="snapshot",
        choices=[
            "snapshot",
            "apply-create-facade",
            "apply-bind-facade",
            "apply-move-sessions",
            "apply-usage-backfill",
            "apply-usage-restore",
            "apply-create-asset",
            "apply-delete-asset",
        ],
    )
    args = ap.parse_args()
    payload = json.load(sys.stdin if args.ids_json == "-" else open(args.ids_json))
    if args.mode == "apply-create-facade":
        json.dump(apply_create_facade(str(payload.get("name") or "OCV5")), sys.stdout)
        sys.stdout.write("\n")
        return 0
    if args.mode == "apply-bind-facade":
        json.dump(apply_bind_facade(str(payload["chatId"]), str(payload["boardProjectId"])), sys.stdout)
        sys.stdout.write("\n")
        return 0
    if args.mode == "apply-move-sessions":
        json.dump(apply_move_sessions(payload), sys.stdout)
        sys.stdout.write("\n")
        return 0
    if args.mode == "apply-usage-backfill":
        json.dump(apply_usage_backfill(payload), sys.stdout)
        sys.stdout.write("\n")
        return 0
    if args.mode == "apply-usage-restore":
        json.dump(apply_usage_restore(payload), sys.stdout)
        sys.stdout.write("\n")
        return 0
    if args.mode == "apply-create-asset":
        require_apply_armed()
        name = str(payload.get("name") or "asset").replace("'", "''")
        digest = str(payload.get("digest") or "")
        path = str(payload.get("containerPath") or "").replace("'", "''")
        session_id = str(payload.get("sessionId") or "").replace("'", "''")
        source = str(payload.get("source") or "output").replace("'", "''")
        sql = f"""
INSERT INTO project_assets (
  id, user_id, name, session_id, container_path, digest, source, created_at, updated_at
) VALUES (
  gen_random_uuid()::text, '{USER_ID}', '{name}', '{session_id}', '{path}', '{digest}', '{source}',
  (EXTRACT(EPOCH FROM NOW())*1000)::bigint, (EXTRACT(EPOCH FROM NOW())*1000)::bigint
)
RETURNING id;
"""
        json.dump({"id": psql(sql).strip(), "created": True}, sys.stdout)
        sys.stdout.write("\n")
        return 0
    if args.mode == "apply-delete-asset":
        require_apply_armed()
        aid = str(payload.get("id") or "")
        if not ID_RE.match(aid):
            raise SystemExit("invalid id")
        psql(
            f"UPDATE project_assets SET deleted_at=(EXTRACT(EPOCH FROM NOW())*1000)::bigint "
            f"WHERE id='{aid}' AND user_id='{USER_ID}' AND deleted_at IS NULL;"
        )
        json.dump({"ok": True}, sys.stdout)
        sys.stdout.write("\n")
        return 0
    session_ids = clean_ids(payload.get("sessionIds") or payload.get("ids") or [])
    has_board = pg_has_usage_board_col()
    from datetime import datetime, timezone
    snapshot = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "readonly": True,
        "database": DB,
        "userId": USER_ID,
        "usageUserId": USAGE_USER,
        "usageBoardColumn": has_board,
        "sessions": query_sessions(session_ids),
        "chatProjects": query_chat_projects(),
        "usage": query_usage(session_ids, has_board),
        "assets": query_assets(),
        "cron": read_cron(),
        "board": read_board(args.board),
        "projectContext": read_project_context(args.board),
        "testProjectContext": read_project_context("b12fc2f7-c466-49de-892b-b44326b782c4"),
        "queriedSessionIds": session_ids,
        "applyModesWired": [
            "apply-create-facade",
            "apply-bind-facade",
            "apply-move-sessions",
            "apply-usage-backfill",
            "apply-usage-restore",
            "apply-create-asset",
            "apply-delete-asset",
        ],
    }
    json.dump(snapshot, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}), file=sys.stderr)
        raise
