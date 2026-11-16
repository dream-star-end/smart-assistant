#!/usr/bin/env python3
"""Red/green unit + production-shell integration proofs for OCV5-774:
local input-digest gate receipt cache & per-gate checkpoint resume.
"""
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[2]
CACHE_PY = ROOT / "scripts/lib/v5-selfhost-local-gate-cache.py"
RECEIPTS_SH = ROOT / "scripts/lib/v5-selfhost-gate-receipts.sh"
BUILD_JOBS_SH = ROOT / "scripts/lib/v5-selfhost-build-jobs.sh"
SUMMARY_SH = ROOT / "scripts/lib/v5-selfhost-train-summary.sh"
MASTER_LIB_SH = ROOT / "scripts/v5-selfhost-master-release-lib.sh"
MANIFEST_JSON = ROOT / "deploy/v5/selfhost-release-gates.json"

spec = importlib.util.spec_from_file_location("local_gate_cache", CACHE_PY)
assert spec and spec.loader
cache_mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cache_mod)


def extract_fn(src: str, name: str) -> str:
    match = re.search(rf"^{re.escape(name)}\(\) \{{[^\n]*\n[\s\S]*?^\}}", src, re.M)
    assert match, f"missing function {name}"
    return match.group(0)


class LocalGateCacheTest(unittest.TestCase):
    def setUp(self) -> None:
        parent_dir = "/root" if os.geteuid() == 0 and Path("/root").is_dir() else None
        self.tmp = tempfile.TemporaryDirectory(prefix="oc-local-gate-cache-", dir=parent_dir)
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name).resolve()
        os.chmod(self.base, 0o700)
        self.cache_dir = self.base / "gate-receipts"
        self.plan_dir = self.base / "plan"
        self.plan_dir.mkdir(mode=0o700)
        self.repo = self.base / "repo"
        self.init_fixture_repo()

    def git(self, *args: str) -> str:
        env = {
            "PATH": os.environ["PATH"],
            "HOME": str(self.base),
            "LC_ALL": "C.UTF-8",
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": "/dev/null",
        }
        proc = subprocess.run(
            ["git", "-C", str(self.repo), *args],
            env=env,
            capture_output=True,
            text=True,
            check=True,
        )
        return proc.stdout.strip()

    def write_repo(self, rel: str, content: str) -> None:
        target = self.repo / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")

    def commit_all(self, msg: str) -> str:
        self.git("add", "-A")
        self.git("commit", "-qm", msg)
        return self.git("rev-parse", "HEAD")

    def init_fixture_repo(self) -> None:
        self.repo.mkdir()
        self.git("init", "-q", "-b", "feat/v5-selfhost")
        self.git("config", "user.name", "test")
        self.git("config", "user.email", "test@example.invalid")
        self.write_repo("deploy/v5/selfhost-release-gates.json", MANIFEST_JSON.read_text(encoding="utf-8"))
        self.write_repo("package.json", '{"name":"root"}\n')
        self.write_repo("package-lock.json", '{"lockfileVersion":3}\n')
        self.write_repo("scripts/check-x.ts", "// v1\n")
        self.write_repo("packages/protocol/package.json", '{"name":"@openclaude/protocol"}\n')
        self.write_repo("packages/protocol/src/index.ts", "export const P = 1;\n")
        self.write_repo(
            "packages/storage/package.json",
            json.dumps({"name": "@openclaude/storage", "dependencies": {"@openclaude/protocol": "*"}}) + "\n",
        )
        self.write_repo("packages/storage/src/db.ts", "export const S = 1;\n")
        self.write_repo(
            "packages/gateway/package.json",
            json.dumps({
                "name": "@openclaude/gateway",
                "dependencies": {"@openclaude/protocol": "*", "@openclaude/storage": "*"},
            }) + "\n",
        )
        self.write_repo("packages/gateway/src/server.ts", "export const G = 1;\n")
        self.write_repo(
            "packages/commercial/package.json",
            json.dumps({
                "name": "@openclaude/commercial",
                "dependencies": {"@openclaude/gateway": "*", "@openclaude/protocol": "*", "@openclaude/storage": "*"},
            }) + "\n",
        )
        self.write_repo("packages/commercial/agent-sandbox/platform-runtime/prompts/p.md", "prompt v1\n")
        self.write_repo("packages/commercial/src/ws/bridge.ts", "export const C = 1;\n")
        self.write_repo("packages/web-react/src/App.tsx", "export const W = 1;\n")
        self.write_repo("e2e/session-display/incidents.json", '{"incidents":[]}\n')
        self.write_repo("docs/notes.md", "doc v1\n")
        self.sha1 = self.commit_all("initial")

    def run_cli(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["python3", str(CACHE_PY), *args],
            capture_output=True,
            text=True,
            check=False,
        )

    def test_manifest_coverage_and_scope_isolation_across_commits(self) -> None:
        manifest = json.loads(MANIFEST_JSON.read_text(encoding="utf-8"))
        c_gates = {
            g["id"] for g in manifest["gates"]
            if not g.get("stage") and g["id"] not in ("web-react-production-build", "oc-memory-mcp-build")
        }
        self.assertEqual(set(cache_mod.GATE_SCOPES.keys()), c_gates)

        d1 = cache_mod.compute_scope_digests(str(self.repo), self.sha1, "v20.20.2", "Python 3.11", "img:1")

        # Dirty working tree file without commit must NOT alter immutable commit digests.
        self.write_repo("packages/commercial/src/ws/bridge.ts", "MUTATED UNCOMMITTED\n")
        d1_dirty = cache_mod.compute_scope_digests(str(self.repo), self.sha1, "v20.20.2", "Python 3.11", "img:1")
        self.assertEqual(d1, d1_dirty)
        self.git("checkout", "--", ".")

        # Pure docs change: storage, gateway, backend keep identical digests; only full changes.
        self.write_repo("docs/notes.md", "doc v2\n")
        sha_docs = self.commit_all("docs")
        d_docs = cache_mod.compute_scope_digests(str(self.repo), sha_docs, "v20.20.2", "Python 3.11", "img:1")
        self.assertEqual(d1["box-longtask"], d_docs["box-longtask"])
        self.assertEqual(d1["upload-retention-http"], d_docs["upload-retention-http"])
        self.assertEqual(d1["system-approval-fencing"], d_docs["system-approval-fencing"])
        self.assertNotEqual(d1["architecture"], d_docs["architecture"])

        # Pure web-react change: all 19 storage/gateway/backend gates stay identical; 5 full gates change.
        self.write_repo("packages/web-react/src/App.tsx", "export const W = 2;\n")
        sha_web = self.commit_all("web")
        d_web = cache_mod.compute_scope_digests(str(self.repo), sha_web, "v20.20.2", "Python 3.11", "img:1")
        for gid, scope in cache_mod.GATE_SCOPES.items():
            if scope in ("storage", "gateway", "backend"):
                self.assertEqual(d_docs[gid], d_web[gid], gid)
            else:
                self.assertNotEqual(d_docs[gid], d_web[gid], gid)

        # commercial/src change: storage & gateway scopes stay identical; backend & full change.
        self.write_repo("packages/commercial/src/ws/bridge.ts", "export const C = 2;\n")
        sha_comm = self.commit_all("commercial-src")
        d_comm = cache_mod.compute_scope_digests(str(self.repo), sha_comm, "v20.20.2", "Python 3.11", "img:1")
        self.assertEqual(d_web["system-approval-fencing"], d_comm["system-approval-fencing"])
        self.assertEqual(d_web["upload-retention-http"], d_comm["upload-retention-http"])
        self.assertNotEqual(d_web["box-longtask"], d_comm["box-longtask"])
        self.assertNotEqual(d_web["ccb-mcp-availability"], d_comm["ccb-mcp-availability"])

        # commercial/agent-sandbox prompt change MUST invalidate gateway scope too!
        self.write_repo("packages/commercial/agent-sandbox/platform-runtime/prompts/p.md", "prompt v2\n")
        sha_prompt = self.commit_all("sandbox-prompt")
        d_prompt = cache_mod.compute_scope_digests(str(self.repo), sha_prompt, "v20.20.2", "Python 3.11", "img:1")
        self.assertEqual(d_comm["system-approval-fencing"], d_prompt["system-approval-fencing"])
        self.assertNotEqual(d_comm["upload-retention-http"], d_prompt["upload-retention-http"])

        # Brand-new unknown backend package packages/new-svc is automatically included in backend & gateway!
        self.write_repo("packages/new-svc/index.ts", "export const N = 1;\n")
        sha_newpkg = self.commit_all("new-pkg")
        d_newpkg = cache_mod.compute_scope_digests(str(self.repo), sha_newpkg, "v20.20.2", "Python 3.11", "img:1")
        self.assertNotEqual(d_prompt["box-longtask"], d_newpkg["box-longtask"])
        self.assertNotEqual(d_prompt["upload-retention-http"], d_newpkg["upload-retention-http"])

        # If gateway/package.json adds @openclaude/commercial, gateway scope auto-promotes so commercial/src invalidates it!
        self.write_repo(
            "packages/gateway/package.json",
            json.dumps({
                "name": "@openclaude/gateway",
                "dependencies": {"@openclaude/commercial": "*", "@openclaude/protocol": "*"},
            }) + "\n",
        )
        sha_dep = self.commit_all("gw-dep-commercial")
        d_dep1 = cache_mod.compute_scope_digests(str(self.repo), sha_dep, "v20.20.2", "Python 3.11", "img:1")
        self.write_repo("packages/commercial/src/ws/bridge.ts", "export const C = 3;\n")
        sha_dep2 = self.commit_all("commercial-after-gw-dep")
        d_dep2 = cache_mod.compute_scope_digests(str(self.repo), sha_dep2, "v20.20.2", "Python 3.11", "img:1")
        self.assertNotEqual(d_dep1["upload-retention-http"], d_dep2["upload-retention-http"])

    def test_architecture_replay_tamper_rejection_force_and_bounded_gc(self) -> None:
        plan_file = self.plan_dir / "plan.json"
        r = self.run_cli("plan", str(self.cache_dir), str(self.repo), self.sha1, str(plan_file), "v20", "py3", "", "0")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.strip(), "0/24")

        # Architecture record without report file fails closed.
        bad_arch = self.run_cli("record", str(plan_file), self.sha1, "architecture")
        self.assertNotEqual(bad_arch.returncode, 0)

        arch_src = self.plan_dir / "arch-in.json"
        arch_src.write_text(json.dumps({
            "byRule": {"layer": 12, "cycle": 3},
            "identities": 1400,
            "grown": ["a"],
            "stale": ["b", "c"],
            "unmapped": 5,
            "seconds": 41.8,
        }), encoding="utf-8")
        self.assertEqual(self.run_cli("record", str(plan_file), self.sha1, "architecture", str(arch_src)).returncode, 0)
        self.assertEqual(self.run_cli("record", str(plan_file), self.sha1, "box-longtask").returncode, 0)

        # Re-plan hits both receipts; force=1 ignores hits.
        plan2 = self.plan_dir / "plan2.json"
        r2 = self.run_cli("plan", str(self.cache_dir), str(self.repo), self.sha1, str(plan2), "v20", "py3", "", "0")
        self.assertEqual(r2.returncode, 0, r2.stderr)
        self.assertEqual(r2.stdout.strip(), "2/24")
        restored = self.plan_dir / "restored/architecture.json"
        self.assertEqual(self.run_cli("has", str(plan2), self.sha1, "architecture", str(restored)).returncode, 0)
        doc = json.loads(restored.read_text(encoding="utf-8"))
        self.assertEqual(doc["byRule"], {"layer": 12, "cycle": 3})
        self.assertEqual(doc["identities"], 1400)

        plan_forced = self.plan_dir / "plan-force.json"
        rf = self.run_cli("plan", str(self.cache_dir), str(self.repo), self.sha1, str(plan_forced), "v20", "py3", "", "1")
        self.assertEqual(rf.stdout.strip(), "0/24")
        self.assertNotEqual(self.run_cli("has", str(plan_forced), self.sha1, "box-longtask").returncode, 0)

        # Tampering permissions (world-writable receipt) causes point-of-use verification to reject it!
        rec_files = list(self.cache_dir.glob("box-longtask--*.json"))
        self.assertEqual(len(rec_files), 1)
        os.chmod(rec_files[0], 0o666)
        self.assertNotEqual(self.run_cli("has", str(plan2), self.sha1, "box-longtask").returncode, 0)
        os.chmod(rec_files[0], 0o644)
        self.assertEqual(self.run_cli("has", str(plan2), self.sha1, "box-longtask").returncode, 0)

        # Bounded GC caps receipt count at MAX_RECEIPTS (512).
        now_ns = time.time_ns()
        for idx in range(530):
            dummy = self.cache_dir / f"watch-gate--{idx:064x}.json"
            dummy.write_text('{"schema":"x"}\n', encoding="utf-8")
            os.chmod(dummy, 0o644)
            os.utime(dummy, ns=(now_ns - idx * 1_000_000, now_ns - idx * 1_000_000))
        cache_mod.gc_receipts(self.cache_dir)
        remaining = [p for p in self.cache_dir.iterdir() if p.is_file()]
        self.assertLessEqual(len(remaining), cache_mod.MAX_RECEIPTS)

    def test_production_shell_breakpoint_resume_and_cross_commit_frontend_fixup(self) -> None:
        master_src = MASTER_LIB_SH.read_text(encoding="utf-8")
        build_fn = extract_fn(master_src, "build_master_release")
        gates_body = build_fn[build_fn.index("  # P3:"):build_fn.index("  tsum_mark P.mcp-bundle")]
        helpers = "\n".join(
            extract_fn(master_src, name)
            for name in ("master_gate_load1", "master_gate_attempt_log", "master_gate_first_failure",
                         "master_seed_frontend_buildinfo", "master_note_architecture")
        )

        bin_dir = self.base / "bin"
        bin_dir.mkdir(mode=0o700)
        real_node = shutil.which("node")
        assert real_node
        # Stub runner for gate invocations; delegates `node -e` (used by master_note_architecture)
        # and `--version` to real node. Also provides a fast `ps` stub if slim container lacks procps.
        runner = f"""#!/bin/bash
set -eu
if [[ "${{1:-}}" == "--version" ]]; then exec {real_node!r} --version; fi
if [[ "${{1:-}}" == "-e" ]]; then exec {real_node!r} "$@"; fi
id="${{TMPDIR##*/}}"
case "$*" in
  *check-v5-box-success-recovery.ts*) id=C.box-success-recovery ;;
  *check-v5-box-continuation.ts*) id=C.box-continuation ;;
  *check-v5-box-incident-proofs.ts*) id=C.box-incident-proofs ;;
  *check-v5-box-longtask.ts*) id=C.box-longtask ;;
  *check-v5-master-incident-proofs.ts*) id=C.master-incident-proofs ;;
  *check-v5-codex-chatgpt-ws.ts*) id=C.codex-chatgpt-ws ;;
  *check-v5-ocv5-376-platform-tool-proofs.ts*) id=C.platform-tool-proofs ;;
  *check-v5-box-terminal-unproven-probe.ts*) id=C.terminal-unproven ;;
  *check-v5-upload-retention-proof.ts*) id=C.upload-retention ;;
  *check-v5-ccb-mcp-availability.ts*) id=C.ccb-mcp ;;
  *check-v5-codex-late-stop-proof.sh*) id=C.codex-late-stop ;;
esac
printf 'RUN %s\\n' "$id" >>"$EVENTS"
if [[ "$id" == "${{FAIL_AT:-never}}" ]]; then
  echo '[gate-failure] injected failure'
  exit 19
fi
case "$id" in
  D)
    mkdir -p packages/web-react/dist
    echo '<meta name="oc-build" content="0123456789abcdef">' >packages/web-react/dist/index.html
    printf '0.250\\n' >"$OC_V5_SELFHOST_TSC_TIMER_FILE"
    ;;
  C.architecture)
    printf '{{"byRule":{{"r":7}},"identities":99,"grown":["g1"],"stale":[],"unmapped":2,"seconds":3.4}}\\n' >"$TMPDIR/architecture.json"
    ;;
esac
"""
        for tool in ("npx", "node", "bash", "npm"):
            p = bin_dir / tool
            p.write_text(runner, encoding="utf-8")
            os.chmod(p, 0o755)
        if not shutil.which("ps"):
            ps_stub = bin_dir / "ps"
            ps_stub.write_text(
                "#!/usr/bin/env python3\n"
                "import os, sys\n"
                "if sys.argv[1:] == ['-eo', 'pgid=,stat=']:\n"
                "    for e in os.listdir('/proc'):\n"
                "        if e.isdigit():\n"
                "            try:\n"
                "                raw = open(f'/proc/{e}/stat', encoding='utf-8', errors='replace').read()\n"
                "                f = raw[raw.rfind(')') + 2:].split()\n"
                "                print(f'{f[2]} {f[0]}')\n"
                "            except OSError:\n"
                "                pass\n"
                "    sys.exit(0)\n"
                "sys.exit(1)\n",
                encoding="utf-8",
            )
            os.chmod(ps_stub, 0o755)

        def execute_train(sha: str, train_id: str, fail_at: str = "") -> tuple[int, list[str], dict[str, str]]:
            run_root = self.base / train_id
            for sub in ("tmp", "logs", "staging/scripts/lib", "staging/packages/web-react"):
                (run_root / sub).mkdir(parents=True, exist_ok=True)
            for gate_file in (
                "check-architecture.ts", "v5-selfhost-watch-gate.sh", "lib/gateTestDb.mjs",
                "check-v5-box-success-recovery.ts", "check-v5-box-continuation.ts",
                "check-v5-box-incident-proofs.ts", "check-v5-box-longtask.ts",
                "check-v5-upload-retention-proof.ts",
            ):
                (run_root / "staging/scripts" / gate_file).write_text("fixture\n", encoding="utf-8")
            load_file = run_root / "load"
            load_file.write_text("0.50 0 0 1/1 1\n", encoding="utf-8")
            events_file = run_root / "events"
            events_file.write_text("", encoding="utf-8")

            shell_script = f"""
set -Eeuo pipefail
source {str(BUILD_JOBS_SH)!r}
source {str(SUMMARY_SH)!r}
source {str(RECEIPTS_SH)!r}
REPO_ROOT={str(self.repo)!r}
SCRIPT_DIR={str(ROOT / "scripts")!r}
OC_V5_LOCAL_GATE_CACHE=1
OC_V5_LOCAL_GATE_CACHE_DIR={str(self.cache_dir)!r}
MASTER_GATE_TMPDIR={str(run_root / "tmp")!r}
MASTER_GATE_LOADAVG={str(load_file)!r}
MASTER_GATE_ATTEMPT_DIR={str(run_root / "logs")!r}
OC_V5_TRAIN_SUMMARY_DIR={str(run_root / "logs")!r}
LEASE_TRAIN_ID={train_id!r}
LEASE_TARGET_SHA={sha!r}
MASTER_BOX_GATE_LOAD_MAX=8
MASTER_GATE_IDLE_TIMEOUT_S=20
MASTER_GATE_LOAD_SCALE=1
MASTER_GATE_DB_URL='fixture-db'
WEB_DIST_REUSE_RECORD=.web-dist-reuse.json
FAIL_AT={fail_at!r}
export FAIL_AT
EVENTS={str(events_file)!r}
export EVENTS
mlog() {{ echo "$*" >&2; }}
{helpers}
master_web_dist_key() {{ :; }}
write_web_dist_reuse_record() {{ :; }}
await_runtime_release_bg() {{ printf 'EVENT runtime-awaited\\n' >>"$EVENTS"; }}
master_gate_wait_host_idle() {{ printf 'EVENT idle-%s\\n' "$1" >>"$EVENTS"; }}
master_gate_db_create() {{ printf 'EVENT db-create\\n' >>"$EVENTS"; }}
master_gate_db_drop() {{ printf 'EVENT db-drop\\n' >>"$EVENTS"; }}
master_gate_retryable() {{ shift; "$@"; }}
cleanup_master_gate_tmpdir() {{ printf 'EVENT tmp-cleanup\\n' >>"$EVENTS"; }}
cleanup_master_staging() {{ reap_master_build_jobs; printf 'EVENT staging-cleanup\\n' >>"$EVENTS"; }}
die() {{ echo "$*" >&2; exit 73; }}
staging={str(run_root / "staging")!r}
donor=''
full_sha={sha!r}
tsum_init
trap 'rc=$?; reap_master_build_jobs; tsum_finish "$rc"' EXIT
master_gate_receipt_prepare "$staging" "$full_sha"
run_gates() {{
{gates_body}
}}
run_gates
printf 'EVENT sealed\\n' >>"$EVENTS"
"""
            env = {
                "PATH": f"{bin_dir}:{os.environ['PATH']}",
                "HOME": str(self.base),
                "TMPDIR": str(run_root / "tmp"),
                "LC_ALL": "C.UTF-8",
            }
            proc = subprocess.run(["/bin/bash", "-c", shell_script], env=env, capture_output=True, text=True)
            ev_lines = [l for l in events_file.read_text(encoding="utf-8").splitlines() if l]
            summary = json.loads((run_root / f"logs/{train_id}.summary.json").read_text(encoding="utf-8"))
            return proc.returncode, ev_lines, summary["notes"], proc.stderr

        # Run 1: fails late at C.ccb-mcp! All 13 parallel C gates + 9 preceding serial gates must persist receipts.
        rc1, ev1, notes1, err1 = execute_train(self.sha1, "tr-run1", fail_at="C.ccb-mcp")
        self.assertEqual(rc1, 73, err1)
        ran1 = [l.split(" ", 1)[1] for l in ev1 if l.startswith("RUN ")]
        self.assertIn("C.ccb-mcp", ran1)
        self.assertNotIn("C.codex-late-stop", ran1)
        self.assertEqual(notes1["localGateCache.hits"], "0/24")

        # Run 2 (same SHA breakpoint resume!): ONLY D (frontend) + C.ccb-mcp + C.codex-late-stop run!
        # All 22 previously passed C gates skip, AND idle-box-gates / db-create are skipped too!
        rc2, ev2, notes2, err2 = execute_train(self.sha1, "tr-run2", fail_at="")
        self.assertEqual(rc2, 0, err2)
        ran2 = [l.split(" ", 1)[1] for l in ev2 if l.startswith("RUN ")]
        self.assertEqual(ran2, ["D", "C.ccb-mcp", "C.codex-late-stop"])
        self.assertNotIn("EVENT idle-box-gates", ev2)
        self.assertNotIn("EVENT db-create", ev2)
        self.assertEqual(notes2["localGateCache.hits"], "22/24")
        self.assertEqual(notes2["gateEvidence.box-longtask"], "local-input-receipt")
        self.assertEqual(notes2["gateEvidence.watch-gate"], "local-input-receipt")
        self.assertEqual(notes2["gateEvidence.ccb-mcp-availability"], "local")
        # Architecture metrics restored from receipt cleanly!
        self.assertEqual(notes2["arch.violations"], "7")
        self.assertEqual(notes2["arch.identities"], "99")
        self.assertEqual(notes2["arch.grown"], "1")
        self.assertEqual(notes2["arch.unmapped"], "2")

        # Run 3 (cross-commit pure web-react fixup, like OCV5-773 e0c1f1ee1!):
        # 19 storage/gateway/backend gates STILL hit receipts; ONLY D + 5 full-scope gates run!
        self.write_repo("packages/web-react/src/App.tsx", "export const W = 99;\n")
        sha_web_fix = self.commit_all("fix(v5): lazy split web-react bundle")
        rc3, ev3, notes3, err3 = execute_train(sha_web_fix, "tr-run3", fail_at="")
        self.assertEqual(rc3, 0, err3)
        ran3 = sorted(l.split(" ", 1)[1] for l in ev3 if l.startswith("RUN "))
        self.assertEqual(
            ran3,
            sorted([
                "D",
                "C.session-rootfix",
                "C.architecture",
                "C.master-incident-proofs",
                "C.platform-tool-proofs",
                "C.ccb-mcp",
            ]),
        )
        self.assertEqual(notes3["localGateCache.hits"], "19/24")
        # master-incident-proofs needed the test DB, so db-create DID run on Run 3!
        self.assertIn("EVENT db-create", ev3)

    def test_root_and_unprivileged_trust_boundaries(self) -> None:
        # Symlink cache directory is always rejected.
        real_dir = self.base / "real-cache"
        real_dir.mkdir(mode=0o700)
        sym_dir = self.base / "sym-cache"
        sym_dir.symlink_to(real_dir)
        plan_file = self.plan_dir / "sym-plan.json"
        r_sym = self.run_cli("plan", str(sym_dir), str(self.repo), self.sha1, str(plan_file), "v20", "py3", "", "0")
        self.assertNotEqual(r_sym.returncode, 0)

        # Group-writable cache directory is always rejected.
        gw_dir = self.base / "gw-cache"
        gw_dir.mkdir(mode=0o700)
        os.chmod(gw_dir, 0o770)
        r_gw = self.run_cli("plan", str(gw_dir), str(self.repo), self.sha1, str(plan_file), "v20", "py3", "", "0")
        self.assertNotEqual(r_gw.returncode, 0)

        if os.geteuid() == 0:
            # Under root, a cache directory beneath world-writable /tmp MUST be rejected!
            with tempfile.TemporaryDirectory(prefix="oc-untrusted-root-", dir="/tmp") as bad_tmp:
                bad_cache = Path(bad_tmp) / "gate-receipts"
                r_bad = self.run_cli("plan", str(bad_cache), str(self.repo), self.sha1, str(plan_file), "v20", "py3", "", "0")
                self.assertNotEqual(r_bad.returncode, 0)
        else:
            # Unprivileged callers cannot target production /var/lib/openclaude-v5-selfhost paths.
            r_prod = self.run_cli(
                "plan",
                "/var/lib/openclaude-v5-selfhost/gate-receipts",
                str(self.repo),
                self.sha1,
                str(plan_file),
                "v20",
                "py3",
                "",
                "0",
            )
            self.assertNotEqual(r_prod.returncode, 0)


if __name__ == "__main__":
    unittest.main()
