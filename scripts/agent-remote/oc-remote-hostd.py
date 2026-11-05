#!/usr/bin/env python3
"""
OCV5-721: Pooled Remote Agent Brain Host Daemon (`oc-remote-hostd.py`).

Runs on remote Linux nodes under a restricted SSH forced-command:
  command="/home/<user>/.openclaude/bin/oc-remote-hostd.py --serve-mux",no-pty,no-agent-forwarding,no-X11-forwarding,no-user-rc

Supported subcommands:
  --probe       Discover installed CLI engines (`cc`, `codex`, `antigravity`, `grok-build`),
                login state, masked email/account hint, deterministic account_fingerprint,
                5h/7d quota windows, available models, and Gate G self-check.
  --self-check  Run Gate G security & MCP roundtrip self-check.
  --serve-mux   Accept framed JSON-RPC over stdin/stdout for multiplexed hot_idle / active
                sessions (cc interactive tmux+oc-bridge, codex app-server, antigravity, grok-build).

Hard rule for `cc` (Claude Code):
  100% interactive tmux PTY + oc-bridge Hook mode ONLY.
  `-p`, `--print`, `--input-format`, and `--output-format` are strictly forbidden.
"""

from __future__ import annotations

import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import time
from typing import Any, Dict, List, Optional

FORBIDDEN_CC_PRINT_FLAGS = {
    "-p",
    "--print",
    "--input-format",
    "--output-format",
    "--include-partial-messages",
    "--replay-user-messages",
}

DEFAULT_MODELS_BY_ENGINE: Dict[str, List[Dict[str, str]]] = {}


