#!/usr/bin/env python3
# Source-bound real registration, native SQL and production early binder fixture.
# Real oc-lease register + real SQL generators + actual early binder.
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True
SCRIPTS = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location(
    "policy_fixture", SCRIPTS / "__tests__/v5LeasePolicyAcceptance.test.py")
fm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fm)
TRAIN = "tr-20261019T000000Z-111111111111"
OTHER = "tr-20261019T000001Z-222222222222"
STAMP = "2026-10-19T00:00:00Z"


def run(args, env):
    return subprocess.run(args, env=env, text=True, capture_output=True,
                          timeout=20, check=False)


def caller_functions(path):
    lines = (SCRIPTS / "deploy-v5-selfhost.sh").read_text().splitlines(keepends=True)
    out = []
    for name in ["lease_train_load_lib", "proc_starttime_of"]:
        start = [i for i, line in enumerate(lines) if line.startswith(name + "() {")]
        fm.need(len(start) == 1, "missing actual caller function " + name)
        end = next(i for i in range(start[0] + 1, len(lines)) if lines[i].rstrip() == "}")
        out.extend(lines[start[0]:end + 1]); out.append("\n")
    path.write_text("".join(out))


NATIVE_BIND = r"""
set -Eeuo pipefail
source "$1/v5-lease-lib.sh"
views="$(lease_policy_views_sql deploy:selfhost)"
bind="$(lease_policy_bind_sql "$P521_TRAIN" "$P521_SHA" fixture)"
lease_tx <<SQL
.bail on
BEGIN IMMEDIATE;
$views
$bind
COMMIT;
SQL
"""

EARLY_BIND = r"""
set -Eeuo pipefail
SCRIPT_DIR="$1"
source "$SCRIPT_DIR/v5-lease-lib.sh"
source "$SCRIPT_DIR/lib/v5-selfhost-release-policy.sh"
source "$2"
log() { printf '%s\n' "$*"; }
LEASE_LIB="$SCRIPT_DIR/v5-lease-lib.sh"
LEASE_TRAIN_ID="$P521_TRAIN"; LEASE_TARGET_SHA="$P521_SHA"
LEASE_TRAIN_ACTIVE=0; DRY=0
SELFHOST_DEPLOY_LOCK="$OC_V5_SELFHOST_DEPLOY_LOCK"
exec 8>"$SELFHOST_DEPLOY_LOCK"
flock -x 8
if [[ "${P521_RACE:-0}" == 1 ]]; then
  # Transparent native SQL delegation. Only inject the old worker's real
  # executor_pid publication between binder's SELECT and its claim transaction.
  definition="$(declare -f lease_policy_bind_sql)"
  eval "${definition/lease_policy_bind_sql/native_lease_policy_bind_sql}"
  lease_policy_bind_sql() {
    printf '%s\n' "$RELEASE_POLICY_ORIGINAL_PID" >>"$P521_RACE_WITNESS"
    lease_sql "UPDATE train SET executor_pid=$$ WHERE id='$(lease_q "$LEASE_TRAIN_ID")' AND executor_pid=0;" >/dev/null
    native_lease_policy_bind_sql "$@"
  }
fi
rc=0
release_policy_bind_official_train_request "$P521_SHA" || rc=$?
owner_rc=-1
if [[ "$rc" == 0 && "${RELEASE_POLICY_MODE:-}" == user-impact-only ]]; then
  owner_rc=0; release_policy_require_owner || owner_rc=$?
fi
printf 'WITNESS {"rc":%s,"pid":%s,"mode":"%s","claimed":%s,"active":%s,"ownerRc":%s}\n' \
 "$rc" "$$" "${RELEASE_POLICY_MODE:-}" "${RELEASE_POLICY_CLAIMED:-0}" "$LEASE_TRAIN_ACTIVE" "$owner_rc"
exit "$rc"
"""


