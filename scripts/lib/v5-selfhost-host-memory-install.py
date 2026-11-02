#!/usr/bin/env python3
"""Selfhost-only sampler installation primitives for the official release owner.

The command line is a read-only plan by default. Mutations require an explicit
owner_check callback supplied by the existing release coordinator; this module
does not mint owner flags, acquire an alternative lease, or authorize itself.
File replacement is atomic. File/service changes together are not a transaction:
a durable snapshot precedes them and failed/uncertain recovery is reported.
"""

from __future__ import annotations

import argparse
import ast
import configparser
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import stat
import subprocess
import tempfile
from typing import Callable
import uuid

UNIT = "openclaude-v5-selfhost-host-memory.service"
LIVE = Path("/opt/openclaude/openclaude-v5-selfhost-live")
RELEASES = Path("/opt/openclaude/openclaude-v5-selfhost-releases")
PROGRAM = Path("/opt/openclaude/v5-selfhost-breakglass/host-memory/sampler.py")
UNIT_FILE = Path("/etc/systemd/system") / UNIT
STATE_ROOT = Path("/var/lib/openclaude-v5-selfhost/host-memory-install")
SOURCE_PROGRAM = Path("scripts/v5-selfhost-host-memory.py")
SOURCE_UNIT = Path("deploy/v5-selfhost") / UNIT
SNAPSHOT_NAME = re.compile(r"\d{8}T\d{6}Z-[0-9a-f]{12}\Z")
OPERATION_ID = re.compile(r"tr-[A-Za-z0-9][A-Za-z0-9_-]{0,124}\Z")
# Effective configuration is checked through systemd as well: files can appear
# in a generator/control/vendor path that is not present on every host.
UNIT_PATHS = tuple(Path(p) for p in (
    "/etc/systemd/system.control", "/run/systemd/system.control",
    "/run/systemd/transient", "/run/systemd/generator.early",
    "/etc/systemd/system", "/etc/systemd/system.attached",
    "/run/systemd/system", "/run/systemd/system.attached",
    "/run/systemd/generator", "/usr/local/lib/systemd/system",
    "/usr/lib/systemd/system", "/lib/systemd/system",
    "/run/systemd/generator.late",
))
DEPENDENCY_PROPERTIES = (
    "Wants", "Requires", "Requisite", "BindsTo", "PartOf", "Upholds",
    "OnFailure", "OnSuccess", "PropagatesStopTo", "StopPropagatedFrom",
    "PropagatesReloadTo", "ReloadPropagatedFrom", "Conflicts",
)


class InstallError(RuntimeError):
    pass


class OwnershipRequired(InstallError):
    pass


class ServiceOperationUnknown(InstallError):
    pass


class RecoveryRequired(InstallError):
    def __init__(self, snapshot: Path, observed: dict | None = None):
        super().__init__("Sampler recovery requires owner review; snapshot=" + str(snapshot))
        self.snapshot = snapshot
        self.observed = observed


def _sha(blob: bytes) -> str:
    return hashlib.sha256(blob).hexdigest()


