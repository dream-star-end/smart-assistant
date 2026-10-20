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

# The reason must be on the same line as `-- compat:` (no newline in between).
COMPAT_RE = re.compile(r"--[ \t]*compat:[ \t]*(\S[^\n]*?)[ \t]*$", re.I | re.M)


def tokenize(text):
    """One pass over PostgreSQL text. Yields (kind, value, line): kind is "comment", "string" (any
    quoted literal, E'..' with backslash escapes, $tag$ bodies), "ident" ("quoted" identifiers),
    "semi" or "code". Raises ValueError on an unterminated literal or comment."""
    i, n, line = 0, len(text), 1
    while i < n:
        c = text[i]
        start_line = line
        if text.startswith("--", i):
            j = text.find("\n", i)
            j = n if j < 0 else j
            yield "comment", text[i:j], start_line
            i = j
            continue
        if text.startswith("/*", i):
            depth, j = 1, i + 2          # PostgreSQL block comments nest
            while j < n and depth:
                if text.startswith("/*", j):
                    depth += 1; j += 2
                elif text.startswith("*/", j):
                    depth -= 1; j += 2
                else:
                    j += 1
            if depth:
                raise ValueError(f"unterminated block comment at line {start_line}")
            seg = text[i:j]
            line += seg.count("\n")
            yield "comment", seg, start_line
            i = j
            continue
        if c == "'" or (c in "eE" and text.startswith("'", i + 1) and (i == 0 or not (text[i - 1].isalnum() or text[i - 1] == "_"))):
            esc = c in "eE"
            j = i + (2 if esc else 1)
            while j < n:
                if esc and text[j] == "\\":
                    j += 2
                    continue
                if text[j] == "'":
                    if j + 1 < n and text[j + 1] == "'":
                        j += 2
                        continue
                    break
                j += 1
            if j >= n:
                raise ValueError(f"unterminated string at line {start_line}")
            seg = text[i:j + 1]
            line += seg.count("\n")
            yield "string", seg, start_line
            i = j + 1
            continue
        if c == '"':
            j = text.find('"', i + 1)
            while j >= 0 and text.startswith('""', j):
                j = text.find('"', j + 2)
            if j < 0:
                raise ValueError(f"unterminated identifier at line {start_line}")
            seg = text[i:j + 1]
            line += seg.count("\n")
            yield "ident", seg, start_line
            i = j + 1
            continue
        if c == "$":
            m = re.match(r"\$([A-Za-z_][A-Za-z0-9_]*)?\$", text[i:])
            if m and not (i > 0 and (text[i - 1].isalnum() or text[i - 1] == "_")):
                tag = m.group(0)
                j = text.find(tag, i + len(tag))
                if j < 0:
                    raise ValueError(f"unterminated {tag} body at line {start_line}")
                seg = text[i:j + len(tag)]
                line += seg.count("\n")
                yield "string", seg, start_line
                i = j + len(tag)
                continue
        if c == ";":
            yield "semi", c, start_line
            i += 1
            continue
        j = i + 1
        while j < n:
            d = text[j]
            if d in "';\"$" or text.startswith(("--", "/*"), j):
                break
            if d in "eE" and text.startswith("'", j + 1) and not (text[j - 1].isalnum() or text[j - 1] == "_"):
                break
            j += 1
        seg = text[i:j]
        line += seg.count("\n")
        yield "code", seg, start_line
        i = j


def split_statements(text):
    """Statements as (start_line, leading_comments, code_text): code_text keeps keywords and blanks
    every literal ('' for strings, "" for identifiers is kept as written, $BODY$ for dollar bodies);
    leading_comments are the comments between the previous statement and this one's first token."""
    out, lead, code, start, bodies = [], [], [], None, []
    for kind, val, line in tokenize(text):
        if kind == "semi":
            if code:
                out.append((start, "\n".join(lead), re.sub(r"\s+", " ", "".join(code)).strip(), bodies))
            lead, code, start, bodies = [], [], None, []
            continue
        if kind == "comment":
            if not "".join(code).strip():
                lead.append(val)
            code.append(" ")
            continue
        if kind == "string":
            if val.startswith("$"):
                bodies.append(re.sub(r"^\$[A-Za-z0-9_]*\$|\$[A-Za-z0-9_]*\$$", "", val))
            code.append(" $BODY$ " if val.startswith("$") else " '' ")
        else:
            code.append(val)
        if start is None and val.strip():
            start = line + val[:len(val) - len(val.lstrip())].count("\n")
    if "".join(code).strip():
        out.append((start, "\n".join(lead), re.sub(r"\s+", " ", "".join(code)).strip(), bodies))
    return out


