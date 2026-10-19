#!/usr/bin/env python3
"""Focused source-bound reader integration fixture.

Install as scripts/__tests__/v5LeasePolicyAcceptance.test.py. It sources the real
shared library/worker and uses real SQLite plus foundation prepare/checkpoint/
resolve. Only temporary fixture roots are mutated. No worker main, paid gates,
production env/DB, systemd, network or production process is called.
Synthetic accepted observations below test the reader contract; they do not
claim that actual release gates passed. Terminal/PID claiming belongs to the
separate actual caller harness.
"""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sqlite3
import stat
import subprocess
import sys
import tempfile
from unittest import mock

sys.dont_write_bytecode = True
SCRIPTS = Path(__file__).resolve().parents[1]
LIB = SCRIPTS / "v5-lease-lib.sh"
WORKER = SCRIPTS / "v5-lease-worker.sh"
HELPER = SCRIPTS / "lib/v5-release-policy.py"
try:
    spec = importlib.util.spec_from_file_location("v5_policy_acceptance_fixture", HELPER)
    policy = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(policy)
except Exception as exc:
    print("FAIL fixture_import error=" + type(exc).__name__)
    raise SystemExit(1)
TRAIN = "tr-20261019T000000Z-111111111111"
OTHER = "tr-20261019T000001Z-222222222222"
RIDE = "ls-20261019T000000Z-333333333333"
STAMP = "2026-10-19T00:00:00Z"
NONCE = "fixture-nonce-521"
LAST = {}


def need(ok, label):
    if not ok:
        raise AssertionError(label)


def command(argv, env=None):
    return subprocess.run(argv, env=env, capture_output=True, text=True,
                          timeout=30, check=False)


def json_bytes(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def git_fixture(root):
    repo = root / "fixture-repo"
    repo.mkdir()
    # A caller's GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE must never redirect fixture
    # commits to a real checkout. Drop inherited Git controls before any git call.
    env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    env.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull,
               GIT_AUTHOR_NAME="Policy fixture", GIT_AUTHOR_EMAIL="fixture@example.invalid",
               GIT_COMMITTER_NAME="Policy fixture", GIT_COMMITTER_EMAIL="fixture@example.invalid",
               GIT_AUTHOR_DATE=STAMP, GIT_COMMITTER_DATE=STAMP)
    need(command(["git", "-C", str(repo), "init", "-q"], env).returncode == 0,
         "fixture git init")
    shas = []
    for label in ["before", "target", "descendant"]:
        result = command(["git", "-C", str(repo), "-c", "commit.gpgsign=false",
                          "commit", "-q", "--allow-empty", "-m", label], env)
        need(result.returncode == 0, "fixture git commit")
        result = command(["git", "-C", str(repo), "rev-parse", "HEAD"], env)
        need(result.returncode == 0, "fixture git rev-parse")
        shas.append(result.stdout.strip())
    return repo, shas


