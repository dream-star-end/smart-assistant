#!/usr/bin/env python3
"""plugin-exec — 平台启动器：运行随基线下发的「本机插件」命令（OCV5-383，plugin.json openclaude-plugin/1）。

用法（由各插件命令的 2 行 shim 调用，不直接给 Agent 用）：
    plugin-exec <插件名> <命令名> [参数...]

步骤：
  1. 读 /run/oc/claude-config/skills/<插件名>/plugin.json（只读挂载），找 components.bin 里同名命令；
     entry 只允许插件目录内 scripts/ 下的相对路径，realpath 不得逃出插件目录；解释器只允许 python3。
  2. 问 master 这个插件是否已在「管理中心 → 插件」停用（POST /v3/plugins/state，容器身份 bearer，3 秒超时，
     结果缓存 15 秒）。停用 → stderr 一行 JSON 错误、退出码 3；查询失败 → 按启用处理（开关是偏好，不是安全边界，
     网络抖动不能让插件不可用）。
  3. exec python3 -I <entry> 参数...（-I：不加载用户 site-packages / PYTHON* 环境，插件只用标准库）。
     Agent 的 shell 带着平台给 Claude Code 设的 HTTPS_PROXY（海外出口）。插件在 permissions.network 里声明的
     来源加进 NO_PROXY，直接从容器出网：国内行情站经海外出口常被断开（OCV5-383 上线验收：经代理 0/10，直连 10/10）。
     其余地址照旧走代理；查启用状态是平台内部调用，从不走代理。
"""
import json
import os
import re
import shutil
import sys
import time
import urllib.parse
import urllib.request

SKILLS_ROOT = os.environ.get("OC_PLUGIN_SKILLS_ROOT", "/run/oc/claude-config/skills")
NAME_RE = re.compile(r"^[a-z][a-z0-9-]{1,63}$")
BIN_RE = re.compile(r"^[a-z][a-z0-9-]{0,31}$")
ENTRY_RE = re.compile(r"^scripts/(?!.*(?:^|/)\.\.(?:/|$))[A-Za-z0-9._/-]+$")
INTERPRETERS = {"python3"}
STATE_TTL = 15
EXIT_DISABLED = 3
EXIT_BROKEN = 2


def die(code, message):
    sys.stderr.write(json.dumps({"error": message}, ensure_ascii=False) + "\n")
    sys.exit(code)


def load_bin(plugin, name):
    if not NAME_RE.match(plugin) or not BIN_RE.match(name):
        die(EXIT_BROKEN, f"plugin-exec: 非法的插件或命令名 {plugin!r} {name!r}")
    root = os.path.join(SKILLS_ROOT, plugin)
    try:
        with open(os.path.join(root, "plugin.json"), encoding="utf-8") as f:
            manifest = json.load(f)
    except (OSError, ValueError) as e:
        die(EXIT_BROKEN, f"插件「{plugin}」的 plugin.json 读不到或不是合法 JSON（{type(e).__name__}），请联系管理员")
    if manifest.get("schema") != "openclaude-plugin/1" or manifest.get("name") != plugin:
        die(EXIT_BROKEN, f"插件「{plugin}」的 plugin.json 不是 openclaude-plugin/1 或名字不符")
    for b in (manifest.get("components") or {}).get("bin") or []:
        if isinstance(b, dict) and b.get("name") == name:
            entry, interp = b.get("entry"), b.get("interpreter")
            if not isinstance(entry, str) or not ENTRY_RE.match(entry) or interp not in INTERPRETERS:
                die(EXIT_BROKEN, f"插件「{plugin}」的命令 {name} 声明不合法（entry 须在 scripts/ 下，解释器只支持 python3）")
            real_root = os.path.realpath(root)
            path = os.path.realpath(os.path.join(root, entry))
            if not path.startswith(real_root + os.sep) or not os.path.isfile(path):
                die(EXIT_BROKEN, f"插件「{plugin}」的命令 {name} 指向的文件不存在或在插件目录外")
            return manifest, path, interp
    die(EXIT_BROKEN, f"插件「{plugin}」没有声明命令 {name}")


HOST_RE = re.compile(r"^[a-z0-9.-]{1,253}$")
PROXY_KEYS = ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy")


def direct_hosts(manifest):
    """plugin.json permissions.network 里声明的来源 → 主机名（校验器已保证是 http(s) 来源，这里再过一遍）。"""
    hosts = []
    for origin in (manifest.get("permissions") or {}).get("network") or []:
        if not isinstance(origin, str):
            continue
        u = urllib.parse.urlsplit(origin)
        host = (u.hostname or "").lower()
        if u.scheme in ("http", "https") and HOST_RE.match(host) and host not in hosts:
            hosts.append(host)
    return hosts


