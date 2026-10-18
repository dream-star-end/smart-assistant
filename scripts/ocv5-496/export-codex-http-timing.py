"""Export only HTTP correlation metadata from a caller-selected CLI SQLite DB, read-only."""
import argparse, datetime, json, pathlib, re, sqlite3
UUID = r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}"
def valid_id(value, pattern):
    return value if isinstance(value, str) and re.fullmatch(pattern, value, re.I) else None
def scalar(body, key):
    match = re.search(r'(?<![A-Za-z0-9_.])' + re.escape(key) + r'=("(?:[^"\\]|\\.)*"|[^\s,}]+)', body)
    if not match:
        return None
    value = match.group(1)
    if value.startswith('"'):
        try:
            return json.loads(value)
        except ValueError:
            return None
    return value
def export_metadata(path, cutoff):
    db = sqlite3.connect(pathlib.Path(path).resolve().as_uri() + "?mode=ro", uri=True)
    try:
        sql = """SELECT id,ts,ts_nanos,thread_id,process_uuid,feedback_log_body FROM logs
          WHERE ts>=? AND target='codex_http_client::client'
          AND length(feedback_log_body)<=65536 ORDER BY id"""
        for rowid, ts, nanos, thread, proc, body in db.execute(sql, (cutoff,)):
            if not isinstance(body, str) or "Request completed" not in body:
                continue
            body = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', body)
            method = scalar(body, "method")
            operation = "responses" if method == "POST" and scalar(body, "transport") == "responses_http" else None
            if method == "GET":
                # URL is examined only in memory; never exported, including its query/authority.
                from urllib.parse import urlsplit
                url = scalar(body, "url") or scalar(body, "request_url")
                if isinstance(url, str) and urlsplit(url).path.rstrip("/").endswith("/models"):
                    operation = "models"
            if operation is None:
                continue
            match = re.search(r'\bheaders=(\{.*)', body)
            if not match:
                continue
            try:
                headers = json.JSONDecoder().raw_decode(match.group(1))[0]
            except ValueError:
                continue
            if not isinstance(headers, dict):
                continue
            private_id = valid_id(headers.get("x-openclaude-relay-request-id"), r"[0-9a-f]{32}")
            legacy_id = valid_id(headers.get("x-request-id"), r"[0-9a-f]{32}")
            request_id = private_id or legacy_id
            status = scalar(body, "status")
            if not request_id or not status or not status.isdigit() or not 100 <= int(status) <= 599:
                continue
            yield {"rowId": rowid, "timestampNs": str(ts * 1000000000 + nanos),
                   "requestId": request_id, "correlationSource": "private" if private_id else "legacy",
                   "threadId": valid_id(thread, UUID), "turnId": valid_id(scalar(body, "turn_id"), UUID),
                   "processUuid": valid_id(proc, r"(?:pid:[0-9]+:)?" + UUID),
                   "method": method, "operation": operation, "status": int(status)}
    finally:
        db.close()
def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", required=True)
    parser.add_argument("--since", required=True, help="ISO8601 UTC lower bound")
    args = parser.parse_args()
    cutoff = int(datetime.datetime.fromisoformat(args.since.replace("Z", "+00:00")).timestamp())
    for item in export_metadata(args.db, cutoff):
        print(json.dumps(item))
if __name__ == "__main__":
    main()