class Case:
    def __init__(self, root, repo, before_sha, sha):
        root.mkdir(mode=0o700)
        self.root, self.repo, self.sha = root, repo, sha
        self.db = root / "lease.db"
        self.env = {k:v for k,v in os.environ.items() if not k.startswith("GIT_")}
        for key in ["__OC_LEASE_LIB_LOADED", "OC_SESSION_KEY", "OPENCLAUDE_SESSION_KEY"]:
            self.env.pop(key, None)
        self.env.update(OC_V5_LEASE_DB=str(self.db),
            OC_V5_LEASE_LOCK=str(root / "lease-db.lock"),
            OC_V5_LEASE_REPO_ROOT=str(repo), OC_V5_LEASE_BRANCH="fixture",
            OC_V5_LEASE_LIVE_LINK=str(root / "live"),
            OC_V5_LEASE_SURVIVOR_STATE=str(root / "survivor.state"),
            OC_V5_SELFHOST_DEPLOY_LOCK=str(root / "deploy.lock"),
            OC_V5_RELEASE_POLICY_CONTEXT=str(root / "policy/unresolved.json"),
            OC_USER_ID="3", PYTHONDONTWRITEBYTECODE="1",
            P521_TRAIN=TRAIN, P521_SHA=sha,
            P521_RACE_WITNESS=str(root / "race.witness"))
        (root / "policy").mkdir(mode=0o700)
        (root / "before").mkdir()
        (root / "before/.complete").write_text(json.dumps({"sourceCommit": before_sha}))
        (root / "live").symlink_to(root / "before")
        (root / "survivor.state").write_text("phase=committed\n")
        self.functions = root / "caller.functions.sh"
        caller_functions(self.functions)
        result = run(["bash", "-euo", "pipefail", "-c",
                      'source "$1/v5-lease-lib.sh"; lease_init_db',
                      "fixture", str(SCRIPTS)], self.env)
        fm.need(result.returncode == 0, "actual lease_init_db")

    def sql(self, query, args=()):
        with sqlite3.connect(self.db) as con:
            return con.execute(query, args).fetchall()

    def snapshot(self):
        return {table: self.sql("SELECT * FROM " + table + " ORDER BY 1")
                for table in ["train", "lease", "event", "outbox"]}

    def register(self, owner, explicit=True, sha=None, ticket="OCV5-521"):
        args = ["bash", str(SCRIPTS / "oc-lease.sh"), "register", "--resource",
                "deploy:selfhost", "--mode", "ride", "--sha", sha or self.sha,
                "--callback", "none", "--uid", "3", "--owner", owner,
                "--ticket", ticket]
        if explicit:
            args += ["--release-policy", "user-impact-only"]
        return run(args, self.env)

    def train(self, sha=None):
        self.sql("""INSERT INTO train(id,resource,target_sha,status,owner,executor_pid,
                    evidence_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)""",
                 (TRAIN, "deploy:selfhost", sha or self.sha, "planned", "worker:424242", 0,
                  json.dumps({"fixtureTrain": {"keep": True}}), STAMP, STAMP))

    def native(self, sha=None):
        return run(["bash", "-c", NATIVE_BIND, "fixture", str(SCRIPTS)],
                   dict(self.env, P521_SHA=sha or self.sha))

    def early(self, race=False):
        result = run(["bash", "-c", EARLY_BIND, "fixture", str(SCRIPTS),
                      str(self.functions)], dict(self.env, P521_RACE=str(int(race))))
        lines = [x[len("WITNESS "):] for x in result.stdout.splitlines()
                 if x.startswith("WITNESS ")]
        fm.need(len(lines) == 1, "actual early binder did not return one witness")
        return result, json.loads(lines[0])

    def doc(self):
        return json.loads(self.sql("SELECT evidence_json FROM train WHERE id=?", (TRAIN,))[0][0])


def assert_registration_and_claim(c, before_sha):
    fm.need(c.register("first").returncode == 0, "actual explicit registration")
    ride = c.sql("SELECT id FROM lease")[0][0]
    # Fixture metadata is deliberately unrelated to the new policy nodes.
    c.sql("""UPDATE lease SET callback_session_key=?,callback_agent_id=?,
             result_json=json_set(result_json,'$.fixtureExtra',json(?)) WHERE id=?""",
          ("agent:fixture:webchat:dm:777", "fixture", '{"keep":[1,2]}', ride))
    before = c.snapshot()
    fm.need(c.register("first", ticket="OCV5-522").returncode == 0, "actual idempotent register")
    fm.need(c.snapshot() == before, "idempotent register changed callbacks, metadata or events")
    fm.need(c.register("mixed", explicit=False).returncode != 0, "same-source mixed register accepted")
    fm.need(c.snapshot() == before, "mixed register partially wrote")
    fm.need(c.register("old", sha=before_sha).returncode != 0, "non-tip explicit request accepted")
    fm.need(c.snapshot() == before, "wrong-source register partially wrote")
    c.train()
    before_late = c.snapshot()
    fm.need(c.register("late").returncode != 0, "late explicit register accepted")
    fm.need(c.snapshot() == before_late, "late register partially wrote")
    result, witness = c.early(race=True)
    fm.need(result.returncode == 0 and witness == {
        "rc": 0, "pid": witness["pid"], "mode": "user-impact-only",
        "claimed": 1, "active": 1, "ownerRc": 0}, "actual raced early claim failed")
    fm.need((c.root / "race.witness").read_text().splitlines() == ["0"],
            "race did not occur after native original PID0 read")
    doc = c.doc()
    fm.need(doc["releasePolicy"] == {"schema": 1, "mode": "user-impact-only",
        "sourceSha": c.sha, "leaseIds": [ride]}, "exact source/frozen ID set differs")
    fm.need(doc["fixtureTrain"] == {"keep": True}, "train metadata overwritten")
    fm.need(c.sql("SELECT executor_pid,status FROM train")[0] == (witness["pid"], "building"),
            "native worker0-to-publisher PID CAS not persisted")
    row = c.sql("SELECT callback_session_key,callback_agent_id,ticket_ref,result_json FROM lease")[0]
    fm.need(row[:3] == ("agent:fixture:webchat:dm:777", "fixture", "OCV5-521"),
            "binder changed original callback ownership")
    result_doc = json.loads(row[3])
    fm.need(result_doc["fixtureExtra"] == {"keep": [1,2]}, "lease metadata overwritten")
    fm.need(result_doc["request"]["releasePolicy"] == {"schema":1,"mode":"user-impact-only","sourceSha":c.sha},
            "immutable original request changed")
    fm.need(result_doc["releasePolicyBinding"] == {"schema":1,"trainId":TRAIN,"sourceSha":c.sha},
            "actual native receipt differs")
    frozen, leases = c.doc(), c.sql("SELECT * FROM lease ORDER BY seq")
    result, witness = c.early()
    fm.need(result.returncode != 0 and witness["claimed"] == 0,
            "existing nonce was falsely reported as a fresh successful claim")
    fm.need(c.doc() == frozen and c.sql("SELECT * FROM lease ORDER BY seq") == leases,
            "rejected rebind replaced original nonce/snapshot/bindings/metadata")
    # The real early binder may separately mark the verified train failed.
    # Do NOT claim its whole DB is unchanged on this deliberate rejection.


