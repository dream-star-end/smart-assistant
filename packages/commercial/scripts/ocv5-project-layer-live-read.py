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
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
USAGE_ID_RE = re.compile(r"^\d{1,20}$")


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


def psql_script(sql: str) -> str:
    """Multi-statement script (BEGIN/DO/COMMIT). RAISE aborts before COMMIT."""
    return sh(
        ["sudo", "-u", "postgres", "psql", "-d", DB, "-v", "ON_ERROR_STOP=1", "-A", "-t", "-q"],
        stdin=sql,
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


def parse_usage_row_id(raw) -> str | None:
    if isinstance(raw, int) and raw >= 0:
        return str(raw)
    if isinstance(raw, str):
        s = raw.strip()
        if USAGE_ID_RE.match(s):
            return s
    return None


def clean_usage_ids(raw: list) -> list[str]:
    out = []
    seen = set()
    for x in raw:
        s = parse_usage_row_id(x)
        if s and s not in seen:
            seen.add(s)
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
    raw = psql(sql).strip()
    cid = raw.splitlines()[-1].strip() if raw else ""
    if not UUID_RE.match(cid):
        raise SystemExit(f"create_facade_bad_id:{cid!r}")
    return {"id": cid, "created": True}


def apply_bind_facade(chat_id: str, board_id: str | None) -> dict:
    require_apply_armed()
    if not ID_RE.match(chat_id):
        raise SystemExit("invalid id")
    if board_id not in (None, "") and not ID_RE.match(str(board_id)):
        raise SystemExit("invalid id")
    row_raw = psql(
        "SELECT json_build_object('id', id, 'board', board_project_id, "
        "'deleted', deleted_at, 'user_id', user_id) "
        f"FROM chat_projects WHERE id = '{chat_id}';"
    ).strip()
    if not row_raw:
        raise SystemExit(f"bind_failed:no_row:{chat_id}")
    row = json.loads(row_raw)
    if row.get("user_id") != USER_ID:
        raise SystemExit(f"bind_failed:wrong_user:{chat_id}:{row.get('user_id')}")
    if row.get("deleted") not in (None,):
        raise SystemExit(f"bind_failed:deleted:{chat_id}")
    current = row.get("board")
    if board_id not in (None, "") and current == board_id:
        return {"id": chat_id, "old": current, "new": current, "idempotent": True}
    new_sql = "NULL" if board_id in (None, "") else "'" + str(board_id).replace("'", "''") + "'"
    pred = "TRUE" if board_id in (None, "") else f"(cp.board_project_id IS NULL OR cp.board_project_id = {new_sql})"
    sql = f"""
WITH old AS (
  SELECT id, board_project_id AS old_board
    FROM chat_projects
   WHERE id = '{chat_id}' AND user_id = '{USER_ID}' AND deleted_at IS NULL
   FOR UPDATE
), u AS (
  UPDATE chat_projects cp
     SET board_project_id = {new_sql},
         updated_at = (EXTRACT(EPOCH FROM NOW())*1000)::bigint
    FROM old
   WHERE cp.id = old.id
     AND {pred}
  RETURNING cp.id, old.old_board, cp.board_project_id AS new_board
)
SELECT json_build_object(
  'id', id,
  'old', old_board,
  'new', new_board
) FROM u;
"""
    raw = psql(sql).strip()
    if not raw:
        raise SystemExit(
            f"bind_failed:empty_returning:{chat_id}:current={current}:target={board_id}"
        )
    got = json.loads(raw)
    if not got.get("id"):
        raise SystemExit(f"bind_failed:no_id:{chat_id}")
    return got


def _sql_text_or_null(value) -> str:
    if value in (None, ""):
        return "NULL"
    return "'" + str(value).replace("'", "''") + "'"


def apply_move_sessions_sql(payload: dict) -> str:
    ids = clean_ids(payload.get("ids") or [])
    expected = payload.get("expected") or []
    raw_project = payload.get("projectId")
    allow_null = payload.get("allowNullProject") is True or raw_project is None
    if allow_null and raw_project in (None, ""):
        project_sql = "NULL"
    else:
        project_id = str(raw_project or "")
        if not ID_RE.match(project_id):
            raise SystemExit("invalid projectId")
        project_sql = "'" + project_id.replace("'", "''") + "'"
    if len(expected) != len(ids) or {e.get("id") for e in expected} != set(ids):
        raise SystemExit("expected_ids_mismatch")
    values = []
    for exp in expected:
        sid = str(exp.get("id") or "").replace("'", "")
        if not ID_RE.match(sid):
            raise SystemExit("invalid expected id")
        values.append(
            f"('{sid}', {_sql_text_or_null(exp.get('projectId'))}, {int(exp.get('updatedAt') or 0)})"
        )
    planned = len(ids)
    return f"""
BEGIN;
CREATE TEMP TABLE _ocv5_exp (id text, old_project text, old_updated bigint) ON COMMIT DROP;
INSERT INTO _ocv5_exp(id, old_project, old_updated) VALUES {", ".join(values)};
CREATE TEMP TABLE _ocv5_post ON COMMIT DROP AS
  UPDATE client_sessions cs
     SET project_id = {project_sql},
         updated_at = GREATEST(cs.updated_at + 1, (EXTRACT(EPOCH FROM NOW())*1000)::bigint)
    FROM _ocv5_exp exp
   WHERE cs.user_id = '{USER_ID}'
     AND cs.id = exp.id
     AND cs.deleted_at IS NULL
     AND cs.archived_at IS NULL
     AND cs.updated_at = exp.old_updated
     AND cs.project_id IS NOT DISTINCT FROM exp.old_project
  RETURNING cs.id,
            exp.old_project AS "oldProjectId",
            exp.old_updated AS "oldUpdatedAt",
            cs.updated_at AS "updatedAt",
            cs.project_id AS "projectId";
DO $body$
DECLARE
  planned int := {planned};
  updated int;
BEGIN
  SELECT COUNT(*) INTO updated FROM _ocv5_post;
  IF updated IS DISTINCT FROM planned THEN
    RAISE EXCEPTION 'stale_session planned=% updated=%', planned, updated;
  END IF;
END
$body$;
SELECT json_build_object(
  'ok', true,
  'updated', (SELECT COUNT(*) FROM _ocv5_post),
  'post', COALESCE((SELECT json_agg(row_to_json(p) ORDER BY p.id) FROM _ocv5_post p), '[]'::json)
);
COMMIT;
"""


def apply_move_sessions(payload: dict, exec_sql=None) -> dict:
    require_apply_armed()
    sql = apply_move_sessions_sql(payload)
    runner = exec_sql or psql_script
    raw = runner(sql).strip().splitlines()
    text = next((line for line in reversed(raw) if line.strip()), "") or "{}"
    return json.loads(text)


def apply_usage_backfill_sql(payload: dict) -> str:
    row_ids = clean_usage_ids(payload.get("rowIds") or [])
    planned = int(payload.get("planned") or len(row_ids))
    board = str(payload.get("boardProjectId") or "")
    if not row_ids:
        raise SystemExit("usage_row_ids_empty")
    if not ID_RE.match(board):
        raise SystemExit("invalid boardProjectId")
    arr = sql_text_array(row_ids)
    return f"""
BEGIN;
CREATE TEMP TABLE _ocv5_usage_post ON COMMIT DROP AS
  UPDATE usage_records
     SET board_project_id = '{board}',
         board_project_source = 'migration_backfill',
         board_project_captured_at = NOW()
   WHERE user_id = {USAGE_USER}::bigint
     AND board_project_id IS NULL
     AND id::text = ANY({arr})
  RETURNING id::text AS id,
            NULL::text AS "oldBoardProjectId",
            board_project_id AS "newBoardProjectId",
            board_project_source AS "newSource";
DO $body$
DECLARE
  planned int := {planned};
  updated int;
  recorded int;
BEGIN
  SELECT COUNT(*) INTO updated FROM _ocv5_usage_post;
  recorded := updated;
  IF planned IS DISTINCT FROM updated OR planned IS DISTINCT FROM recorded THEN
    RAISE EXCEPTION 'usage_count_mismatch planned=% updated=% recorded=%', planned, updated, recorded;
  END IF;
END
$body$;
SELECT json_build_object(
  'planned', {planned},
  'updated', (SELECT COUNT(*) FROM _ocv5_usage_post),
  'recorded', (SELECT COUNT(*) FROM _ocv5_usage_post),
  'rows', COALESCE((SELECT json_agg(row_to_json(u) ORDER BY u.id) FROM _ocv5_usage_post u), '[]'::json)
);
COMMIT;
"""


def apply_usage_backfill(payload: dict, exec_sql=None, require_column: bool = True) -> dict:
    require_apply_armed()
    if require_column and not pg_has_usage_board_col():
        raise SystemExit("usage_board_column_missing")
    sql = apply_usage_backfill_sql(payload)
    runner = exec_sql or psql_script
    raw = runner(sql).strip().splitlines()
    text = next((line for line in reversed(raw) if line.strip()), "") or "{}"
    return json.loads(text)


def apply_usage_restore_sql(payload: dict) -> str:
    rows = payload.get("rows") or []
    planned = len(rows)
    if not rows:
        return "SELECT json_build_object('restored', 0, 'planned', 0);"
    values = []
    for r in rows:
        rid = parse_usage_row_id(r.get("id"))
        if not rid:
            raise SystemExit("invalid usage id")
        old_sql = _sql_text_or_null(r.get("oldBoardProjectId"))
        post_sql = _sql_text_or_null(r.get("postBoardProjectId") or r.get("newBoardProjectId"))
        values.append(f"({rid}::bigint, {old_sql}, {post_sql})")
    return f"""
BEGIN;
CREATE TEMP TABLE _ocv5_usage_restore(id bigint, old_board text, post_board text) ON COMMIT DROP;
INSERT INTO _ocv5_usage_restore(id, old_board, post_board) VALUES {", ".join(values)};
CREATE TEMP TABLE _ocv5_usage_restored ON COMMIT DROP AS
  UPDATE usage_records ur
     SET board_project_id = exp.old_board,
         board_project_source = CASE WHEN exp.old_board IS NULL THEN NULL ELSE ur.board_project_source END,
         board_project_captured_at = CASE WHEN exp.old_board IS NULL THEN NULL ELSE ur.board_project_captured_at END
    FROM _ocv5_usage_restore exp
   WHERE ur.user_id = {USAGE_USER}::bigint
     AND ur.id = exp.id
     AND ur.board_project_source = 'migration_backfill'
     AND ur.board_project_id IS NOT DISTINCT FROM exp.post_board
  RETURNING ur.id;
DO $body$
DECLARE
  planned int := {planned};
  updated int;
BEGIN
  SELECT COUNT(*) INTO updated FROM _ocv5_usage_restored;
  IF updated IS DISTINCT FROM planned THEN
    RAISE EXCEPTION 'usage_restore_mismatch planned=% updated=%', planned, updated;
  END IF;
END
$body$;
SELECT json_build_object('restored', (SELECT COUNT(*) FROM _ocv5_usage_restored), 'planned', {planned});
COMMIT;
"""


def apply_usage_restore(payload: dict, exec_sql=None, require_column: bool = True) -> dict:
    require_apply_armed()
    if require_column and not pg_has_usage_board_col():
        raise SystemExit("usage_board_column_missing")
    sql = apply_usage_restore_sql(payload)
    runner = exec_sql or psql_script
    raw = runner(sql).strip().splitlines()
    text = next((line for line in reversed(raw) if line.strip()), "") or '{"restored":0}'
    return json.loads(text)


def self_test_usage_missing_row() -> dict:
    """Negative liveness: planned=2 but UPDATE would hit 1 → SQL RAISE, 0 rows committed."""
    os.environ["OPENCLAUDE_PROJECT_LAYER_APPLY"] = "1"
    captured = {"sql": "", "committed": False}

    def fake_psql(sql: str) -> str:
        captured["sql"] = sql
        if "RAISE EXCEPTION" in sql and "usage_count_mismatch" in sql:
            captured["committed"] = False
            raise RuntimeError("ERROR:  usage_count_mismatch planned=2 updated=1 recorded=1")
        captured["committed"] = "COMMIT;" in sql
        return '{"planned":2,"updated":2,"recorded":2,"rows":[]}'

    try:
        apply_usage_backfill(
            {"rowIds": ["1", "2"], "planned": 2, "boardProjectId": OCV5},
            exec_sql=fake_psql,
            require_column=False,
        )
        return {"ok": False, "error": "expected_raise", "updated": 2}
    except Exception as exc:
        return {
            "ok": True,
            "updated": 0,
            "committed": captured["committed"],
            "sqlHasRaise": "RAISE EXCEPTION" in captured["sql"]
            and "usage_count_mismatch" in captured["sql"],
            "raiseBeforeCommit": captured["sql"].find("RAISE EXCEPTION")
            < captured["sql"].rfind("COMMIT"),
            "error": str(exc),
        }


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
            "self-test-usage-missing-row",
        ],
    )
    args = ap.parse_args()
    if args.mode == "self-test-usage-missing-row":
        json.dump(self_test_usage_missing_row(), sys.stdout)
        sys.stdout.write("\n")
        return 0
    payload = json.load(sys.stdin if args.ids_json == "-" else open(args.ids_json))
    if args.mode == "apply-create-facade":
        json.dump(apply_create_facade(str(payload.get("name") or "OCV5")), sys.stdout)
        sys.stdout.write("\n")
        return 0
    if args.mode == "apply-bind-facade":
        json.dump(
            apply_bind_facade(
                str(payload["chatId"]),
                payload.get("boardProjectId") if payload.get("boardProjectId") not in (None, "") else None,
            ),
            sys.stdout,
        )
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
        raise SystemExit("asset_http_api_only: helper must not INSERT project_assets")
    if args.mode == "apply-delete-asset":
        raise SystemExit("asset_http_api_only: helper must not DELETE project_assets")
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