def _systemctl(args: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(["systemctl", *args], capture_output=True, text=True,
                          timeout=30, check=False)


class Installer:
    """root/runner injection is for isolated fixtures, never a new owner source."""

    def __init__(self, root: Path = Path("/"), runner: Callable = _systemctl):
        self.root = root.absolute()
        self.runner = runner

    def path(self, logical: Path) -> Path:
        return self.root / logical.relative_to("/")

    @staticmethod
    def _check_owner(owner_check: Callable | None) -> None:
        if owner_check is None:
            raise OwnershipRequired("Official release owner_check callback is required")
        # A successful callback returns None; False is also rejected so a
        # accidentally boolean, unsuccessful check cannot authorize a write.
        if owner_check() is False:
            raise OwnershipRequired("Official release ownership check failed")

    @staticmethod
    def _safe_path(path: Path, *, leaf_link: bool = False) -> None:
        parts = list(path.absolute().parents)[::-1] + [path.absolute()]
        for part in parts:
            try:
                s = part.lstat()
            except FileNotFoundError:
                continue
            if stat.S_ISLNK(s.st_mode) and not (leaf_link and part == path):
                raise InstallError("Symlink path refused: " + str(part))
            if part != path and not stat.S_ISDIR(s.st_mode):
                raise InstallError("Non-directory parent refused")

    @classmethod
    def _regular(cls, path: Path, *, absent_ok: bool = False) -> os.stat_result | None:
        cls._safe_path(path)
        try:
            s = path.lstat()
        except FileNotFoundError:
            if absent_ok:
                return None
            raise InstallError("Required file is absent: " + str(path)) from None
        if not stat.S_ISREG(s.st_mode) or s.st_nlink != 1:
            raise InstallError("Non-regular or hard-linked file refused")
        if s.st_uid != os.geteuid() or s.st_mode & 0o022:
            raise InstallError("Untrusted file owner or write permissions")
        return s

    def _dropins(self) -> None:
        # Include dash-prefix and global service drop-ins. These checks also
        # protect the not-yet-loaded case; effective DropInPaths is authoritative
        # once daemon-reload has loaded the new fragment.
        stem = UNIT.removesuffix(".service")
        names = [UNIT, "service"] + [stem[:m.end()] + ".service"
                                      for m in re.finditer("-", stem)]
        for base in UNIT_PATHS:
            for name in names:
                for suffix in (".d", ".wants", ".requires"):
                    path = self.path(base / (name + suffix))
                    # /lib may be a distribution alias of /usr/lib. Do not
                    # follow it: the effective systemd query still covers it.
                    if any(p.is_symlink() for p in [path, *path.parents]):
                        if base == Path("/lib/systemd/system"):
                            continue
                        raise InstallError("Symlink sampler override path refused")
                    self._safe_path(path)
                    if path.exists() and (not path.is_dir() or any(path.iterdir())):
                        raise InstallError("Existing sampler drop-ins/dependencies require separate review")

    @staticmethod
    def _allowed_dependencies() -> dict[str, set[str]]:
        # Default service dependencies and mount ancestors of only the fixed
        # sampler/log paths. Do not allow an arbitrary injected service/mount.
        mounts = {"-.mount"}
        for fixed in (PROGRAM.parent, Path("/var/log/openclaude-v5-selfhost/host-memory")):
            for parent in (fixed, *fixed.parents):
                if parent == Path("/"):
                    continue
                escaped = str(parent).lstrip("/").replace("-", r"\x2d").replace("/", "-")
                mounts.add(escaped + ".mount")
        return {"Requires": {"sysinit.target", "system.slice", *mounts},
                "Conflicts": {"shutdown.target"}}

    @staticmethod
    def _validate_unit(blob: bytes) -> None:
        unit = configparser.ConfigParser(interpolation=None, strict=True)
        try:
            unit.read_string(blob.decode("utf-8"))
            argv = shlex.split(unit["Service"]["ExecStart"])
            if argv[0] != "/usr/bin/python3" or argv[-1] != str(PROGRAM):
                raise ValueError("Unexpected sampler ExecStart")
            if any(arg not in ("-I", "-B") for arg in argv[1:-1]):
                raise ValueError("Unexpected sampler arguments")
            if unit["Service"].get("User", "root") != "root":
                raise ValueError("Unexpected sampler identity")
            if "environmentfile" in unit["Service"] or any(
                    k.startswith("exec") and k != "execstart" for k in unit["Service"]):
                raise ValueError("Unexpected sampler hook/config")
            dependency_keys = {"wants", "requires", "requisite", "bindsto", "partof",
                               "upholds", "onfailure", "onsuccess", "propagatesstopto",
                               "stoppropagatedfrom", "propagatesreloadto", "reloadpropagatedfrom",
                               "conflicts", "requiresmountsfor", "wantsmountsfor"}
            if "Unit" in unit and dependency_keys.intersection(unit["Unit"]):
                raise ValueError("Unexpected cross-unit dependency")
            if set(unit["Install"]) != {"wantedby"} or unit["Install"]["WantedBy"].split() != ["multi-user.target"]:
                raise ValueError("Unexpected sampler enable targets/aliases")
        except (UnicodeError, configparser.Error, KeyError, ValueError, IndexError):
            raise InstallError("Sampler unit validation failed; unit not executed") from None

    def _source(self, source_release: Path | None) -> tuple[Path, dict[str, bytes]]:
        live = self.path(LIVE)
        self._safe_path(live, leaf_link=True)
        if not live.is_symlink():
            raise InstallError("Expected existing selfhost-live symlink")
        resolved = live.resolve(strict=True)
        self._safe_path(resolved)
        releases = self.path(RELEASES)
        if resolved.parent != releases or not re.fullmatch(r"rel-[A-Za-z0-9._-]+", resolved.name):
            raise InstallError("Live target is outside selfhost releases")
        candidate = live if source_release is None else Path(source_release).absolute()
        if candidate != live:
            self._safe_path(candidate)
        if candidate.resolve(strict=True) != resolved:
            raise InstallError("Source must be the current selfhost live release")
        result = {}
        for key, relative in (("program", SOURCE_PROGRAM), ("unit", SOURCE_UNIT)):
            file = resolved / relative
            self._regular(file)
            result[key] = file.read_bytes()
        try:
            ast.parse(result["program"].decode("utf-8"))
        except (SyntaxError, UnicodeError):
            raise InstallError("Sampler source validation failed; source not executed") from None
        self._validate_unit(result["unit"])
        return resolved, result

    def _state(self) -> dict:
        try:
            r = self.runner(["show", UNIT, "--no-pager",
                             "--property=" + ",".join(("LoadState", "ActiveState", "UnitFileState", "Job",
                                                       "FragmentPath", "DropInPaths", *DEPENDENCY_PROPERTIES))])
        except OwnershipRequired:
            raise
        except Exception:
            raise InstallError("Sampler service state is unavailable") from None
        values = dict(line.split("=", 1) for line in r.stdout.splitlines() if "=" in line)
        load = values.get("LoadState")
        active = values.get("ActiveState")
        enabled = values.get("UnitFileState", "")
        if r.returncode and load != "not-found":
            raise InstallError("Sampler service state query failed")
        if load not in ("loaded", "not-found") or active not in ("active", "inactive", "failed"):
            raise InstallError("Sampler service state is not stable/recognized")
        if values.get("Job", "").strip() not in ("", "0"):
            raise InstallError("Sampler service still has a pending job")
        if enabled not in ("", "enabled", "disabled"):
            raise InstallError("Sampler enable/mask/link state needs separate review")
        if not {"FragmentPath", "DropInPaths", *DEPENDENCY_PROPERTIES}.issubset(values):
            raise InstallError("Sampler effective configuration is unavailable")
        if values["DropInPaths"].strip():
            raise InstallError("Effective sampler drop-ins require separate review")
        if values["FragmentPath"] != (str(UNIT_FILE) if load == "loaded" else ""):
            raise InstallError("Effective sampler fragment is not the fixed owned unit")
        allowed = self._allowed_dependencies()
        if any(set(values[key].split()) - allowed.get(key, set()) for key in DEPENDENCY_PROPERTIES):
            raise InstallError("Effective sampler cross-unit dependencies require separate review")
        return {"load": load, "active_state": active, "active": active == "active",
                "enabled": enabled == "enabled", "unit_file_state": enabled or "not-found"}

    def _old_file(self, path: Path) -> dict:
        s = self._regular(path, absent_ok=True)
        if s is None:
            return {"exists": False}
        data = path.read_bytes()
        return {"exists": True, "mode": stat.S_IMODE(s.st_mode),
                "sha256": _sha(data), "bytes": len(data)}

    def plan(self, source_release: Path | None = None) -> dict:
        source, blobs = self._source(source_release)
        self._dropins()
        files = {key: self._old_file(self.path(logical))
                 for key, logical in (("program", PROGRAM), ("unit", UNIT_FILE))}
        if files["unit"]["exists"]:
            self._validate_unit(self.path(UNIT_FILE).read_bytes())
        previous_state = self._state()
        if previous_state["active_state"] == "failed":
            raise InstallError("Existing failed sampler needs separate recovery review")
        return {"source_release": str(source), "unit": UNIT,
                "source_sha256": {k: _sha(v) for k, v in blobs.items()},
                "previous_files": files, "previous_state": previous_state,
                "program_directory_existed": self.path(PROGRAM.parent).exists()}

    def _mkdir(self, path: Path, owner_check: Callable) -> None:
        self._check_owner(owner_check)
        self._safe_path(path)
        path.mkdir(mode=0o700, parents=True, exist_ok=True)
        self._safe_path(path)
        s = path.lstat()
        if not stat.S_ISDIR(s.st_mode) or s.st_uid != os.geteuid() or s.st_mode & 0o077:
            raise InstallError("Snapshot/program directory is not private and owned")

    def _write(self, path: Path, blob: bytes, mode: int, owner_check: Callable) -> None:
        self._check_owner(owner_check)
        self._regular(path, absent_ok=True)
        fd, tmp = tempfile.mkstemp(prefix="." + path.name + ".", dir=path.parent)
        try:
            with os.fdopen(fd, "wb") as stream:
                os.fchmod(stream.fileno(), mode)
                stream.write(blob)
                stream.flush()
                os.fsync(stream.fileno())
            self._check_owner(owner_check)
            self._regular(path, absent_ok=True)
            os.replace(tmp, path)
            parent_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(parent_fd)
            finally:
                os.close(parent_fd)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)

    def _manifest(self, snapshot: Path, manifest: dict, owner_check: Callable) -> None:
        self._write(snapshot / "manifest.json",
                    (json.dumps(manifest, sort_keys=True, indent=2) + "\n").encode(),
                    0o600, owner_check)

    def _receipt_path(self, operation_id: str | None) -> Path:
        if not isinstance(operation_id, str) or not OPERATION_ID.fullmatch(operation_id):
            raise InstallError("Explicit tr-* operation_id is required; it is not authorization")
        return self.path(STATE_ROOT) / ("operation-" + _sha(operation_id.encode()) + ".json")

    def _load_receipt(self, operation_id: str) -> tuple[Path, dict | None]:
        path = self._receipt_path(operation_id)
        s = self._regular(path, absent_ok=True)
        if s is None:
            return path, None
        parent = path.parent.lstat()
        if parent.st_uid != os.geteuid() or parent.st_mode & 0o077 or s.st_mode & 0o077:
            raise InstallError("Operation receipt is not private and owned")
        receipt = json.loads(path.read_text())
        if (receipt.get("schema") != 1 or receipt.get("unit") != UNIT
                or receipt.get("operation_id") != operation_id
                or not SNAPSHOT_NAME.fullmatch(receipt.get("snapshot", ""))):
            raise InstallError("Unexpected sampler operation receipt")
        return path, receipt

    def _receipt(self, path: Path, receipt: dict, owner_check: Callable, *, new=False) -> None:
        blob = (json.dumps(receipt, sort_keys=True, indent=2) + "\n").encode()
        if not new:
            self._write(path, blob, 0o600, owner_check)
            return
        self._check_owner(owner_check)
        self._safe_path(path)
        # Publish a complete, fsynced receipt without replacing a racing
        # operation. The hard link is removed immediately after publication.
        fd, tmp = tempfile.mkstemp(prefix=".operation-", dir=path.parent)
        try:
            with os.fdopen(fd, "wb") as stream:
                os.fchmod(stream.fileno(), 0o600)
                stream.write(blob)
                stream.flush()
                os.fsync(stream.fileno())
            self._check_owner(owner_check)
            try:
                os.link(tmp, path)
            except FileExistsError:
                raise InstallError("Operation receipt already exists; no targets changed") from None
            os.unlink(tmp)
            parent_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(parent_fd)
            finally:
                os.close(parent_fd)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)

    def _observed(self) -> tuple[dict, dict]:
        files = {key: self._old_file(self.path(logical))
                 for key, logical in (("program", PROGRAM), ("unit", UNIT_FILE))}
        return files, self._state()

    @staticmethod
    def _verify_identity(receipt: dict, manifest: dict) -> None:
        if (manifest.get("operation_id") != receipt["operation_id"]
                or manifest["source_release"] != receipt["source_release"]
                or manifest["source_sha256"] != receipt["source_sha256"]):
            raise InstallError("Operation receipt and original snapshot disagree")

    def snapshot_for_operation(self, operation_id: str) -> Path:
        """Resolve only this operation's original snapshot; read-only, no owner grant.

        The official release coordinator must separately establish fresh ownership
        and pass its original guard to rollback(). This resolver intentionally
        does not inspect service state or accept a caller-chosen snapshot path.
        """
        _, receipt = self._load_receipt(operation_id)
        if receipt is None:
            raise InstallError("Original operation receipt is absent")
        snapshot = self.path(STATE_ROOT) / receipt["snapshot"]
        manifest = self._load_snapshot(snapshot)
        self._verify_identity(receipt, manifest)
        return snapshot

    def _verify_receipt(self, receipt: dict, manifest: dict, snapshot: Path,
                        *, allow_applying=False) -> tuple[dict, dict]:
        self._verify_identity(receipt, manifest)
        files, state = self._observed()  # Includes pending-job/unstable-state rejection.
        status = receipt.get("status")
        interrupted = status in ("applying", "restoring")
        if status not in ("prepared", "applied", "restored") and not (allow_applying and interrupted):
            raise RecoveryRequired(snapshot, state)
        # Explicit interrupted recovery may accept old/new owned files below;
        # terminal states still require their exact recorded observations.
        if not interrupted and (files != receipt.get("expected_files")
                                or state != receipt.get("expected_state")):
            raise RecoveryRequired(snapshot, state)
        return files, state

    def _snapshot(self, plan: dict, owner_check: Callable) -> tuple[Path, dict]:
        state_root = self.path(STATE_ROOT)
        self._mkdir(state_root, owner_check)
        self._check_owner(owner_check)
        name = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:12]
        snapshot = state_root / name
        snapshot.mkdir(mode=0o700)
        manifest = {"schema": 1, **plan, "status": "prepared"}
        for key, logical in (("program", PROGRAM), ("unit", UNIT_FILE)):
            old = plan["previous_files"][key]
            if old["exists"]:
                blob = self.path(logical).read_bytes()
                if _sha(blob) != old["sha256"]:
                    raise InstallError("Sampler file changed during snapshot")
                self._write(snapshot / (key + ".previous"), blob, 0o600, owner_check)
        self._manifest(snapshot, manifest, owner_check)
        return snapshot, manifest

    def _mutate(self, args: list[str], owner_check: Callable) -> None:
        self._check_owner(owner_check)
        if args[0] in ("enable", "start", "restart"):
            self._dropins()
            self._state()  # Includes effective fragment/drop-in/dependency validation.
            self._check_owner(owner_check)
        failure = False
        try:
            r = self.runner(args)
        except OwnershipRequired:
            raise
        except Exception:
            failure = True
        if failure or r.returncode:
            # A failed/timeout command may have executed. Observe immediately,
            # including when rollback itself fails; never blindly repeat it.
            try:
                self._state()
            except OwnershipRequired:
                raise
            except InstallError:
                pass
            error = ServiceOperationUnknown if failure else InstallError
            raise error("Sampler service operation failed/uncertain; state checked, output suppressed") from None

    def _load_snapshot(self, snapshot: Path) -> dict:
        snapshot = snapshot.absolute()
        if snapshot.parent != self.path(STATE_ROOT) or not SNAPSHOT_NAME.fullmatch(snapshot.name):
            raise InstallError("Snapshot must be an owned selfhost sampler snapshot")
        self._safe_path(snapshot)
        s = snapshot.lstat()
        if not stat.S_ISDIR(s.st_mode) or s.st_uid != os.geteuid() or s.st_mode & 0o077:
            raise InstallError("Snapshot directory is not private and owned")
        self._regular(snapshot / "manifest.json")
        manifest = json.loads((snapshot / "manifest.json").read_text())
        if manifest.get("schema") != 1 or manifest.get("unit") != UNIT:
            raise InstallError("Unexpected sampler snapshot schema")
        for key in ("program", "unit"):
            old = manifest["previous_files"][key]
            if old["exists"]:
                file = snapshot / (key + ".previous")
                self._regular(file)
                blob = file.read_bytes()
                if len(blob) != old["bytes"] or _sha(blob) != old["sha256"]:
                    raise InstallError("Snapshot backup integrity mismatch")
                if not isinstance(old["mode"], int) or old["mode"] & ~0o777 or old["mode"] & 0o022:
                    raise InstallError("Unexpected backup permissions")
                if key == "unit":
                    self._validate_unit(blob)
        return manifest

    def rollback(self, snapshot: Path, *, owner_check: Callable | None = None,
                 operation_id: str | None = None) -> dict:
        # Deliberate recovery entry only. apply() never resumes in-progress
        # targets. Stable state and exact old/new ownership are verified below.
        return self._restore(snapshot, owner_check=owner_check, operation_id=operation_id,
                             known_failure=True)

    def _restore(self, snapshot: Path, *, owner_check: Callable | None,
                 operation_id: str | None = None, known_failure=False) -> dict:
        self._check_owner(owner_check)
        snapshot = Path(snapshot).absolute()
        manifest = self._load_snapshot(snapshot)
        operation_id = operation_id or manifest.get("operation_id")
        receipt_path, receipt = self._load_receipt(operation_id)
        if receipt is None or receipt["snapshot"] != snapshot.name:
            raise InstallError("Original operation receipt is required for rollback")
        current_files, current_state = self._verify_receipt(
            receipt, manifest, snapshot, allow_applying=known_failure)
        if receipt["status"] == "restored":
            return {"restored": True, "snapshot": str(snapshot),
                    "state": receipt["expected_state"], "operation_id": operation_id,
                    "changed": False, "logs_preserved": True}
        if current_files == manifest["previous_files"] and current_state == manifest["previous_state"]:
            manifest["status"] = "restored"
            self._manifest(snapshot, manifest, owner_check)
            receipt.update(status="restored", expected_files=current_files,
                           expected_state=current_state)
            self._receipt(receipt_path, receipt, owner_check)
            return {"restored": True, "snapshot": str(snapshot), "state": current_state,
                    "operation_id": operation_id, "changed": False, "logs_preserved": True}
        self._dropins()
        for key, logical in (("program", PROGRAM), ("unit", UNIT_FILE)):
            current = self._old_file(self.path(logical))
            old = manifest["previous_files"][key]
            new_owned = (current["exists"]
                         and current["sha256"] == manifest["source_sha256"][key]
                         and current["mode"] == (0o755 if key == "program" else 0o644))
            if current != old and not new_owned:
                raise RecoveryRequired(snapshot, current_state)
        # Observe first: never compete with an unresolved service job or blindly
        # retry the operation that failed. Ownership is checked before writes.
        observed = self._state()
        receipt["status"] = "restoring"
        self._receipt(receipt_path, receipt, owner_check)
        if observed["active"] or observed["load"] == "loaded":
            self._mutate(["stop", UNIT], owner_check)
            if self._state()["active"]:
                raise RecoveryRequired(snapshot, self._state())
        if observed["enabled"]:
            self._mutate(["disable", UNIT], owner_check)
        for key, logical in (("program", PROGRAM), ("unit", UNIT_FILE)):
            target = self.path(logical)
            old = manifest["previous_files"][key]
            if old["exists"]:
                self._write(target, (snapshot / (key + ".previous")).read_bytes(),
                            old["mode"], owner_check)
            else:
                self._check_owner(owner_check)
                self._regular(target, absent_ok=True)
                target.unlink(missing_ok=True)
        self._mutate(["daemon-reload"], owner_check)
        previous = manifest["previous_state"]
        if previous["enabled"]:
            self._mutate(["enable", UNIT], owner_check)
        if previous["active"]:
            self._mutate(["start", UNIT], owner_check)
        files, current = self._observed()
        if files != manifest["previous_files"] or current != previous:
            raise RecoveryRequired(snapshot, current)
        manifest["status"] = "restored"
        self._manifest(snapshot, manifest, owner_check)
        if not manifest["program_directory_existed"]:
            self._check_owner(owner_check)
            try:
                self.path(PROGRAM.parent).rmdir()
            except OSError:
                pass  # Do not remove anything another owner has since created.
        receipt.update(status="restored", expected_files=manifest["previous_files"],
                       expected_state=current)
        self._receipt(receipt_path, receipt, owner_check)
        return {"restored": True, "snapshot": str(snapshot), "state": current,
                "operation_id": operation_id, "logs_preserved": True}

    def apply(self, source_release: Path | None = None, *, owner_check: Callable | None = None,
              operation_id: str | None = None) -> dict:
        self._check_owner(owner_check)
        receipt_path, receipt = self._load_receipt(operation_id)
        source, blobs = self._source(source_release)
        source_hashes = {key: _sha(blob) for key, blob in blobs.items()}
        self._dropins()
        reused = receipt is not None
        if receipt is not None:
            if receipt["source_release"] != str(source) or receipt["source_sha256"] != source_hashes:
                raise InstallError("Operation source changed; original snapshot retained")
            snapshot = self.path(STATE_ROOT) / receipt["snapshot"]
            manifest = self._load_snapshot(snapshot)
            self._verify_receipt(receipt, manifest, snapshot)
            if receipt["status"] == "applied":
                return {"changed": False, "snapshot": str(snapshot),
                        "operation_id": operation_id, "reused_snapshot": True}
            plan = manifest
        else:
            plan = self.plan(source_release)
            if plan["source_sha256"] != source_hashes:
                raise InstallError("Sampler source changed while planning")
            snapshot, manifest = self._snapshot({**plan, "operation_id": operation_id}, owner_check)
            receipt = {"schema": 1, "unit": UNIT, "operation_id": operation_id,
                       "snapshot": snapshot.name, "source_release": str(source),
                       "source_sha256": source_hashes, "status": "prepared",
                       "expected_files": plan["previous_files"],
                       "expected_state": plan["previous_state"]}
            self._receipt(receipt_path, receipt, owner_check, new=True)
        if (all(plan["previous_files"][key].get("sha256") == source_hashes[key]
                and plan["previous_files"][key].get("mode") == mode
                for key, mode in (("program", 0o755), ("unit", 0o644)))
                and plan["previous_state"]["active"] and plan["previous_state"]["enabled"]):
            files, state = self._observed()
            if files != plan["previous_files"] or state != plan["previous_state"]:
                raise RecoveryRequired(snapshot, state)
            manifest["status"] = "applied"
            self._manifest(snapshot, manifest, owner_check)
            receipt.update(status="applied", expected_files=files, expected_state=state)
            self._receipt(receipt_path, receipt, owner_check)
            return {"changed": False, "snapshot": str(snapshot), "state": state,
                    "operation_id": operation_id, "reused_snapshot": reused}
        changes_started = False
        try:
            # Re-observe after the durable snapshot and before touching unit files.
            self._dropins()
            if self._state() != plan["previous_state"]:
                raise InstallError("Sampler state changed during snapshot")
            for key, logical in (("program", PROGRAM), ("unit", UNIT_FILE)):
                if self._old_file(self.path(logical)) != plan["previous_files"][key]:
                    raise InstallError("Sampler file changed during snapshot")
            manifest["status"] = "prepared"
            self._manifest(snapshot, manifest, owner_check)
            receipt["status"] = "applying"
            self._receipt(receipt_path, receipt, owner_check)
            self._mkdir(self.path(PROGRAM.parent), owner_check)
            changes_started = True
            self._write(self.path(PROGRAM), blobs["program"], 0o755, owner_check)
            self._write(self.path(UNIT_FILE), blobs["unit"], 0o644, owner_check)
            self._mutate(["daemon-reload"], owner_check)
            self._mutate(["enable", UNIT], owner_check)
            self._mutate(["restart", UNIT], owner_check)
            files, state = self._observed()
            expected_files = {key: {"exists": True, "sha256": source_hashes[key],
                                    "bytes": len(blobs[key]), "mode": mode}
                              for key, mode in (("program", 0o755), ("unit", 0o644))}
            if files != expected_files:
                # A foreign writer's bytes/mode must never become our accepted
                # baseline or be overwritten by automatic compensation.
                raise RecoveryRequired(snapshot, state)
            if not state["active"] or not state["enabled"] or state["load"] != "loaded":
                raise RecoveryRequired(snapshot, state)
            try:
                final_source, final_blobs = self._source(source_release)
            except OwnershipRequired:
                raise
            except (InstallError, OSError):
                raise RecoveryRequired(snapshot, state) from None
            if final_source != source or any(_sha(final_blobs[k]) != source_hashes[k] for k in blobs):
                raise RecoveryRequired(snapshot, state)
            manifest["status"] = "applied"
            self._manifest(snapshot, manifest, owner_check)
            receipt.update(status="applied", expected_files=files, expected_state=state)
            self._receipt(receipt_path, receipt, owner_check)
            return {"changed": True, "snapshot": str(snapshot), "state": state,
                    "operation_id": operation_id, "reused_snapshot": reused}
        except OwnershipRequired:
            # Owner loss is the coordinator's exit-86 condition. Never wrap it
            # or attempt compensating writes using an expired owner context.
            raise
        except RecoveryRequired:
            raise
        except Exception as error:
            if not changes_started:
                # The snapshot is an audit artifact, not permission to revert
                # state somebody else changed before this operation wrote it.
                raise InstallError("Sampler preparation stopped before target changes; snapshot=" + str(snapshot)) from error
            try:
                observed = self._state()  # First check any uncertain outcome.
                if isinstance(error, ServiceOperationUnknown):
                    raise error
                self._check_owner(owner_check)
                self._restore(snapshot, owner_check=owner_check,
                              operation_id=operation_id, known_failure=True)
            except OwnershipRequired:
                raise
            except Exception:
                raise RecoveryRequired(snapshot, locals().get("observed")) from error
            raise InstallError("Sampler installation failed; previous files/state restored; snapshot=" + str(snapshot)) from error


def main(argv: list[str] | None = None, *, installer: Installer | None = None,
         owner_check: Callable | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--apply", action="store_true")
    action.add_argument("--rollback", type=Path, metavar="SNAPSHOT")
    parser.add_argument("--source-release", type=Path)
    parser.add_argument("--operation-id", help="tr-* identity only; never grants ownership")
    args = parser.parse_args(argv)
    installer = installer or Installer()
    try:
        if args.apply:
            result = installer.apply(args.source_release, owner_check=owner_check,
                                     operation_id=args.operation_id)
        elif args.rollback:
            result = installer.rollback(args.rollback, owner_check=owner_check,
                                        operation_id=args.operation_id)
        else:
            result = {"dry_run": True, **installer.plan(args.source_release)}
        print(json.dumps(result, sort_keys=True))
        return 0
    except OwnershipRequired:
        raise  # Preserve the owner's distinct loss signal for the release bridge.
    except (InstallError, OSError, ValueError, KeyError) as error:
        # No source bytes, unit content or service command output reaches logs.
        message = str(error) if isinstance(error, InstallError) else "Installer input/filesystem validation failed"
        print(json.dumps({"error": type(error).__name__, "message": message}))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
