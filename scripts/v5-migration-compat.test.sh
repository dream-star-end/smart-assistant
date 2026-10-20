#!/usr/bin/env bash
# OCV5-542: additive-only migration detector (scripts/lib/v5-migration-compat.py) and its blocking
# check (scripts/v5-selfhost-migration-compat-check.sh). Usage: bash scripts/v5-migration-compat.test.sh
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DET="$DIR/lib/v5-migration-compat.py"
CHECK="$DIR/v5-selfhost-migration-compat-check.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
pass=0 fail=0
ok() { echo "PASS $1"; pass=$((pass + 1)); }
bad() { echo "FAIL $1" >&2; fail=$((fail + 1)); }

# kinds <sql> → sets K (comma list of the first candidate's kinds, "none" if none) and DRC (detector rc)
K="" DRC=0
kinds() {
  printf '%s\n' "$1" >"$T/m.sql"
  local out; out="$(python3 "$DET" "$T/m.sql")"; DRC=$?
  if [[ -z "$out" ]]; then K=none; else K="$(head -1 <<<"$out" | jq -r '.kinds | join(",")')"; fi
}
red() { # <name> <sql> <expected-kind>
  kinds "$2"
  if [[ "$DRC" == 1 && ",$K," == *",$3,"* ]]; then ok "red: $1 [$K]"; else bad "red: $1 (rc=$DRC kinds=$K, want $3)"; fi
  kinds "-- compat: test fixture, old readers ignore this
$2"
  if [[ "$DRC" == 0 ]]; then ok "declared: $1"; else bad "declared: $1 (rc=$DRC)"; fi
}
green() { # <name> <sql>
  kinds "$2"
  if [[ "$DRC" == 0 && "$K" == none ]]; then ok "green: $1"; else bad "green: $1 (rc=$DRC kinds=$K)"; fi
}

# Every R8-1 class, red without a declaration and green with one.
red "Codex r8 next_fire_at SET NOT NULL" "ALTER TABLE cron_jobs ALTER COLUMN next_fire_at SET NOT NULL;" set-not-null
red "change type" "ALTER TABLE t ALTER COLUMN a TYPE varchar(10);" alter-type
red "set data type" "ALTER TABLE t ALTER COLUMN a SET DATA TYPE bigint;" alter-type
red "add constraint" "ALTER TABLE t ADD CONSTRAINT t_c CHECK (n > 0);" add-constraint
red "add check" "ALTER TABLE t ADD CHECK (n > 0);" add-constraint
red "add unique" "ALTER TABLE t ADD UNIQUE (a);" add-constraint
red "column with inline references" "ALTER TABLE t ADD COLUMN u bigint REFERENCES users(id);" add-constraint
red "unique index" "CREATE UNIQUE INDEX IF NOT EXISTS t_u ON t (a);" unique-index
red "NOT NULL column without default" "ALTER TABLE t ADD COLUMN d int NOT NULL;" add-not-null-no-default
red "standalone DROP INDEX" "DROP INDEX IF EXISTS t_a;" drop-object
red "standalone DROP VIEW" "DROP VIEW v;" drop-object
red "standalone DROP FUNCTION" "DROP FUNCTION IF EXISTS f(int);" drop-object
red "DROP TABLE" "DROP TABLE t;" drop-object
red "DROP COLUMN" "ALTER TABLE t DROP COLUMN a;" alter-drop
red "DROP DEFAULT" "ALTER TABLE t ALTER COLUMN a DROP DEFAULT;" alter-drop
red "rename column" "ALTER TABLE t RENAME COLUMN a TO b;" rename
red "rename table" "ALTER TABLE t RENAME TO t2;" rename
red "enum RENAME VALUE" "ALTER TYPE mood RENAME VALUE 'sad' TO 'blue';" rename
red "create trigger" "CREATE TRIGGER trg BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION f();" trigger
red "drop trigger" "DROP TRIGGER IF EXISTS trg ON t;" trigger
red "disable trigger" "ALTER TABLE t DISABLE TRIGGER trg;" trigger
red "create or replace function" 'CREATE OR REPLACE FUNCTION f() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql;' function
red "UPDATE backfill" "UPDATE t SET b = 'x' WHERE b IS NULL;" update
red "CTE UPDATE" "WITH s AS (SELECT id FROM t) UPDATE t SET b = 1 FROM s WHERE t.id = s.id;" update
red "upsert DO UPDATE" "INSERT INTO t (id) VALUES (1) ON CONFLICT (id) DO UPDATE SET a = EXCLUDED.a;" update
red "DELETE cleanup" "DELETE FROM t WHERE id < 0;" delete
red "TRUNCATE" "TRUNCATE t;" truncate
red "DO block (dynamic)" "DO \$\$ BEGIN EXECUTE format('ALTER TABLE %I DROP COLUMN z', 't'); END \$\$;" dynamic-or-procedural
red "tagged dollar body" "DO \$body\$ BEGIN PERFORM 1; END \$body\$;" dynamic-or-procedural
red "SET DEFAULT on existing column" "ALTER TABLE t ALTER COLUMN a SET DEFAULT 'x';" alter-other
red "unknown statement" "VACUUM t;" unclassified
red "REVOKE" "REVOKE ALL ON TABLE t FROM app;" revoke
red "replace view" "CREATE OR REPLACE VIEW v AS SELECT 1;" replace-view
# Codex r1 repros (false negatives that must be red).
red "UPDATE with an alias" "UPDATE t x SET a = 1;" update
red "UPDATE ONLY" "UPDATE ONLY t SET a = 1;" update
red "any DROP, e.g. DROP DOMAIN" "DROP DOMAIN old_type CASCADE;" drop-object
red "a '--' inside a string does not hide the rest" "ALTER TABLE t ADD COLUMN b text DEFAULT '--', ALTER COLUMN a SET NOT NULL;" set-not-null
red "ALTER DOMAIN" "ALTER DOMAIN d SET NOT NULL;" alter-type
red "WITH ... INSERT" "WITH s AS (SELECT 1) INSERT INTO t SELECT * FROM s;" cte
red "DO block shows what its body does" "DO \$\$ BEGIN ALTER TABLE t ADD CONSTRAINT c CHECK (a > 0); END \$\$;" add-constraint
# Additive forms stay green.
green "new table with NOT NULL/UNIQUE inside" "CREATE TABLE IF NOT EXISTS t (id bigint PRIMARY KEY, a text NOT NULL UNIQUE);"
green "plain index" "CREATE INDEX IF NOT EXISTS t_a ON t (a);"
green "nullable column" "ALTER TABLE t ADD COLUMN IF NOT EXISTS b text;"
green "NOT NULL column with default" "ALTER TABLE t ADD COLUMN c int NOT NULL DEFAULT 0;"
green "two nullable columns" "ALTER TABLE t ADD COLUMN x text, ADD COLUMN y jsonb;"
green "seed insert DO NOTHING" "INSERT INTO t (id, a) VALUES (1, 'semi;colon') ON CONFLICT (id) DO NOTHING;"
green "enum ADD VALUE" "ALTER TYPE mood ADD VALUE IF NOT EXISTS 'ok';"
green "comment with quotes and semicolons" "COMMENT ON TABLE t IS 'it''s fine; really';"
green "lock" "LOCK TABLE t IN SHARE ROW EXCLUSIVE MODE;"
green "keywords inside strings do not count" "INSERT INTO notes (body) VALUES ('UPDATE t SET x; DROP TABLE y;');"

