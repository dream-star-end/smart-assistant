#!/usr/bin/env python3
"""OpenClaude 个人版 egress 节点看门狗(本机 sing-box :18991 的主备 selector)。

移植自商业版 watchdog(claude-egress-watchdog.py),整段复用状态机,参数化到个人版:
  - 被守护:openclaude-egress.service(本机 sing-box,单一出海代理)
  - selector:proxy(成员 = node-a 主 / node-b 备,由 gateway egressSubscription.ts 生成)
  - clash_api:127.0.0.1:19096(external_controller + secret 从 SINGBOX_CONF 读,避开商业版 19095)
  - 告警:**个人版无 PG**,不走 outbox/inbox。alert() 直 curl 企业微信机器人 webhook
    (qyapi 国内直连,--noproxy '*' 不经 18991 —— 代理挂了正是要报警时)。webhook 从 env 读。

干啥(与商业版一致):
  - 每 10s 经 clash_api 对 selector 各成员做一次真实出站 delay 探测(非本地端口探活)
  - 当前选中(now)成员连续 3 次失败 → 另一成员健康则 PUT selector 无重启切换
  - 节点挂/恢复、自动切换、外部切换、全成员挂、sing-box 失联 → 企微告警
  - 恢复滞回(连 3 次成功才判恢复)+ 震荡静默(30min 内翻转 ≥3 次 → 静默,稳定后收尾)

与商业版的差异(参数化):
  - NODES:动态从 selector.all 读(个人版可能 1 或 2 成员;单成员则无冗余,挂即 all_down)
  - label():从 meta 文件读节点人类可读名(node-a=name / node-b=backup_name)
  - alert():企微机器人 webhook 直发(替换商业版 psql fan-out + inbox 双写)

运行:systemd openclaude-personal-egress-watchdog.service(Restart=always;OnFailure 自监)
日志:/var/log/openclaude-personal-egress-watchdog.log
状态:/var/lib/openclaude-egress/watchdog-state.json(跨重启保持,避免重复告警)
"""

import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

SINGBOX_CONF = os.environ.get("EGW_SINGBOX_CONF", "/etc/sing-box/openclaude-egress-proxy.json")
META_FILE = os.environ.get("EGW_META_FILE", "/etc/sing-box/openclaude-egress-proxy.meta")
SELECTOR = os.environ.get("EGW_SELECTOR", "proxy")
DIRECT_TAG = "direct"
SERVICE = os.environ.get("EGW_SERVICE", "openclaude-egress.service")
HOST = os.environ.get("EGW_HOST") or socket.gethostname()
CURL = os.environ.get("EGW_CURL", "/usr/bin/curl")

INTERVAL = int(os.environ.get("EGW_INTERVAL", "10"))
FAIL_THRESHOLD = int(os.environ.get("EGW_FAIL_THRESHOLD", "3"))
RECOVER_THRESHOLD = int(os.environ.get("EGW_RECOVER_THRESHOLD", "3"))  # 恢复滞回:连续 N 次成功才判恢复
FLAP_WINDOW = int(os.environ.get("EGW_FLAP_WINDOW", str(30 * 60)))     # 震荡观察窗口:30min
FLAP_COUNT = int(os.environ.get("EGW_FLAP_COUNT", "3"))                # 窗口内翻转 ≥N → 震荡静默
PROBE_TIMEOUT_MS = int(os.environ.get("EGW_PROBE_TIMEOUT_MS", "8000"))
PROBE_URL = os.environ.get("EGW_PROBE_URL", "https://cp.cloudflare.com/generate_204")

STATE_FILE = os.environ.get("EGW_STATE_FILE", "/var/lib/openclaude-egress/watchdog-state.json")
LOG_FILE = os.environ.get("EGW_LOG_FILE", "/var/log/openclaude-personal-egress-watchdog.log")

REALERT_NODE_DOWN = int(os.environ.get("EGW_REALERT_NODE_DOWN", str(6 * 3600)))   # 单成员持续挂:6h
REALERT_CRITICAL = int(os.environ.get("EGW_REALERT_CRITICAL", str(30 * 60)))      # 全挂/失联:30min

CST = timezone(timedelta(hours=8))

# clash_api 走本机回环,强制不经任何代理(代理挂了正是要探测/切换时)
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def ts() -> str:
    return datetime.now(CST).strftime("%F %T")


def log(msg: str) -> None:
    line = f"{ts()} {msg}"
    print(line, flush=True)
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass


# clash_api 端点每 tick 从 config 现读(secret sticky,但迁移前 config 可能还没 clash_api;
# 现读可平滑等待 gateway 首次 selector 迁移,不崩溃循环、不误报)
_CLASH = {"base": None, "secret": ""}


def clash_endpoint():
    """从 SINGBOX_CONF 读 clash_api 端点。缺失(迁移前)返回 (None, '')。"""
    try:
        cfg = json.load(open(SINGBOX_CONF, encoding="utf-8"))
        api = cfg["experimental"]["clash_api"]
        return "http://" + api["external_controller"], api.get("secret", "")
    except (OSError, ValueError, KeyError, TypeError):
        return None, ""


def clash_request(method: str, path: str, body=None, timeout=15):
    base = _CLASH["base"]
    if not base:
        raise RuntimeError("clash_api endpoint not available (config lacks experimental.clash_api)")
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method)
    if _CLASH["secret"]:
        req.add_header("Authorization", f"Bearer {_CLASH['secret']}")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    with OPENER.open(req, timeout=timeout) as resp:
        raw = resp.read()
        return resp.status, (json.loads(raw) if raw else {})


def get_selector():
    """返回 (now, members, err)。members = selector 候选成员(去掉 direct)。失败 now=None。"""
    try:
        status, data = clash_request("GET", f"/proxies/{urllib.parse.quote(SELECTOR)}")
        if status == 200:
            now = data.get("now")
            members = [m for m in (data.get("all") or []) if isinstance(m, str) and m != DIRECT_TAG]
            if now in members:
                return now, members, ""
            return None, members, f"HTTP {status} now={now!r} not in {members}"
        return None, [], f"HTTP {status}"
    except Exception as e:  # noqa: BLE001 — 失联本身就是要监控的状态
        return None, [], str(e)


def probe(tag: str):
    """经指定成员真实出站探测。返回 (ok, 描述)。"""
    q = urllib.parse.urlencode({"timeout": PROBE_TIMEOUT_MS, "url": PROBE_URL})
    try:
        status, data = clash_request(
            "GET", f"/proxies/{urllib.parse.quote(tag)}/delay?{q}",
            timeout=PROBE_TIMEOUT_MS / 1000 + 5,
        )
        if status == 200 and isinstance(data.get("delay"), int):
            return True, f"{data['delay']}ms"
        return False, f"HTTP {status} {data}"
    except urllib.error.HTTPError as e:
        return False, f"HTTP {e.code} (探测失败/超时)"
    except Exception as e:  # noqa: BLE001
        return False, str(e)


def switch_to(tag: str) -> bool:
    try:
        status, _ = clash_request("PUT", f"/proxies/{urllib.parse.quote(SELECTOR)}", body={"name": tag})
        return status in (200, 204)
    except Exception as e:  # noqa: BLE001
        log(f"SWITCH-FAIL PUT selector→{tag}: {e}")
        return False


def read_meta() -> dict:
    meta = {}
    try:
        for line in open(META_FILE, encoding="utf-8"):
            i = line.find("=")
            if i > 0:
                meta[line[:i]] = line[i + 1:].strip()
    except OSError:
        pass
    return meta


def label(tag: str) -> str:
    """node-a/node-b 稳定 tag → 人类可读名(从 meta 文件读),读不到就用 tag。"""
    meta = read_meta()
    if tag == "node-a" and meta.get("name"):
        return f"{meta['name']}(主/node-a)"
    if tag == "node-b" and meta.get("backup_name"):
        return f"{meta['backup_name']}(备/node-b)"
    return tag


def wecom_webhook_url() -> str:
    """企微机器人 webhook:整 URL(EGW_WECOM_WEBHOOK)> key(EGW_WECOM_KEY)> key 文件(EGW_WECOM_KEY_FILE)。"""
    url = os.environ.get("EGW_WECOM_WEBHOOK", "").strip()
    if url:
        return url
    key = os.environ.get("EGW_WECOM_KEY", "").strip()
    if not key:
        kf = os.environ.get("EGW_WECOM_KEY_FILE", "").strip()
        if kf:
            try:
                key = Path(kf).read_text(encoding="utf-8").strip()
            except OSError:
                key = ""
    if key:
        return f"https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key={key}"
    return ""