def body_kinds(bodies):
    """Kinds found in dollar-quoted bodies (DO blocks, functions), so the reviewer sees what the
    procedural code does. The statement is already a candidate on its own; this only adds detail."""
    kinds = set()
    for b in bodies:
        try:
            inner = split_statements(b)
        except ValueError:
            kinds.add("unparseable-body")
            continue
        for _s, _l, code, sub in inner:
            u = code.upper()
            kinds |= {k for k, rx in RULES if re.search(rx, u)}
            if re.match(r"^ALTER\s+TABLE\b", u):
                kinds |= alter_table_kinds(u)
            kinds |= body_kinds(sub)
    return kinds


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
    ("update", r"\bUPDATE\s+(?:ONLY\s+)?(?!OF\b)[\w\".]+\s+(?:(?:AS\s+)?\w+\s+)?SET\b|\bDO\s+UPDATE\b"),
    ("delete", r"\bDELETE\s+FROM\b"),
    ("truncate", r"^TRUNCATE\b"),
    ("dynamic-or-procedural", r"^DO\b|\bEXECUTE\b(?!\s+(?:FUNCTION|PROCEDURE)\b)|\bCALL\b"),
    ("revoke", r"^REVOKE\b"),
    ("policy", r"\b(?:CREATE|ALTER)\s+POLICY\b|\b(?:ENABLE|FORCE)\s+ROW\s+LEVEL\s+SECURITY\b"),
]
# Statement forms that are additive by themselves (a new table, a plain index, a seed row...).
# A statement starting any other way is a candidate: by its leading keyword when known
# (LEADING), otherwise "unclassified" (fail closed). RULES then add what they find inside.
ADDITIVE_START = re.compile(
    r"^(?:CREATE\s+(?:TABLE|INDEX|SEQUENCE|SCHEMA|EXTENSION|VIEW)\b|CREATE\s+TYPE\b|CREATE\s+UNIQUE\s+INDEX\b|INSERT\b|"
    r"COMMENT\s+ON\b|GRANT\b|SELECT\b|SET\b|BEGIN\b|START\s+TRANSACTION\b|COMMIT\b|ANALYZE\b|LOCK\b|"
    r"CREATE\s+TEMP(?:ORARY)?\s+TABLE\b|ALTER\s+TABLE\b|ALTER\s+TYPE\s+[\w\".]+\s+ADD\s+VALUE\b|"
    r"CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE|TRIGGER|VIEW|RULE)\b|CREATE\s+CONSTRAINT\s+TRIGGER\b)")
LEADING = [
    ("drop-object", r"^DROP\b"),
    ("update", r"^UPDATE\b"),
    ("delete", r"^DELETE\b"),
    ("truncate", r"^TRUNCATE\b"),
    ("cte", r"^WITH\b"),
    ("dynamic-or-procedural", r"^(?:DO|CALL|EXECUTE|PREPARE)\b"),
    ("revoke", r"^REVOKE\b"),
    ("alter-type", r"^ALTER\s+(?:TYPE|DOMAIN)\b"),
    ("alter-other", r"^ALTER\b"),
]


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
    u = body.upper()
    kinds = {k for k, rx in RULES if re.search(rx, u)}
    if re.match(r"^ALTER\s+TABLE\b", u):
        kinds |= alter_table_kinds(u)
    if not ADDITIVE_START.match(u):
        lead = [k for k, rx in LEADING if re.match(rx, u)]
        kinds.add(lead[0] if lead else "unclassified")
    return sorted(kinds)


def check_file(path):
    try:
        text = open(path, encoding="utf-8").read()
    except OSError as e:
        print(json.dumps({"file": path, "error": str(e)}))
        return None
    found = []
    try:
        stmts = split_statements(text)
    except ValueError as e:
        found.append({"file": path, "line": 0, "kinds": ["unparseable"], "declared": False, "reason": None, "snippet": str(e)})
        return found
    for start, lead, body, bodies in stmts:
        kinds = sorted(set(classify(body)) | body_kinds(bodies)) if bodies else classify(body)
        if not kinds:
            continue
        reasons = COMPAT_RE.findall(lead)
        reason = reasons[-1] if reasons else None
        found.append({"file": path, "line": start, "kinds": kinds, "declared": bool(reason), "reason": reason,
                      "snippet": body[:160]})
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
