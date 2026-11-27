#!/usr/bin/env python3
"""Red/green unit + production-shell integration proofs for OCV5-774 / OCV5-775:
local input-digest gate receipt cache, narrowed frontend gate scopes, & per-gate checkpoint resume.
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
GOV_GATES_SH = ROOT / "scripts/lib/v5-selfhost-governance-gates.sh"
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

        d1 = cache_mod.compute_scope_digests(
            str(self.repo), self.sha1, "v20.20.2", "Python 3.11", "img:1", "/usr/bin/bun:1.2.0"
        )

        # R1-P1-2: Host Bun identity changes ONLY codex-late-stop-closure digest.
        d1_bun2 = cache_mod.compute_scope_digests(
            str(self.repo), self.sha1, "v20.20.2", "Python 3.11", "img:1", "/usr/bin/bun:1.2.1"
        )
        self.assertNotEqual(d1["codex-late-stop-closure"], d1_bun2["codex-late-stop-closure"])
        for gid in cache_mod.GATE_SCOPES:
            if gid != "codex-late-stop-closure":
                self.assertEqual(d1[gid], d1_bun2[gid], gid)

        # Dirty working tree file without commit must NOT alter immutable commit digests.
        self.write_repo("packages/commercial/src/ws/bridge.ts", "MUTATED UNCOMMITTED\n")
        d1_dirty = cache_mod.compute_scope_digests(
            str(self.repo), self.sha1, "v20.20.2", "Python 3.11", "img:1", "/usr/bin/bun:1.2.0"
        )
        self.assertEqual(d1, d1_dirty)
        self.git("checkout", "--", ".")

        # Pure docs change: storage, gateway, backend keep identical digests; only full changes.
        self.write_repo("docs/notes.md", "doc v2\n")
        sha_docs = self.commit_all("docs")
        d_docs = cache_mod.compute_scope_digests(
            str(self.repo), sha_docs, "v20.20.2", "Python 3.11", "img:1", "/usr/bin/bun:1.2.0"
        )
        self.assertEqual(d1["box-longtask"], d_docs["box-longtask"])
        self.assertEqual(d1["upload-retention-http"], d_docs["upload-retention-http"])
        self.assertEqual(d1["system-approval-fencing"], d_docs["system-approval-fencing"])
        self.assertNotEqual(d1["architecture"], d_docs["architecture"])

        # Pure web-react App.tsx change (OCV5-775 / OCV5-823): 21 non-web gates stay identical;
        # the 3 web-touching gates (session-unavailable-rootfix, platform-tool-proofs, architecture) change!
        self.write_repo("packages/web-react/src/App.tsx", "export const W = 2;\n")
        sha_web = self.commit_all("web")
        d_web = cache_mod.compute_scope_digests(
            str(self.repo), sha_web, "v20.20.2", "Python 3.11", "img:1", "/usr/bin/bun:1.2.0"
        )
        for gid, scope in cache_mod.GATE_SCOPES.items():
            if scope not in ("backend_web", "full"):
                self.assertEqual(d_docs[gid], d_web[gid], gid)
            else:
                self.assertNotEqual(d_docs[gid], d_web[gid], gid)

        # OCV5-775: editing CCB_WEB_EXTRA_PATHS invalidates ccb-mcp-availability + backend_web/full, while backend stays unchanged.
        self.write_repo("packages/web-react/src/components/tool/format.ts", "export const F = 1;\n")
        sha_ccb_web = self.commit_all("web-ccb-format")
        d_ccb_web = cache_mod.compute_scope_digests(
            str(self.repo), sha_ccb_web, "v20.20.2", "Python 3.11", "img:1", "/usr/bin/bun:1.2.0"
        )
        self.assertNotEqual(d_web["ccb-mcp-availability"], d_ccb_web["ccb-mcp-availability"])
        self.assertNotEqual(d_web["session-unavailable-rootfix"], d_ccb_web["session-unavailable-rootfix"])
        self.assertEqual(d_web["box-longtask"], d_ccb_web["box-longtask"])
        self.assertEqual(d_web["master-incident-proofs"], d_ccb_web["master-incident-proofs"])
        sha_web = sha_ccb_web
        d_web = d_ccb_web

        # commercial/src/ws/bridge.ts change: storage, gateway, policy, watch, ccb, and commercial-leaf gates
        # stay identical; full backend & backend_web & full gates change!
        self.write_repo("packages/commercial/src/ws/bridge.ts", "export const C = 2;\n")
        sha_comm = self.commit_all("commercial-src")
        d_comm = cache_mod.compute_scope_digests(
            str(self.repo), sha_comm, "v20.20.2", "Python 3.11", "img:1", "/usr/bin/bun:1.2.0"
        )
        self.assertEqual(d_web["system-approval-fencing"], d_comm["system-approval-fencing"])
        self.assertEqual(d_web["upload-retention-http"], d_comm["upload-retention-http"])
        self.assertEqual(d_web["ccb-mcp-availability"], d_comm["ccb-mcp-availability"])
        self.assertEqual(d_web["watch-gate"], d_comm["watch-gate"])
        self.assertEqual(d_web["host-log-policy"], d_comm["host-log-policy"])
        self.assertEqual(d_web["codex-chatgpt-ws"], d_comm["codex-chatgpt-ws"])
        self.assertEqual(d_web["terminal-unproven"], d_comm["terminal-unproven"])
        self.assertNotEqual(d_web["box-longtask"], d_comm["box-longtask"])
        self.assertNotEqual(d_web["master-incident-proofs"], d_comm["master-incident-proofs"])

        # commercial/agent-sandbox prompt change MUST invalidate gateway scope too!
        self.write_repo("packages/commercial/agent-sandbox/platform-runtime/prompts/p.md", "prompt v2\n")
        sha_prompt = self.commit_all("sandbox-prompt")
        d_prompt = cache_mod.compute_scope_digests(
            str(self.repo), sha_prompt, "v20.20.2", "Python 3.11", "img:1", "/usr/bin/bun:1.2.0"
        )
        self.assertEqual(d_comm["system-approval-fencing"], d_prompt["system-approval-fencing"])
        self.assertNotEqual(d_comm["upload-retention-http"], d_prompt["upload-retention-http"])

        # Brand-new unknown backend package packages/new-svc is automatically included in backend & gateway!
        self.write_repo("packages/new-svc/index.ts", "export const N = 1;\n")
        sha_newpkg = self.commit_all("new-pkg")
        d_newpkg = cache_mod.compute_scope_digests(
            str(self.repo), sha_newpkg, "v20.20.2", "Python 3.11", "img:1", "/usr/bin/bun:1.2.0"
        )
        self.assertNotEqual(d_prompt["box-longtask"], d_newpkg["box-longtask"])
        self.assertNotEqual(d_prompt["upload-retention-http"], d_newpkg["upload-retention-http"])

        # R1-Warn-3: If storage/package.json adds @openclaude/commercial, BOTH storage AND gateway
        # scopes transitively promote so commercial/src invalidates both!
        self.write_repo(
            "packages/storage/package.json",
            json.dumps({
                "name": "@openclaude/storage",
                "dependencies": {"@openclaude/commercial": "*", "@openclaude/protocol": "*"},
            }) + "\n",
        )
        sha_st_dep1 = self.commit_all("storage-dep-commercial")
        d_st1 = cache_mod.compute_scope_digests(
            str(self.repo), sha_st_dep1, "v20.20.2", "Python 3.11", "img:1", "/usr/bin/bun:1.2.0"
        )
        self.write_repo("packages/commercial/src/ws/bridge.ts", "export const C = 25;\n")
        sha_st_dep2 = self.commit_all("commercial-after-storage-dep")
        d_st2 = cache_mod.compute_scope_digests(
            str(self.repo), sha_st_dep2, "v20.20.2", "Python 3.11", "img:1", "/usr/bin/bun:1.2.0"
        )
        self.assertNotEqual(d_st1["system-approval-fencing"], d_st2["system-approval-fencing"])
        self.assertNotEqual(d_st1["upload-retention-http"], d_st2["upload-retention-http"])
        # Restore storage/package.json so we also verify direct gateway/package.json promotion independently.
        self.write_repo(
            "packages/storage/package.json",
            json.dumps({"name": "@openclaude/storage", "dependencies": {"@openclaude/protocol": "*"}}) + "\n",
        )

        # If gateway/package.json adds @openclaude/commercial, gateway scope auto-promotes so commercial/src invalidates it!
        self.write_repo(
            "packages/gateway/package.json",
            json.dumps({
                "name": "@openclaude/gateway",
                "dependencies": {"@openclaude/commercial": "*", "@openclaude/protocol": "*"},
            }) + "\n",
        )
        sha_dep = self.commit_all("gw-dep-commercial")
        d_dep1 = cache_mod.compute_scope_digests(
            str(self.repo), sha_dep, "v20.20.2", "Python 3.11", "img:1", "/usr/bin/bun:1.2.0"
        )
        self.write_repo("packages/commercial/src/ws/bridge.ts", "export const C = 3;\n")
        sha_dep2 = self.commit_all("commercial-after-gw-dep")
        d_dep2 = cache_mod.compute_scope_digests(
            str(self.repo), sha_dep2, "v20.20.2", "Python 3.11", "img:1", "/usr/bin/bun:1.2.0"
        )
        self.assertNotEqual(d_dep1["upload-retention-http"], d_dep2["upload-retention-http"])
        # Meanwhile storage stayed narrow when only gateway added commercial:
        self.assertEqual(d_dep1["system-approval-fencing"], d_dep2["system-approval-fencing"])

    def test_architecture_replay_tamper_rejection_force_bun_and_bounded_gc(self) -> None:
        plan_file = self.plan_dir / "plan.json"
        r = self.run_cli(
            "plan", str(self.cache_dir), str(self.repo), self.sha1, str(plan_file), "v20", "py3", "", "bun:1.2", "0"
        )
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.strip(), "0/24")

        # R1-P1-2: Empty bun_id disables caching ONLY for codex-late-stop-closure (cacheable=False, record is no-op).
        plan_no_bun = self.plan_dir / "plan-no-bun.json"
        r_nb = self.run_cli(
            "plan", str(self.cache_dir), str(self.repo), self.sha1, str(plan_no_bun), "v20", "py3", "", "", "0"
        )
        self.assertEqual(r_nb.returncode, 0, r_nb.stderr)
        nb_doc = json.loads(plan_no_bun.read_text(encoding="utf-8"))
        self.assertFalse(nb_doc["gates"]["codex-late-stop-closure"]["cacheable"])
        self.assertTrue(nb_doc["gates"]["upload-retention-http"]["cacheable"])
        self.assertEqual(self.run_cli("record", str(plan_no_bun), self.sha1, "codex-late-stop-closure").returncode, 0)
        self.assertEqual(list(self.cache_dir.glob("codex-late-stop-closure--*.json")), [])

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
        r2 = self.run_cli(
            "plan", str(self.cache_dir), str(self.repo), self.sha1, str(plan2), "v20", "py3", "", "bun:1.2", "0"
        )
        self.assertEqual(r2.returncode, 0, r2.stderr)
        self.assertEqual(r2.stdout.strip(), "2/24")
        restored = self.plan_dir / "restored/architecture.json"
        self.assertEqual(self.run_cli("has", str(plan2), self.sha1, "architecture", str(restored)).returncode, 0)
        doc = json.loads(restored.read_text(encoding="utf-8"))
        self.assertEqual(doc["byRule"], {"layer": 12, "cycle": 3})
        self.assertEqual(doc["identities"], 1400)

        plan_forced = self.plan_dir / "plan-force.json"
        rf = self.run_cli(
            "plan", str(self.cache_dir), str(self.repo), self.sha1, str(plan_forced), "v20", "py3", "", "bun:1.2", "1"
        )
        self.assertEqual(rf.stdout.strip(), "0/24")
        self.assertNotEqual(self.run_cli("has", str(plan_forced), self.sha1, "box-longtask").returncode, 0)

        # Tampering permissions (world-writable receipt) causes point-of-use verification to reject it!
        rec_files = list(self.cache_dir.glob("box-longtask--*.json"))
        self.assertEqual(len(rec_files), 1)
        os.chmod(rec_files[0], 0o666)
        self.assertNotEqual(self.run_cli("has", str(plan2), self.sha1, "box-longtask").returncode, 0)
        os.chmod(rec_files[0], 0o644)
        self.assertEqual(self.run_cli("has", str(plan2), self.sha1, "box-longtask").returncode, 0)

        # R1-P1-1 (GC protection): Even if an active plan receipt is the oldest file in a full cache,
        # recording another gate in the same plan MUST NOT evict any receipt referenced by that plan!
        os.utime(rec_files[0], ns=(1_000_000_000, 1_000_000_000))
        now_ns = time.time_ns()
        for idx in range(530):
            dummy = self.cache_dir / f"watch-gate--{idx:064x}.json"
            dummy.write_text('{"schema":"x"}\n', encoding="utf-8")
            os.chmod(dummy, 0o644)
            os.utime(dummy, ns=(now_ns - idx * 1_000_000, now_ns - idx * 1_000_000))
        self.assertEqual(self.run_cli("record", str(plan2), self.sha1, "box-continuation").returncode, 0)
        self.assertEqual(self.run_cli("has", str(plan2), self.sha1, "box-longtask").returncode, 0)
        # Even with protected plan receipts, total receipt count on disk stays bounded at <= MAX_RECEIPTS (512).
        remaining_protected = [p for p in self.cache_dir.iterdir() if p.is_file()]
        self.assertLessEqual(len(remaining_protected), cache_mod.MAX_RECEIPTS)

        # Unprotected bounded GC caps receipt count at MAX_RECEIPTS (512).
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
                         "master_seed_frontend_buildinfo", "master_save_frontend_buildinfo",
                         "master_note_architecture")
        )

        bin_dir = self.base / "bin"
        bin_dir.mkdir(mode=0o700)
        real_node = shutil.which("node")
        assert real_node
        bun_stub = bin_dir / "bun"
        bun_stub.write_text('#!/bin/bash\nif [[ "${1:-}" == "--version" ]]; then echo "1.2.0"; exit 0; fi\nexit 0\n', encoding="utf-8")
        os.chmod(bun_stub, 0o755)
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
case "$id" in
  C.box-success-recovery|C.box-incident-proofs|C.box-longtask|C.master-incident-proofs)
    if [[ "${{TEST_DATABASE_URL:-}}" != "created-gate-db" ]]; then
      echo "[gate-failure] missing TEST_DATABASE_URL (${{TEST_DATABASE_URL:-empty}})"
      exit 23
    fi
    ;;
esac
if [[ "$id" == "C.box-continuation" && "${{EVICT_INCIDENT_ON_CONT:-0}}" == "1" ]]; then
  rm -f -- "$CACHE_DIR_FOR_RUNNER"/box-incident-proofs--*.json
fi
printf 'RUN %s\\n' "$id" >>"$EVENTS"
if [[ "$id" == "${{FAIL_AT:-never}}" ]]; then
  echo '[gate-failure] injected failure'
  exit 19
fi
case "$id" in
  D)
    mkdir -p packages/web-react/dist
    echo '<meta name="oc-build" content="0123456789abcdef">' >packages/web-react/dist/index.html
    echo 'buildinfo-from-D' >packages/web-react/tsconfig.tsbuildinfo
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

        def execute_train(
            sha: str, train_id: str, fail_at: str = "", evict_incident_on_cont: bool = False
        ) -> tuple[int, list[str], dict[str, str], str]:
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
umask 022
source {str(BUILD_JOBS_SH)!r}
source {str(SUMMARY_SH)!r}
source {str(RECEIPTS_SH)!r}
source {str(GOV_GATES_SH)!r}
OC_V5_REFEREE_ROOT={str(run_root / "missing-referee")!r}
MASTER_LIVE_LINK={str(run_root / "missing-live")!r}
REPO_ROOT={str(self.repo)!r}
SCRIPT_DIR={str(ROOT / "scripts")!r}
OC_V5_LOCAL_GATE_CACHE=1
OC_V5_LOCAL_GATE_CACHE_DIR={str(self.cache_dir)!r}
OC_V5_TSC_CACHE_DIR={str(self.base / "tsc-cache")!r}
CACHE_DIR_FOR_RUNNER={str(self.cache_dir)!r}
export CACHE_DIR_FOR_RUNNER
EVICT_INCIDENT_ON_CONT={'1' if evict_incident_on_cont else '0'}
export EVICT_INCIDENT_ON_CONT
MASTER_GATE_TMPDIR={str(run_root / "tmp")!r}
MASTER_GATE_LOADAVG={str(load_file)!r}
MASTER_GATE_ATTEMPT_DIR={str(run_root / "logs")!r}
OC_V5_TRAIN_SUMMARY_DIR={str(run_root / "logs")!r}
LEASE_TRAIN_ID={train_id!r}
LEASE_TARGET_SHA={sha!r}
MASTER_BOX_GATE_LOAD_MAX=8
MASTER_GATE_IDLE_TIMEOUT_S=20
MASTER_GATE_LOAD_SCALE=1
MASTER_GATE_DB_URL=''
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
master_gate_db_create() {{ MASTER_GATE_DB_URL='created-gate-db'; printf 'EVENT db-create\\n' >>"$EVENTS"; }}
master_gate_db_drop() {{ MASTER_GATE_DB_URL=''; printf 'EVENT db-drop\\n' >>"$EVENTS"; }}
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

        # Run 3 (cross-commit pure web-react fixup, like OCV5-773 e0c1f1ee1! OCV5-775 + OCV5-823):
        # 21/24 gates STILL hit receipts; ONLY D + the 3 web-touching gates (all in C.parallel!) run!
        # Neither idle-box-gates nor db-create runs because platform-tool-proofs is now in C.parallel!
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
                "C.platform-tool-proofs",
            ]),
        )
        self.assertEqual(notes3["localGateCache.hits"], "21/24")
        self.assertNotIn("EVENT idle-box-gates", ev3)
        self.assertNotIn("EVENT db-create", ev3)
        self.assertEqual((self.base / "tsc-cache/web-react.tsbuildinfo").read_text(encoding="utf-8"), "buildinfo-from-D\n")

        # Run 4 (R1-P1-1 end-to-end proof): All 4 DB gates hit at plan time while box-continuation misses,
        # AND box-incident-proofs receipt vanishes on disk during box-continuation!
        # master_ensure_gate_db MUST lazily create the test DB right before box-incident-proofs runs.
        for p in self.cache_dir.glob("box-continuation--*.json"):
            p.unlink()
        rc4, ev4, notes4, err4 = execute_train(sha_web_fix, "tr-run4", evict_incident_on_cont=True)
        self.assertEqual(rc4, 0, err4)
        self.assertEqual(notes4["localGateCache.hits"], "23/24")
        self.assertLess(ev4.index("RUN C.box-continuation"), ev4.index("EVENT db-create"))
        self.assertLess(ev4.index("EVENT db-create"), ev4.index("RUN C.box-incident-proofs"))

        # Run 5 (R1-P1-2 end-to-end proof): Upgrading host Bun invalidates ONLY codex-late-stop-closure!
        bun_stub.write_text('#!/bin/bash\nif [[ "${1:-}" == "--version" ]]; then echo "1.2.1"; exit 0; fi\nexit 0\n', encoding="utf-8")
        os.chmod(bun_stub, 0o755)
        rc5, ev5, notes5, err5 = execute_train(sha_web_fix, "tr-run5")
        self.assertEqual(rc5, 0, err5)
        self.assertEqual(notes5["localGateCache.hits"], "23/24")
        ran5 = [l.split(" ", 1)[1] for l in ev5 if l.startswith("RUN ")]
        self.assertEqual(ran5, ["D", "C.codex-late-stop"])

    def test_root_and_unprivileged_trust_boundaries(self) -> None:
        # Symlink cache directory is always rejected.
        real_dir = self.base / "real-cache"
        real_dir.mkdir(mode=0o700)
        sym_dir = self.base / "sym-cache"
        sym_dir.symlink_to(real_dir)
        plan_file = self.plan_dir / "sym-plan.json"
        r_sym = self.run_cli(
            "plan", str(sym_dir), str(self.repo), self.sha1, str(plan_file), "v20", "py3", "", "bun:1", "0"
        )
        self.assertNotEqual(r_sym.returncode, 0)

        # Group-writable cache directory is always rejected.
        gw_dir = self.base / "gw-cache"
        gw_dir.mkdir(mode=0o700)
        os.chmod(gw_dir, 0o770)
        r_gw = self.run_cli(
            "plan", str(gw_dir), str(self.repo), self.sha1, str(plan_file), "v20", "py3", "", "bun:1", "0"
        )
        self.assertNotEqual(r_gw.returncode, 0)

        if os.geteuid() == 0:
            # Under root, a cache directory beneath world-writable /tmp MUST be rejected!
            with tempfile.TemporaryDirectory(prefix="oc-untrusted-root-", dir="/tmp") as bad_tmp:
                bad_cache = Path(bad_tmp) / "gate-receipts"
                r_bad = self.run_cli(
                    "plan", str(bad_cache), str(self.repo), self.sha1, str(plan_file), "v20", "py3", "", "bun:1", "0"
                )
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
                "bun:1",
                "0",
            )
            self.assertNotEqual(r_prod.returncode, 0)

    def test_r1_audit_esm_syntax_and_git_symlink_regressions(self) -> None:
        real_node = shutil.which("node")
        assert real_node

        # 1) R1-P1-1: Real Node ESM execution + actual plan -> record -> plan for quoted export,
        # quoted import, and executable template-literal dynamic import `${(await import(name)).H}`.
        syntax_cases = (
            ("quoted-export", 'export { H as "P" } from "./helper.mjs";\n', 'ns["P"]'),
            ("quoted-import", 'import { "H" as H } from "./helper.mjs";\nexport const P = H;\n', "ns.P"),
            (
                "template-dynamic-import",
                'const name = "./helper.mjs";\nexport const P = Number(`${(await import(name)).H}`);\n',
                "ns.P",
            ),
        )
        for idx, (label, persist_src, expr) in enumerate(syntax_cases):
            self.write_repo("packages/web-react/src/lib/helper.mjs", "export const H = 1;\n")
            self.write_repo("packages/web-react/src/lib/persist.mjs", persist_src)
            sha_a = self.commit_all(f"syntax-a-{label}")
            node_check = (
                f'const ns = await import({json.dumps(str(self.repo / "packages/web-react/src/lib/persist.mjs"))});'
                f"if ({expr} !== 1) process.exit(9);"
            )
            self.assertEqual(subprocess.run([real_node, "--input-type=module", "-e", node_check]).returncode, 0, label)

            plan_a = self.plan_dir / f"syntax-{idx}-a.json"
            self.assertEqual(
                self.run_cli("plan", str(self.cache_dir), str(self.repo), sha_a, str(plan_a), "v20", "py3", "", "bun:1", "0").returncode,
                0,
            )
            self.assertEqual(self.run_cli("record", str(plan_a), sha_a, "session-unavailable-rootfix").returncode, 0)
            plan_a_hit = self.plan_dir / f"syntax-{idx}-a-hit.json"
            self.assertEqual(
                self.run_cli("plan", str(self.cache_dir), str(self.repo), sha_a, str(plan_a_hit), "v20", "py3", "", "bun:1", "0").returncode,
                0,
            )
            self.assertEqual(self.run_cli("has", str(plan_a_hit), sha_a, "session-unavailable-rootfix").returncode, 0)

            self.write_repo("packages/web-react/src/lib/helper.mjs", "export const H = 2;\n")
            sha_b = self.commit_all(f"syntax-b-{label}")
            self.assertEqual(subprocess.run([real_node, "--input-type=module", "-e", node_check]).returncode, 9, label)

            plan_b = self.plan_dir / f"syntax-{idx}-b.json"
            self.assertEqual(
                self.run_cli("plan", str(self.cache_dir), str(self.repo), sha_b, str(plan_b), "v20", "py3", "", "bun:1", "0").returncode,
                0,
            )
            doc_b = json.loads(plan_b.read_text(encoding="utf-8"))
            self.assertFalse(doc_b["gates"]["session-unavailable-rootfix"]["hit"], label)
            self.assertNotEqual(self.run_cli("has", str(plan_b), sha_b, "session-unavailable-rootfix").returncode, 0, label)

        # 2) R1-P1-2: Git symlink target mutation + regular<->symlink mode transition + ancestor symlink + backend symlink!
        ccb_ok_src = (
            "export function unwrapExecuteExtraToolInput() {}\n"
            "export function parseExecuteExtraToolResult() {}\n"
            "export function parseSearchExtraToolsResult() {}\n"
        )
        self.write_repo("packages/web-react/src/lib/chat/actual.ts", ccb_ok_src)
        extra_link = self.repo / "packages/web-react/src/lib/chat/extraTool.ts"
        if extra_link.exists() or extra_link.is_symlink():
            extra_link.unlink()
        extra_link.symlink_to("./actual.ts")
        sha_sym_a = self.commit_all("ccb-symlink-a")

        def check_ccb_markers() -> bool:
            txt = (self.repo / "packages/web-react/src/lib/chat/extraTool.ts").read_text(encoding="utf-8")
            return all(
                fn in txt
                for fn in ("unwrapExecuteExtraToolInput", "parseExecuteExtraToolResult", "parseSearchExtraToolsResult")
            )

        self.assertTrue(check_ccb_markers())
        plan_sa = self.plan_dir / "sym-a.json"
        self.assertEqual(
            self.run_cli("plan", str(self.cache_dir), str(self.repo), sha_sym_a, str(plan_sa), "v20", "py3", "", "bun:1", "0").returncode,
            0,
        )
        self.assertEqual(self.run_cli("record", str(plan_sa), sha_sym_a, "ccb-mcp-availability").returncode, 0)
        plan_sa_hit = self.plan_dir / "sym-a-hit.json"
        self.assertEqual(
            self.run_cli("plan", str(self.cache_dir), str(self.repo), sha_sym_a, str(plan_sa_hit), "v20", "py3", "", "bun:1", "0").returncode,
            0,
        )
        self.assertEqual(self.run_cli("has", str(plan_sa_hit), sha_sym_a, "ccb-mcp-availability").returncode, 0)

        # Mutate ONLY actual.ts (symlink blob OID stays identical!); ccb-mcp-availability MUST miss!
        self.write_repo("packages/web-react/src/lib/chat/actual.ts", "export const broken = 1;\n")
        sha_sym_b = self.commit_all("ccb-symlink-b")
        self.assertFalse(check_ccb_markers())
        plan_sb = self.plan_dir / "sym-b.json"
        self.assertEqual(
            self.run_cli("plan", str(self.cache_dir), str(self.repo), sha_sym_b, str(plan_sb), "v20", "py3", "", "bun:1", "0").returncode,
            0,
        )
        doc_sb = json.loads(plan_sb.read_text(encoding="utf-8"))
        self.assertFalse(doc_sb["gates"]["ccb-mcp-availability"]["hit"])
        self.assertNotEqual(self.run_cli("has", str(plan_sb), sha_sym_b, "ccb-mcp-availability").returncode, 0)

        # Regular file <-> symlink mode transition with IDENTICAL blob bytes ("./actual.ts"):
        extra_link.unlink()
        extra_link.write_bytes(b"./actual.ts")
        sha_reg_mode = self.commit_all("ccb-regular-same-bytes")
        d_sym_b = cache_mod.compute_scope_digests(str(self.repo), sha_sym_b, "v20", "py3", "", "bun:1")
        d_reg_mode = cache_mod.compute_scope_digests(str(self.repo), sha_reg_mode, "v20", "py3", "", "bun:1")
        self.assertNotEqual(d_sym_b["ccb-mcp-availability"], d_reg_mode["ccb-mcp-availability"])

        # Ancestor directory symlink (`src/lib/chat -> ../other_chat`) promotes ccb-mcp-availability to full_items:
        shutil.rmtree(self.repo / "packages/web-react/src/lib/chat")
        self.write_repo("packages/web-react/src/lib/other_chat/extraTool.ts", ccb_ok_src)
        (self.repo / "packages/web-react/src/lib/chat").symlink_to("other_chat")
        sha_anc1 = self.commit_all("ccb-ancestor-symlink-1")
        self.write_repo("packages/web-react/src/lib/other_chat/extraTool.ts", "export const broken = 2;\n")
        sha_anc2 = self.commit_all("ccb-ancestor-symlink-2")
        d_anc1 = cache_mod.compute_scope_digests(str(self.repo), sha_anc1, "v20", "py3", "", "bun:1")
        d_anc2 = cache_mod.compute_scope_digests(str(self.repo), sha_anc2, "v20", "py3", "", "bun:1")
        self.assertNotEqual(d_anc1["ccb-mcp-availability"], d_anc2["ccb-mcp-availability"])

        # Backend symlink inside packages/commercial/agent-sandbox promotes gateway & storage scopes too:
        (self.repo / "packages/commercial/agent-sandbox/sym-bridge.ts").symlink_to("../src/ws/bridge.ts")
        sha_bsym1 = self.commit_all("backend-symlink-1")
        self.write_repo("packages/commercial/src/ws/bridge.ts", "export const C = 999;\n")
        sha_bsym2 = self.commit_all("backend-symlink-2")
        d_bsym1 = cache_mod.compute_scope_digests(str(self.repo), sha_bsym1, "v20", "py3", "", "bun:1")
        d_bsym2 = cache_mod.compute_scope_digests(str(self.repo), sha_bsym2, "v20", "py3", "", "bun:1")
        self.assertNotEqual(d_bsym1["upload-retention-http"], d_bsym2["upload-retention-http"])
        self.assertNotEqual(d_bsym1["system-approval-fencing"], d_bsym2["system-approval-fencing"])

    def test_ocv5_823_per_gate_file_closure_isolation_and_conservative_fallbacks(self) -> None:
        # Seed representative gate scripts + transitive helpers + commercial leaf modules + deploy configs.
        self.write_repo("scripts/v5-worktree-new.sh", "#!/usr/bin/env bash\necho v1\n")
        self.write_repo("scripts/v5-selfhost-watch.sh", "#!/usr/bin/env bash\necho watch v1\n")
        self.write_repo("scripts/v5-selfhost-watch-gate.sh", "WATCH_GATE_TESTS=(v5-selfhost-watch-selftest.sh)\n")
        self.write_repo("scripts/v5-selfhost-watch-selftest.sh", "source scripts/v5-selfhost-watch.sh\n")
        self.write_repo("scripts/check-v5-box-longtask.ts", 'import "./lib/gateLoadScale.js";\n')
        self.write_repo("scripts/check-v5-box-incident-proofs.ts", 'import "./lib/boxCustomHelper.js";\n')
        self.write_repo("scripts/lib/gateLoadScale.ts", "export const SCALE = 1;\n")
        self.write_repo("scripts/lib/boxCustomHelper.ts", "export const HELPER = 1;\n")
        self.write_repo("deploy/v5-selfhost/host-log-policy.json", '{"v":1}\n')
        self.write_repo("packages/commercial/src/http/proxy/boxRunLiveness.ts", "export const LIVE = 1;\n")
        self.write_repo("packages/commercial/src/http/codexUpstreamHeaders.ts", "export const HDR = 1;\n")
        self.write_repo("claude-code-best/src/index.ts", "export const CCB = 1;\n")
        self.write_repo(".github/workflows/ci.yml", "name: ci\n")
        sha0 = self.commit_all("seed-closures")
        d0 = cache_mod.compute_scope_digests(str(self.repo), sha0, "v20", "py3", "img:1", "bun:1")

        # 1) Editing a single UNRELATED script must NOT bust the 24 gates: 23/24 keep identical digests!
        self.write_repo("scripts/v5-worktree-new.sh", "#!/usr/bin/env bash\necho v2\n")
        sha_unrel = self.commit_all("edit-unrelated-script")
        d_unrel = cache_mod.compute_scope_digests(str(self.repo), sha_unrel, "v20", "py3", "img:1", "bun:1")
        changed_unrel = sorted(gid for gid in d0 if d0[gid] != d_unrel[gid])
        self.assertEqual(changed_unrel, ["architecture"])

        # Editing .github/workflows/ci.yml also keeps 23/24 gates unchanged!
        self.write_repo(".github/workflows/ci.yml", "name: ci-v2\n")
        sha_ci = self.commit_all("edit-ci")
        d_ci = cache_mod.compute_scope_digests(str(self.repo), sha_ci, "v20", "py3", "img:1", "bun:1")
        self.assertEqual(sorted(gid for gid in d_unrel if d_unrel[gid] != d_ci[gid]), ["architecture"])

        # 2) Editing a gate-specific script MUST miss that gate while leaving unrelated gates intact!
        self.write_repo("scripts/v5-selfhost-watch.sh", "#!/usr/bin/env bash\necho watch v2\n")
        sha_watch = self.commit_all("edit-watch")
        d_watch = cache_mod.compute_scope_digests(str(self.repo), sha_watch, "v20", "py3", "img:1", "bun:1")
        self.assertEqual(sorted(gid for gid in d_ci if d_ci[gid] != d_watch[gid]), ["architecture", "watch-gate"])

        self.write_repo("scripts/check-v5-box-longtask.ts", 'import "./lib/gateLoadScale.js";\n// v2\n')
        sha_lt = self.commit_all("edit-box-longtask")
        d_lt = cache_mod.compute_scope_digests(str(self.repo), sha_lt, "v20", "py3", "img:1", "bun:1")
        self.assertEqual(sorted(gid for gid in d_watch if d_watch[gid] != d_lt[gid]), ["architecture", "box-longtask"])

        # Transitive helper discovered automatically via static import closure:
        self.write_repo("scripts/lib/boxCustomHelper.ts", "export const HELPER = 2;\n")
        sha_helper = self.commit_all("edit-box-custom-helper")
        d_helper = cache_mod.compute_scope_digests(str(self.repo), sha_helper, "v20", "py3", "img:1", "bun:1")
        self.assertNotEqual(d_lt["box-incident-proofs"], d_helper["box-incident-proofs"])
        self.assertEqual(d_lt["box-continuation"], d_helper["box-continuation"])
        self.assertEqual(d_lt["upload-retention-http"], d_helper["upload-retention-http"])

        # 3) Deploy config file change misses ONLY dependent gates (host-log-policy, watch-gate, architecture)!
        self.write_repo("deploy/v5-selfhost/host-log-policy.json", '{"v":2}\n')
        sha_hlp = self.commit_all("edit-host-log-policy")
        d_hlp = cache_mod.compute_scope_digests(str(self.repo), sha_hlp, "v20", "py3", "img:1", "bun:1")
        self.assertEqual(
            sorted(gid for gid in d_helper if d_helper[gid] != d_hlp[gid]),
            ["architecture", "host-log-policy", "watch-gate"],
        )

        # 4) Narrowed commercial leaf module changes miss their owning gate + backend/web/full, not sibling leaves!
        self.write_repo("packages/commercial/src/http/proxy/boxRunLiveness.ts", "export const LIVE = 2;\n")
        sha_live = self.commit_all("edit-box-run-liveness")
        d_live = cache_mod.compute_scope_digests(str(self.repo), sha_live, "v20", "py3", "img:1", "bun:1")
        self.assertNotEqual(d_hlp["terminal-unproven"], d_live["terminal-unproven"])
        self.assertNotEqual(d_hlp["box-longtask"], d_live["box-longtask"])
        self.assertEqual(d_hlp["codex-chatgpt-ws"], d_live["codex-chatgpt-ws"])
        self.assertEqual(d_hlp["watch-gate"], d_live["watch-gate"])
        self.assertEqual(d_hlp["host-log-policy"], d_live["host-log-policy"])

        self.write_repo("packages/commercial/src/http/codexUpstreamHeaders.ts", "export const HDR = 2;\n")
        sha_hdr = self.commit_all("edit-codex-headers")
        d_hdr = cache_mod.compute_scope_digests(str(self.repo), sha_hdr, "v20", "py3", "img:1", "bun:1")
        self.assertNotEqual(d_live["codex-chatgpt-ws"], d_hdr["codex-chatgpt-ws"])
        self.assertEqual(d_live["terminal-unproven"], d_hdr["terminal-unproven"])
        self.assertEqual(d_live["host-log-policy"], d_hdr["host-log-policy"])

        # 5) CCB source change misses ONLY codex-late-stop-closure + architecture!
        self.write_repo("claude-code-best/src/index.ts", "export const CCB = 2;\n")
        sha_ccb = self.commit_all("edit-ccb")
        d_ccb = cache_mod.compute_scope_digests(str(self.repo), sha_ccb, "v20", "py3", "img:1", "bun:1")
        self.assertEqual(
            sorted(gid for gid in d_hdr if d_hdr[gid] != d_ccb[gid]),
            ["architecture", "codex-late-stop-closure"],
        )

        # 6) Conservative fallback: dynamic import in narrowed commercial leaf promotes it to backend!
        self.write_repo(
            "packages/commercial/src/http/proxy/boxRunLiveness.ts",
            "export async function load(p: string) { return import(p); }\n",
        )
        sha_dyn1 = self.commit_all("leaf-dynamic-import")
        d_dyn1 = cache_mod.compute_scope_digests(str(self.repo), sha_dyn1, "v20", "py3", "img:1", "bun:1")
        self.write_repo("packages/commercial/src/ws/bridge.ts", "export const C = 1234;\n")
        sha_dyn2 = self.commit_all("bridge-after-leaf-dynamic")
        d_dyn2 = cache_mod.compute_scope_digests(str(self.repo), sha_dyn2, "v20", "py3", "img:1", "bun:1")
        self.assertNotEqual(d_dyn1["terminal-unproven"], d_dyn2["terminal-unproven"])

        # 7) Conservative fallback: unknown brand-new top-level directory invalidates ALL 24 gates!
        self.write_repo("mystery-top/config.json", '{"x":1}\n')
        sha_unk = self.commit_all("add-unknown-top")
        d_unk = cache_mod.compute_scope_digests(str(self.repo), sha_unk, "v20", "py3", "img:1", "bun:1")
        for gid in d_dyn2:
            self.assertNotEqual(d_dyn2[gid], d_unk[gid], gid)

        # 8) Smoke check on the real repository HEAD: produces 24 valid 64-hex digests cleanly.
        real_head = subprocess.run(
            ["git", "-C", str(ROOT), "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
        real_digests = cache_mod.compute_scope_digests(str(ROOT), real_head, "v20", "py3", "img:1", "bun:1")
        self.assertEqual(len(real_digests), 24)
        for gid, digest in real_digests.items():
            self.assertRegex(digest, r"^[0-9a-f]{64}$", gid)


if __name__ == "__main__":
    unittest.main()