def alert(event_type: str, severity: str, title: str, body: str) -> None:
    """个人版告警:直发企业微信机器人(markdown)。任何失败只记日志,绝不抛。"""
    log(f"ALERT [{severity}] {event_type}: {title}")
    url = wecom_webhook_url()
    content = (
        f"**{title}**\n\n{body}\n\n"
        f"> {ts()} 北京时间 · host={HOST} · severity={severity}\n"
        f"> 详见 {LOG_FILE}"
    )[:4000]
    if not url:
        log("ALERT-FAIL 未配置企微 webhook(EGW_WECOM_WEBHOOK / EGW_WECOM_KEY / EGW_WECOM_KEY_FILE),告警只落本地日志")
        return
    payload = json.dumps({"msgtype": "markdown", "markdown": {"content": content}}, ensure_ascii=False)
    try:
        # --noproxy '*':qyapi 国内直连,绝不经 18991(代理挂时告警仍要能发出去)
        r = subprocess.run(
            [CURL, "-sS", "--noproxy", "*", "--max-time", "15",
             "-H", "Content-Type: application/json", "--data-binary", payload, url],
            capture_output=True, text=True, timeout=25,
        )
        ok = r.returncode == 0 and '"errcode":0' in (r.stdout or "")
        log("WECOM-OK" if ok else f"WECOM-FAIL rc={r.returncode} out={r.stdout.strip()[:200]} err={r.stderr.strip()[:120]}")
    except Exception as e:  # noqa: BLE001
        log(f"WECOM-FAIL {e}")
    # TODO(块C,可选):个人版如需在站内留痕,可在此加一路 POST 到 gateway 内部回调登记(当前无此需求)。