class Fixture:
    def __init__(self, root, repo, shas, explicit=True, accepted=True, legacy=False):
        self.root = root
        root.mkdir(mode=0o700)
        self.repo, (self.before_sha, self.sha, self.next_sha) = repo, shas
        self.db = root / "lease.db"
        self.active = root / "policy/unresolved.json"
        self.active.parent.mkdir(mode=0o700)
        self.archive = self.active.with_name(self.active.name + ".resolved." + TRAIN + ".json")
        self.live = root / "live"
        self.before = self.release("before", self.before_sha)
        self.target = self.release("target", self.sha)
        self.live.symlink_to(self.target)
        self.env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
        self.env.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull)
        self.env.pop("__OC_LEASE_LIB_LOADED", None)
        self.env.update({
            "OC_V5_LEASE_DB": str(self.db),
            "OC_V5_LEASE_LOCK": str(root / "lease-db.lock"),
            "OC_V5_LEASE_REPO_ROOT": str(repo),
            "OC_V5_LEASE_LIVE_LINK": str(self.live),
            "OC_V5_LEASE_SURVIVOR_STATE": str(root / "survivor.state"),
            "OC_V5_LEASE_SURVIVOR_COMMITTED": str(root / "survivor.committed"),
            "OC_V5_SELFHOST_DEPLOY_LOCK": str(root / "deploy.lock"),
            "OC_V5_LEASE_CUTOVER_GRACE_FILE": str(root / "grace"),
            "OC_V5_LEASE_WORKER_LOCK": str(root / "worker.lock"),
            "OC_V5_LEASE_LOG_DIR": str(root / "logs"),
            "OC_V5_AUTORECOVER_DIR": str(root / "autorecover"),
            "OC_V5_TASK_SPOOL_DIR": str(root / "task-spool"),
            "OC_V5_RELEASE_POLICY_CONTEXT": str(self.active),
            "PYTHONDONTWRITEBYTECODE": "1",
            "OC_V5_LEASE_DRY": "0",
        })
        need(self.call("lease_init_db").returncode == 0, "real lease_init_db")
        (root / "survivor.state").write_text("phase=committed\n")
        self.request = {
            "edition": "selfhost", "operationId": TRAIN, "candidateSha": self.sha,
            "owner": {"deploymentId": TRAIN, "nonce": NONCE},
            "before": self.stack(self.before, self.before_sha, "bundles/before"),
            "target": self.stack(self.target, self.sha, "bundles/target"),
            "history": {"path": str(root / "history.jsonl"),
                        "predecessorSha256": hashlib.sha256(b"").hexdigest(),
                        "transitionKind": "joint"},
        }
        self.evidence = {"fixture": "legacy"} if legacy else {
            "releasePolicy": {"schema": 1, "mode": "user-impact-only",
                              "sourceSha": self.sha, "leaseIds": [RIDE]},
            "releasePolicyOwner": {"nonce": NONCE, "pid": 123456789, "startTicks": "1"},
            "releasePolicyAcceptance": {"schema": 1, "operationId": TRAIN,
                "candidateSha": self.sha, "nonce": NONCE,
                "targetStackSha256": policy.stack_digest(self.request["target"]),
                "resolution": "forward"},
        }
        self.insert_train(TRAIN, self.sha, "committed", self.target, self.evidence)
        self.set_ride(explicit=explicit, bound=explicit and not legacy)
        if not legacy:
            policy.prepare(self.active, self.request)
            policy.checkpoint(self.active, TRAIN, {"phase": "exposure-armed", "mayHaveServed": True,
                "observations": self.observed(self.request["target"])})
            if accepted:
                policy.resolve(self.active, TRAIN, "forward")

    def release(self, name, sha):
        p = self.root / name
        p.mkdir()
        (p / ".complete").write_bytes(json_bytes({"sourceCommit": sha, "fixture": name}))
        return p

    def stack(self, release, sha, current):
        return {"masterRelease": str(release), "currentTarget": current,
                "tuple": {"OC_RUNTIME_IMAGE": None, "OC_RUNTIME_IMAGE_ID": "",
                          "OC_RUNTIME_RELEASE": "/fixture/runtime", "OC_PLATFORM_BUNDLE": ""},
                "sourceCommit": sha,
                "sourceDigest": hashlib.sha256((release / ".complete").read_bytes()).hexdigest(),
                "port": 18790}

    @staticmethod
    def observed(stack):
        return {"identity": "exact", "service": "usable", "authority": "unobserved",
                "allRequiredPassed": True, "lineageCoherent": True,
                "verifiedDirection": "target", "verifiedStackSha256": policy.stack_digest(stack)}

    def sql(self, text, args=()):
        with sqlite3.connect(self.db) as con:
            return con.execute(text, args).fetchall()

    def insert_train(self, identity, sha, status, rel, evidence):
        self.sql("""INSERT INTO train(id,resource,target_sha,status,owner,executor_pid,rel_path,
                    evidence_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)""",
                 (identity, "deploy:selfhost", sha, status, "fixture", 123456789,
                  None if rel is None else str(rel), json.dumps(evidence), STAMP, STAMP))

    def update_evidence(self, mutate):
        doc = json.loads(self.sql("SELECT evidence_json FROM train WHERE id=?", (TRAIN,))[0][0])
        mutate(doc)
        self.sql("UPDATE train SET evidence_json=? WHERE id=?", (json.dumps(doc), TRAIN))

    def set_ride(self, explicit=True, bound=True):
        doc = {}
        if explicit:
            doc["request"] = {"releasePolicy": {"schema": 1, "mode": "user-impact-only", "sourceSha": self.sha}}
        if bound:
            doc["releasePolicyBinding"] = {"schema": 1, "trainId": TRAIN, "sourceSha": self.sha}
        self.sql("""INSERT OR REPLACE INTO lease(id,resource,mode,status,owner,owner_uid,want_sha,
                    result_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)""",
                 (RIDE, "deploy:selfhost", "ride", "registered", "fixture", "fixture",
                  self.sha, json.dumps(doc), STAMP, STAMP))

    def ride_doc(self, mutate):
        doc = json.loads(self.sql("SELECT result_json FROM lease WHERE id=?", (RIDE,))[0][0])
        mutate(doc)
        self.sql("UPDATE lease SET result_json=? WHERE id=?", (json.dumps(doc), RIDE))

    def archive_doc(self, mutate):
        doc = json.loads(self.archive.read_text())
        mutate(doc)
        self.archive.write_bytes(json_bytes(doc))
        self.archive.chmod(0o600)

    def call(self, function, *args, worker=False, lib=None):
        source = WORKER if worker else (lib or LIB)
        return command(["bash", "-euo", "pipefail", "-c", 'source "$1"; shift; "$@"',
                        "fixture", str(source), function, *map(str, args)], self.env)

    def snapshot(self):
        return {table: self.sql("SELECT * FROM " + table + " ORDER BY 1")
                for table in ["train", "lease", "event", "outbox"]}

    def witness(self, result):
        return {"rc": result.returncode, "stderr_nonempty": bool(result.stderr),
                "active": self.active.exists() or self.active.is_symlink(),
                "archive": self.archive.exists(),
                "train": [x[0] for x in self.sql("SELECT status FROM train ORDER BY seq")],
                "ride": [x[0] for x in self.sql("SELECT status FROM lease ORDER BY seq")],
                "events": self.sql("SELECT count(*) FROM event")[0][0],
                "outbox": self.sql("SELECT count(*) FROM outbox")[0][0]}

    def probe(self, good, function="lease_live_committed_sha", *args, lib=None):
        global LAST
        before = self.snapshot()
        result = self.call(function, *args, lib=lib)
        LAST = self.witness(result)
        need((result.returncode == 0) == good, "reader return status")
        if good and function == "lease_live_committed_sha":
            live_sha = json.loads((self.live.resolve() / ".complete").read_text())["sourceCommit"]
            need(result.stdout.strip() == live_sha, "reader exact stdout SHA")
        need(self.snapshot() == before, "reader changed SQLite rows")
        need("fixture-nonce" not in result.stdout + result.stderr, "reader leaked nonce")
        return result

    def settle(self, satisfied):
        global LAST
        result = self.call("settle_rides", worker=True)
        LAST = self.witness(result)
        need(result.returncode == 0, "real settle_rides returned nonzero")
        need(LAST["ride"] == (["satisfied"] if satisfied else ["registered"]), "ride terminal status")
        need(LAST["outbox"] == int(satisfied), "satisfaction outbox count")
        return result

    def other_archive(self):
        request = copy.deepcopy(self.request)
        request["operationId"] = OTHER
        request["owner"]["deploymentId"] = OTHER
        policy.prepare(self.active, request)
        policy.checkpoint(self.active, OTHER, {"phase": "exposure-armed", "mayHaveServed": True,
                                             "observations": self.observed(request["target"])})
        return policy.resolve(self.active, OTHER, "forward")

    def advance(self):
        release = self.release("descendant", self.next_sha)
        self.insert_train(OTHER, self.next_sha, "committed", release, {"fixture": "legacy descendant"})
        self.live.unlink()
        self.live.symlink_to(release)
        return release


