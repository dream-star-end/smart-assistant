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
# A privilege named TRUNCATE is not a TRUNCATE command. Recognize only complete,
# simple table ACL statements; leave complex/unrecognized SQL conservatively intact.
priv = r"(?:SELECT|INSERT|UPDATE|DELETE|TRUNCATE|REFERENCES|TRIGGER|MAINTAIN|ALL(?:\s+PRIVILEGES)?)"
privs = priv + r"(?:\s*,\s*" + priv + r")*"
ident = r"[A-Za-z_][A-Za-z_0-9$]*(?:\.[A-Za-z_][A-Za-z_0-9$]*)?"
names = ident + r"(?:\s*,\s*" + ident + r")*"
acl = (r"(?:GRANT\s+(?P<grant_privs>" + privs + r")\s+ON\s+(?:TABLE\s+)?" + names +
       r"\s+TO\s+" + names + r"(?:\s+WITH\s+GRANT\s+OPTION)?|" +
       r"REVOKE\s+(?:GRANT\s+OPTION\s+FOR\s+)?(?P<revoke_privs>" + privs +
       r")\s+ON\s+(?:TABLE\s+)?" + names + r"\s+FROM\s+" + names + r"(?:\s+(?:CASCADE|RESTRICT))?)")
def mask_acl_privilege(match):
    group = "grant_privs" if match.group("grant_privs") is not None else "revoke_privs"
    start, end = match.span(group)
    start -= match.start(); end -= match.start()
    sql = match.group(0)
    return sql[:start] + re.sub(r"\bTRUNCATE\b", "        ", sql[start:end], flags=re.I) + sql[end:]
text = re.sub(r"(?:^|;)\s*" + acl + r"\s*(?=;|$)", mask_acl_privilege, text, flags=re.I)
if re.search(r"\bTRUNCATE\b", text, re.I):
    print("TRUNCATE"); sys.exit(0)
sys.exit(1)
PY
}
