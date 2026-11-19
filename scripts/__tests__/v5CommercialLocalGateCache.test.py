#!/usr/bin/env python3
"""Unit & orchestration tests for commercial deploy-v5 gate cache & build_release lanes.

Proves cache soundness (release-input-cache-soundness-audit) and T2 audit closures:
- Same inputs -> plan/record/plan hits;
- Web-react source change -> backend/gateway/storage hit while full gates miss;
- Web-react package.json manifest or npm_ver change -> ALL gates (including 7 box gates) miss;
- CCB static web-react extra file change -> backend_ccb misses while plain backend hits;
- Symlink outside docs/web-react -> fail-closed promotion of narrowed scopes to full;
- Remote node version change -> remote staging gates miss while controller-only gates hit;
- Exact Bun identity parity for master (OC_BUN_BIN/BUN_BIN/PATH first-existing) vs codex (PATH/HOME);
- Runtime image ID change -> all gates miss;
- Tampered receipt file on disk -> fail-closed miss at `has` point-of-use;
- force=1 -> misses even with valid receipts;
- Unprivileged caller / untrusted ancestor rejected;
- Pinned workspace + runtime dep pre-check (@openclaude/* symlinks, tsx loader, better-sqlite3);
- Remote frontend tsbuildinfo seed/save rejects 0775 staging dirs and succeeds after chmod go-w;
- Real deploy-v5.sh build_release() executes cleanly under `set -Eeuo pipefail` across
  cold run, all-hit run, single-gate failure, and lane cancel (workers die before scratch rm).
"""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

REPO_ROOT = Path(__file__).resolve().parents[2]
HELPER = REPO_ROOT / "scripts/lib/v5-commercial-local-gate-cache.py"
SHELL_LIB = REPO_ROOT / "scripts/lib/v5-commercial-gate-cache.sh"
DEPLOY_SH = REPO_ROOT / "scripts/deploy-v5.sh"


def run_git(repo: Path, *args: str) -> str:
    env = {
        **os.environ,
        "GIT_AUTHOR_NAME": "Test",
        "GIT_AUTHOR_EMAIL": "test@example.com",
        "GIT_COMMITTER_NAME": "Test",
        "GIT_COMMITTER_EMAIL": "test@example.com",
    }
    proc = subprocess.run(
        ["git", "-C", str(repo), *args],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=True,
    )
    return proc.stdout.strip()


def init_fixture_repo(repo: Path) -> str:
    repo.mkdir(parents=True, exist_ok=True)
    run_git(repo, "init", "-b", "main")
    (repo / "package.json").write_text(
        json.dumps({
            "name": "openclaude",
            "workspaces": [
                "packages/protocol",
                "packages/storage",
                "packages/gateway",
                "packages/commercial",
                "packages/web-react",
                "packages/cli",
            ],
        }),
        encoding="utf-8",
    )
    (repo / "package-lock.json").write_text('{"name":"openclaude","lockfileVersion":3}\n', encoding="utf-8")
    for pkg, deps in [
        ("protocol", {}),
        ("storage", {"@openclaude/protocol": "*"}),
        ("gateway", {"@openclaude/protocol": "*", "@openclaude/storage": "*"}),
        ("commercial", {"@openclaude/protocol": "*", "@openclaude/storage": "*", "@openclaude/gateway": "*"}),
        ("web-react", {"@openclaude/protocol": "*"}),
        ("cli", {"@openclaude/gateway": "*"}),
    ]:
        pdir = repo / "packages" / pkg
        pdir.mkdir(parents=True, exist_ok=True)
        (pdir / "package.json").write_text(
            json.dumps({"name": f"@openclaude/{pkg}", "version": "1.0.0", "dependencies": deps}),
            encoding="utf-8",
        )
        (pdir / "index.ts").write_text(f"export const pkg = '{pkg}';\n", encoding="utf-8")
    (repo / "packages/commercial/agent-sandbox").mkdir(parents=True, exist_ok=True)
    (repo / "packages/commercial/agent-sandbox/prompt.md").write_text("v1\n", encoding="utf-8")
    extra1 = repo / "packages/web-react/src/lib/chat/extraTool.ts"
    extra1.parent.mkdir(parents=True, exist_ok=True)
    extra1.write_text("export const extra = 1;\n", encoding="utf-8")
    extra2 = repo / "packages/web-react/src/components/tool/format.ts"
    extra2.parent.mkdir(parents=True, exist_ok=True)
    extra2.write_text("export const fmt = 1;\n", encoding="utf-8")
    (repo / "packages/web-react/src/App.tsx").write_text("export const App = () => 'v1';\n", encoding="utf-8")
    (repo / "docs").mkdir(exist_ok=True)
    (repo / "docs/README.md").write_text("doc v1\n", encoding="utf-8")
    run_git(repo, "add", "-A")
    run_git(repo, "commit", "-m", "init")
    return run_git(repo, "rev-parse", "HEAD")


