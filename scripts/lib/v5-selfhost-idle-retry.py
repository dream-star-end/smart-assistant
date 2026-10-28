#!/usr/bin/env python3
"""Trusted local receipt for an unexposed, fully built selfhost candidate.

The deploy lock serializes callers. This only validates identities/marker hashes;
the caller must still verify artifact contents and run the ordinary cutover gates.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile


def require(condition, message):
    if not condition:
        raise ValueError(message)


def trusted(path, directory=False):
    p = Path(path)
    require(p.is_absolute() and str(p.resolve(strict=True)) == str(p), "noncanonical path")
    s = p.lstat()
    require((stat.S_ISDIR if directory else stat.S_ISREG)(s.st_mode), "unsafe type")
    require(s.st_uid == 0 and s.st_gid == 0 and not s.st_mode & 0o022, "unsafe ownership/mode")
    return p


def marker(path):
    raw = trusted(path).read_bytes()
    return json.loads(raw), hashlib.sha256(raw).hexdigest()


def artifacts(doc, roots):
    for key, root, pattern, name in zip(
        ("master", "runtime", "bundle"), roots,
        (r"rel-[A-Za-z0-9._-]+", r"rel-[a-f0-9]{12}", r"[a-f0-9]{12}"),
        (".complete", "MANIFEST.json", "MANIFEST.json"),
    ):
        p = Path(doc[key])
        require(p.parent == trusted(root, True) and re.fullmatch(pattern, p.name), "outside artifact root")
        trusted(p, True)
        j, digest = marker(p / name)
        require(doc[key + "Marker"] == digest, "artifact marker changed")
        if key == "master":
            require(j["sourceCommit"] == doc["sha"], "source mismatch")
            require(not p.name.endswith(".poisoned") and not os.path.lexists(p / ".poisoned") and not os.path.lexists(str(p) + ".poisoned"), "poisoned")
        else:
            require(p.name == ("rel-" if key == "runtime" else "") + j["digest"], "digest name mismatch")


def main():
    action, master_root, runtime_root, bundles_root, *args = sys.argv[1:]
    roots = (master_root, runtime_root, bundles_root)
    receipt = trusted(master_root, True) / ".idle-retry.json"
    if action == "clear":
        receipt.unlink(missing_ok=True)
        return
    if action == "save":
        sha, master, runtime, bundle, image, image_id = args
        doc = dict(schema=1, sha=sha, master=master, runtime=runtime, bundle=bundle,
                   image=image, imageId=image_id)
        for key, name in (("master", ".complete"), ("runtime", "MANIFEST.json"), ("bundle", "MANIFEST.json")):
            doc[key + "Marker"] = marker(Path(doc[key]) / name)[1]
    else:
        doc = json.loads(trusted(receipt).read_text())
    require(doc["schema"] == 1 and re.fullmatch(r"[a-f0-9]{40}", doc["sha"]), "invalid receipt")
    require(re.fullmatch(r"[A-Za-z0-9._:/-]+", doc["image"]), "invalid image tag")
    require(re.fullmatch(r"sha256:[a-f0-9]{64}", doc["imageId"]), "invalid image ID")
    artifacts(doc, roots)
    if action == "save":
        fd, tmp = tempfile.mkstemp(prefix=".idle-retry-", dir=master_root)
        try:
            with os.fdopen(fd, "w") as f:
                json.dump(doc, f)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, receipt)
            dfd = os.open(master_root, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(dfd)
            finally:
                os.close(dfd)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)
    elif action == "load":
        require(len(args) == 1 and doc["sha"] == args[0], "different candidate SHA")
        print("\t".join(doc[k] for k in ("master", "runtime", "bundle", "image", "imageId")))
    elif action == "protect":
        print(doc["master"])
    else:
        raise ValueError("unknown action")


if __name__ == "__main__":
    try:
        main()
    except (AssertionError, KeyError, TypeError, ValueError, OSError):
        print("idle retry receipt unavailable or invalid", file=sys.stderr)
        sys.exit(1)