# Declarations bind to the next statement only.
printf '%s\n' "-- compat: covers the first one only" "UPDATE t SET a = 1;" "UPDATE t SET b = 2;" >"$T/m.sql"
out="$(python3 "$DET" "$T/m.sql")"; rc=$?
[[ "$rc" == 1 && "$(jq -s 'map(.declared)' <<<"$out" | tr -d ' \n')" == "[true,false]" ]] \
  && ok "a declaration covers only the statement right after it" || bad "declaration scope (rc=$rc)"
printf '%s\n' "-- compat: only notes.body is new" "UPDATE notes SET body = E'can\\'t';" "UPDATE t SET a = 1;" "INSERT INTO notes VALUES (E'won\\'t');" >"$T/m.sql"
out="$(python3 "$DET" "$T/m.sql")"; rc=$?
[[ "$rc" == 1 && "$(jq -s 'map([.line, .declared])' <<<"$out" | tr -d ' \n')" == "[[2,true],[3,false]]" ]] \
  && ok "E'..' backslash escapes do not merge statements (Codex r1)" || bad "E-string escapes (rc=$rc): $out"
printf '%s\n' "-- compat:" "-- unrelated comment" "UPDATE t SET a = 1;" >"$T/m.sql"
python3 "$DET" "$T/m.sql" >/dev/null; [[ $? == 1 ]] && ok "an empty reason does not borrow the next comment line (Codex r1)" || bad "empty reason next line"
printf '%s\n' "/* outer /* nested */ still a comment; DROP TABLE x; */ CREATE INDEX i ON t (a);" >"$T/m.sql"
python3 "$DET" "$T/m.sql" >/dev/null; [[ $? == 0 ]] && ok "nested block comments are comments" || bad "nested comments"
printf '%s\n' "-- compat:" "UPDATE t SET a = 1;" >"$T/m.sql"
python3 "$DET" "$T/m.sql" >/dev/null; [[ $? == 1 ]] && ok "an empty reason is not a declaration" || bad "empty reason"
printf '%s\n' "UPDATE t SET a = 1; -- compat: trailing comment belongs to the next statement" >"$T/m.sql"
python3 "$DET" "$T/m.sql" >/dev/null; [[ $? == 1 ]] && ok "a trailing comment does not declare the statement before it" || bad "trailing comment"
printf '%s\n' "INSERT INTO t VALUES ('unterminated);" >"$T/m.sql"
out="$(python3 "$DET" "$T/m.sql")"; rc=$?
[[ "$rc" == 1 && "$(jq -r '.kinds[0]' <<<"$out")" == unparseable ]] && ok "unparseable file is red" || bad "unparseable (rc=$rc)"
python3 "$DET" "$T/missing.sql" >/dev/null 2>&1; [[ $? == 2 ]] && ok "unreadable file exits 2" || bad "unreadable"