def immutable_tree(root):
    """All directory/file/link identities except atime, which reading may change."""
    result = {}
    for path in [root, *sorted(root.rglob("*"))]:
        info = path.lstat()
        if stat.S_ISREG(info.st_mode):
            content = hashlib.sha256(path.read_bytes()).hexdigest()
        elif stat.S_ISDIR(info.st_mode):
            content = None
        elif stat.S_ISLNK(info.st_mode):
            content = os.readlink(path)
        else:
            raise AssertionError("unexpected fixture tree entry type")
        result[str(path.relative_to(root))] = (
            info.st_mode, info.st_uid, info.st_gid, info.st_size,
            info.st_mtime_ns, info.st_ctime_ns, content)
    return result


def readonly_no_ambient_bytecode(f):
    # New, owned target release; keep it writable so EACCES cannot hide this bug.
    # These are exact source bytes, not a copied/fake acceptance predicate.
    scripts = f.target / "scripts"
    helper_dir = scripts / "lib"
    helper_dir.mkdir(parents=True, mode=0o700)
    copied_lib = scripts / "v5-lease-lib.sh"
    copied_helper = helper_dir / "v5-release-policy.py"
    copied_adapter = helper_dir / "v5-selfhost-release-policy.sh"
    for source, target in [(LIB, copied_lib), (HELPER, copied_helper),
                           (SCRIPTS / "lib/v5-selfhost-release-policy.sh", copied_adapter)]:
        shutil.copy2(source, target)
        need(target.read_bytes() == source.read_bytes(), "not exact production source bytes")
    need(os.access(helper_dir, os.W_OK), "bytecode test requires writable owned helper dir")
    need(not list(f.target.rglob("__pycache__")) and not list(f.target.rglob("*.pyc")),
         "new fixture must begin without bytecode/cache directories")

    clean_env = f.env.copy()
    for key in ["PYTHONDONTWRITEBYTECODE", "PYTHONPYCACHEPREFIX", "PYTHONPATH", "PYTHONHOME",
                "DATABASE_URL"]:
        clean_env.pop(key, None)
    need("PYTHONDONTWRITEBYTECODE" not in clean_env and "PYTHONPYCACHEPREFIX" not in clean_env,
         "qualifying reader invocation must have no ambient bytecode suppression/redirect")
    clean_env.update(MASTER_RELEASES_ROOT=str(f.root), MASTER_LIVE_LINK=str(f.live))

    # Prove this actual child interpreter can create a real .pyc under this env.
    # This writes only a sacrificial control module outside the sealed target.
    control = f.root / "bytecode-positive-control"
    control.mkdir(mode=0o700)
    module = control / "cache_control.py"
    module.write_text("value = 521\n")
    result = command(["python3", "-c", """
import importlib.util,pathlib,sys
assert not sys.dont_write_bytecode, 'child bytecode disabled before reader test'
path=pathlib.Path(sys.argv[1])
spec=importlib.util.spec_from_file_location('bytecode_positive_control',path)
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
assert pathlib.Path(importlib.util.cache_from_source(str(path))).is_file(), 'no real pyc control'
""", str(module)], clean_env)
    need(result.returncode == 0 and bool(list(control.rglob("*.pyc"))),
         "real default-bytecode positive control did not create pyc")

    # Use the real master artifact digest, not an imitation or an exclude list.
    master_lib = SCRIPTS / "v5-selfhost-master-release-lib.sh"
    def artifact_digest():
        result = command(["bash", "-euo", "pipefail", "-c",
                          'source "$1"; release_artifact_digest "$2"',
                          "fixture", str(master_lib), str(f.target)], clean_env)
        value = result.stdout.strip()
        need(result.returncode == 0 and len(value) == 64 and
             all(c in "0123456789abcdef" for c in value), "actual artifact digest failed")
        return value

    before_tree = immutable_tree(f.target)
    before_digest = artifact_digest()
    before_complete = (f.target / ".complete").read_bytes()
    before_sql = f.snapshot()
    original_env = f.env
    f.env = clean_env
    try:
        # The actual reader and loader execute in the exact copied production
        # shared library under a new shell whose PYTHONDONTWRITEBYTECODE is absent.
        # Repeat after the cold read; no deletion/repair of caches between reads.
        for _ in range(2):
            f.probe(True, "lease_policy_archive_accepted", TRAIN, f.sha,
                    "current", f.target, RIDE, lib=copied_lib)
            need(immutable_tree(f.target) == before_tree,
                 "acceptance reader mutated sealed release directory tree")
            need(artifact_digest() == before_digest,
                 "acceptance reader changed real release artifact digest")
            need((f.target / ".complete").read_bytes() == before_complete,
                 "acceptance reader changed manifest bytes")
            need(f.snapshot() == before_sql, "acceptance reader mutated SQLite rows")

        # The other production dynamic-import entry already owns a command-local
        # suppression. Exercise its real field reader without global suppression.
        # A valid owned active snapshot is setup outside the target release only.
        shutil.copy2(f.archive, f.active)
        adapter_env = clean_env.copy()
        adapter_env["SCRIPT_DIR"] = str(scripts)
        result = command(["bash", "-euo", "pipefail", "-c", """
source "$1"
RELEASE_POLICY_CONTEXT="$2"
RELEASE_POLICY_OPERATION="$3"
release_policy_py field phase
""", "fixture", str(copied_adapter), str(f.active), TRAIN], adapter_env)
        need(result.returncode == 0 and result.stdout.strip() == "resolved",
             "actual selfhost policy field reader failed")
        need(immutable_tree(f.target) == before_tree and artifact_digest() == before_digest,
             "selfhost policy import mutated sealed release tree/digest")
        need((f.target / ".complete").read_bytes() == before_complete and f.snapshot() == before_sql,
             "readonly imports mutated manifest or SQLite rows")
    finally:
        f.env = original_env
    need(not list(f.target.rglob("__pycache__")) and not list(f.target.rglob("*.pyc")),
         "readonly imports added a cache directory/file")


