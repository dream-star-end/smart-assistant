#!/usr/bin/env python3
"""Per-statement compatibility candidates of a SQL migration (OCV5-542, phase 3 plan v3.6 §9.3 rule 3, R8-1).

This phase only allows additive migrations: an older release must keep reading and writing what a
newer one leaves in the database. A statement that might break that is a *candidate*; each candidate
needs a `-- compat: <why old reads and writes are unaffected>` comment right before it (in the
comment block between the previous statement and this one). The detector not matching does not mean
a migration is safe: unparseable input and dynamic SQL are candidates too, and the PR still has to
state compatibility for every migration (§9.8).

Usage: v5-migration-compat.py <file.sql>...
Output: one JSON object per candidate statement:
  {"file", "line", "kinds": [...], "declared": bool, "reason": str|null, "snippet"}
Exit: 0 no undeclared candidate; 1 at least one undeclared candidate; 2 usage or read error.
The existing breaking-DDL detector (scripts/lib/v5-migration-ddl.sh) is separate and unchanged.
"""
import json
import re
import sys

COMPAT_RE = re.compile(r"--\s*compat:\s*(\S.*?)\s*$", re.I | re.M)


def split_statements(text):
    """Split SQL into statements, honouring '...' strings, "..." identifiers, $tag$ bodies, -- and
    /* */ comments. Returns (statements, error); each statement is (start_line, leading_comments, body)."""
    out = []
    i, n = 0, len(text)
    line = 1
    buf = []
    lead = []          # comments seen before the statement's first code character
    start_line = None
    error = None

    def flush():
        nonlocal buf, lead, start_line
        body = "".join(buf).strip()
        if body:
            out.append((start_line or line, "".join(lead), body))
        buf, lead, start_line = [], [], None

    while i < n:
        c = text[i]
        if c == "-" and text.startswith("--", i):
            j = text.find("\n", i)
            j = n if j < 0 else j
            (buf if buf and "".join(buf).strip() else lead).append(text[i:j] + "\n")
            i = j
            continue
        if c == "/" and text.startswith("/*", i):
            j = text.find("*/", i + 2)
            if j < 0:
                error = f"unterminated block comment at line {line}"
                break
            seg = text[i:j + 2]
            (buf if buf and "".join(buf).strip() else lead).append(seg)
            line += seg.count("\n")
            i = j + 2
            continue
        if c in "'\"":
            j = i + 1
            while j < n:
                if text[j] == c:
                    if j + 1 < n and text[j + 1] == c:
                        j += 2
                        continue
                    break
                j += 1
            if j >= n:
                error = f"unterminated quote at line {line}"
                break
            seg = text[i:j + 1]
            if start_line is None:
                start_line = line
            buf.append(seg)
            line += seg.count("\n")
            i = j + 1
            continue
        if c == "$":
            m = re.match(r"\$([A-Za-z_][A-Za-z0-9_]*)?\$", text[i:])
            if m:
                tag = m.group(0)
                j = text.find(tag, i + len(tag))
                if j < 0:
                    error = f"unterminated {tag} body at line {line}"
                    break
                seg = text[i:j + len(tag)]
                if start_line is None:
                    start_line = line
                buf.append(seg)
                line += seg.count("\n")
                i = j + len(tag)
                continue
        if c == ";":
            buf.append(c)
            flush()
            i += 1
            continue
        if c == "\n":
            line += 1
        if not c.isspace() and start_line is None:
            start_line = line
        buf.append(c)
        i += 1
    if error is None:
        flush()
    return out, error


def code_only(body):
    """Statement text with comments and string/dollar-quoted contents blanked (keywords only)."""
    s = re.sub(r"/\*.*?\*/", " ", body, flags=re.S)
    s = re.sub(r"--[^\n]*", " ", s)
    s = re.sub(r"\$([A-Za-z_][A-Za-z0-9_]*)?\$.*?\$\1\$", " $BODY$ ", s, flags=re.S)
    s = re.sub(r"'(?:[^']|'')*'", "''", s)
    return re.sub(r"\s+", " ", s).strip()