# The blocking check over a git range.
R="$T/repo"; M="packages/commercial/src/db/migrations"
mkdir -p "$R/scripts/lib" "$R/$M"
cp "$CHECK" "$R/scripts/"; cp "$DET" "$R/scripts/lib/"
git -C "$R" init -q -b main; git -C "$R" config user.email t@t; git -C "$R" config user.name t
echo "CREATE TABLE a (id int);" >"$R/$M/0001_a.sql"; git -C "$R" add -A; git -C "$R" commit -qm base
run_check() { (cd "$R" && bash scripts/v5-selfhost-migration-compat-check.sh --base main "$@") >"$T/out" 2>&1; echo $?; }
git -C "$R" checkout -qb feat
[[ "$(run_check)" == 0 ]] && grep -q 'no migration changes' "$T/out" && ok "check: no migration change passes" || bad "check: no change"
printf '%s\n' "ALTER TABLE a ADD COLUMN b text;" "UPDATE a SET b = 'x';" >"$R/$M/0002_b.sql"; git -C "$R" add -A; git -C "$R" commit -qm b
[[ "$(run_check)" == 1 ]] && grep -q '::error file=.*0002_b.sql,line=2::compat candidate \[update\]' "$T/out" \
  && ok "check: undeclared UPDATE fails with a file/line annotation" || bad "check: undeclared"
printf '%s\n' "ALTER TABLE a ADD COLUMN b text;" "-- compat: backfills a column added in this migration; old code never reads b" "UPDATE a SET b = 'x';" >"$R/$M/0002_b.sql"
git -C "$R" add -A; git -C "$R" commit -qm b2
[[ "$(run_check)" == 0 ]] && grep -q '::notice.*declared: backfills' "$T/out" && ok "check: declared candidate passes and is listed" || bad "check: declared"
printf '%s\n' "## Summary" "x" >"$T/body.md"
[[ "$(run_check --pr-body-file "$T/body.md")" == 1 ]] && grep -q "needs a '## Migration compatibility' section" "$T/out" \
  && ok "check: PR without the compatibility section fails" || bad "check: missing section"
printf '%s\r\n' "## Migration compatibility" "- 0001_x: n/a" "## Other" "0002_b" >"$T/body.md"
[[ "$(run_check --pr-body-file "$T/body.md")" == 1 ]] && grep -q "does not mention 0002_b" "$T/out" \
  && ok "check: the section must name every changed migration (text after the next heading does not count)" || bad "check: unnamed"
printf '%s\n' "## migration compatibility" "- 0002_b: adds nullable b; old version ignores it; test: old reads/writes a" >"$T/body.md"
[[ "$(run_check --pr-body-file "$T/body.md")" == 0 ]] && ok "check: section naming the migration passes" || bad "check: section ok"
echo "CREATE TABLE c (id int);" >"$R/$M/0003_c.sql"; git -C "$R" add -A; git -C "$R" commit -qm c
[[ "$(run_check --pr-body-file "$T/body.md")" == 1 ]] && grep -q "does not mention 0003_c" "$T/out" \
  && ok "check: a migration with no candidate still has to be self-reported" || bad "check: self-report"
printf 'import sys; sys.exit(3)\n' >"$R/scripts/lib/v5-migration-compat.py"
[[ "$(run_check)" == 1 ]] && grep -q 'compat detector failed (rc=3)' "$T/out" && ok "check: detector crash fails closed" || bad "check: crash"
[[ "$(cd "$R" && bash scripts/v5-selfhost-migration-compat-check.sh >/dev/null 2>&1; echo $?)" == 2 ]] && ok "check: missing --base is a usage error" || bad "check: usage"

# The CI job runs it as a blocking step (not continue-on-error).
WF="$DIR/../.github/workflows/v5-selfhost-gates.yml"
job="$(awk '/^  migration-compat:/{f=1} f{print} f && /^  [a-z-]+:$/ && !/migration-compat/{exit}' "$WF")"
grep -q 'bash scripts/v5-selfhost-migration-compat-check.sh --base' <<<"$job" && ! grep -q 'continue-on-error' <<<"$job" \
  && grep -q 'pr-body-file' <<<"$job" && ok "workflow: migration-compat job runs the check blocking, with the PR body" || bad "workflow job"

echo "migration compat tests: $pass passed, $fail failed"
[[ "$fail" == 0 ]]