def load_state() -> dict:
    try:
        return json.load(open(STATE_FILE, encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def save_state(state: dict) -> None:
    tmp = STATE_FILE + ".tmp"
    try:
        os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(state, f, ensure_ascii=False, indent=1)
        os.replace(tmp, STATE_FILE)
    except OSError as e:
        log(f"STATE-SAVE-FAIL {e}")


def systemctl_status() -> str:
    try:
        r = subprocess.run(["systemctl", "is-active", SERVICE],
                           capture_output=True, text=True, timeout=10)
        return r.stdout.strip() or r.stderr.strip()
    except Exception as e:  # noqa: BLE001
        return str(e)


def ensure_node_state(nodes: dict, tag: str) -> dict:
    st = nodes.setdefault(tag, {})
    st.setdefault("state", "unknown")
    st.setdefault("fails", 0)
    st.setdefault("succs", 0)
    st.setdefault("last_alert", 0)
    st.setdefault("flips", [])
    st.setdefault("flapping", False)
    return st


def note_flip(st: dict, tag: str, now: int, selected: str) -> bool:
    """记录一次 up/down 状态翻转,维护震荡静默;返回本次翻转的告警是否应外发。"""
    st["flips"] = [t for t in st["flips"] if now - t < FLAP_WINDOW]
    st["flips"].append(now)
    if st["flapping"]:
        return False
    if len(st["flips"]) >= FLAP_COUNT:
        st["flapping"] = True
        alert("ops.egress_node_flapping", "warning",
              f"[个人版 egress] 节点频繁震荡,告警进入静默:{label(tag)}",
              f"⚠️ 节点 {label(tag)} 在 {FLAP_WINDOW // 60} 分钟内状态翻转 {len(st['flips'])} 次"
              f"(时好时坏)。该节点的挂/恢复告警进入静默,只记本地日志;"
              f"稳定满 {FLAP_WINDOW // 60} 分钟后会发送收尾通知。\n"
              f"当前主用:{label(selected)};主用故障时的自动切换与切换告警不受静默影响。")
        return False
    return True


def main() -> None:
    state = load_state()
    state.setdefault("nodes", {})
    state.setdefault("api", {"state": "unknown", "fails": 0, "last_alert": 0, "ever_up": False})
    state["api"].setdefault("ever_up", False)
    state.setdefault("all_down", {"active": False, "last_alert": 0})
    state.setdefault("last_selected", None)

    log(f"WATCHDOG-START host={HOST} service={SERVICE} conf={SINGBOX_CONF} "
        f"interval={INTERVAL}s threshold={FAIL_THRESHOLD} recover={RECOVER_THRESHOLD} "
        f"flap={FLAP_COUNT}/{FLAP_WINDOW}s probe={PROBE_URL} timeout={PROBE_TIMEOUT_MS}ms")

    pool = ThreadPoolExecutor(max_workers=4)
    while True:
        loop_start = time.time()
        try:
            tick(state, pool)
        except Exception as e:  # noqa: BLE001 — 单轮异常不允许弄死守护进程
            log(f"TICK-ERROR {type(e).__name__}: {e}")
        save_state(state)
        time.sleep(max(1.0, INTERVAL - (time.time() - loop_start)))


def tick(state: dict, pool: ThreadPoolExecutor) -> None:
    now = int(time.time())
    api = state["api"]
    nodes = state["nodes"]

    # ── 端点现读:迁移前 config 尚无 clash_api → 平滑等待,不误报不崩溃 ──
    base, secret = clash_endpoint()
    _CLASH["base"], _CLASH["secret"] = base, secret
    if base is None and not api.get("ever_up"):
        log("WAIT selector 未就绪(config 无 experimental.clash_api),等待首次迁移...")
        return

    # ── 0) sing-box / clash_api 可达性 + selector 成员发现 ──
    selected, members, api_err = get_selector()
    if selected is None:
        api["fails"] += 1
        log(f"API-FAIL #{api['fails']} {api_err}")
        if api["fails"] >= FAIL_THRESHOLD and api["state"] != "down":
            api["state"] = "down"
            api["last_alert"] = now
            alert("ops.egress_singbox_unreachable", "critical",
                  "[个人版 egress] sing-box 代理失联,出海可能全断",
                  f"🚨 watchdog 连续 {api['fails']} 次连不上 sing-box clash_api({base})。\n"
                  f"`systemctl is-active {SERVICE}` = **{systemctl_status()}**\n"
                  "本机全部出海经此代理,请立即处理:\n"
                  f"```\njournalctl -u {SERVICE} -n 50 --no-pager\n```")
        elif api["state"] == "down" and now - api["last_alert"] >= REALERT_CRITICAL:
            api["last_alert"] = now
            alert("ops.egress_singbox_unreachable", "critical",
                  "[个人版 egress] sing-box 仍失联(持续提醒)",
                  f"🚨 sing-box clash_api 持续不可达,服务状态 = {systemctl_status()}。")
        return
    if api["state"] == "down":
        alert("ops.egress_singbox_recovered", "warning",
              "[个人版 egress] sing-box 已恢复可达",
              f"✅ clash_api 恢复,当前选中节点:{label(selected)}。")
    api["state"], api["fails"], api["ever_up"] = "up", 0, True

    if not members:
        log("NO-MEMBERS selector 无候选成员,跳过本轮探测")
        return

    # 动态初始化成员状态(个人版成员随配置 regen 可能 1↔2 变化)
    for tag in members:
        ensure_node_state(nodes, tag)

    # ── 1) 外部切换检测(非本 watchdog 发起的选中变化) ──
    last_sel = state.get("last_selected")
    if last_sel and last_sel in members and selected != last_sel:
        alert("ops.egress_switch_external", "warning",
              "[个人版 egress] 检测到外部切换代理节点",
              f"节点由 {label(last_sel)} 变为 **{label(selected)}**(非 watchdog 发起,可能是前端/人工操作)。")
    state["last_selected"] = selected

    # ── 2) 成员并行探测 ──
    results = dict(zip(members, pool.map(probe, members)))
    for tag in members:
        ok, detail = results[tag]
        st = nodes[tag]
        role = "主用" if tag == selected else "备用"

        # 震荡静默收尾:窗口内不再有翻转(已稳定 FLAP_WINDOW)→ 解除静默并通报
        st["flips"] = [t for t in st["flips"] if now - t < FLAP_WINDOW]
        if st["flapping"] and not st["flips"]:
            st["flapping"] = False
            alert("ops.egress_node_flap_end", "warning",
                  f"[个人版 egress] 节点震荡结束:{label(tag)}",
                  f"节点 {label(tag)} 已稳定 {FLAP_WINDOW // 60} 分钟,"
                  f"当前状态:{'✅ 正常' if st['state'] == 'up' else '🚨 不可用'}。"
                  f"当前主用:{label(selected)}。")

        if ok:
            st["fails"] = 0
            if st["state"] == "down":
                st["succs"] += 1
                if st["succs"] >= RECOVER_THRESHOLD:
                    st["state"], st["succs"] = "up", 0
                    if note_flip(st, tag, now, selected):
                        alert("ops.egress_node_recovered", "warning",
                              f"[个人版 egress] {role}节点已恢复:{label(tag)}",
                              f"✅ 节点 {label(tag)} 连续 {RECOVER_THRESHOLD} 次探测正常(延迟 {detail}),"
                              f"判定恢复。当前主用:{label(selected)}。")
                    else:
                        log(f"RECOVER-QUIET {tag}(震荡静默中)")
            else:
                st["state"], st["succs"] = "up", 0
        else:
            st["succs"] = 0
            st["fails"] += 1
            log(f"PROBE-FAIL {tag} #{st['fails']} {detail}")
            if st["fails"] >= FAIL_THRESHOLD and st["state"] != "down":
                st["state"] = "down"
                st["last_alert"] = now
                if note_flip(st, tag, now, selected):
                    sev = "critical" if tag == selected else "warning"
                    alert("ops.egress_node_down", sev,
                          f"[个人版 egress] {role}节点连续{st['fails']}次探测失败:{label(tag)}",
                          f"🚨 节点 {label(tag)}({role})连续 {st['fails']} 次探测失败,判定不可用。\n"
                          f"最近一次错误:{detail}\n"
                          + ("watchdog 将自动切换到备用节点(若其健康)。" if tag == selected
                             else "主用节点不受影响,但**已无冗余**,主用再挂将无节点可切。"))
                else:
                    log(f"DOWN-QUIET {tag}(震荡静默中)")
            elif st["state"] == "down" and now - st["last_alert"] >= REALERT_NODE_DOWN:
                st["last_alert"] = now
                alert("ops.egress_node_down", "warning",
                      f"[个人版 egress] 节点持续不可用(6h 提醒):{label(tag)}",
                      f"节点 {label(tag)} 仍处于不可用状态(最近错误:{detail})。")

    # ── 3) 切换决策:主用挂 → 任一健康备用则切,否则全挂告警 ──
    standbys = [m for m in members if m != selected]
    healthy_standbys = [m for m in standbys if nodes[m]["state"] == "up"]
    all_down = state["all_down"]
    if nodes[selected]["state"] == "down":
        if healthy_standbys:
            target = healthy_standbys[0]
            if switch_to(target):
                state["last_selected"] = target
                all_down["active"] = False
                alert("ops.egress_node_switch", "critical",
                      f"[个人版 egress] 已自动切换节点:{label(selected)} → {label(target)}",
                      f"🔀 主用节点 {label(selected)} 连续 {nodes[selected]['fails']} 次探测失败,"
                      f"已自动切换到 **{label(target)}**(clash_api 无重启切换)。\n"
                      f"原主用恢复后**不会自动切回**,如需切回可在恢复告警后手动处理。")
            else:
                alert("ops.egress_node_switch", "critical",
                      "[个人版 egress] 自动切换失败!",
                      f"🚨 主用 {label(selected)} 已挂且备用 {label(target)} 健康,"
                      "但 PUT selector 切换失败,请立即人工介入。")
        else:
            if not all_down["active"]:
                all_down["active"] = True
                all_down["last_alert"] = now
                detail = "无备用节点(单成员 selector)" if len(members) < 2 else "所有备用节点也不可用"
                alert("ops.egress_all_nodes_down", "critical",
                      "[个人版 egress] 无可用节点,出海已断",
                      f"🚨🚨 当前选中 {label(selected)} 探测失败,且{detail},无节点可切。\n"
                      "本机全部出海不可用。watchdog 持续探测,任一节点恢复即自动恢复/切换,"
                      "并每 30 分钟重复本告警。")
            elif now - all_down["last_alert"] >= REALERT_CRITICAL:
                all_down["last_alert"] = now
                alert("ops.egress_all_nodes_down", "critical",
                      "[个人版 egress] 仍无可用节点(持续提醒)",
                      "🚨 selector 所有成员均持续探测失败,出海仍中断。")
    else:
        all_down["active"] = False


def notify_fail() -> None:
    """systemd OnFailure 入口:看门狗本体异常退出时发一条企微告警(复用同一 webhook 逻辑)。"""
    msg = sys.argv[2] if len(sys.argv) > 2 else (
        "🚨 openclaude-personal-egress-watchdog.service 异常退出(systemd OnFailure)。\n"
        "节点异常自动切换已失效(egress 仍在跑但无人守护),请上机排查:\n"
        "> journalctl -u openclaude-personal-egress-watchdog -n 50 --no-pager"
    )
    alert("ops.egress_watchdog_failed", "critical", "[个人版 egress] 看门狗进程异常退出", msg)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--notify-fail":
        notify_fail()
        sys.exit(0)
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