def link_fixture_workspaces(root: Path) -> None:
    scope = root / "node_modules" / "@openclaude"
    scope.mkdir(parents=True, exist_ok=True)
    for pkg in ("protocol", "storage", "gateway", "commercial", "web-react", "cli"):
        link = scope / pkg
        if link.exists() or link.is_symlink():
            link.unlink()
        os.symlink(f"../../packages/{pkg}", link)
    tsx_dist = root / "node_modules" / "tsx" / "dist"
    tsx_dist.mkdir(parents=True, exist_ok=True)
    (tsx_dist / "loader.mjs").write_text("export {};\n", encoding="utf-8")
    bsqlite = root / "node_modules" / "better-sqlite3"
    bsqlite.mkdir(parents=True, exist_ok=True)
    (bsqlite / "package.json").write_text('{"name":"better-sqlite3","main":"index.js"}\n', encoding="utf-8")
    (bsqlite / "index.js").write_text("module.exports = {};\n", encoding="utf-8")


def run_helper(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    proc = subprocess.run(
        [sys.executable, str(HELPER), *args],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )
    if check and proc.returncode != 0:
        raise AssertionError(f"helper failed rc={proc.returncode}: {proc.stderr}")
    return proc


class CommercialGateCacheTest(unittest.TestCase):
    def setUp(self) -> None:
        parent_dir = "/root" if os.geteuid() == 0 and Path("/root").is_dir() else None
        self.tmp = Path(tempfile.mkdtemp(prefix="oc-comm-gate-cache-", dir=parent_dir)).resolve()
        os.chmod(self.tmp, 0o700)
        self.repo = self.tmp / "repo"
        self.cache = self.tmp / "cache"
        self.plan = self.tmp / "plan.json"
        self.sha1 = init_fixture_repo(self.repo)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def plan_for(
        self,
        sha: str,
        node_ver: str = "v20.20.2",
        remote_node_ver: str = "v20.20.2",
        npm_ver: str = "10.8.2",
        py_ver: str = "Python 3.12.3",
        img: str = "img:1",
        img_id: str = "sha256:aaa",
        master_bun_id: str = "/usr/bin/bun:1.3.14",
        codex_bun_id: str = "/usr/bin/bun:1.3.14",
        force: str = "0",
    ) -> dict:
        run_helper(
            "plan", str(self.cache), str(self.repo), sha, str(self.plan),
            node_ver, remote_node_ver, npm_ver, py_ver, img, img_id,
            master_bun_id, codex_bun_id, force,
        )
        return json.loads(self.plan.read_text(encoding="utf-8"))

    def record_all(self, sha: str, plan_doc: dict) -> None:
        for gid in plan_doc["gates"]:
            run_helper("record", str(self.plan), sha, gid)

    def test_web_only_change_preserves_backend_and_invalidates_full(self) -> None:
        p1 = self.plan_for(self.sha1)
        self.assertEqual(p1["hits"], 0)
        self.record_all(self.sha1, p1)

        p1_again = self.plan_for(self.sha1)
        self.assertEqual(p1_again["hits"], p1_again["total"])
        res = run_helper("has", str(self.plan), self.sha1, "master-incident-proofs")
        self.assertIn(self.sha1[:12], res.stdout)

        (self.repo / "packages/web-react/src/App.tsx").write_text("export const App = () => 'v2';\n", encoding="utf-8")
        run_git(self.repo, "add", "-A")
        run_git(self.repo, "commit", "-m", "web ui tweak")
        sha2 = run_git(self.repo, "rev-parse", "HEAD")

        p2 = self.plan_for(sha2)
        self.assertTrue(p2["gates"]["master-incident-proofs"]["hit"])
        self.assertTrue(p2["gates"]["box-incident-proofs"]["hit"])
        self.assertTrue(p2["gates"]["system-approval-fencing"]["hit"])
        self.assertTrue(p2["gates"]["ccb-mcp-availability"]["hit"])
        self.assertFalse(p2["gates"]["taskboard-commercial-gate"]["hit"])
        self.assertFalse(p2["gates"]["advisor-1m-dup-picker"]["hit"])
        self.assertFalse(p2["gates"]["session-unavailable-rootfix"]["hit"])
        self.assertFalse(p2["gates"]["ocv5-376-platform-tool-proofs"]["hit"])

        (self.repo / "packages/web-react/src/lib/chat/extraTool.ts").write_text("export const extra = 2;\n", encoding="utf-8")
        run_git(self.repo, "add", "-A")
        run_git(self.repo, "commit", "-m", "ccb extra tweak")
        sha3 = run_git(self.repo, "rev-parse", "HEAD")
        p3 = self.plan_for(sha3)
        self.assertFalse(p3["gates"]["ccb-mcp-availability"]["hit"])
        self.assertTrue(p3["gates"]["master-incident-proofs"]["hit"])

    def test_web_react_manifest_and_npm_ver_invalidate_all_gates(self) -> None:
        p1 = self.plan_for(self.sha1)
        self.record_all(self.sha1, p1)

        mf = self.repo / "packages/web-react/package.json"
        doc = json.loads(mf.read_text(encoding="utf-8"))
        doc["version"] = "1.0.1"
        mf.write_text(json.dumps(doc), encoding="utf-8")
        run_git(self.repo, "add", "-A")
        run_git(self.repo, "commit", "-m", "bump web-react package.json")
        sha2 = run_git(self.repo, "rev-parse", "HEAD")

        p2 = self.plan_for(sha2)
        self.assertEqual(p2["hits"], 0, "workspace manifest edit must invalidate every gate")
        for gid in (
            "box-success-recovery",
            "box-continuation",
            "codex-late-stop-closure",
            "box-incident-proofs",
            "box-terminal-unproven",
            "grok-cli-compatibility",
            "box-longtask",
            "master-incident-proofs",
            "system-approval-fencing",
            "upload-retention-http",
        ):
            self.assertFalse(p2["gates"][gid]["hit"], f"{gid} must miss when packages/web-react/package.json changes")

        self.record_all(sha2, p2)
        p_npm = self.plan_for(sha2, npm_ver="10.9.0")
        self.assertEqual(p_npm["hits"], 0, "npm version change must invalidate every gate")

    def test_bun_selector_parity_master_vs_codex(self) -> None:
        # 1) Distinct keys: changing master_bun_id misses only master; changing codex_bun_id misses only codex.
        p1 = self.plan_for(self.sha1, master_bun_id="/opt/bun:1.3.14", codex_bun_id="/usr/bin/bun:1.3.14")
        self.record_all(self.sha1, p1)

        p_master_chg = self.plan_for(self.sha1, master_bun_id="", codex_bun_id="/usr/bin/bun:1.3.14")
        self.assertFalse(p_master_chg["gates"]["master-incident-proofs"]["hit"])
        self.assertTrue(p_master_chg["gates"]["codex-late-stop-closure"]["hit"])

        p_codex_chg = self.plan_for(self.sha1, master_bun_id="/opt/bun:1.3.14", codex_bun_id="/usr/bin/bun:1.3.15")
        self.assertTrue(p_codex_chg["gates"]["master-incident-proofs"]["hit"])
        self.assertFalse(p_codex_chg["gates"]["codex-late-stop-closure"]["hit"])

        # 2) Shell selector parity against both auditor B4 counterexamples:
        path_dir = self.tmp / "bun-path"
        path_dir.mkdir()
        path_bun = path_dir / "bun"
        path_bun.write_text("#!/usr/bin/env bash\necho 1.3.14\n", encoding="utf-8")
        os.chmod(path_bun, 0o755)

        override_bun = self.tmp / "override-bun"
        override_bun.write_text("#!/usr/bin/env bash\necho 1.3.14\n", encoding="utf-8")
        # Counterexample 1: OC_BUN_BIN exists but is NOT executable -> master selector MUST fail
        # (never fall through to PATH bun), while codex selector still uses PATH bun.
        os.chmod(override_bun, 0o644)
        res1 = subprocess.run(
            [
                "bash", "-c",
                f'source "{SHELL_LIB}"; m="$(commercial_resolve_master_bun_id || true)"; c="$(commercial_resolve_codex_bun_id || true)"; printf "M=%s\\nC=%s\\n" "$m" "$c"',
            ],
            env={**os.environ, "PATH": f"{path_dir}:/usr/bin:/bin", "OC_BUN_BIN": str(override_bun)},
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=True,
        )
        self.assertIn("M=\n", res1.stdout)
        self.assertIn(f"C={path_bun.resolve()}:1.3.14\n", res1.stdout)

        # Counterexample 2: OC_BUN_BIN is executable 1.3.14, PATH bun bumps to 1.3.15 ->
        # master selector stays pinned to OC_BUN_BIN (1.3.14), codex selector reflects PATH 1.3.15.
        os.chmod(override_bun, 0o755)
        path_bun.write_text("#!/usr/bin/env bash\necho 1.3.15\n", encoding="utf-8")
        res2 = subprocess.run(
            [
                "bash", "-c",
                f'source "{SHELL_LIB}"; m="$(commercial_resolve_master_bun_id || true)"; c="$(commercial_resolve_codex_bun_id || true)"; printf "M=%s\\nC=%s\\n" "$m" "$c"',
            ],
            env={**os.environ, "PATH": f"{path_dir}:/usr/bin:/bin", "OC_BUN_BIN": str(override_bun)},
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=True,
        )
        self.assertIn(f"M={override_bun.resolve()}:1.3.14\n", res2.stdout)
        self.assertIn(f"C={path_bun.resolve()}:1.3.15\n", res2.stdout)

    def test_symlink_outside_web_promotes_narrow_scopes_to_full(self) -> None:
        p1 = self.plan_for(self.sha1)
        self.record_all(self.sha1, p1)

        os.symlink("../web-react/src/App.tsx", self.repo / "packages/storage/escape.ts")
        run_git(self.repo, "add", "-A")
        run_git(self.repo, "commit", "-m", "add symlink")
        sha2 = run_git(self.repo, "rev-parse", "HEAD")

        p2 = self.plan_for(sha2)
        self.assertEqual(p2["hits"], 0)
        self.record_all(sha2, p2)

        (self.repo / "packages/web-react/src/App.tsx").write_text("export const App = () => 'v3';\n", encoding="utf-8")
        run_git(self.repo, "add", "-A")
        run_git(self.repo, "commit", "-m", "mutate symlink target")
        sha3 = run_git(self.repo, "rev-parse", "HEAD")
        p3 = self.plan_for(sha3)
        self.assertFalse(p3["gates"]["system-approval-fencing"]["hit"])
        self.assertFalse(p3["gates"]["master-incident-proofs"]["hit"])

    def test_toolchain_and_tamper_and_force_fail_closed(self) -> None:
        p1 = self.plan_for(self.sha1)
        self.record_all(self.sha1, p1)

        p_remote = self.plan_for(self.sha1, remote_node_ver="v20.21.0")
        self.assertFalse(p_remote["gates"]["lossless-anchor-contract"]["hit"])
        self.assertTrue(p_remote["gates"]["master-incident-proofs"]["hit"])

        p_img = self.plan_for(self.sha1, img_id="sha256:bbb")
        self.assertEqual(p_img["hits"], 0)

        p_force = self.plan_for(self.sha1, force="1")
        self.assertEqual(p_force["hits"], 0)

        p_ok = self.plan_for(self.sha1)
        digest = p_ok["gates"]["master-incident-proofs"]["inputDigest"]
        receipt_file = self.cache / f"master-incident-proofs--{digest}.json"
        receipt_file.write_text('{"schema":"bad"}\n', encoding="utf-8")
        tampered = run_helper("has", str(self.plan), self.sha1, "master-incident-proofs", check=False)
        self.assertNotEqual(tampered.returncode, 0)

    def test_unprivileged_rejects_prod_root(self) -> None:
        if os.geteuid() == 0:
            res = run_helper(
                "plan", "/tmp/oc-comm-gate-cache-untrusted-dir", str(self.repo),
                self.sha1, str(self.plan), "v20.20.2", "v20.20.2", "10.8.2", "Python 3.12.3",
                "img:1", "sha256:aaa", "/usr/bin/bun:1.3.14", "/usr/bin/bun:1.3.14", "0",
                check=False,
            )
            self.assertNotEqual(res.returncode, 0)
            self.assertIn("group/other writable rejected", res.stderr)
            return
        res = run_helper(
            "plan", "/var/lib/openclaude-v5-commercial/gate-receipts", str(self.repo),
            self.sha1, str(self.plan), "v20.20.2", "v20.20.2", "10.8.2", "Python 3.12.3",
            "img:1", "sha256:aaa", "/usr/bin/bun:1.3.14", "/usr/bin/bun:1.3.14", "0",
            check=False,
        )
        self.assertNotEqual(res.returncode, 0)

    def test_pinned_workspaces_and_runtime_deps_check(self) -> None:
        link_fixture_workspaces(self.repo)
        ok = subprocess.run(
            ["bash", "-Eeuo", "pipefail", "-c", f'source "{SHELL_LIB}"; commercial_verify_pinned_workspaces_local "{self.repo}"'],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=False,
        )
        self.assertEqual(ok.returncode, 0, ok.stderr)

        # Counterexample B3-a: remove tsx loader while keeping workspace links intact -> MUST fail.
        loader = self.repo / "node_modules/tsx/dist/loader.mjs"
        loader.unlink()
        missing_tsx = subprocess.run(
            ["bash", "-Eeuo", "pipefail", "-c", f'source "{SHELL_LIB}"; commercial_verify_pinned_workspaces_local "{self.repo}"'],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=False,
        )
        self.assertNotEqual(missing_tsx.returncode, 0)
        self.assertIn("tsx loader missing", missing_tsx.stderr)
        loader.write_text("export {};\n", encoding="utf-8")

        # Counterexample B3-b: remove better-sqlite3 -> MUST fail.
        bsqlite = self.repo / "node_modules/better-sqlite3"
        shutil.rmtree(bsqlite)
        missing_sqlite = subprocess.run(
            ["bash", "-Eeuo", "pipefail", "-c", f'source "{SHELL_LIB}"; commercial_verify_pinned_workspaces_local "{self.repo}"'],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=False,
        )
        self.assertNotEqual(missing_sqlite.returncode, 0)
        self.assertIn("better-sqlite3 unreadable", missing_sqlite.stderr)
        link_fixture_workspaces(self.repo)

        # Counterexample B3-c: redirect @openclaude/gateway outside pinned tree -> MUST fail.
        outside = self.tmp / "outside-gateway"
        outside.mkdir()
        gw_link = self.repo / "node_modules/@openclaude/gateway"
        gw_link.unlink()
        os.symlink(str(outside), gw_link)
        bad = subprocess.run(
            ["bash", "-Eeuo", "pipefail", "-c", f'source "{SHELL_LIB}"; commercial_verify_pinned_workspaces_local "{self.repo}"'],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=False,
        )
        self.assertNotEqual(bad.returncode, 0)
        self.assertIn("escaped pinned tree", bad.stderr)

    def test_remote_frontend_buildinfo_rejects_group_writable_and_roundtrips_after_chmod(self) -> None:
        releases = self.tmp / "releases"
        staging1 = releases / ".staging-1"
        web1 = staging1 / "packages" / "web-react"
        web1.mkdir(parents=True)
        cache_dir = releases / ".tsc-cache"
        payload = '{"program":{"fileNames":["src/App.tsx"]},"version":"5.7.0"}\n'
        (web1 / "tsconfig.tsbuildinfo").write_text(payload, encoding="utf-8")
        os.chmod(web1 / "tsconfig.tsbuildinfo", 0o644)

        os.chmod(releases, 0o755)
        os.chmod(staging1, 0o775)
        os.chmod(staging1 / "packages", 0o775)
        os.chmod(web1, 0o775)

        script = f"""
set -Eeuo pipefail
source "{SHELL_LIB}"
KL_HOST=local-stub
RELEASES_ROOT="{releases}"
OC_V5_TSC_CACHE_DIR="{cache_dir}"
DRY=0
ssh() {{ shift; "$@"; }}
commercial_save_remote_frontend_buildinfo "{staging1}"
"""
        res = subprocess.run(["bash", "-c", script], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=False)
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertFalse((cache_dir / "web-react.tsbuildinfo").exists(), "0775 staging dir must be rejected")

        os.chmod(staging1, 0o755)
        os.chmod(staging1 / "packages", 0o755)
        os.chmod(web1, 0o755)
        staging2 = releases / ".staging-2"
        web2 = staging2 / "packages" / "web-react"
        web2.mkdir(parents=True)
        os.chmod(staging2, 0o755)
        os.chmod(staging2 / "packages", 0o755)
        os.chmod(web2, 0o755)

        script2 = f"""
set -Eeuo pipefail
source "{SHELL_LIB}"
KL_HOST=local-stub
RELEASES_ROOT="{releases}"
OC_V5_TSC_CACHE_DIR="{cache_dir}"
DRY=0
ssh() {{ shift; "$@"; }}
commercial_save_remote_frontend_buildinfo "{staging1}"
commercial_seed_remote_frontend_buildinfo "{staging2}" ""
"""
        res2 = subprocess.run(["bash", "-c", script2], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=False)
        self.assertEqual(res2.returncode, 0, res2.stderr)
        self.assertTrue((cache_dir / "web-react.tsbuildinfo").is_file())
        seeded = web2 / "tsconfig.tsbuildinfo"
        self.assertTrue(seeded.is_file(), f"expected seeded buildinfo; stderr={res2.stderr}")
        self.assertEqual(seeded.read_text(encoding="utf-8"), payload)
        self.assertEqual(int(seeded.stat().st_mtime), 0, "seeded buildinfo mtime must be zeroed")

    def test_commercial_cleanup_kills_nested_lane_workers_before_rm_scratch(self) -> None:
        # B5 counterexample 2: multi-layer subshell lane spawning a delayed-write worker.
        # commercial_cleanup_build_locals MUST reap the leaf worker BEFORE removing scratch,
        # and the leaf worker must NEVER write its completion marker afterwards.
        src = DEPLOY_SH.read_text(encoding="utf-8")
        m_cl = re.search(r"^commercial_cleanup_build_locals\(\) \{.*?^\}", src, re.M | re.S)
        self.assertIsNotNone(m_cl)

        ready = self.tmp / "leaf-ready.txt"
        marker = self.tmp / "leaf-survived.txt"
        script = f"""
set -Eeuo pipefail
source "{SHELL_LIB}"
BUILD_RELEASE_ACTIVE_TMPDIR="$(mktemp -d /tmp/ocv5-build-gates.XXXXXX)"
BUILD_RELEASE_ACTIVE_BOX_CAND=""
BUILD_RELEASE_ACTIVE_PIDS=()
{m_cl.group(0)}

(
  (
    bash -c 'printf "%s\\n" "$$" > "{ready}"; sleep 0.6; printf "survived\\n" > "{marker}"'
  ) &
  wait
) &
BUILD_RELEASE_ACTIVE_PIDS+=("$!")

for _ in $(seq 1 100); do
  [[ -f "{ready}" ]] && break
  sleep 0.05
done
[[ -f "{ready}" ]] || {{ echo "leaf never started" >&2; exit 1; }}

commercial_cleanup_build_locals
"""
        res = subprocess.run(["bash", "-c", script], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=False)
        self.assertEqual(res.returncode, 0, res.stderr)
        time.sleep(0.8)
        self.assertFalse(marker.exists(), "leaf worker must be reaped before scratch removal and never write marker")

    def test_build_release_real_lanes_cold_hit_and_failure(self) -> None:
        src = DEPLOY_SH.read_text(encoding="utf-8")
        m_br = re.search(r"^build_release\(\) \{.*?^\}", src, re.M | re.S)
        m_cl = re.search(r"^commercial_cleanup_build_locals\(\) \{.*?^\}", src, re.M | re.S)
        self.assertIsNotNone(m_br, "failed to extract build_release() from scripts/deploy-v5.sh")
        self.assertIsNotNone(m_cl, "failed to extract commercial_cleanup_build_locals() from scripts/deploy-v5.sh")

        link_fixture_workspaces(self.repo)
        releases = self.tmp / "releases"
        cur_rel = releases / "rel-prev"
        (cur_rel / "packages/web-react/dist").mkdir(parents=True)
        (cur_rel / "packages/web-react/dist/index.html").write_text(
            '<meta name="oc-build" content="abcdef123456">', encoding="utf-8"
        )
        (cur_rel / "package-lock.json").write_text(
            (self.repo / "package-lock.json").read_text(encoding="utf-8"), encoding="utf-8"
        )
        link_fixture_workspaces(cur_rel)
        os.chmod(releases, 0o755)

        real_node = shutil.which("node")
        self.assertIsNotNone(real_node)

        stub_bin = self.tmp / "stub-bin"
        stub_bin.mkdir()
        call_log = self.tmp / "calls.log"
        fail_marker = self.tmp / "fail-gate.txt"

        (stub_bin / "npx").write_text(
            f"""#!/usr/bin/env bash
printf 'npx %s\\n' "$*" >> "{call_log}"
if [[ -f "{fail_marker}" ]]; then
  want="$(cat "{fail_marker}")"
  if [[ "$*" == *"$want"* ]]; then
    echo "simulated failure: $want" >&2
    exit 1
  fi
fi
exit 0
""",
            encoding="utf-8",
        )
        os.chmod(stub_bin / "npx", 0o755)

        (stub_bin / "npm").write_text(
            f"""#!/usr/bin/env bash
printf 'npm %s\\n' "$*" >> "{call_log}"
if [[ "$*" == *"--version"* ]]; then
  echo "10.8.2"
  exit 0
fi
if [[ "$*" == *"run build --workspace packages/web-react"* ]]; then
  mkdir -p packages/web-react/dist
  printf '<meta name="oc-build" content="deadbeef1234">\\n' > packages/web-react/dist/index.html
  printf '{{"version":"5.7.0"}}\\n' > packages/web-react/tsconfig.tsbuildinfo
  chmod 0644 packages/web-react/tsconfig.tsbuildinfo
fi
exit 0
""",
            encoding="utf-8",
        )
        os.chmod(stub_bin / "npm", 0o755)

        # Delegate `node -e` to the real node binary so commercial_verify_pinned_workspaces_local's
        # real better-sqlite3 resolution check executes, while stubbing version & proof scripts.
        (stub_bin / "node").write_text(
            f"""#!/usr/bin/env bash
if [[ "${{1:-}}" == "-e" ]]; then
  exec "{real_node}" "$@"
fi
printf 'node %s\\n' "$*" >> "{call_log}"
if [[ "${{1:-}}" == "--version" ]]; then
  echo "v20.20.2"
  exit 0
fi
exit 0
""",
            encoding="utf-8",
        )
        os.chmod(stub_bin / "node", 0o755)

        codex_stub = self.repo / "scripts" / "check-v5-codex-late-stop-proof.sh"
        codex_stub.parent.mkdir(parents=True, exist_ok=True)
        codex_stub.write_text(f'#!/usr/bin/env bash\nprintf "codex-late-stop\\n" >> "{call_log}"\n', encoding="utf-8")
        os.chmod(codex_stub, 0o755)
        run_git(self.repo, "add", "-A")
        run_git(self.repo, "commit", "-m", "add codex stub")
        sha = run_git(self.repo, "rev-parse", "HEAD")

        waiver_stub = self.tmp / "waiver-gate.sh"
        waiver_stub.write_text("#!/usr/bin/env bash\nexit 0\n", encoding="utf-8")
        os.chmod(waiver_stub, 0o755)

        # Provide a deterministic stub bun on PATH so both master & codex bun IDs resolve.
        (stub_bin / "bun").write_text("#!/usr/bin/env bash\necho 1.3.14\n", encoding="utf-8")
        os.chmod(stub_bin / "bun", 0o755)

        harness = self.tmp / "run_build_release.sh"
        harness.write_text(
            f"""#!/usr/bin/env bash
set -Eeuo pipefail
export PATH="{stub_bin}:$PATH"
unset OC_BUN_BIN BUN_BIN
source "{SHELL_LIB}"
REPO_ROOT="{self.repo}"
RELEASES_ROOT="{releases}"
KL_HOST="local-stub"
DRY=0
WITH_DIST=1
RUNTIME_IMAGE_REF="openclaude/runtime:test"
RUNTIME_IMAGE_ID="sha256:test123"
OC_V5_COMMERCIAL_GATE_CACHE_DIR="{self.cache}"
OC_V5_TSC_CACHE_DIR="{releases}/.tsc-cache"
OC_V5_PROOF_TEST_DATABASE_URL="postgres://test:test@127.0.0.1:55432/openclaude_test"
TURN_WAIVER_SQL_GATE="{waiver_stub}"
CAPTURED_RELEASE_PREDECESSOR="{cur_rel}"
BUILD_RELEASE_ACTIVE_TMPDIR=""
BUILD_RELEASE_ACTIVE_BOX_CAND=""
BUILD_RELEASE_ACTIVE_PIDS=()

resolve_release_source_commit() {{ printf '%s' "{sha}"; }}
assert_ci_green_process_local() {{ return 0; }}
bg_current_release() {{ printf '%s' "{cur_rel}"; }}
assert_clean_source_tree() {{ return 0; }}
write_flavor_manifest() {{ printf '{{"flavor":"commercial"}}\\n' > "$1/flavor.manifest.json"; }}
scp() {{ cp "$2" "${{3#*:}}"; }}
try_reuse_web_dist() {{ return 1; }}
write_version() {{ printf '%s\\n' "$2" > "$1/VERSION"; }}
harden_release_baseline() {{ return 0; }}
write_release_baseline_manifest() {{ return 0; }}
publish_strong_release() {{ mv -T "$1" "$2"; : > "$2/.complete"; }}
record_dist_reuse_in_complete() {{ return 0; }}
ssh() {{
  shift
  if [[ "$1" == "bash" || "$1" == "python3" ]]; then
    "$@"
  else
    bash -c "$1"
  fi
}}

{m_cl.group(0)}
{m_br.group(0)}

build_release
""",
            encoding="utf-8",
        )
        os.chmod(harness, 0o755)

        r1 = subprocess.run(["bash", str(harness)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=False)
        self.assertEqual(r1.returncode, 0, f"cold build_release failed:\n{r1.stderr}")
        self.assertIn("cache_hits=0/25, executed=25", r1.stderr)
        log1 = call_log.read_text(encoding="utf-8")
        self.assertIn("npm --prefix /tmp/ocv5-box-success-cand.", log1)
        self.assertIn("check-v5-lossless-anchor-contract.ts", log1)
        self.assertIn("check-v5-master-incident-proofs.ts", log1)
        self.assertTrue((releases / ".tsc-cache/web-react.tsbuildinfo").is_file())

        call_log.unlink()
        r2 = subprocess.run(["bash", str(harness)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=False)
        self.assertEqual(r2.returncode, 0, f"warm all-hit build_release failed:\n{r2.stderr}")
        self.assertIn("cache_hits=25/25, executed=0", r2.stderr)
        self.assertIn("seeded warm frontend tsbuildinfo", r2.stderr)
        log2 = call_log.read_text(encoding="utf-8") if call_log.exists() else ""
        self.assertNotIn("ocv5-box-success-cand.", log2, "all-hit run must skip box_cand npm ci")
        self.assertNotIn("check-v5-lossless-anchor-contract.ts", log2)
        self.assertNotIn("check-v5-master-incident-proofs.ts", log2)

        shutil.rmtree(self.cache, ignore_errors=True)
        fail_marker.write_text("check-v5-visible-orphan-liveness.ts", encoding="utf-8")
        r3 = subprocess.run(["bash", str(harness)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=False)
        self.assertNotEqual(r3.returncode, 0, "single gate failure must fail build_release")
        self.assertIn("visible-orphan liveness gate failed", r3.stderr)
        receipts = list(self.cache.glob("*.json")) if self.cache.exists() else []
        self.assertEqual(receipts, [], "failed build_release must not record any gate receipts")


if __name__ == "__main__":
    unittest.main()