RULES = [
    ("set-not-null", r"\bSET\s+NOT\s+NULL\b"),
    ("alter-type", r"\bALTER\s+(?:COLUMN\s+)?[\w\".]+\s+(?:SET\s+DATA\s+)?TYPE\b"),
    ("add-constraint", r"\bADD\s+(?:CONSTRAINT|CHECK|UNIQUE|PRIMARY\s+KEY|FOREIGN\s+KEY|EXCLUDE)\b"),
    ("validate-constraint", r"\bVALIDATE\s+CONSTRAINT\b"),
    ("unique-index", r"\bCREATE\s+UNIQUE\s+INDEX\b"),
    ("drop-object", r"\bDROP\s+(?:INDEX|VIEW|MATERIALIZED\s+VIEW|FUNCTION|PROCEDURE|TABLE|TYPE|SEQUENCE|SCHEMA|POLICY|RULE|EXTENSION)\b"),
    ("alter-drop", r"\bDROP\s+(?:COLUMN|CONSTRAINT|DEFAULT|NOT\s+NULL|IDENTITY|EXPRESSION)\b"),
    ("rename", r"\bRENAME\b"),
    ("trigger", r"\b(?:CREATE|ALTER|DROP)\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\b|\b(?:ENABLE|DISABLE)\s+TRIGGER\b"),
    ("function", r"\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\b"),
    ("replace-view", r"\bCREATE\s+OR\s+REPLACE\s+(?:VIEW|RULE)\b"),
    ("update", r"(?:^|\)\s*|\bWITH\b.*\b)UPDATE\s+(?!OF\b)[\w\".]+\s+(?:AS\s+\w+\s+)?SET\b|\bDO\s+UPDATE\b"),
    ("delete", r"(?:^|\)\s*|\bWITH\b.*\b)DELETE\s+FROM\b"),
    ("truncate", r"^TRUNCATE\b"),
    ("dynamic-or-procedural", r"^DO\b|\bEXECUTE\b(?!\s+(?:FUNCTION|PROCEDURE)\b)|\bCALL\b"),
    ("revoke", r"^REVOKE\b"),
    ("policy", r"\b(?:CREATE|ALTER)\s+POLICY\b|\b(?:ENABLE|FORCE)\s+ROW\s+LEVEL\s+SECURITY\b"),
]
# Statement forms that are additive by themselves (a new table, a plain index, a seed row...).
# Anything else with no rule hit is "unclassified" (fail closed, needs a declaration).
ADDITIVE_START = re.compile(
    r"^(?:CREATE\s+(?:TABLE|INDEX|SEQUENCE|SCHEMA|EXTENSION|TYPE|VIEW)\b|CREATE\s+(?:UNIQUE\s+)?INDEX\b|INSERT\b|"
    r"COMMENT\s+ON\b|GRANT\b|SELECT\b|SET\b|BEGIN\b|START\s+TRANSACTION\b|COMMIT\b|ANALYZE\b|LOCK\b|"
    r"CREATE\s+TEMP(?:ORARY)?\s+TABLE\b|"
    r"ALTER\s+TABLE\b|ALTER\s+TYPE\s+[\w\".]+\s+ADD\s+VALUE\b|"
    r"CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE|TRIGGER|VIEW|RULE)\b|CREATE\s+CONSTRAINT\s+TRIGGER\b|"
    r"DROP\b|UPDATE\b|DELETE\b|WITH\b|DO\b|TRUNCATE\b|CALL\b|ALTER\s+TYPE\b|REVOKE\b)")


def alter_table_kinds(u):
    """ALTER TABLE is additive only when every clause is ADD COLUMN (nullable, or NOT NULL with a DEFAULT)."""
    rest = re.sub(r"^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?[\w\".]+\s*", "", u).rstrip(";").strip()
    kinds = set()
    depth, cur, clauses = 0, "", []
    for ch in rest:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if ch == "," and depth == 0:
            clauses.append(cur.strip()); cur = ""
        else:
            cur += ch
    clauses.append(cur.strip())
    for c in filter(None, clauses):
        m = re.match(r"^ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?!CONSTRAINT\b|CHECK\b|UNIQUE\b|PRIMARY\b|FOREIGN\b|EXCLUDE\b)[\w\"]+\s+(.*)$", c)
        if m:
            col = m.group(1)
            if re.search(r"\bNOT\s+NULL\b", col) and not re.search(r"\bDEFAULT\b", col):
                kinds.add("add-not-null-no-default")
            if re.search(r"\b(?:UNIQUE|CHECK|REFERENCES|PRIMARY\s+KEY)\b", col):
                kinds.add("add-constraint")
            continue
        if not any(re.search(rx, c) for _, rx in RULES):
            kinds.add("alter-other")
    return kinds


def classify(body):
    u = code_only(body).upper()
    kinds = {k for k, rx in RULES if re.search(rx, u)}
    if re.match(r"^ALTER\s+TABLE\b", u):
        kinds |= alter_table_kinds(u)
    if re.match(r"^ALTER\s+TYPE\b", u) and not re.match(r"^ALTER\s+TYPE\s+[\w\".]+\s+ADD\s+VALUE\b", u):
        kinds.add("alter-type")
    if not ADDITIVE_START.match(u):
        kinds.add("unclassified")
    return sorted(kinds)


def check_file(path):
    try:
        text = open(path, encoding="utf-8").read()
    except OSError as e:
        print(json.dumps({"file": path, "error": str(e)}))
        return None
    stmts, error = split_statements(text)
    found = []
    if error:
        found.append({"file": path, "line": 0, "kinds": ["unparseable"], "declared": False, "reason": None, "snippet": error})
        return found
    for start, lead, body in stmts:
        kinds = classify(body)
        if not kinds:
            continue
        reasons = COMPAT_RE.findall(lead)
        reason = reasons[-1] if reasons else None
        found.append({"file": path, "line": start, "kinds": kinds, "declared": bool(reason), "reason": reason,
                      "snippet": code_only(body)[:160]})
    return found


def main(argv):
    if not argv:
        print(__doc__, file=sys.stderr)
        return 2
    rc = 0
    for p in argv:
        found = check_file(p)
        if found is None:
            return 2
        for f in found:
            print(json.dumps(f, ensure_ascii=False))
            if not f["declared"]:
                rc = 1
    return rc


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