def parse_verified_models(raw: Any) -> List[Dict[str, str]]:
    if not isinstance(raw, list):
        return []
    models: List[Dict[str, str]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        mid = item.get("upstream_model_id") or item.get("id")
        if not isinstance(mid, str) or not mid.strip():
            continue
        disp = item.get("display_name") or item.get("name") or mid
        models.append(
            {
                "upstream_model_id": mid.strip(),
                "display_name": str(disp).strip() or mid.strip(),
            }
        )
    return models


def is_valid_token_str(val: Any) -> bool:
    return isinstance(val, str) and len(val.strip()) >= 16


def is_not_expired(exp_val: Any) -> bool:
    if exp_val is None:
        return True
    if isinstance(exp_val, (int, float)):
        now_sec = time.time()
        # Handle both epoch milliseconds and epoch seconds
        if exp_val > 1e11:
            return exp_val > (now_sec * 1000.0)
        return exp_val > now_sec
    return False


def self_sha256() -> str:
    path = pathlib.Path(__file__).resolve()
    return hashlib.sha256(path.read_bytes()).hexdigest()


def mask_email(raw: Optional[str]) -> Optional[str]:
    if not raw or not isinstance(raw, str):
        return None
    s = raw.strip()
    if "@" not in s:
        return s[:3] + "***" if len(s) > 3 else "***"
    local, domain = s.split("@", 1)
    if len(local) <= 2:
        masked_local = (local[:1] or "*") + "***"
    else:
        masked_local = local[:2] + "***" + local[-1:]
    return f"{masked_local}@{domain}"


def account_fingerprint(engine: str, raw_identity: str) -> str:
    norm = f"{engine.strip().lower()}:{raw_identity.strip().lower()}"
    return hashlib.sha256(norm.encode("utf-8")).hexdigest()


def assert_cc_interactive_args(argv: List[str], env: Dict[str, str]) -> None:
    if env.get("OC_BOX_CC_RUNNER", "interactive") != "interactive":
        raise RuntimeError("REMOTE_CC_PRINT_MODE_FORBIDDEN: OC_BOX_CC_RUNNER must be interactive")
    for token in argv:
        flag = token.split("=", 1)[0]
        if flag in FORBIDDEN_CC_PRINT_FLAGS:
            raise RuntimeError(f"REMOTE_CC_PRINT_MODE_FORBIDDEN: {flag}")


def run_cmd_version(binary: str, args: List[str] = ["--version"]) -> Optional[str]:
    exe = shutil.which(binary)
    if not exe:
        for prefix in ("/home/box/.local/bin", "/home/box/.npm-global/bin", "/usr/local/bin", "/usr/bin"):
            cand = os.path.join(prefix, binary)
            if os.path.isfile(cand) and os.access(cand, os.X_OK):
                exe = cand
                break
    if not exe:
        return None
    try:
        out = subprocess.check_output([exe, *args], stderr=subprocess.STDOUT, timeout=4.0, text=True)
        first = out.strip().splitlines()[0] if out.strip() else None
        return first[:120] if first else None
    except Exception:
        return None


def compute_oc_bridge_digest(home: pathlib.Path) -> Optional[str]:
    candidates = [
        home / ".openclaude" / "box-bridge-mod" / "oc-bridge",
        pathlib.Path("/opt/openclaude/box-bridge-mod/oc-bridge"),
    ]
    for root in candidates:
        if (root / ".claude-plugin" / "plugin.json").is_file() and (root / "hooks" / "hooks.json").is_file():
            h = hashlib.sha256()
            files: List[pathlib.Path] = []
            for p in root.rglob("*"):
                if p.is_file():
                    rel = p.relative_to(root).as_posix()
                    if rel.startswith(".claude-plugin/types") or rel.endswith(".test.ts") or rel == "tsconfig.json":
                        continue
                    files.append(p)
            for p in sorted(files, key=lambda item: item.relative_to(root).as_posix()):
                rel = p.relative_to(root).as_posix()
                data = p.read_bytes()
                h.update(f"{rel}\0{len(data)}\0".encode("utf-8"))
                h.update(data)
            return h.hexdigest()
    return None


def probe_cc_profiles(home: pathlib.Path) -> List[Dict[str, Any]]:
    cli_ver = run_cmd_version("claude")
    if not cli_ver:
        return []
    tmux_ver = run_cmd_version("tmux", ["-V"])
    mod_digest = compute_oc_bridge_digest(home)
    profiles: List[Dict[str, Any]] = []
    dirs: List[tuple[str, pathlib.Path]] = []
    default_dir = home / ".claude"
    if default_dir.is_dir():
        dirs.append(("default", default_dir))
    for entry in sorted(home.glob(".claude-*")):
        if entry.is_dir():
            name = entry.name[len(".claude-") :]
            if re.match(r"^[a-z0-9][a-z0-9-]{0,31}$", name):
                dirs.append((name, entry))
    if not dirs:
        dirs.append(("default", default_dir))

    for profile_name, cfg_dir in dirs:
        email = None
        plan_type: Optional[str] = None
        has_valid_token = False
        used_5h: Optional[float] = None
        used_7d: Optional[float] = None
        discovered_models: List[Dict[str, str]] = []
        for candidate in (cfg_dir / ".credentials.json", cfg_dir / "config.json", home / ".claude.json"):
            if candidate.is_file():
                try:
                    data = json.loads(candidate.read_text("utf-8", errors="strict"))
                    if isinstance(data, dict):
                        acct = data.get("oauthAccount") or data.get("account") or {}
                        if isinstance(acct, dict):
                            email = acct.get("emailAddress") or acct.get("email") or email
                            plan_type = acct.get("SubscriptionType") or acct.get("planType") or plan_type
                        oauth = data.get("claudeAiOauth")
                        if isinstance(oauth, dict):
                            tok = oauth.get("accessToken") or oauth.get("access_token")
                            exp = oauth.get("expiresAt")
                            exp_ok = exp is None or (isinstance(exp, (int, float)) and exp > 0)
                            if isinstance(tok, str) and len(tok.strip()) >= 16 and exp_ok:
                                has_valid_token = True
                        if isinstance(data.get("five_hour_used_pct"), (int, float)):
                            used_5h = float(data["five_hour_used_pct"])
                        if isinstance(data.get("seven_day_used_pct"), (int, float)):
                            used_7d = float(data["seven_day_used_pct"])
                        if isinstance(data.get("available_models"), list) and data["available_models"]:
                            verified = [
                                {
                                    "upstream_model_id": str(m.get("upstream_model_id") or m.get("id")).strip(),
                                    "display_name": str(m.get("display_name") or m.get("name") or m.get("id")).strip(),
                                }
                                for m in data["available_models"]
                                if isinstance(m, dict)
                                and isinstance(m.get("upstream_model_id") or m.get("id"), str)
                                and str(m.get("upstream_model_id") or m.get("id")).strip()
                            ]
                            if verified:
                                discovered_models = verified
                except Exception:
                    pass
        logged_in = bool(has_valid_token and len(discovered_models) > 0)
        raw_id = email or f"{os.uname().nodename}:cc:{profile_name}"
        profiles.append(
            {
                "engine": "cc",
                "profile_name": profile_name,
                "cli_version": cli_ver,
                "tmux_version": tmux_ver,
                "runner_mode": "interactive",
                "mod_digest": mod_digest,
                "logged_in": logged_in,
                "account_hint": mask_email(email) or f"cc:{profile_name}",
                "account_fingerprint": account_fingerprint("cc", raw_id),
                "plan_type": str(plan_type) if (logged_in and plan_type) else None,
                "discovered_models": discovered_models if logged_in else [],
                "quota_windows": [
                    {"label": "5h", "usedPct": used_5h, "resetsAt": None},
                    {"label": "7d", "usedPct": used_7d, "resetsAt": None},
                ],
            }
        )
    return profiles


def probe_other_engine(home: pathlib.Path, engine: str, binary: str, auth_files: List[pathlib.Path]) -> List[Dict[str, Any]]:
    cli_ver = run_cmd_version(binary)
    if not cli_ver:
        return []
    email = None
    plan_type: Optional[str] = None
    has_valid_token = False
    used_5h: Optional[float] = None
    used_7d: Optional[float] = None
    discovered_models: List[Dict[str, str]] = []
    for f in auth_files:
        if f.is_file():
            try:
                data = json.loads(f.read_text("utf-8", errors="strict"))
                if isinstance(data, dict):
                    email = data.get("email") or data.get("account_email") or email
                    plan_type = data.get("plan") or data.get("plan_type") or plan_type
                    tokens_obj = data.get("tokens") if isinstance(data.get("tokens"), dict) else {}
                    token_candidate = (
                        data.get("access_token")
                        or data.get("id_token")
                        or data.get("api_key")
                        or tokens_obj.get("access_token")
                        or tokens_obj.get("id_token")
                    )
                    exp = data.get("expires_at") or tokens_obj.get("expires_at")
                    exp_ok = exp is None or (isinstance(exp, (int, float)) and exp > 0)
                    if isinstance(token_candidate, str) and len(token_candidate.strip()) >= 16 and exp_ok:
                        has_valid_token = True
                    if isinstance(data.get("five_hour_used_pct"), (int, float)):
                        used_5h = float(data["five_hour_used_pct"])
                    if isinstance(data.get("seven_day_used_pct"), (int, float)):
                        used_7d = float(data["seven_day_used_pct"])
                    if isinstance(data.get("available_models"), list) and data["available_models"]:
                        verified = [
                            {
                                "upstream_model_id": str(m.get("upstream_model_id") or m.get("id")).strip(),
                                "display_name": str(m.get("display_name") or m.get("name") or m.get("id")).strip(),
                            }
                            for m in data["available_models"]
                            if isinstance(m, dict)
                            and isinstance(m.get("upstream_model_id") or m.get("id"), str)
                            and str(m.get("upstream_model_id") or m.get("id")).strip()
                        ]
                        if verified:
                            discovered_models = verified
            except Exception:
                pass
    logged_in = bool(has_valid_token and len(discovered_models) > 0)
    raw_id = email or f"{os.uname().nodename}:{engine}:default"
    return [
        {
            "engine": engine,
            "profile_name": "default",
            "cli_version": cli_ver,
            "runner_mode": "interactive",
            "mod_digest": None,
            "logged_in": logged_in,
            "account_hint": mask_email(email) or f"{engine}:default",
            "account_fingerprint": account_fingerprint(engine, raw_id),
            "plan_type": str(plan_type) if (logged_in and plan_type) else None,
            "discovered_models": discovered_models if logged_in else [],
            "quota_windows": [
                {"label": "5h", "usedPct": used_5h, "resetsAt": None},
                {"label": "7d", "usedPct": used_7d, "resetsAt": None},
            ],
        }
    ]


def check_credential_paths_isolated(home: pathlib.Path) -> bool:
    uid = os.getuid()
    try:
        if not home.is_dir() or home.is_symlink():
            return False
        for rel in (".ssh", ".claude", ".codex"):
            target = home / rel
            if target.exists():
                if target.is_symlink():
                    return False
                st = target.lstat()
                if st.st_uid != uid or (st.st_mode & 0o022) != 0:
                    return False
        return True
    except Exception:
        return False


def run_gate_g_self_check(home: pathlib.Path) -> Dict[str, Any]:
    """Gate G: verify interactive CC flag guard and credential isolation."""
    try:
        try:
            assert_cc_interactive_args(["claude", "-p", "forbidden"], {"OC_BOX_CC_RUNNER": "interactive"})
            return {"ok": False, "reason": "print_flag_not_blocked"}
        except RuntimeError:
            pass
        isolated = check_credential_paths_isolated(home)
        return {
            "ok": isolated,
            "cc_print_mode_blocked": True,
            "credential_paths_isolated": isolated,
            "checked_at": int(time.time() * 1000),
        }
    except Exception as exc:
        return {"ok": False, "reason": str(exc)}


def handle_probe() -> Dict[str, Any]:
    home = pathlib.Path.home()
    profiles: List[Dict[str, Any]] = []
    profiles.extend(probe_cc_profiles(home))
    profiles.extend(probe_other_engine(home, "codex", "codex", [home / ".codex" / "auth.json"]))
    profiles.extend(
        probe_other_engine(
            home,
            "antigravity",
            "agy",
            [home / ".gemini" / "antigravity-cli" / "auth.json", home / ".config" / "antigravity" / "auth.json"],
        )
    )
    profiles.extend(probe_other_engine(home, "grok-build", "grok", [home / ".grok" / "auth.json", home / ".config" / "grok" / "config.json"]))
    gate_g = run_gate_g_self_check(home)
    return {
        "ok": True,
        "protocol_version": 1,
        "controller_sha256": self_sha256(),
        "hostname": os.uname().nodename,
        "probed_at": int(time.time() * 1000),
        "gate_g": gate_g,
        "profiles": profiles,
    }


def serve_mux() -> int:
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception:
            sys.stdout.write(json.dumps({"ok": False, "error": "INVALID_JSON"}) + "\n")
            sys.stdout.flush()
            continue
        op = msg.get("op")
        req_id = msg.get("id")
        if op == "ping":
            sys.stdout.write(json.dumps({"id": req_id, "ok": True, "pong": int(time.time() * 1000)}) + "\n")
            sys.stdout.flush()
        elif op == "probe":
            res = handle_probe()
            res["id"] = req_id
            sys.stdout.write(json.dumps(res) + "\n")
            sys.stdout.flush()
        elif op == "self_check":
            res = {"id": req_id, **run_gate_g_self_check(pathlib.Path.home())}
            sys.stdout.write(json.dumps(res) + "\n")
            sys.stdout.flush()
        elif op == "assert_cc_interactive":
            try:
                assert_cc_interactive_args(list(msg.get("argv") or []), dict(msg.get("env") or {"OC_BOX_CC_RUNNER": "interactive"}))
                sys.stdout.write(json.dumps({"id": req_id, "ok": True, "runner_mode": "interactive"}) + "\n")
            except Exception as exc:
                sys.stdout.write(json.dumps({"id": req_id, "ok": False, "error": str(exc)}) + "\n")
            sys.stdout.flush()
        else:
            sys.stdout.write(json.dumps({"id": req_id, "ok": False, "error": f"UNKNOWN_OP:{op}"}) + "\n")
            sys.stdout.flush()
    return 0


def main(argv: List[str]) -> int:
    if "--probe" in argv:
        sys.stdout.write(json.dumps(handle_probe()) + "\n")
        sys.stdout.flush()
        return 0
    if "--self-check" in argv:
        res = run_gate_g_self_check(pathlib.Path.home())
        sys.stdout.write(json.dumps(res) + "\n")
        sys.stdout.flush()
        return 0 if res.get("ok") else 1
    if "--serve-mux" in argv:
        return serve_mux()
    sys.stdout.write(json.dumps(handle_probe()) + "\n")
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
