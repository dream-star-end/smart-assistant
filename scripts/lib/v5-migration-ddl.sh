#!/usr/bin/env bash
# Breaking-DDL detector shared by the selfhost release train's migration gate
# (scripts/v5-selfhost-master-release-lib.sh classify_pending_migration_file)
# and the PR precheck (scripts/v5-selfhost-migration-precheck.sh), OCV5-450.
# One implementation, so CI warns about exactly what the train will refuse.
# Sourced, never executed.

sql_file_has_breaking_ddl() { # <sql-file> → rc 0 = breaking
  local f="$1"
  python3 - "$f" <<'PY'
import re, sys
path = sys.argv[1]
text = open(path, encoding="utf-8", errors="replace").read()
text = re.sub(r"/\*.*?\*/", " ", text, flags=re.S)
text = re.sub(r"--.*?$", " ", text, flags=re.M)
if re.search(r"\bDROP\s+TABLE\b", text, re.I):
    print("DROP TABLE"); sys.exit(0)
if re.search(r"\bDROP\s+COLUMN\b", text, re.I):
    print("DROP COLUMN"); sys.exit(0)
if re.search(r"\bALTER\b[\s\S]{0,200}\bDROP\b", text, re.I):
    print("ALTER ... DROP"); sys.exit(0)
if re.search(r"\bRENAME\s+(TO|COLUMN|TABLE)\b", text, re.I):
    print("RENAME"); sys.exit(0)
if re.search(r"\bTRUNCATE\b", text, re.I):
    print("TRUNCATE"); sys.exit(0)
sys.exit(1)
PY
}