def native_rejection(c, kind):
    fm.need(c.register("one").returncode == 0, "native negative seed register one")
    fm.need(c.register("two").returncode == 0, "native negative seed register two")
    c.train()
    if kind == "mixed":
        c.sql("UPDATE lease SET result_json='{}' WHERE owner='two'")
    elif kind == "conflicting-binding":
        c.sql("UPDATE lease SET result_json=json_set(result_json,'$.releasePolicyBinding',json(?)) WHERE owner='two'",
              (json.dumps({"schema":1,"trainId":OTHER,"sourceSha":c.sha}),))
    elif kind == "late-snapshot":
        fm.need(c.native().returncode == 0, "actual initial native freeze")
        # Model a row arriving from an older registrar after native freeze.
        c.sql("""INSERT INTO lease(id,resource,mode,status,owner,owner_uid,want_sha,
                 result_json,created_at,updated_at) SELECT ?,resource,mode,status,?,owner_uid,want_sha,
                 json_object('request',json_extract(result_json,'$.request')),created_at,updated_at
                 FROM lease WHERE owner='one'""",
              ("ls-20261019T000001Z-444444444444", "third"))
    else:
        raise AssertionError(kind)
    before = c.snapshot()
    fm.need(c.native().returncode != 0, "native SQL accepted " + kind)
    fm.need(c.snapshot() == before, "native SQL rejection partially wrote " + kind)


def main():
    with tempfile.TemporaryDirectory(prefix="ocv5-521-register-bind-") as temp:
        root = Path(temp)
        repo, (before, target, next_sha) = fm.git_fixture(root)
        origin = root / "origin.git"
        env = {k:v for k,v in os.environ.items() if not k.startswith("GIT_")}
        env.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull)
        for cmd in [["git","init","-q","--bare",str(origin)],
                    ["git","-C",str(repo),"remote","add","origin",str(origin)],
                    ["git","-C",str(repo),"push","-q","origin",target+":refs/heads/fixture"],
                    ["git","-C",str(repo),"checkout","-q","--detach",target]]:
            fm.need(run(cmd, env).returncode == 0, "private local origin setup")
        assert_registration_and_claim(Case(root/"claim",repo,before,target), before)
        legacy = Case(root/"legacy",repo,before,target)
        fm.need(legacy.register("legacy", explicit=False).returncode == 0, "actual default legacy register")
        legacy.train(); snap = legacy.snapshot()
        result, witness = legacy.early()
        fm.need(result.returncode == 0 and witness["mode"] == "" and witness["claimed"] == 0,
                "unrequested legacy policy changed behavior")
        fm.need(legacy.snapshot() == snap, "legacy early binder wrote policy/owner")
        for kind in ["mixed", "conflicting-binding", "late-snapshot"]:
            native_rejection(Case(root/kind,repo,before,target), kind)
        frozen = Case(root/"source-freeze",repo,before,target)
        fm.need(frozen.register("before-tip-advance").returncode == 0, "source freeze actual register")
        fm.need(run(["git","-C",str(repo),"push","-q","origin",next_sha+":refs/heads/fixture"],env).returncode == 0,
                "private fast-forward tip")
        fm.need(run(["git","-C",str(repo),"checkout","-q","--detach",next_sha],env).returncode == 0,
                "private publisher advanced HEAD")
        frozen.train(sha=next_sha); snap = frozen.snapshot()
        fm.need(frozen.native(sha=next_sha).returncode != 0, "old explicit request silently followed advanced tip")
        fm.need(frozen.snapshot() == snap, "source freeze rejection partially wrote")
    print("PASS actual register / native SQL / early PID0-race / legacy / rejection cases")


if __name__ == "__main__":
    main()