def child_env(manifest, environ=None):
    """插件进程的环境：设了代理时，把插件声明的主机并进 NO_PROXY / no_proxy（保留原有项）。"""
    env = dict(os.environ if environ is None else environ)
    hosts = direct_hosts(manifest)
    if not hosts or not any(env.get(k) for k in PROXY_KEYS):
        return env
    current = [h.strip() for h in (env.get("NO_PROXY") or env.get("no_proxy") or "").split(",") if h.strip()]
    merged = ",".join(current + [h for h in hosts if h not in current])
    env["NO_PROXY"] = env["no_proxy"] = merged
    return env


def endpoint():
    base = (os.environ.get("OPENCLAUDE_V3_MASTER_BASE_URL") or "").strip()
    tok = (os.environ.get("OPENCLAUDE_V3_CONTAINER_TOKEN") or "").strip()
    if not tok and os.environ.get("OPENCLAUDE_V3_CONTAINER_TOKEN_FILE"):
        try:
            with open(os.environ["OPENCLAUDE_V3_CONTAINER_TOKEN_FILE"].strip(), encoding="utf-8") as f:
                tok = f.read().strip()
        except OSError:
            tok = ""
    if base and tok:
        return base.rstrip("/"), tok
    # 与 gateway ocConnectorsClient 同一回退：entrypoint 成对写入的 container-auth.json（两个字段同一来源）。
    home = (os.environ.get("OPENCLAUDE_HOME") or "").strip() or os.path.join(os.path.expanduser("~"), ".openclaude")
    try:
        with open(os.path.join(home, "container-auth.json"), encoding="utf-8") as f:
            d = json.load(f)
        b, t = str(d.get("masterBaseUrl") or "").strip(), str(d.get("containerToken") or "").strip()
        if b and t:
            return b.rstrip("/"), t
    except (OSError, ValueError):
        pass
    return None


def cache_path(plugin):
    return os.path.join(os.path.expanduser("~"), ".cache", "oc-plugins", f"state-{plugin}.json")


def enabled(plugin):
    """True / False；查不到返回 None（调用方按启用处理）。"""
    cp = cache_path(plugin)
    try:
        with open(cp, encoding="utf-8") as f:
            c = json.load(f)
        if time.time() - float(c.get("ts", 0)) < STATE_TTL and isinstance(c.get("enabled"), bool):
            return c["enabled"]
    except (OSError, ValueError, TypeError):
        pass
    ep = endpoint()
    if not ep:
        return None
    base, tok = ep
    req = urllib.request.Request(
        f"{base}/v3/plugins/state",
        data=json.dumps({"slug": plugin}).encode(),
        headers={"Authorization": f"Bearer {tok}", "content-type": "application/json"},
        method="POST",
    )
    try:
        # 平台内部调用：不经 Agent 环境里的任何代理。
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=3) as resp:
            body = json.loads(resp.read().decode("utf-8") or "{}")
    except Exception:  # noqa: BLE001 —— 任何失败都按启用处理
        return None
    if body.get("kind") != "state" or not isinstance(body.get("enabled"), bool):
        return None
    try:
        os.makedirs(os.path.dirname(cp), exist_ok=True)
        with open(cp, "w", encoding="utf-8") as f:
            json.dump({"ts": time.time(), "enabled": body["enabled"]}, f)
    except OSError:
        pass
    return body["enabled"]


def main(argv):
    if len(argv) < 2:
        die(EXIT_BROKEN, "用法：plugin-exec <插件名> <命令名> [参数...]")
    plugin, name, args = argv[0], argv[1], argv[2:]
    manifest, path, interp = load_bin(plugin, name)
    help_only = bool(args) and all(a in ("-h", "--help") for a in args)
    if not help_only:
        state = enabled(plugin)
        if state is False:
            label = manifest.get("displayName") or plugin
            die(EXIT_DISABLED, f"插件「{label}」已停用，请在 管理中心 → 插件 里打开后再用")
    exe = shutil.which(interp)
    if not exe:
        die(EXIT_BROKEN, f"容器里没有 {interp}，插件「{plugin}」无法运行")
    os.execve(exe, [exe, "-I", path, *args], child_env(manifest))


if __name__ == "__main__":
    main(sys.argv[1:])