def main():
    failures = 0
    cases = []

    def case(name, fn, **options):
        cases.append((name, fn, options))

    case("accepted_exact_archive", lambda f: f.probe(True))
    case("readonly_import_no_ambient_bytecode", readonly_no_ambient_bytecode)
    case("legacy_without_policy_unchanged", lambda f: f.probe(True), legacy=True, explicit=False)

    def presence(f, shape):
        if shape == "valid": policy.prepare(f.active, f.request)
        elif shape == "corrupt": f.active.write_bytes(b"{")
        elif shape == "directory": f.active.mkdir()
        else: f.active.symlink_to(f.root / "absent-target")
        f.probe(False)
    for shape in ["valid", "corrupt", "directory", "broken-symlink"]:
        case("active_barrier_" + shape, lambda f, s=shape: presence(f, s))

    def expected(f, key, value):
        f.update_evidence(lambda e: e["releasePolicyAcceptance"].__setitem__(key, value))
        f.probe(False)
    for key, value in [("operationId", OTHER), ("nonce", "foreign-nonce"),
                       ("targetStackSha256", "f" * 64), ("resolution", "compensated")]:
        case("expectation_" + key, lambda f, k=key, v=value: expected(f, k, v))
    def archive_owner(f):
        f.archive_doc(lambda c: c["owner"].__setitem__("nonce", "foreign-nonce")); f.probe(False)
    case("archive_owner_nonce", archive_owner)
    def other_same_sha(f):
        f.other_archive(); f.archive.unlink(); f.probe(False)
    case("other_same_sha_archive_never_substitutes", other_same_sha)
    def wrong_direction(f):
        f.archive_doc(lambda c: c.__setitem__("resolution", "compensated")); f.probe(False)
    case("archive_wrong_resolution", wrong_direction)

    def observation(f, key, value):
        def mutate(c):
            if value is None: c["observations"].pop(key, None)
            else: c["observations"][key] = value
        f.archive_doc(mutate); f.probe(False)
    for key, value in [("allRequiredPassed", None), ("allRequiredPassed", False),
                       ("allRequiredPassed", "true"), ("lineageCoherent", False),
                       ("verifiedDirection", "before"), ("verifiedStackSha256", "f" * 64),
                       ("identity", "unknown"), ("service", "unknown")]:
        case("observation_" + key + "_" + str(value), lambda f, k=key, v=value: observation(f, k, v))

    def status(f, value):
        f.sql("UPDATE train SET status=? WHERE id=?", (value, TRAIN)); f.probe(False)
    for value in ["failed", "building"]:
        case("train_not_committed_" + value, lambda f, v=value: status(f, v))
    def wrong_path(f):
        f.sql("UPDATE train SET rel_path=? WHERE id=?", (str(f.before), TRAIN)); f.probe(False)
    case("train_live_path_mismatch", wrong_path)
    def complete_changed(f):
        (f.target / ".complete").write_bytes(json_bytes({"sourceCommit": f.sha, "changed": True})); f.probe(False)
    case("complete_same_source_different_bytes", complete_changed)
    def physical_other(f):
        another = f.release("other-same-sha", f.sha)
        f.live.unlink(); f.live.symlink_to(another); f.probe(False)
    case("physical_other_release_same_source", physical_other)
    def newer_unexposed(f):
        e = copy.deepcopy(f.evidence)
        e["releasePolicyAcceptance"]["operationId"] = OTHER
        f.insert_train(OTHER, f.sha, "failed", None, e); f.probe(True)
    case("actual_owner_beats_newer_unexposed_same_sha", newer_unexposed)

    case("explicit_unbound_same_live_stays_registered",
         lambda f: (f.set_ride(explicit=True, bound=False), f.settle(False)))
    def wrong_binding(f, key, value):
        f.ride_doc(lambda d: d["releasePolicyBinding"].__setitem__(key, value)); f.settle(False)
    case("ride_wrong_train_binding", lambda f: wrong_binding(f, "trainId", OTHER))
    case("ride_wrong_source_binding", lambda f: wrong_binding(f, "sourceSha", f.before_sha))
    def not_in_snapshot(f):
        f.update_evidence(lambda e: e["releasePolicy"].__setitem__("leaseIds", [])); f.settle(False)
    case("ride_not_in_frozen_snapshot", not_in_snapshot)
    def request_changed(f):
        f.ride_doc(lambda d: d["request"]["releasePolicy"].__setitem__("mode", "foreign")); f.settle(False)
    case("ride_request_changed", request_changed)
    def historical(f):
        current = f.advance()
        f.probe(True, "lease_policy_archive_accepted", TRAIN, f.sha, "historical", current, RIDE)
        f.settle(True)
        before = f.snapshot()
        f.settle(True)
        need(f.snapshot() == before, "second settle not idempotent")
    case("accepted_historical_ancestor_settles_once", historical)
    def legacy_borrow(f):
        f.set_ride(explicit=False, bound=False)
        f.sql("UPDATE train SET status='failed' WHERE id=?", (TRAIN,))
        f.archive.unlink(); f.settle(False)
    case("legacy_ride_cannot_borrow_failed_policy_live", legacy_borrow)

    def bad_evidence(f):
        f.sql("UPDATE train SET evidence_json='{' WHERE id=?", (TRAIN,)); f.probe(False)
    case("malformed_train_metadata", bad_evidence)
    def lost_policy_node(f):
        f.update_evidence(lambda e: e.pop("releasePolicy")); f.probe(False)
    case("bound_ride_prevents_metadata_legacy_fallback", lost_policy_node)
    def archive_shape(f, shape):
        if shape == "symlink":
            saved = f.root / "saved-archive"
            f.archive.rename(saved); f.archive.symlink_to(saved)
        elif shape == "public-mode": f.archive.chmod(0o644)
        else: f.archive.write_bytes(b"{")
        f.probe(False)
    for shape in ["symlink", "public-mode", "truncated"]:
        case("archive_shape_" + shape, lambda f, s=shape: archive_shape(f, s))
    def missing_helper(f):
        copied = f.root / "isolated-scripts/v5-lease-lib.sh"
        copied.parent.mkdir(); copied.write_bytes(LIB.read_bytes())
        f.probe(False, lib=copied)
    case("source_only_shared_lib_missing_helper_fails_closed", missing_helper)

    def lost_ack(f):
        sync = policy.sync_directory
        def after_unlink(path):
            if not f.active.exists() and f.archive.exists():
                raise OSError("fixture lost unlink directory-fsync ACK")
            return sync(path)
        failed = False
        with mock.patch.object(policy, "sync_directory", side_effect=after_unlink):
            try: policy.resolve(f.active, TRAIN, "forward")
            except OSError: failed = True
        need(failed and not f.active.exists() and f.archive.exists(), "lost-ACK witness")
        f.probe(True)
        f.settle(True)
    case("unlink_ack_loss_exact_archive_allows_finite_acceptance", lost_ack, accepted=False)

    with tempfile.TemporaryDirectory(prefix="ocv5-521-acceptance-fixture-") as name:
        top = Path(name)
        need((top.stat().st_mode & 0o077) == 0, "temporary root must be private")
        repo, shas = git_fixture(top)
        for index, (name, fn, options) in enumerate(cases):
            global LAST
            LAST = {}
            try:
                fixture = Fixture(top / ("case-" + str(index)), repo, shas, **options)
                fn(fixture)
                print("PASS " + name + " witness=" + json.dumps(LAST, sort_keys=True, separators=(",", ":")))
            except Exception as exc:
                failures += 1
                # Deliberately do not emit raw subprocess stdout/stderr, env,
                # tuple values or nonce. Structural witness is sufficient.
                check = " check=" + json.dumps(str(exc)) if isinstance(exc, AssertionError) else ""
                print("FAIL " + name + " error=" + type(exc).__name__ + check +
                      " witness=" + json.dumps(LAST, sort_keys=True, separators=(",", ":")))
        print(("FAIL" if failures else "PASS") + " total=" + str(len(cases)) + " failed=" + str(failures))
    return int(failures != 0)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, subprocess.SubprocessError, AssertionError) as exc:
        check = " check=" + json.dumps(str(exc)) if isinstance(exc, AssertionError) else ""
        print("FAIL fixture_setup error=" + type(exc).__name__ + check)
        raise SystemExit(1)
