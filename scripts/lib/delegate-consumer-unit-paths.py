#!/usr/bin/env python3
"""Conservative systemd path projection, not startup authorization.

The caller supplies ordered actual fragment/drop-in and EnvironmentFile texts
after binding root-owned file identities. This parser cannot discover drop-ins,
prove the effective live unit, or authorize exec. Unsupported syntax is unknown.
Only path keys are returned; secrets and arbitrary environment are not retained.
"""
from pathlib import Path
import re
import shlex

MAX_TEXT = 1024 * 1024
PATH_KEYS = {"HOME", "OPENCLAUDE_HOME", "OPENCLAUDE_DELEGATE_JOBS_DB"}
ENTRYPOINTS = {
    ("/usr/bin/npx", "tsx", "packages/cli/src/index.ts", "gateway"),
    ("/usr/bin/npx", "tsx", "packages/commercial/src/egress/main.ts"),
    ("/usr/bin/node", "--import", "tsx", "packages/commercial/src/egress/main.ts"),
}
# These can alter the actual path/user/environment outside this small parser.
UNSUPPORTED = {"RootDirectory", "RootImage", "BindPaths", "BindReadOnlyPaths",
               "TemporaryFileSystem", "DynamicUser", "PAMName", "PassEnvironment",
               "UnsetEnvironment", "SetLoginEnvironment", "EnvironmentDirectory",
               "ProtectHome", "PrivateTmp", "MountImages", "ExtensionImages",
               "ExtensionDirectories"}


class Unknown(Exception):
    pass


def require(condition):
    if not condition:
        raise Unknown("unverifiable_unit_paths")


def path(value):
    require(isinstance(value, str) and value and not any(c in value for c in "\x00\r\n%\\"))
    p = Path(value)
    require(p.is_absolute() and ".." not in p.parts and str(p) == value)
    return p


def text_lines(text):
    require(isinstance(text, str) and len(text.encode()) <= MAX_TEXT and "\x00" not in text)
    return text.splitlines()


def words(value):
    # The supported systemd subset needs no C escapes or line continuations.
    # shlex is not a general systemd parser: refuse those forms rather than
    # silently interpreting them as shell syntax.
    require("\\" not in value)
    try:
        return shlex.split(value, comments=False, posix=True)
    except ValueError:
        raise Unknown("unverifiable_unit_paths") from None


def parse_unit(fragments):
    require(isinstance(fragments, list) and 0 < len(fragments) <= 128)
    env, files, scalars, commands = {}, [], {}, []
    for text in fragments:
        section = None
        for raw in text_lines(text):
            line = raw.strip()
            if not line or line.startswith(("#", ";")):
                continue
            require(not line.endswith("\\"))
            if line.startswith("["):
                require(line.endswith("]")); section = line[1:-1]
                continue
            if section != "Service":
                continue
            require("=" in line)
            key, value = (s.strip() for s in line.split("=", 1))
            if key in UNSUPPORTED:
                require(not value)
            elif key in {"User", "Group", "WorkingDirectory", "Type"}:
                scalars[key] = value
            elif key == "Environment":
                if not value:
                    env.clear()
                for entry in words(value):
                    require("=" in entry)
                    name, val = entry.split("=", 1)
                    require(re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name))
                    if name in PATH_KEYS:
                        require("%" not in val)
                        env[name] = val
            elif key == "EnvironmentFile":
                if not value:
                    files.clear()
                    continue
                entries = words(value)
                require(len(entries) == 1)
                entry = entries[0]
                optional = entry.startswith("-")
                filename = entry[1:] if optional else entry
                path(filename)
                require(not any(c in filename for c in "*?[]"))
                files.append({"path": filename, "optional": optional})
            elif key == "ExecStart":
                if not value:
                    commands.clear()
                else:
                    command = tuple(words(value))
                    require(command in ENTRYPOINTS)
                    commands.append(command)
    require(scalars.get("User") == "root" and scalars.get("Group", "root") == "root")
    require(scalars.get("Type", "simple") == "simple" and len(commands) == 1)
    cwd = str(path(scalars.get("WorkingDirectory")))
    return {"environment": env, "environmentFiles": files, "workingDirectory": cwd,
            "argv": list(commands[0]), "user": "root"}


def parse_environment_file(text):
    result = {}
    for raw in text_lines(text):
        line = raw.strip()
        if not line or line.startswith(("#", ";")):
            continue
        # An unsupported continuation on ANY key could hide a following path
        # assignment inside a multiline secret. Never ignore that ambiguity.
        require(not line.endswith("\\") and "=" in line)
        name, value = line.split("=", 1)
        name = name.strip(); value = value.strip()
        require(re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name))
        require("\\" not in value)
        # Validate quote balance on ignored keys too, without returning secrets.
        if value.startswith(('"', "'")):
            quote = value[0]
            require(len(value) >= 2 and value.endswith(quote) and quote not in value[1:-1])
            value = value[1:-1]
        else:
            require('"' not in value and "'" not in value)
        if name in PATH_KEYS:
            require(name not in result)  # Duplicate same-file keys are ambiguous.
            result[name] = value
    return result


def resolve_unit_paths(plan, environment_files, passwd_home):
    """All files are actual contents (None only for proven missing optional file).

    EnvironmentFile overrides Environment regardless of textual order, and
    later files override earlier files. passwd_home is the looked-up root passwd
    entry supplied by the trusted caller, NEVER this process's HOME/default.
    """
    require(isinstance(environment_files, dict))
    env = dict(plan["environment"])
    for item in plan["environmentFiles"]:
        require(item["path"] in environment_files)
        text = environment_files[item["path"]]
        if text is None:
            require(item["optional"])
        else:
            env.update(parse_environment_file(text))
    root_home = str(path(passwd_home))
    override = env.get("OPENCLAUDE_DELEGATE_JOBS_DB", "").strip()
    home = env.get("OPENCLAUDE_HOME", "").strip()
    if override:
        database = path(override)
    else:
        # node:os.homedir() uses HOME when set; an empty HOME is not guessed.
        database = (path(home) if home else path(env.get("HOME", root_home)) / '.openclaude') / 'delegate-jobs.db'
    return {"database": str(database), "pathEnvironment": env,
            "workingDirectory": plan["workingDirectory"], "argv": plan["argv"]}
